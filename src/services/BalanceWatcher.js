const { db } = require('../config/database');
const PriceService = require('./PriceService');
const { walletServiceFor } = require('./wallets');

class BalanceWatcher {
    constructor() {
        this.priceService = PriceService;
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
     * Update a wallet's balance on Ethereum
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
}

module.exports = new BalanceWatcher();
