'use strict';

/**
 * Merchants on Telegram: a merchant links their account to the bot from
 * the dashboard, and from then on hears about their money where they
 * already are - a message when a payment settles, one when a payout
 * finishes - and can ask the bot for their numbers with /stats.
 *
 * The link is a short code the dashboard mints and the merchant carries
 * to the bot in a deep link (t.me/<bot>?start=link_<code>); the bot hands
 * it back here through the internal endpoints, which are guarded by a
 * secret derived from the bot token - both processes hold the token, so
 * neither needs another key and the token itself never travels.
 *
 * Messages go straight to the Bot API from here, fire-and-forget: the
 * settlement path never waits on Telegram, and a merchant who blocked the
 * bot is quietly unlinked the first time Telegram says so.
 */

const crypto = require('crypto');
const { db } = require('../config/database');
const logger = require('./logger');

const CODE_TTL_MS = 10 * 60000;
const DEFAULT_PREFS = Object.freeze({ paid: true, payouts: true });
const API = 'https://api.telegram.org';

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const enabled = () => Boolean(token());

/** The secret the bot must present to the internal endpoints. */
function internalSecret(t = token()) {
  return t ? crypto.createHash('sha256').update(`etheroute-telegram-internal:${t}`).digest('hex') : '';
}

function isInternal(presented) {
  const want = internalSecret();
  if (!want || !presented || typeof presented !== 'string' || presented.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(want));
}

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (hash) => (hash && hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash || '');
const usd = (n) => (Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null);
const num = (n, max = 8) => (Number.isFinite(n) ? Number(n.toFixed(max)).toString() : String(n));

// ── the link ──────────────────────────────────────────────────────────────
function newCode() {
  // 8 characters people can read back: no 0/O, 1/I/L
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8)).map((b) => alphabet[b % alphabet.length]).join('');
}

function pruneCodes() {
  const now = Date.now();
  for (const c of db.getAll('telegramLinkCodes')) if (new Date(c.expiresAt).getTime() < now) db.delete('telegramLinkCodes', c.id);
}

/** A code for the dashboard to hand the merchant; any earlier code of theirs is dropped. */
function createLinkCode(clientId) {
  pruneCodes();
  for (const c of db.findBy('telegramLinkCodes', { clientId })) db.delete('telegramLinkCodes', c.id);
  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.create('telegramLinkCodes', { id: code, clientId, expiresAt, createdAt: new Date().toISOString() });
  return { code, expiresAt };
}

/** The bot brought a code back with the chat it came from: bind them. */
function consumeLinkCode(code, { chatId, username = null, firstName = null }) {
  const record = db.getById('telegramLinkCodes', String(code || '').trim().toUpperCase());
  if (!record) return { error: 'unknown', message: 'That code is not one I gave out. Make a new one from the dashboard.' };
  db.delete('telegramLinkCodes', record.id);
  if (new Date(record.expiresAt).getTime() < Date.now()) return { error: 'expired', message: 'That code has expired - they last ten minutes. Make a new one from the dashboard.' };
  const user = db.getById('users', record.clientId);
  if (!user) return { error: 'gone', message: 'That account no longer exists.' };
  // one chat, one account: a chat linked elsewhere moves here
  for (const other of accountsForChat(chatId)) if (other.id !== user.id) db.update('users', other.id, { telegram: null });
  const prefs = (user.telegram && user.telegram.prefs) || { ...DEFAULT_PREFS };
  const telegram = { chatId: Number(chatId), username, firstName, linkedAt: new Date().toISOString(), prefs };
  const updated = db.update('users', user.id, { telegram });
  logger.info(`[Telegram] ${user.username} linked to chat ${chatId}${username ? ` (@${username})` : ''}`);
  return { account: summaryFor(updated) };
}

function accountsForChat(chatId) {
  const id = Number(chatId);
  return db.getAll('users').filter((u) => u.telegram && Number(u.telegram.chatId) === id);
}

const accountForChat = (chatId) => accountsForChat(chatId)[0] || null;

function unlinkClient(clientId) {
  const user = db.getById('users', clientId);
  if (!user || !user.telegram) return false;
  db.update('users', clientId, { telegram: null });
  logger.info(`[Telegram] ${user.username} unlinked`);
  return true;
}

