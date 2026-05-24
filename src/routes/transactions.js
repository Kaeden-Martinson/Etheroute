const { Router } = require('express');
const TransactionService = require('../services/TransactionService');
const PayoutService = require('../services/PayoutService');
const { db } = require('../config/database');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Get all transactions for a client
 * GET /api/transactions/list
 */
router.get('/list', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key or clientId is required');
    }

    const transactions = TransactionService.getClientTransactions(clientId);

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
        failureReason: transaction.failureReason
      }))
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Get a specific transaction by ID
 * POST /api/transactions/getTransaction
 */
router.get('/getTransaction', (req, res, next) => {
  try {
    const { transactionId } = req.body;
    const transaction = TransactionService.getTransaction(transactionId);

    if (!transaction) {
      throw new ApiError(404, 'Transaction not found');
    }

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
      failureMessage: transaction.failureMessage
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
