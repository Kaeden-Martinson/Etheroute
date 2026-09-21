/**
 * Alerts: a Discord webhook gets an embed with a level, a title, fields and
 * the detail as code when it is a stack; Slack an attachment of the same
 * shape; anyone else the raw fields. Every caller says what level it is.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { buildPayload, LEVELS, notify } = require('../src/services/AlertService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');
const DISCORD = 'https://discord.com/api/webhooks/123/abc';
const SLACK = 'https://hooks.slack.com/services/T/B/x';

describe('The payload per destination', () => {
  test('Discord gets one embed: glyph in the title, the level colour, inline fields, footer and timestamp', () => {
    const p = buildPayload(DISCORD, 'Bitcoin rpc down', 'no endpoint answering', { level: 'error', fields: [{ name: 'Chain', value: 'Bitcoin (BTC)' }, { name: 'Change', value: 'up → down' }, { name: 'Empty', value: '' }, { name: 'Long', value: 'x'.repeat(2000), inline: false }] });
    assert.strictEqual(p.username, 'Etheroute');
    assert.strictEqual(p.embeds.length, 1);
    const e = p.embeds[0];
    assert.strictEqual(e.title, '🔴 Bitcoin rpc down');
    assert.strictEqual(e.description, 'no endpoint answering');
    assert.strictEqual(e.color, LEVELS.error.color);
    assert.deepStrictEqual(e.fields.map((f) => f.name), ['Chain', 'Change', 'Long'], 'an empty field is dropped');
    assert.strictEqual(e.fields[0].inline, true);
    assert.strictEqual(e.fields[2].inline, false);
    assert.strictEqual(e.fields[2].value.length, 1024, 'a field value is cut to Discord\'s limit');
    assert.ok(e.fields[2].value.endsWith('…'));
    assert.match(e.footer.text, /^Etheroute · test · /);
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
  });

  test('a stack trace becomes a code block; a plain sentence does not', () => {
    const stack = 'TypeError: boom\n    at Object.<anonymous> (/srv/app.js:1:1)\n    at Module._compile (node:internal/modules/cjs/loader:1)';
    const code = buildPayload(DISCORD, 'Uncaught exception', stack, { level: 'critical' }).embeds[0];
    assert.ok(code.description.startsWith('```\nTypeError: boom'));
    assert.ok(code.description.endsWith('\n```'));
    assert.strictEqual(code.color, LEVELS.critical.color);
    const plain = buildPayload(DISCORD, 'Fee sweep', 'Two transfers, $12.00 in all.', { level: 'success' }).embeds[0];
    assert.strictEqual(plain.description, 'Two transfers, $12.00 in all.');
    assert.strictEqual(plain.title, '🟢 Fee sweep');
    const long = buildPayload(DISCORD, 'x', 'line\n'.repeat(900), {}).embeds[0];
    assert.ok(long.description.length <= 1910, 'a long report is cut to fit the embed');
  });

  test('every level has a colour and a glyph, and an unknown level is an error', () => {
    for (const level of ['critical', 'error', 'warning', 'info', 'success']) {
      const e = buildPayload(DISCORD, 's', 'd', { level }).embeds[0];
      assert.strictEqual(e.color, LEVELS[level].color, level);
      assert.ok(e.title.startsWith(LEVELS[level].glyph), level);
    }
    assert.strictEqual(buildPayload(DISCORD, 's', 'd', { level: 'nope' }).embeds[0].color, LEVELS.error.color);
    assert.strictEqual(buildPayload(DISCORD, 's', 'd').embeds[0].color, LEVELS.error.color);
  });

  test('Slack gets an attachment with the colour bar and short fields; anyone else the raw fields', () => {
    const s = buildPayload(SLACK, 'Server started', 'Listening on port 3000.', { level: 'info', fields: [{ name: 'Node', value: 'v25' }] });
    assert.strictEqual(s.text, '🔵 Etheroute: Server started');
    assert.strictEqual(s.attachments[0].color, LEVELS.info.slack);
    assert.deepStrictEqual(s.attachments[0].fields, [{ title: 'Node', value: 'v25', short: true }]);
    assert.ok(!('embeds' in s));

    const raw = buildPayload('https://ops.example.com/hook', 'Server started', 'Listening.', { level: 'info', fields: [{ name: 'Node', value: 'v25' }] });
    assert.strictEqual(raw.level, 'info');
    assert.strictEqual(raw.subject, 'Server started');
    assert.strictEqual(raw.detail, 'Listening.');
    assert.deepStrictEqual(raw.fields, [{ name: 'Node', value: 'v25', inline: true }]);
    assert.ok(raw.text.startsWith('🔵 Etheroute: Server started'));
    assert.strictEqual(raw.content, raw.text, 'a Discord-shaped endpoint elsewhere still gets content');
  });
});

describe('Delivery', () => {
  test('posts the embed to the webhook, and says when the webhook refuses', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ path: req.url, body: JSON.parse(body) }); res.statusCode = req.url.includes('refuse') ? 404 : 204; res.end(req.url.includes('refuse') ? '{"message":"Unknown Webhook"}' : ''); });
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const original = process.env.ALERT_WEBHOOK_URL;
    const logger = require('../src/services/logger');
    const warned = [];
    const originalWarn = logger.warn;
    logger.warn = (...args) => warned.push(args.join(' '));
    try {
      process.env.ALERT_WEBHOOK_URL = `${base}/discord.com-lookalike`;
      notify('Hello', 'world', `k${Date.now()}`, { level: 'info' });
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].body.subject, 'Hello', 'a host that is not Discord gets the raw shape');
      process.env.ALERT_WEBHOOK_URL = `${base}/refuse`;
      notify('Hello', 'world', `r${Date.now()}`, { level: 'info' });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(warned.some((w) => /webhook answered 404: .*Unknown Webhook/.test(w)), warned.join(' | '));
    } finally {
      logger.warn = originalWarn;
      if (original === undefined) delete process.env.ALERT_WEBHOOK_URL; else process.env.ALERT_WEBHOOK_URL = original;
      await new Promise((r) => server.close(r));
    }
  });
});

describe('Every caller says its level', () => {
  test('crashes are critical or error with the message as a field; a 500 names the route, request and client; chains and sweeps carry their facts; the server announces itself', () => {
    const app = read('src/app.js');
    assert.ok(app.includes("level: 'critical',") && app.includes("'uncaughtException', {"));
    assert.ok(app.includes("'unhandledRejection', {") && app.includes("{ name: 'Uptime', value: `${Math.round(process.uptime() / 60)} min` }"));
    assert.ok(app.includes("{ name: 'Route', value: `${req.method} ${req.baseUrl || ''}${req.path}` }"));
    assert.ok(app.includes("{ name: 'Client', value: req.auth ? `${req.auth.username} (${req.auth.method})` : 'anonymous' }"));
    assert.ok(app.includes("AlertService.notify('Server started'") && app.includes("level: 'info'") && app.includes("{ name: 'Fee addresses', value:"));
    const health = read('src/services/ChainHealthService.js');
    assert.ok(health.includes("level: recovered ? 'success' : (severe ? 'error' : 'warning')"));
    assert.ok(health.includes("{ name: 'Change', value: `${change.from || 'unknown'} → ${change.to}` }"));
    const fees = read('src/services/FeeCollectionService.js');
    assert.ok(fees.includes("level: failed.length ? 'warning' : 'success'"));
    assert.ok(fees.includes("closed wallet' : ''}`, value:"));
  });
});
