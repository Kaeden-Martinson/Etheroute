const { Router } = require('express');
const crypto = require('crypto');
const { db } = require('../config/database');
const BalanceWatcher = require('../services/BalanceWatcher');
const TransactionService = require('../services/TransactionService');
const PriceService = require('../services/PriceService');
const WebhookService = require('../services/WebhookService');
const QRCode = require('qrcode');
const logger = require('../services/logger');
const { config } = require('../config/env');
const { ApiError } = require('../utils/errors');
const { validateCryptoAddress } = require('../utils/validators');
const { requireAuth } = require('../middleware/auth');
const { checkoutLimiter, clientLimiter } = require('../middleware/rateLimit');
const chains = require('../config/chains');
const EthereumProvider = require('../services/EthereumProvider');

const family = (code) => (chains.has(code) ? chains.get(code).family : null);

const router = Router();

const SESSION_TTL_MS = config.checkout.ttlMinutes * 60 * 1000;

// An EVM chain with no transaction index is read block by block over RPC
// instead, and every EVM chain falls back to the same reading while its
// index is not answering (see scanEvmPaymentOverRpc). This many blocks per
// check keeps one check to a few seconds on a public endpoint; a longer
// backlog is worked through across successive checks.
const RPC_SCAN_MAX_BLOCKS = 40;
// Where a scan starts when the session carries no cursor - the baseline is
// normally taken the moment the buyer's address arrives, so this only covers
// a session made before the scan existed, or a baseline the RPC refused.
const RPC_SCAN_FIRST_LOOKBACK = 20;

// A token payment is a Transfer event, read with eth_getLogs from a cursor
// the session keeps. Public endpoints cap a query's block range; windows of
// this many blocks, this many per check, keep under every cap seen and still
// clear an hour of a sub-second chain in a few checks.
const LOG_WINDOW_BLOCKS = 1000;
const LOG_WINDOWS_PER_CHECK = 5;
// An endpoint that caps the range lower says so ("maximum allowed is 50");
// the window is cut to what it allows, per chain, and kept. Below this the
// endpoint is not worth reading through.
const LOG_WINDOW_FLOOR = 10;
const logWindowByChain = new Map();
const logWindowFor = (chain) => logWindowByChain.get(chain) || LOG_WINDOW_BLOCKS;
// Re-read this many blocks behind the cursor each time: a short reorg can
// move a transfer into a later block after the cursor passed it.
const LOG_OVERLAP_BLOCKS = 12;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// A session is checked against the chain at most this often, however many
// times its status is polled. Every check is one or more third-party API calls
// (an explorer query per poll, plus one per transaction on Solana), and those
// providers rate-limit by IP - so unthrottled polling from a few dozen buyers
// was enough to get every session stuck in VERIFYING.
const RECHECK_INTERVAL_MS = 15_000;

// A VERIFYING session with no payment in sight is allowed this long past its
// deadline before it expires - long enough for a payment sent at the last
// minute to show up in the explorer.
const VERIFYING_GRACE_MS = 15 * 60 * 1000;

/**
 * Session states.
 *
 * VERIFYING is the important addition: when the chain data needed to confirm a
 * payment cannot be fetched, the session waits there instead of guessing. The
 * previous implementation assumed success on error and settled unpaid sessions.
 */
const STATUS = {
  PENDING: 'PENDING',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  VERIFYING: 'VERIFYING',
  PAID: 'PAID',
  INSUFFICIENT: 'INSUFFICIENT',
  EXPIRED: 'EXPIRED',
};

const TERMINAL = [STATUS.PAID, STATUS.INSUFFICIENT, STATUS.EXPIRED];

// ─── Amounts ─────────────────────────────────────────────────────────────────

function usdRateFor(chain) {
  return PriceService[`${String(chain).toLowerCase()}ToUsdRate`];
}

/**
 * Given a chain and exactly one of nativeAmount / usdAmount, return both.
 */
function resolveAmounts(chain, nativeAmount, usdAmount) {
  const hasNative = nativeAmount !== undefined && nativeAmount !== null && nativeAmount !== '';
  const hasUsd = usdAmount !== undefined && usdAmount !== null && usdAmount !== '';

  if (!hasNative && !hasUsd) {
    throw new ApiError(400, 'Either nativeAmount or usdAmount is required');
  }
  if (hasNative && hasUsd) {
    throw new ApiError(400, 'Provide either nativeAmount or usdAmount, not both');
  }

  const usdRate = usdRateFor(chain);
  if (!usdRate) {
    throw new ApiError(503, 'Price data is not yet available. Please retry in a moment.');
  }
  if (!PriceService.isFresh()) {
    // Quoting a checkout at a price from hours ago is a real loss for one side
    // or the other. Refuse until the feed recovers.
    throw new ApiError(503, `Price data is stale (last updated ${PriceService.ageSeconds()}s ago). Please retry in a moment.`);
  }

  if (hasNative) {
    const native = parseFloat(nativeAmount);
    if (Number.isNaN(native) || native <= 0) {
      throw new ApiError(400, 'nativeAmount must be a positive number');
    }
    return { nativeAmount: native, usdAmount: parseFloat((native * usdRate).toFixed(6)) };
  }

  const usd = parseFloat(usdAmount);
  if (Number.isNaN(usd) || usd <= 0) {
    throw new ApiError(400, 'usdAmount must be a positive number');
  }
  return { nativeAmount: parseFloat((usd / usdRate).toFixed(8)), usdAmount: usd };
}

// ─── Session helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a stored session.
 *
 * Sessions written before the amount fields were split still carry a single
 * `amount`. Reading through this function means those old records render
 * correctly instead of showing undefined.
 */
function normalise(session) {
  if (!session) return session;
  if (session.nativeAmount === undefined && session.amount !== undefined) {
    return {
      ...session,
      nativeAmount: session.amount,
      usdAmount: session.usdAmount ?? null,
    };
  }
  return session;
}

function getSession(sessionId) {
  return normalise(db.getById('checkoutSessions', sessionId));
}

/**
 * A short signed token proving this session really did settle.
 *
 * The old redirect appended a bare session id, so a buyer could visit the
 * vendor's success URL directly and appear to have paid. The vendor should
 * verify this token (or call the API) before releasing goods.
 */
function settlementToken(session) {
  return crypto
    .createHmac('sha256', config.keyEncryptionKey)
    .update(`checkout-settlement:${session.id}:${session.status}`)
    .digest('base64url');
}

