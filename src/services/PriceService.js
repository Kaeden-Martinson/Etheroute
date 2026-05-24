/**
 * PriceService - Centralized price fetching for all chains
 * Fetches USD rates from CoinGecko and caches them
 * Used by BalanceWatcher and SwapService
 */
class PriceService {
  constructor() {
    this.ethToUsdRate = undefined;
    this.solToUsdRate = undefined;
    this.btcToUsdRate = undefined;
    this.ltcToUsdRate = undefined;

    this._createUpdateLoop();
  }

  /**
   * Fetch all prices from CoinGecko
   */
  async tickUpdate() {
    try {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,bitcoin,litecoin&vs_currencies=usd");
      const data = await response.json();
      this.ethToUsdRate = data.ethereum.usd;
      this.solToUsdRate = data.solana.usd;
      this.btcToUsdRate = data.bitcoin.usd;
      this.ltcToUsdRate = data.litecoin.usd;
    } catch (error) {
      console.error("Error fetching prices from CoinGecko:", error.message);
    }
  }

  /**
   * Create update loop - fetch prices every 60 seconds
   */
  _createUpdateLoop() {
    this.tickUpdate(); // Initial fetch
    setInterval(async () => {
      try {
        await this.tickUpdate();
      } catch (error) {
        console.error("Error in price update loop:", error.message);
      }
    }, 60 * 1000);
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
