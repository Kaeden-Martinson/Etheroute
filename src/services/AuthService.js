const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { config } = require('../config/env');

// ── Password hashing ─────────────────────────────────────────────────────────
// scrypt is memory-hard and ships in Node core, so there is no native build step
// and no third-party dependency in the authentication path.

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const SCRYPT_PREFIX = 'scrypt$';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  });

  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns { valid, needsRehash } - needsRehash is
 * true for accounts still on the legacy unsalted SHA-256 scheme so the caller
 * can transparently upgrade them on next successful login.
 */
function verifyPassword(password, stored) {
  if (!stored) return { valid: false, needsRehash: false };

  if (!stored.startsWith(SCRYPT_PREFIX)) {
    // Legacy: unsalted SHA-256 hex. Compared in constant time, then upgraded.
    const legacy = crypto.createHash('sha256').update(password).digest('hex');
    const a = Buffer.from(legacy, 'utf-8');
    const b = Buffer.from(stored, 'utf-8');
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { valid, needsRehash: valid };
  }

  const [, N, r, p, salt, expected] = stored.split('$');
  const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), SCRYPT_PARAMS.keylen, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });

  const expectedBuf = Buffer.from(expected, 'base64');
  const valid = derived.length === expectedBuf.length && crypto.timingSafeEqual(derived, expectedBuf);
  return { valid, needsRehash: false };
}

// ── API keys ─────────────────────────────────────────────────────────────────
// API keys are high-entropy random strings, so a fast hash is appropriate here -
// there is nothing to brute force. Only the hash is stored; the plaintext is
// shown exactly once, at generation.

const API_KEY_BYTES = 32;

// Length of the random part after the `ethr_` prefix, giving a 46-character
// key. base64url of 32 bytes is 43 characters; trimming to 41 keeps 246 bits
// of entropy, far beyond anything brute-forceable. Keys issued at the older
// length still work - they are looked up by hash, never by length.
const API_KEY_SECRET_LENGTH = 41;