function appendSettlement(url, session) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('session', session.id);
    parsed.searchParams.set('status', session.status);
    parsed.searchParams.set('token', settlementToken(session));
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildStatusResponse(session) {
  const response = {
    sessionId: session.id,
    status: session.status,
    chain: session.chain,
    chainSymbol: chains.has(session.chain) ? chains.get(session.chain).symbol : session.chain,
    walletAddress: session.walletAddress,
    nativeAmount: session.nativeAmount,
    usdAmount: session.usdAmount,
    // What the page is set to be paid in, and the figure for each asset the
    // link can be paid in.
    asset: sessionAsset(session),
    amounts: sessionAmounts(session),
    expiresAt: session.expiresAt,
    paidAmount: session.paidAmount ?? null,
    paidAsset: session.paidAsset ?? null,
    paidTxHash: session.paidTxHash ?? null,
    paidAt: session.paidAt ?? null,
    confirmations: session.confirmations ?? null,
    requiredConfirmations: config.checkout.confirmations[session.chain] ?? 1,
    // Set while a matching transaction has been seen but is not yet deep
    // enough. Lets the page tell "your payment is on the chain, waiting for
    // confirmations" apart from "the chain is temporarily unreadable" -
    // both are VERIFYING, and they deserve very different screens.
    pendingTxHash: session.pendingTxHash ?? null,
    pendingAsset: session.pendingAsset ?? null,
    detected: Boolean(session.pendingTxHash || session.paidTxHash),
    // A merchant-initiated cancel is an expiry with a reason, so the page can
    // say "the merchant closed this" rather than "it timed out".
    cancelledByMerchant: Boolean(session.cancelledByMerchant),
    // The buyer's own address, so a reload can restore "expecting from".
    clientWalletAddress: session.clientWalletAddress ?? null,
  };

  if (session.status === STATUS.PAID) {
    response.redirectUrl = appendSettlement(session.successRoute, session);
  } else if (session.status === STATUS.INSUFFICIENT || session.status === STATUS.EXPIRED) {
    response.redirectUrl = appendSettlement(session.failureRoute, session);
  }

  return response;
}

/**
 * Expire a session past its deadline. A session already being verified is left
 * alone - money may have arrived just before the cutoff and it deserves to
 * finish settling.
 */
function checkExpiry(session) {
  const overdueMs = Date.now() - new Date(session.expiresAt).getTime();
  const expired = overdueMs > 0;
  let canExpire = session.status === STATUS.PENDING || session.status === STATUS.AWAITING_PAYMENT;

  // VERIFYING with a transaction in hand is never expired - it is paid and
  // waiting on depth. VERIFYING with nothing seen is just AWAITING_PAYMENT
  // during an explorer outage, and gets a grace period rather than living
  // forever.
  if (session.status === STATUS.VERIFYING && !session.pendingTxHash && overdueMs > VERIFYING_GRACE_MS) {
    canExpire = true;
  }

  if (expired && canExpire) {
    const updated = normalise(db.update('checkoutSessions', session.id, { status: STATUS.EXPIRED }));
    notify(updated, 'checkout.session.expired');
    return updated;
  }
  return session;
}

/**
 * Expire a session past its deadline - but only after one last look at the
 * chain. "Expired" must mean no funds were sent in the window, not that the
 * window closed a few seconds before the explorer showed the payment. A
 * session with a payment seen, partial or full, is never expired; it goes on
 * to settle as PAID or INSUFFICIENT like any other.
 *
 * The final check bypasses the usual poll throttle: it is the one that
 * decides, so it must be current.
 */
async function expireIfUnpaid(session) {
  if (!session || TERMINAL.includes(session.status)) return session;
  if (new Date(session.expiresAt).getTime() > Date.now()) return session;

  let current = session;
  if (session.clientWalletAddress) {
    try {
      current = await settleNow(session);
    } catch (error) {
      logger.warn(`[Checkout] Final check before expiry failed for ${session.id}: ${error.message}`);
    }
  }

  return checkExpiry(current);
}

function notify(session, event) {
  if (!session || !session.webhookUrl) return;
  WebhookService.enqueue({
    clientId: session.clientId,
    url: session.webhookUrl,
    event,
    data: {
      sessionId: session.id,
      status: session.status,
      chain: session.chain,
      nativeAmount: session.nativeAmount,
      usdAmount: session.usdAmount,
      paidAmount: session.paidAmount ?? null,
      paidAsset: session.paidAsset ?? null,
      paidTxHash: session.paidTxHash ?? null,
      paidAt: session.paidAt ?? null,
      walletAddress: session.walletAddress,
      clientWalletAddress: session.clientWalletAddress,
    },
  });
}

// ─── Settlement ──────────────────────────────────────────────────────────────

/**
 * How many confirmations a transaction has, or null when the source does not
 * say. Null means "cannot determine" and is treated as not-yet-confirmed.
 */
function confirmationsOf(chain, tx) {
  if (family(chain) === 'evm') {
    const value = Number(tx.confirmations);
    return Number.isFinite(value) ? value : null;
  }

  if (family(chain) === 'utxo') {
    // The history lookup reports depth when it could read the chain tip.
    // Without it, a block height still proves one confirmation - but only
    // one, which is why LTC (which requires two) could never settle before
    // the tip was fetched.
    const depth = Number(tx.confirmations);
    if (Number.isFinite(depth) && depth > 0) return depth;
    return tx.blockHeight ? 1 : 0;
  }

  switch (chain) {
    case 'XRP':
      return tx.validated ? 1 : 0;
    case 'SOL':
      if (tx.status === 'finalized') return 32;
      if (tx.status === 'confirmed') return 1;
      return 0;
    default:
      return null;
  }
}

/**
 * Has this transaction already settled a different session? A given payment
 * must credit at most one checkout.
 */
function alreadyClaimed(txHash, sessionId) {
  if (!txHash) return false;
  return db
    .getAll('checkoutSessions')
    .some((other) => other.paidTxHash === txHash && other.id !== sessionId);
}

/**
 * Every figure a session can be paid with: the coin's, fixed at creation,
 * and a dollar token's, which is the USD figure itself. Keyed by asset
 * symbol. A session without a USD figure (no price at creation) has only
 * its coin.
 */
function amountsFor(chain, nativeAmount, usdAmount) {
  if (!chains.has(chain)) return {};
  const amounts = { [chains.get(chain).symbol]: nativeAmount };
  if (Number.isFinite(usdAmount) && usdAmount > 0) {
    for (const token of chains.tokensOf(chain)) amounts[token.symbol] = usdAmount;
  }
  return amounts;
}

/** The session's figures, with the coin-only shape of an older session. */
function sessionAmounts(session) {
  if (session.amounts && typeof session.amounts === 'object') return session.amounts;
  return amountsFor(session.chain, session.nativeAmount, session.usdAmount);
}

/** The asset a session is set to be paid in: the pick, else the coin. */
function sessionAsset(session) {
  if (session.asset && sessionAmounts(session)[session.asset] !== undefined) return session.asset;
  return chains.has(session.chain) ? chains.get(session.chain).symbol : null;
}

/** The figure a payment in `asset` has to reach. */
function amountDue(session, asset) {
  const amounts = sessionAmounts(session);
  return amounts[asset] !== undefined ? amounts[asset] : session.nativeAmount;
}

/** A 20-byte address as a 32-byte log topic. */
const topicOf = (address) => `0x${String(address).slice(2).toLowerCase().padStart(64, '0')}`;

