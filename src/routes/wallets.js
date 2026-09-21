const { Router } = require('express');
const QRCode = require('qrcode');
const WalletService = require('../services/WalletService');
const BalanceWatcher = require('../services/BalanceWatcher');
const PriceService = require('../services/PriceService');
const { db } = require('../config/database');
const { validateChain } = require('../utils/validators');
const { ApiError, ValidationError } = require('../utils/errors');
const { assertOwnership } = require('../middleware/auth');
const chains = require('../config/chains');
const { config } = require('../config/env');
const GasEstimator = require('../services/GasEstimator');

const router = Router();

// A wallet's balance is re-read from the chain at most this often on demand.
const BALANCE_REFRESH_MIN_MS = 30 * 1000;

const LABEL_MAX = 40;

/**
 * A wallet's display name, or null to clear it. Whitespace-trimmed, bounded,
 * and plain text - it is rendered on the dashboard and in pickers.
 */
function normaliseLabel(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('label must be a string');
  const label = raw.replace(/\s+/g, ' ').trim();
  if (label.length === 0) return null;
  if (label.length > LABEL_MAX) throw new ValidationError(`label must be ${LABEL_MAX} characters or fewer`);
  return label;
}

/**
 * Shape a wallet for the API. Secrets are dropped here rather than relied on
 * being absent - this is the only place wallets are serialised for clients.
 */
function presentWallet(wallet) {
  const rawBalance = wallet.balance || 0;
  // Dollars at today's rate, not the rate of the last chain read: prices
  // move between refreshes and the figure should follow. The stored USD is
  // the fallback for a coin the price feed has not priced yet.
  const liveRate = PriceService.rateFor(wallet.chain);
  const rawBalanceUSD = liveRate > 0 ? rawBalance * liveRate : (wallet.balanceUSD || 0);

  // Platform fees charged on past withdrawals that are still sitting at this
  // address awaiting collection. Reported separately rather than silently
  // deducted: the wallet really does hold this, and showing a client a balance
  // of zero for an address that demonstrably holds funds is both confusing and
  // impossible to reconcile against the chain.
  const feeHeld = Math.min(wallet.serviceSubtractions || 0, rawBalance);
  const available = Math.max(0, rawBalance - feeHeld);
  const perUnit = rawBalance > 0 ? rawBalanceUSD / rawBalance : 0;

  const walletTxs = db.findBy('transactions', { fromAddress: wallet.address });
  const isProcessing = walletTxs.some((t) => t.status === 'PENDING' || t.status === 'PROCESSING');

  // The chain's dollar tokens, every one listed even at zero so the shape is
  // the same for every wallet on the chain. At par: a token is its dollars.
  // A token is withdrawable like the coin - paid out as itself, or swapped
  // on its chain - but it is reported beside the coin, not folded into
  // `balance`, because the two are different assets. A token's own platform
  // fee from earlier withdrawals is held back the same way the coin's is.
  const held = wallet.tokenBalances || {};
  const feesHeld = wallet.serviceSubtractionsTokens || {};
  const tokens = chains.tokensOf(wallet.chain).map((token) => {
    const onChain = Number(held[token.symbol]) || 0;
    const feeHeldToken = Math.min(Number(feesHeld[token.symbol]) || 0, onChain);
    const amount = Math.max(0, onChain - feeHeldToken);
    return { symbol: token.symbol, contract: token.contract, balance: amount, balanceUSD: amount, onChainBalance: onChain, platformFeeHeld: feeHeldToken };
  });
  const tokensUSD = tokens.reduce((sum, token) => sum + token.balanceUSD, 0);

  return {
    id: wallet.id,
    address: wallet.address,
    chain: wallet.chain,
    // Merchant-chosen name, for telling one ETH wallet from another.
    label: wallet.label || null,

    // Yours to withdraw.
    balance: available,
    balanceUSD: available * perUnit,

    // What the address actually holds - verifiable on-chain.
    onChainBalance: rawBalance,
    onChainBalanceUSD: rawBalanceUSD,

    // Owed to the platform from earlier withdrawals, if any.
    platformFeeHeld: feeHeld,
    platformFeeHeldUSD: feeHeld * perUnit,

    // Dollar tokens held at the address (EVM chains), and their sum.
    tokens,
    tokensUSD,

    createdAt: wallet.createdAt,
    // When the chain was last read for this wallet.
    lastUpdated: wallet.lastUpdated || null,
    isProcessing,
    ...(isProcessing && { ineligibilityReason: 'Transaction currently processing' }),
  };
}

