'use strict';

/**
 * Moderation in the group. An admin replies to a message with a command -
 * /ban, /kick, /mute 1h, /unmute, /warn, /del, /purge - and the bot acts
 * on the person who wrote it. Who counts as an admin is Telegram's own
 * answer (creator or administrator of that chat), plus anyone listed in
 * TELEGRAM_ADMIN_IDS, remembered for a minute so a busy chat does not
 * ask Telegram on every command. Every action is a card in the staff
 * chat when there is one.
 */

const { parseDuration, formatDuration, UNITS } = require('../../src/utils/duration');
const { NO_PERMISSIONS, FULL_PERMISSIONS } = require('./api');
const { esc, b, code, mention, who, card, cut } = require('./format');

const ADMIN_TTL_MS = 60000;
const adminCache = new Map();

/** "/mute@EtherouteBot 1h too loud" → { name: 'mute', args: '1h too loud', argv: ['1h', 'too', 'loud'] }; null when not a command. */
function parseCommand(text, botUsername) {
  const m = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // for another bot
  const args = (m[3] || '').trim();
  return { name: m[1].toLowerCase(), args, argv: args ? args.split(/\s+/) : [] };
}

/** Whether `userId` may moderate `chatId`: listed, or an admin of the chat according to Telegram. */
async function isAdmin(ctx, chatId, userId) {
  if (!userId) return false;
  if (ctx.config.adminIds.includes(Number(userId))) return true;
  const key = `${chatId}:${userId}`;
  const cached = adminCache.get(key);
  if (cached && cached.until > Date.now()) return cached.admin;
  let admin = false;
  try {
    const m = await ctx.api.getChatMember(chatId, userId);
    admin = m && (m.status === 'creator' || m.status === 'administrator');
  } catch { admin = false; }
  adminCache.set(key, { admin, until: Date.now() + ADMIN_TTL_MS });
  if (adminCache.size > 1000) adminCache.clear();
  return admin;
}

/** A card to the staff chat, if there is one. Never throws. */
async function modLog(ctx, text) {
  if (!ctx.config.logChatId) return false;
  try {
    await ctx.api.sendMessage(ctx.config.logChatId, text);
    return true;
  } catch (err) {
    ctx.log.warn('staff-chat post failed:', err.description || err.message);
    return false;
  }
}

/** The person a command is about: the author of the message it replies to. */
function targetOf(message) {
  const r = message.reply_to_message;
  if (!r) return null;
  if (r.sender_chat) return null; // a channel post or an anonymous admin: not a person to act on
  return r.from || null;
}

const warnKey = (chatId, userId) => `${chatId}:${userId}`;
const warningsFor = (ctx, chatId, userId) => ((ctx.store.data.warnings || {})[warnKey(chatId, userId)] || []).slice();

/**
 * The group commands. Each returns the reply to send in the group (HTML),
 * or null to say nothing. `message` is the command message; the person
 * running it has already been checked as an admin.
 */
