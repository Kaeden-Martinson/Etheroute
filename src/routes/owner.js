'use strict';

/**
 * The owner panel's API: the platform as its operator sees it.
 *
 * Every route needs a signed-in session on an account flagged `owner`
 * (scripts/owner.js grant <username>). Nothing here is reachable with an
 * API key, and nothing here returns a secret: wallets come without their
 * keys, users without their hashes. The panel reads across every merchant
 * - that is the point - so the guard is the whole of the access control.
 */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { db, DB_FILE } = require('../config/database');
const { config } = require('../config/env');
const chains = require('../config/chains');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { ApiError, ValidationError } = require('../utils/errors');
const PriceService = require('../services/PriceService');
const FeeCollectionService = require('../services/FeeCollectionService');
const ChainHealthService = require('../services/ChainHealthService');
const GasFloatService = require('../services/GasFloatService');
const UsageLog = require('../services/UsageLog');
const KeyVault = require('../services/crypto/KeyVault');

const router = Router();
router.use(requireAuth, requireOwner);

const DAY_MS = 24 * 60 * 60 * 1000;
const IN_FLIGHT = ['PENDING', 'PROCESSING'];

function limitOf(req, fallback = 50, max = 500) {
  return Math.min(Math.max(parseInt(req.query.limit, 10) || fallback, 1), max);
}

/** A wallet as the owner may see it: its figures, never its keys. */
function publicWallet(wallet) {
  const safe = KeyVault.redactWallet ? KeyVault.redactWallet(wallet) : wallet;
  const { privateKey, seedPhrase, ...rest } = safe;
  const rate = PriceService.rateFor(wallet.chain) || 0;
  const tokensUSD = Object.values(wallet.tokenBalances || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
  return {
    ...rest,
    balanceUSD: (Number(wallet.balance) || 0) * rate,
    tokensUSD,
    platformFeeHeld: Number(wallet.serviceSubtractions) || 0,
    platformFeeHeldUSD: (Number(wallet.serviceSubtractions) || 0) * rate,
    platformFeeHeldTokens: wallet.serviceSubtractionsTokens || {},
  };
}

/** A user as a row in the merchants table: no hashes, no codes. */
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin || null,
    developer: !!user.developer,
    owner: !!user.owner,
    apiKeyPrefix: user.apiKeyPrefix || null,
    apiKeyGeneratedAt: user.apiKeyGeneratedAt || null,
  };
}

