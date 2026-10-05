/**
 * The webhook signing secret: the one a vendor verifies our deliveries
 * against. It starts out derived from the master key, so it survives a
 * restart and can always be shown again; a client who thinks it has leaked
 * mints their own, which is stored on their record and used from the next
 * delivery onwards.
 *
 * Covered here: which secret is effective, that rotating replaces it and
 * the old one stops verifying, that the two endpoints only ever hand a
 * caller their own, and that the delivery path still refuses a private
 * target (which is why the signature is checked by composition rather than
 * against a local endpoint).
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
const crypto = require('node:crypto');

const app = require('../src/app');
const { db } = require('../src/config/database');
const WebhookService = require('../src/services/WebhookService');

let server;
let base;

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

async function register(prefix) {
  const r = await call('POST', '/api/auth/register', { body: { username: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'a-very-long-test-password' } });
  const id = (await call('GET', '/api/auth/verify', { token: r.body.token })).body.clientId;
  return { token: r.body.token, id };
}

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('Which secret is effective', () => {
  test('derived until rotated: stable per client, different between clients, and rotation replaces it', () => {
    const id = `svc-${crypto.randomUUID()}`;
    db.create('users', { id, username: id, passwordHash: 'x', createdAt: new Date().toISOString() });

    const derived = WebhookService.derivedSigningSecret(id);
    assert.match(derived, /^[A-Za-z0-9_-]{20,}$/, 'base64url, no padding to trip up a shell');
    assert.strictEqual(WebhookService.derivedSigningSecret(id), derived, 'the same every time it is asked');
    assert.strictEqual(WebhookService.signingSecret(id), derived, 'effective = derived while nothing is stored');
    assert.strictEqual(WebhookService.signingSecretIsRotated(id), false);
    assert.notStrictEqual(WebhookService.derivedSigningSecret(`${id}-other`), derived, 'and it is per client');

    const minted = WebhookService.rotateSigningSecret(id);
    assert.match(minted, /^[A-Za-z0-9_-]{32,}$/);
    assert.notStrictEqual(minted, derived);
    assert.strictEqual(WebhookService.signingSecret(id), minted, 'the stored one wins from now on');
    assert.strictEqual(WebhookService.signingSecretIsRotated(id), true);
    assert.strictEqual(db.getById('users', id).webhookSecret, minted, 'kept on the record');
    assert.ok(db.getById('users', id).webhookSecretRotatedAt, 'with the moment it happened');
    assert.strictEqual(WebhookService.derivedSigningSecret(id), derived, 'the derived value itself is untouched');

    const again = WebhookService.rotateSigningSecret(id);
    assert.notStrictEqual(again, minted, 'each rotation is a fresh random value');
    assert.strictEqual(WebhookService.signingSecret(id), again);
  });

  test('a secret that has been rotated away no longer verifies', () => {
    const id = `svc-${crypto.randomUUID()}`;
    db.create('users', { id, username: id, passwordHash: 'x', createdAt: new Date().toISOString() });
    const body = JSON.stringify({ event: 'checkout.session.completed', data: { sessionId: 'abc' } });
    const ts = Math.floor(Date.now() / 1000);

    const old = WebhookService.signingSecret(id);
    const signedWithOld = WebhookService.signPayload(old, ts, body);
    assert.strictEqual(WebhookService.verifySignature(old, signedWithOld, body), true);

    const fresh = WebhookService.rotateSigningSecret(id);
    assert.strictEqual(WebhookService.verifySignature(fresh, signedWithOld, body), false, 'an endpoint on the new secret rejects the old signature');

    // ...and what the delivery path will send from now on verifies against the new one.
    const signedNow = WebhookService.signPayload(WebhookService.signingSecret(id), ts, body);
    assert.strictEqual(WebhookService.verifySignature(fresh, signedNow, body), true);
    assert.strictEqual(WebhookService.verifySignature(old, signedNow, body), false);
  });

  test('rotating for a client that does not exist stores nothing and says so', () => {
    assert.strictEqual(WebhookService.rotateSigningSecret(`missing-${crypto.randomUUID()}`), null);
    assert.strictEqual(WebhookService.signingSecretIsRotated(`missing-${crypto.randomUUID()}`), false);
  });

  test('a delivery is still refused when its target is private, so a secret never leaves for localhost', async () => {
    const id = `svc-${crypto.randomUUID()}`;
    db.create('users', { id, username: id, passwordHash: 'x', createdAt: new Date().toISOString() });
    const delivery = WebhookService.enqueue({ clientId: id, url: 'http://127.0.0.1:9/hook', event: 'checkout.session.completed', data: { sessionId: 'x' } });
    assert.ok(delivery, 'queued');
    // enqueue fires the first attempt in the background; wait for it to record
    for (let i = 0; i < 40; i += 1) {
      const row = db.getById('webhookDeliveries', delivery.id);
      if (row && row.attempts > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const row = db.getById('webhookDeliveries', delivery.id);
    assert.strictEqual(row.attempts, 1);
    assert.match(String(row.lastError), /refused|private/i);
    assert.notStrictEqual(row.status, 'DELIVERED');
  });
});

describe('GET /api/webhook-secret', () => {
  test('needs a credential, hands back only the caller\'s own secret, and says whether it has been rotated', async () => {
    assert.strictEqual((await call('GET', '/api/webhook-secret')).status, 401);
    assert.strictEqual((await call('GET', '/api/webhook-secret', { token: 'not-a-token' })).status, 401);

    const a = await register('wh-a');
    const b = await register('wh-b');
    const mine = await call('GET', '/api/webhook-secret', { token: a.token });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.success, true);
    assert.strictEqual(mine.body.webhookSecret, WebhookService.signingSecret(a.id));
    assert.strictEqual(mine.body.rotated, false, 'a new account is on the derived secret');
    assert.strictEqual(mine.body.algorithm, 'HMAC-SHA256');
    assert.strictEqual(mine.body.header, 'Etheroute-Signature');
    assert.match(mine.body.format, /^t=<unix seconds>,v1=<hex>/);
    assert.ok(mine.body.note.includes('Keep it secret'));

    const theirs = await call('GET', '/api/webhook-secret', { token: b.token });
    assert.notStrictEqual(theirs.body.webhookSecret, mine.body.webhookSecret, 'no two accounts share one');
    assert.strictEqual(theirs.body.webhookSecret, WebhookService.signingSecret(b.id));

    // the same value on the next call: an endpoint configured once keeps working
    assert.strictEqual((await call('GET', '/api/webhook-secret', { token: a.token })).body.webhookSecret, mine.body.webhookSecret);
  });

  test('a signature from the delivery path verifies against what this returns', async () => {
    const m = await register('wh-verify');
    const secret = (await call('GET', '/api/webhook-secret', { token: m.token })).body.webhookSecret;
    const body = JSON.stringify({ event: 'checkout.session.completed', data: { sessionId: '7bc9' }, createdAt: new Date().toISOString() });
    const header = WebhookService.signPayload(WebhookService.signingSecret(m.id), Math.floor(Date.now() / 1000), body);
    assert.strictEqual(WebhookService.verifySignature(secret, header, body), true);
    assert.strictEqual(WebhookService.verifySignature(secret, header, `${body} `), false, 'and only against the exact bytes');
  });
});

describe('POST /api/webhook-secret/rotate', () => {
  test('mints a new secret, returns it once with 201, and the old one stops verifying', async () => {
    const m = await register('wh-rotate');
    const before = (await call('GET', '/api/webhook-secret', { token: m.token })).body.webhookSecret;

    const rotated = await call('POST', '/api/webhook-secret/rotate', { token: m.token });
    assert.strictEqual(rotated.status, 201);
    assert.strictEqual(rotated.body.rotated, true);
    assert.notStrictEqual(rotated.body.webhookSecret, before);
    assert.ok(rotated.body.rotatedNote.includes('no longer verifies'), 'the reply says to update the endpoint');
    assert.strictEqual(rotated.body.algorithm, 'HMAC-SHA256');

    const after = await call('GET', '/api/webhook-secret', { token: m.token });
    assert.strictEqual(after.body.webhookSecret, rotated.body.webhookSecret, 'and it sticks');
    assert.strictEqual(after.body.rotated, true);

    const body = JSON.stringify({ event: 'checkout.session.expired' });
    const ts = Math.floor(Date.now() / 1000);
    assert.strictEqual(WebhookService.verifySignature(rotated.body.webhookSecret, WebhookService.signPayload(before, ts, body), body), false, 'nothing signed with the old secret passes');
    assert.strictEqual(WebhookService.verifySignature(rotated.body.webhookSecret, WebhookService.signPayload(WebhookService.signingSecret(m.id), ts, body), body), true);

    const twice = await call('POST', '/api/webhook-secret/rotate', { token: m.token });
    assert.notStrictEqual(twice.body.webhookSecret, rotated.body.webhookSecret, 'rotating again is another fresh value');
  });

  test('needs a credential, and rotating one account leaves another alone', async () => {
    assert.strictEqual((await call('POST', '/api/webhook-secret/rotate')).status, 401);
    const a = await register('wh-x');
    const b = await register('wh-y');
    const bBefore = WebhookService.signingSecret(b.id);
    await call('POST', '/api/webhook-secret/rotate', { token: a.token });
    assert.strictEqual(WebhookService.signingSecret(b.id), bBefore);
    assert.strictEqual(WebhookService.signingSecretIsRotated(b.id), false);
  });
});
