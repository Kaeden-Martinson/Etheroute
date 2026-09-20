/**
 * Merchant-facing checkout endpoints.
 *
 * Exercised end to end against a real server so the auth middleware, ownership
 * checks and route ordering are all covered — a listing route that leaks
 * another merchant's payment links would not show up in a unit test of the
 * handler alone.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const app = require('../src/app');
const PriceService = require('../src/services/PriceService');

let server;
let base;

/** Merchant fixture: a registered account with one wallet. */
async function merchant(username) {
  const registration = await call('POST', '/api/auth/register', {
    body: { username, password: 'a-very-long-test-password' },
  });
  const token = registration.body.token;
  const wallet = await call('POST', '/api/wallets/generate', { token, body: { chain: 'BTC' } });
  return { token, walletId: wallet.body.id };
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function sessionPayload(walletId, overrides = {}) {
  return {
    walletId,
    usdAmount: 25,
    successRoute: 'https://shop.example.com/thanks',
    failureRoute: 'https://shop.example.com/failed',
    ...overrides,
  };
}

before(async () => {
  // Pin a price so session creation does not depend on the live feed.
  PriceService.btcToUsdRate = 60000;

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('Listing payment links', () => {
  test('requires authentication', async () => {
    const response = await call('GET', '/api/checkout/sessions');
    assert.strictEqual(response.status, 401);
  });

  test('returns only the caller\'s own sessions', async () => {
    const alice = await merchant(`alice_${Date.now()}`);
    const bob = await merchant(`bob_${Date.now()}`);

    await call('POST', '/api/checkout/create', {
      token: alice.token,
      body: sessionPayload(alice.walletId, { reference: 'alice-order' }),
    });

    const bobsView = await call('GET', '/api/checkout/sessions', { token: bob.token });
    assert.strictEqual(bobsView.status, 200);
    assert.strictEqual(bobsView.body.total, 0, 'Bob must not see Alice\'s payment links');

    const alicesView = await call('GET', '/api/checkout/sessions', { token: alice.token });
    assert.strictEqual(alicesView.body.total, 1);
    assert.strictEqual(alicesView.body.sessions[0].reference, 'alice-order');
  });

  test('summarises counts and collected value', async () => {
    const shop = await merchant(`shop_${Date.now()}`);
    await call('POST', '/api/checkout/create', { token: shop.token, body: sessionPayload(shop.walletId) });
    await call('POST', '/api/checkout/create', { token: shop.token, body: sessionPayload(shop.walletId) });

    const listing = await call('GET', '/api/checkout/sessions', { token: shop.token });
    assert.strictEqual(listing.body.total, 2);
    assert.strictEqual(listing.body.totals.PENDING, 2);
    assert.strictEqual(listing.body.paidUsd, 0, 'nothing is paid, so nothing is collected');
  });

  test('rejects an unknown status filter rather than silently ignoring it', async () => {
    const shop = await merchant(`filter_${Date.now()}`);
    const response = await call('GET', '/api/checkout/sessions?status=NOT_A_STATUS', { token: shop.token });
    assert.strictEqual(response.status, 400);
  });

  test('filters by status', async () => {
    const shop = await merchant(`statusfilter_${Date.now()}`);
    await call('POST', '/api/checkout/create', { token: shop.token, body: sessionPayload(shop.walletId) });

    const pending = await call('GET', '/api/checkout/sessions?status=PENDING', { token: shop.token });
    assert.strictEqual(pending.body.sessions.length, 1);

    const paid = await call('GET', '/api/checkout/sessions?status=PAID', { token: shop.token });
    assert.strictEqual(paid.body.sessions.length, 0);
  });
});

describe('Reading one payment link', () => {
  test('the owner sees the full record', async () => {
    const shop = await merchant(`owner_${Date.now()}`);
    const created = await call('POST', '/api/checkout/create', {
      token: shop.token,
      body: sessionPayload(shop.walletId, { reference: 'ref-1', webhookUrl: 'https://shop.example.com/hook' }),
    });

    const detail = await call('GET', `/api/checkout/sessions/${created.body.sessionId}`, { token: shop.token });
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.session.reference, 'ref-1');
    assert.strictEqual(detail.body.session.webhookUrl, 'https://shop.example.com/hook');
    assert.ok(detail.body.session.requiredConfirmations >= 1);
  });

  test('another merchant gets 404, not 403 - the id is not confirmed to exist', async () => {
    const owner = await merchant(`owner2_${Date.now()}`);
    const stranger = await merchant(`stranger_${Date.now()}`);

    const created = await call('POST', '/api/checkout/create', {
      token: owner.token,
      body: sessionPayload(owner.walletId),
    });

    const response = await call('GET', `/api/checkout/sessions/${created.body.sessionId}`, { token: stranger.token });
    assert.strictEqual(response.status, 404);
  });
});

describe('Cancelling a payment link', () => {
  test('an open link can be cancelled by its owner', async () => {
    const shop = await merchant(`cancel_${Date.now()}`);
    const created = await call('POST', '/api/checkout/create', {
      token: shop.token,
      body: sessionPayload(shop.walletId),
    });

    const response = await call('POST', `/api/checkout/sessions/${created.body.sessionId}/cancel`, { token: shop.token });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.session.status, 'EXPIRED');
  });

  test('another merchant cannot cancel it', async () => {
    const owner = await merchant(`cowner_${Date.now()}`);
    const stranger = await merchant(`cstranger_${Date.now()}`);

    const created = await call('POST', '/api/checkout/create', {
      token: owner.token,
      body: sessionPayload(owner.walletId),
    });

    const response = await call('POST', `/api/checkout/sessions/${created.body.sessionId}/cancel`, { token: stranger.token });
    assert.strictEqual(response.status, 404);

    // And it is genuinely untouched.
    const detail = await call('GET', `/api/checkout/sessions/${created.body.sessionId}`, { token: owner.token });
    assert.strictEqual(detail.body.session.status, 'PENDING');
  });

  test('cancelling twice is harmless', async () => {
    const shop = await merchant(`twice_${Date.now()}`);
    const created = await call('POST', '/api/checkout/create', {
      token: shop.token,
      body: sessionPayload(shop.walletId),
    });

    await call('POST', `/api/checkout/sessions/${created.body.sessionId}/cancel`, { token: shop.token });
    const second = await call('POST', `/api/checkout/sessions/${created.body.sessionId}/cancel`, { token: shop.token });
    assert.strictEqual(second.status, 200);
  });
});

describe('Creating a payment link', () => {
  test('a wallet belonging to someone else is not usable', async () => {
    const owner = await merchant(`wowner_${Date.now()}`);
    const stranger = await merchant(`wstranger_${Date.now()}`);

    const response = await call('POST', '/api/checkout/create', {
      token: stranger.token,
      body: sessionPayload(owner.walletId),
    });

    assert.strictEqual(response.status, 404);
  });

  test('both amounts at once is rejected', async () => {
    const shop = await merchant(`bothamt_${Date.now()}`);
    const response = await call('POST', '/api/checkout/create', {
      token: shop.token,
      body: sessionPayload(shop.walletId, { nativeAmount: 0.001 }),
    });
    assert.strictEqual(response.status, 400);
  });

  test('a non-http redirect is rejected', async () => {
    const shop = await merchant(`badurl_${Date.now()}`);
    const response = await call('POST', '/api/checkout/create', {
      token: shop.token,
      body: sessionPayload(shop.walletId, { successRoute: 'javascript:alert(1)' }),
    });
    assert.strictEqual(response.status, 400);
  });
});

describe('Account: changing the password', () => {
  test('needs the current password, and the new one must be different and long enough', async () => {
    const shop = await merchant(`pw_${Date.now()}`);
    const wrong = await call('POST', '/api/auth/change-password', { token: shop.token, body: { currentPassword: 'not-the-password-at-all', newPassword: 'another-long-password-1' } });
    assert.strictEqual(wrong.status, 400);
    assert.match(wrong.body.message, /incorrect/i);

    const short = await call('POST', '/api/auth/change-password', { token: shop.token, body: { currentPassword: 'a-very-long-test-password', newPassword: 'short' } });
    assert.strictEqual(short.status, 400);

    const same = await call('POST', '/api/auth/change-password', { token: shop.token, body: { currentPassword: 'a-very-long-test-password', newPassword: 'a-very-long-test-password' } });
    assert.strictEqual(same.status, 400);

    const anon = await call('POST', '/api/auth/change-password', { body: { currentPassword: 'a-very-long-test-password', newPassword: 'another-long-password-1' } });
    assert.strictEqual(anon.status, 401);
  });

  test('with the current password, the change takes and the old one stops working', async () => {
    const name = `pw2_${Date.now()}`;
    const shop = await merchant(name);
    const changed = await call('POST', '/api/auth/change-password', { token: shop.token, body: { currentPassword: 'a-very-long-test-password', newPassword: 'another-long-password-1' } });
    assert.strictEqual(changed.status, 200);

    const old = await call('POST', '/api/auth/login', { body: { username: name, password: 'a-very-long-test-password' } });
    assert.strictEqual(old.status, 401);
    const fresh = await call('POST', '/api/auth/login', { body: { username: name, password: 'another-long-password-1' } });
    assert.strictEqual(fresh.status, 200);
  });

  test('the profile says how many recovery codes are left', async () => {
    const shop = await merchant(`codes_${Date.now()}`);
    const me = await call('GET', '/api/clients/me', { token: shop.token });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.recoveryCodesTotal, 10);
    assert.strictEqual(me.body.recoveryCodesRemaining, 10, 'a new account has the full set');
    assert.ok(!('recoveryCodeHashes' in me.body) && !('passwordHash' in me.body), 'and nothing secret');
  });
});

