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

  /**
   * Close a wallet: it stops being the merchant's, and whatever is at the
   * address - the platform's held fee, and the remainder under the
   * withdrawal minimum - is the platform's, booked as held so the fee sweep
   * collects it. The record and its key stay: the funds are reachable.
   */
  closeWallet(walletId, { by = 'merchant' } = {}) {
    return db.transaction('wallets', walletId, (wallet) => {
      const coin = Number(wallet.balance) || 0;
      const tokens = {};
      for (const [symbol, amount] of Object.entries(wallet.tokenBalances || {})) {
        if (Number(amount) > 0) tokens[symbol] = Number(amount);
      }
      return {
        isActive: false,
        closedAt: new Date().toISOString(),
        closedBy: by,
        // what was at the address when it closed, for the record
        forfeited: { coin, tokens },
        // and all of it is now the platform's to collect
        serviceSubtractions: coin,
        serviceSubtractionsTokens: tokens,
      };
    });
  }
}

module.exports = new WalletService();
