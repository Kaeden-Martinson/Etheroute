const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { walletServiceFor } = require('./wallets');
const { db } = require('../config/database');

class WalletService {
  generateWallet(clientId, chain) {
    // Check users table (clientId is the user ID)
    const user = db.getById('users', clientId);
    if (!user) {
      throw new Error(`User with ID ${clientId} not found`);
    }

    // The registry decides which family signs for this chain.
    return walletServiceFor(chain).createWallet(clientId, null);
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