function generateApiKey() {
  const secret = crypto.randomBytes(API_KEY_BYTES).toString('base64url').slice(0, API_KEY_SECRET_LENGTH);
  const key = `ethr_${secret}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 12),
  };
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key, 'utf-8').digest('hex');
}

// ── Recovery codes ─────────────────────────────────────────────────────────────
// Since there is no email channel, a forgotten password is recovered with a
// one-time code the user saved at sign-up. Codes are high-entropy, so — like API
// keys — a fast hash is appropriate; only the hashes are stored, and each code is
// consumed on use.

const RECOVERY_CODE_COUNT = 10;

/** A grouped, high-entropy one-time code, e.g. "3f9a-1c00-be72" (48 bits). */
function makeRecoveryCode() {
  const hex = crypto.randomBytes(6).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function normaliseRecoveryCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(code), 'utf-8').digest('hex');
}

/** Returns { codes: [plaintext…], hashes: [sha256…] }. Plaintext is shown once. */
function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = Array.from({ length: count }, makeRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

// ── Session tokens ───────────────────────────────────────────────────────────

function generateToken(clientId, username) {
  return jwt.sign(
    { clientId, username },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiresIn, subject: String(clientId) }
  );
}

/**
 * Verify a session token. Returns the payload, or null when the token is
 * invalid, expired, or signed with an unexpected algorithm.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

class AuthService {
  static register(db, { username, password }) {
    if (db.findOneBy('users', { username })) {
      throw new Error('Username already taken');
    }

    const { codes, hashes } = generateRecoveryCodes();

    const user = {
      id: uuidv4(),
      username,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
      developer: false,
      apiKeyHash: null,
      apiKeyPrefix: null,
      apiKeyGeneratedAt: null,
      recoveryCodeHashes: hashes,
    };

    db.create('users', user);

    return {
      token: generateToken(user.id, username),
      clientId: user.id,
      username: user.username,
      // Shown exactly once; the user must save these to reset a forgotten password.
      recoveryCodes: codes,
    };
  }

  /**
   * Reset a forgotten password using one of the account's recovery codes. The
   * code is consumed on success. Returns the number of codes still unused so the
   * UI can warn when the user is running low.
   */
  static resetPassword(db, { username, recoveryCode, newPassword }) {
    const user = db.findOneBy('users', { username });

    // Constant-ish work and an identical error whether or not the user exists,
    // so this endpoint cannot be used to probe which usernames are registered.
    const presented = hashRecoveryCode(recoveryCode);
    const hashes = (user && Array.isArray(user.recoveryCodeHashes)) ? user.recoveryCodeHashes : [];
    let matchIndex = -1;
    for (let i = 0; i < hashes.length; i += 1) {
      const a = Buffer.from(hashes[i], 'utf-8');
      const b = Buffer.from(presented, 'utf-8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) { matchIndex = i; break; }
    }

    if (!user || matchIndex === -1) {
      throw new Error('Invalid username or recovery code');
    }

    const remaining = hashes.filter((_, i) => i !== matchIndex);
    db.update('users', user.id, {
      passwordHash: hashPassword(newPassword),
      recoveryCodeHashes: remaining,
    });

    return { username: user.username, recoveryCodesRemaining: remaining.length };
  }

  /**
   * Replace the account's recovery codes with a fresh set, invalidating the old
   * ones. Returns the new plaintext codes (shown once).
   */
  static regenerateRecoveryCodes(db, clientId) {
    const user = db.getById('users', clientId);
    if (!user) throw new Error('User not found');
    const { codes, hashes } = generateRecoveryCodes();
    db.update('users', clientId, { recoveryCodeHashes: hashes });
    return { recoveryCodes: codes };
  }

  /**
   * Change a signed-in user's password. The current password has to verify
   * first - a stolen session must not be enough to lock the owner out.
   */
  static changePassword(db, clientId, { currentPassword, newPassword }) {
    const user = db.getById('users', clientId);
    if (!user) throw new Error('User not found');

    const { valid } = verifyPassword(currentPassword, user.passwordHash);
    if (!valid) throw new Error('Current password is incorrect');

    db.update('users', clientId, { passwordHash: hashPassword(newPassword) });
    return { username: user.username };
  }

  /** How many recovery codes an account has left, and how many a set holds. */
  static recoveryCodeStatus(db, clientId) {
    const user = db.getById('users', clientId);
    const remaining = user && Array.isArray(user.recoveryCodeHashes) ? user.recoveryCodeHashes.length : 0;
    return { remaining, total: RECOVERY_CODE_COUNT };
  }

  static login(db, { username, password }) {
    const user = db.findOneBy('users', { username });

    if (!user) {
      // Spend comparable time on a miss so response timing does not reveal
      // whether the username exists.
      hashPassword(crypto.randomBytes(16).toString('hex'));
      throw new Error('Invalid username or password');
    }

    const { valid, needsRehash } = verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new Error('Invalid username or password');
    }

    const updates = { lastLogin: new Date().toISOString() };
    if (needsRehash) {
      updates.passwordHash = hashPassword(password);
    }
    db.update('users', user.id, updates);

    return {
      token: generateToken(user.id, user.username),
      clientId: user.id,
      username: user.username,
    };
  }

  /**
   * Issue a new API key, replacing any existing one. The plaintext is returned
   * here and never stored, so this is the only moment it can be shown.
   */
  static issueApiKey(db, clientId) {
    const { key, hash, prefix } = generateApiKey();
    const generatedAt = new Date().toISOString();

    const updated = db.update('users', clientId, {
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      apiKeyGeneratedAt: generatedAt,
      // Clear the pre-migration plaintext field if it is still present.
      apiKey: undefined,
    });

    if (!updated) return null;
    return { apiKey: key, prefix, generatedAt };
  }

  static revokeApiKey(db, clientId) {
    return db.update('users', clientId, {
      apiKeyHash: null,
      apiKeyPrefix: null,
      apiKeyGeneratedAt: null,
      apiKey: undefined,
    });
  }

  /**
   * Resolve an API key to its owner by hash lookup. Returns null when no user
   * holds that key.
   */
  static findUserByApiKey(db, presentedKey) {
    if (!presentedKey) return null;
    const hash = hashApiKey(presentedKey);
    return db.findOneBy('users', { apiKeyHash: hash });
  }

  static verifyToken(token) {
    return verifyToken(token);
  }
}

module.exports = AuthService;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.generateToken = generateToken;
module.exports.verifyToken = verifyToken;
module.exports.generateApiKey = generateApiKey;
module.exports.hashApiKey = hashApiKey;
