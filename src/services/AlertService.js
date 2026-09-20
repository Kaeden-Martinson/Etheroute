'use strict';

/**
 * Critical-error alerting.
 *
 * When ALERT_WEBHOOK_URL is set (e.g. a Slack/Discord incoming webhook or your
 * own endpoint), unexpected 5xx errors and process-level crashes are POSTed to
 * it so an operator hears about money-path failures instead of finding them in
 * the logs later. With no URL configured this is a no-op, so it is safe to leave
 * wired in everywhere.
 *
 * Fire-and-forget: it never throws and never blocks the request path, and it
 * de-dupes bursts of the same alert with a short cooldown so one failing loop
 * cannot flood the channel.
 */

const http = require('http');
const https = require('https');
const logger = require('./logger');

const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 60000);
const lastSent = new Map();

function urlFor() {
  return process.env.ALERT_WEBHOOK_URL || '';
}

function onCooldown(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < COOLDOWN_MS) return true;
  lastSent.set(key, now);
  // Keep the map from growing unbounded.
  if (lastSent.size > 200) lastSent.clear();
  return false;
}

/**
 * Send an alert. `key` groups messages for de-duping (defaults to subject).
 * Returns immediately; delivery happens in the background.
 */
function notify(subject, detail, key) {
  const target = urlFor();
  if (!target) return;
  if (onCooldown(key || subject)) return;

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    logger.warn('[AlertService] ALERT_WEBHOOK_URL is not a valid URL; skipping alert.');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  // "text" and "content" cover Slack and Discord webhooks respectively; the raw
  // fields are there for a custom endpoint.
  const text = `🚨 Etheroute: ${subject}\n${detail || ''}`.slice(0, 1800);
  const body = JSON.stringify({ text, content: text, subject, detail, at: new Date().toISOString() });

  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.request(
    {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 4000,
    },
    (res) => { res.on('data', () => {}); res.on('end', () => {}); },
  );

  req.on('error', (err) => logger.warn(`[AlertService] delivery failed: ${err.message}`));
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

module.exports = { notify };