describe('Quoting a rate for the form', () => {
  test('requires authentication', async () => {
    const response = await call('GET', '/api/checkout/quote?chain=BTC');
    assert.strictEqual(response.status, 401);
  });

  test('returns the rate the create call would price at, with its age', async () => {
    const shop = await merchant(`quote_${Date.now()}`);
    const response = await call('GET', '/api/checkout/quote?chain=btc', { token: shop.token });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.chain, 'BTC', 'the code is normalised');
    assert.strictEqual(response.body.symbol, 'BTC');
    assert.strictEqual(response.body.usdRate, 60000, 'the pinned feed rate');
    assert.strictEqual(response.body.fresh, true);
    assert.ok('ageSeconds' in response.body);

    // and it agrees with what a link is then made at
    const created = await call('POST', '/api/checkout/create', { token: shop.token, body: sessionPayload(shop.walletId, { usdAmount: 30 }) });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.nativeAmount, parseFloat((30 / response.body.usdRate).toFixed(8)));
    assert.strictEqual(created.body.usdRate, response.body.usdRate, 'and the create response carries the rate it used');
  });

  test('an unknown or missing chain is a 400, not a rate of 0', async () => {
    const shop = await merchant(`quotebad_${Date.now()}`);
    for (const query of ['?chain=DOGE', '']) {
      const response = await call('GET', `/api/checkout/quote${query}`, { token: shop.token });
      assert.strictEqual(response.status, 400, `quote${query}`);
    }
  });

  test('a chain whose price has not loaded says so rather than quoting', async () => {
    const shop = await merchant(`quotecold_${Date.now()}`);
    const saved = PriceService.ltcToUsdRate;
    PriceService.ltcToUsdRate = 0;
    try {
      const response = await call('GET', '/api/checkout/quote?chain=LTC', { token: shop.token });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.usdRate, 0);
      assert.strictEqual(response.body.fresh, false);
    } finally {
      PriceService.ltcToUsdRate = saved;
    }
  });
});
