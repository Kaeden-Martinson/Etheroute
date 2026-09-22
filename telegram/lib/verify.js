'use strict';

/**
 * The gate on the group. Whoever joins is muted on the spot and shown a
 * welcome with one button; pressing it - which a person can and a spam
 * bot mostly cannot - lifts the mute. Ten minutes without a press and
 * they are shown out (a ban lifted at once, so they can try again). While
 * they wait, anything they manage to post is deleted.
 *
 * For a day after joining, a message with a link, a @channel or a
 * forward from a channel is treated as the spam it almost always is:
 * deleted, and the sender muted for an hour. Admins are never touched.
 */

const { NO_PERMISSIONS, FULL_PERMISSIONS } = require('./api');
const { esc, b, mention, who, card } = require('./format');
const { isAdmin, modLog } = require('./moderation');

const PREFIX = 'verify:';
const TELEGRAM_SERVICE_ID = 777000;
const timers = new Map();

const buttonFor = (userId) => ({ inline_keyboard: [[{ text: '✅ I am a person', callback_data: `${PREFIX}${userId}` }]] });
const pendingKey = (chatId, userId) => `${chatId}:${userId}`;

function welcomeText(user, config) {
  const minutes = Math.round(config.verify.timeoutMs / 60000);
  return [
    `👋 Welcome to ${b(config.brand.name)}, ${mention(user)}!`,
    '',
    `Press the button below to prove you are a person and you can talk. You have ${b(`${minutes} minutes`)}.`,
    '',
    `Then: /rules for the short list, and message me privately with /support if you need the team.`,
  ].join('\n');
}

/** Someone joined: mute them, greet them, start the clock. */
async function onJoin(ctx, chatId, user) {
  if (!user || user.is_bot) return false;
  if (await isAdmin(ctx, chatId, user.id)) return false;
  await ctx.api.restrictChatMember(chatId, user.id, NO_PERMISSIONS).catch((err) => ctx.log.warn(`could not mute newcomer ${user.id}:`, err.description || err.message));
  const sent = await ctx.api.sendMessage(chatId, welcomeText(user, ctx.config), { reply_markup: buttonFor(user.id) }).catch(() => null);
  const record = { chatId, userId: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username || null, messageId: sent ? sent.message_id : null, at: Date.now() };
  ctx.store.update('pending', (p) => { p[pendingKey(chatId, user.id)] = record; });
  ctx.store.update('joined', (j) => { j[pendingKey(chatId, user.id)] = Date.now(); if (Object.keys(j).length > 5000) for (const k of Object.keys(j).slice(0, 1000)) delete j[k]; });
  schedule(ctx, record);
  ctx.log.info(`newcomer ${who(user).replace(/<[^>]+>/g, '')} in ${chatId}: waiting for the button`);
  return true;
}

function schedule(ctx, record) {
  const key = pendingKey(record.chatId, record.userId);
  clear(key);
  const wait = Math.max(0, record.at + ctx.config.verify.timeoutMs - Date.now());
  const t = setTimeout(() => expire(ctx, record).catch((err) => ctx.log.warn('verify expiry failed:', err.message)), wait);
  if (typeof t.unref === 'function') t.unref(); // the poller keeps the process up; a clock alone should not
  timers.set(key, t);
}

function clear(key) {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
}

/** The clock ran out: out they go, and the welcome goes with them. */
async function expire(ctx, record) {
  const key = pendingKey(record.chatId, record.userId);
  if (!(ctx.store.data.pending || {})[key]) return false;
  ctx.store.update('pending', (p) => { delete p[key]; });
  clear(key);
  await ctx.api.banChatMember(record.chatId, record.userId).catch(() => {});
  await ctx.api.unbanChatMember(record.chatId, record.userId).catch(() => {});
  if (record.messageId) await ctx.api.deleteMessage(record.chatId, record.messageId).catch(() => {});
  await modLog(ctx, card('⌛ Did not verify', [['Member', `${esc(record.name || '(no name)')}${record.username ? ` (@${esc(record.username)})` : ''} <code>${record.userId}</code>`], ['Chat', String(record.chatId)], ['Waited', `${Math.round(ctx.config.verify.timeoutMs / 60000)} min`]]));
  ctx.log.info(`newcomer ${record.userId} did not press the button in time; removed from ${record.chatId}`);
  return true;
}

