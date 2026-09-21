/**
 * BalanceWatcher - keeps every wallet's stored balance close to the chain.
 *
 * Three ways a balance gets refreshed:
 *
 *   - The sweep. Every minute, the wallets whose figure is oldest are read
 *     again, a bounded batch per tick and a few at a time, so no wallet is
 *     ever more than a few minutes stale whether or not anyone is looking.
 *     A wallet with a transaction in flight is read more often.
 *   - A nudge. When the platform itself moves money - a payout broadcast, a
 *     transfer confirmed or refunded, a checkout settled - the wallets
 *     involved are read at once, off the request path.
 *   - A pull. The dashboard asks (POST /api/wallets/refresh) right after
 *     it sends a withdrawal, and gets the fresh figures back in the reply.
 *
 * Every read is a call to a public explorer or RPC that rate-limits by IP,
 * which is why the sweep is bounded and the pull is throttled per client:
 * a page polling every few seconds used to fan out into one upstream call
 * per wallet per poll, and everyone's balances went stale together once
 * the provider started answering 429.
 */
const { db } = require('../config/database');
const PriceService = require('./PriceService');
const { walletServiceFor } = require('./wallets');
const logger = require('./logger');

// How often the sweep runs, how old a figure must be to be read again, how
// old one with a transaction in flight may be, and how many per tick.
const SWEEP_INTERVAL_MS = Number(process.env.BALANCE_SWEEP_INTERVAL_MS) || 60 * 1000;
const STALE_MS = Number(process.env.BALANCE_STALE_MS) || 3 * 60 * 1000;
const IN_FLIGHT_STALE_MS = 30 * 1000;
const SWEEP_BATCH = Number(process.env.BALANCE_SWEEP_BATCH) || 25;
const CONCURRENCY = 4;

// A pull for the same client inside this window returns what is stored.
const PULL_THROTTLE_MS = 5 * 1000;

class BalanceWatcher {
    constructor() {
        this.priceService = PriceService;
        this.timer = null;
        this.sweeping = null;
        this.pulledAt = new Map();
    }

    /**
     * Get ETH to USD rate from PriceService
     */
    get ethToUsdRate() {
        return this.priceService.ethToUsdRate;
    }

    /**
     * Get SOL to USD rate from PriceService
     */
    get solToUsdRate() {
        return this.priceService.solToUsdRate;
    }

    /**
     * Get BTC to USD rate from PriceService
     */
    get btcToUsdRate() {
        return this.priceService.btcToUsdRate;
    }

    /**
     * Get LTC to USD rate from PriceService
     */
    get ltcToUsdRate() {
        return this.priceService.ltcToUsdRate;
    }

    /**
     * Read a wallet's balance from its chain and store it.
     * @param {Object} wallet - Wallet object with address
     * @returns {Promise<Object>} Balance information
     */
    async updateWalletBalance(wallet) {
        const updatedWallet = await walletServiceFor(wallet.chain).updateBalance(wallet, PriceService.rateFor(wallet.chain));

        // A large balance drop used to be treated as "the rest is our fee" and
        // serviceSubtractions was set to whatever remained, forcing the client's
        // displayed balance to zero. Two problems with that: it guessed rather
        // than reading the fee actually charged, and because it never reset, any
        // deposit the client made afterwards stayed invisible to them.
        //
        // The fee is now a known figure recorded at withdrawal time, so there is
        // nothing to infer here.
        return updatedWallet;
    }

    /**
     * Get transaction history for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<Object>} Transaction data
     */
    async getTransactionHistory(wallet) {
        return walletServiceFor(wallet.chain).getTransactionHistory(wallet.address);
    }

