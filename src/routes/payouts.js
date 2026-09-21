const { Router } = require('express');
const PayoutService = require('../services/PayoutService');
const { ValidationError } = require('../utils/errors');
const { assertOwnership } = require('../middleware/auth');

const router = Router();

/**
 * Shape a payout for the API, computing per-chain gas from the stored plan.
 */
function presentPayout(payout) {
  const gasPerChain = {};
  for (const transfer of (payout.withdrawalPlan && payout.withdrawalPlan.transfers) || []) {
    gasPerChain[transfer.chain] = (gasPerChain[transfer.chain] || 0) + (transfer.estimatedGas || 0);
  }

  return {
    id: payout.id,
    clientId: payout.clientId,
    status: payout.status,
    totalAmountUsd: payout.totalAmountUsd,
    platformFee: payout.platformFee,
    estimatedTotalGas: payout.estimatedTotalGas || 0,
    gasPerChain,
    netAmountUsd: payout.netAmountUsd,
    chain: payout.chain,
    payoutChain: payout.payoutChain || payout.chain,
    // The asset it settled in on that chain: the coin, or a dollar token.
    payoutAsset: payout.payoutAsset || null,
    recipientAddress: payout.recipientAddress,
    type: payout.type,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
    completedAt: payout.completedAt,
    withdrawalPlan: payout.withdrawalPlan,
  };
}

/**
 * List the caller's payouts.
 * GET /api/payouts/list
 */
router.get('/list', (req, res, next) => {
  try {
    const payouts = PayoutService.getClientPayouts(req.auth.clientId);

    res.json({
      success: true,
      count: payouts.length,
      payouts: payouts.map(presentPayout),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Fetch one payout the caller owns.
 * GET /api/payouts/:payoutId
 */
router.get('/:payoutId', (req, res, next) => {
  try {
    const { payoutId } = req.params;
    if (!payoutId) throw new ValidationError('payoutId is required');

    const payout = assertOwnership(PayoutService.getPayout(payoutId), req, 'Payout');

    res.json({ success: true, payout: presentPayout(payout) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
