const { Router } = require('express');
const TransactionService = require('../services/TransactionService');
const { db } = require('../config/database');
const BalanceWatcher = require('../services/BalanceWatcher');
const { ValidationError } = require('../utils/errors');
const { assertOwnership } = require('../middleware/auth');

const router = Router();

/**
 * List the caller's transactions.
 * GET /api/transactions/list
 */
router.get('/list', (req, res, next) => {
  try {
    const transactions = TransactionService.getClientTransactions(req.auth.clientId);

    res.json(
      transactions.map((transaction) => ({
        id: transaction.id,
        transactionHash: transaction.transactionHash,
        type: transaction.type,
        chain: transaction.chain,
        nativeAmount: transaction.nativeAmount,
        usdAmount: transaction.usdAmount,
        status: transaction.status,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt,
        failedAt: transaction.failedAt,
        failureReason: transaction.failureReason,
      }))
    );
  } catch (error) {
    next(error);
  }
});

/**
 * On-chain history for one of the caller's wallets.
 * POST /api/transactions/wallet
 */
router.post('/wallet', async (req, res, next) => {
  try {
    const { walletId } = req.body;
    if (!walletId) throw new ValidationError('walletId is required');

    const wallet = assertOwnership(db.getById('wallets', walletId), req, 'Wallet');
    const history = await BalanceWatcher.getTransactionHistory(wallet);

    res.json(history || { status: 'unavailable', transactions: [] });
  } catch (error) {
    next(error);
  }
});

/**
 * Fetch one transaction the caller owns.
 * GET /api/transactions/:transactionId
 */
router.get('/:transactionId', (req, res, next) => {
  try {
    const { transactionId } = req.params;
    if (!transactionId) throw new ValidationError('transactionId is required');

    const transaction = assertOwnership(
      TransactionService.getTransaction(transactionId),
      req,
      'Transaction'
    );

    res.json({
      id: transaction.id,
      clientId: transaction.clientId,
      transactionHash: transaction.transactionHash,
      orderId: transaction.orderId,
      type: transaction.type,
      chain: transaction.chain,
      nativeAmount: transaction.nativeAmount,
      usdAmount: transaction.usdAmount,
      status: transaction.status,
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      finalAddress: transaction.finalAddress,
      blockNumber: transaction.blockNumber,
      createdAt: transaction.createdAt,
      broadcastedAt: transaction.broadcastedAt,
      completedAt: transaction.completedAt,
      failedAt: transaction.failedAt,
      failureReason: transaction.failureReason,
      failureMessage: transaction.failureMessage,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