/**
 * List the caller's wallets.
 * GET /api/wallets/list
 *
 * Balances are served from the database. A background refresh is kicked off but
 * not awaited, so one slow RPC endpoint cannot stall the dashboard.
 */
router.get('/list', (req, res, next) => {
  try {
    const wallets = WalletService.getWalletsByClient(req.auth.clientId);

    for (const wallet of wallets) {
      // Every refresh is a call to a public explorer or RPC that rate-limits
      // by IP. A client (or a partner integration) polling this endpoint
      // every few seconds used to fan out into one upstream call per wallet
      // per poll, and everyone's balances went stale together once the
      // provider started answering 429.
      const age = Date.now() - new Date(wallet.lastUpdated || 0).getTime();
      if (age < BALANCE_REFRESH_MIN_MS) continue;

      BalanceWatcher.updateWalletBalance(wallet).catch((error) => {
        console.warn(`[wallets] Background balance refresh failed for ${wallet.id}: ${error.message}`);
      });
    }

    res.json(wallets.map(presentWallet));
  } catch (error) {
    next(error);
  }
});

/**
 * Read every wallet's balance from its chain now and return them fresh.
 * The dashboard asks right after it sends a withdrawal, and when a payout
 * it is watching settles. Throttled per client: a second ask inside a few
 * seconds returns what the first read.
 * POST /api/wallets/refresh
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const wallets = await BalanceWatcher.refreshClient(req.auth.clientId);
    res.json(wallets.map(presentWallet));
  } catch (error) {
    next(error);
  }
});

/**
 * Generate a new wallet for the caller.
 * POST /api/wallets/generate
 */
