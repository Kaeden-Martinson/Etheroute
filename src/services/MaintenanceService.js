/**
 * Periodic maintenance.
 *
 * The payout pipeline monitors transfers in memory, so a restart mid-payout
 * used to leave transactions in PROCESSING forever - and because withdrawal
 * eligibility skips wallets with an in-flight transaction, that permanently
 * locked the wallet out of future withdrawals. The reaper below is what breaks
 * that trap until payout execution moves onto a durable queue.
 */
const { db } = require('../config/database');
const { config } = require('../config/env');
const logger = require('./logger');
const TransactionService = require('./TransactionService');
const WebhookService = require('./WebhookService');
const { pruneIdempotencyKeys } = require('../middleware/idempotency');

const IN_FLIGHT = ['PENDING', 'PROCESSING'];

/**
 * Fail out transactions that have been in flight past the configured deadline.
 */
function reapStuckTransactions() {
  const cutoff = Date.now() - config.payouts.stuckTransactionMinutes * 60 * 1000;
  let reaped = 0;

  for (const transaction of db.getAll('transactions')) {
    if (!IN_FLIGHT.includes(transaction.status)) continue;

    const startedAt = new Date(transaction.broadcastedAt || transaction.createdAt).getTime();
    if (Number.isNaN(startedAt) || startedAt > cutoff) continue;

    // The reconciler saw this transfer on the network recently: the funds are
    // committed and it will settle or be refunded on its own schedule. Failing
    // it now would only free the wallet for a second sweep of coins that are
    // already spoken for.
    const seenAt = new Date(transaction.lastCheckedAt || 0).getTime();
    const pendingOnChain = transaction.lastKnownStatus && transaction.lastKnownStatus !== 'not_found';
    if (pendingOnChain && Date.now() - seenAt < 2 * 60 * 60 * 1000) continue;

    try {
      TransactionService.markTransactionFailed(
        transaction.id,
        'STUCK_TIMEOUT',
        `No confirmation after ${config.payouts.stuckTransactionMinutes} minutes. Released so the wallet is not blocked; verify on-chain before retrying.`
      );
      reaped += 1;
      logger.warn(`[Maintenance] Released stuck transaction ${transaction.id} (${transaction.chain})`);
    } catch (error) {
      logger.error(`[Maintenance] Could not release ${transaction.id}: ${error.message}`);
    }
  }

  return reaped;
}

/**
 * Re-check every in-flight transfer against its chain (or Sideshift order).
 *
 * The payout pipeline only watches a transfer in-process for ten minutes. A
 * Bitcoin confirmation, or a swap out of Bitcoin, routinely takes longer, and
 * a restart loses the watcher entirely. This is what carries those transfers
 * to CONFIRMED or FAILED afterwards.
 */
async function reconcileInFlightTransfers() {
  // Required lazily: PayoutService pulls in every wallet service.
  const PayoutService = require('./PayoutService');
  let resolved = 0;

  for (const transaction of db.getAll('transactions')) {
    if (transaction.status !== 'PROCESSING') continue;

    try {
      const outcome = await PayoutService.reconcileTransaction(transaction);
      if (outcome !== 'pending') {
        resolved += 1;
        logger.info(`[Maintenance] Transfer ${transaction.id} (${transaction.chain}) -> ${outcome}`);
      }
    } catch (error) {
      logger.warn(`[Maintenance] Could not check ${transaction.id}: ${error.message}`);
    }
  }

  return resolved;
}

/**
 * Mark payouts whose transfers have all finished but whose own status was never
 * updated - the symptom of a process that died mid-run, or of transfers that
 * settled after the in-process monitor handed them over.
 */
