const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const SolanaWalletService = require('./wallets/SolanaWalletService');
const BitcoinWalletService = require('./wallets/BitcoinWalletService');
const EthereumWalletService = require('./wallets/EthereumWalletService');
const LitecoinWalletService = require('./wallets/LitecoinWalletService');
const { db } = require('../config/database');

class WalletService {
  generateWallet(clientId, chain) {
    // Check users table (clientId is the user ID)
    const user = db.getById('users', clientId);
    if (!user) {
      throw new Error(`User with ID ${clientId} not found`);
    }

    // Delegate to specialized services
    if (chain === 'ETH') {
      return EthereumWalletService.createWallet(clientId, null, 'mainnet');
    }

    if (chain === 'SOL') {
      return SolanaWalletService.createWallet(clientId, null, 'mainnet');
    }

    if (chain === 'BTC') {
      return BitcoinWalletService.createWallet(clientId, null, 'mainnet');
    }

    if (chain === 'LTC') {
      return LitecoinWalletService.createWallet(clientId, null, 'mainnet');
    }
  }

  getWalletsByClient(clientId) {
    return db.findBy('wallets', { clientId, isActive: true });
  }

  getWalletByAddress(address) {
    return db.findOneBy('wallets', { address, isActive: true });
  }

  deactivateWallet(walletId) {
    db.update('wallets', walletId, { isActive: false });
  }
}

module.exports = new WalletService();
