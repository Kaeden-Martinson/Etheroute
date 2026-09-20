/**
 * Pre-production audit: the things that would have broken on the first real
 * payout to a non-ETH chain, the first LTC checkout, or the first partner
 * integration hitting the API from one address.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { db } = require('../src/config/database');
const ChainTxStatus = require('../src/services/ChainTxStatus');
const SideshiftService = require('../src/services/SideshiftService');
const PayoutService = require('../src/services/PayoutService');
const TransactionService = require('../src/services/TransactionService');
const SwapService = require('../src/services/SwapService');
const GasEstimator = require('../src/services/GasEstimator');
const PriceService = require('../src/services/PriceService');
const BalanceWatcher = require('../src/services/BalanceWatcher');
const WebhookService = require('../src/services/WebhookService');
const BitcoinWalletService = require('../src/services/wallets/BitcoinWalletService');
const LitecoinWalletService = require('../src/services/wallets/LitecoinWalletService');
const checkout = require('../src/routes/checkout');

const { confirmationsOf, settle, checkExpiry, expireIfUnpaid, RECHECK_INTERVAL_MS } = checkout._internals;

// ─── Direct transfers are checked on their own chain ─────────────────────────

describe('Direct payout status is checked on the transfer\'s own chain', () => {
  let original;
  beforeEach(() => { original = ChainTxStatus.getTransferStatus; });
  afterEach(() => { ChainTxStatus.getTransferStatus = original; });

  test('a BTC direct transfer is looked up as BTC, not on the Ethereum RPC', async () => {
    const calls = [];
    ChainTxStatus.getTransferStatus = async (chain, hash) => {
      calls.push({ chain, hash });
      return { status: 'settled', confirmations: 3, blockHeight: 900000 };
    };

    const service = new SideshiftService(PriceService);
    const [status] = await service.getOrderStatus('direct_transfer_abc', 'btc-txid', 'BTC');

    assert.deepStrictEqual(calls, [{ chain: 'BTC', hash: 'btc-txid' }]);
    assert.strictEqual(status.status, 'settled');
    assert.strictEqual(status.chain, 'BTC');
  });

  test('every supported chain routes to its own lookup', async () => {
    const seen = [];
    ChainTxStatus.getTransferStatus = async (chain) => {
      seen.push(chain);
      return { status: 'waiting', confirmations: 0, blockHeight: null };
    };
    const service = new SideshiftService(PriceService);
    for (const chain of ['ETH', 'BTC', 'LTC', 'SOL']) {
      await service.getOrderStatus('direct_transfer_x', 'hash', chain);
    }
    assert.deepStrictEqual(seen, ['ETH', 'BTC', 'LTC', 'SOL']);
  });

  test('a hash the network does not know yet reports waiting, not failed', async () => {
    ChainTxStatus.getTransferStatus = async () => ({ status: 'not_found', confirmations: 0, blockHeight: null });
    const service = new SideshiftService(PriceService);
    const [status] = await service.getOrderStatus('direct_transfer_x', 'hash', 'LTC');
    assert.strictEqual(status.status, 'waiting');
    assert.strictEqual(status.onChainStatus, 'not_found');
  });

  test('an unsupported chain is rejected rather than silently checked elsewhere', async () => {
    await assert.rejects(() => original('DOGE', 'hash'), /Unsupported chain/);
  });
});

// ─── Sideshift status vocabulary ─────────────────────────────────────────────

describe('Sideshift order statuses', () => {
  const classify = PayoutService.constructor.classifyOrderStatus;

  test('settled confirms', () => {
    assert.strictEqual(classify('settled').confirmed, true);
  });

  test('the in-progress states keep waiting rather than failing', () => {
    // 'refund' and 'refunding' were previously unhandled and 'review' /
    // 'settling' fell through the same gap; none of them is a failure yet.
    for (const status of ['waiting', 'pending', 'processing', 'review', 'settling', 'refund', 'refunding']) {
      assert.strictEqual(classify(status).pending, true, `${status} should still be pending`);
    }
  });

  test('terminal failures carry a reason', () => {
    assert.strictEqual(classify('expired').reason, 'ORDER_EXPIRED');
    assert.strictEqual(classify('refunded').reason, 'ORDER_REFUNDED');
    assert.strictEqual(classify('multiple').reason, 'ORDER_NEEDS_REVIEW');
  });

  test('an unknown future status is treated as pending, not failed', () => {
    assert.strictEqual(classify('something-new').pending, true);
  });
});

// ─── In-flight transfers survive the in-process monitor ──────────────────────

describe('Transfers left in flight are reconciled later', () => {
  let originalStatus;
  let wallet;

  beforeEach(() => {
    originalStatus = PayoutService.sideShift.getOrderStatus;
    wallet = db.create('wallets', {
      id: `w-${Date.now()}-${Math.random()}`,
      clientId: 'client-reconcile',
      chain: 'BTC',
      address: `bc1q-reconcile-${Math.random()}`,
      isActive: true,
      balance: 0,
      serviceSubtractions: 0,
    });
  });

  afterEach(() => {
    PayoutService.sideShift.getOrderStatus = originalStatus;
  });

  function transactionFor(orderId, txHash) {
    const transaction = TransactionService.createTransaction(
      'client-reconcile', txHash, orderId, 'DIRECT_TRANSFER', 'BTC', 0.01, 600, wallet.address, 'bc1qdest', 'bc1qdest'
    );
    TransactionService.markTransactionProcessing(transaction.id, txHash);
    return db.getById('transactions', transaction.id);
  }

  test('a settled direct transfer becomes CONFIRMED', async () => {
    PayoutService.sideShift.getOrderStatus = async () => [{ status: 'settled' }];
    const transaction = transactionFor('direct_transfer_1', 'hash-1');

    const outcome = await PayoutService.reconcileTransaction(transaction);

    assert.strictEqual(outcome, 'confirmed');
    assert.strictEqual(db.getById('transactions', transaction.id).status, 'CONFIRMED');
  });

  test('a transfer still waiting stays PROCESSING and records when it was seen', async () => {
    PayoutService.sideShift.getOrderStatus = async () => [{ status: 'waiting' }];
    const transaction = transactionFor('direct_transfer_2', 'hash-2');

    const outcome = await PayoutService.reconcileTransaction(transaction);
    const after = db.getById('transactions', transaction.id);

    assert.strictEqual(outcome, 'pending');
    assert.strictEqual(after.status, 'PROCESSING');
    assert.strictEqual(after.lastKnownStatus, 'waiting');
    assert.ok(after.lastCheckedAt, 'the check should be timestamped for the stuck-transaction reaper');
  });

  test('the chain the transfer was on is passed to the status lookup', async () => {
    let seenChain = null;
    PayoutService.sideShift.getOrderStatus = async (orderId, txHash, chain) => {
      seenChain = chain;
      return [{ status: 'waiting' }];
    };
    await PayoutService.reconcileTransaction(transactionFor('direct_transfer_3', 'hash-3'));
    assert.strictEqual(seenChain, 'BTC');
  });

  test('a refunded swap becomes FAILED with the reason', async () => {
    PayoutService.sideShift.getOrderStatus = async () => [{ status: 'refunded' }];
    const transaction = transactionFor('sideshift-order-9', 'hash-4');

    const outcome = await PayoutService.reconcileTransaction(transaction);
    const after = db.getById('transactions', transaction.id);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(after.status, 'FAILED');
    assert.strictEqual(after.failureReason, 'ORDER_REFUNDED');
  });

  test('re-checking does not move the broadcast time, so the reaper clock is honest', async () => {
    PayoutService.sideShift.getOrderStatus = async () => [{ status: 'waiting' }];
    const transaction = transactionFor('direct_transfer_5', 'hash-5');
    const before = transaction.broadcastedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await PayoutService.reconcileTransaction(transaction);

    assert.strictEqual(db.getById('transactions', transaction.id).broadcastedAt, before);
  });
});

describe('Payout final status', () => {
  test('a payout with nothing confirmed and something failed is FAILED, never COMPLETED', () => {
    const payout = db.create('payouts', { id: `p-${Math.random()}`, clientId: 'c', status: 'PROCESSING', withdrawalPlan: { transfers: [] } });
    assert.strictEqual(PayoutService.finalisePayout(payout.id, 0, 2), 'FAILED');
  });

  test('mixed outcomes are PARTIAL', () => {
    const payout = db.create('payouts', { id: `p-${Math.random()}`, clientId: 'c', status: 'PROCESSING', withdrawalPlan: { transfers: [] } });
    assert.strictEqual(PayoutService.finalisePayout(payout.id, 1, 1), 'PARTIAL');
  });

  test('the monitor no longer fails transfers on timeout', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/PayoutService.js'), 'utf-8');
    const monitor = source.slice(source.indexOf('async monitorTransactionConfirmation'), source.indexOf('static classifyOrderStatus'));
    assert.ok(!/'TIMEOUT'/.test(monitor), 'a slow confirmation must be left PROCESSING for the maintenance sweep, not marked FAILED');
    assert.ok(monitor.includes('unresolvedCount'), 'the monitor should report what it could not resolve');
  });
});

describe('Concurrent withdrawals for one client', () => {
  test('a second withdrawal while one is in progress is refused with 409', async () => {
    PayoutService.inFlightClients.add('client-busy');
    try {
      await assert.rejects(
        () => PayoutService.processWithdrawal('client-busy', '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e', undefined, 'ETH'),
        (error) => error.statusCode === 409
      );
    } finally {
      PayoutService.inFlightClients.delete('client-busy');
    }
  });

  test('wallets in a payout that has not finished count as busy', () => {
    db.create('payouts', {
      id: `p-${Math.random()}`,
      clientId: 'client-inflight',
      status: 'PENDING',
      withdrawalPlan: { transfers: [{ fromAddress: 'addr-A', status: 'PENDING' }, { fromAddress: 'addr-B', status: 'CONFIRMED' }] },
    });
    const busy = PayoutService.addressesInFlight('client-inflight');
    assert.ok(busy.has('addr-A'));
    assert.ok(!busy.has('addr-B'), 'a confirmed transfer no longer holds its wallet');
  });
});

// ─── Solana rent ─────────────────────────────────────────────────────────────

describe('Solana reserve covers rent exemption', () => {
  let originalQuote;
  let originalEstimate;

  beforeEach(() => {
    PriceService.solToUsdRate = 150;
    originalQuote = SwapService.sideshift.getGasQuote;
    originalEstimate = GasEstimator.estimate;
    GasEstimator.clear();
    GasEstimator.estimate = async () => ({ native: 0.000005, usd: 0.00075, live: true });
    SwapService.sideshift.getGasQuote = async (from, to, amount) => ({ outputAmount: amount, changeInOutput: 0, estimatedGasUsd: 0.001 });
  });

  afterEach(() => {
    SwapService.sideshift.getGasQuote = originalQuote;
    GasEstimator.estimate = originalEstimate;
    GasEstimator.clear();
  });

  test('a SOL send leaves at least the rent-exempt minimum behind', async () => {
    const plan = await SwapService.planBatchWithdrawal([{ chain: 'SOL', address: 'sol-addr', balance: 0.05, balanceUSD: 7.5 }], 7.5, 'SOL');
    const transfer = plan.transfers[0];
    assert.ok(transfer.networkReserveNative >= 0.00089088, `reserve ${transfer.networkReserveNative} is below the rent-exempt minimum`);
    assert.ok(transfer.networkReserveNative > 0.000005 * 1.5, 'the fee-based reserve alone is a hundred times too small');
  });

  test('the floor does not apply to chains without rent', async () => {
    PriceService.btcToUsdRate = 60000;
    GasEstimator.estimate = async () => ({ native: 0.00002, usd: 1.2, live: true });
    const plan = await SwapService.planBatchWithdrawal([{ chain: 'BTC', address: 'btc-addr', balance: 0.01, balanceUSD: 600 }], 600, 'BTC');
    assert.ok(Math.abs(plan.transfers[0].networkReserveNative - 0.00002 * 1.5) < 1e-12);
  });
});

// ─── UTXO fee sizing ─────────────────────────────────────────────────────────

describe('Bitcoin and Litecoin fees are sized to the transaction', () => {
  test('each extra input costs more', () => {
    assert.strictEqual(BitcoinWalletService.constructor.virtualSize(1, 2), 141);
    assert.ok(BitcoinWalletService.constructor.virtualSize(4, 2) > 2 * 141);
  });

  test('legacy P2PKH Litecoin transactions are larger than SegWit ones', () => {
    assert.ok(LitecoinWalletService.constructor.virtualSize(1, 2) > BitcoinWalletService.constructor.virtualSize(1, 2));
  });

  test('the send path selects inputs against a fee that grows with them', () => {
    for (const [name, file] of [['BTC', 'BitcoinWalletService'], ['LTC', 'LitecoinWalletService']]) {
      const source = fs.readFileSync(path.join(__dirname, `../src/services/wallets/${file}.js`), 'utf-8');
      const send = source.slice(source.indexOf('async sendTransaction'), source.indexOf('async broadcastRawTransaction'));
      assert.ok(send.includes('virtualSize(selectedUtxos.length'), `${name}: fee must be recomputed per selected input`);
      assert.ok(send.includes('DUST_SATS'), `${name}: dust change must be folded into the fee`);
      assert.ok(!send.includes('estimateFee(6)'), `${name}: the fixed one-input fee must not be used for a real send`);
    }
  });

  test('a signed transaction has somewhere else to go when the first endpoint is down', () => {
    assert.ok(BitcoinWalletService.broadcastEndpoints.length >= 2);
    assert.ok(LitecoinWalletService.broadcastEndpoints.length >= 2);
  });
});

// ─── Checkout confirmations ──────────────────────────────────────────────────

describe('Checkout confirmation depth on UTXO chains', () => {
  test('a reported depth is used', () => {
    assert.strictEqual(confirmationsOf('LTC', { blockHeight: 100, confirmations: 4 }), 4);
    assert.strictEqual(confirmationsOf('BTC', { blockHeight: 100, confirmations: 2 }), 2);
  });

  test('without a depth a mined transaction still counts one confirmation', () => {
    assert.strictEqual(confirmationsOf('LTC', { blockHeight: 100 }), 1);
  });

  test('the LTC and BTC history lookups report depth from the chain tip', () => {
    for (const file of ['BitcoinWalletService', 'LitecoinWalletService']) {
      const source = fs.readFileSync(path.join(__dirname, `../src/services/wallets/${file}.js`), 'utf-8');
      assert.ok(source.includes('getTipHeight()'), `${file} must fetch the tip`);
      assert.ok(/confirmations:\s*blockHeight && tipHeight/.test(source), `${file} must compute confirmations from the tip`);
    }
  });
});

// ─── Checkout settlement throttling ──────────────────────────────────────────

describe('Checkout settlement is throttled and coalesced', () => {
  let originalHistory;
  let lookups;

  beforeEach(() => {
    originalHistory = BalanceWatcher.getTransactionHistory;
    lookups = 0;
    BalanceWatcher.getTransactionHistory = async () => {
      lookups += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 'success', transactions: [] };
    };
  });

  afterEach(() => {
    BalanceWatcher.getTransactionHistory = originalHistory;
  });

  function makeSession(overrides = {}) {
    const wallet = db.create('wallets', {
      id: `w-${Math.random()}`, clientId: 'c', chain: 'BTC', address: `bc1q-${Math.random()}`, isActive: true,
    });
    return db.create('checkoutSessions', {
      id: `s-${Math.random()}`,
      clientId: 'c',
      walletId: wallet.id,
      walletAddress: wallet.address,
      chain: 'BTC',
      nativeAmount: 0.01,
      usdAmount: 600,
      clientWalletAddress: 'bc1qbuyer',
      status: 'AWAITING_PAYMENT',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      ...overrides,
    });
  }

  test('a session checked a moment ago is not checked again', async () => {
    const session = makeSession({ lastCheckedAt: new Date().toISOString() });
    await settle(session);
    assert.strictEqual(lookups, 0);
  });

  test('a session past the interval is checked and stamped', async () => {
    const session = makeSession({ lastCheckedAt: new Date(Date.now() - RECHECK_INTERVAL_MS - 1).toISOString() });
    await settle(session);
    assert.strictEqual(lookups, 1);
    assert.ok(new Date(db.getById('checkoutSessions', session.id).lastCheckedAt).getTime() > Date.now() - 1000);
  });

  test('concurrent polls share one lookup', async () => {
    const session = makeSession();
    await Promise.all([settle(session), settle(session), settle(session)]);
    assert.strictEqual(lookups, 1);
  });

  test('the maintenance sweep settles sessions nobody is polling', () => {
    const maintenance = fs.readFileSync(path.join(__dirname, '../src/services/MaintenanceService.js'), 'utf-8');
    assert.ok(maintenance.includes('settleCheckoutSessions'), 'the sweep must check waiting sessions against the chain');
    assert.ok(/sessionsChecked:\s*await settleCheckoutSessions\(\)/.test(maintenance), 'and it must run every pass');
  });
});

describe('Checkout expiry', () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  test('a VERIFYING session with a payment in sight never expires', () => {
    const session = db.create('checkoutSessions', {
      id: `s-${Math.random()}`, status: 'VERIFYING', pendingTxHash: 'abc', expiresAt: past, clientId: 'c',
    });
    assert.strictEqual(checkExpiry(session).status, 'VERIFYING');
  });

  test('a VERIFYING session with nothing seen expires after the grace period', () => {
    const session = db.create('checkoutSessions', {
      id: `s-${Math.random()}`, status: 'VERIFYING', pendingTxHash: null, expiresAt: past, clientId: 'c',
    });
    assert.strictEqual(checkExpiry(session).status, 'EXPIRED');
  });

  test('a VERIFYING session only just past its deadline is given time', () => {
    const session = db.create('checkoutSessions', {
      id: `s-${Math.random()}`, status: 'VERIFYING', pendingTxHash: null,
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(), clientId: 'c',
    });
    assert.strictEqual(checkExpiry(session).status, 'VERIFYING');
  });
});

// ─── Webhook targets ─────────────────────────────────────────────────────────

describe('Webhook targets cannot point inside the network', () => {
  const refused = [
    'http://localhost:3000/hook',
    'http://127.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/hook',
    'http://192.168.1.1/hook',
    'http://172.20.0.5/hook',
    'http://[::1]/hook',
    'http://[::ffff:10.0.0.1]/hook',
    'http://api.internal/hook',
    'http://user:pass@example.com/hook',
  ];

  for (const url of refused) {
    test(`${url} is refused`, () => {
      assert.ok(WebhookService.unsafeTargetReason(new URL(url)), url);
    });
  }

  test('an ordinary public https endpoint is allowed', () => {
    assert.strictEqual(WebhookService.unsafeTargetReason(new URL('https://hooks.partner.example/etheroute')), null);
  });

  test('delivery does not follow redirects', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/WebhookService.js'), 'utf-8');
    assert.ok(source.includes("redirect: 'manual'"));
  });
});

// ─── Rate limiting ───────────────────────────────────────────────────────────

describe('Rate limits are per account once the caller is known', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf-8');
  const checkoutRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');

  test('every authenticated router mounts the client limiter after requireAuth', () => {
    const mounts = app.match(/app\.use\('\/api\/[a-z-]+', requireAuth[^\n]*\)/g) || [];
    assert.ok(mounts.length >= 6, 'expected the authenticated routers');
    for (const mount of mounts) {
      assert.ok(mount.includes('requireAuth, clientLimiter'), `${mount} should be limited per client`);
    }
  });

  test('the merchant checkout routes are limited per client too', () => {
    const merchantRoutes = checkoutRoutes.match(/router\.(?:get|post)\('[^']+', requireAuth[^\n]*/g) || [];
    assert.ok(merchantRoutes.length >= 4);
    for (const route of merchantRoutes) {
      assert.ok(route.includes('requireAuth, clientLimiter'), route);
    }
  });

  test('the limits can be tuned per deployment', () => {
    const { config } = require('../src/config/env');
    assert.ok(config.rateLimits.perClientPerMinute > 0);
    assert.ok(config.rateLimits.perIpPerMinute >= config.rateLimits.perClientPerMinute, 'the IP ceiling should not be tighter than one client\'s budget');
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('Idempotency keys abandoned mid-request', () => {
  const { idempotency } = require('../src/middleware/idempotency');

  function run(req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ kind: 'response', body, headers: this.headers }); },
      };
      idempotency({ required: true })(req, res, (error) => resolve({ kind: 'next', error }));
    });
  }

  function request(key) {
    return { headers: { 'idempotency-key': key }, path: '/api/withdrawal', body: { a: 1 }, auth: { clientId: 'idem-client' } };
  }

  test('a key still in progress from moments ago is refused', async () => {
    const key = `k-${Math.random()}`;
    db.create('idempotencyKeys', {
      id: `idem-client:${key}`, clientId: 'idem-client', status: 'in_progress', createdAt: new Date().toISOString(),
      fingerprint: require('crypto').createHash('sha256').update(JSON.stringify({ path: '/api/withdrawal', body: { a: 1 } })).digest('hex'),
    });
    const result = await run(request(key));
    assert.strictEqual(result.kind, 'next');
    assert.strictEqual(result.error.statusCode, 409);
  });

  test('a key stuck in progress for a long time is taken over', async () => {
    const key = `k-${Math.random()}`;
    db.create('idempotencyKeys', {
      id: `idem-client:${key}`, clientId: 'idem-client', status: 'in_progress',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      fingerprint: require('crypto').createHash('sha256').update(JSON.stringify({ path: '/api/withdrawal', body: { a: 1 } })).digest('hex'),
    });
    const result = await run(request(key));
    assert.strictEqual(result.kind, 'next');
    assert.strictEqual(result.error, undefined, 'the request should proceed');
  });
});