/** An EVM chain whose payments are found by reading its blocks, not an index. */
function scansOverRpc(chain) {
  return family(chain) === 'evm' && (chains.get(chain).history || []).length === 0;
}

/**
 * The scan's starting point: the block after the one at the tip, and the
 * merchant balance, at the moment the buyer's address arrives. Taken here so
 * the first check has nothing to read back through. Best effort - a session
 * without it starts RPC_SCAN_FIRST_LOOKBACK blocks back on its first check.
 * Every EVM session gets one: a chain with an index may still need the scan
 * as its fallback.
 */
async function rpcScanBaseline(session) {
  if (family(session.chain) !== 'evm') return {};
  try {
    return await EthereumProvider.forChain(session.chain).withProvider(async (provider) => {
      const [tip, balance] = await Promise.all([provider.getBlockNumber(), provider.getBalance(session.walletAddress)]);
      return { scanFromBlock: tip + 1, scanBalance: balance.toString() };
    });
  } catch (error) {
    logger.warn(`[Checkout] No RPC scan baseline for ${session.id}: ${error.message}`);
    return {};
  }
}

/**
 * Find the buyer's payment on an EVM chain with no transaction index by
 * reading the chain's own blocks over RPC, from where the last check left
 * off up to the tip.
 *
 * The merchant balance gates the work: while it is what it was after the
 * last full pass, nothing has landed and the cursor just moves to the tip.
 * When it differs, the blocks in between are read with their transactions
 * and searched for a transfer from the buyer to the merchant. At most
 * RPC_SCAN_MAX_BLOCKS are read per check; the cursor is persisted on the
 * session so a backlog is finished over the following checks. A block's
 * timestamp is held to the session's creation like the index path holds
 * `timeStamp`. Anything found is checked for a reverted receipt.
 *
 * Returns the findPayment outcomes; throws on RPC failure, which the caller
 * reports as unverifiable.
 */
async function scanEvmPaymentOverRpc(session) {
  const { ethers } = require('ethers');
  return EthereumProvider.forChain(session.chain).withProvider(async (provider) => {
    const tip = await provider.getBlockNumber();
    const balance = (await provider.getBalance(session.walletAddress)).toString();
    const from = Number.isInteger(session.scanFromBlock) ? session.scanFromBlock : Math.max(0, tip - RPC_SCAN_FIRST_LOOKBACK);
    const cursor = (fields) => db.update('checkoutSessions', session.id, fields);

    if (from > tip) return { outcome: 'none' };

    // Same balance as at the end of the last full pass: nothing arrived.
    if (typeof session.scanBalance === 'string' && session.scanBalance === balance) {
      cursor({ scanFromBlock: tip + 1 });
      return { outcome: 'none' };
    }

    const end = Math.min(tip, from + RPC_SCAN_MAX_BLOCKS - 1);
    const merchant = String(session.walletAddress).toLowerCase();
    const buyer = String(session.clientWalletAddress).toLowerCase();
    const createdAtSec = Math.floor(new Date(session.createdAt).getTime() / 1000);

    for (let number = from; number <= end; number++) {
      const block = await provider.send('eth_getBlockByNumber', [`0x${number.toString(16)}`, true]);
      if (!block) break; // the tip moved back on us; keep the cursor where it is
      if (parseInt(block.timestamp, 16) < createdAtSec) continue;

      const tx = (block.transactions || []).find((t) =>
        String(t.to || '').toLowerCase() === merchant &&
        String(t.from || '').toLowerCase() === buyer &&
        BigInt(t.value || '0x0') > 0n
      );
      if (!tx) continue;

      // Resume after this block either way: a reverted transfer is not a
      // payment, and the same block is not worth reading twice.
      cursor({ scanFromBlock: number + 1 });
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt && receipt.status !== 1) continue;

      return {
        outcome: 'found',
        asset: chains.get(session.chain).symbol,
        amount: parseFloat(ethers.formatEther(BigInt(tx.value))),
        txHash: tx.hash,
        confirmations: tip - number + 1,
      };
    }

    // Caught up to the tip: the balance now stands for "seen through here".
    cursor({ scanFromBlock: end + 1, ...(end === tip ? { scanBalance: balance } : {}) });
    return { outcome: 'none' };
  });
}

/**
 * Look for the buyer's payment in the merchant wallet's transaction history.
 *
 * Returns one of:
 *   { outcome: 'none' }        - nothing matching yet
 *   { outcome: 'unverifiable' } - chain data unavailable; caller must wait
 *   { outcome: 'found', amount, txHash, confirmations }
 *
 * Every failure path returns 'unverifiable'. Nothing here ever assumes a
 * payment arrived.
 */
async function findPayment(session, wallet) {
  const coin = await findCoinPayment(session, wallet);
  if (coin.outcome === 'found' || family(session.chain) !== 'evm') return coin;

  // Not the coin, or not yet: the chain's dollar tokens are watched too,
  // whichever the customer picked. A transfer seen on an earlier check is
  // followed by its hash (findCoinPayment did that above, for any asset).
  try {
    const token = await findTokenPayment(session);
    if (token.outcome === 'found') {
      if (alreadyClaimed(token.txHash, session.id)) return coin;
      return token;
    }
  } catch (error) {
    logger.warn(`[Checkout] Token lookup failed for session ${session.id}: ${error.message}`);
    return { outcome: 'unverifiable' };
  }
  return coin;
}

/**
 * The buyer's payment in the chain's own coin: a wallet's hint or a seen
 * transfer by its hash, else the index, else (on an EVM chain) the blocks.
 */
