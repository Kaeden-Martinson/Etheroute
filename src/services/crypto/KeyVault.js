/**
 * KeyVault - envelope encryption for wallet private keys and seed phrases.
 *
 * Stored keys are encrypted with AES-256-GCM under a master key held in the
 * KEY_ENCRYPTION_KEY environment variable. A stolen database dump is useless on
 * its own: the attacker also needs the process environment.
 *
 * This is the stepping stone to a real KMS or an external custodian - the call
 * sites here (encrypt / decrypt) are the same two operations a KMS exposes, so
 * swapping the implementation later does not touch the wallet services.
 */
const crypto = require('crypto');
const { config } = require('../../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit nonce, the GCM standard
const TAG_LENGTH = 16;
const PREFIX = 'enc.v1.';

/**
 * Derive a 32-byte encryption key from the configured master secret.
 * A fixed salt is acceptable here because the master secret is already
 * high-entropy - this is a domain separator, not a password stretch.
 */
let cachedKey = null;
function masterKey() {
  if (!cachedKey) {
    cachedKey = crypto.hkdfSync(
      'sha256',
      Buffer.from(config.keyEncryptionKey, 'utf-8'),
      Buffer.from('etheroute-keyvault-v1'),
      Buffer.from('wallet-key-encryption'),
      32
    );
    cachedKey = Buffer.from(cachedKey);
  }
  return cachedKey;
}

/**
 * True when a stored value is already ciphertext produced by this vault.
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret. Returns "enc.v1.<iv>.<tag>.<ciphertext>", all base64url.
 * Passing an already-encrypted value through is a no-op, which makes the
 * migration script idempotent.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX.slice(0, -1),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a secret. A value that is not ciphertext is returned unchanged, so
 * records written before encryption was introduced still work while the
 * migration runs.
 */
function decrypt(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  if (!isEncrypted(stored)) return stored;

  const parts = String(stored).split('.');
  if (parts.length !== 5) {
    throw new Error('KeyVault: malformed ciphertext');
  }

  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const ciphertext = Buffer.from(parts[4], 'base64url');

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('KeyVault: malformed ciphertext');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');
  } catch {
    // GCM authentication failed: wrong master key, or the record was tampered with.
    throw new Error('KeyVault: could not decrypt - KEY_ENCRYPTION_KEY may have changed');
  }
}

/**
 * Return a wallet with its secrets decrypted, for signing. Keep the result in a
 * local variable and never persist or log it.
 */
function unsealWallet(wallet) {
  if (!wallet) return wallet;
  return {
    ...wallet,
    privateKey: decrypt(wallet.privateKey),
    seedPhrase: decrypt(wallet.seedPhrase),
  };
}

/**
 * Return a wallet with its secrets encrypted, ready to store.
 */
function sealWallet(wallet) {
  if (!wallet) return wallet;
  return {
    ...wallet,
    privateKey: encrypt(wallet.privateKey),
    seedPhrase: encrypt(wallet.seedPhrase),
  };
}

/**
 * Strip secrets entirely. Use for anything that leaves the process - API
 * responses, logs, error reports.
 */
function redactWallet(wallet) {
  if (!wallet) return wallet;
  const { privateKey, seedPhrase, publicKey, derivationPath, ...safe } = wallet;
  return safe;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  sealWallet,
  unsealWallet,
  redactWallet,
};
