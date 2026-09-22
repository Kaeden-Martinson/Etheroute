'use strict';

/**
 * Merchants in a private chat with the bot. A merchant arrives from the
 * dashboard's deep link with "/start link_<code>"; the code goes to the
 * API's internal endpoints, the account and this chat are bound, and from
 * then on the API itself tells them here when a payment settles or a
 * payout finishes. /stats and /recent ask the API for their numbers;
 * /notify turns the two kinds of message on and off; /unlink undoes it.
 *
 * The internal endpoints are guarded by a secret derived from the bot
 * token - the same derivation as the API's - so nothing else is configured.
 */

const crypto = require('crypto');
const { esc, b, i, code, cut, when, ago } = require('./format');

const internalSecret = (token) => crypto.createHash('sha256').update(`etheroute-telegram-internal:${token}`).digest('hex');

/** GET/POST/PUT against /api/telegram/internal/*; { ok, status, body }. Never throws. */
async function call(ctx, method, path, { query, body, fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(`${ctx.config.status.apiUrl}/api/telegram/internal${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-internal-secret': internalSecret(ctx.config.token) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok && Boolean(json && json.success), status: res.status, body: json || {} };
  } catch (err) {
    ctx.log.warn(`internal API ${method} ${path} failed:`, err.message);
    return { ok: false, status: 0, body: { message: 'The API did not answer' } };
  }
}

const usd = (n) => (Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-');
const num = (n) => (Number.isFinite(n) ? Number(n.toFixed(8)).toString() : String(n));

// ── the link ──────────────────────────────────────────────────────────────
/** "/start link_ABCD2345" → "ABCD2345"; anything else → null. */
function linkCodeFrom(args) {
  const m = /^link[_-]([A-Za-z0-9]{6,12})$/.exec(String(args || '').trim());
  return m ? m[1].toUpperCase() : null;
}

async function link(ctx, message, codeText) {
  const r = await call(ctx, 'POST', '/link', { body: { code: codeText, chatId: message.chat.id, username: message.from.username || null, firstName: message.from.first_name || null } });
  if (!r.ok) {
    const why = r.status === 0 ? 'I could not reach Etheroute just now - try the link again in a minute.' : r.body.message || 'That did not work.';
    await ctx.api.sendMessage(message.chat.id, `${esc(why)}`);
    return { ok: false };
  }
  const a = r.body.account;
  await ctx.api.sendMessage(message.chat.id, [
    `✅ ${b('Linked')} to your Etheroute account ${b(a.username)}.`,
    '',
    `From now on I will message you here when a payment settles and when a payout finishes.`,
    '',
    `/stats - your numbers · /recent - the last payments · /notify - what you hear about · /unlink - stop`,
  ].join('\n'));
  ctx.log.info(`chat ${message.chat.id} linked to merchant ${a.username}`);
  return { ok: true, account: a };
}

async function account(ctx, chatId) {
  const r = await call(ctx, 'GET', '/account', { query: { chatId } });
  return r.ok ? r.body.account : null;
}

const NOT_LINKED = 'This chat is not linked to an Etheroute account. In the dashboard, open Account → Notifications → Connect Telegram, and press the link it gives you.';

async function unlink(ctx, message) {
  const r = await call(ctx, 'POST', '/unlink', { body: { chatId: message.chat.id } });
  if (!r.ok) return ctx.api.sendMessage(message.chat.id, esc(r.body.message || 'That did not work.'));
  return ctx.api.sendMessage(message.chat.id, r.body.unlinked ? 'Unlinked. You will not hear from me about your account any more; connect again from the dashboard any time.' : NOT_LINKED);
}

// ── the numbers ───────────────────────────────────────────────────────────
function statsText(a, s) {
  const row = (label, w) => `${b(label)}: ${w.count} payment${w.count === 1 ? '' : 's'} · ${usd(w.usd)}`;
  return cut([
    `📊 ${b(a.username)} - your payments`,
    '',
    row('Today', s.today), row('7 days', s.week), row('30 days', s.month), row('All time', s.allTime),
    '',
    `${b('Balance across wallets')}: ${usd(s.balanceUsd)} in ${s.wallets} wallet${s.wallets === 1 ? '' : 's'}`,
    `${b('Open checkouts')}: ${s.openCheckouts}`,
    `${b('Payouts')}: ${s.payouts.completed} completed of ${s.payouts.count}`,
    s.lastPayment ? `${b('Last payment')}: ${esc(num(s.lastPayment.nativeAmount))} ${esc(s.lastPayment.asset || '')} (${usd(s.lastPayment.usdAmount)}) on ${esc(s.lastPayment.chain)}, ${ago(s.lastPayment.at)}` : `${b('Last payment')}: none yet`,
    '',
    i('/recent for the last few; /notify to change what I message you about.'),
  ].join('\n'));
}

async function stats(ctx, message) {
  const r = await call(ctx, 'GET', '/stats', { query: { chatId: message.chat.id } });
  if (r.status === 404) return ctx.api.sendMessage(message.chat.id, NOT_LINKED);
  if (!r.ok) return ctx.api.sendMessage(message.chat.id, esc(r.body.message || 'I could not fetch your numbers just now.'));
  return ctx.api.sendMessage(message.chat.id, statsText(r.body.account, r.body.stats));
}

function recentText(a, payments) {
  if (!payments.length) return `${b(a.username)}: no payments yet.`;
  return cut([
    `🧾 ${b(a.username)} - last ${payments.length} payment${payments.length === 1 ? '' : 's'}`,
    '',
    ...payments.map((p) => `• ${esc(num(p.nativeAmount))} ${esc(p.asset || '')} (${usd(p.usdAmount)}) on ${esc(p.chain)} - ${esc(when(p.at))}${p.txHash ? `\n  ${code(p.txHash.length > 20 ? `${p.txHash.slice(0, 10)}…${p.txHash.slice(-8)}` : p.txHash)}` : ''}`),
  ].join('\n'));
}

async function recent(ctx, message, limit = 5) {
  const r = await call(ctx, 'GET', '/recent', { query: { chatId: message.chat.id, limit } });
  if (r.status === 404) return ctx.api.sendMessage(message.chat.id, NOT_LINKED);
  if (!r.ok) return ctx.api.sendMessage(message.chat.id, esc(r.body.message || 'I could not fetch your payments just now.'));
  return ctx.api.sendMessage(message.chat.id, recentText(r.body.account, r.body.payments || []));
}

// ── what they hear about ──────────────────────────────────────────────────
const PREF_WORDS = { paid: 'a payment settles', payouts: 'a payout finishes' };

function notifyText(a) {
  const on = (v) => (v ? '🔔 on' : '🔕 off');
  return [
    b('What I message you about'),
    '',
    `${on(a.prefs.paid)} - when ${PREF_WORDS.paid}  (${code('/notify paid off')} / ${code('on')})`,
    `${on(a.prefs.payouts)} - when ${PREF_WORDS.payouts}  (${code('/notify payouts off')} / ${code('on')})`,
  ].join('\n');
}

/** "/notify" shows; "/notify paid off" sets. */
async function notify(ctx, message, cmd) {
  const [what, state] = cmd.argv;
  if (cmd.argv.length) {
    if (!PREF_WORDS[what] || !['on', 'off'].includes(state)) return ctx.api.sendMessage(message.chat.id, `Say ${code('/notify paid on')}, ${code('/notify paid off')}, ${code('/notify payouts on')} or ${code('/notify payouts off')}.`);
    const r = await call(ctx, 'PUT', '/preferences', { body: { chatId: message.chat.id, prefs: { [what]: state === 'on' } } });
    if (r.status === 404) return ctx.api.sendMessage(message.chat.id, NOT_LINKED);
    if (!r.ok) return ctx.api.sendMessage(message.chat.id, esc(r.body.message || 'That did not work.'));
    return ctx.api.sendMessage(message.chat.id, notifyText(r.body.account));
  }
  const a = await account(ctx, message.chat.id);
  if (!a) return ctx.api.sendMessage(message.chat.id, NOT_LINKED);
  return ctx.api.sendMessage(message.chat.id, notifyText(a));
}

module.exports = { internalSecret, call, linkCodeFrom, link, unlink, account, stats, recent, notify, statsText, recentText, notifyText, NOT_LINKED };
