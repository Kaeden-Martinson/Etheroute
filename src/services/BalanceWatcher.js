const { db } = require('../config/database');
const PriceService = require('./PriceService');

const EthereumWalletService = require('./wallets/EthereumWalletService');
const SolanaWalletService = require('./wallets/SolanaWalletService');
const BitcoinWalletService = require('./wallets/BitcoinWalletService');
const LitecoinWalletService = require('./wallets/LitecoinWalletService');

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
        const oldBalance = parseFloat(wallet.balance) || 0;
        let updatedWallet;

        switch (wallet.chain) {
            case 'ETH': updatedWallet = await EthereumWalletService.updateBalance(wallet, this.ethToUsdRate); break;
            case 'LTC': updatedWallet = await LitecoinWalletService.updateBalance(wallet, this.ltcToUsdRate); break;
            case 'BTC': updatedWallet = await BitcoinWalletService.updateBalance(wallet, this.btcToUsdRate); break;
            case 'SOL': updatedWallet = await SolanaWalletService.updateBalance(wallet, this.solToUsdRate); break;
        }

        // Detect >90% balance drop — the remaining balance is the retained service fee.
        // Setting serviceSubtractions = newBalance makes the displayed client balance = 0.
        if (updatedWallet && oldBalance > 0.000001) {
            const newBalance = parseFloat(updatedWallet.balance) || 0;
            if (newBalance < oldBalance * 0.10) {
                db.update('wallets', wallet.id, { serviceSubtractions: newBalance });
                console.log(`[BalanceWatcher] 90%+ drop on ${wallet.chain} wallet ${wallet.id}: ${oldBalance} → ${newBalance}. serviceSubtractions set to ${newBalance}`);
            }
        }

        return updatedWallet;
    }

    /**
     * Get transaction history for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<Object>} Transaction data
     */
    async getTransactionHistory(wallet) {
        switch (wallet.chain) {
            case 'ETH': {
                return await EthereumWalletService.getTransactionHistory(wallet.address);
            };
            break;

            case 'LTC': { 
                return await LitecoinWalletService.getTransactionHistory(wallet.address);
            }; 
            break;

            case 'BTC': {
                return await BitcoinWalletService.getTransactionHistory(wallet.address);
            };
            break;
            
            case 'SOL': {
                return await SolanaWalletService.getTransactionHistory(wallet.address);
            };
            break;
        };
    };
}

module.exports = new BalanceWatcher();
