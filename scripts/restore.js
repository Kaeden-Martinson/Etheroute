'use strict';

/**
 * Restore the database from a timestamped snapshot written by BackupService.
 *
 *   node scripts/restore.js                 # list available snapshots
 *   node scripts/restore.js --latest        # restore the newest snapshot
 *   node scripts/restore.js database-2026-09-16T18-00-00-000Z.sqlite
 *
 * A snapshot from before the SQLite store (database-<stamp>.json) restores
 * too: its records are imported in place of what is there.
 *
 * The current database is saved to database.pre-restore.<ts>.sqlite first,
 * so a restore is itself reversible. Stop the server before restoring.
 */

const fs = require('fs');
const path = require('path');
const { db, DB_FILE, DB_DIR } = require('../src/config/database');

// The same folder and naming BackupService uses. (Not required from there:
// the services pull in the logger, which takes over console.log.)
const BACKUP_DIR = path.join(DB_DIR, 'backups');
const SNAPSHOT = /^database-.*\.(sqlite|json)$/;

function listSnapshots() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => SNAPSHOT.test(f)).sort();
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(DB_DIR, `database.pre-restore.${stamp}.sqlite`);
  db.snapshotTo(safety);
  console.log('Current database saved to', path.basename(safety));

  if (chosen.endsWith('.json')) {
    // A snapshot of the JSON store: import its records over what is there.
    const data = JSON.parse(fs.readFileSync(src, 'utf-8'));
    const imported = db.replaceAll(data);
    db.close();
    console.log(`Restored ${chosen}: ${imported} records imported into ${path.basename(DB_FILE)}`);
  } else {
    // A SQLite snapshot replaces the file. The log and shared-memory files
    // belong to the old database and must go with it, or SQLite would
    // replay the old log onto the restored file.
    db.close();
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + suffix); } catch { /* none left, which is the usual case */ }
    }
    fs.copyFileSync(src, DB_FILE);
    console.log('Restored', chosen, '->', path.basename(DB_FILE));
  }
  console.log('Start the server to load the restored data.');
}

main();