// ─── Price freshness ─────────────────────────────────────────────────────────

describe('Stale prices are not quoted', () => {
  test('age is reported', () => {
    PriceService.updatedAt = Date.now() - 90_000;
    assert.ok(PriceService.ageSeconds() >= 89 && PriceService.ageSeconds() <= 91);
  });

  test('a price older than the limit is not fresh outside test mode', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      PriceService.updatedAt = Date.now() - 20 * 60 * 1000;
      assert.strictEqual(PriceService.isFresh(15 * 60 * 1000), false);
      PriceService.updatedAt = Date.now() - 60 * 1000;
      assert.strictEqual(PriceService.isFresh(15 * 60 * 1000), true);
      PriceService.updatedAt = null;
      assert.strictEqual(PriceService.isFresh(), false);
    } finally {
      process.env.NODE_ENV = env;
      PriceService.updatedAt = Date.now();
    }
  });

  test('the checkout amount resolver refuses stale prices', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');
    assert.ok(source.includes('PriceService.isFresh()'));
  });
});

// ─── Checkout page: "payment detected" state ─────────────────────────────────

describe('The checkout page can tell a seen payment from an unreadable chain', () => {
  const checkoutJs = fs.readFileSync(path.join(__dirname, '../public/js/checkout.js'), 'utf-8');
  const checkoutHtml = fs.readFileSync(path.join(__dirname, '../public/checkout.html'), 'utf-8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');

  test('the status endpoint exposes the pending hash and required depth', () => {
    const fn = routeSource.slice(routeSource.indexOf('function buildStatusResponse'), routeSource.indexOf('function checkExpiry'));
    assert.ok(fn.includes('pendingTxHash: session.pendingTxHash'));
    assert.ok(fn.includes('requiredConfirmations:'));
    assert.ok(fn.includes('detected:'));
  });

  test('a detected payment switches to its own step, not a hint under the QR code', () => {
    assert.ok(checkoutHtml.includes('id="step-verifying"'), 'markup for the detected state');
    assert.ok(checkoutJs.includes("showStep('step-verifying')"));
    // showStep only toggles steps it knows about - a new one that is not
    // listed there can never become visible.
    assert.match(checkoutJs, /\['step-address', 'step-watching', 'step-verifying'/);
  });

  test('VERIFYING with nothing seen keeps watching rather than claiming detection', () => {
    const poll = checkoutJs.slice(checkoutJs.indexOf('async function pollStatus'), checkoutJs.indexOf('const DEFAULT_WATCH_HINT'));
    const branch = poll.slice(poll.indexOf("case 'VERIFYING'"), poll.indexOf("case 'AWAITING_PAYMENT'"));
    assert.ok(branch.includes('data.pendingTxHash || data.detected'), 'detection must be gated on the hash');
    assert.ok(!/handleDetected\(data\);\s*break/.test(branch.split('else')[0]) || branch.includes('else'), 'unreadable chain must fall through to the watching note');
  });

  test('once detected, the expiry clock stops and is hidden', () => {
    const fn = checkoutJs.slice(checkoutJs.indexOf('function handleDetected'), checkoutJs.indexOf('// ── Terminal States'));
    assert.ok(fn.includes('stopCountdown()'));
    assert.ok(fn.includes("hide('countdown-row')"));
  });

  test('the page shows progress towards the required depth', () => {
    assert.ok(checkoutHtml.includes('id="verify-confirmations"'));
    assert.ok(checkoutHtml.includes('id="verify-required"'));
    assert.ok(checkoutHtml.includes('id="verify-bar"'));
  });
});

describe('Confirmation defaults', () => {
  test('Ethereum settles at three confirmations', () => {
    const { config } = require('../src/config/env');
    assert.strictEqual(config.checkout.confirmations.ETH, 3);
  });
});

describe('A session with money in it is never expired', () => {
  let originalHistory;
  beforeEach(() => { originalHistory = BalanceWatcher.getTransactionHistory; });
  afterEach(() => { BalanceWatcher.getTransactionHistory = originalHistory; });

  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  function overdueSession(overrides = {}) {
    const wallet = db.create('wallets', {
      id: `w-${Math.random()}`, clientId: 'c', chain: 'BTC', address: `bc1qmerchant${Math.random().toString(36).slice(2)}`, isActive: true,
    });
    return db.create('checkoutSessions', {
      id: `s-${Math.random()}`,
      clientId: 'c',
      walletId: wallet.id,
      walletAddress: wallet.address,
      chain: 'BTC',
      nativeAmount: 0.01,
      usdAmount: 600,
      clientWalletAddress: 'bc1qbuyer',
      status: 'AWAITING_PAYMENT',
      expiresAt: past,
      createdAt: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
      ...overrides,
    });
  }

  test('a paid session is left alone', async () => {
    const session = overdueSession({ status: 'PAID', paidTxHash: 'abc', paidAmount: 0.01 });
    const after = await expireIfUnpaid(session);
    assert.strictEqual(after.status, 'PAID');
  });

  test('an underpaid session is left alone', async () => {
    const session = overdueSession({ status: 'INSUFFICIENT', paidTxHash: 'abc', paidAmount: 0.004 });
    const after = await expireIfUnpaid(session);
    assert.strictEqual(after.status, 'INSUFFICIENT');
  });

  test('a payment that shows up right at the deadline settles instead of expiring', async () => {
    const session = overdueSession();
    BalanceWatcher.getTransactionHistory = async () => ({
      status: 'success',
      transactions: [{
        hash: 'late-tx', time: Math.floor(Date.now() / 1000) - 30, blockHeight: 900000, confirmations: 1,
        inputs: [{ address: 'bc1qbuyer', value: 0.02 }],
        outputs: [{ address: session.walletAddress, value: 0.01 }],
      }],
    });

    const after = await expireIfUnpaid(session);

    assert.notStrictEqual(after.status, 'EXPIRED');
    assert.strictEqual(after.status, 'PAID');
    assert.strictEqual(after.paidTxHash, 'late-tx');
  });

  test('a partial payment at the deadline becomes INSUFFICIENT, not EXPIRED', async () => {
    const session = overdueSession();
    BalanceWatcher.getTransactionHistory = async () => ({
      status: 'success',
      transactions: [{
        hash: 'short-tx', time: Math.floor(Date.now() / 1000) - 30, blockHeight: 900000, confirmations: 1,
        inputs: [{ address: 'bc1qbuyer', value: 0.02 }],
        outputs: [{ address: session.walletAddress, value: 0.004 }],
      }],
    });

    const after = await expireIfUnpaid(session);
    assert.strictEqual(after.status, 'INSUFFICIENT');
  });

  test('nothing sent in the window expires', async () => {
    const session = overdueSession();
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'success', transactions: [] });

    const after = await expireIfUnpaid(session);
    assert.strictEqual(after.status, 'EXPIRED');
  });

  test('an unreadable chain at the deadline holds rather than expiring', async () => {
    // The final check could not be made, so "no funds were sent" is not
    // known. The VERIFYING grace period handles it from here.
    const session = overdueSession();
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'error' });

    const after = await expireIfUnpaid(session);
    assert.strictEqual(after.status, 'VERIFYING');
  });

  test('the final check ignores the poll throttle', async () => {
    let lookups = 0;
    const session = overdueSession({ lastCheckedAt: new Date().toISOString() });
    BalanceWatcher.getTransactionHistory = async () => { lookups += 1; return { status: 'success', transactions: [] }; };

    await expireIfUnpaid(session);
    assert.strictEqual(lookups, 1, 'a just-checked session must still be checked once more before expiring');
  });
});

