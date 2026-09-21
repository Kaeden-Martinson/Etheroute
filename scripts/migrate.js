#!/usr/bin/env node
/**
 * Forward migration to the hardened data model.
 *
 * Run:  node scripts/migrate.js [--dry-run]
 *
 * Idempotent - safe to run repeatedly, and safe to run against a database that
 * is already fully migrated.
 *
 *   1. Wallet privateKey / seedPhrase  -> encrypted at rest (AES-256-GCM)
 *   2. User apiKey (plaintext)         -> apiKeyHash + apiKeyPrefix
 *   3. Checkout sessions `amount`      -> nativeAmount / usdAmount
 *   4. Missing fields backfilled on wallets, sessions and users
 *
 * A timestamped snapshot of the database is written before anything changes.
 * Stop the server before running it.
 */
const path = require('path');

const { validate } = require('../src/config/env');
validate();

const { db, DB_FILE, DB_DIR, TABLES } = require('../src/config/database');
const KeyVault = require('../src/services/crypto/KeyVault');
const AuthService = require('../src/services/AuthService');

const DRY_RUN = process.argv.includes('--dry-run');

function log(message) {
  console.log(`  ${message}`);
}

function main() {
  // Every table as an array of records; the steps below mutate these and
  // the whole set is written back in one commit at the end.
  const data = db.exportAll();

  if (!DRY_RUN) {
    const backup = path.join(DB_DIR, `database.pre-migration.${Date.now()}.sqlite`);
    db.snapshotTo(backup);
    console.log(`\nSnapshot written to ${path.basename(backup)} (of ${path.basename(DB_FILE)})\n`);
  } else {
    console.log('\nDRY RUN - no changes will be written\n');
  }

  const stats = {
    walletsEncrypted: 0,
    walletsAlreadyEncrypted: 0,
    apiKeysHashed: 0,
    sessionsNormalised: 0,
    fieldsBackfilled: 0,
  };

  // ── 1 + 4. Wallets: encrypt signing material, backfill fields ──────────────
  console.log('Wallets');
  for (const wallet of data.wallets || []) {
    const needsEncryption =
      (wallet.privateKey && !KeyVault.isEncrypted(wallet.privateKey)) ||
      (wallet.seedPhrase && !KeyVault.isEncrypted(wallet.seedPhrase));

    if (needsEncryption) {
      const sealed = KeyVault.sealWallet(wallet);
      wallet.privateKey = sealed.privateKey;
      wallet.seedPhrase = sealed.seedPhrase;
      stats.walletsEncrypted += 1;
      log(`encrypted keys for ${wallet.chain} ${wallet.address}`);
    } else if (wallet.privateKey) {
      stats.walletsAlreadyEncrypted += 1;
    }

    if (wallet.serviceSubtractions === undefined) {
      wallet.serviceSubtractions = 0;
      stats.fieldsBackfilled += 1;
    }
    if (wallet.isActive === undefined) {
      wallet.isActive = true;
      stats.fieldsBackfilled += 1;
    }
  }
  log(`${stats.walletsEncrypted} encrypted, ${stats.walletsAlreadyEncrypted} already encrypted`);

  // ── 2. Users: hash plaintext API keys ─────────────────────────────────────
  console.log('\nUsers');
  for (const user of data.users || []) {
    if (user.apiKey && !user.apiKeyHash) {
      // Hash the existing key so it keeps working - customers are not locked
      // out by the migration. It should still be rotated: keys issued before
      // this change came from Math.random() and are predictable.
      user.apiKeyHash = AuthService.hashApiKey(user.apiKey);
      user.apiKeyPrefix = String(user.apiKey).slice(0, 12);
      delete user.apiKey;
      stats.apiKeysHashed += 1;
      log(`hashed API key for ${user.username} - ROTATE THIS KEY, it was generated with a weak RNG`);
    } else if (user.apiKey) {
      delete user.apiKey;
    }

    for (const [field, value] of [['apiKeyHash', null], ['apiKeyPrefix', null], ['apiKeyGeneratedAt', null], ['developer', false]]) {
      if (user[field] === undefined) {
        user[field] = value;
        stats.fieldsBackfilled += 1;
      }
    }

    if (user.passwordHash && !user.passwordHash.startsWith('scrypt$')) {
      log(`${user.username} still on legacy password hash - upgraded automatically at next login`);
    }
  }
  log(`${stats.apiKeysHashed} API keys hashed`);

  // ── 3. Checkout sessions: split the old single amount field ───────────────
  console.log('\nCheckout sessions');
  for (const session of data.checkoutSessions || []) {
    if (session.nativeAmount === undefined && session.amount !== undefined) {
      session.nativeAmount = session.amount;
      if (session.usdAmount === undefined) session.usdAmount = null;
      delete session.amount;
      stats.sessionsNormalised += 1;
      log(`normalised session ${session.id}`);
    }

    for (const [field, value] of [
      ['webhookUrl', null],
      ['reference', null],
      ['pendingTxHash', null],
      ['confirmations', null],
    ]) {
      if (session[field] === undefined) {
        session[field] = value;
        stats.fieldsBackfilled += 1;
      }
    }

    // balanceSnapshot drove the old delta-based detection, which is gone.
    delete session.balanceSnapshot;
  }
  log(`${stats.sessionsNormalised} sessions normalised`);

  // ── Ensure every expected table exists ────────────────────────────────────
  for (const table of TABLES) {
    if (!Array.isArray(data[table])) {
      data[table] = [];
      console.log(`\nCreated missing table: ${table}`);
    }
  }

  if (!DRY_RUN) {
    db.replaceAll(data);
  }
  db.close();

  console.log('\n' + '-'.repeat(58));
  console.log('Summary');
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key.padEnd(26)} ${value}`);
  }
  console.log('-'.repeat(58));

  if (DRY_RUN) {
    console.log('\nDry run complete - re-run without --dry-run to apply.\n');
  } else {
    console.log('\nMigration complete.\n');
    console.log('Next: rotate every API key and move funds to freshly generated wallets.');
    console.log('The keys in git history are public and encryption does not undo that.\n');
  }
}

main();
