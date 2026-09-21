/**
 * The owner panel: the flag, the guard, the API across every merchant,
 * the CLI that grants the flag, and the page.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);
process.env.PLATFORM_FEE_ADDRESS_EVM = '0x1111111111111111111111111111111111111111';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const app = require('../src/app');
const { db } = require('../src/config/database');
const PriceService = require('../src/services/PriceService');
const FeeCollectionService = require('../src/services/FeeCollectionService');
const { requireOwner } = require('../src/middleware/auth');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/\r\n/g, '\n');

let server;
let base;

async function call(method, route, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function register(prefix) {
  const r = await call('POST', '/api/auth/register', { body: { username: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'a-very-long-test-password' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.clientId || r.body.id || r.body.user?.id, username: r.body.username || r.body.user?.username };
}

before(async () => {
  PriceService.ethToUsdRate = 3000;
  PriceService.btcToUsdRate = 60000;
  PriceService.ltcToUsdRate = 80;
  PriceService.solToUsdRate = 150;
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('The guard', () => {
  test('needs the flag and a session: a merchant is refused, an API key is refused, an owner passes', () => {
    const next = (err) => err;
    assert.match(String(requireOwner({ auth: { owner: false, method: 'jwt' } }, {}, next).message), /Owner access required/);
    assert.match(String(requireOwner({ auth: { owner: true, method: 'apiKey' } }, {}, next).message), /signed-in session, not an API key/);
    assert.strictEqual(requireOwner({ auth: { owner: true, method: 'jwt' } }, {}, next), undefined);
    assert.match(String(requireOwner({}, {}, next).message), /Owner access required/);
  });

  test('over HTTP: 401 without a credential, 403 for a merchant, 200 for an owner; verify and me say who is one', async () => {
    const merchant = await register('merchant');
    assert.strictEqual((await call('GET', '/api/owner/overview')).status, 401);
    const refused = await call('GET', '/api/owner/overview', { token: merchant.token });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.message, /Owner access required/);
    const verify = await call('GET', '/api/auth/verify', { token: merchant.token });
    assert.strictEqual(verify.body.owner, false);

    const user = db.findOneBy('users', { id: verify.body.clientId });
    db.update('users', user.id, { owner: true });
    const allowed = await call('GET', '/api/owner/overview', { token: merchant.token });
    assert.strictEqual(allowed.status, 200, 'the flag is read on each request: no new login needed');
    assert.strictEqual((await call('GET', '/api/auth/verify', { token: merchant.token })).body.owner, true);
    assert.strictEqual((await call('GET', '/api/clients/me', { token: merchant.token })).body.owner, true);
  });
});

describe('The API across every merchant', () => {
  let owner;
  let other;
  before(async () => {
    owner = await register('owner');
    other = await register('other');
    const ownerId = (await call('GET', '/api/auth/verify', { token: owner.token })).body.clientId;
    const otherId = (await call('GET', '/api/auth/verify', { token: other.token })).body.clientId;
    owner.id = ownerId; other.id = otherId;
    db.update('users', ownerId, { owner: true });
    // the other merchant's world: a wallet holding a fee, a payout, a paid link, a transfer in flight
    db.create('wallets', { clientId: otherId, chain: 'ETH', address: '0x' + 'a'.repeat(40), balance: 0.5, balanceUSD: 1500, isActive: true, serviceSubtractions: 0.01, serviceSubtractionsTokens: { USDC: 3 }, tokenBalances: { USDC: 10 }, privateKey: 'x', seedPhrase: null, createdAt: new Date().toISOString() });
    db.create('payouts', { clientId: otherId, status: 'COMPLETED', payoutChain: 'ETH', chain: 'ETH', recipientAddress: '0x' + 'b'.repeat(40), totalAmountUsd: 100, netAmountUsd: 94, platformFee: 5, withdrawalPlan: { transfers: [{ status: 'CONFIRMED' }] }, createdAt: new Date().toISOString() });
    db.create('payouts', { clientId: otherId, status: 'PARTIAL', payoutChain: 'BTC', chain: 'BTC', recipientAddress: 'bc1q', totalAmountUsd: 40, netAmountUsd: 37, platformFee: 2, withdrawalPlan: { transfers: [{ status: 'FAILED' }, { status: 'CONFIRMED' }] }, createdAt: new Date(Date.now() - 1000).toISOString() });
    db.create('checkoutSessions', { clientId: otherId, status: 'PAID', chain: 'ETH', asset: 'ETH', usdAmount: 25, nativeAmount: 0.008, reference: 'ORD-1', createdAt: new Date().toISOString(), paidAt: new Date().toISOString(), paidTxHash: '0xpaid' });
    db.create('checkoutSessions', { clientId: otherId, status: 'AWAITING_PAYMENT', chain: 'BTC', asset: 'BTC', usdAmount: 10, nativeAmount: 0.0002, createdAt: new Date().toISOString() });
    db.create('transactions', { clientId: otherId, type: 'DIRECT_TRANSFER', status: 'PROCESSING', chain: 'ETH', nativeAmount: 0.1, usdAmount: 300, transactionHash: '0xinflight', fromAddress: '0x' + 'a'.repeat(40), toAddress: '0x' + 'b'.repeat(40), createdAt: new Date().toISOString() });
    db.create('transactions', { clientId: otherId, type: 'DIRECT_TRANSFER', status: 'FAILED', chain: 'ETH', nativeAmount: 0.1, usdAmount: 300, transactionHash: '0xfailed', fromAddress: '0x' + 'a'.repeat(40), failureReason: 'INSUFFICIENT_FUNDS', createdAt: new Date().toISOString() });
    db.createMany('apiCalls', [{ clientId: otherId, endpoint: '/api/wallets/list', method: 'GET', statusCode: 200, timestamp: new Date().toISOString() }, { clientId: otherId, endpoint: '/api/wallets/list', method: 'GET', statusCode: 500, timestamp: new Date().toISOString() }]);
  });

  test('overview counts the platform, not the caller', async () => {
    const r = await call('GET', '/api/owner/overview', { token: owner.token });
    assert.strictEqual(r.status, 200);
    const d = r.body;
    assert.ok(d.merchants.total >= 2);
    assert.ok(d.merchants.owners >= 1);
    assert.ok(d.wallets.onChainUsd >= 1500 + 10, 'the other merchant\'s coin and tokens');
    assert.ok(d.payouts.total >= 2);
    assert.ok(d.payouts.volumeUsd >= 140);
    assert.ok(d.payouts.feesUsd >= 7);
    assert.ok(d.payouts.byStatus.PARTIAL >= 1);
    assert.ok(d.checkout.paidUsd >= 25);
    assert.ok(d.checkout.open >= 1);
    assert.ok(d.transactions.inFlight >= 1);
    assert.ok(d.transactions.failedLast7d >= 1);
    assert.ok(d.fees.heldUsd >= 30 + 3, 'held: 0.01 ETH at $3000 plus 3 USDC');
    assert.strictEqual(d.fees.configured, true);
    assert.ok(d.usage.last24h >= 2);
    assert.ok(d.usage.errorsLast24h >= 1);
    assert.ok(Array.isArray(d.latest.payouts) && d.latest.payouts[0].username);
    assert.ok('counts' in d.chains);
  });

  test('merchants: every account with its figures, searchable; one merchant in full, keys redacted', async () => {
    const list = await call('GET', '/api/owner/merchants', { token: owner.token });
    assert.strictEqual(list.status, 200);
    const row = list.body.merchants.find((m) => m.id === other.id);
    assert.ok(row, 'the other merchant is listed');
    assert.strictEqual(row.wallets, 1);
    assert.strictEqual(row.onChainUsd, 1510);
    assert.strictEqual(row.feesHeldUsd, 33);
    assert.strictEqual(row.payouts, 2);
    assert.strictEqual(row.payoutVolumeUsd, 140);
    assert.strictEqual(row.paidSessions, 1);
    assert.ok(!('passwordHash' in row) && !('apiKeyHash' in row), 'no hashes');
    const searched = await call('GET', `/api/owner/merchants?q=${encodeURIComponent(other.id.slice(0, 8))}`, { token: owner.token });
    assert.deepStrictEqual(searched.body.merchants.map((m) => m.id), [other.id]);

    const one = await call('GET', `/api/owner/merchants/${other.id}`, { token: owner.token });
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.wallets.length, 1);
    assert.ok(!('privateKey' in one.body.wallets[0]) && !('seedPhrase' in one.body.wallets[0]), 'never the keys');
    assert.strictEqual(one.body.wallets[0].platformFeeHeld, 0.01);
    assert.deepStrictEqual(one.body.wallets[0].platformFeeHeldTokens, { USDC: 3 });
    assert.strictEqual(one.body.payouts.length, 2);
    assert.strictEqual(one.body.sessions.length, 2);
    assert.strictEqual(one.body.transactions.length, 2);
    assert.strictEqual(one.body.usage.total, 2);
    assert.strictEqual((await call('GET', '/api/owner/merchants/nope', { token: owner.token })).status, 404);
  });

  test('payouts, transactions and sessions list across merchants, filtered by status', async () => {
    const partial = await call('GET', '/api/owner/payouts?status=partial', { token: owner.token });
    assert.ok(partial.body.payouts.length >= 1 && partial.body.payouts.every((p) => p.status === 'PARTIAL'));
    assert.strictEqual(partial.body.payouts[0].username, other.username);
    assert.deepStrictEqual(partial.body.payouts[0].transfersByStatus, { FAILED: 1, CONFIRMED: 1 });

    const inflight = await call('GET', '/api/owner/transactions', { token: owner.token });
    assert.ok(inflight.body.transactions.some((t) => t.transactionHash === '0xinflight'));
    assert.ok(!inflight.body.transactions.some((t) => t.transactionHash === '0xfailed'), 'in flight by default');
    const failed = await call('GET', '/api/owner/transactions?status=FAILED', { token: owner.token });
    assert.ok(failed.body.transactions.some((t) => t.transactionHash === '0xfailed' && t.failureReason === 'INSUFFICIENT_FUNDS'));

    const paid = await call('GET', '/api/owner/sessions?status=PAID', { token: owner.token });
    assert.ok(paid.body.sessions.some((s) => s.reference === 'ORD-1' && s.username === other.username));
  });

  test('fees: the book with merchant names; plan and reconcile through the API; collect is a real sweep', async () => {
    const book = await call('GET', '/api/owner/fees', { token: owner.token });
    assert.strictEqual(book.status, 200);
    assert.ok(book.body.held.rows.some((r) => r.username === other.username && r.asset === 'USDC' && r.held === 3));
    assert.strictEqual(book.body.addresses.EVM, '0x1111111111111111111111111111111111111111');

    const plan = await call('POST', '/api/owner/fees/plan', { token: owner.token, body: { chain: 'ETH' } });
    assert.strictEqual(plan.status, 200);
    assert.ok(Array.isArray(plan.body.planned) && Array.isArray(plan.body.skipped));
    assert.ok(plan.body.skipped.some((s) => /in flight/.test(s.reason)), 'that wallet has a transfer in flight');
    assert.strictEqual((await call('POST', '/api/owner/fees/plan', { token: owner.token, body: { chain: 'NOPE' } })).status, 400);

    const originalCollect = FeeCollectionService.collect;
    let seen = null;
    FeeCollectionService.collect = async (options) => { seen = options; return { collected: [{ id: 'c1' }], failed: [], skipped: [] }; };
    try {
      const collect = await call('POST', '/api/owner/fees/collect', { token: owner.token, body: {} });
      assert.strictEqual(collect.status, 200);
      assert.deepStrictEqual(seen, { chain: null });
      assert.strictEqual(collect.body.collected.length, 1);
    } finally {
      FeeCollectionService.collect = originalCollect;
    }

    const reconcile = await call('POST', '/api/owner/fees/reconcile', { token: owner.token });
    assert.strictEqual(reconcile.status, 200);
    assert.strictEqual(typeof reconcile.body.changed, 'number');
  });

  test('overview carries the trend, the deltas, the stuck transfers and the float', async () => {
    const r = await call('GET', '/api/owner/overview', { token: owner.token });
    const d = r.body;
    assert.strictEqual(d.trend.length, 30);
    const today = d.trend[d.trend.length - 1];
    assert.ok(today.withdrawnUsd >= 100 && today.feesUsd >= 5 && today.paidInUsd >= 25, JSON.stringify(today));
    assert.ok('previous30d' in d.payouts && 'previous30d' in d.checkout);
    assert.ok(Array.isArray(d.transactions.stuck));
    assert.ok('enabled' in d.gasFloat);
    assert.strictEqual(typeof d.server.errorsLastHour, 'number');
    assert.ok('nextRunAt' in d.fees);
  });

  test('payouts carry their legs; transfers carry age and whether they are past the usual time', async () => {
    const list = await call('GET', '/api/owner/payouts?status=PARTIAL', { token: owner.token });
    const p = list.body.payouts.find((x) => x.clientId === other.id);
    assert.deepStrictEqual(p.legs.map((l) => l.status), ['FAILED', 'CONFIRMED']);
    assert.ok('route' in p.legs[0] && 'txHash' in p.legs[0] && 'platformFeeUSD' in p.legs[0]);

    // an old in-flight transfer on Bitcoin: past the usual hour
    db.create('transactions', { clientId: other.id, type: 'DIRECT_TRANSFER', status: 'PROCESSING', chain: 'BTC', nativeAmount: 0.001, usdAmount: 60, transactionHash: 'oldbtc', fromAddress: 'bc1qold', orderId: 'direct_transfer_old', createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
    const inflight = await call('GET', '/api/owner/transactions', { token: owner.token });
    const old = inflight.body.transactions.find((t) => t.transactionHash === 'oldbtc');
    assert.ok(old.ageSeconds >= 5 * 3600 - 5);
    assert.ok(old.usualSeconds >= 600);
    assert.strictEqual(old.stuck, true);
    const fresh = inflight.body.transactions.find((t) => t.transactionHash === '0xinflight');
    assert.strictEqual(fresh.stuck, false);
  });

  test('a transfer can be re-checked on demand, one or all', async () => {
    const PayoutService = require('../src/services/PayoutService');
    const original = PayoutService.reconcileTransaction;
    const seen = [];
    PayoutService.reconcileTransaction = async (t) => { seen.push(t.transactionHash); return 'pending'; };
    try {
      const tx = db.findOneBy('transactions', { transactionHash: '0xinflight' });
      const one = await call('POST', `/api/owner/transactions/${tx.id}/recheck`, { token: owner.token });
      assert.strictEqual(one.status, 200);
      assert.strictEqual(one.body.outcome, 'pending');
      assert.strictEqual(one.body.transaction.id, tx.id);
      assert.deepStrictEqual(seen, ['0xinflight']);
      const done = db.findOneBy('transactions', { transactionHash: '0xfailed' });
      const settled = await call('POST', `/api/owner/transactions/${done.id}/recheck`, { token: owner.token });
      assert.strictEqual(settled.body.outcome, 'failed', 'a settled transfer is not asked again');
      assert.strictEqual((await call('POST', '/api/owner/transactions/nope/recheck', { token: owner.token })).status, 404);
      const all = await call('POST', '/api/owner/transactions/recheck', { token: owner.token });
      assert.strictEqual(all.status, 200);
      assert.strictEqual(typeof all.body.resolved, 'number');
      assert.ok(seen.length >= 2, 'every in-flight transfer was asked');
    } finally {
      PayoutService.reconcileTransaction = original;
    }
  });

  test('search finds every kind that carries the term', async () => {
    const byHash = await call('GET', '/api/owner/search?q=0xINFLIGHT', { token: owner.token });
    assert.strictEqual(byHash.status, 200);
    assert.strictEqual(byHash.body.transactions.length, 1, 'a hash matches whole, case aside');
    const byAddress = await call('GET', `/api/owner/search?q=${'0x' + 'a'.repeat(40)}`, { token: owner.token });
    assert.strictEqual(byAddress.body.wallets.length, 1);
    assert.ok(byAddress.body.transactions.length >= 2, 'the transfers from that address');
    assert.ok(!('privateKey' in byAddress.body.wallets[0]));
    const byRef = await call('GET', '/api/owner/search?q=ord-1', { token: owner.token });
    assert.strictEqual(byRef.body.sessions.length, 1);
    const byName = await call('GET', `/api/owner/search?q=${other.username.slice(0, 6)}`, { token: owner.token });
    assert.ok(byName.body.merchants.some((m) => m.id === other.id));
    const byRecipient = await call('GET', `/api/owner/search?q=${'0x' + 'b'.repeat(40)}`, { token: owner.token });
    assert.ok(byRecipient.body.payouts.length >= 1);
    assert.strictEqual((await call('GET', '/api/owner/search?q=ab', { token: owner.token })).status, 400, 'too short');
  });

  test('the log tail, the snapshot and the chain check are the operator\'s', async () => {
    const logger = require('../src/services/logger');
    logger.warn('[Test] a warning the panel should show apikey=SECRET123 ok');
    const logs = await call('GET', '/api/owner/logs?lines=50', { token: owner.token });
    assert.strictEqual(logs.status, 200);
    assert.ok(logs.body.lines.length >= 1);
    assert.strictEqual(logs.body.lines[0].level, 'warn');
    assert.match(logs.body.lines[0].message, /apikey=\[redacted\]/);
    assert.ok(!logs.body.lines[0].message.includes('SECRET123'));
    assert.strictEqual(typeof logs.body.errorsLastHour, 'number');

    const snap = await call('POST', '/api/owner/server/snapshot', { token: owner.token });
    assert.strictEqual(snap.status, 200);
    assert.match(snap.body.file, /^database-.*\.sqlite$/);

    const ChainHealthService = require('../src/services/ChainHealthService');
    const originalRun = ChainHealthService.runOnce;
    let ran = 0;
    ChainHealthService.runOnce = async () => { ran += 1; };
    try {
      const check = await call('POST', '/api/owner/chains/check', { token: owner.token });
      assert.strictEqual(check.status, 200);
      assert.strictEqual(ran, 1);
      assert.ok(Array.isArray(check.body.chains));
    } finally {
      ChainHealthService.runOnce = originalRun;
    }
    const srv = await call('GET', '/api/owner/server', { token: owner.token });
    assert.ok('commit' in srv.body && 'errorsLastHour' in srv.body);
  });

  test('usage, chains and server describe the platform without secrets', async () => {
    const usage = await call('GET', '/api/owner/usage?period=day', { token: owner.token });
    assert.strictEqual(usage.body.labels.length, 24);
    assert.strictEqual(usage.body.values.length, 24);
    assert.ok(usage.body.total >= 2);
    assert.ok(usage.body.topMerchants.some((m) => m.username === other.username));
    assert.ok(usage.body.topEndpoints.some((e) => e.endpoint === 'GET /api/wallets/list'));
    const week = await call('GET', '/api/owner/usage?period=week', { token: owner.token });
    assert.strictEqual(week.body.labels.length, 7);

    const chains = await call('GET', '/api/owner/chains', { token: owner.token });
    assert.ok(Array.isArray(chains.body.chains) && chains.body.chains.length > 60);

    const srv = await call('GET', '/api/owner/server', { token: owner.token });
    assert.strictEqual(srv.status, 200);
    assert.strictEqual(srv.body.node, process.version);
    assert.strictEqual(typeof srv.body.uptimeSeconds, 'number');
    assert.strictEqual(srv.body.database.file, 'database.sqlite');
    assert.strictEqual(srv.body.set.platformFeeRate, 0.05);
    assert.strictEqual(typeof srv.body.set.etherscanKey, 'boolean');
    assert.strictEqual(srv.body.feeAddresses.EVM, '0x1111111111111111111111111111111111111111');
    const text = JSON.stringify(srv.body);
    for (const secret of [process.env.JWT_SECRET, process.env.KEY_ENCRYPTION_KEY]) assert.ok(!text.includes(secret), 'no secret in the body');
  });
});

describe('The CLI and the page', () => {
  test('scripts/owner.js grants, lists and revokes on the record', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'etheroute-owner-'));
    const env = { ...process.env, DATA_DIR: dir };
    const run = (...args) => execFileSync(process.execPath, ['scripts/owner.js', ...args], { cwd: ROOT, encoding: 'utf-8', env, timeout: 30000 });
    execFileSync(process.execPath, ['-e', "require('./src/config/database').db.create('users', { id: 'u1', username: 'ann' })"], { cwd: ROOT, env });
    assert.match(run('list'), /No owners/);
    assert.match(run('grant', 'ann'), /ann is now an owner/);
    assert.match(run('list'), /ann/);
    assert.match(run('grant', 'ann'), /already an owner/);
    assert.match(run('revoke', 'ann'), /no longer an owner/);
    assert.match(run('list'), /No owners/);
    try {
      run('grant', 'nobody');
      assert.fail('an unknown name is an error');
    } catch (error) {
      assert.match(String(error.stdout || ''), /No account named nobody/);
    }
  });

  test('the page is routed, wears the dashboard chrome, and names every handler it uses', () => {
    const appSource = read('src/app.js');
    assert.ok(appSource.includes("'/owner': 'owner.html'"));
    assert.ok(appSource.includes("app.use('/api/owner', requireAuth, clientLimiter, ownerRoutes);"));
    const html = read('public/owner.html');
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(html.includes('/css/dashboard.css') && html.includes('/css/owner.css'));
    assert.ok(html.includes('/js/common/actions.js') && html.includes('/js/owner.js'));
    assert.ok(!/on(click|submit|input)=/.test(html), 'no inline handlers: the CSP forbids them');
    const js = read('public/js/owner.js');
    const handlers = [...html.matchAll(/data-on-(?:click|input)="([a-zA-Z]+)"/g)].map((m) => m[1]);
    for (const name of new Set(handlers)) {
      if (name === 'cycleTheme' || name === 'navigateTo') continue;
      assert.ok(new RegExp(`function ${name}\\(`).test(js), `${name} is defined`);
      assert.ok(js.includes(name), `${name} is exposed`);
    }
    for (const id of ['ovVolume', 'ovChart', 'ovAttention', 'ownerSearch', 'searchResults', 'merchantRows', 'mWalletRows', 'payoutRows', 'txRows', 'recheckAllBtn', 'sessionRows', 'feeHeldRows', 'feePlanOut', 'feeNext', 'usageChart', 'chainRows', 'chainChips', 'checkChainsBtn', 'serverConfig', 'serverLog', 'snapshotBtn', 'notOwner']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(html.includes('data-on-submit="submitSearch"'));
    for (const name of ['submitSearch', 'togglePayout', 'recheckOne', 'recheckAll', 'filterChains', 'checkChainsNow', 'snapshotNow', 'drawFlowChart', 'legsHtml', 'ticksHtml']) assert.ok(new RegExp(`function ${name}\\(`).test(js), name);
    assert.ok(js.includes("e.key !== '/'"), 'slash focuses the search');
    assert.ok(js.includes('is-stuck'), 'age past the usual time is marked');
    assert.ok(js.includes("api('/owner/overview')") && js.includes("api('/owner/fees/collect'") && js.includes('window.confirm('), 'a sweep asks first');
    // the dashboard shows the way in to owners alone
    const dash = read('public/dashboard.html');
    assert.ok(dash.includes('id="ownerLink" href="/owner"') && dash.includes('hidden>'));
    assert.ok(read('public/js/dashboard.js').includes('if (ownerLink && identity && identity.owner) ownerLink.hidden = false;'));
    assert.ok(read('public/css/dashboard.css').includes('.rail .nav-link[hidden] { display: none; }'), 'hidden wins over the flex rail link');
  });
});