function unlinkChat(chatId) {
  let n = 0;
  for (const u of accountsForChat(chatId)) { db.update('users', u.id, { telegram: null }); n += 1; }
  return n;
}

function setPrefs(clientId, prefs = {}) {
  const user = db.getById('users', clientId);
  if (!user || !user.telegram) return null;
  const next = { ...DEFAULT_PREFS, ...user.telegram.prefs };
  for (const key of Object.keys(DEFAULT_PREFS)) if (typeof prefs[key] === 'boolean') next[key] = prefs[key];
  return summaryFor(db.update('users', clientId, { telegram: { ...user.telegram, prefs: next } }));
}

/** What either side may know about the link. */
function summaryFor(user) {
  if (!user) return null;
  const t = user.telegram || null;
  return {
    clientId: user.id,
    username: user.username,
    linked: Boolean(t),
    chatId: t ? t.chatId : null,
    telegramUsername: t ? t.username : null,
    linkedAt: t ? t.linkedAt : null,
    prefs: { ...DEFAULT_PREFS, ...(t ? t.prefs : {}) },
  };
}

// ── the numbers ───────────────────────────────────────────────────────────
const DAY = 86400000;
const startOfTodayUtc = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** A merchant's payments, in windows the bot can say in one message. */
function stats(clientId) {
  const now = Date.now();
  const payments = db.findBy('transactions', { clientId }).filter((t) => t.type === 'DEPOSIT' && t.status === 'CONFIRMED');
  const windowed = (since) => {
    const rows = payments.filter((t) => new Date(t.createdAt).getTime() >= since);
    return { count: rows.length, usd: Number(rows.reduce((s, t) => s + (Number.isFinite(t.usdAmount) ? t.usdAmount : 0), 0).toFixed(2)) };
  };
  const sessions = db.findBy('checkoutSessions', { clientId });
  const openStatuses = new Set(['PENDING', 'AWAITING_PAYMENT', 'VERIFYING']);
  const payouts = db.findBy('payouts', { clientId });
  const wallets = db.findBy('wallets', { clientId }).filter((w) => w.isActive !== false);
  const last = payments.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  return {
    today: windowed(startOfTodayUtc()),
    week: windowed(now - 7 * DAY),
    month: windowed(now - 30 * DAY),
    allTime: windowed(0),
    openCheckouts: sessions.filter((s) => openStatuses.has(s.status)).length,
    wallets: wallets.length,
    balanceUsd: Number(wallets.reduce((s, w) => s + (Number.isFinite(w.balanceUSD) ? w.balanceUSD : Number.isFinite(w.balanceUsd) ? w.balanceUsd : 0), 0).toFixed(2)),
    payouts: { count: payouts.length, completed: payouts.filter((p) => p.status === 'COMPLETED').length },
    lastPayment: last ? { at: last.createdAt, chain: last.chain, asset: last.asset, nativeAmount: last.nativeAmount, usdAmount: last.usdAmount } : null,
  };
}

/** The latest payments, newest first. */
function recent(clientId, limit = 5) {
  return db.findBy('transactions', { clientId })
    .filter((t) => t.type === 'DEPOSIT' && t.status === 'CONFIRMED')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map((t) => ({ at: t.createdAt, chain: t.chain, asset: t.asset, nativeAmount: t.nativeAmount, usdAmount: t.usdAmount, txHash: t.transactionHash, sessionId: t.sessionId }));
}

// ── sending ───────────────────────────────────────────────────────────────
let cachedUsername = process.env.TELEGRAM_BOT_USERNAME || null;
// the tests stand in for the Bot API here
let fetchRef = null;
const doFetch = (...args) => (fetchRef || globalThis.fetch)(...args);

/** The bot's @name, for the deep link: from .env, or asked of Telegram once. */
async function botUsername({ fetchImpl = doFetch } = {}) {
  if (cachedUsername) return cachedUsername;
  if (!enabled()) return null;
  try {
    const res = await fetchImpl(`${API}/bot${token()}/getMe`, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json && json.ok && json.result && json.result.username) cachedUsername = json.result.username;
  } catch (err) {
    logger.warn(`[Telegram] getMe failed: ${err.message}`);
  }
  return cachedUsername;
}

