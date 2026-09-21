/**
 * Closing a wallet: refused while the merchant could still withdraw from
 * it, otherwise what is left is the platform's - booked as held, emptied
 * by the fee sweep with no dollar floor, and said so to the merchant.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../src/app');
const { db } = require('../src/config/database');
const PriceService = require('../src/services/PriceService');
const GasEstimator = require('../src/services/GasEstimator');
const BalanceWatcher = require('../src/services/BalanceWatcher');
const KeyVault = require('../src/services/crypto/KeyVault');
const { FeeCollectionService } = require('../src/services/FeeCollectionService');
const PayoutService = require('../src/services/PayoutService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');
const KEY = '1111111111111111111111111111111111111111111111111111111111111111';
const EVM_FEE = '0x1111111111111111111111111111111111111111';

let server;
let base;
let token;
let clientId;
let originalEstimate;
let originalRefresh;

async function call(method, route, body) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const sealed = (fields) => db.create('wallets', KeyVault.sealWallet({ clientId, isActive: true, privateKey: KEY, seedPhrase: null, createdAt: new Date().toISOString(), ...fields }));

before(async () => {
  PriceService.ethToUsdRate = 3000;
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  const r = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `closer_${Date.now()}`, password: 'a-very-long-test-password' }) });
  const body = await r.json();
  token = body.token;
  clientId = body.clientId;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  originalEstimate = GasEstimator.estimate;
  originalRefresh = BalanceWatcher.updateWalletBalance;
  GasEstimator.clear();
  // a plain ETH send costs $0.30; the withdrawal minimum is about $0.63
  GasEstimator.estimate = async () => ({ native: 0.0001, usd: 0.3, live: true });
  // the chain read: the record already says what is there
  BalanceWatcher.updateWalletBalance = async () => ({ status: 'success' });
});
afterEach(() => {
  GasEstimator.estimate = originalEstimate;
  BalanceWatcher.updateWalletBalance = originalRefresh;
  GasEstimator.clear();
});

describe('Closing', () => {
  test('is refused while the wallet holds coin the merchant can withdraw, and says how much', async () => {
    const w = sealed({ chain: 'ETH', address: '0x' + '1'.repeat(40), balance: 0.01, serviceSubtractions: 0.0005 });
    const r = await call('DELETE', '/api/wallets/delete', { walletId: w.id });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.message, /still holds 0\.009500 ETH \(\$28\.50\) you can withdraw/);
    assert.strictEqual(db.getById('wallets', w.id).isActive, true, 'untouched');
  });

  test('is refused while it holds a token the merchant can withdraw', async () => {
    const w = sealed({ chain: 'ETH', address: '0x' + '2'.repeat(40), balance: 0.0001, tokenBalances: { USDC: 20 }, serviceSubtractionsTokens: { USDC: 1 } });
    const r = await call('DELETE', '/api/wallets/delete', { walletId: w.id });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.message, /still holds 19\.00 USDC you can withdraw/);
  });

  test('is refused with a transfer in flight, and again once closed', async () => {
    const w = sealed({ chain: 'ETH', address: '0x' + '3'.repeat(40), balance: 0 });
    db.create('transactions', { clientId, fromAddress: w.address, status: 'PROCESSING', chain: 'ETH' });
    assert.strictEqual((await call('DELETE', '/api/wallets/delete', { walletId: w.id })).status, 409);
    for (const t of db.findBy('transactions', { fromAddress: w.address })) db.delete('transactions', t.id);
    assert.strictEqual((await call('DELETE', '/api/wallets/delete', { walletId: w.id })).status, 200);
    const again = await call('DELETE', '/api/wallets/delete', { walletId: w.id });
    assert.strictEqual(again.status, 409);
    assert.match(again.body.message, /already closed/);
  });

  test('takes what is left when nothing withdrawable remains: the held fee, the dust, the token crumbs - and says so', async () => {
    // 0.00034 ETH of which 0.0003 is the held fee: $0.12 available, under the $0.63 minimum
    const w = sealed({ chain: 'ETH', address: '0x' + '4'.repeat(40), balance: 0.00034, serviceSubtractions: 0.0003, tokenBalances: { USDC: 0.28, USDT: 0 }, serviceSubtractionsTokens: { USDC: 0.28 } });
    const r = await call('DELETE', '/api/wallets/delete', { walletId: w.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /Wallet closed\. 0\.00034 ETH and 0\.28 USDC left at the address is retained by the platform\./);
    assert.deepStrictEqual(r.body.forfeited, { coin: { asset: 'ETH', amount: 0.00034, usd: 1.02 }, tokens: [{ asset: 'USDC', amount: 0.28, usd: 0.28 }], usd: 1.3 });

    const closed = db.getById('wallets', w.id);
    assert.strictEqual(closed.isActive, false);
    assert.ok(closed.closedAt);
    assert.strictEqual(closed.closedBy, 'merchant');
    assert.deepStrictEqual(closed.forfeited, { coin: 0.00034, tokens: { USDC: 0.28 } });
    assert.strictEqual(closed.serviceSubtractions, 0.00034, 'the whole balance is now the platform\'s');
    assert.deepStrictEqual(closed.serviceSubtractionsTokens, { USDC: 0.28 });
    assert.ok(closed.privateKey, 'the key stays: the funds are reachable');

    // gone from the merchant's list; the owner still sees it, marked closed
    const list = await call('GET', '/api/wallets/list');
    assert.ok(!list.body.some((x) => x.id === w.id));
  });

  test('an empty wallet closes with nothing to say', async () => {
    const w = sealed({ chain: 'ETH', address: '0x' + '5'.repeat(40), balance: 0 });
    const r = await call('DELETE', '/api/wallets/delete', { walletId: w.id });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.message, 'Wallet closed.');
    assert.strictEqual(r.body.forfeited.usd, 0);
  });
});

describe('The sweep empties closed wallets', () => {
  let svc;
  let sent;
  let originalSend;
  beforeEach(() => {
    svc = new FeeCollectionService({ PLATFORM_FEE_ADDRESS_EVM: EVM_FEE });
    sent = [];
    originalSend = PayoutService.sendTransfer;
    PayoutService.sendTransfer = async (chain, wallet, to, amount, asset) => { sent.push({ chain, from: wallet.address, to, amount, asset }); return `0xhash${sent.length}`; };
  });
  afterEach(() => { PayoutService.sendTransfer = originalSend; });

  test('a closed wallet is listed as held, and swept with no dollar floor once it beats twice the gas; an open one with the same crumbs waits', async () => {
    for (const w of db.getAll('wallets')) db.delete('wallets', w.id);
    // $1.80 of ETH in a closed wallet: $1.35 after the reserve, over 2x the $0.30 gas, under the $10 floor an open wallet needs
    const closed = sealed({ chain: 'ETH', address: '0x' + '6'.repeat(40), balance: 0.0006, serviceSubtractions: 0.0006, closedAt: new Date().toISOString(), isActive: false, tokenBalances: { USDC: 0.28 }, serviceSubtractionsTokens: { USDC: 0.28 } });
    const open = sealed({ chain: 'ETH', address: '0x' + '7'.repeat(40), balance: 0.0006, serviceSubtractions: 0.0006 });

    const held = svc.held();
    assert.deepStrictEqual(held.map((r) => [r.address.slice(2, 3), r.asset, r.closed]), [['6', 'ETH', true], ['6', 'USDC', true], ['7', 'ETH', false]]);

    const { planned, skipped } = await svc.collect({ dryRun: true });
    assert.deepStrictEqual(planned.map((c) => [c.address.slice(2, 3), c.asset, c.amount]), [['6', 'ETH', 0.00045]], 'the coin, less the gas reserve');
    const why = Object.fromEntries(skipped.map((s) => [`${s.address.slice(2, 3)}:${s.asset}`, s.reason]));
    assert.match(why['6:USDC'], /\$0\.28 is under 2x the \$0\.90 gas \(closed wallet\)/, 'the crumbs of USDC are not worth a token transfer');
    assert.match(why['7:ETH'], /under the \$10 minimum/, 'an open wallet keeps the floor');

    const result = await svc.collect();
    assert.strictEqual(result.collected.length, 1);
    assert.strictEqual(result.collected[0].via, 'closure');
    assert.deepStrictEqual(sent, [{ chain: 'ETH', from: closed.address, to: EVM_FEE, amount: 0.00045, asset: 'ETH' }]);
    assert.ok(Math.abs(db.getById('wallets', closed.id).serviceSubtractions - 0.00015) < 1e-9, 'the reserve is what remains held');
    assert.strictEqual(db.getById('wallets', open.id).serviceSubtractions, 0.0006, 'untouched');
  });

  test('a deposit that lands after the close is the platform\'s too', async () => {
    for (const w of db.getAll('wallets')) db.delete('wallets', w.id);
    const closed = sealed({ chain: 'ETH', address: '0x' + '8'.repeat(40), balance: 0.02, serviceSubtractions: 0.0001, closedAt: new Date().toISOString(), isActive: false });
    const { planned } = await svc.collect({ dryRun: true });
    assert.deepStrictEqual(planned.map((c) => [c.asset, c.amount]), [['ETH', 0.02 - 0.00015]], 'the whole balance, not the figure from the close');
    assert.strictEqual(db.getById('wallets', closed.id).id, closed.id);
  });

  test('an address key under the prefix that names no family is flagged', () => {
    const s = new FeeCollectionService({ PLATFORM_FEE_ADDRESS_: '0x1', PLATFORM_FEE_ADDRESS_ETH: '0x2', PLATFORM_FEE_ADDRESS_EVM: EVM_FEE, PLATFORM_FEE_ADDRESS_BTC: '' });
    assert.deepStrictEqual(s.unknownAddressKeys(), ['PLATFORM_FEE_ADDRESS_', 'PLATFORM_FEE_ADDRESS_ETH']);
    assert.ok(read('src/services/FeeCollectionService.js').includes('names no family and is ignored'));
  });
});

describe('What the merchant is told', () => {
  test('the dialog says what stays behind and calls it a close; the terms and the reference say the same', () => {
    const js = read('public/js/dashboard.js');
    assert.ok(js.includes('function closingRemainder(w)'));
    assert.ok(js.includes('is kept by Etheroute.'));
    assert.ok(js.includes("title: `Close this ${chain} wallet?`"));
    assert.ok(js.includes("confirmText: 'Close wallet'"));
    assert.ok(!js.includes('Anything already in it is swept out first'), 'the old, untrue line');
    const terms = read('public/terms.html');
    assert.ok(terms.includes('<h3>5.4 Closing a Wallet</h3>'));
    assert.ok(terms.includes('is retained by Etheroute'));
    const spec = read('public/js/api-spec.js');
    assert.ok(spec.includes("summary: 'Close a wallet'") && spec.includes('forfeited'));
  });
});