async function findCoinPayment(session, wallet) {
  // A payment made through a connected wallet tells us its hash the moment
  // it is sent. Verify that transaction directly over RPC: instant, works on
  // every EVM chain including those with no free transaction index, and does
  // not depend on an explorer having caught up.
  if (session.hintTxHash && family(session.chain) === 'evm') {
    const hinted = await verifyHintedEvmPayment(session);
    if (hinted) return hinted;
  }

  // No index to ask: read the blocks. A transfer seen on an earlier check is
  // followed by its hash from then on, so counting its confirmations costs
  // one lookup rather than another pass over the blocks.
  if (scansOverRpc(session.chain)) return readEvmBlocks(session);

  let history;

  try {
    history = await BalanceWatcher.getTransactionHistory(wallet);
  } catch (error) {
    logger.warn(`[Checkout] History lookup threw for session ${session.id}: ${error.message}`);
    history = null;
  }

  if (!history || history.status === 'error' || history.status === 'rate_limited' || history.status === 'unavailable' || !Array.isArray(history.transactions)) {
    // An EVM chain whose index is not answering is read the way an EVM chain
    // with no index is, rather than held until the index comes back. Any
    // other chain holds: nothing settles on a guess.
    if (family(session.chain) === 'evm') {
      logger.warn(`[Checkout] Index unavailable for session ${session.id} (${session.chain}); reading blocks over RPC`);
      return readEvmBlocks(session);
    }
    return { outcome: 'unverifiable' };
  }

  const createdAtSec = Math.floor(new Date(session.createdAt).getTime() / 1000);
  const buyer = session.clientWalletAddress;
  const merchant = session.walletAddress;

  let match = null;

  switch (family(session.chain) === 'evm' ? 'EVM' : (family(session.chain) === 'utxo' ? 'UTXO' : session.chain)) {
    case 'EVM': {
      const buyerLower = String(buyer).toLowerCase();
      const merchantLower = String(merchant).toLowerCase();

      const tx = history.transactions.find((t) =>
        String(t.from || '').toLowerCase() === buyerLower &&
        String(t.to || '').toLowerCase() === merchantLower &&
        parseInt(t.timeStamp || '0', 10) >= createdAtSec &&
        t.isError !== '1'
      );

      if (tx) {
        const { ethers } = require('ethers');
        match = {
          asset: chains.get(session.chain).symbol,
          amount: parseFloat(ethers.formatEther(tx.value || '0')),
          txHash: tx.hash,
          confirmations: confirmationsOf(session.chain, tx),
        };
      }
      break;
    }

    case 'UTXO': {
      const tx = history.transactions.find((t) => {
        const time = t.time ?? 0;
        if (time > 0 && time < createdAtSec) return false;
        const fromBuyer = (t.inputs || []).some((i) => i.address === buyer);
        const toMerchant = (t.outputs || []).some((o) => o.address === merchant);
        return fromBuyer && toMerchant;
      });

      if (tx) {
        // Count only the outputs that landed on the merchant address.
        const received = (tx.outputs || [])
          .filter((o) => o.address === merchant)
          .reduce((sum, o) => sum + o.value, 0);

        match = {
          amount: received,
          txHash: tx.hash ?? tx.txid,
          confirmations: confirmationsOf(session.chain, tx),
        };
      }
      break;
    }

    case 'XRP': {
      // a validated payment from the buyer to the merchant, after the link was made
      const tx = history.transactions.find((t) =>
        (t.timestamp ?? 0) >= createdAtSec && t.sender === buyer && t.recipient === merchant && t.validated
      );
      if (tx) {
        match = { amount: tx.amount, txHash: tx.hash, confirmations: 1 };
      }
      break;
    }

    case 'SOL': {
      const tx = history.transactions.find((t) =>
        (t.timestamp ?? 0) >= createdAtSec && t.sender === buyer
      );

      if (tx) {
        const change = (tx.balanceChanges || []).find((b) => b.address === merchant);
        // Require a positive credit to the merchant address; without it we
        // cannot say this transaction paid anything.
        if (!change || change.delta <= 0) break;

        match = {
          amount: change.delta,
          txHash: tx.signature,
          confirmations: confirmationsOf('SOL', tx),
        };
      }
      break;
    }

    default:
      return { outcome: 'unverifiable' };
  }

  if (!match) return { outcome: 'none' };
  if (!match.txHash) return { outcome: 'unverifiable' };
  if (alreadyClaimed(match.txHash, session.id)) return { outcome: 'none' };

  return { outcome: 'found', ...match };
}

/**
 * A dollar-token payment: the token's Transfer(buyer, merchant) event, read
 * with eth_getLogs from the block the buyer gave their address (the same
 * baseline the coin's scan starts from), in bounded windows, with the cursor
 * kept on the session. A Transfer event only exists in a transaction that
 * succeeded, so there is no receipt to check. Reads every token the chain
 * carries, the one picked first.
 *
 * Returns a findPayment outcome with `asset` set; throws on RPC failure.
 */
async function findTokenPayment(session) {
  const { ethers } = require('ethers');
  const tokens = chains.tokensOf(session.chain);
  if (tokens.length === 0) return { outcome: 'none' };
  const picked = sessionAsset(session);
  tokens.sort((a, b) => (a.symbol === picked ? -1 : b.symbol === picked ? 1 : 0));

  // withLogs, not withProvider: not every public endpoint serves getLogs.
  return EthereumProvider.forChain(session.chain).withLogs(async (provider) => {
    const tip = await provider.getBlockNumber();
    const start = Number.isInteger(session.logsFromBlock) ? session.logsFromBlock
      : Number.isInteger(session.scanFromBlock) ? session.scanFromBlock
        : Math.max(0, tip - RPC_SCAN_FIRST_LOOKBACK);
    const from = Math.max(0, start - LOG_OVERLAP_BLOCKS);
    if (from > tip) return { outcome: 'none' };
    let window = logWindowFor(session.chain);
    let end = Math.min(tip, from + window * LOG_WINDOWS_PER_CHECK - 1);
    const topics = [TRANSFER_TOPIC, topicOf(session.clientWalletAddress), topicOf(session.walletAddress)];

    for (const token of tokens) {
      for (let lo = from; lo <= end; lo += window) {
        const hi = Math.min(end, lo + window - 1);
        let logs;
        try {
          logs = await provider.getLogs({ address: token.contract, fromBlock: lo, toBlock: hi, topics });
        } catch (error) {
          // "Block range too large: maximum allowed is 50": take the number,
          // narrow the window for this chain from here on, and read this
          // stretch again at the new size.
          const cap = /maximum allowed is (\d+)|max(?:imum)? (?:block )?range (?:is |of )?(\d+)|exceeds (?:the )?limit of (\d+)|limited to (\d+) blocks/i.exec(String(error.message));
          const allowed = cap ? Number(cap[1] || cap[2] || cap[3] || cap[4]) : 0;
          if (!(allowed >= LOG_WINDOW_FLOOR && allowed < window)) throw error;
          window = allowed;
          logWindowByChain.set(session.chain, window);
          end = Math.min(tip, from + window * LOG_WINDOWS_PER_CHECK - 1);
          lo -= window; // the loop's own step lands the retry on `lo` again
          continue;
        }
        const log = (logs || []).find((entry) => !entry.removed && BigInt(entry.data || '0x0') > 0n);
        if (!log) continue;
        const block = Number(log.blockNumber);
        return {
          outcome: 'found',
          asset: token.symbol,
          amount: parseFloat(ethers.formatUnits(BigInt(log.data), token.decimals)),
          txHash: log.transactionHash,
          confirmations: tip - block + 1,
        };
      }
    }

    db.update('checkoutSessions', session.id, { logsFromBlock: end + 1 });
    return { outcome: 'none' };
  });
}

/**
 * The RPC path as findPayment uses it: a transfer already seen is followed
 * by its hash, otherwise the blocks since the cursor are read. A payment
 * that settled another session is not one. Any failure holds the session.
 */