/** One HTML message to one chat. Resolves true when delivered; never throws. */
async function send(chatId, text, { fetchImpl = doFetch } = {}) {
  if (!enabled() || !chatId) return false;
  try {
    const res = await fetchImpl(`${API}/bot${token()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    if (json && json.ok) return true;
    const description = (json && json.description) || `HTTP ${res.status}`;
    // 403: they blocked the bot or deleted the chat; there is nobody to tell any more
    if (res.status === 403 || /blocked|deactivated|chat not found/i.test(description)) {
      const n = unlinkChat(chatId);
      logger.warn(`[Telegram] chat ${chatId} unreachable (${description}); unlinked ${n} account(s)`);
    } else {
      logger.warn(`[Telegram] sendMessage to ${chatId} failed: ${description}`);
    }
    return false;
  } catch (err) {
    logger.warn(`[Telegram] sendMessage to ${chatId} failed: ${err.message}`);
    return false;
  }
}

// ── what merchants hear about ─────────────────────────────────────────────
function paymentText(session, { asset, amount, txHash, usdAmount, underpaid }) {
  const value = usd(usdAmount);
  return [
    `${underpaid ? '⚠️ <b>Payment received - short</b>' : '💸 <b>Payment received</b>'}`,
    `<b>${esc(num(amount))} ${esc(asset)}</b>${value ? ` (${esc(value)})` : ''} on ${esc(session.chain)}`,
    session.reference ? `Reference: ${esc(session.reference)}` : null,
    underpaid ? `Asked: ${esc(num(session.nativeAmount))} ${esc(session.asset || asset)}${usd(session.usdAmount) ? ` (${esc(usd(session.usdAmount))})` : ''}` : null,
    txHash ? `Tx: <code>${esc(short(txHash))}</code>` : null,
    `Checkout: <code>${esc(session.id)}</code>`,
  ].filter(Boolean).join('\n');
}

/** A checkout settled: tell the merchant, if they asked to hear it. */
function notifyPayment(session, payment) {
  if (!enabled() || !session) return Promise.resolve(false);
  const user = db.getById('users', session.clientId);
  if (!user || !user.telegram || !user.telegram.chatId) return Promise.resolve(false);
  const prefs = { ...DEFAULT_PREFS, ...user.telegram.prefs };
  if (!prefs.paid) return Promise.resolve(false);
  return send(user.telegram.chatId, paymentText(session, payment)).catch(() => false);
}

function payoutText(payout) {
  const glyph = { COMPLETED: '✅', PARTIAL: '⚠️', FAILED: '⛔' }[payout.status] || 'ℹ️';
  const word = { COMPLETED: 'Payout completed', PARTIAL: 'Payout partly completed', FAILED: 'Payout failed' }[payout.status] || `Payout ${payout.status}`;
  return [
    `${glyph} <b>${esc(word)}</b>`,
    usd(payout.totalAmountUsd) ? `${esc(usd(payout.totalAmountUsd))}${payout.payoutAsset ? ` as ${esc(payout.payoutAsset)}` : ''} on ${esc(payout.payoutChain || '')}` : null,
    payout.recipientAddress ? `To: <code>${esc(short(payout.recipientAddress))}</code>` : null,
    `Payout: <code>${esc(payout.id)}</code>`,
  ].filter(Boolean).join('\n');
}

/** A payout reached its end: tell the merchant, if they asked to hear it. */
function notifyPayout(payout) {
  if (!enabled() || !payout) return Promise.resolve(false);
  const user = db.getById('users', payout.clientId);
  if (!user || !user.telegram || !user.telegram.chatId) return Promise.resolve(false);
  const prefs = { ...DEFAULT_PREFS, ...user.telegram.prefs };
  if (!prefs.payouts) return Promise.resolve(false);
  return send(user.telegram.chatId, payoutText(payout)).catch(() => false);
}

module.exports = {
  enabled, internalSecret, isInternal, CODE_TTL_MS, DEFAULT_PREFS,
  createLinkCode, consumeLinkCode, accountForChat, unlinkClient, unlinkChat, setPrefs, summaryFor,
  stats, recent, botUsername, send, paymentText, payoutText, notifyPayment, notifyPayout,
  _setBotUsername: (u) => { cachedUsername = u; },
  _setFetch: (fn) => { fetchRef = fn; },
};
