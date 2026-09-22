/**
 * Merchants on Telegram, the API's side: the link code the dashboard
 * mints and the bot brings back, the secret that guards the bot's
 * endpoints, what a merchant hears about and when, the numbers /stats
 * reads, and the two routers - against the real app on a spare port,
 * with a stand-in for the Bot API.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);
process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
process.env.TELEGRAM_BOT_USERNAME = 'etheroute_bot';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const { db } = require('../src/config/database');
const Telegram = require('../src/services/TelegramNotifyService');
const merchantBot = require('../telegram/lib/merchant');

let server;
let base;
const sent = [];
Telegram._setFetch(async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  sent.push({ url: String(url), body });
  if (body && body.chat_id === 666) return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
});

async function call(method, route, { token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const response = await fetch(base + route, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function register(prefix) {
  const r = await call('POST', '/api/auth/register', { body: { username: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'a-very-long-test-password' } });
  const id = (await call('GET', '/api/auth/verify', { token: r.body.token })).body.clientId;
  return { token: r.body.token, id, username: db.getById('users', id).username };
}

const secret = Telegram.internalSecret();
const internal = (method, route, body) => call(method, `/api/telegram/internal${route}`, { body, headers: { 'x-internal-secret': secret } });

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('The secret', () => {
  test('is derived from the token the same way on both sides, and compared in constant time', () => {
    assert.strictEqual(Telegram.internalSecret(), merchantBot.internalSecret(process.env.TELEGRAM_BOT_TOKEN), 'the bot computes the same one');
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.strictEqual(Telegram.isInternal(secret), true);
    assert.strictEqual(Telegram.isInternal(`${secret.slice(0, 63)}0`), secret.endsWith('0'));
    assert.strictEqual(Telegram.isInternal(''), false);
    assert.strictEqual(Telegram.isInternal(process.env.TELEGRAM_BOT_TOKEN), false, 'the token itself is not the secret');
    assert.strictEqual(Telegram.internalSecret(''), '');
  });

  test('guards every internal endpoint', async () => {
    assert.strictEqual((await call('GET', '/api/telegram/internal/account?chatId=1')).status, 401);
    assert.strictEqual((await call('GET', '/api/telegram/internal/account?chatId=1', { headers: { 'x-internal-secret': 'nope' } })).status, 401);
    assert.strictEqual((await call('POST', '/api/telegram/internal/link', { body: { code: 'X', chatId: 1 } })).status, 401);
    assert.strictEqual((await internal('GET', '/account?chatId=1')).status, 404, 'with it: through, to "nobody is linked"');
  });
});

describe('The link', () => {
  test('the dashboard mints a code with the deep link; the bot brings it back; the account and the chat are bound', async () => {
    const m = await register('tg');
    const before = await call('GET', '/api/telegram', { token: m.token });
    assert.strictEqual(before.body.linked, false);
    assert.strictEqual(before.body.enabled, true);
    assert.strictEqual(before.body.botUsername, 'etheroute_bot');
    assert.deepStrictEqual(before.body.prefs, { paid: true, payouts: true });

    const minted = await call('POST', '/api/telegram/link-code', { token: m.token });
    assert.strictEqual(minted.status, 200);
    assert.match(minted.body.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/, 'readable letters only');
    assert.strictEqual(minted.body.url, `https://t.me/etheroute_bot?start=link_${minted.body.code}`);
    assert.ok(new Date(minted.body.expiresAt).getTime() - Date.now() > 9 * 60000);

    const again = await call('POST', '/api/telegram/link-code', { token: m.token });
    assert.notStrictEqual(again.body.code, minted.body.code);
    const stale = await internal('POST', '/link', { code: minted.body.code, chatId: 5001 });
    assert.strictEqual(stale.status, 404, 'a newer code replaces the old one');

    const wrong = await internal('POST', '/link', { code: 'NOPE1234', chatId: 5001 });
    assert.strictEqual(wrong.status, 404);
    assert.ok(wrong.body.message.includes('not one I gave out'));
    const bad = await internal('POST', '/link', { code: again.body.code, chatId: 'abc' });
    assert.strictEqual(bad.status, 400);

    const linked = await internal('POST', '/link', { code: again.body.code.toLowerCase(), chatId: 5001, username: 'merch', firstName: 'Merch' });
    assert.strictEqual(linked.status, 200);
    assert.strictEqual(linked.body.account.username, m.username);
    assert.strictEqual(linked.body.account.linked, true);
    assert.strictEqual(linked.body.account.chatId, 5001);
    assert.strictEqual((await internal('POST', '/link', { code: again.body.code, chatId: 5001 })).status, 404, 'a code is spent once');

    const after = await call('GET', '/api/telegram', { token: m.token });
    assert.strictEqual(after.body.linked, true);
    assert.strictEqual(after.body.telegramUsername, 'merch');
    const who = await internal('GET', '/account?chatId=5001');
    assert.strictEqual(who.body.account.clientId, m.id);

    // preferences from either side
    const prefs = await call('PUT', '/api/telegram/preferences', { token: m.token, body: { payouts: false, nonsense: true, paid: 'yes' } });
    assert.deepStrictEqual(prefs.body.prefs, { paid: true, payouts: false }, 'only booleans of known keys');
    const fromBot = await internal('PUT', '/preferences', { chatId: 5001, prefs: { paid: false } });
    assert.deepStrictEqual(fromBot.body.account.prefs, { paid: false, payouts: false });

    // a second account linking the same chat takes it over
    const other = await register('tg2');
    const code2 = (await call('POST', '/api/telegram/link-code', { token: other.token })).body.code;
    await internal('POST', '/link', { code: code2, chatId: 5001 });
    assert.strictEqual((await call('GET', '/api/telegram', { token: m.token })).body.linked, false, 'the first account lost the chat');
    assert.strictEqual((await internal('GET', '/account?chatId=5001')).body.account.clientId, other.id);

    // unlink from the dashboard, and from the bot
    assert.strictEqual((await call('DELETE', '/api/telegram/link', { token: other.token })).body.unlinked, true);
    assert.strictEqual((await call('DELETE', '/api/telegram/link', { token: other.token })).body.unlinked, false);
    const code3 = (await call('POST', '/api/telegram/link-code', { token: other.token })).body.code;
    await internal('POST', '/link', { code: code3, chatId: 5002 });
    assert.strictEqual((await internal('POST', '/unlink', { chatId: 5002 })).body.unlinked, 1);
    assert.strictEqual((await internal('GET', '/account?chatId=5002')).status, 404);
    assert.strictEqual((await call('PUT', '/api/telegram/preferences', { token: other.token, body: { paid: false } })).status, 409, 'no link: nothing to set');
  });

  test('an expired code is refused and said so', () => {
    const m = { id: 'expired-user' };
    db.create('users', { id: m.id, username: 'expired', passwordHash: 'x', createdAt: new Date().toISOString() });
    db.create('telegramLinkCodes', { id: 'OLDCODE2', clientId: m.id, expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString() });
    const r = Telegram.consumeLinkCode('OLDCODE2', { chatId: 7 });
    assert.strictEqual(r.error, 'expired');
    assert.ok(r.message.includes('ten minutes'));
    assert.strictEqual(db.getById('telegramLinkCodes', 'OLDCODE2'), null, 'and dropped');
  });
});

describe('What a merchant hears about', () => {
  test('a settled checkout and a finished payout reach the linked chat as HTML; preferences and no link keep quiet; a block unlinks', async () => {
    const m = await register('tg3');
    const code = (await call('POST', '/api/telegram/link-code', { token: m.token })).body.code;
    await internal('POST', '/link', { code, chatId: 5003 });
    sent.length = 0;

    const session = { id: 'sess-1', clientId: m.id, chain: 'ETH', asset: 'ETH', nativeAmount: 0.5, usdAmount: 1246.22, reference: 'ORD-<9>' };
    assert.strictEqual(await Telegram.notifyPayment(session, { asset: 'ETH', amount: 0.5, txHash: '0x' + 'ab'.repeat(32), usdAmount: 1246.22, underpaid: false }), true);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].url.endsWith('/sendMessage'));
    assert.strictEqual(sent[0].body.chat_id, 5003);
    assert.strictEqual(sent[0].body.parse_mode, 'HTML');
    assert.ok(sent[0].body.text.startsWith('💸 <b>Payment received</b>\n<b>0.5 ETH</b> ($1,246.22) on ETH'));
    assert.ok(sent[0].body.text.includes('Reference: ORD-&lt;9&gt;'), 'escaped');
    assert.ok(sent[0].body.text.includes('<code>0xababab…ababab</code>') && sent[0].body.text.includes('<code>sess-1</code>'));

    assert.strictEqual(await Telegram.notifyPayment(session, { asset: 'ETH', amount: 0.3, usdAmount: 700, underpaid: true }), true);
    assert.ok(sent[1].body.text.startsWith('⚠️ <b>Payment received - short</b>') && sent[1].body.text.includes('Asked: 0.5 ETH ($1,246.22)'));

    const payout = { id: 'po-1', clientId: m.id, status: 'COMPLETED', totalAmountUsd: 100, payoutChain: 'BASE', payoutAsset: 'USDC', recipientAddress: '0x' + 'cd'.repeat(20) };
    assert.strictEqual(await Telegram.notifyPayout(payout), true);
    assert.ok(sent[2].body.text.startsWith('✅ <b>Payout completed</b>\n$100.00 as USDC on BASE'));
    assert.strictEqual(await Telegram.notifyPayout({ ...payout, status: 'FAILED' }), true);
    assert.ok(sent[3].body.text.startsWith('⛔ <b>Payout failed</b>'));

    await internal('PUT', '/preferences', { chatId: 5003, prefs: { paid: false } });
    assert.strictEqual(await Telegram.notifyPayment(session, { asset: 'ETH', amount: 1 }), false, 'switched off');
    assert.strictEqual(await Telegram.notifyPayout(payout), true, 'payouts still on');
    assert.strictEqual(await Telegram.notifyPayment({ ...session, clientId: 'nobody' }, { asset: 'ETH', amount: 1 }), false, 'no such merchant');
    assert.strictEqual(await Telegram.notifyPayment(null, {}), false);

    // the bot was blocked: Telegram says 403, the link is dropped
    const blocked = await register('tg4');
    const code2 = (await call('POST', '/api/telegram/link-code', { token: blocked.token })).body.code;
    await internal('POST', '/link', { code: code2, chatId: 666 });
    assert.strictEqual(await Telegram.notifyPayout({ ...payout, clientId: blocked.id }), false);
    assert.strictEqual((await call('GET', '/api/telegram', { token: blocked.token })).body.linked, false);
  });

  test('without a token nothing is sent and the endpoints say so', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '';
    try {
      assert.strictEqual(Telegram.enabled(), false);
      assert.strictEqual(await Telegram.notifyPayout({ id: 'x', clientId: 'y', status: 'COMPLETED' }), false);
      assert.strictEqual((await internal('GET', '/account?chatId=1')).status, 503);
      const m = await register('tg5');
      assert.strictEqual((await call('POST', '/api/telegram/link-code', { token: m.token })).status, 503);
      assert.strictEqual((await call('GET', '/api/telegram', { token: m.token })).body.enabled, false);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });
});

describe('The numbers', () => {
  test('/stats and /recent: payments in windows, open checkouts, wallets, payouts, the last payment', async () => {
    const m = await register('tg6');
    const code = (await call('POST', '/api/telegram/link-code', { token: m.token })).body.code;
    await internal('POST', '/link', { code, chatId: 5006 });
    const day = 86400000;
    const at = (agoMs) => new Date(Date.now() - agoMs).toISOString();
    db.create('transactions', { clientId: m.id, type: 'DEPOSIT', status: 'CONFIRMED', chain: 'ETH', asset: 'ETH', nativeAmount: 0.5, usdAmount: 1000, transactionHash: '0xnew', createdAt: at(60000) });
    db.create('transactions', { clientId: m.id, type: 'DEPOSIT', status: 'CONFIRMED', chain: 'BASE', asset: 'USDC', nativeAmount: 25, usdAmount: 25, transactionHash: '0xweek', createdAt: at(3 * day) });
    db.create('transactions', { clientId: m.id, type: 'DEPOSIT', status: 'CONFIRMED', chain: 'BTC', asset: 'BTC', nativeAmount: 0.01, usdAmount: 600, transactionHash: '0xmonth', createdAt: at(20 * day) });
    db.create('transactions', { clientId: m.id, type: 'DEPOSIT', status: 'CONFIRMED', chain: 'LTC', asset: 'LTC', nativeAmount: 3, usdAmount: 240, createdAt: at(60 * day) });
    db.create('transactions', { clientId: m.id, type: 'DIRECT_TRANSFER', status: 'PROCESSING', chain: 'ETH', nativeAmount: 0.1, usdAmount: 300, createdAt: at(1000) });
    db.create('transactions', { clientId: 'someone-else', type: 'DEPOSIT', status: 'CONFIRMED', chain: 'ETH', nativeAmount: 9, usdAmount: 9000, createdAt: at(1000) });
    db.create('checkoutSessions', { clientId: m.id, status: 'AWAITING_PAYMENT', chain: 'ETH', createdAt: at(1000) });
    db.create('checkoutSessions', { clientId: m.id, status: 'PAID', chain: 'ETH', createdAt: at(1000) });
    db.create('wallets', { clientId: m.id, chain: 'ETH', address: '0x1', balanceUSD: 500.5, isActive: true, privateKey: 'x', createdAt: at(1000) });
    db.create('wallets', { clientId: m.id, chain: 'BTC', address: 'bc1', balanceUSD: 100, isActive: false, privateKey: 'x', createdAt: at(1000) });
    db.create('payouts', { clientId: m.id, status: 'COMPLETED', totalAmountUsd: 100, createdAt: at(1000) });
    db.create('payouts', { clientId: m.id, status: 'FAILED', totalAmountUsd: 10, createdAt: at(1000) });

    const r = await internal('GET', '/stats?chatId=5006');
    assert.strictEqual(r.status, 200);
    const s = r.body.stats;
    assert.ok(s.today.count >= 1 && s.today.usd >= 1000, 'the payment a minute ago is today\'s (UTC)');
    assert.deepStrictEqual(s.week, { count: 2, usd: 1025 });
    assert.deepStrictEqual(s.month, { count: 3, usd: 1625 });
    assert.deepStrictEqual(s.allTime, { count: 4, usd: 1865 }, 'deposits only; transfers in flight and other merchants are not counted');
    assert.strictEqual(s.openCheckouts, 1);
    assert.strictEqual(s.wallets, 1, 'a closed wallet is not counted');
    assert.strictEqual(s.balanceUsd, 500.5);
    assert.deepStrictEqual(s.payouts, { count: 2, completed: 1 });
    assert.strictEqual(s.lastPayment.chain, 'ETH');

    const recent = await internal('GET', '/recent?chatId=5006&limit=2');
    assert.strictEqual(recent.body.payments.length, 2);
    assert.deepStrictEqual(recent.body.payments.map((p) => p.txHash), ['0xnew', '0xweek'], 'newest first');
    assert.strictEqual((await internal('GET', '/recent?chatId=5006&limit=999')).body.payments.length, 4, 'capped at twenty, and there are four');
    assert.strictEqual((await internal('GET', '/stats?chatId=1')).status, 404);
  });
});
