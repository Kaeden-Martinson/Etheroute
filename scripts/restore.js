'use strict';

/**
 * Restore the database from a timestamped snapshot written by BackupService.
 *
 *   node scripts/restore.js                 # list available snapshots
 *   node scripts/restore.js --latest        # restore the newest snapshot
 *   node scripts/restore.js database-2026-09-16T18-00-00-000Z.json
 *
 * The current database is copied to database.pre-restore.<ts>.json first, so a
 * restore is itself reversible. Stop the server before restoring.
 */

const fs = require('fs');
const path = require('path');
const { DB_FILE, DB_DIR } = require('../src/config/database');

const BACKUP_DIR = path.join(DB_DIR, 'backups');

function listSnapshots() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => /^database-.*\.json$/.test(f)).sort();
}

function main() {
  const arg = process.argv[2];
  const snaps = listSnapshots();

  if (!arg) {
    if (!snaps.length) {
      console.log('No snapshots found in', BACKUP_DIR);
      return;
    }
    console.log('Available snapshots (newest last):\n');
    snaps.forEach((f) => console.log('  ' + f));
    console.log('\nRestore with:  node scripts/restore.js --latest');
    console.log('          or:  node scripts/restore.js <filename>');
    return;
  }

  const chosen = arg === '--latest' ? snaps[snaps.length - 1] : arg;
  if (!chosen) {
    console.error('No snapshot to restore.');
    process.exit(1);
  }
  const src = path.join(BACKUP_DIR, chosen);
  if (!fs.existsSync(src)) {
    console.error('Snapshot not found:', src);
    process.exit(1);
  }

  if (fs.existsSync(DB_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safety = path.join(DB_DIR, `database.pre-restore.${stamp}.json`);
    fs.copyFileSync(DB_FILE, safety);
    console.log('Current database saved to', path.basename(safety));
  }

  fs.copyFileSync(src, DB_FILE);
  console.log('Restored', chosen, '->', path.basename(DB_FILE));
  console.log('Start the server to load the restored data.');
}

main();