/** The button was pressed. */
async function onButton(ctx, query) {
  const userId = Number(query.data.slice(PREFIX.length));
  const chatId = query.message && query.message.chat && query.message.chat.id;
  if (query.from.id !== userId) {
    await ctx.api.answerCallbackQuery(query.id, { text: 'That button is for someone else.', show_alert: false });
    return false;
  }
  const key = pendingKey(chatId, userId);
  const record = (ctx.store.data.pending || {})[key];
  clear(key);
  ctx.store.update('pending', (p) => { delete p[key]; });
  await ctx.api.restrictChatMember(chatId, userId, ctx.chatPermissions || FULL_PERMISSIONS).catch((err) => ctx.log.warn(`could not unmute ${userId}:`, err.description || err.message));
  await ctx.api.answerCallbackQuery(query.id, { text: 'Welcome in!' });
  if (query.message) {
    await ctx.api.editMessageText(chatId, query.message.message_id, `✅ Welcome, ${mention(query.from)}. Have a look at /rules; message me privately with /support if you need the team.`).catch(() => {});
    setTimeout(() => ctx.api.deleteMessage(chatId, query.message.message_id).catch(() => {}), 60000);
  }
  ctx.log.info(`verified ${userId} in ${chatId}${record ? '' : ' (no record; lifted anyway)'}`);
  return true;
}

const isPending = (ctx, chatId, userId) => Boolean((ctx.store.data.pending || {})[pendingKey(chatId, userId)]);
const joinedAt = (ctx, chatId, userId) => (ctx.store.data.joined || {})[pendingKey(chatId, userId)] || null;

const LINK = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|@[a-zA-Z0-9_]{5,}|\.(com|net|org|io|xyz|app|finance|cash|money)\b)/i;

/**
 * A message from a newcomer that should not stand: anything while they
 * are still unverified, or a link in their first day. Returns what was
 * done, or null. Admins, channel posts and Telegram itself are left alone.
 */
async function onMessage(ctx, message) {
  const user = message.from;
  const chatId = message.chat.id;
  if (!user || user.is_bot || message.sender_chat || user.id === TELEGRAM_SERVICE_ID || message.is_automatic_forward) return null;
  if (isPending(ctx, chatId, user.id)) {
    await ctx.api.deleteMessage(chatId, message.message_id).catch(() => {});
    return 'deleted:unverified';
  }
  const joined = joinedAt(ctx, chatId, user.id);
  if (!joined || Date.now() - joined > ctx.config.verify.linkGraceMs) return null;
  const text = `${message.text || message.caption || ''}`;
  const forwardedFromChannel = message.forward_origin && message.forward_origin.type === 'channel';
  const hasLinkEntity = [...(message.entities || []), ...(message.caption_entities || [])].some((e) => e.type === 'url' || e.type === 'text_link' || e.type === 'mention');
  if (!forwardedFromChannel && !hasLinkEntity && !LINK.test(text)) return null;
  if (await isAdmin(ctx, chatId, user.id)) return null;
  await ctx.api.deleteMessage(chatId, message.message_id).catch(() => {});
  await ctx.api.restrictChatMember(chatId, user.id, NO_PERMISSIONS, Math.floor(Date.now() / 1000) + 3600).catch(() => {});
  await modLog(ctx, card('🚫 Link from a newcomer', [['Member', who(user)], ['Chat', esc(message.chat.title || chatId)], ['Did', 'deleted the message, muted for 1h'], ['Text', text ? `<code>${esc(text.slice(0, 300))}</code>` : forwardedFromChannel ? '(a forwarded channel post)' : '(no text)']]));
  ctx.log.info(`newcomer ${user.id} posted a link in ${chatId} within the grace period; deleted and muted for an hour`);
  return 'deleted:link';
}

/** After a restart: every newcomer still waiting gets their clock back. */
function resume(ctx) {
  const pending = Object.values(ctx.store.data.pending || {});
  for (const record of pending) schedule(ctx, record);
  if (pending.length) ctx.log.info(`resumed ${pending.length} newcomer(s) waiting to verify`);
  return pending.length;
}

module.exports = { PREFIX, welcomeText, buttonFor, onJoin, onButton, onMessage, expire, resume, isPending, joinedAt, LINK, schedule, clear, TELEGRAM_SERVICE_ID };
