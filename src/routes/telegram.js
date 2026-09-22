'use strict';

/**
 * Telegram for merchants, two routers.
 *
 * `merchant` sits behind the usual credential, under /api/telegram: the
 * dashboard reads the link, mints the code that starts one, drops it, and
 * sets what the merchant wants to hear about.
 *
 * `internal` is the bot's side, under /api/telegram/internal, guarded by
 * the secret derived from the bot token (TelegramNotifyService): the bot
 * hands a code back with the chat it came from, asks who a chat belongs
 * to, and fetches a merchant's numbers for /stats and /recent.
 */

const { Router } = require('express');
const Telegram = require('../services/TelegramNotifyService');

// ── the merchant's side ───────────────────────────────────────────────────
const merchant = Router();

merchant.get('/', async (req, res) => {
  const { db } = require('../config/database');
  const summary = Telegram.summaryFor(db.getById('users', req.auth.clientId));
  res.json({ success: true, enabled: Telegram.enabled(), botUsername: await Telegram.botUsername(), ...summary });
});

merchant.post('/link-code', async (req, res) => {
  if (!Telegram.enabled()) return res.status(503).json({ success: false, message: 'Telegram notifications are not set up on this server.' });
  const bot = await Telegram.botUsername();
  const { code, expiresAt } = Telegram.createLinkCode(req.auth.clientId);
  res.json({ success: true, code, expiresAt, botUsername: bot, url: bot ? `https://t.me/${bot}?start=link_${code}` : null });
});

merchant.delete('/link', (req, res) => {
  res.json({ success: true, unlinked: Telegram.unlinkClient(req.auth.clientId) });
});

merchant.put('/preferences', (req, res) => {
  const body = req.body || {};
  const prefs = {};
  for (const key of Object.keys(Telegram.DEFAULT_PREFS)) if (typeof body[key] === 'boolean') prefs[key] = body[key];
  const summary = Telegram.setPrefs(req.auth.clientId, prefs);
  if (!summary) return res.status(409).json({ success: false, message: 'Connect Telegram first.' });
  res.json({ success: true, ...summary });
});

// ── the bot's side ────────────────────────────────────────────────────────
const internal = Router();

internal.use((req, res, next) => {
  if (!Telegram.enabled()) return res.status(503).json({ success: false, message: 'TELEGRAM_BOT_TOKEN is not set on the API' });
  if (!Telegram.isInternal(req.get('x-internal-secret'))) return res.status(401).json({ success: false, message: 'Not the bot' });
  return next();
});

const chatOf = (value) => (/^-?\d+$/.test(String(value || '')) ? Number(value) : null);

internal.post('/link', (req, res) => {
  const { code, chatId, username, firstName } = req.body || {};
  const chat = chatOf(chatId);
  if (!code || !chat) return res.status(400).json({ success: false, message: 'code and chatId are required' });
  const result = Telegram.consumeLinkCode(code, { chatId: chat, username: username || null, firstName: firstName || null });
  if (result.error) return res.status(result.error === 'expired' ? 410 : 404).json({ success: false, error: result.error, message: result.message });
  res.json({ success: true, account: result.account });
});

internal.post('/unlink', (req, res) => {
  const chat = chatOf((req.body || {}).chatId);
  if (!chat) return res.status(400).json({ success: false, message: 'chatId is required' });
  res.json({ success: true, unlinked: Telegram.unlinkChat(chat) });
});

/** Who a chat belongs to, or 404: the bot's way of knowing whether /stats means anything here. */
internal.get('/account', (req, res) => {
  const chat = chatOf(req.query.chatId);
  const user = chat ? Telegram.accountForChat(chat) : null;
  if (!user) return res.status(404).json({ success: false, message: 'No account is linked to that chat' });
  res.json({ success: true, account: Telegram.summaryFor(user) });
});

internal.get('/stats', (req, res) => {
  const chat = chatOf(req.query.chatId);
  const user = chat ? Telegram.accountForChat(chat) : null;
  if (!user) return res.status(404).json({ success: false, message: 'No account is linked to that chat' });
  res.json({ success: true, account: Telegram.summaryFor(user), stats: Telegram.stats(user.id) });
});

internal.get('/recent', (req, res) => {
  const chat = chatOf(req.query.chatId);
  const user = chat ? Telegram.accountForChat(chat) : null;
  if (!user) return res.status(404).json({ success: false, message: 'No account is linked to that chat' });
  res.json({ success: true, account: Telegram.summaryFor(user), payments: Telegram.recent(user.id, req.query.limit) });
});

internal.put('/preferences', (req, res) => {
  const { chatId, prefs } = req.body || {};
  const chat = chatOf(chatId);
  const user = chat ? Telegram.accountForChat(chat) : null;
  if (!user) return res.status(404).json({ success: false, message: 'No account is linked to that chat' });
  res.json({ success: true, account: Telegram.setPrefs(user.id, prefs || {}) });
});

module.exports = { merchant, internal };