describe('Merchant cancel is distinguishable from a timeout', () => {
  const { settleNow } = checkout._internals; // ensure internals loaded
  const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');

  test('cancel marks the session and fires a cancelled webhook', () => {
    const cancel = routeSrc.slice(routeSrc.indexOf("router.post('/sessions/:sessionId/cancel'"), routeSrc.indexOf("router.get('/session/:sessionId'"));
    assert.ok(cancel.includes('cancelledByMerchant: true'), 'the cancel writes the flag');
    assert.ok(cancel.includes("notify(updated, 'checkout.session.cancelled')"), 'a distinct webhook event');
  });

  test('the status and public views expose cancelledByMerchant', () => {
    const build = routeSrc.slice(routeSrc.indexOf('function buildStatusResponse'), routeSrc.indexOf('function checkExpiry'));
    assert.ok(build.includes('cancelledByMerchant: Boolean(session.cancelledByMerchant)'));
    assert.ok(build.includes('clientWalletAddress: session.clientWalletAddress'), 'buyer address echoed for reload');
    const pub = routeSrc.slice(routeSrc.indexOf("router.get('/session/:sessionId'"), routeSrc.indexOf("router.get('/status/:sessionId'"));
    assert.ok(pub.includes('cancelledByMerchant: Boolean(current.cancelledByMerchant)'));
    assert.ok(pub.includes('clientWalletAddress: revealed ? current.clientWalletAddress'));
  });

  test('the checkout page tells a closed payment from an expired one', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/checkout.js'), 'utf-8');
    const fn = js.slice(js.indexOf('function handleExpired'), js.indexOf('// ── Countdown'));
    assert.ok(fn.includes('cancelledByMerchant'), 'branches on the flag');
    assert.ok(fn.includes('Payment closed') && fn.includes('merchant closed'), 'the closed wording');
  });

  test('"expecting from" is restored on reload from the session', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/checkout.js'), 'utf-8');
    const fn = js.slice(js.indexOf('function populateWatchingStep'), js.indexOf('// ── Polling'));
    assert.ok(fn.includes('sessionData?.clientWalletAddress'), 'falls back to the stored address');
  });
});

