const { Router } = require('express');
const PayoutService = require('../services/PayoutService');
const logger = require('../services/logger');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * POST /api/withdrawal/preview
 * Preview withdrawal without creating it - returns accurate data for UI
 */
router.post('/preview', async (req, res, next) => {
  try {
    const { clientId, recipientAddress, selectedWallets } = req.body;

    if (!clientId || !recipientAddress) {
      throw new ApiError(400, 'API Key is required along with recipientAddress');
    }

    logger.action(`[WithdrawalRoute] Getting preview for client: ${clientId}`);

    const preview = await PayoutService.getWithdrawalPreview(clientId, recipientAddress, selectedWallets);

    res.json({
      success: true,
      data: preview
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/withdrawal
 * Create a standard withdrawal for a single wallet
 */
router.post('/', async (req, res, next) => {
  try {
    const { recipientAddress, selectedWallets, clientId } = req.body;

    // Validate Client ID and recipient address
    if (!clientId || !recipientAddress) {
      throw new ApiError(400, 'API Key is required along with recipientAddress');
    }

    logger.action(`[WithdrawalRoute] Creating withdrawal for client: ${clientId} to recipient: ${recipientAddress}`);

    // Use selected wallet addresses from request, or fall back to all active wallet addresses
    let walletAddresses = selectedWallets;
    if (!walletAddresses || !Array.isArray(walletAddresses) || walletAddresses.length === 0) {
      walletAddresses = PayoutService.getClientActiveWalletAddresses(clientId);
    }

    if (walletAddresses.length === 0) {
      throw new ApiError(400, 'Client has no active wallets to withdraw from');
    }

    const payout = await PayoutService.processWithdrawal(clientId, recipientAddress, walletAddresses);

    res.status(201).json({
      id: payout.id,
      clientId: payout.clientId,
      recipientAddress,
      netAmountUsd: payout.netAmountUsd,
      totalAmountUsd: payout.totalAmountUsd,
      chain: payout.chain,
      platformFee: payout.platformFee,
      estimatedTotalGas: payout.estimatedTotalGas,
      status: payout.status,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