    /** A few at a time, never all at once. */
    async refreshMany(wallets, concurrency = CONCURRENCY) {
        const queue = [...wallets];
        const results = [];
        const worker = async () => {
            while (queue.length) {
                const wallet = queue.shift();
                try {
                    results.push(await this.updateWalletBalance(wallet));
                } catch (error) {
                    logger.warn(`[BalanceWatcher] ${wallet.chain} ${wallet.address}: ${error.message}`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        return results;
    }

    /**
     * Refresh wallets by id right now, off the caller's path: the platform
     * just moved money through them. Any wallet of ours at `addresses` is
     * refreshed too - a payout to one of the client's own wallets lands
     * somewhere we hold.
     */
    nudge(walletIds = [], addresses = []) {
        const wanted = new Set(walletIds.filter(Boolean));
        const lower = new Set(addresses.filter(Boolean).map((a) => String(a).toLowerCase()));
        const wallets = db.findBy('wallets', { isActive: true }).filter((w) => wanted.has(w.id) || lower.has(String(w.address).toLowerCase()));
        if (wallets.length === 0) return Promise.resolve([]);
        return this.refreshMany(wallets).catch((error) => {
            logger.warn(`[BalanceWatcher] nudge failed: ${error.message}`);
            return [];
        });
    }

    /**
     * Refresh a client's wallets and return them fresh. Throttled per client
     * so a page that asks on every render still costs one upstream round a
     * few seconds.
     */
    async refreshClient(clientId, { minAgeMs = PULL_THROTTLE_MS } = {}) {
        const last = this.pulledAt.get(clientId) || 0;
        const wallets = db.findBy('wallets', { clientId, isActive: true });
        if (Date.now() - last >= minAgeMs) {
            this.pulledAt.set(clientId, Date.now());
            if (this.pulledAt.size > 1000) this.pulledAt.clear();
            await this.refreshMany(wallets);
        }
        return db.findBy('wallets', { clientId, isActive: true });
    }

    /** The wallets whose figure is oldest, up to the batch, oldest first. */
    due(now = Date.now()) {
        const inFlight = new Set(
            db.findBy('transactions', { status: 'PROCESSING' }).concat(db.findBy('transactions', { status: 'PENDING' })).map((t) => t.fromAddress)
        );
        return db.findBy('wallets', { isActive: true })
            .map((w) => ({ wallet: w, age: now - new Date(w.lastUpdated || 0).getTime(), busy: inFlight.has(w.address) }))
            .filter(({ age, busy }) => age >= (busy ? IN_FLIGHT_STALE_MS : STALE_MS))
            .sort((a, b) => b.age - a.age)
            .slice(0, SWEEP_BATCH)
            .map(({ wallet }) => wallet);
    }

    /** One sweep: read the stalest wallets. */
    async sweep() {
        if (this.sweeping) return this.sweeping;
        this.sweeping = (async () => {
            const wallets = this.due();
            if (wallets.length === 0) return 0;
            const before = new Map(wallets.map((w) => [w.id, w.balance]));
            const results = await this.refreshMany(wallets);
            const changed = wallets.filter((w) => {
                const fresh = db.getById('wallets', w.id);
                return fresh && fresh.balance !== before.get(w.id);
            });
            if (changed.length) {
                logger.info(`[BalanceWatcher] ${results.length} wallets refreshed, ${changed.length} moved: ${changed.map((w) => `${w.chain} ${w.address.slice(0, 8)}…`).join(', ')}`);
            }
            return results.length;
        })().finally(() => { this.sweeping = null; });
        return this.sweeping;
    }

    start(intervalMs = SWEEP_INTERVAL_MS) {
        if (this.timer) return this.timer;
        this.timer = setInterval(() => {
            this.sweep().catch((error) => logger.error(`[BalanceWatcher] sweep failed: ${error.message}`));
        }, intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        return this.timer;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = new BalanceWatcher();
module.exports.SWEEP_INTERVAL_MS = SWEEP_INTERVAL_MS;
module.exports.STALE_MS = STALE_MS;
module.exports.IN_FLIGHT_STALE_MS = IN_FLIGHT_STALE_MS;
module.exports.SWEEP_BATCH = SWEEP_BATCH;
module.exports.PULL_THROTTLE_MS = PULL_THROTTLE_MS;