async function readEvmBlocks(session) {
  if (session.pendingTxHash) {
    const seen = await verifyHintedEvmPayment(session, session.pendingTxHash);
    if (seen && seen.outcome === 'found' && alreadyClaimed(seen.txHash, session.id)) return { outcome: 'none' };
    if (seen) return seen;
  }
  try {
    const scanned = await scanEvmPaymentOverRpc(session);
    if (scanned.outcome === 'found' && alreadyClaimed(scanned.txHash, session.id)) return { outcome: 'none' };
    return scanned;
  } catch (error) {
    logger.warn(`[Checkout] RPC scan failed for session ${session.id}: ${error.message}`);
    return { outcome: 'unverifiable' };
  }
}

/**
 * Advance a session that is waiting on payment. Returns the current session.
 */
/**
 * Check a wallet-reported transaction hash against the chain. Returns a
 * findPayment outcome when the transaction is a real transfer from the buyer
 * to the merchant wallet; null to fall through to the history lookup (the
 * hash is unknown so far, or it is not the payment it claimed to be).
 */
async function verifyHintedEvmPayment(session, txHash = session.hintTxHash) {
  const { ethers } = require('ethers');
  try {
    return await EthereumProvider.forChain(session.chain).withProvider(async (provider) => {
      const tx = await provider.getTransaction(txHash);
      if (!tx) return null; // not propagated yet

      const fromBuyer = String(tx.from || '').toLowerCase() === String(session.clientWalletAddress).toLowerCase();
      const to = String(tx.to || '').toLowerCase();
      const toMerchant = to === String(session.walletAddress).toLowerCase();
      // A token payment is a call to the token's contract; the merchant is
      // in the Transfer event it emits, which the receipt carries.
      const token = chains.tokensOf(session.chain).find((t) => t.contract.toLowerCase() === to);
      if (!fromBuyer || (!toMerchant && !token)) {
        logger.warn(`[Checkout] Hinted tx ${txHash} for ${session.id} is not buyer -> merchant; ignoring`);
        return null;
      }

      let confirmations = 0;
      let receipt = null;
      if (tx.blockNumber) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status !== 1) return { outcome: 'none' }; // reverted
        const tip = await provider.getBlockNumber();
        confirmations = Math.max(1, tip - tx.blockNumber + 1);
      }

      if (token) {
        // Unmined: the call is to the token, but what it moves and to whom is
        // only known once the event exists. Seen, with nothing to count yet.
        if (!receipt) return { outcome: 'found', asset: token.symbol, amount: 0, txHash, confirmations: 0 };
        const transfer = (receipt.logs || []).find((log) =>
          String(log.address).toLowerCase() === to &&
          Array.isArray(log.topics) && log.topics.length === 3 &&
          String(log.topics[0]).toLowerCase() === TRANSFER_TOPIC &&
          String(log.topics[1]).toLowerCase() === topicOf(session.clientWalletAddress) &&
          String(log.topics[2]).toLowerCase() === topicOf(session.walletAddress)
        );
        if (!transfer) {
          logger.warn(`[Checkout] Hinted tx ${txHash} for ${session.id} moved no ${token.symbol} to the merchant; ignoring`);
          return null;
        }
        return {
          outcome: 'found',
          asset: token.symbol,
          amount: parseFloat(ethers.formatUnits(BigInt(transfer.data || '0x0'), token.decimals)),
          txHash,
          confirmations,
        };
      }

      return {
        outcome: 'found',
        asset: chains.get(session.chain).symbol,
        amount: parseFloat(ethers.formatEther(tx.value || 0n)),
        txHash,
        confirmations,
      };
    });
  } catch (error) {
    logger.warn(`[Checkout] Could not verify hinted tx for ${session.id}: ${error.message}`);
    return null;
  }
}

const settlementsInFlight = new Map();

async function settle(session) {
  // Recently checked: serve what we know. Concurrent pollers share one lookup.
  const lastChecked = new Date(session.lastCheckedAt || 0).getTime();
  if (Date.now() - lastChecked < RECHECK_INTERVAL_MS) return session;

  const inFlight = settlementsInFlight.get(session.id);
  if (inFlight) return inFlight;

  const run = settleNow(session).finally(() => settlementsInFlight.delete(session.id));
  settlementsInFlight.set(session.id, run);
  return run;
}

