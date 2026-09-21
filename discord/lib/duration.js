'use strict';

/**
 * Durations as people type them: "10m", "1h30m", "7d", "2w", a bare
 * number meaning minutes. Discord's own limit on a timeout is 28 days.
 */

const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const MAX_TIMEOUT_MS = 28 * UNITS.d;

/** "1h30m" → 5400000; a bare number is minutes; anything else → null. */
function parseDuration(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * UNITS.m;
  const re = /(\d+(?:\.\d+)?)([smhdw])/g;
  let total = 0;
  let matched = '';
  let m;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * UNITS[m[2]];
    matched += m[0];
  }
  if (matched !== s || total <= 0) return null;
  return Math.round(total);
}

/** 5400000 → "1h 30m"; under a second → "0s". */
function formatDuration(ms) {
  let left = Math.max(0, Math.round(Number(ms) || 0));
  const parts = [];
  for (const [unit, size] of [['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    const n = Math.floor(left / size);
    if (n > 0) { parts.push(`${n}${unit}`); left -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(' ') : '0s';
}

module.exports = { parseDuration, formatDuration, UNITS, MAX_TIMEOUT_MS };
