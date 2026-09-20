/**
 * GasEstimator - one source of truth for what a transfer actually costs.
 *
 * Each wallet service already estimates fees from a live source (mempool.space
 * for BTC, the node's relay fee for LTC, getRecentPrioritizationFees for SOL,
 * getFeeData for ETH). Those were only consulted at broadcast time; the numbers
 * shown to clients and used to decide eligibility were hardcoded constants.
 *
 * That is wrong in both directions. Fee markets move by an order of magnitude:
 * when the network is cheap a fixed buffer wrongly rejects wallets as too small
 * to withdraw, and when it is expensive the reserve is too thin and the send
 * fails to broadcast.
 *
 * Results are cached briefly - a preview and the withdrawal it turns into
 * should agree, and a batch should not hammer the fee APIs once per wallet.
 */
const PriceService = require('./PriceService');
const chains = require('../config/chains');
const logger = require('./logger');

const CACHE_TTL_MS = 60 * 1000;

/**
 * Last-resort values from the registry, used only when the live estimate is
 * unreachable. Set deliberately on the high side: over-reserving leaves dust
 * behind, while under-reserving produces a transaction the network will not
 * accept.
 */
const FALLBACK_NATIVE = Object.fromEntries(chains.list().map((c) => [c.code, c.fallbackGasNative]));

/** Native units per smallest unit, for the chains that report integers. */
const SATS = 1e8;
const LAMPORTS = 1e9;

class GasEstimator {
  constructor() {
    this.cache = new Map();
  }

  usdRate(chain) {
    return PriceService[`${String(chain).toLowerCase()}ToUsdRate`] || 0;
  }

  /**
   * Cost of one outbound transfer on `chain`.
   *
   * @param {string} chain
   * @returns {Promise<{native: number, usd: number, live: boolean}>}
   */
  async estimate(chain) {
    const key = chain.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }

    let native = null;

    try {
      native = await this.fetchNative(key);
    } catch (error) {
      logger.warn(`[GasEstimator] Live estimate failed for ${key}: ${error.message}`);
    }

    const live = native !== null && Number.isFinite(native) && native > 0;
    if (!live) {
      native = FALLBACK_NATIVE[key] ?? 0.001;
    }

    const value = {
      native,
      usd: native * this.usdRate(key),
      live,
    };

    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Ask the chain's own wallet service, and convert whatever unit it reports
   * into native units.
   */
  async fetchNative(chain) {
    if (!chains.has(chain)) return null;
    // Required lazily: the wallet services pull in PayoutService-adjacent
    // modules, and a top-level import here would create a require cycle.
    const { walletServiceFor } = require('./wallets');
    const service = walletServiceFor(chain);

    switch (chains.get(chain).family) {
      case 'evm': {
        const result = await service.estimateFee('0x0000000000000000000000000000000000000000');
        if (result && result.status === 'success') return Number(result.totalMaxFeeEth);
        return null;
      }
      case 'utxo': {
        const satoshis = await service.estimateFee(3);
        return Number.isFinite(satoshis) ? satoshis / SATS : null;
      }
      case 'solana': {
        const lamports = await service.estimateFee(1);
        return Number.isFinite(lamports) ? lamports / LAMPORTS : null;
      }
      default:
        return null;
    }
  }

  /**
   * Estimates for several chains at once, resolved in parallel.
   * @returns {Promise<Object>} keyed by chain
   */
  async estimateMany(chains) {
    const unique = [...new Set(chains.map((c) => c.toUpperCase()))];
    const results = await Promise.all(unique.map((chain) => this.estimate(chain)));

    return unique.reduce((acc, chain, index) => {
      acc[chain] = results[index];
      return acc;
    }, {});
  }

  /**
   * How much native currency to leave behind so the send can be broadcast.
   *
   * Carries a safety multiplier because the fee market can move between the
   * estimate and the broadcast. Under-reserving means the transaction is
   * rejected; over-reserving only leaves a little dust.
   */
  async reserveFor(chain, multiplier = 1.5) {
    const { native } = await this.estimate(chain);
    return native * multiplier;
  }

  /** Drop cached values - used by tests. */
  clear() {
    this.cache.clear();
  }
}

module.exports = new GasEstimator();
module.exports.FALLBACK_NATIVE = FALLBACK_NATIVE;
