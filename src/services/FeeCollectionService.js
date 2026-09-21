'use strict';

/**
 * FeeCollectionService - the platform's fee, moved to the platform.
 *
 * A withdrawal takes the platform's share out of what is sent and leaves it
 * in the merchant's wallet, on the books as held (serviceSubtractions on
 * the wallet record, per asset). This service is what turns held into
 * collected:
 *
 *  - On a Bitcoin-style chain the fee rides in the withdrawal itself, as a
 *    second output to the platform's address: nothing held, nothing to
 *    sweep. SwapService asks `feeOutputFor` when it plans such a leg.
 *  - Everywhere else a transfer has one recipient, so the fee waits in the
 *    wallet until it is worth a transaction of its own. `collect()` sweeps
 *    each wallet's held fee to the platform's address once it clears
 *    FEE_COLLECT_MIN_USD and FEE_COLLECT_GAS_MULTIPLE times the gas.
 *
 * One address per family: PLATFORM_FEE_ADDRESS_EVM serves every EVM chain;
 * _BTC, _LTC, _BCH, _DOGE, _SOL and _XRP their own. A family with no
 * address keeps holding, as before. Every collection is a row in
 * feeCollections, and a sweep is also a FEE_COLLECTION transaction on the
 * merchant's ledger, watched to confirmation like any other transfer.
 */

const crypto = require('crypto');
const { db } = require('../config/database');
const chains = require('../config/chains');
const { validateCryptoAddress } = require('../utils/validators');
const PriceService = require('./PriceService');
const GasEstimator = require('./GasEstimator');
const { walletServiceFor } = require('./wallets');
const logger = require('./logger');

