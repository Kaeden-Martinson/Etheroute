/**
 * Balances that follow the chain: the sweep, the nudges after money moves,
 * the dashboard's pull, and the explorers that fail over when one goes away.
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
const crypto = require('node:crypto');

const { db } = require('../src/config/database');
const BalanceWatcher = require('../src/services/BalanceWatcher');
const { STALE_MS, IN_FLIGHT_STALE_MS, SWEEP_BATCH, PULL_THROTTLE_MS } = BalanceWatcher;
const { walletServiceFor } = require('../src/services/wallets');
const ProxyService = require('../src/services/ProxyService');
const ChainTxStatus = require('../src/services/ChainTxStatus');
const Health = require('../src/services/ChainHealthService');
const chains = require('../src/config/chains');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

const CLIENT = crypto.randomUUID();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function wallet(chain, address, lastUpdated, extra = {}) {
  return db.create('wallets', { id: crypto.randomUUID(), clientId: CLIENT, chain, address, privateKey: 'x', balance: 1, balanceUSD: 1, isActive: true, lastUpdated, createdAt: new Date().toISOString(), ...extra });
}

function wipe() {
  for (const table of ['wallets', 'transactions']) {
    for (const row of db.getAll(table)) if (row.clientId === CLIENT || row.fromAddress === 'busy-addr') db.delete(table, row.id);
  }
}

let refreshed;
let originalUpdate;
beforeEach(() => {
  wipe();
  refreshed = [];
  originalUpdate = BalanceWatcher.updateWalletBalance;
  BalanceWatcher.updateWalletBalance = async (w) => {
    refreshed.push(w.address);
    db.update('wallets', w.id, { balance: 2, lastUpdated: new Date().toISOString() });
    return { status: 'success' };
  };
  BalanceWatcher.pulledAt.clear();
});
afterEach(() => { BalanceWatcher.updateWalletBalance = originalUpdate; wipe(); });

describe('The sweep', () => {
  test('reads the stalest wallets first, a bounded batch, and a busy wallet sooner', () => {
    wallet('ETH', 'fresh', ago(10 * 1000));
    wallet('ETH', 'stale-old', ago(STALE_MS + 60 * 1000));
    wallet('ETH', 'stale-new', ago(STALE_MS + 1000));
    wallet('ETH', 'busy-addr', ago(IN_FLIGHT_STALE_MS + 1000));
    wallet('ETH', 'busy-but-fresh', ago(5000));
    db.create('transactions', { id: crypto.randomUUID(), clientId: CLIENT, fromAddress: 'busy-addr', status: 'PROCESSING' });
    const due = BalanceWatcher.due().map((w) => w.address);
    assert.deepStrictEqual(due, ['stale-old', 'stale-new', 'busy-addr'], 'oldest first; a wallet with a transaction in flight after thirty seconds; a fresh one not at all');
    for (let i = 0; i < SWEEP_BATCH + 5; i += 1) wallet('ETH', `many-${i}`, ago(STALE_MS + 2000 + i));
    assert.strictEqual(BalanceWatcher.due().length, SWEEP_BATCH, 'a batch a tick, not everything');
  });

  test('a sweep refreshes what is due and reports how many moved', async () => {
    wallet('ETH', 'a', ago(STALE_MS + 1000));
    wallet('BTC', 'b', ago(STALE_MS + 1000));
    wallet('ETH', 'c', ago(1000));
    const count = await BalanceWatcher.sweep();
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(refreshed.sort(), ['a', 'b']);
    assert.strictEqual(await BalanceWatcher.sweep(), 0, 'nothing is due right after');
  });

  test('a failing wallet does not stop the others', async () => {
    BalanceWatcher.updateWalletBalance = async (w) => { if (w.address === 'boom') throw new Error('explorer down'); refreshed.push(w.address); return {}; };
    const results = await BalanceWatcher.refreshMany([{ address: 'boom', chain: 'ETH' }, { address: 'ok', chain: 'ETH' }]);
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(refreshed, ['ok']);
  });
});

describe('Nudges and pulls', () => {
  test('a nudge reads the wallets named by id or by address - a recipient of ours included', async () => {
    const a = wallet('ETH', '0xAbC', ago(1000));
    wallet('ETH', '0xDeF', ago(1000));
    wallet('ETH', '0x123', ago(1000));
    await BalanceWatcher.nudge([a.id], ['0xdef', 'nobody']);
    assert.deepStrictEqual(refreshed.sort(), ['0xAbC', '0xDeF'], 'the id, and the address case-insensitively; a stranger is not ours');
    assert.deepStrictEqual(await BalanceWatcher.nudge([], []), []);
  });

  test('a pull refreshes the client once per window and returns the fresh records', async () => {
    wallet('ETH', 'p1', ago(1000));
    wallet('LTC', 'p2', ago(1000));
    const first = await BalanceWatcher.refreshClient(CLIENT);
    assert.strictEqual(first.length, 2);
    assert.ok(first.every((w) => w.balance === 2), 'fresh');
    assert.strictEqual(refreshed.length, 2);
    await BalanceWatcher.refreshClient(CLIENT);
    assert.strictEqual(refreshed.length, 2, 'a second pull inside the window reads nothing again');
    BalanceWatcher.pulledAt.set(CLIENT, Date.now() - PULL_THROTTLE_MS - 1);
    await BalanceWatcher.refreshClient(CLIENT);
    assert.strictEqual(refreshed.length, 4);
  });
});

describe('Wired into money moving', () => {
  test('payouts nudge on broadcast, after the watch, and on reconcile; a settled checkout nudges its wallet', () => {
    const payout = read('src/services/PayoutService.js');
    assert.ok(payout.includes("const BalanceWatcher = require('./BalanceWatcher');"));
    assert.ok(payout.includes('BalanceWatcher.nudge([storedWallet.id], [recipientAddress]);'), 'right after the broadcast');
    assert.ok(payout.includes('this._nudgeWalletsOf(payoutId);'), 'after the in-process watch');
    assert.ok(payout.includes('BalanceWatcher.nudge([], [transaction.fromAddress, transaction.finalAddress]);'), 'a confirmed reconcile');
    assert.ok(payout.includes('BalanceWatcher.nudge([], [transaction.fromAddress]);'), 'a refunded one');
    const checkout = read('src/routes/checkout.js');
    assert.ok(checkout.includes("require('../services/BalanceWatcher').nudge([session.walletId]);"));
    const wallets = read('src/routes/wallets.js');
    assert.ok(wallets.includes("router.post('/refresh', async (req, res, next) => {"));
    assert.ok(wallets.includes('await BalanceWatcher.refreshClient(req.auth.clientId)'));
    assert.ok(wallets.includes('const liveRate = PriceService.rateFor(wallet.chain);'), 'dollars at today\'s rate');
    assert.ok(wallets.includes('lastUpdated: wallet.lastUpdated || null,'));
    const app = read('src/app.js');
    assert.ok(app.includes('BalanceWatcher.start();') && app.includes('BalanceWatcher.stop();'));
  });

  test('the dashboard pulls after Send, follows the payout, and refreshes the head on the quiet steps', () => {
    const js = read('public/js/dashboard.js');
    assert.ok(js.includes('async function refreshWallets()'));
    assert.ok(js.includes('apiFetch(`${API_URL}/wallets/refresh`'));
    assert.ok(js.includes('refreshWallets();\n        watchPayout(result.id);'), 'after a withdrawal is sent');
    assert.ok(js.includes('function watchPayout(payoutId)'));
    assert.ok(js.includes("if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(String(payout.status).toUpperCase())) {"));
    assert.ok(js.includes('} else if (currentStep === 1 || currentStep === 4) {\n            await loadWithdrawalPage(true);'));
    assert.ok(js.includes('function displayFinalSummary(payout, liveTransfers = null)'));
    assert.ok(js.includes("const state = status === 'CONFIRMED' ? 'Confirmed' : status === 'FAILED' ? 'Failed'"));
    assert.ok(js.includes('function tickBalanceAge()'));
    const html = read('public/dashboard.html');
    assert.ok(html.includes('id="balanceAge"'));
  });

  test('the status page refreshes itself and names an endpoint that is down', () => {
    const js = read('public/js/status.js');
    assert.ok(js.includes('const AUTO_REFRESH_MS = 60 * 1000;'));
    assert.ok(js.includes('function startAutoRefresh()'));
    assert.ok(js.includes("document.addEventListener('visibilitychange'"));
    assert.ok(js.includes("(quota spent)' : ''}`).join(', ')} down"), 'a spent quota is named as such');
    assert.ok(js.includes("' is-partial'"));
    const html = read('public/status.html');
    assert.ok(html.includes('id="statusLive"'));
    const css = read('public/css/status.css');
    assert.ok(css.includes('.chain-row__rpc.is-partial { color: var(--warn); }'));
  });
});

describe('Explorers that fail over', () => {
  let originalFetch;
  afterEach(() => { if (originalFetch) { ProxyService.fetch = originalFetch; originalFetch = null; } });

  /** litecoinspace / mempool.space dead; BlockCypher answering. */
  function deadMirrorsLiveBlockCypher() {
    originalFetch = ProxyService.fetch;
    const calls = [];
    ProxyService.fetch = async (url) => {
      calls.push(String(url));
      const u = String(url);
      if (u.includes('litecoinspace.org') || u.includes('mempool.space') || u.includes('blockstream.info')) throw new Error('fetch failed');
      const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (u.endsWith('/balance')) return reply({ final_balance: 485948 });
      if (u.includes('unspentOnly')) return reply({ txrefs: [{ tx_hash: '74'.repeat(32), tx_output_n: 1, value: 485948, script: '76a914' + '54'.repeat(20) + '88ac', confirmations: 85 }] });
      if (u.includes('/txs/')) return reply({ hash: '74'.repeat(32), block_height: 3181593, confirmations: 85 });
      if (u.includes('/full')) return reply({ txs: [{ hash: '74'.repeat(32), confirmed: '2026-09-21T00:21:05Z', block_height: 3181593, confirmations: 85, fees: 1000, inputs: [{ addresses: ['LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D'], output_value: 9710457 }], outputs: [{ addresses: ['ltc1q0h3h0t48v60rx9cg88fq0gckmhh2mxu5mtqfqq'], value: 9223509 }, { addresses: ['LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D'], value: 485948 }] }] });
      if (/\/main(\?|$)/.test(u)) return reply({ height: 3181677, medium_fee_per_kb: 10000 });
      return { ok: false, status: 404, json: async () => null, text: async () => '' };
    };
    return calls;
  }

  test('Litecoin: every read falls to BlockCypher when litecoinspace is gone, and says so in the health probe', async () => {
    const calls = deadMirrorsLiveBlockCypher();
    const ltc = walletServiceFor('LTC');
    const balance = await ltc.getBalance('LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D');
    assert.strictEqual(balance.status, 'success');
    assert.strictEqual(balance.balanceLTC, 0.00485948);
    assert.strictEqual(await ltc.getTipHeight(), 3181677);
    assert.deepStrictEqual(await ltc.getTransactionStatus('74'.repeat(32)), { status: 'settled', confirmations: 85, blockHeight: 3181593 });
    assert.deepStrictEqual(await ChainTxStatus.getTransferStatus('LTC', '74'.repeat(32)), { status: 'settled', confirmations: 85, blockHeight: 3181593 }, 'the status lookup goes through the service');
    const history = await ltc.getTransactionHistory('LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D');
    assert.strictEqual(history.transactions[0].outputs[1].address, 'LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D');
    assert.strictEqual(history.transactions[0].confirmations, 85);
    assert.ok(calls.some((c) => c.includes('litecoinspace.org')), 'litecoinspace was tried first');
    assert.ok(calls.some((c) => c.includes('api.blockcypher.com/v1/ltc/main')), 'then BlockCypher');
    const probe = await ltc.probeExplorers();
    assert.deepStrictEqual(probe.map((p) => [p.url.replace(/^https:\/\//, ''), p.ok]), [['litecoinspace.org/api', false], ['api.blockcypher.com/v1/ltc/main', true]]);
    const health = await Health.probeUtxo(chains.get('LTC'));
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.endpointsUp, 1);
    assert.strictEqual(health.endpoints, 2);
    assert.deepStrictEqual(health.down, ['https://litecoinspace.org/api']);
  });

  test('Bitcoin: two mempool mirrors, then BlockCypher, including a segwit address', async () => {
    deadMirrorsLiveBlockCypher();
    const btc = walletServiceFor('BTC');
    const balance = await btc.getBalance('bc1qshw69ddj08e4e0ndz4qdlfjatqmuwu9uya6h8h');
    assert.strictEqual(balance.status, 'success');
    assert.strictEqual(balance.balanceBTC, 0.00485948);
    const utxos = await btc.fallback.getUtxos('bc1qshw69ddj08e4e0ndz4qdlfjatqmuwu9uya6h8h');
    assert.strictEqual(utxos[0].value, 485948);
    const probe = await btc.probeExplorers();
    assert.deepStrictEqual(probe.map((p) => p.ok), [false, false, true]);
  });

  test('a mirror that answers is used and BlockCypher is not touched', async () => {
    originalFetch = ProxyService.fetch;
    const calls = [];
    ProxyService.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('litecoinspace.org') && String(url).endsWith('/blocks/tip/height')) return { ok: true, status: 200, text: async () => '3181700', json: async () => 3181700 };
      throw new Error('should not be called');
    };
    assert.strictEqual(await walletServiceFor('LTC').getTipHeight(), 3181700);
    assert.ok(calls.every((c) => c.includes('litecoinspace.org')));
  });

  test('the health service records an endpoints event when the set answering changes, without an alert', async () => {
    const AlertService = require('../src/services/AlertService');
    const notified = [];
    const originalNotify = AlertService.notify;
    AlertService.notify = (subject) => notified.push(subject);
    for (const row of db.getAll('chainHealth')) db.delete('chainHealth', row.id);
    for (const row of db.getAll('chainHealthEvents')) db.delete('chainHealthEvents', row.id);
    const service = new Health.ChainHealthService();
    service.thorchain = { inbound: { byChain: new Map(), at: 0 }, pools: { at: 0 }, ready: async () => {}, serves: () => false };
    service._coins = new Map();
    service.dex = { providersFor: () => [] };
    try {
      service.probeRpc = async () => ({ ok: true, endpointsUp: 2, endpoints: 2, tip: 1, latencyMs: 1, error: null, down: [] });
      // Scroll: no cross-chain route to be off, so only the endpoints can change
      await service.checkChain(chains.get('SCROLL'));
      service.probeRpc = async () => ({ ok: true, endpointsUp: 1, endpoints: 2, tip: 2, latencyMs: 1, error: null, down: ['https://litecoinspace.org/api'] });
      const state = await service.checkChain(chains.get('SCROLL'));
      assert.strictEqual(state.status, 'up', 'one explorer answering is still up');
      assert.strictEqual(state.rpc.partial, true);
      const event = db.getAll('chainHealthEvents').find((e) => e.component === 'endpoints');
      assert.ok(event, 'an endpoints event');
      assert.strictEqual(event.from, '2/2');
      assert.strictEqual(event.to, '1/2');
      assert.strictEqual(event.detail, 'not answering: litecoinspace.org/api');
      assert.deepStrictEqual(notified, [], 'no alert for a failover the app handles');
    } finally {
      AlertService.notify = originalNotify;
      for (const row of db.getAll('chainHealth')) db.delete('chainHealth', row.id);
      for (const row of db.getAll('chainHealthEvents')) db.delete('chainHealthEvents', row.id);
    }
  });
});
