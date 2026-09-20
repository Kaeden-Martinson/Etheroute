/**
 * PriceService - Centralized price fetching for all chains
 * Fetches USD rates from CoinGecko and caches them
 * Used by BalanceWatcher and SwapService
 */
const { config } = require('../config/env');
const chains = require('../config/chains');

// One request for every coin the registry knows. L2s share Ethereum's id, so
// the list is shorter than the chain list.
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${chains.coingeckoIds().join(',')}&vs_currencies=usd`;

class PriceService {
  constructor() {
    this.ethToUsdRate = undefined;
    this.solToUsdRate = undefined;
    this.btcToUsdRate = undefined;
    this.ltcToUsdRate = undefined;

    // When the rates were last refreshed successfully. A rate that has not
    // moved for an hour because CoinGecko has been refusing us is not a rate
    // anyone should be charged at.
    this.updatedAt = null;
    this.lastError = null;

    this._createUpdateLoop();
  }

  /**
   * Fetch all prices from CoinGecko
   */
  async tickUpdate() {
    try {
      const headers = {};
      if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;

      const response = await fetch(COINGECKO_URL, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        // 429 is the common one on the keyless tier. The body is JSON with a
        // status.error_message; reading `data.ethereum.usd` off it threw a
        // TypeError that hid the real reason.
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // The four original chains must all be present - a partial answer is
      // an error, as before. A newer chain missing its rate is logged and
      // left at its previous value, so one bad id cannot take the feed down.
      const required = ['ethereum', 'solana', 'bitcoin', 'litecoin'];
      for (const id of required) {
        if (!Number.isFinite(data?.[id]?.usd) || data[id].usd <= 0) throw new Error(`no ${id} rate in response`);
      }

      for (const chain of chains.list()) {
        const rate = data?.[chain.coingeckoId]?.usd;
        if (Number.isFinite(rate) && rate > 0) {
          this[`${chain.code.toLowerCase()}ToUsdRate`] = rate;
        } else if (!required.includes(chain.coingeckoId)) {
          console.warn(`[PriceService] No rate for ${chain.code} (${chain.coingeckoId}) in CoinGecko response`);
        }
      }

      this.updatedAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      console.error("Error fetching prices from CoinGecko:", error.message);
    }
  }

  /** USD rate for a chain code, or 0 when it has not loaded. */
  rateFor(code) {
    return this[`${String(code).toLowerCase()}ToUsdRate`] || 0;
  }

  /** Seconds since the last successful refresh, or null if never. */
  ageSeconds() {
    return this.updatedAt ? Math.round((Date.now() - this.updatedAt) / 1000) : null;
  }

  /**
   * Whether the cached rates are recent enough to price something with.
   * Under test the rates are pinned by hand and never expire.
   */
  isFresh(maxAgeMs = (config.priceMaxAgeMinutes || 15) * 60 * 1000) {
    if (process.env.NODE_ENV === 'test') return true;
    return Boolean(this.updatedAt) && Date.now() - this.updatedAt <= maxAgeMs;
  }

  /**
   * Create update loop - fetch prices every 60 seconds
   */
  _createUpdateLoop() {
    // Skip the network entirely under test - rates are set explicitly there.
    if (process.env.NODE_ENV === 'test') return;

    this.tickUpdate(); // Initial fetch

    this._timer = setInterval(async () => {
      try {
        await this.tickUpdate();
      } catch (error) {
        console.error("Error in price update loop:", error.message);
      }
    }, 60 * 1000);

    // Do not hold the process open on this timer alone, so the app can shut
    // down cleanly and short-lived scripts can exit.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * Stop the refresh loop. Called during graceful shutdown.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get ETH to chain exchange rate
   */
  getEthRate(chain) {
    const rate = this[`${chain}ToUsdRate`];
    if (!this.ethToUsdRate || !rate) {
      return 0;
    }
    return rate / this.ethToUsdRate;
  }

  /**
   * Get all current rates
   */
  getAllRates() {
    return {
      ethToUsd: this.ethToUsdRate,
      solToUsd: this.solToUsdRate,
      btcToUsd: this.btcToUsdRate,
      ltcToUsd: this.ltcToUsdRate,
      solToEth: this.getEthRate('sol'),
      btcToEth: this.getEthRate('btc'),
      ltcToEth: this.getEthRate('ltc'),
    };
  }
}

module.exports = new PriceService();
