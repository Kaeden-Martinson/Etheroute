const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');

class TransactionService {
  createTransaction(clientId, transactionHash, orderId, type, chain, nativeAmount, usdAmount, fromAddress, toAddress, finalAddress, extra = {}) {
    const transaction = {
      id: uuidv4(),
      clientId,
      transactionHash,
      orderId,
      type,
      chain,
      // What left, in `asset`: the chain's coin unless a token is named.
      asset: extra.asset || null,
      route: extra.route || null,
      // Set when a token was swapped for the coin on its chain before the
      // send: the swap's own hash.
      preSwapTxHash: extra.preSwapTxHash || null,
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
   * A payment that landed in one of the client's wallets - a checkout that
   * settled. Recorded confirmed, since settlement only calls this once the
   * chain has confirmed it; `asset` names what arrived (the chain's coin, or
   * a dollar token by symbol). One record per settled session.
   */
  recordDeposit({ clientId, chain, asset, nativeAmount, usdAmount, transactionHash, fromAddress, toAddress, sessionId }) {
    const existing = sessionId ? db.findOneBy('transactions', { sessionId }) : null;
    if (existing) return existing;
    const now = new Date().toISOString();

    // The platform's share is a share of what the merchant was paid, so it
    // is taken here, once, on the way in - not again at withdrawal. It is
    // set aside in the wallet it arrived in, in the asset it arrived as,
    // and the sweep collects it from there.
    const wallet = toAddress
      ? db.getAll('wallets').find((w) => w.chain === chain && String(w.address).toLowerCase() === String(toAddress).toLowerCase())
      : null;
    const accrued = wallet
      ? require('./FeeCollectionService').accrueOnPayment(wallet, asset || chain, nativeAmount)
      : null;

    return db.create('transactions', {
      id: uuidv4(),
      clientId,
      transactionHash: transactionHash || null,
      orderId: null,
      sessionId: sessionId || null,
      type: 'DEPOSIT',
      chain,
      asset: asset || null,
      nativeAmount,
      usdAmount: Number.isFinite(usdAmount) ? usdAmount : null,
      status: 'CONFIRMED',
      fromAddress: fromAddress || null,
      toAddress: toAddress || null,
      finalAddress: null,
      blockNumber: null,
      // what the platform took of this payment, in the asset it arrived as
      platformFeeNative: accrued ? accrued.fee : 0,
      platformFeeRate: accrued ? accrued.rate : 0,
      createdAt: now,
      completedAt: now,
    });
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
  /**
   * Record bookkeeping on a transaction without changing its status - the
   * last status the chain or Sideshift reported, and when it was checked.
   */
  touch(transactionId, fields) {
    const transaction = db.update('transactions', transactionId, { ...fields });
    if (!transaction) {
      throw new Error(`Transaction with ID ${transactionId} not found`);
    }
    return transaction;
  }

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
