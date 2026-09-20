/**
 * Regression tests for the vulnerabilities found in the security review.
 *
 * Each test names the finding it locks down, so a future change that reopens one
 * fails here with an explanation rather than silently shipping.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AuthService = require('../src/services/AuthService');
const KeyVault = require('../src/services/crypto/KeyVault');
const { validateCryptoAddress } = require('../src/utils/validators');
const WebhookService = require('../src/services/WebhookService');

describe('C5 - session tokens', () => {
  test('a token signed with the old default secret is rejected', () => {
    const crypto = require('crypto');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
    const payload = Buffer.from(JSON.stringify({
      clientId: 'victim',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64');
    const signature = crypto
      .createHmac('sha256', 'your-secret-key')
      .update(`${header}.${payload}`)
      .digest('base64');

    assert.strictEqual(AuthService.verifyToken(`${header}.${payload}.${signature}`), null);
  });

  test('a tampered token is rejected', () => {
    const token = AuthService.generateToken('client-1', 'alice');
    assert.strictEqual(AuthService.verifyToken(token.slice(0, -4) + 'AAAA'), null);
  });

  test('an unsigned (alg:none) token is rejected', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ clientId: 'victim' })).toString('base64url');
    assert.strictEqual(AuthService.verifyToken(`${header}.${payload}.`), null);
  });

  test('a valid token round-trips', () => {
    const token = AuthService.generateToken('client-1', 'alice');
    assert.strictEqual(AuthService.verifyToken(token).clientId, 'client-1');
  });
});

describe('C6 / H7 - credential generation and storage', () => {
  test('API keys are unpredictable and distinct', () => {
    const keys = new Set();
    for (let i = 0; i < 500; i += 1) keys.add(AuthService.generateApiKey().key);
    assert.strictEqual(keys.size, 500);
  });

  test('API keys carry enough entropy', () => {
    const { key } = AuthService.generateApiKey();
    // 32 random bytes, base64url encoded, behind an "ethr_" prefix.
    assert.ok(key.startsWith('ethr_'));
    assert.ok(key.length >= 40, `key too short: ${key.length}`);
  });

  test('passwords are salted - the same password hashes differently each time', () => {
    const a = AuthService.hashPassword('correct horse battery staple');
    const b = AuthService.hashPassword('correct horse battery staple');
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith('scrypt$'));
  });

  test('password verification accepts the right password and rejects others', () => {
    const hash = AuthService.hashPassword('correct horse battery staple');
    assert.strictEqual(AuthService.verifyPassword('correct horse battery staple', hash).valid, true);
    assert.strictEqual(AuthService.verifyPassword('wrong password entirely', hash).valid, false);
  });

  test('legacy SHA-256 passwords still log in, and are flagged for upgrade', () => {
    const crypto = require('crypto');
    const legacy = crypto.createHash('sha256').update('old-password').digest('hex');
    const result = AuthService.verifyPassword('old-password', legacy);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.needsRehash, true);
  });
});

describe('C1 - wallet keys are encrypted at rest', () => {
  const secret = '0x' + 'ab'.repeat(32);

  test('ciphertext does not contain the plaintext', () => {
    const encrypted = KeyVault.encrypt(secret);
    assert.ok(!encrypted.includes(secret));
    assert.ok(encrypted.startsWith('enc.v1.'));
  });

  test('encryption round-trips', () => {
    assert.strictEqual(KeyVault.decrypt(KeyVault.encrypt(secret)), secret);
  });

  test('encryption is idempotent, so the migration can be re-run', () => {
    const once = KeyVault.encrypt(secret);
    assert.strictEqual(KeyVault.encrypt(once), once);
  });

  test('tampered ciphertext is rejected rather than silently decrypted', () => {
    const encrypted = KeyVault.encrypt(secret);
    assert.throws(() => KeyVault.decrypt(encrypted.slice(0, -6) + 'BBBBBB'));
  });

  test('redaction strips every secret field', () => {
    const redacted = KeyVault.redactWallet({
      id: 'w1', address: '0xabc', privateKey: secret, seedPhrase: 'twelve words here',
    });
    assert.strictEqual(redacted.privateKey, undefined);
    assert.strictEqual(redacted.seedPhrase, undefined);
    assert.strictEqual(redacted.address, '0xabc');
  });
});

describe('Checkout - address validation accepts modern formats', () => {
  const valid = [
    ['BTC', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'legacy'],
    ['BTC', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'P2SH'],
    ['BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'segwit v0'],
    ['BTC', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'taproot'],
    ['LTC', 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9', 'LTC segwit'],
    ['LTC', 'LTdsVS8VDw6syvfQADdhf2PHAm3rMGJvPX', 'LTC legacy'],
    ['ETH', '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e', 'ETH'],
    ['SOL', '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK', 'SOL'],
  ];

  for (const [chain, address, label] of valid) {
    test(`${chain} accepts ${label}`, () => {
      assert.strictEqual(validateCryptoAddress(address, chain), true);
    });
  }

  const invalid = [
    ['BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bad checksum'],
    ['BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet address'],
    ['ETH', '0xZZ1973e6A8d74C34d86319345fe19B4F279A5f8e', 'non-hex'],
    ['ETH', '0xDd1973e6A8d74C34d86319345fe19B4F279A5f', 'too short'],
    ['BTC', '', 'empty'],
  ];

  for (const [chain, address, label] of invalid) {
    test(`${chain} rejects ${label}`, () => {
      assert.strictEqual(validateCryptoAddress(address, chain), false);
    });
  }
});

describe('Webhooks - signature verification', () => {
  const secret = 'webhook-test-secret';
  const body = JSON.stringify({ event: 'checkout.session.completed', data: { sessionId: 'abc' } });

  test('a correctly signed payload verifies', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = WebhookService.signPayload(secret, ts, body);
    assert.strictEqual(WebhookService.verifySignature(secret, header, body), true);
  });

  test('a modified body fails verification', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = WebhookService.signPayload(secret, ts, body);
    assert.strictEqual(WebhookService.verifySignature(secret, header, body + ' '), false);
  });

  test('the wrong secret fails verification', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = WebhookService.signPayload(secret, ts, body);
    assert.strictEqual(WebhookService.verifySignature('other-secret', header, body), false);
  });

  test('an old signature is rejected as a replay', () => {
    const stale = Math.floor(Date.now() / 1000) - 4000;
    const header = WebhookService.signPayload(secret, stale, body);
    assert.strictEqual(WebhookService.verifySignature(secret, header, body), false);
  });

  test('each client gets a distinct signing secret', () => {
    assert.notStrictEqual(
      WebhookService.signingSecret('client-a'),
      WebhookService.signingSecret('client-b')
    );
  });
});

describe('API key length', () => {
  test('a new key is 46 characters and still carries the prefix', () => {
    const { generateApiKey } = require('../src/services/AuthService');
    for (let i = 0; i < 20; i++) {
      const { key, prefix } = generateApiKey();
      assert.strictEqual(key.length, 46);
      assert.ok(key.startsWith('ethr_'));
      assert.strictEqual(prefix, key.slice(0, 12));
      assert.match(key.slice(5), /^[A-Za-z0-9_-]{41}$/, 'base64url alphabet only');
    }
  });
});
