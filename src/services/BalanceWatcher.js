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
        switch (wallet.chain) {
            case 'ETH': {
                return EthereumWalletService.updateBalance(wallet, this.ethToUsdRate, 'mainnet');
            };
            break;

            case 'LTC': { 
                return LitecoinWalletService.updateBalance(wallet, this.ltcToUsdRate, 'mainnet');
            }; 
            break;

            case 'BTC': { 
                return BitcoinWalletService.updateBalance(wallet, this.btcToUsdRate, 'mainnet');
            }; 
            break;

            case 'SOL': {
                return SolanaWalletService.updateBalance(wallet, this.solToUsdRate, 'mainnet');
            };
            break;
        }
    }

    /**
     * Get transaction history for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<Object>} Transaction data
     */
    async getTransactionHistory(address) {
        switch (wallet.chain) {
            case 'ETH': {
                return EthereumWalletService.getTransactionHistory(address, 'mainnet');
            };
            break;

            case 'LTC': { 
                return LitecoinWalletService.getTransactionHistory(address, 'mainnet');
            }; 
            break;

            case 'BTC': {
                return BitcoinWalletService.getTransactionHistory(address, 'mainnet');
            };
            break;
            
            case 'SOL': {
                return SolanaWalletService.getTransactionHistory(address, 'mainnet');
            };
            break;
        };
    };
}

module.exports = new BalanceWatcher();
