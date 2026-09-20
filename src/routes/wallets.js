const { Router } = require('express');
const QRCode = require('qrcode');
const WalletService = require('../services/WalletService');
const BalanceWatcher = require('../services/BalanceWatcher');
const { db } = require('../config/database');
const { validateChain } = require('../utils/validators');
const { ApiError, ValidationError } = require('../utils/errors');
const { assertOwnership } = require('../middleware/auth');

const router = Router();

// A wallet's balance is re-read from the chain at most this often on demand.
const BALANCE_REFRESH_MIN_MS = 30 * 1000;

const LABEL_MAX = 40;

/**
 * A wallet's display name, or null to clear it. Whitespace-trimmed, bounded,
 * and plain text - it is rendered on the dashboard and in pickers.
 */
function normaliseLabel(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('label must be a string');
  const label = raw.replace(/\s+/g, ' ').trim();
  if (label.length === 0) return null;
  if (label.length > LABEL_MAX) throw new ValidationError(`label must be ${LABEL_MAX} characters or fewer`);
  return label;
}

/**
 * Shape a wallet for the API. Secrets are dropped here rather than relied on
 * being absent - this is the only place wallets are serialised for clients.
 */
function presentWallet(wallet) {
  const rawBalance = wallet.balance || 0;
  const rawBalanceUSD = wallet.balanceUSD || 0;

  // Platform fees charged on past withdrawals that are still sitting at this
  // address awaiting collection. Reported separately rather than silently
  // deducted: the wallet really does hold this, and showing a client a balance
  // of zero for an address that demonstrably holds funds is both confusing and
  // impossible to reconcile against the chain.
  const feeHeld = Math.min(wallet.serviceSubtractions || 0, rawBalance);
  const available = Math.max(0, rawBalance - feeHeld);
  const perUnit = rawBalance > 0 ? rawBalanceUSD / rawBalance : 0;

  const walletTxs = db.findBy('transactions', { fromAddress: wallet.address });
  const isProcessing = walletTxs.some((t) => t.status === 'PENDING' || t.status === 'PROCESSING');

  return {
    id: wallet.id,
    address: wallet.address,
    chain: wallet.chain,
    // Merchant-chosen name, for telling one ETH wallet from another.
    label: wallet.label || null,

    // Yours to withdraw.
    balance: available,
    balanceUSD: available * perUnit,

    // What the address actually holds - verifiable on-chain.
    onChainBalance: rawBalance,
    onChainBalanceUSD: rawBalanceUSD,

    // Owed to the platform from earlier withdrawals, if any.
    platformFeeHeld: feeHeld,
    platformFeeHeldUSD: feeHeld * perUnit,

    createdAt: wallet.createdAt,
    isProcessing,
    ...(isProcessing && { ineligibilityReason: 'Transaction currently processing' }),
  };
}

/**
 * List the caller's wallets.
 * GET /api/wallets/list
 *
 * Balances are served from the database. A background refresh is kicked off but
 * not awaited, so one slow RPC endpoint cannot stall the dashboard.
 */
router.get('/list', (req, res, next) => {
  try {
    const wallets = WalletService.getWalletsByClient(req.auth.clientId);

    for (const wallet of wallets) {
      // Every refresh is a call to a public explorer or RPC that rate-limits
      // by IP. A client (or a partner integration) polling this endpoint
      // every few seconds used to fan out into one upstream call per wallet
      // per poll, and everyone's balances went stale together once the
      // provider started answering 429.
      const age = Date.now() - new Date(wallet.lastUpdated || 0).getTime();
      if (age < BALANCE_REFRESH_MIN_MS) continue;

      BalanceWatcher.updateWalletBalance(wallet).catch((error) => {
        console.warn(`[wallets] Background balance refresh failed for ${wallet.id}: ${error.message}`);
      });
    }

    res.json(wallets.map(presentWallet));
  } catch (error) {
    next(error);
  }
});

/**
 * Generate a new wallet for the caller.
 * POST /api/wallets/generate
 */
router.post('/generate', (req, res, next) => {
  try {
    const { chain } = req.body;

    if (!chain || !validateChain(chain)) {
      throw new ValidationError(`Valid chain is required (one of ${require('../config/chains').CODES.join(', ')})`);
    }
    const label = normaliseLabel(req.body.label);

    const wallet = WalletService.generateWallet(req.auth.clientId, chain);
    if (!wallet) {
      throw new ApiError(500, 'Wallet generation failed');
    }
    if (label) db.update('wallets', wallet.id, { label });

    res.status(201).json({
      id: wallet.id,
      address: wallet.address,
      chain: wallet.chain,
      label,
      clientId: wallet.clientId,
      balance: wallet.balance,
      createdAt: wallet.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The wallet's address as a QR, for anyone who wants to pay it directly.
 * Drawn the way the payment link's QR is; the address is public by nature.
 * GET /api/wallets/:walletId/qr
 */
router.get('/:walletId/qr', async (req, res, next) => {
  try {
    const wallet = assertOwnership(db.getById('wallets', req.params.walletId), req, 'Wallet');
    const svg = await QRCode.toString(wallet.address, {
      type: 'svg',
      margin: 1,
      width: 180,
      errorCorrectionLevel: 'M',
    });
    res.json({ success: true, address: wallet.address, chain: wallet.chain, svg });
  } catch (error) {
    next(error);
  }
});

/**
 * Rename a wallet. Send an empty label to clear it.
 * PATCH /api/wallets/:walletId
 */
router.patch('/:walletId', (req, res, next) => {
  try {
    const wallet = assertOwnership(db.getById('wallets', req.params.walletId), req, 'Wallet');
    if (!('label' in req.body)) throw new ValidationError('label is required');

    const label = normaliseLabel(req.body.label);
    const updated = db.update('wallets', wallet.id, { label });

    res.json(presentWallet(updated));
  } catch (error) {
    next(error);
  }
});

/**
 * Deactivate a wallet.
 * DELETE /api/wallets/delete
 *
 * Soft delete: the record holds the only copy of the signing key, so destroying
 * it would strand any funds still at that address. A wallet with a balance or an
 * in-flight transaction cannot be removed at all.
 */
router.delete('/delete', (req, res, next) => {
  try {
    const { walletId } = req.body;
    if (!walletId) throw new ValidationError('walletId is required');

    const wallet = assertOwnership(db.getById('wallets', walletId), req, 'Wallet');

    if ((wallet.balance || 0) > 0) {
      throw new ApiError(409, 'Cannot remove a wallet that still holds a balance. Withdraw the funds first.');
    }

    const walletTxs = db.findBy('transactions', { fromAddress: wallet.address });
    if (walletTxs.some((t) => t.status === 'PENDING' || t.status === 'PROCESSING')) {
      throw new ApiError(409, 'Cannot remove a wallet with a transaction in progress.');
    }

    WalletService.deactivateWallet(walletId);

    res.json({ message: 'Wallet removed successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