function reconcilePayouts() {
  let updated = 0;

  for (const payout of db.getAll('payouts')) {
    if (payout.status !== 'PROCESSING') continue;

    const transfers = (payout.withdrawalPlan && payout.withdrawalPlan.transfers) || [];
    if (transfers.length === 0) continue;

    const settled = transfers.every((t) => t.status === 'CONFIRMED' || t.status === 'FAILED');
    if (!settled) continue;

    const confirmed = transfers.filter((t) => t.status === 'CONFIRMED').length;
    const failed = transfers.filter((t) => t.status === 'FAILED').length;

    let status = 'COMPLETED';
    if (failed > 0 && confirmed > 0) status = 'PARTIAL';
    else if (failed > 0) status = 'FAILED';

    db.update('payouts', payout.id, {
      status,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    updated += 1;
    logger.warn(`[Maintenance] Reconciled orphaned payout ${payout.id} -> ${status}`);
  }

  return updated;
}

/**
 * Check the chain for sessions that are waiting on a payment.
 *
 * Settlement used to run only from the buyer's browser poll. Close the tab
 * after paying and the payment was never noticed: no webhook, no PAID status,
 * and the session expired an hour later. The vendor's integration cannot
 * depend on the buyer keeping a page open.
 */
async function settleCheckoutSessions() {
  const checkout = require('../routes/checkout');
  const { settle, normalise, RECHECK_INTERVAL_MS } = checkout._internals;
  const now = Date.now();
  let checked = 0;

  for (const raw of db.getAll('checkoutSessions')) {
    const session = normalise(raw);
    if (!['AWAITING_PAYMENT', 'VERIFYING'].includes(session.status)) continue;
    if (!session.clientWalletAddress) continue;
    if (new Date(session.expiresAt).getTime() <= now && !session.pendingTxHash) continue;

    // settle() throttles itself; the check here only keeps the count honest.
    const lastChecked = new Date(session.lastCheckedAt || 0).getTime();
    if (now - lastChecked < RECHECK_INTERVAL_MS) continue;

    try {
      await settle(session);
      checked += 1;
    } catch (error) {
      logger.warn(`[Maintenance] Settlement check failed for session ${session.id}: ${error.message}`);
    }
  }

  return checked;
}

/**
 * Expire checkout sessions past their deadline, so a session nobody polls does
 * not sit in PENDING indefinitely.
 */
async function expireCheckoutSessions() {
  // Same rule as the status endpoint, so expiring from here also sends the
  // vendor's `checkout.session.expired` webhook and takes the same final look
  // at the chain first. A bare status write did neither.
  const { expireIfUnpaid, normalise } = require('../routes/checkout')._internals;
  let expired = 0;

  for (const raw of db.getAll('checkoutSessions')) {
    if (!['PENDING', 'AWAITING_PAYMENT', 'VERIFYING'].includes(raw.status)) continue;
    if (new Date(raw.expiresAt).getTime() > Date.now()) continue;
    try {
      const after = await expireIfUnpaid(normalise(raw));
      if (after && after.status === 'EXPIRED') expired += 1;
    } catch (error) {
      logger.warn(`[Maintenance] Expiry check failed for session ${raw.id}: ${error.message}`);
    }
  }

  return expired;
}

async function runOnce() {
  const results = {
    // Order matters: check the chain first, so a transfer that has just
    // confirmed is not reaped, and so its payout can be finalised in the same
    // pass.
    transfersResolved: await reconcileInFlightTransfers(),
    stuckTransactions: reapStuckTransactions(),
    payoutsReconciled: reconcilePayouts(),
    sessionsChecked: await settleCheckoutSessions(),
    sessionsExpired: await expireCheckoutSessions(),
    idempotencyKeysPruned: pruneIdempotencyKeys(),
    webhooksRetried: await WebhookService.sweep(),
  };

  const worked = Object.values(results).some((count) => count > 0);
  if (worked) {
    logger.info(`[Maintenance] ${JSON.stringify(results)}`);
  }

  return results;
}

let timer = null;

function start(intervalMs = 60_000) {
  if (timer) return timer;

  timer = setInterval(() => {
    runOnce().catch((error) => logger.error(`[Maintenance] Sweep failed: ${error.message}`));
  }, intervalMs);

  // Do not hold the process open on this timer alone.
  if (typeof timer.unref === 'function') timer.unref();

  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  runOnce,
  reapStuckTransactions,
  reconcileInFlightTransfers,
  reconcilePayouts,
  settleCheckoutSessions,
  expireCheckoutSessions,
};
