/**
 * Realtime Service - Handles WebSocket connections and broadcasts transaction/payout updates
 * Note: clientId refers to user ID in the users table
 */

class RealtimeService {
  constructor() {
    this.clients = new Map(); // userId -> Set of WebSocket connections
    console.log('[RealtimeService] Initialized');
  }

  /**
   * Register a WebSocket connection for a user
   * @param {string} clientId - User ID
   * @param {WebSocket} ws - WebSocket connection
   */
  registerClient(clientId, ws) {
    if (!this.clients.has(clientId)) {
      this.clients.set(clientId, new Set());
    }
    this.clients.get(clientId).add(ws);
    console.log(`[RealtimeService] Client ${clientId} connected (${this.clients.get(clientId).size} connections)`);
  }

  /**
   * Unregister a WebSocket connection
   * @param {string} clientId - Client ID
   * @param {WebSocket} ws - WebSocket connection
   */
  unregisterClient(clientId, ws) {
    if (this.clients.has(clientId)) {
      this.clients.get(clientId).delete(ws);
      if (this.clients.get(clientId).size === 0) {
        this.clients.delete(clientId);
      }
      console.log(`[RealtimeService] Client ${clientId} disconnected`);
    }
  }

  /**
   * Broadcast transaction status update to a client
   * @param {string} clientId - Client ID
   * @param {Object} transaction - Transaction object with updated status
   */
  broadcastTransactionUpdate(clientId, transaction) {
    this._broadcast(clientId, {
      type: 'transaction_update',
      data: {
        transactionId: transaction.id,
        orderId: transaction.orderId,
        chain: transaction.chain,
        status: transaction.status,
        nativeAmount: transaction.nativeAmount,
        usdAmount: transaction.usdAmount,
        failureReason: transaction.failureReason,
        failureMessage: transaction.failureMessage,
        broadcastedAt: transaction.broadcastedAt,
        completedAt: transaction.completedAt,
      }
    });
  }

  /**
   * Broadcast payout status update to a client
   * @param {string} clientId - Client ID
   * @param {Object} payout - Payout object with updated status
   */
  broadcastPayoutUpdate(clientId, payout) {
    this._broadcast(clientId, {
      type: 'payout_update',
      data: {
        payoutId: payout.id,
        status: payout.status,
        netAmountUsd: payout.netAmountUsd,
        totalAmountUsd: payout.totalAmountUsd,
        platformFee: payout.platformFee,
        chain: payout.chain,
        updatedAt: payout.updatedAt,
        completedAt: payout.completedAt,
        transferCount: payout.withdrawalPlan?.transfers?.length || 0,
        type: payout.type,
      }
    });
  }

  /**
   * Broadcast a list of transactions to a client
   * @param {string} clientId - Client ID
   * @param {Array} transactions - Array of transaction objects
   */
  broadcastTransactionsList(clientId, transactions) {
    this._broadcast(clientId, {
      type: 'transactions_list',
      data: {
        transactions: transactions.map(t => ({
          transactionId: t.id,
          orderId: t.orderId,
          chain: t.chain,
          status: t.status,
          nativeAmount: t.nativeAmount,
          usdAmount: t.usdAmount,
          failureReason: t.failureReason,
          type: t.type,
          broadcastedAt: t.broadcastedAt,
          completedAt: t.completedAt,
        }))
      }
    });
  }

  /**
   * Broadcast a list of payouts to a client
   * @param {string} clientId - Client ID
   * @param {Array} payouts - Array of payout objects
   */
  broadcastPayoutsList(clientId, payouts) {
    this._broadcast(clientId, {
      type: 'payouts_list',
      data: {
        payouts: payouts.map(p => ({
          payoutId: p.id,
          status: p.status,
          netAmountUsd: p.netAmountUsd,
          totalAmountUsd: p.totalAmountUsd,
          platformFee: p.platformFee,
          chain: p.chain,
          updatedAt: p.updatedAt,
          completedAt: p.completedAt,
          transferCount: p.withdrawalPlan?.transfers?.length || 0,
          type: p.type,
          createdAt: p.createdAt,
        }))
      }
    });
  }

  /**
   * Internal broadcast method
   * @private
   */
  _broadcast(clientId, message) {
    if (!this.clients.has(clientId)) {
      return;
    }

    const connections = this.clients.get(clientId);
    const messageStr = JSON.stringify(message);
    let successCount = 0;
    let failureCount = 0;

    connections.forEach(ws => {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(messageStr);
          successCount++;
        } else {
          failureCount++;
          connections.delete(ws);
        }
      } catch (error) {
        failureCount++;
        connections.delete(ws);
      }
    });

    if (failureCount > 0) {
      console.log(`[RealtimeService] Sent to ${successCount} connections (${failureCount} failed)`);
    }
  }

  /**
   * Get count of active connections for a client
   * @param {string} clientId - Client ID
   * @returns {number} Number of active connections
   */
  getConnectionCount(clientId) {
    return this.clients.has(clientId) ? this.clients.get(clientId).size : 0;
  }
}

module.exports = new RealtimeService();
