const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');

class TransactionService {
  createTransaction(clientId, transactionHash, orderId, type, chain, nativeAmount, usdAmount, fromAddress, toAddress, finalAddress) {
    const transaction = {
      id: uuidv4(),
      clientId,
      transactionHash,
      orderId,
      type,
      chain,
      nativeAmount, 
      usdAmount,
      status: 'PENDING',
      fromAddress: fromAddress || null,
      toAddress: toAddress || null,
      finalAddress: finalAddress || null,
      blockNumber: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    // Validate wallet exists
    const wallet = db.findOneBy('wallets', { address: fromAddress });
    if (!wallet) {
      throw new Error(`Source wallet not found: ${fromAddress}`);
    }

    return db.create('transactions', transaction);
  }

  /**
   * Update transaction to PROCESSING status (broadcast but not confirmed)
   * @param {string} transactionId - Transaction ID
   * @param {string} txHash - Transaction hash from blockchain
   * @returns {Object} Updated transaction
   */
  markTransactionProcessing(transactionId, txHash) {
    const updates = {
      status: 'PROCESSING',
      transactionHash: txHash || undefined,
      broadcastedAt: new Date().toISOString()
    };

    const transaction = db.update('transactions', transactionId, updates);
    if (!transaction) {
      throw new Error(`Transaction with ID ${transactionId} not found`);
    }
    
    return transaction;
  }

  /**
   * Mark transaction as FAILED with error details
   * @param {string} transactionId - Transaction ID
   * @param {string} failureReason - Reason for failure (e.g., 'REVERTED', 'TIMEOUT', 'INSUFFICIENT_GAS')
   * @param {string} errorMessage - Detailed error message
   * @returns {Object} Updated transaction
   */
  markTransactionFailed(transactionId, failureReason, errorMessage) {
    const updates = {
      status: 'FAILED',
      failureReason,
      failureMessage: errorMessage,
      failedAt: new Date().toISOString()
    };

    const transaction = db.update('transactions', transactionId, updates);
    if (!transaction) {
      throw new Error(`Transaction with ID ${transactionId} not found`);
    }
    
    return transaction;
  }

  getTransaction(transactionId) {
    return db.getById('transactions', transactionId);
  }

  getTransactionByHash(hash) {
    return db.findOneBy('transactions', { transactionHash: hash });
  }

  getClientTransactions(clientId) {
    return db.findBy('transactions', { clientId });
  }

  /**
   * Update transaction status
   * @param {string} transactionId - Transaction ID
   * @param {string} status - Status: PENDING, PROCESSING, CONFIRMED, FAILED
   * @param {number} blockNumber - Block number (for confirmed transactions)
   * @returns {Object} Updated transaction
   */
  updateTransactionStatus(transactionId, status, blockNumber) {
    const validStatuses = ['PENDING', 'PROCESSING', 'CONFIRMED', 'FAILED'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    const updates = { status };
    
    if (status === 'PROCESSING') {
      updates.broadcastedAt = new Date().toISOString();
    } else if (status === 'CONFIRMED') {
      updates.completedAt = new Date().toISOString();
      if (blockNumber) {
        updates.blockNumber = blockNumber;
      }
    } else if (status === 'FAILED') {
      updates.failedAt = new Date().toISOString();
    }

    const transaction = db.update('transactions', transactionId, updates);
    if (!transaction) {
      throw new Error(`Transaction with ID ${transactionId} not found`);
    }
    
    return transaction;
  }
}

module.exports = new TransactionService();
