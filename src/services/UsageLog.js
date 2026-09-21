'use strict';

/**
 * The usage log, written in batches.
 *
 * Every authenticated request records a row for billing and the dashboard's
 * chart. Writing each one as it happens made every request pay for a disk
 * flush; here the rows wait a couple of seconds and go in one commit. A
 * reader that needs the newest rows calls flush() first, and shutdown
 * flushes what is left, so nothing is lost but the last moment of a crash.
 */

const { db } = require('../config/database');
const logger = require('./logger');

const FLUSH_MS = Number(process.env.USAGE_FLUSH_MS || 2000);
// A burst larger than this is written at once rather than held.
const FLUSH_AT = 500;

let pending = [];
let timer = null;

function record(row) {
  pending.push(row);
  if (pending.length >= FLUSH_AT) {
    flush();
  } else if (!timer) {
    timer = setTimeout(flush, FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/** Write what is waiting, in one transaction. Returns how many rows went. */
function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.length === 0) return 0;
  const rows = pending;
  pending = [];
  try {
    db.createMany('apiCalls', rows);
    return rows.length;
  } catch (error) {
    logger.error(`[UsageLog] Could not write ${rows.length} usage rows: ${error.message}`);
    return 0;
  }
}

function pendingCount() {
  return pending.length;
}

module.exports = { record, flush, pendingCount, FLUSH_MS };
