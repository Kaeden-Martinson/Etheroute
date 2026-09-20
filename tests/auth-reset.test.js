/**
 * Password reset via one-time recovery codes. There is no email channel, so a
 * forgotten password is recovered with a code saved at sign-up. These tests
 * exercise AuthService directly against an in-memory database stub.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const AuthService = require('../src/services/AuthService');

/** Minimal in-memory stand-in for the db module's row API. */
function makeDb() {
  const tables = { users: [] };
  return {
    _tables: tables,
    findOneBy(table, criteria) {
      return tables[table].find((r) => Object.entries(criteria).every(([k, v]) => r[k] === v)) || null;
    },
    getById(table, id) {
      return tables[table].find((r) => r.id === id) || null;
    },
    create(table, row) {
      tables[table].push(row);
      return row;
    },
    update(table, id, updates) {
      const row = tables[table].find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, updates);
      return row;
    },
  };
}

const PW = 'correct-horse-battery';
const NEW_PW = 'a-brand-new-passphrase';

describe('Recovery codes', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  test('registration returns a set of one-time codes and stores only their hashes', () => {
    const res = AuthService.register(db, { username: 'alice', password: PW });
    assert.ok(Array.isArray(res.recoveryCodes) && res.recoveryCodes.length >= 8, 'codes returned');
    const user = db.findOneBy('users', { username: 'alice' });
    assert.strictEqual(user.recoveryCodeHashes.length, res.recoveryCodes.length, 'a hash per code');
    // Plaintext codes are never stored.
    for (const code of res.recoveryCodes) {
      assert.ok(!JSON.stringify(user).includes(code), 'plaintext code not stored');
    }
  });

  test('a valid code resets the password, is consumed, and old password stops working', () => {
    const { recoveryCodes } = AuthService.register(db, { username: 'bob', password: PW });
    const code = recoveryCodes[0];

    const out = AuthService.resetPassword(db, { username: 'bob', recoveryCode: code, newPassword: NEW_PW });
    assert.strictEqual(out.recoveryCodesRemaining, recoveryCodes.length - 1, 'code consumed');

    // New password works, old one does not.
    assert.ok(AuthService.login(db, { username: 'bob', password: NEW_PW }).token);
    assert.throws(() => AuthService.login(db, { username: 'bob', password: PW }), /Invalid/);

    // The used code cannot be reused.
    assert.throws(() => AuthService.resetPassword(db, { username: 'bob', recoveryCode: code, newPassword: 'yet-another-pass' }), /Invalid/);
  });

  test('codes are case- and dash-insensitive', () => {
    const { recoveryCodes } = AuthService.register(db, { username: 'carol', password: PW });
    const messy = recoveryCodes[0].toUpperCase().replace(/-/g, ' ');
    const out = AuthService.resetPassword(db, { username: 'carol', recoveryCode: messy, newPassword: NEW_PW });
    assert.strictEqual(out.recoveryCodesRemaining, recoveryCodes.length - 1);
  });

  test('a wrong code or unknown user is rejected with the same error', () => {
    AuthService.register(db, { username: 'dave', password: PW });
    assert.throws(() => AuthService.resetPassword(db, { username: 'dave', recoveryCode: 'ffff-ffff-ffff', newPassword: NEW_PW }), /Invalid username or recovery code/);
    assert.throws(() => AuthService.resetPassword(db, { username: 'nobody', recoveryCode: 'ffff-ffff-ffff', newPassword: NEW_PW }), /Invalid username or recovery code/);
  });

  test('regenerating codes invalidates the previous set', () => {
    const { recoveryCodes } = AuthService.register(db, { username: 'erin', password: PW });
    const user = db.findOneBy('users', { username: 'erin' });
    const fresh = AuthService.regenerateRecoveryCodes(db, user.id);
    assert.strictEqual(fresh.recoveryCodes.length, recoveryCodes.length);
    // Old code no longer works.
    assert.throws(() => AuthService.resetPassword(db, { username: 'erin', recoveryCode: recoveryCodes[0], newPassword: NEW_PW }), /Invalid/);
    // A new one does.
    assert.ok(AuthService.resetPassword(db, { username: 'erin', recoveryCode: fresh.recoveryCodes[0], newPassword: NEW_PW }));
  });
});
