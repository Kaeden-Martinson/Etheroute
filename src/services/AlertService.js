'use strict';

/**
 * Alerting: what an operator needs to hear about, sent where they will
 * hear it.
 *
 * When ALERT_WEBHOOK_URL is set, crashes, unexpected 5xx errors, chains going
 * down or coming back, fee sweeps and the server starting are POSTed to it.
 * A Discord webhook gets an embed - a colour for the level, a title, fields,
 * the detail in a code block when it is a stack - a Slack webhook gets an
 * attachment in the same shape, and any other endpoint gets the raw JSON.
 * With no URL this is a no-op, so it is safe to wire in everywhere.
 *
 * Fire-and-forget: it never throws and never blocks the request path, and it
 * de-dupes bursts of the same alert with a short cooldown so one failing loop
 * cannot flood the channel.
 */

const http = require('http');
const https = require('https');
const os = require('os');
const logger = require('./logger');

const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 60000);
const lastSent = new Map();

// The levels, their colour on the embed's edge, and the glyph in the title.
const LEVELS = {
  critical: { color: 0xb3261e, glyph: '🔴', slack: '#b3261e' },
  error: { color: 0xd9534f, glyph: '🔴', slack: '#d9534f' },
  warning: { color: 0xe8a23a, glyph: '🟠', slack: '#e8a23a' },
  info: { color: 0x1d4e89, glyph: '🔵', slack: '#1d4e89' },
  success: { color: 0x1f7a43, glyph: '🟢', slack: '#1f7a43' },
};

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

function cut(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A stack trace or a multi-line report reads as code; a sentence does not. */
function looksLikeCode(text) {
  return /\n\s+at |\n {2,}/.test(String(text || '')) || String(text || '').split('\n').length > 6;
}

function footerText() {
  return `Etheroute · ${process.env.NODE_ENV || 'development'} · ${os.hostname()}`;
}

/**
 * The body for `target`: Discord's embeds, Slack's attachments, or the raw
 * fields for an endpoint of your own. Exported for the tests.
 */
function buildPayload(target, subject, detail, options = {}) {
  const level = LEVELS[options.level] ? options.level : 'error';
  const style = LEVELS[level];
  const at = new Date().toISOString();
  const fields = (options.fields || []).filter((f) => f && f.name && f.value != null && String(f.value) !== '').slice(0, 25)
    .map((f) => ({ name: cut(f.name, 256), value: cut(String(f.value), 1024), inline: f.inline !== false }));
  const host = (() => { try { return new URL(target).hostname; } catch { return ''; } })();
  const body = String(detail || '');
  const asCode = looksLikeCode(body);

  if (/(^|\.)discord(app)?\.com$/.test(host)) {
    const description = asCode ? `\`\`\`\n${cut(body.replace(/`/g, "'"), 1900)}\n\`\`\`` : cut(body, 2000);
    const embed = {
      title: cut(`${style.glyph} ${subject}`, 256),
      description: description || undefined,
      color: style.color,
      fields,
      footer: { text: footerText() },
      timestamp: at,
    };
    if (options.url) embed.url = options.url;
    return { username: 'Etheroute', embeds: [embed] };
  }

  if (/(^|\.)slack\.com$/.test(host)) {
    return {
      text: `${style.glyph} Etheroute: ${subject}`,
      attachments: [{
        color: style.slack,
        title: cut(subject, 256),
        text: asCode ? `\`\`\`${cut(body, 2900)}\`\`\`` : cut(body, 3000),
        fields: fields.map((f) => ({ title: f.name, value: f.value, short: f.inline })),
        footer: footerText(),
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }

  // Anyone else gets the plain shape, with a text line for whatever reads it.
  const text = `${style.glyph} Etheroute: ${subject}\n${cut(body, 1800)}`;
  return { text, content: text, subject, detail: body, level, fields, at, host: os.hostname(), environment: process.env.NODE_ENV || 'development' };
}

/**
 * Send an alert. `key` groups messages for de-duping (defaults to subject).
 * `options.level` is critical, error, warning, info or success; `options.fields`
 * are `{ name, value, inline }` for the embed. Returns immediately; delivery
 * happens in the background.
 */
function notify(subject, detail, key, options = {}) {
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

  const body = JSON.stringify(buildPayload(target, subject, detail, options));

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
    (res) => {
      // A webhook that answers but refuses (a deleted Discord webhook is a
      // 404, a bad token a 401) would otherwise fail in silence forever.
      let answer = '';
      res.on('data', (chunk) => { if (answer.length < 300) answer += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 300) logger.warn(`[AlertService] webhook answered ${res.statusCode}: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`);
      });
    },
  );

  req.on('error', (err) => logger.warn(`[AlertService] delivery failed: ${err.message}`));
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

module.exports = { notify, buildPayload, LEVELS };
