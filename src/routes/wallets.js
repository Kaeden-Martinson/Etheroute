const { Router } = require('express');
const WalletService = require('../services/WalletService');
const BalanceWatcher = require('../services/BalanceWatcher');
const { db } = require('../config/database');
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
      wallets.map((wallet) => {
        const subs = wallet.serviceSubtractions || 0;
        const rawBalance = wallet.balance || 0;
        const adjustedBalance = Math.max(0, rawBalance - subs);
        const adjustedBalanceUSD = rawBalance > 0
          ? (wallet.balanceUSD || 0) * (adjustedBalance / rawBalance)
          : 0;

        // Check for any PENDING or PROCESSING transactions for this wallet
        const walletTxs = db.findBy('transactions', { fromAddress: wallet.address });
        const isProcessing = walletTxs.some(t => t.status === 'PENDING' || t.status === 'PROCESSING');

        return {
          id: wallet.id,
          address: wallet.address,
          chain: wallet.chain,
          balance: adjustedBalance,
          balanceUSD: adjustedBalanceUSD,
          createdAt: wallet.createdAt,
          isProcessing,
          ...(isProcessing && { ineligibilityReason: 'Transaction currently processing' }),
        };
      })
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
