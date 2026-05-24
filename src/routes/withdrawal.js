const { Router } = require('express');
const PayoutService = require('../services/PayoutService');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * GET /api/withdrawal/preview
 * Preview withdrawal without creating it - returns accurate data for UI
 */
router.get('/preview', async (req, res, next) => {
  try {
    const { clientId, recipientAddress, selectedChains } = req.body;

    if (!clientId || !recipientAddress || !selectedChains) {
      throw new ApiError(400, 'API Key is required along with recipientAddress and selectedChains');
    }

    console.log(`\n[WithdrawalRoute] Getting preview for client: ${clientId}`);

    const selectedChainsArray = selectedChains ? selectedChains.split(',').map(c => c.trim()) : null;
    const preview = await PayoutService.getWithdrawalPreview(clientId, recipientAddress, selectedChainsArray);

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
    const { recipientAddress, selectedChains, clientId } = req.body;

    // Validate Client ID and recipient address
    if (!clientId || !selectedChains || !recipientAddress) {
      throw new ApiError(400, 'API Key is required along with recipientAddress and selectedChains');
    }

    console.log(`\n[WithdrawalRoute] Creating withdrawal for client: ${clientId} to recipient: ${recipientAddress}`);

    // Use selected chains from request, or fall back to client's active chains
    let chains = selectedChains;
    if (!chains || !Array.isArray(chains) || chains.length === 0) {
      chains = PayoutService.getClientActiveChains(clientId);
    }

    if (chains.length === 0) {
      throw new ApiError(400, 'Client has no active wallets to withdraw from');
    }

    const payout = await PayoutService.processWithdrawal(clientId, recipientAddress, chains);

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

