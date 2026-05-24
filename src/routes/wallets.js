const { Router } = require('express');
const WalletService = require('../services/WalletService');
const BalanceWatcher = require('../services/BalanceWatcher');
const { validateChain } = require('../utils/validators');
const { ApiError, ValidationError } = require('../utils/errors');

const router = Router();

/**
 * Get wallets for a client
 * GET /api/wallets/list
 */
router.get('/list', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ValidationError('clientId is required');
    }

    const wallets = WalletService.getWalletsByClient(clientId);

    wallets.forEach((wallet) => BalanceWatcher.updateWalletBalance(wallet));

    res.json(
      wallets.map((wallet) => ({
        id: wallet.id,
        address: wallet.address,
        chain: wallet.chain,
        balance: wallet.balance,
        balanceUSD: wallet.balanceUSD,
        createdAt: wallet.createdAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Generate a new wallet
 * POST /api/wallets/generate
 */
router.post('/generate', (req, res, next) => {
  try {
    const { chain, clientId } = req.body;

    if (!clientId) {
      throw new ValidationError('clientId is required');
    }
    if (!chain || !validateChain(chain)) {
      throw new ValidationError('Valid chain (ETH, BTC, LTC, SOL) is required');
    }

    const wallet = WalletService.generateWallet(clientId, chain);

    res.status(201).json({
      id: wallet.id,
      address: wallet.address,
      chain: wallet.chain,
      clientId: wallet.clientId,
      balance: wallet.balance,
      createdAt: wallet.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get transaction history for a wallet
 * GET /api/wallets/transactions
 */
router.get('/transactions', async (req, res, next) => {
  try {
    const { walletId } = req.body;
    const { db } = require('../config/database');
    
    const wallet = db.getById('wallets', walletId);
    if (!wallet) {
      throw new ApiError(404, 'Wallet not found');
    }

    const txHistory = await BalanceWatcher.getTransactionHistory(wallet.address);
    
    res.json(txHistory);
  } catch (error) {
    next(error);
  }
});

/**
 * Delete a wallet
 * DELETE /api/wallets/delete
 */
router.delete('/delete', (req, res, next) => {
  try {
    const { walletId } = req.body;
    const { db } = require('../config/database');
    
    const wallet = db.getById('wallets', walletId);
    if (!wallet) {
      throw new ApiError(404, 'Wallet not found');
    }

    // Delete the wallet from the database
    db.delete('wallets', walletId);

    res.json({ message: 'Wallet deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
