'use strict';

/**
 * Point-in-time database snapshots.
 *
 * The database module already keeps a single rolling `database.backup.json`
 * (written before every save), which protects against a corrupt write. This
 * service adds timestamped snapshots on a schedule so you can also roll back to
 * an earlier *state* — recover from a bad migration, an accidental delete, or
 * data you need from yesterday — and keeps only the most recent N.
 *
 * Snapshots live in <dataDir>/backups and are pruned to BACKUP_KEEP files.
 * Restore with `node scripts/restore.js`.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { DB_FILE, DB_DIR } = require('../config/database');

const BACKUP_DIR = path.join(DB_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000); // daily

let timer = null;

function snapshot() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `database-${stamp}.json`);
    fs.copyFileSync(DB_FILE, dest);
    prune();
    logger.info(`[BackupService] Snapshot written: ${path.basename(dest)}`);
    return dest;
  } catch (error) {
    logger.error('[BackupService] Snapshot failed:', error.message);
    return null;
  }
}

function prune() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^database-.*\.json$/.test(f))
    .sort(); // ISO-ish timestamps sort chronologically
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

module.exports = { start, stop, snapshot, BACKUP_DIR };
