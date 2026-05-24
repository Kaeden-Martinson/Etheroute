const { Router } = require('express');
const PayoutService = require('../services/PayoutService');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Get all payouts for a user
 * GET /api/payouts/list
 */
router.get('/list', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key is required');
    }

    const payouts = PayoutService.getClientPayouts(clientId);

    res.json({
      success: true,
      count: payouts.length,
      payouts: payouts.map((payout) => ({
        id: payout.id,
        clientId: payout.clientId,
        status: payout.status,
        totalAmountUsd: payout.totalAmountUsd,
        platformFee: payout.platformFee,
        netAmountUsd: payout.netAmountUsd,
        chain: payout.chain,
        recipientAddress: payout.recipientAddress,
        type: payout.type,
        createdAt: payout.createdAt,
        updatedAt: payout.updatedAt,
        completedAt: payout.completedAt,
        withdrawalPlan: payout.withdrawalPlan,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get a specific payout by ID
 * POST /api/payouts/getPayout
 */
router.get('/getPayout', (req, res, next) => {
  try {
    const { payoutId } = req.body;

    const payout = PayoutService.getPayout(payoutId);

    if (!payout) {
      throw new ApiError(404, 'Payout not found');
    }

    res.json({
      success: true,
      payout: {
        id: payout.id,
        clientId: payout.clientId,
        status: payout.status,
        totalAmountUsd: payout.totalAmountUsd,
        platformFee: payout.platformFee,
        netAmountUsd: payout.netAmountUsd,
        chain: payout.chain,
        recipientAddress: payout.recipientAddress,
        type: payout.type,
        createdAt: payout.createdAt,
        updatedAt: payout.updatedAt,
        completedAt: payout.completedAt,
        withdrawalPlan: payout.withdrawalPlan,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
