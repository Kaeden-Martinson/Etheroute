const { Router } = require('express');
const PayoutService = require('../services/PayoutService');
const logger = require('../services/logger');
const { ValidationError } = require('../utils/errors');
const { validateCryptoAddress, validateChain, SUPPORTED_CHAINS } = require('../utils/validators');
const { withdrawalLimiter } = require('../middleware/rateLimit');
const { idempotency } = require('../middleware/idempotency');

const router = Router();

/**
 * Resolve and validate the chain the client is cashing out in, defaulting to
 * ETH so integrations written before multi-chain payouts keep working.
 */
function resolvePayoutChain(raw) {
  if (raw === undefined || raw === null || raw === '') return 'ETH';

  const chain = String(raw).toUpperCase();
  if (!validateChain(chain)) {
    throw new ValidationError(`payoutChain must be one of: ${SUPPORTED_CHAINS.join(', ')}`);
  }
  return chain;
}

/**
 * The recipient address must be valid for the chain being paid out, not for ETH.
 */
function validateRecipient(recipientAddress, payoutChain) {
  if (!recipientAddress) {
    throw new ValidationError('recipientAddress is required');
  }
  if (!validateCryptoAddress(recipientAddress, payoutChain)) {
    throw new ValidationError(`recipientAddress must be a valid ${payoutChain} address`);
  }
}

function validateSelection(selectedWallets) {
  if (selectedWallets === undefined || selectedWallets === null) return undefined;
  if (!Array.isArray(selectedWallets)) {
    throw new ValidationError('selectedWallets must be an array of wallet addresses');
  }
  if (selectedWallets.some((address) => typeof address !== 'string')) {
    throw new ValidationError('selectedWallets must contain only wallet addresses');
  }
  return selectedWallets;
}

/**
 * Preview a withdrawal without creating it.
 * POST /api/withdrawal/preview
 */
router.post('/preview', withdrawalLimiter, async (req, res, next) => {
  try {
    const { recipientAddress } = req.body;
    const payoutChain = resolvePayoutChain(req.body.payoutChain);
    validateRecipient(recipientAddress, payoutChain);
    const selectedWallets = validateSelection(req.body.selectedWallets);

    logger.action(`[WithdrawalRoute] Preview for client: ${req.auth.clientId} in ${payoutChain}`);

    const preview = await PayoutService.getWithdrawalPreview(
      req.auth.clientId,
      recipientAddress,
      selectedWallets,
      payoutChain
    );

    res.json({ success: true, data: preview });
  } catch (error) {
    next(error);
  }
});

/**
 * Create a withdrawal.
 * POST /api/withdrawal
 *
 * Requires an Idempotency-Key header - a retry after a timeout must not
 * broadcast a second set of transfers.
 */
router.post('/', withdrawalLimiter, idempotency({ required: true }), async (req, res, next) => {
  try {
    const { recipientAddress } = req.body;
    const payoutChain = resolvePayoutChain(req.body.payoutChain);
    validateRecipient(recipientAddress, payoutChain);
    const selectedWallets = validateSelection(req.body.selectedWallets);

    logger.action(
      `[WithdrawalRoute] Creating ${payoutChain} withdrawal for client: ${req.auth.clientId} to ${recipientAddress}`
    );

    let walletAddresses = selectedWallets;
    if (!walletAddresses || walletAddresses.length === 0) {
      walletAddresses = PayoutService.getClientActiveWalletAddresses(req.auth.clientId);
    }

    if (walletAddresses.length === 0) {
      throw new ValidationError('Client has no active wallets to withdraw from');
    }

    const payout = await PayoutService.processWithdrawal(
      req.auth.clientId,
      recipientAddress,
      walletAddresses,
      payoutChain
    );

    res.status(201).json({
      id: payout.id,
      clientId: payout.clientId,
      recipientAddress,
      payoutChain: payout.payoutChain,
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
