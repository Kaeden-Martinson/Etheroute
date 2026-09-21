'use strict';

/**
 * Point-in-time database snapshots.
 *
 * The write-ahead log protects the live database against a crash mid-write.
 * This service adds timestamped copies on a schedule so you can also roll
 * back to an earlier *state* — recover from a bad migration, an accidental
 * delete, or data you need from yesterday — and keeps only the most recent N.
 *
 * A snapshot is a consistent, compacted copy taken through SQLite itself
 * (VACUUM INTO) while the server keeps serving; copying the file by hand
 * would miss what is still in the log. Snapshots live in <dataDir>/backups
 * and are pruned to BACKUP_KEEP files. Restore with `node scripts/restore.js`.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { db, DB_FILE, DB_DIR } = require('../config/database');

const BACKUP_DIR = path.join(DB_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000); // daily

// Snapshots from before the SQLite store are JSON; restore.js still reads them.
const SNAPSHOT = /^database-.*\.(sqlite|json)$/;

let timer = null;

function snapshot() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `database-${stamp}.sqlite`);
    db.snapshotTo(dest);
    prune();
    logger.info(`[BackupService] Snapshot written: ${path.basename(dest)}`);
    return dest;
  } catch (error) {
    logger.error('[BackupService] Snapshot failed:', error.message);
    return null;
  }
}

function listSnapshots() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => SNAPSHOT.test(f))
    .sort(); // ISO-ish timestamps sort chronologically
}

function prune() {
  const files = listSnapshots();
  const excess = files.length - KEEP;
  for (let i = 0; i < excess; i += 1) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, files[i])); } catch { /* best effort */ }
  }
}

function start() {
  if (timer || INTERVAL_MS <= 0) return;
  // One snapshot shortly after boot, then on the interval.
  setTimeout(snapshot, 5000).unref?.();
  timer = setInterval(snapshot, INTERVAL_MS);
  timer.unref?.();
  logger.info(`[BackupService] Started — snapshot every ${Math.round(INTERVAL_MS / 3600000)}h, keeping ${KEEP}.`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, snapshot, listSnapshots, BACKUP_DIR, SNAPSHOT };