function usdOfWallet(wallet) {
  const rate = PriceService.rateFor(wallet.chain) || 0;
  const tokens = Object.values(wallet.tokenBalances || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
  return (Number(wallet.balance) || 0) * rate + tokens;
}

function payoutRow(p) {
  const transfers = (p.withdrawalPlan && p.withdrawalPlan.transfers) || [];
  return {
    id: p.id,
    clientId: p.clientId,
    status: p.status,
    payoutChain: p.payoutChain || p.chain,
    payoutAsset: p.payoutAsset || null,
    recipientAddress: p.recipientAddress,
    totalAmountUsd: Number(p.totalAmountUsd) || 0,
    netAmountUsd: Number(p.netAmountUsd) || 0,
    platformFee: Number(p.platformFee) || 0,
    transfers: transfers.length,
    transfersByStatus: transfers.reduce((acc, t) => { const s = String(t.status || 'PENDING').toUpperCase(); acc[s] = (acc[s] || 0) + 1; return acc; }, {}),
    createdAt: p.createdAt,
    completedAt: p.completedAt || null,
  };
}

function newestFirst(list, field = 'createdAt') {
  return list.slice().sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
}

/**
 * The numbers on the front page.
 * GET /api/owner/overview
 */
router.get('/overview', (req, res, next) => {
  try {
    const now = Date.now();
    const since = (days) => new Date(now - days * DAY_MS).toISOString();
    const users = db.getAll('users');
    const wallets = db.findBy('wallets', { isActive: true });
    const payouts = db.getAll('payouts');
    const sessions = db.getAll('checkoutSessions');
    const transactions = db.getAll('transactions');
    const fees = FeeCollectionService.summary();
    const health = ChainHealthService.getSnapshot();
    UsageLog.flush();

    const payoutsByStatus = payouts.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {});
    const recentPayouts = payouts.filter((p) => String(p.createdAt) >= since(30));
    const paidSessions = sessions.filter((s) => s.status === 'PAID');
    const recentPaid = paidSessions.filter((s) => String(s.paidAt || s.createdAt) >= since(30));
    const usersByName = new Map(users.map((u) => [u.id, u.username]));

    res.json({
      generatedAt: new Date(now).toISOString(),
      merchants: {
        total: users.length,
        newLast7d: users.filter((u) => String(u.createdAt) >= since(7)).length,
        activeLast30d: users.filter((u) => String(u.lastLogin || '') >= since(30)).length,
        owners: users.filter((u) => u.owner).length,
      },
      wallets: {
        total: wallets.length,
        byChain: wallets.reduce((acc, w) => { acc[w.chain] = (acc[w.chain] || 0) + 1; return acc; }, {}),
        onChainUsd: wallets.reduce((sum, w) => sum + usdOfWallet(w), 0),
      },
      payouts: {
        total: payouts.length,
        byStatus: payoutsByStatus,
        volumeUsd: payouts.reduce((sum, p) => sum + (Number(p.totalAmountUsd) || 0), 0),
        feesUsd: payouts.reduce((sum, p) => sum + (Number(p.platformFee) || 0), 0),
        last30d: { count: recentPayouts.length, volumeUsd: recentPayouts.reduce((sum, p) => sum + (Number(p.totalAmountUsd) || 0), 0), feesUsd: recentPayouts.reduce((sum, p) => sum + (Number(p.platformFee) || 0), 0) },
      },
      checkout: {
        sessions: sessions.length,
        paid: paidSessions.length,
        paidUsd: paidSessions.reduce((sum, s) => sum + (Number(s.usdAmount) || 0), 0),
        last30d: { paid: recentPaid.length, paidUsd: recentPaid.reduce((sum, s) => sum + (Number(s.usdAmount) || 0), 0) },
        open: sessions.filter((s) => ['PENDING', 'AWAITING_PAYMENT', 'VERIFYING'].includes(s.status)).length,
      },
      transactions: {
        inFlight: transactions.filter((t) => IN_FLIGHT.includes(t.status)).length,
        failedLast7d: transactions.filter((t) => t.status === 'FAILED' && String(t.createdAt) >= since(7)).length,
      },
      fees: {
        configured: fees.configured,
        heldUsd: fees.held.usd,
        heldWallets: fees.held.wallets,
        collectedUsd: fees.collected.usd,
        collectedCount: fees.collected.count,
      },
      usage: {
        last24h: db.countBy('apiCalls', {}, 'timestamp', { from: since(1) }),
        errorsLast24h: db.range('apiCalls', {}, 'timestamp', { from: since(1) }).filter((c) => Number(c.statusCode) >= 400).length,
        last7d: db.countBy('apiCalls', {}, 'timestamp', { from: since(7) }),
      },
      chains: { counts: health.counts, checkedAt: health.checkedAt, problems: health.chains.filter((c) => c.status && c.status !== 'up' && c.status !== 'unknown').map((c) => ({ code: c.code, name: c.name, status: c.status })) },
      latest: {
        payouts: newestFirst(payouts).slice(0, 8).map((p) => ({ ...payoutRow(p), username: usersByName.get(p.clientId) || null })),
        merchants: newestFirst(users).slice(0, 5).map(publicUser),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Every merchant, with what they hold and what they have moved.
 * GET /api/owner/merchants?q=&limit=
 */
router.get('/merchants', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = limitOf(req, 100);
    const wallets = db.findBy('wallets', { isActive: true });
    const payouts = db.getAll('payouts');
    const sessions = db.getAll('checkoutSessions');
    const byClient = (list) => list.reduce((acc, r) => { (acc[r.clientId] = acc[r.clientId] || []).push(r); return acc; }, {});
    const walletsBy = byClient(wallets);
    const payoutsBy = byClient(payouts);
    const sessionsBy = byClient(sessions);

    const rows = db.getAll('users')
      .filter((u) => !q || String(u.username || '').toLowerCase().includes(q) || String(u.id).toLowerCase().startsWith(q))
      .map((u) => {
        const own = walletsBy[u.id] || [];
        const paid = (sessionsBy[u.id] || []).filter((s) => s.status === 'PAID');
        const outs = payoutsBy[u.id] || [];
        return {
          ...publicUser(u),
          wallets: own.length,
          onChainUsd: own.reduce((sum, w) => sum + usdOfWallet(w), 0),
          feesHeldUsd: own.reduce((sum, w) => sum + (Number(w.serviceSubtractions) || 0) * (PriceService.rateFor(w.chain) || 0) + Object.values(w.serviceSubtractionsTokens || {}).reduce((t, v) => t + (Number(v) || 0), 0), 0),
          payouts: outs.length,
          payoutVolumeUsd: outs.reduce((sum, p) => sum + (Number(p.totalAmountUsd) || 0), 0),
          paidSessions: paid.length,
          paidUsd: paid.reduce((sum, s) => sum + (Number(s.usdAmount) || 0), 0),
          lastActivity: [u.lastLogin, ...outs.map((p) => p.createdAt), ...paid.map((s) => s.paidAt)].filter(Boolean).sort().pop() || u.createdAt,
        };
      });
    res.json({ total: rows.length, merchants: newestFirst(rows, 'lastActivity').slice(0, limit) });
  } catch (error) {
    next(error);
  }
});

/**
 * One merchant: wallets, payouts, sessions, transactions.
 * GET /api/owner/merchants/:id
 */
router.get('/merchants/:id', (req, res, next) => {
  try {
    const user = db.getById('users', req.params.id);
    if (!user) throw new ApiError(404, 'Merchant not found');
    const wallets = db.findBy('wallets', { clientId: user.id }).map(publicWallet);
    const payouts = newestFirst(db.findBy('payouts', { clientId: user.id })).slice(0, 50).map(payoutRow);
    const sessions = newestFirst(db.findBy('checkoutSessions', { clientId: user.id })).slice(0, 50).map((s) => ({ id: s.id, status: s.status, chain: s.chain, asset: s.asset, usdAmount: s.usdAmount, nativeAmount: s.nativeAmount, reference: s.reference, createdAt: s.createdAt, paidAt: s.paidAt, paidTxHash: s.paidTxHash }));
    const transactions = newestFirst(db.findBy('transactions', { clientId: user.id })).slice(0, 50).map((t) => ({ id: t.id, type: t.type, status: t.status, chain: t.chain, asset: t.asset, route: t.route, nativeAmount: t.nativeAmount, usdAmount: t.usdAmount, transactionHash: t.transactionHash, fromAddress: t.fromAddress, toAddress: t.toAddress, createdAt: t.createdAt, completedAt: t.completedAt, failureReason: t.failureReason || null }));
    const usage = { last24h: db.countBy('apiCalls', { clientId: user.id }, 'timestamp', { from: new Date(Date.now() - DAY_MS).toISOString() }), total: db.countBy('apiCalls', { clientId: user.id }) };
    res.json({ merchant: publicUser(user), wallets, payouts, sessions, transactions, usage });
  } catch (error) {
    next(error);
  }
});

/**
 * Payouts across every merchant, newest first.
 * GET /api/owner/payouts?status=&limit=
 */
router.get('/payouts', (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const usersByName = new Map(db.getAll('users').map((u) => [u.id, u.username]));
    const list = newestFirst(status ? db.findBy('payouts', { status }) : db.getAll('payouts'));
    res.json({ total: list.length, payouts: list.slice(0, limitOf(req)).map((p) => ({ ...payoutRow(p), username: usersByName.get(p.clientId) || null })) });
  } catch (error) {
    next(error);
  }
});

/**
 * Transactions across every merchant; in flight by default.
 * GET /api/owner/transactions?status=PROCESSING&limit=
 */
router.get('/transactions', (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const usersByName = new Map(db.getAll('users').map((u) => [u.id, u.username]));
    const all = status === 'ALL' || !status
      ? db.getAll('transactions').filter((t) => !status ? IN_FLIGHT.includes(t.status) : true)
      : db.findBy('transactions', { status });
    const list = newestFirst(all).slice(0, limitOf(req)).map((t) => ({
      id: t.id, clientId: t.clientId, username: usersByName.get(t.clientId) || null, type: t.type, status: t.status, chain: t.chain, asset: t.asset, route: t.route,
      nativeAmount: t.nativeAmount, usdAmount: t.usdAmount, transactionHash: t.transactionHash, fromAddress: t.fromAddress, toAddress: t.toAddress,
      createdAt: t.createdAt, completedAt: t.completedAt, failureReason: t.failureReason || null, lastKnownStatus: t.lastKnownStatus || null, lastCheckedAt: t.lastCheckedAt || null,
    }));
    res.json({ total: all.length, transactions: list });
  } catch (error) {
    next(error);
  }
});

/**
 * Checkout sessions across every merchant.
 * GET /api/owner/sessions?status=&limit=
 */
router.get('/sessions', (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const usersByName = new Map(db.getAll('users').map((u) => [u.id, u.username]));
    const list = newestFirst(status ? db.findBy('checkoutSessions', { status }) : db.getAll('checkoutSessions'));
    res.json({
      total: list.length,
      sessions: list.slice(0, limitOf(req)).map((s) => ({ id: s.id, clientId: s.clientId, username: usersByName.get(s.clientId) || null, status: s.status, chain: s.chain, asset: s.asset, usdAmount: s.usdAmount, nativeAmount: s.nativeAmount, reference: s.reference, createdAt: s.createdAt, paidAt: s.paidAt, paidTxHash: s.paidTxHash })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The fee book: held per wallet, collected per chain, the addresses.
 * GET /api/owner/fees
 */
router.get('/fees', (req, res, next) => {
  try {
    const usersByName = new Map(db.getAll('users').map((u) => [u.id, u.username]));
    const summary = FeeCollectionService.summary();
    summary.held.rows = summary.held.rows.map((r) => ({ ...r, username: usersByName.get(r.clientId) || null }));
    summary.recent = summary.recent.map((r) => ({ ...r, username: usersByName.get(r.clientId) || null }));
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

function chainArg(req) {
  const chain = req.body && req.body.chain ? String(req.body.chain).toUpperCase() : null;
  if (chain && !chains.has(chain)) throw new ValidationError(`Unknown chain ${chain}`);
  return chain;
}

/**
 * What a sweep would send now, and why the rest waits. Reads the chains; sends nothing.
 * POST /api/owner/fees/plan { chain? }
 */
router.post('/fees/plan', async (req, res, next) => {
  try {
    const result = await FeeCollectionService.collect({ chain: chainArg(req), dryRun: true });
    res.json({ planned: result.planned || [], skipped: result.skipped, note: result.note || null });
  } catch (error) {
    next(error);
  }
});

/**
 * Sweep the held fees that are worth it to the platform's addresses. Real sends.
 * POST /api/owner/fees/collect { chain? }
 */
router.post('/fees/collect', async (req, res, next) => {
  try {
    const result = await FeeCollectionService.collect({ chain: chainArg(req) });
    res.json({ collected: result.collected, failed: result.failed, skipped: result.skipped, note: result.note || null });
  } catch (error) {
    next(error);
  }
});

/**
 * Cap every held figure at what its wallet holds.
 * POST /api/owner/fees/reconcile
 */
router.post('/fees/reconcile', (req, res, next) => {
  try {
    res.json({ changed: FeeCollectionService.reconcileHeld() });
  } catch (error) {
    next(error);
  }
});

/**
 * Requests across the platform, bucketed, with the busiest merchants.
 * GET /api/owner/usage?period=day|week
 */
router.get('/usage', (req, res, next) => {
  try {
    UsageLog.flush();
    const period = req.query.period === 'week' ? 'week' : 'day';
    const stepMs = period === 'week' ? DAY_MS : 60 * 60 * 1000;
    const buckets = period === 'week' ? 7 : 24;
    const end = Math.floor(Date.now() / stepMs) * stepMs + stepMs;
    const start = end - buckets * stepMs;
    const rows = db.range('apiCalls', {}, 'timestamp', { from: new Date(start).toISOString() });
    const values = new Array(buckets).fill(0);
    const errors = new Array(buckets).fill(0);
    const byClient = {};
    const byEndpoint = {};
    for (const row of rows) {
      const t = new Date(row.timestamp).getTime();
      const i = Math.floor((t - start) / stepMs);
      if (i >= 0 && i < buckets) {
        values[i] += 1;
        if (Number(row.statusCode) >= 400) errors[i] += 1;
      }
      byClient[row.clientId] = (byClient[row.clientId] || 0) + 1;
      const key = `${row.method} ${String(row.endpoint || '').replace(/\/[0-9a-f-]{20,}/gi, '/:id')}`;
      byEndpoint[key] = (byEndpoint[key] || 0) + 1;
    }
    const usersByName = new Map(db.getAll('users').map((u) => [u.id, u.username]));
    res.json({
      period,
      labels: values.map((_, i) => new Date(start + i * stepMs).toISOString()),
      values,
      errors,
      total: rows.length,
      topMerchants: Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([clientId, calls]) => ({ clientId, username: usersByName.get(clientId) || null, calls })),
      topEndpoints: Object.entries(byEndpoint).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([endpoint, calls]) => ({ endpoint, calls })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Every chain's health, as the status page has it.
 * GET /api/owner/chains
 */
router.get('/chains', (req, res, next) => {
  try {
    res.json(ChainHealthService.getSnapshot());
  } catch (error) {
    next(error);
  }
});

/**
 * The process and its configuration, without secrets: what is set, not what to.
 * GET /api/owner/server
 */
router.get('/server', async (req, res, next) => {
  try {
    const pkg = require('../../package.json');
    let dbBytes = null;
    try { dbBytes = fs.statSync(DB_FILE).size + (fs.existsSync(`${DB_FILE}-wal`) ? fs.statSync(`${DB_FILE}-wal`).size : 0); } catch { /* unreadable */ }
    const fees = FeeCollectionService.summary();
    const floatChains = ['ETH', 'BASE', 'ARB', 'POL', 'BNB', 'OP', 'AVAX'].filter((c) => chains.has(c));
    const floatBalances = GasFloatService.enabled()
      ? await Promise.all(floatChains.map(async (code) => { try { return { chain: code, balance: await GasFloatService.balanceOn(code) }; } catch (error) { return { chain: code, balance: null, error: error.message }; } }))
      : [];
    res.json({
      version: pkg.version,
      node: process.version,
      environment: config.nodeEnv || process.env.NODE_ENV || 'development',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      database: { file: path.basename(DB_FILE), bytes: dbBytes, usagePending: UsageLog.pendingCount() },
      chains: { total: chains.CODES.length, families: [...new Set(chains.list().map((c) => c.family))] },
      prices: { updatedAt: PriceService.updatedAt ? new Date(PriceService.updatedAt).toISOString() : null, fresh: PriceService.isFresh(), error: PriceService.lastError || null },
      set: {
        etherscanKey: Boolean(process.env.ETHERSCAN_API_KEY),
        oneRpcKey: Boolean(process.env.ONE_RPC_KEY),
        blockcypherToken: Boolean(process.env.BLOCKCYPHER_TOKEN),
        coingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
        alertWebhook: Boolean(process.env.ALERT_WEBHOOK_URL),
        gasFloat: GasFloatService.enabled(),
        crossChainPrefer: process.env.CROSS_CHAIN_PREFER || null,
        platformFeeRate: config.payouts.platformFeeRate,
      },
      gasFloat: { address: GasFloatService.address || null, balances: floatBalances },
      feeAddresses: fees.addresses,
      feeThresholds: fees.thresholds,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