router.post('/generate', (req, res, next) => {
  try {
    const { chain } = req.body;

    if (!chain || !validateChain(chain)) {
      throw new ValidationError(`Valid chain is required (one of ${require('../config/chains').CODES.join(', ')})`);
    }
    const label = normaliseLabel(req.body.label);

    const wallet = WalletService.generateWallet(req.auth.clientId, chain);
    if (!wallet) {
      throw new ApiError(500, 'Wallet generation failed');
    }
    if (label) db.update('wallets', wallet.id, { label });

    res.status(201).json({
      id: wallet.id,
      address: wallet.address,
      chain: wallet.chain,
      label,
      clientId: wallet.clientId,
      balance: wallet.balance,
      createdAt: wallet.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The wallet's address as a QR, for anyone who wants to pay it directly.
 * Drawn the way the payment link's QR is; the address is public by nature.
 * GET /api/wallets/:walletId/qr
 */
router.get('/:walletId/qr', async (req, res, next) => {
  try {
    const wallet = assertOwnership(db.getById('wallets', req.params.walletId), req, 'Wallet');
    const svg = await QRCode.toString(wallet.address, {
      type: 'svg',
      margin: 1,
      width: 180,
      errorCorrectionLevel: 'M',
    });
    res.json({ success: true, address: wallet.address, chain: wallet.chain, svg });
  } catch (error) {
    next(error);
  }
});

/**
 * Rename a wallet. Send an empty label to clear it.
 * PATCH /api/wallets/:walletId
 */
router.patch('/:walletId', (req, res, next) => {
  try {
    const wallet = assertOwnership(db.getById('wallets', req.params.walletId), req, 'Wallet');
    if (!('label' in req.body)) throw new ValidationError('label is required');

    const label = normaliseLabel(req.body.label);
    const updated = db.update('wallets', wallet.id, { label });

    res.json(presentWallet(updated));
  } catch (error) {
    next(error);
  }
});

/**
 * Close a wallet.
 * DELETE /api/wallets/delete
 *
 * A soft delete: the record holds the only copy of the signing key, so
 * destroying it would strand any funds still at that address. The wallet is
 * read from its chain first, and closing is refused while it holds anything
 * the merchant could still withdraw (over the chain's withdrawal minimum) or
 * has a transaction in flight. What is left - the platform's held fee, and
 * the remainder too small to withdraw - is forfeited to the platform, and
 * the response says exactly what that was.
 */
router.delete('/delete', async (req, res, next) => {
  try {
    const { walletId } = req.body;
    if (!walletId) throw new ValidationError('walletId is required');

    let wallet = assertOwnership(db.getById('wallets', walletId), req, 'Wallet');
    if (wallet.isActive === false) throw new ApiError(409, 'This wallet is already closed.');

    const walletTxs = db.findBy('transactions', { fromAddress: wallet.address });
    if (walletTxs.some((t) => t.status === 'PENDING' || t.status === 'PROCESSING')) {
      throw new ApiError(409, 'Cannot close a wallet with a transaction in progress.');
    }

    // The figures this decides on must be the chain's, not minutes old.
    try {
      await BalanceWatcher.updateWalletBalance(wallet);
    } catch {
      // the stored figure, then
    }
    wallet = db.getById('wallets', walletId);

    const chain = chains.get(wallet.chain);
    const rate = PriceService.rateFor(wallet.chain) || 0;
    const gas = await GasEstimator.estimate(wallet.chain);
    const feeRate = config.payouts.platformFeeRate;
    // A plain send of the coin, or of a token (about three plain sends'
    // worth of gas), on this chain: what a withdrawal would need.
    const SwapService = require('../services/SwapService');
    const coinMinimumUsd = SwapService.minimumBalanceUsd(wallet.chain, wallet.chain, feeRate, gas.usd, 'direct');
    const tokenMinimumUsd = SwapService.minimumBalanceUsd(wallet.chain, wallet.chain, feeRate, gas.usd * 3, 'direct');

    const onChain = Number(wallet.balance) || 0;
    const available = Math.max(0, onChain - (Number(wallet.serviceSubtractions) || 0));
    if (available * rate >= coinMinimumUsd) {
      throw new ApiError(409, `This wallet still holds ${available.toFixed(6)} ${chain.symbol} ($${(available * rate).toFixed(2)}) you can withdraw. Withdraw it first, then close the wallet.`);
    }
    const heldTokens = wallet.serviceSubtractionsTokens || {};
    for (const [symbol, amount] of Object.entries(wallet.tokenBalances || {})) {
      const availableToken = Math.max(0, (Number(amount) || 0) - (Number(heldTokens[symbol]) || 0));
      if (availableToken >= tokenMinimumUsd) {
        throw new ApiError(409, `This wallet still holds ${availableToken.toFixed(2)} ${symbol} you can withdraw. Withdraw it first, then close the wallet.`);
      }
    }

    const closed = WalletService.closeWallet(walletId, { by: 'merchant' });
    const forfeited = {
      coin: { asset: chain.symbol, amount: closed.forfeited.coin, usd: closed.forfeited.coin * rate },
      tokens: Object.entries(closed.forfeited.tokens).map(([symbol, amount]) => ({ asset: symbol, amount, usd: amount })),
    };
    forfeited.usd = forfeited.coin.usd + forfeited.tokens.reduce((sum, t) => sum + t.usd, 0);

    res.json({
      message: forfeited.usd > 0
        ? `Wallet closed. ${[forfeited.coin.amount > 0 ? `${forfeited.coin.amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} ${chain.symbol}` : null, ...forfeited.tokens.map((t) => `${t.amount} ${t.asset}`)].filter(Boolean).join(' and ')} left at the address is retained by the platform.`
        : 'Wallet closed.',
      forfeited,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