// Below this a held fee is not worth a transaction of its own.
const MIN_USD = Number(process.env.FEE_COLLECT_MIN_USD || 10);
// And the fee must be worth at least this many times the gas it costs to move.
const GAS_MULTIPLE = Number(process.env.FEE_COLLECT_GAS_MULTIPLE || 20);
// The sweep's cadence; 0 leaves it to the CLI.
const INTERVAL_MS = Number(process.env.FEE_COLLECT_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
// Gas headroom, as SwapService keeps it.
const GAS_SAFETY = 1.5;
// A token transfer costs about this many plain transfers' worth of gas.
const TOKEN_GAS_TXS = 3;
// A closed wallet is emptied, not swept for a fee: anything worth this many
// times its gas goes, with no dollar floor.
const CLOSED_GAS_MULTIPLE = Number(process.env.FEE_COLLECT_CLOSED_GAS_MULTIPLE || 2);
// The families an address can be set for. Anything else under the prefix
// is a typo, and said so at start.
const FAMILIES = ['EVM', 'BTC', 'LTC', 'BCH', 'DOGE', 'SOL', 'XRP'];

class FeeCollectionService {
  constructor(env = process.env) {
    this.env = env;
    this.warned = new Set();
    this.timer = null;
    this.running = false;
  }

  /** The env key that names the platform's address for `chain`. */
  static envKeyFor(chain) {
    const c = chains.get(chain);
    if (!c) return null;
    return c.family === 'evm' ? 'PLATFORM_FEE_ADDRESS_EVM' : `PLATFORM_FEE_ADDRESS_${c.code}`;
  }

  /** The platform's address on `chain`, or null when none is set (or it is not one). */
  addressFor(chain) {
    const code = String(chain || '').toUpperCase();
    const key = FeeCollectionService.envKeyFor(code);
    if (!key) return null;
    const address = String(this.env[key] || '').trim();
    if (!address) return null;
    if (!validateCryptoAddress(address, code)) {
      if (!this.warned.has(key)) {
        this.warned.add(key);
        logger.warn(`[FeeCollection] ${key} is not a valid ${code} address; fees on ${code} stay held`);
      }
      return null;
    }
    return address;
  }

  /** Whether any family has an address to collect to. */
  configured() {
    return ['ETH', 'BTC', 'LTC', 'BCH', 'DOGE', 'SOL', 'XRP'].some((code) => chains.has(code) && this.addressFor(code));
  }

  /** The smallest output a Bitcoin-style chain relays, in coin. */
  dustOf(chain) {
    const service = walletServiceFor(chain);
    const sats = (service && service.spec && service.spec.dustSats)
      || (service && service.constructor && service.constructor.DUST_SATS)
      || 546;
    return sats / 1e8;
  }

  /**
   * For a Bitcoin-style leg: the output that carries the fee in the same
   * transaction, or null when the chain is not that kind, no address is
   * set, or the fee would be dust.
   */
  feeOutputFor(chain, feeAmount) {
    const code = String(chain || '').toUpperCase();
    if (!chains.has(code) || chains.get(code).family !== 'utxo') return null;
    if (!(feeAmount > 0)) return null;
    const address = this.addressFor(code);
    if (!address) return null;
    const amount = Number(Number(feeAmount).toFixed(8));
    if (amount < this.dustOf(code)) return null;
    return { address, amount };
  }

  /**
   * A fee that left in a withdrawal's own transaction: recorded as collected
   * the moment the payout broadcasts, under the payout's hash.
   */
  recordInPayout(wallet, transfer, txHash, payoutId) {
    const out = transfer.feeOutput;
    if (!out || !(out.amount > 0)) return null;
    const rate = PriceService.rateFor(transfer.chain) || 0;
    return db.create('feeCollections', {
      id: crypto.randomUUID(),
      walletId: wallet.id,
      clientId: wallet.clientId,
      chain: transfer.chain,
      asset: chains.get(transfer.chain).symbol,
      amount: out.amount,
      usd: out.amount * rate,
      address: out.address,
      txHash,
      transactionId: null,
      payoutId: payoutId || null,
      via: 'payout',
      status: 'PROCESSING',
      createdAt: new Date().toISOString(),
      confirmedAt: null,
    });
  }

  /** The env keys under the prefix that name no family: a typo, said once. */
  unknownAddressKeys() {
    return Object.keys(this.env).filter((key) => key.startsWith('PLATFORM_FEE_ADDRESS_') && !FAMILIES.includes(key.slice('PLATFORM_FEE_ADDRESS_'.length)));
  }

  /**
   * What every wallet holds for the platform, per asset, at today's rates
   * (a dollar token at par): the fees held in open wallets, and everything
   * left in closed ones. The book the owner reads.
   */
  held() {
    const rows = [];
    for (const wallet of db.getAll('wallets')) {
      if (!chains.has(wallet.chain)) continue;
      const coin = chains.get(wallet.chain).symbol;
      const rate = PriceService.rateFor(wallet.chain) || 0;
      const closed = Boolean(wallet.closedAt);
      const coinHeld = Number(wallet.serviceSubtractions) || 0;
      if (coinHeld > 0) rows.push({ walletId: wallet.id, clientId: wallet.clientId, chain: wallet.chain, address: wallet.address, asset: coin, held: coinHeld, onChain: Number(wallet.balance) || 0, usd: coinHeld * rate, closed });
      for (const [symbol, amount] of Object.entries(wallet.serviceSubtractionsTokens || {})) {
        const tokenHeld = Number(amount) || 0;
        if (tokenHeld > 0) rows.push({ walletId: wallet.id, clientId: wallet.clientId, chain: wallet.chain, address: wallet.address, asset: symbol, held: tokenHeld, onChain: Number((wallet.tokenBalances || {})[symbol]) || 0, usd: tokenHeld, closed });
      }
    }
    return rows;
  }

  /** Held, collected and the recent collections: the owner panel's numbers. */
  summary() {
    const held = this.held();
    const collections = db.getAll('feeCollections');
    const byChain = {};
    for (const c of collections) {
      if (c.status === 'FAILED') continue;
      byChain[c.chain] = byChain[c.chain] || { chain: c.chain, count: 0, usd: 0 };
      byChain[c.chain].count += 1;
      byChain[c.chain].usd += Number(c.usd) || 0;
    }
    return {
      configured: this.configured(),
      nextRunAt: this.nextRunAt || null,
      addresses: Object.fromEntries(['ETH', 'BTC', 'LTC', 'BCH', 'DOGE', 'SOL', 'XRP'].filter((c) => chains.has(c)).map((c) => [c === 'ETH' ? 'EVM' : c, this.addressFor(c)])),
      thresholds: { minUsd: MIN_USD, gasMultiple: GAS_MULTIPLE },
      held: { rows: held, usd: held.reduce((sum, r) => sum + r.usd, 0), wallets: new Set(held.map((r) => r.walletId)).size },
      collected: { usd: Object.values(byChain).reduce((sum, c) => sum + c.usd, 0), count: collections.filter((c) => c.status !== 'FAILED').length, byChain: Object.values(byChain) },
      recent: collections.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50),
    };
  }

  /**
   * Which held fees are worth collecting now, and why the others are not.
   * Reads each candidate wallet from its chain first: a sweep is a real
   * send, and the stored figure may be minutes old.
   */
  async plan({ chain = null, refresh = true } = {}) {
    // Required lazily: BalanceWatcher pulls in the wallet services' state.
    const BalanceWatcher = require('./BalanceWatcher');
    const candidates = [];
    const skipped = [];
    const rows = this.held().filter((r) => !chain || r.chain === String(chain).toUpperCase());
    const walletsById = new Map();

    for (const row of rows) {
      const skip = (reason) => skipped.push({ ...row, reason });
      const address = this.addressFor(row.chain);
      if (!address) { skip(`no ${FeeCollectionService.envKeyFor(row.chain)} set`); continue; }
      // A closed wallet is emptied of whatever beats its gas; an open one
      // waits until the fee is worth a transaction.
      const minUsd = row.closed ? 0 : MIN_USD;
      const gasMultiple = row.closed ? CLOSED_GAS_MULTIPLE : GAS_MULTIPLE;
      if (!(row.usd >= minUsd)) { skip(`$${row.usd.toFixed(2)} held is under the $${MIN_USD} minimum`); continue; }

      let wallet = walletsById.get(row.walletId) || db.getById('wallets', row.walletId);
      if (!wallet) { skip('wallet gone'); continue; }
      if (refresh && !walletsById.has(row.walletId)) {
        // The read writes the record; the record is what is trusted here.
        // (What the read returns has `balance` in dollars, a legacy of the
        // dashboard's first shape - never a figure to send by.)
        let info;
        try {
          info = await BalanceWatcher.updateWalletBalance(wallet);
        } catch (error) {
          info = { status: 'error', error: error.message };
        }
        if (!info || info.status === 'error') { skip(`could not read the wallet from its chain: ${(info && info.error) || 'no answer'}`); continue; }
        wallet = db.getById('wallets', row.walletId);
        if (!wallet) { skip('wallet gone'); continue; }
      }
      walletsById.set(row.walletId, wallet);

      const busy = db.findBy('transactions', { fromAddress: wallet.address }).some((t) => t.status === 'PENDING' || t.status === 'PROCESSING');
      if (busy) { skip('a transfer from this wallet is in flight'); continue; }
      // A closed wallet's held figure is whatever it had when it closed; a
      // deposit that landed since is the platform's too.
      if (row.closed) {
        const coin = chains.get(row.chain).symbol;
        const now = row.asset === coin ? (Number(wallet.balance) || 0) : (Number((wallet.tokenBalances || {})[row.asset]) || 0);
        if (now > row.held) row.held = now;
      }

      const gas = await GasEstimator.estimate(row.chain);
      const coin = chains.get(row.chain).symbol;
      const isToken = row.asset !== coin;
      const coinBalance = Number(wallet.balance) || 0;
      const perTx = gas.native * GAS_SAFETY;
      let collectable;
      if (isToken) {
        const needCoin = perTx * TOKEN_GAS_TXS;
        if (coinBalance < needCoin) { skip(`holds ${coinBalance.toFixed(6)} ${coin}; a ${row.asset} transfer needs about ${needCoin.toFixed(6)} ${coin} for gas`); continue; }
        const onChain = Number((wallet.tokenBalances || {})[row.asset]) || 0;
        collectable = Math.min(row.held, onChain);
      } else {
        const reserve = Math.max(perTx, chains.get(row.chain).minReserveNative || 0);
        collectable = Math.min(row.held, coinBalance - reserve);
      }
      collectable = Number(collectable.toFixed(8));
      if (!(collectable > 0)) { skip(`nothing spare on chain: holds ${(isToken ? Number((wallet.tokenBalances || {})[row.asset]) || 0 : coinBalance).toFixed(6)} ${row.asset}`); continue; }
      if (chains.get(row.chain).family === 'utxo' && collectable < this.dustOf(row.chain)) { skip('below the dust limit'); continue; }

      const rate = isToken ? 1 : (PriceService.rateFor(row.chain) || 0);
      const usd = collectable * rate;
      const gasUsd = gas.usd * (isToken ? TOKEN_GAS_TXS : 1);
      if (!(usd >= minUsd)) { skip(`$${usd.toFixed(2)} collectable is under the $${MIN_USD} minimum`); continue; }
      if (!(usd >= gasUsd * gasMultiple)) { skip(`$${usd.toFixed(2)} is under ${gasMultiple}x the $${gasUsd.toFixed(2)} gas${row.closed ? ' (closed wallet)' : ''}`); continue; }

      candidates.push({ ...row, wallet, to: address, amount: collectable, usd, gasUsd });
    }
    return { candidates, skipped };
  }

  /**
   * Sweep what is worth sweeping. Each send is its own transaction on the
   * merchant's ledger; the held figure comes down by what left. Returns
   * what was collected and what was not, and why.
   */
  async collect({ chain = null, dryRun = false } = {}) {
    if (this.running) return { collected: [], skipped: [], failed: [], note: 'a sweep is already running' };
    this.running = true;
    try {
      // Required lazily: PayoutService requires the world.
      const PayoutService = require('./PayoutService');
      const TransactionService = require('./TransactionService');
      const KeyVault = require('./crypto/KeyVault');
      const BalanceWatcher = require('./BalanceWatcher');
      const { candidates, skipped } = await this.plan({ chain });
      if (dryRun) return { collected: [], skipped, failed: [], planned: candidates.map(({ wallet, ...rest }) => rest) };

      const collected = [];
      const failed = [];
      for (const c of candidates) {
        try {
          const unsealed = KeyVault.unsealWallet(c.wallet);
          const txHash = await PayoutService.sendTransfer(c.chain, unsealed, c.to, c.amount, c.asset);
          const transaction = TransactionService.createTransaction(
            c.clientId, txHash, `direct_transfer_fee_${crypto.randomUUID()}`, 'FEE_COLLECTION', c.chain,
            c.amount, c.usd, c.wallet.address, c.to, c.to, { asset: c.asset, route: 'direct' },
          );
          TransactionService.markTransactionProcessing(transaction.id, txHash);
          this.reduceHeld(c.walletId, c.asset, c.amount);
          const row = db.create('feeCollections', {
            id: crypto.randomUUID(),
            walletId: c.walletId,
            clientId: c.clientId,
            chain: c.chain,
            asset: c.asset,
            amount: c.amount,
            usd: c.usd,
            address: c.to,
            txHash,
            transactionId: transaction.id,
            payoutId: null,
            via: c.closed ? 'closure' : 'sweep',
            status: 'PROCESSING',
            createdAt: new Date().toISOString(),
            confirmedAt: null,
          });
          collected.push(row);
          BalanceWatcher.nudge([c.walletId], []);
          logger.info(`[FeeCollection] ${c.chain} ${c.wallet.address}: ${c.amount} ${c.asset} ($${c.usd.toFixed(2)}) to ${c.to} in ${txHash}`);
        } catch (error) {
          failed.push({ walletId: c.walletId, chain: c.chain, asset: c.asset, amount: c.amount, error: error.message });
          logger.error(`[FeeCollection] ${c.chain} ${c.wallet.address}: ${error.message}`);
        }
      }
      if (collected.length || failed.length) {
        const AlertService = require('./AlertService');
        const total = collected.reduce((sum, r) => sum + r.usd, 0);
        AlertService.notify(
          `Fee sweep: ${collected.length} collected ($${total.toFixed(2)})${failed.length ? `, ${failed.length} failed` : ''}`,
          collected.length ? `${collected.length} transfer${collected.length === 1 ? '' : 's'} to the platform's addresses, $${total.toFixed(2)} in all.` : 'Nothing was collected.',
          'fee-sweep',
          {
            level: failed.length ? 'warning' : 'success',
            fields: [
              ...collected.slice(0, 10).map((r) => ({ name: `${r.chain} · ${r.asset}${r.via === 'closure' ? ' · closed wallet' : ''}`, value: `${r.amount} ($${Number(r.usd).toFixed(2)})\n\`${String(r.txHash).slice(0, 10)}…${String(r.txHash).slice(-6)}\`` })),
              ...failed.slice(0, 5).map((f) => ({ name: `${f.chain} · ${f.asset} failed`, value: `${f.amount}: ${f.error}`, inline: false })),
              ...(skipped.length ? [{ name: 'Waiting', value: `${skipped.length} held fee${skipped.length === 1 ? '' : 's'} not yet worth a transaction`, inline: false }] : []),
            ],
          },
        );
      }
      return { collected, skipped, failed };
    } finally {
      this.running = false;
    }
  }

  /** The held figure for one asset on one wallet, moved by `delta` (never below zero). */
  reduceHeld(walletId, asset, amount) {
    return this.adjustHeld(walletId, asset, -Math.abs(amount));
  }

  adjustHeld(walletId, asset, delta) {
    return db.transaction('wallets', walletId, (wallet) => {
      const coin = chains.has(wallet.chain) ? chains.get(wallet.chain).symbol : null;
      if (asset === coin) {
        return { serviceSubtractions: Math.max(0, Number(((Number(wallet.serviceSubtractions) || 0) + delta).toFixed(8))) };
      }
      const held = { ...(wallet.serviceSubtractionsTokens || {}) };
      held[asset] = Math.max(0, Number(((Number(held[asset]) || 0) + delta).toFixed(8)));
      if (held[asset] === 0) delete held[asset];
      return { serviceSubtractionsTokens: held };
    });
  }

  /**
   * Cap every wallet's held figures at what the wallet actually holds: the
   * figures from before fees were recorded exactly could exceed the chain.
   * Returns how many figures moved.
   */
  reconcileHeld() {
    let changed = 0;
    for (const wallet of db.getAll('wallets')) {
      if (!chains.has(wallet.chain)) continue;
      const updates = {};
      const coinHeld = Number(wallet.serviceSubtractions) || 0;
      const onChain = Number(wallet.balance) || 0;
      if (coinHeld > onChain) { updates.serviceSubtractions = Number(onChain.toFixed(8)); changed += 1; }
      const tokens = { ...(wallet.serviceSubtractionsTokens || {}) };
      let tokensMoved = false;
      for (const [symbol, amount] of Object.entries(tokens)) {
        const have = Number((wallet.tokenBalances || {})[symbol]) || 0;
        if (Number(amount) > have) { tokens[symbol] = Number(have.toFixed(8)); tokensMoved = true; changed += 1; }
        if (!(tokens[symbol] > 0)) delete tokens[symbol];
      }
      if (tokensMoved) updates.serviceSubtractionsTokens = tokens;
      if (Object.keys(updates).length) db.update('wallets', wallet.id, updates);
    }
    return changed;
  }

  /**
   * A collection's transaction settled or failed on its chain (the
   * maintenance reconcile tells us). A failed sweep leaves the fee in the
   * wallet, so it is held again.
   */
  onTransactionResolved(transaction, outcome) {
    if (!transaction || transaction.type !== 'FEE_COLLECTION') return;
    const row = db.findOneBy('feeCollections', { transactionId: transaction.id });
    if (!row || row.status !== 'PROCESSING') return;
    if (outcome === 'confirmed') {
      db.update('feeCollections', row.id, { status: 'CONFIRMED', confirmedAt: new Date().toISOString() });
    } else if (outcome === 'failed') {
      db.update('feeCollections', row.id, { status: 'FAILED' });
      this.adjustHeld(row.walletId, row.asset, Number(row.amount) || 0);
      logger.warn(`[FeeCollection] ${row.chain} ${row.amount} ${row.asset} did not settle (${transaction.transactionHash}); held again`);
    }
  }

  /** A payout's transfer settled or failed: the fee that rode in it did too. */
  onPayoutTransferResolved(txHash, outcome) {
    if (!txHash) return;
    for (const row of db.findBy('feeCollections', { txHash, via: 'payout' })) {
      if (row.status !== 'PROCESSING') continue;
      db.update('feeCollections', row.id, outcome === 'confirmed'
        ? { status: 'CONFIRMED', confirmedAt: new Date().toISOString() }
        : { status: 'FAILED' });
    }
  }

  /** The daily sweep, some minutes after boot so the balances have been read. */
  start() {
    if (this.timer || !(INTERVAL_MS > 0)) return;
    for (const key of this.unknownAddressKeys()) {
      logger.warn(`[FeeCollection] ${key} names no family and is ignored; the addresses are ${FAMILIES.map((f) => `PLATFORM_FEE_ADDRESS_${f}`).join(', ')}`);
    }
    if (!this.configured()) {
      logger.info('[FeeCollection] No PLATFORM_FEE_ADDRESS_* set; fees are held in the merchants\' wallets until one is');
      return;
    }
    const run = () => {
      this.nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();
      this.collect().catch((error) => logger.error(`[FeeCollection] Sweep failed: ${error.message}`));
    };
    this.nextRunAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    setTimeout(run, 10 * 60 * 1000).unref?.();
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref?.();
    logger.info(`[FeeCollection] Started — sweep every ${Math.round(INTERVAL_MS / 3600000)}h; collecting fees over $${MIN_USD} and ${GAS_MULTIPLE}x gas`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.nextRunAt = null;
  }
}

module.exports = new FeeCollectionService();
module.exports.FeeCollectionService = FeeCollectionService;
module.exports.MIN_USD = MIN_USD;
module.exports.GAS_MULTIPLE = GAS_MULTIPLE;