const commands = {
  async ban(ctx, message, cmd) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person to ban.';
    if (await isAdmin(ctx, message.chat.id, target.id)) return 'Not on an admin.';
    const reason = cmd.args || 'No reason given';
    await ctx.api.banChatMember(message.chat.id, target.id, { revoke_messages: false });
    await ctx.api.deleteMessage(message.chat.id, message.reply_to_message.message_id).catch(() => {});
    await modLog(ctx, card('🔨 Banned', [['Member', who(target)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)], ['Reason', esc(reason)]]));
    ctx.log.info(`banned ${target.id} in ${message.chat.id} by ${message.from.id}: ${reason}`);
    return `${mention(target)} was banned. ${esc(reason)}`;
  },

  async kick(ctx, message, cmd) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person to kick.';
    if (await isAdmin(ctx, message.chat.id, target.id)) return 'Not on an admin.';
    const reason = cmd.args || 'No reason given';
    // a kick is a ban lifted at once: they may come back with the link
    await ctx.api.banChatMember(message.chat.id, target.id);
    await ctx.api.unbanChatMember(message.chat.id, target.id);
    await modLog(ctx, card('👢 Kicked', [['Member', who(target)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)], ['Reason', esc(reason)]]));
    ctx.log.info(`kicked ${target.id} from ${message.chat.id} by ${message.from.id}: ${reason}`);
    return `${mention(target)} was removed. ${esc(reason)}`;
  },

  async mute(ctx, message, cmd) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person to mute, with how long: /mute 1h spamming';
    if (await isAdmin(ctx, message.chat.id, target.id)) return 'Not on an admin.';
    let ms = cmd.argv.length ? parseDuration(cmd.argv[0]) : null;
    const reason = (ms ? cmd.argv.slice(1) : cmd.argv).join(' ') || 'No reason given';
    if (!ms) ms = UNITS.h; // Telegram: under 30s or over a year means forever, so a plain /mute is an hour
    const forever = ms > 366 * UNITS.d;
    const until = forever ? 0 : Math.floor((Date.now() + Math.max(ms, 30000)) / 1000);
    await ctx.api.restrictChatMember(message.chat.id, target.id, NO_PERMISSIONS, until || undefined);
    const how = forever ? 'until unmuted' : `for ${formatDuration(ms)}`;
    await modLog(ctx, card('🔇 Muted', [['Member', who(target)], ['For', forever ? 'until unmuted' : formatDuration(ms)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)], ['Reason', esc(reason)]]));
    ctx.log.info(`muted ${target.id} in ${message.chat.id} ${how} by ${message.from.id}: ${reason}`);
    return `${mention(target)} is muted ${how}. ${esc(reason)}`;
  },

  async unmute(ctx, message) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person to unmute.';
    await ctx.api.restrictChatMember(message.chat.id, target.id, ctx.chatPermissions || FULL_PERMISSIONS);
    await modLog(ctx, card('🔊 Unmuted', [['Member', who(target)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)]]));
    return `${mention(target)} can talk again.`;
  },

  async warn(ctx, message, cmd) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person to warn, with the reason.';
    if (await isAdmin(ctx, message.chat.id, target.id)) return 'Not on an admin.';
    const reason = cmd.args || 'No reason given';
    let count = 0;
    ctx.store.update('warnings', (all) => {
      const list = all[warnKey(message.chat.id, target.id)] || (all[warnKey(message.chat.id, target.id)] = []);
      list.push({ reason, by: message.from.id, at: new Date().toISOString() });
      count = list.length;
    });
    await modLog(ctx, card('⚠️ Warned', [['Member', who(target)], ['Warnings now', String(count)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)], ['Reason', esc(reason)]]));
    return `${mention(target)}, this is a warning (${count} on record): ${esc(reason)}`;
  },

  async warnings(ctx, message) {
    const target = targetOf(message) || message.from;
    const list = warningsFor(ctx, message.chat.id, target.id);
    if (!list.length) return `${mention(target)} has no warnings on record.`;
    return cut([b(`Warnings for ${[target.first_name, target.last_name].filter(Boolean).join(' ') || target.id}`), ...list.slice(-10).map((w, n) => `${n + 1}. ${esc(w.reason)} - ${esc(w.at.slice(0, 10))}`)].join('\n'));
  },

  async clearwarnings(ctx, message) {
    const target = targetOf(message);
    if (!target) return 'Reply to a message from the person whose warnings to clear.';
    const had = warningsFor(ctx, message.chat.id, target.id).length;
    ctx.store.update('warnings', (all) => { delete all[warnKey(message.chat.id, target.id)]; });
    await modLog(ctx, card('🧽 Warnings cleared', [['Member', who(target)], ['Cleared', String(had)], ['By', who(message.from)]]));
    return `${mention(target)}'s ${had} warning(s) were cleared.`;
  },

  async del(ctx, message) {
    const r = message.reply_to_message;
    if (!r) return 'Reply to the message to delete.';
    await ctx.api.deleteMessage(message.chat.id, r.message_id);
    await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => {});
    await modLog(ctx, card('🗑️ Message deleted', [['Author', r.from ? who(r.from) : esc(r.sender_chat ? r.sender_chat.title : 'unknown')], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)], ['Text', r.text ? code(r.text.slice(0, 500)) : '(no text)']]));
    return null;
  },

  /** Everything from the replied-to message up to the command: message ids in a chat are sequential. */
  async purge(ctx, message) {
    const r = message.reply_to_message;
    if (!r) return 'Reply to the first message to delete; everything from it to here goes.';
    const from = r.message_id;
    const to = message.message_id;
    if (to - from > 100) return 'That is more than 100 messages; purge in smaller stretches.';
    const ids = [];
    for (let id = from; id <= to; id += 1) ids.push(id);
    let deleted = 0;
    // deleteMessages takes up to 100 at once and fails as a whole if one id is gone, so fall back one by one
    try {
      await ctx.api.deleteMessages(message.chat.id, ids);
      deleted = ids.length;
    } catch {
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        if (await ctx.api.deleteMessage(message.chat.id, id).then(() => true).catch(() => false)) deleted += 1;
      }
    }
    await modLog(ctx, card('🧹 Purged', [['Messages', String(deleted)], ['By', who(message.from)], ['Chat', esc(message.chat.title || message.chat.id)]]));
    ctx.log.info(`purged ${deleted} message(s) in ${message.chat.id} by ${message.from.id}`);
    const note = await ctx.api.sendMessage(message.chat.id, `Deleted ${deleted} message(s).`).catch(() => null);
    if (note) setTimeout(() => ctx.api.deleteMessage(message.chat.id, note.message_id).catch(() => {}), 5000);
    return null;
  },

  async pin(ctx, message) {
    const r = message.reply_to_message;
    if (!r) return 'Reply to the message to pin.';
    await ctx.api.pinChatMessage(message.chat.id, r.message_id, false);
    return null;
  },

  async unpin(ctx, message) {
    const r = message.reply_to_message;
    await ctx.api.unpinChatMessage(message.chat.id, r ? r.message_id : undefined);
    return null;
  },
};

/** The ids a person needs to set the bot up; works for anyone, anywhere. */
function idText(message) {
  const r = message.reply_to_message;
  const rows = [
    ['This chat', code(message.chat.id) + (message.chat.title ? ` - ${esc(message.chat.title)}` : '')],
    ['You', code(message.from.id)],
    r && r.from ? ['Them', `${code(r.from.id)} - ${who(r.from)}`] : null,
    r && r.sender_chat ? ['Posted as', `${code(r.sender_chat.id)} - ${esc(r.sender_chat.title || '')}`] : null,
    r && r.forward_origin && r.forward_origin.chat ? ['Forwarded from', `${code(r.forward_origin.chat.id)} - ${esc(r.forward_origin.chat.title || '')}`] : null,
  ];
  return card('Ids', rows);
}

module.exports = { parseCommand, isAdmin, modLog, targetOf, warningsFor, commands, idText, ADMIN_TTL_MS, adminCache };