async function settleNow(session) {
  const wallet = db.getById('wallets', session.walletId);
  if (!wallet) {
    logger.error(`[Checkout] Wallet ${session.walletId} missing for session ${session.id}`);
    return session;
  }

  // Stamp before the lookup so a slow explorer does not let a burst of polls
  // pile up behind the first one.
  db.update('checkoutSessions', session.id, { lastCheckedAt: new Date().toISOString() });

  const payment = await findPayment(session, wallet);

  if (payment.outcome === 'unverifiable') {
    // Hold rather than guess. The buyer keeps polling and the vendor is not told
    // anything settled.
    if (session.status !== STATUS.VERIFYING) {
      return normalise(db.update('checkoutSessions', session.id, { status: STATUS.VERIFYING })) || session;
    }
    return session;
  }

  if (payment.outcome === 'none') {
    // Nothing yet - if we had dropped into VERIFYING on a previous poll, the
    // chain is readable again, so go back to waiting.
    if (session.status === STATUS.VERIFYING) {
      return normalise(db.update('checkoutSessions', session.id, { status: STATUS.AWAITING_PAYMENT })) || session;
    }
    return session;
  }

  const required = config.checkout.confirmations[session.chain] ?? 1;
  const confirmations = payment.confirmations;
  // What arrived: the coin unless the lookup said otherwise (a token).
  const asset = payment.asset || (chains.has(session.chain) ? chains.get(session.chain).symbol : null);

  if (confirmations === null || confirmations < required) {
    // Seen but not yet deep enough to be irreversible.
    const updated = db.update('checkoutSessions', session.id, {
      status: STATUS.VERIFYING,
      pendingTxHash: payment.txHash,
      pendingAsset: asset,
      confirmations: confirmations ?? 0,
    });
    return normalise(updated) || session;
  }

  // Each asset has its own figure - the coin's fixed at creation, a dollar
  // token's the dollars themselves - and the tolerance applies to that one.
  const tolerance = config.checkout.underpaymentTolerance;
  const due = amountDue(session, asset);
  const paidEnough = payment.amount >= due * (1 - tolerance);
  const status = paidEnough ? STATUS.PAID : STATUS.INSUFFICIENT;

  const updated = normalise(db.update('checkoutSessions', session.id, {
    status,
    paidAt: new Date().toISOString(),
    paidAmount: payment.amount,
    paidAsset: asset,
    paidTxHash: payment.txHash,
    confirmations,
    pendingTxHash: null,
    pendingAsset: null,
  }));

  logger.info(`[Checkout] Session ${session.id} -> ${status} (${payment.amount} ${asset} on ${session.chain}, tx ${payment.txHash})`);
  // Money that arrived is a transaction of the merchant's, whatever it was
  // short of; the transactions tab lists it as received.
  try {
    TransactionService.recordDeposit({
      clientId: session.clientId,
      chain: session.chain,
      asset,
      nativeAmount: payment.amount,
      usdAmount: asset === (chains.has(session.chain) ? chains.get(session.chain).symbol : asset)
        ? (Number.isFinite(session.usdAmount) && session.nativeAmount > 0 ? payment.amount * (session.usdAmount / session.nativeAmount) : null)
        : payment.amount,
      transactionHash: payment.txHash,
      fromAddress: session.clientWalletAddress,
      toAddress: session.walletAddress,
      sessionId: session.id,
    });
  } catch (error) {
    logger.warn(`[Checkout] Could not record the deposit for ${session.id}: ${error.message}`);
  }
  // The receiving wallet's stored figure is behind the chain now.
  require('../services/BalanceWatcher').nudge([session.walletId]);
  notify(updated, paidEnough ? 'checkout.session.completed' : 'checkout.session.underpaid');

  return updated;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * The rate a link would be quoted at right now.
 * GET /api/checkout/quote?chain=ETH
 *
 * The same feed the create call prices from, so the dashboard can show the
 * coin figure as the amount is typed. It is a preview: the rate that counts
 * is the one read when the link is made, and that one is fixed.
 */
router.get('/quote', requireAuth, clientLimiter, (req, res, next) => {
  try {
    const code = String(req.query.chain || '').toUpperCase();
    if (!chains.has(code)) throw new ApiError(400, 'chain is required and must be a supported chain');
    const chain = chains.get(code);

    const usdRate = usdRateFor(code) || 0;
    res.json({
      success: true,
      chain: code,
      symbol: chain.symbol,
      // 0 until the feed has loaded; the page says so rather than dividing by it.
      usdRate,
      ageSeconds: PriceService.ageSeconds(),
      fresh: usdRate > 0 && PriceService.isFresh(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Create a checkout session.
 * POST /api/checkout/create
 */
router.post('/create', requireAuth, clientLimiter, async (req, res, next) => {
  try {
    const { walletId, nativeAmount, usdAmount, successRoute, failureRoute, webhookUrl, reference } = req.body;

    if (!walletId) throw new ApiError(400, 'walletId is required');
    if (!successRoute) throw new ApiError(400, 'successRoute is required');
    if (!failureRoute) throw new ApiError(400, 'failureRoute is required');

    for (const [label, value] of [['successRoute', successRoute], ['failureRoute', failureRoute]]) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new ApiError(400, `${label} must be a valid absolute URL`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ApiError(400, `${label} must use http or https`);
      }
    }

    if (webhookUrl) {
      let parsed;
      try {
        parsed = new URL(webhookUrl);
      } catch {
        throw new ApiError(400, 'webhookUrl must be a valid absolute URL');
      }
      if (parsed.protocol !== 'https:' && config.isProduction) {
        throw new ApiError(400, 'webhookUrl must use https');
      }
      // The server will POST to this address with our own network access. It
      // must not be talked into calling localhost, the cloud metadata service,
      // or anything else on the private side.
      const unsafe = WebhookService.unsafeTargetReason(parsed);
      if (unsafe) throw new ApiError(400, `webhookUrl is not allowed: ${unsafe}`);
    }

    const wallet = db.getById('wallets', walletId);
    if (!wallet || wallet.clientId !== req.auth.clientId) {
      // Do not confirm that a wallet id exists on someone else's account.
      throw new ApiError(404, 'Wallet not found');
    }

    const amounts = resolveAmounts(wallet.chain, nativeAmount, usdAmount);
    const chainInfo = chains.publicInfo(chains.get(wallet.chain));

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    db.create('checkoutSessions', {
      id: sessionId,
      clientId: req.auth.clientId,
      walletId,
      walletAddress: wallet.address,
      chain: wallet.chain,
      nativeAmount: amounts.nativeAmount,
      usdAmount: amounts.usdAmount,
      // One figure per asset the wallet takes; the customer picks on the page.
      amounts: amountsFor(wallet.chain, amounts.nativeAmount, amounts.usdAmount),
      asset: chainInfo.symbol,
      successRoute,
      failureRoute,
      webhookUrl: webhookUrl || null,
      reference: reference || null,
      clientWalletAddress: null,
      status: STATUS.PENDING,
      expiresAt,
      createdAt: new Date().toISOString(),
      paidAt: null,
      paidAmount: null,
      paidTxHash: null,
      pendingTxHash: null,
      confirmations: null,
    });

    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;

    res.status(201).json({
      success: true,
      sessionId,
      checkoutUrl: `${protocol}://${host}/checkout/${sessionId}`,
      expiresAt,
      chain: wallet.chain,
      chainSymbol: chainInfo.symbol,
      walletAddress: wallet.address,
      nativeAmount: amounts.nativeAmount,
      usdAmount: amounts.usdAmount,
      // The figure for each asset the link can be paid in: the coin's, and
      // the dollars for each dollar token the chain carries.
      amounts: amountsFor(wallet.chain, amounts.nativeAmount, amounts.usdAmount),
      // The rate the coin amount was fixed at, so the dashboard can show it
      // exactly rather than back out a rounded ratio of the two amounts.
      usdRate: usdRateFor(wallet.chain),
      // No free transaction index exists for this chain, so a payment made
      // by hand cannot be matched to its sender - only wallet-pay can.
      ...(chainInfo.manualCheckout ? {} : { warning: `${chainInfo.name} payments can only be verified when sent from a connected wallet on the checkout page.` }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Shape a session for its owner. Unlike the public view this includes the
 * routes, the webhook target and the buyer's address - it is only ever returned
 * to the merchant who created the session.
 */
function presentForMerchant(session) {
  const chainDef = chains.has(session.chain) ? chains.get(session.chain) : null;
  return {
    sessionId: session.id,
    reference: session.reference || null,
    status: session.status,
    cancelledByMerchant: Boolean(session.cancelledByMerchant),
    chain: session.chain,
    chainSymbol: chainDef ? chainDef.symbol : session.chain,
    chainName: chainDef ? chainDef.name : session.chain,
    walletId: session.walletId,
    walletAddress: session.walletAddress,
    nativeAmount: session.nativeAmount,
    usdAmount: session.usdAmount,
    amounts: sessionAmounts(session),
    asset: sessionAsset(session),
    clientWalletAddress: session.clientWalletAddress || null,
    paidAmount: session.paidAmount ?? null,
    paidAsset: session.paidAsset ?? null,
    paidTxHash: session.paidTxHash ?? null,
    // A transaction seen but not yet deep enough to settle.
    pendingTxHash: session.pendingTxHash ?? null,
    pendingAsset: session.pendingAsset ?? null,
    paidAt: session.paidAt ?? null,
    lastCheckedAt: session.lastCheckedAt ?? null,
    confirmations: session.confirmations ?? null,
    requiredConfirmations: config.checkout.confirmations[session.chain] ?? 1,
    successRoute: session.successRoute,
    failureRoute: session.failureRoute,
    webhookUrl: session.webhookUrl || null,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

/**
 * List the caller's checkout sessions, newest first.
 * GET /api/checkout/sessions?status=PAID&limit=50&offset=0
 */
router.get('/sessions', requireAuth, clientLimiter, (req, res, next) => {
  try {
    const { status } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    if (status && !Object.values(STATUS).includes(status)) {
      throw new ApiError(400, `Unknown status "${status}". Expected one of: ${Object.values(STATUS).join(', ')}`);
    }

    let sessions = db
      .findBy('checkoutSessions', { clientId: req.auth.clientId })
      .map(normalise);

    // Reflect elapsed expiry in the listing without waiting for the sweeper.
    sessions = sessions.map(checkExpiry);

    if (status) {
      sessions = sessions.filter((session) => session.status === status);
    }

    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totals = sessions.reduce((acc, session) => {
      acc[session.status] = (acc[session.status] || 0) + 1;
      return acc;
    }, {});

    const paidUsd = sessions
      .filter((session) => session.status === STATUS.PAID)
      .reduce((sum, session) => sum + (session.usdAmount || 0), 0);

    res.json({
      success: true,
      total: sessions.length,
      totals,
      paidUsd: Number(paidUsd.toFixed(2)),
      limit,
      offset,
      sessions: sessions.slice(offset, offset + limit).map(presentForMerchant),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * One of the caller's sessions, in full.
 * GET /api/checkout/sessions/:sessionId
 */
router.get('/sessions/:sessionId', requireAuth, clientLimiter, async (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);

    // Do not confirm that a session id exists on someone else's account.
    if (!session || session.clientId !== req.auth.clientId) {
      throw new ApiError(404, 'Checkout session not found');
    }

    res.json({ success: true, session: presentForMerchant(await expireIfUnpaid(session)) });
  } catch (error) {
    next(error);
  }
});

/**
 * The checkout link itself as a QR code, for the merchant to show a customer.
 * GET /api/checkout/sessions/:sessionId/qr
 *
 * Distinct from the payment QR the customer page draws: that one encodes the
 * pay-to address and only exists once the customer has given their sending
 * address. This one encodes the URL of the checkout page, so a customer at a
 * counter can scan it to open the link. Same generator, same ownership check
 * as the session route above.
 */
router.get('/sessions/:sessionId/qr', requireAuth, clientLimiter, async (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session || session.clientId !== req.auth.clientId) {
      throw new ApiError(404, 'Checkout session not found');
    }

    // trust proxy is set in production, so protocol and host are the public
    // ones behind a reverse proxy rather than the container's.
    const url = `${req.protocol}://${req.get('host')}/checkout/${session.id}`;
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: 180,
      errorCorrectionLevel: 'M',
    });
    res.json({ success: true, url, svg });
  } catch (error) {
    next(error);
  }
});

/**
 * Cancel a session that has not been paid.
 * POST /api/checkout/sessions/:sessionId/cancel
 */
router.post('/sessions/:sessionId/cancel', requireAuth, clientLimiter, (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);

    if (!session || session.clientId !== req.auth.clientId) {
      throw new ApiError(404, 'Checkout session not found');
    }

    if (session.status === STATUS.PAID) {
      throw new ApiError(409, 'This session has already been paid and cannot be cancelled');
    }
    if (session.status === STATUS.EXPIRED) {
      return res.json({ success: true, session: presentForMerchant(session) });
    }
    if (session.status === STATUS.VERIFYING) {
      throw new ApiError(409, 'A payment is being confirmed for this session. Wait for it to settle before cancelling.');
    }

    const updated = normalise(db.update('checkoutSessions', session.id, {
      status: STATUS.EXPIRED,
      cancelledByMerchant: true,
      expiresAt: new Date().toISOString(),
    }));

    notify(updated, 'checkout.session.cancelled');

    res.json({ success: true, session: presentForMerchant(updated) });
  } catch (error) {
    next(error);
  }
});

/**
 * Public session info, read by the checkout page.
 * GET /api/checkout/session/:sessionId
 */
router.get('/session/:sessionId', checkoutLimiter, async (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session) throw new ApiError(404, 'Checkout session not found');

    const current = await expireIfUnpaid(session);
    const revealed = !!current.clientWalletAddress;

    const chainInfo = chains.has(current.chain) ? chains.publicInfo(chains.get(current.chain)) : null;

    res.json({
      sessionId: current.id,
      chain: current.chain,
      chainInfo,
      // The destination address is withheld until the buyer has told us which
      // address they are paying from.
      walletAddress: revealed ? current.walletAddress : null,
      nativeAmount: current.nativeAmount,
      usdAmount: current.usdAmount,
      // Every way the link can be paid, with its figure, and the one the
      // page is set to (the coin until the customer picks).
      amounts: sessionAmounts(current),
      asset: sessionAsset(current),
      paidAsset: current.paidAsset ?? null,
      status: current.status,
      expiresAt: current.expiresAt,
      createdAt: current.createdAt,
      hasClientAddress: revealed,
      // The buyer's own sending address, echoed back so a reload restores the
      // "expecting from" line without another round trip.
      clientWalletAddress: revealed ? current.clientWalletAddress : null,
      cancelledByMerchant: Boolean(current.cancelledByMerchant),
      // Wallet URI plus a ready-to-render QR, once the address is known.
      paymentUri: revealed ? paymentUri(current) : null,
      paymentQr: revealed ? await paymentQr(current) : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Build a wallet-openable payment URI so the page can render a QR code.
 */
function paymentUri(session) {
  const { chain, walletAddress, nativeAmount } = session;

  // EIP-681: the chain id after the address tells a wallet which network to
  // use, so a Base payment is not sent on mainnet. Ethereum itself keeps
  // the bare form every wallet already understands.
  if (family(chain) === 'evm') {
    const { chainId } = chains.get(chain);
    const asset = sessionAsset(session);
    const token = chains.tokenOf(chain, asset);
    if (token) {
      // A token payment is a call on the token's contract: the amount in the
      // token's own units, as an integer.
      const { ethers } = require('ethers');
      const units = ethers.parseUnits(String(amountDue(session, asset)), token.decimals).toString();
      const target = chainId === 1 ? token.contract : `${token.contract}@${chainId}`;
      return `ethereum:${target}/transfer?address=${walletAddress}&uint256=${units}`;
    }
    const target = chainId === 1 ? walletAddress : `${walletAddress}@${chainId}`;
    return `ethereum:${target}?value=${nativeAmount}`;
  }

  switch (chain) {
    case 'BTC':
      return `bitcoin:${walletAddress}?amount=${nativeAmount}`;
    case 'LTC':
      return `litecoin:${walletAddress}?amount=${nativeAmount}`;
    case 'BCH':
      // CashAddr already carries its scheme-like prefix; BIP21 for the rest.
      return `${walletAddress.includes(':') ? walletAddress : `bitcoincash:${walletAddress}`}?amount=${nativeAmount}`;
    case 'DOGE':
      return `dogecoin:${walletAddress}?amount=${nativeAmount}`;
    case 'XRP':
      return `ripple:${walletAddress}?amount=${nativeAmount}`;
    case 'SOL':
      return `solana:${walletAddress}?amount=${nativeAmount}`;
    default:
      return walletAddress;
  }
}

/**
 * Render a payment URI as an inline SVG QR code.
 *
 * Generated here rather than in the browser so the page needs no third-party
 * script, which keeps the content security policy strict. Returns null on
 * failure - the address is always shown as text as well, so a missing QR
 * degrades gracefully.
 */
async function paymentQr(session) {
  try {
    return await QRCode.toString(paymentUri(session), {
      type: 'svg',
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'M',
    });
  } catch (error) {
    logger.warn(`[Checkout] QR generation failed for ${session.id}: ${error.message}`);
    return null;
  }
}

/**
 * Submit the buyer's sending address and start watching.
 * POST /api/checkout/submit-wallet
 */
router.post('/submit-wallet', checkoutLimiter, async (req, res, next) => {
  try {
    const { sessionId, clientWalletAddress } = req.body;

    if (!sessionId) throw new ApiError(400, 'sessionId is required');
    if (!clientWalletAddress) throw new ApiError(400, 'clientWalletAddress is required');

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, 'Checkout session not found');

    const current = await expireIfUnpaid(session);
    if (current.status === STATUS.EXPIRED) throw new ApiError(410, 'Checkout session has expired');
    if (TERMINAL.includes(current.status)) throw new ApiError(409, 'This session is already complete');

    // The address is set once. Otherwise anyone holding the session id could
    // change it mid-flow and redirect the match to a different payer.
    if (current.clientWalletAddress) {
      throw new ApiError(409, 'A sending address has already been submitted for this session');
    }

    if (!validateCryptoAddress(clientWalletAddress, current.chain)) {
      throw new ApiError(400, `That does not look like a valid ${current.chain} address`);
    }

    const updated = normalise(db.update('checkoutSessions', sessionId, {
      clientWalletAddress,
      asset: pickAsset(current, req.body.asset),
      status: STATUS.AWAITING_PAYMENT,
      // From here the merchant address is known to the buyer; on an EVM
      // chain this is where a reading of its blocks would start.
      ...(await rpcScanBaseline(current)),
    }));

    res.json({
      success: true,
      status: updated.status,
      walletAddress: updated.walletAddress,
      paymentUri: paymentUri(updated),
      paymentQr: await paymentQr(updated),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The asset a session is to be paid in, from the customer's pick. Nothing
 * given keeps what the session has (the coin, for a fresh one). Anything
 * else must be one of the assets the link carries a figure for.
 */
function pickAsset(session, wanted) {
  if (wanted === undefined || wanted === null || wanted === '') return sessionAsset(session);
  const asset = String(wanted).toUpperCase();
  if (sessionAmounts(session)[asset] === undefined) {
    throw new ApiError(400, `This link cannot be paid in ${asset}; it takes ${Object.keys(sessionAmounts(session)).join(', ')}`);
  }
  return asset;
}

/**
 * Change what a session is to be paid in, after the address is on file.
 * POST /api/checkout/pick-asset
 *
 * The page offers "pay in ETH instead" until a payment is seen; from then
 * on the asset that arrived is the asset. Settlement watches every asset
 * regardless, so this only changes what the page shows.
 */
router.post('/pick-asset', checkoutLimiter, async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) throw new ApiError(400, 'sessionId is required');
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, 'Checkout session not found');
    if (TERMINAL.includes(session.status)) throw new ApiError(409, 'This session is already complete');
    if (session.pendingTxHash) throw new ApiError(409, 'A payment has already been seen for this session');

    const asset = pickAsset(session, req.body.asset);
    const updated = normalise(db.update('checkoutSessions', sessionId, { asset }));
    res.json({
      success: true,
      asset,
      amount: amountDue(updated, asset),
      paymentUri: updated.clientWalletAddress ? paymentUri(updated) : null,
      paymentQr: updated.clientWalletAddress ? await paymentQr(updated) : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * A connected wallet reports the transaction it just sent.
 * POST /api/checkout/tx-hint
 *
 * Nothing is trusted from this: the hash is only a pointer. Settlement
 * fetches the transaction itself and checks the sender, recipient and value
 * before anything is credited.
 */
router.post('/tx-hint', checkoutLimiter, async (req, res, next) => {
  try {
    const { sessionId, txHash } = req.body;
    if (!sessionId) throw new ApiError(400, 'sessionId is required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new ApiError(400, 'txHash must be a 32-byte hex hash');

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, 'Checkout session not found');
    if (family(session.chain) !== 'evm') throw new ApiError(400, 'Transaction hints are only accepted for EVM chains');
    if (!session.clientWalletAddress) throw new ApiError(409, 'Submit the paying address first');
    if (TERMINAL.includes(session.status)) throw new ApiError(409, 'This session is already complete');

    // First hint wins. A second one cannot redirect settlement elsewhere.
    if (session.hintTxHash && session.hintTxHash !== txHash) {
      throw new ApiError(409, 'A transaction has already been reported for this session');
    }

    const updated = normalise(db.update('checkoutSessions', sessionId, {
      hintTxHash: txHash,
      hintedAt: new Date().toISOString(),
      // Let the next poll check straight away rather than wait out the throttle.
      lastCheckedAt: null,
    }));

    const settled = await settle(updated);
    res.json(buildStatusResponse(settled));
  } catch (error) {
    next(error);
  }
});

/**
 * Poll for payment status.
 * GET /api/checkout/status/:sessionId
 */
router.get('/status/:sessionId', checkoutLimiter, async (req, res, next) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session) throw new ApiError(404, 'Checkout session not found');

    if (TERMINAL.includes(session.status)) {
      return res.json(buildStatusResponse(session));
    }

    const current = await expireIfUnpaid(session);
    if (TERMINAL.includes(current.status)) {
      return res.json(buildStatusResponse(current));
    }

    // Still waiting for the buyer to identify themselves.
    if (!current.clientWalletAddress) {
      return res.json(buildStatusResponse(current));
    }

    const settled = await settle(current);
    res.json(buildStatusResponse(settled));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.STATUS = STATUS;
module.exports._internals = { resolveAmounts, confirmationsOf, normalise, paymentUri, settlementToken, findPayment, findCoinPayment, findTokenPayment, amountsFor, sessionAmounts, sessionAsset, amountDue, pickAsset, settle, settleNow, checkExpiry, expireIfUnpaid, verifyHintedEvmPayment, scanEvmPaymentOverRpc, rpcScanBaseline, scansOverRpc, readEvmBlocks, RECHECK_INTERVAL_MS, RPC_SCAN_MAX_BLOCKS, RPC_SCAN_FIRST_LOOKBACK, LOG_WINDOW_BLOCKS, LOG_WINDOWS_PER_CHECK, LOG_OVERLAP_BLOCKS, TRANSFER_TOPIC, logWindowByChain };