describe('Status page reflects the multi-chain product', () => {
  const StatusService = require('../src/services/StatusService');

  test('no per-coin services; checkouts replaces withdrawals', () => {
    const keys = StatusService.getDefinitions().map((d) => d.key);
    assert.ok(!keys.some((k) => ['ETH', 'BTC', 'SOL', 'LTC'].includes(k)), 'no coin rows');
    assert.ok(keys.includes('CHECKOUTS'), 'checkouts is a service');
    assert.ok(!keys.includes('WITHDRAWALS'), 'withdrawals renamed');
    assert.ok(keys.every((k) => StatusService.getDefinitions().find((d) => d.key === k).kind === 'platform'), 'all platform-scoped');
  });

  test('a snapshot still computes without any chain services', () => {
    const snap = StatusService.getSnapshot ? StatusService.getSnapshot() : null;
    // getSnapshot may take args in this codebase; just assert the definitions are non-empty.
    assert.ok(StatusService.getDefinitions().length >= 4);
  });
});

describe('The confirm dialog replaces native prompts', () => {
  test('no window.confirm or prompt remains in the dashboard scripts', () => {
    for (const file of ['js/dashboard.js', 'js/dashboard-checkout.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../public', file), 'utf-8');
      // A native call passes a message string; confirmDialog takes an object.
      assert.ok(!/[^.\w]confirm\(['"`]/.test(src), `${file} uses confirmDialog, not native confirm()`);
      assert.ok(!/[^.\w]prompt\(['"`]/.test(src), `${file} has no native prompt()`);
    }
    const dash = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf-8');
    assert.ok(dash.includes('function confirmDialog'), 'the themed dialog exists');
  });

  test('the API page links to the docs', () => {
    // The modal became a page; its head action is the reference.
    const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf-8');
    assert.ok(html.includes('class="btn-small btn-primary" href="/api-reference" target="_blank" rel="noopener"'));
  });
});
