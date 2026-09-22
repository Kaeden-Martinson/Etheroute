'use strict';

/**
 * The Telegram bot, assembled. Updates come in from the poller and go one
 * of four ways:
 *
 *   a private chat   - /start, /help, /status, /rules, /id, /support and
 *                      the support relay; /announce for admins; and for
 *                      merchants who linked their account, /stats,
 *                      /recent, /notify and /unlink
 *   the group        - the gate on newcomers, the link filter, and the
 *                      admin commands (/ban, /mute, /warn, /purge, ...)
 *   the staff chat   - replies to relayed tickets, /close
 *   a button press   - the newcomer's "I am a person", the announcer's
 *                      Post / Cancel
 *
 * The channel itself is written to, never read: the status pin and the
 * announcements. index.js starts it; the tests build it without a token
 * and feed it updates.
 */

const { Api, Poller, FULL_PERMISSIONS } = require('./lib/api');
const { Store } = require('../src/utils/jsonStore');
const { esc, b, i, code, card, cut, who } = require('./lib/format');
const status = require('./lib/status');
const announce = require('./lib/announce');
const verify = require('./lib/verify');
const support = require('./lib/support');
const moderation = require('./lib/moderation');
const merchant = require('./lib/merchant');
const { rulesText } = require('./lib/rules');

const PRIVATE_COMMANDS = [
  { command: 'start', description: 'What this bot does' },
  { command: 'status', description: 'How Etheroute is doing right now' },
  { command: 'stats', description: 'Merchants: your payments, in numbers' },
  { command: 'recent', description: 'Merchants: your last payments' },
  { command: 'notify', description: 'Merchants: what I message you about' },
  { command: 'support', description: 'Open a support ticket with the team' },
  { command: 'rules', description: 'The community rules' },
  { command: 'id', description: 'Your id, and this chat\'s' },
  { command: 'help', description: 'Every command' },
];
const GROUP_COMMANDS = [
  { command: 'rules', description: 'The community rules' },
  { command: 'status', description: 'How Etheroute is doing right now' },
  { command: 'id', description: 'Ids for this chat and, in a reply, that person' },
  { command: 'help', description: 'Every command' },
];
const ADMIN_COMMANDS = [
  ...GROUP_COMMANDS,
  { command: 'ban', description: 'Reply to ban that person' },
  { command: 'kick', description: 'Reply to remove that person; they can rejoin' },
  { command: 'mute', description: 'Reply with a time (1h, 1d) to mute that person' },
  { command: 'unmute', description: 'Reply to lift a mute' },
  { command: 'warn', description: 'Reply with a reason to warn that person' },
  { command: 'warnings', description: 'Reply to see their warnings' },
  { command: 'del', description: 'Reply to delete that message' },
  { command: 'purge', description: 'Reply to delete from that message to here' },
  { command: 'pin', description: 'Reply to pin that message' },
];

const sameChat = (a, b) => a !== '' && b !== undefined && b !== null && String(a) === String(b);

function createBot(config, { log = require('./lib/log'), store = new Store(config.dataFile), api = new Api(config.token) } = {}) {
  const ctx = { config, store, log, api, me: null, chatPermissions: null, status: {} };
  let poller = null;

  // ── helpers ───────────────────────────────────────────────────────────
  const reply = (message, text, extra = {}) => ctx.api.sendMessage(message.chat.id, text, { reply_parameters: { message_id: message.message_id }, ...extra }).catch((err) => log.warn('reply failed:', err.description || err.message));
  const isGroup = (chat) => chat && (chat.type === 'group' || chat.type === 'supergroup');
  const isStaffChat = (chat) => isGroup(chat) && (sameChat(config.supportChatId, chat.id) || sameChat(config.logChatId, chat.id));
  // with no group configured, any group the bot is in is the community's - except the staff chat
  const isOurGroup = (chat) => isGroup(chat) && (config.groupId ? sameChat(config.groupId, chat.id) : !isStaffChat(chat));

  function helpText(admin) {
    const rows = [b(`${config.brand.name} bot`), ''];
    rows.push(b('Anyone'), '/status - how the platform and networks are doing', '/rules - the community rules', '/support - open a ticket with the team (in a private chat with me)', '/id - ids for this chat and, in a reply, that person');
    rows.push('', b('Merchants, in a private chat with me'), 'Connect from the dashboard (Account → Notifications) and I message you when a payment settles or a payout finishes.', '/stats - your numbers · /recent - the last payments · /notify - what you hear about · /unlink');
    if (admin) rows.push('', b('Admins, in the group, as a reply to a message'), '/ban [reason] · /kick [reason] · /mute 1h [reason] · /unmute', '/warn reason · /warnings · /clearwarnings', '/del · /purge · /pin · /unpin', '', b('Admins, in a private chat with me'), '/announce Headline⏎body - a preview, then a Post button, then the channel');
    return rows.join('\n');
  }

  // ── private chats ────────────────────────────────────────────────────
  async function onPrivate(message) {
    const cmd = moderation.parseCommand(message.text, ctx.me && ctx.me.username);
    if (!cmd) {
      if (message.text || message.caption || message.photo || message.document || message.video || message.voice) return support.onUserMessage(ctx, message);
      return null;
    }
    switch (cmd.name) {
      case 'start': {
        // the dashboard's deep link: t.me/<bot>?start=link_<code>
        const linkCode = merchant.linkCodeFrom(cmd.args);
        if (linkCode) return merchant.link(ctx, message, linkCode);
      }
      // falls through
      case 'help': {
        const admin = await moderation.isAdmin(ctx, config.postChatId, message.from.id);
        return ctx.api.sendMessage(message.chat.id, `${cmd.name === 'start' ? `Hello, ${esc(message.from.first_name || 'there')}. I keep ${b(config.brand.name)}'s channel and group: status, announcements, the gate on newcomers, and support tickets.\n\n` : ''}${helpText(admin)}`);
      }
      case 'status': {
        const picture = require('../src/utils/statusPicture');
        const summary = picture.summarise(await picture.gather(config));
        return ctx.api.sendMessage(message.chat.id, status.statusText(summary, config));
      }
      case 'rules': return ctx.api.sendMessage(message.chat.id, rulesText(config, { botUsername: ctx.me && ctx.me.username }));
      case 'id': return ctx.api.sendMessage(message.chat.id, moderation.idText(message));
      case 'support': return support.start(ctx, message);
      case 'stats': return merchant.stats(ctx, message);
      case 'recent': return merchant.recent(ctx, message, Number(cmd.argv[0]) || 5);
      case 'notify': return merchant.notify(ctx, message, cmd);
      case 'unlink': return merchant.unlink(ctx, message);
      case 'announce': {
        if (!(await moderation.isAdmin(ctx, config.postChatId, message.from.id))) return ctx.api.sendMessage(message.chat.id, 'Only an admin of the channel (or group) can announce.');
        return announce.start(ctx, message, cmd.args);
      }
      default:
        return support.onUserMessage(ctx, message); // an unknown "/thing" from a person is still a message to the team
    }
  }

  // ── the group ─────────────────────────────────────────────────────────
  async function onGroup(message) {
    if (message.new_chat_members && message.new_chat_members.length) {
      for (const user of message.new_chat_members) await verify.onJoin(ctx, message.chat.id, user);
      return 'joined';
    }
    if (message.left_chat_member) return null;
    if (!message.from) return null;

    const swept = await verify.onMessage(ctx, message);
    if (swept) return swept;

    const cmd = moderation.parseCommand(message.text, ctx.me && ctx.me.username);
    if (!cmd) return null;
    if (cmd.name === 'rules') return reply(message, rulesText(config, { botUsername: ctx.me && ctx.me.username }));
    if (cmd.name === 'id') return reply(message, moderation.idText(message));
    if (cmd.name === 'status') {
      const picture = require('../src/utils/statusPicture');
      const summary = picture.summarise(await picture.gather(config));
      return reply(message, status.statusText(summary, config));
    }
    if (cmd.name === 'help') return reply(message, helpText(await moderation.isAdmin(ctx, message.chat.id, message.from.id)));
    if (cmd.name === 'support') return reply(message, `Message me privately - ${ctx.me ? `@${esc(ctx.me.username)}` : 'the bot'} - and write /support there, so your ticket stays between you and the team.`);

    const handler = moderation.commands[cmd.name];
    if (!handler) return null;
    if (!(await moderation.isAdmin(ctx, message.chat.id, message.from.id))) return null; // not theirs to run; say nothing
    const text = await handler(ctx, message, cmd);
    if (text) await reply(message, text);
    return cmd.name;
  }

  // ── the staff chat ────────────────────────────────────────────────────
  async function onStaff(message) {
    if (!message.from || !message.reply_to_message) return null;
    const cmd = moderation.parseCommand(message.text, ctx.me && ctx.me.username);
    return support.onStaffMessage(ctx, message, cmd);
  }

  // ── one update ────────────────────────────────────────────────────────
  async function handle(update) {
    if (update.message) {
      const m = update.message;
      if (m.chat.type === 'private') return onPrivate(m);
      if (isStaffChat(m.chat)) {
        const staff = await onStaff(m);
        if (staff) return staff;
        if (!isOurGroup(m.chat)) return null; // the staff chat is not the community group: nothing else to do there
      }
      if (isOurGroup(m.chat)) return onGroup(m);
      return null;
    }
    if (update.callback_query) {
      const q = update.callback_query;
      const data = q.data || '';
      if (data.startsWith(verify.PREFIX)) return verify.onButton(ctx, q);
      if (data.startsWith(announce.PREFIX)) return announce.onButton(ctx, q);
      return ctx.api.answerCallbackQuery(q.id).catch(() => {});
    }
    if (update.chat_member) {
      const cm = update.chat_member;
      if (!isOurGroup(cm.chat)) return null;
      const was = cm.old_chat_member && cm.old_chat_member.status;
      const now = cm.new_chat_member && cm.new_chat_member.status;
      const user = cm.new_chat_member && cm.new_chat_member.user;
      const gone = ['left', 'kicked'];
      if (gone.includes(was) && !gone.includes(now) && now !== 'restricted') {
        // a join we did not see as a service message (large groups hide those)
        if (!verify.isPending(ctx, cm.chat.id, user.id) && !verify.joinedAt(ctx, cm.chat.id, user.id)) return verify.onJoin(ctx, cm.chat.id, user);
        return null;
      }
      if (!gone.includes(was) && gone.includes(now)) {
        await moderation.modLog(ctx, card(now === 'kicked' ? '🚪 Removed' : '📤 Left', [['Member', who(user)], ['Chat', esc(cm.chat.title || cm.chat.id)], now === 'kicked' && cm.from ? ['By', who(cm.from)] : null]));
        return 'left';
      }
      return null;
    }
    if (update.my_chat_member) {
      const cm = update.my_chat_member;
      const now = cm.new_chat_member.status;
      log.info(`I am now "${now}" in ${cm.chat.type} "${cm.chat.title || cm.chat.username || ''}" (${cm.chat.id})${now === 'administrator' ? '' : now === 'member' ? ' - make me an admin for the gate and moderation to work' : ''}`);
      return 'me';
    }
    return null;
  }

  // ── start ─────────────────────────────────────────────────────────────
  async function settle() {
    ctx.me = await ctx.api.getMe();
    log.info(`signed in as @${ctx.me.username} (${ctx.me.id})`);
    const channel = config.channelId ? await ctx.api.getChat(config.channelId).catch((err) => { log.error(`cannot see the channel ${config.channelId}: ${err.description || err.message}. Add me to it as an admin who can post, edit and pin.`); return null; }) : null;
    if (!config.channelId) log.info('channel   → none; the status pin and announcements go to the group');
    if (channel) {
      log.info(`channel   → ${channel.title || channel.username} (${channel.id})${channel.linked_chat_id ? `, discussion group ${channel.linked_chat_id}` : ''}`);
      if (!config.groupId && channel.linked_chat_id) { config.groupId = String(channel.linked_chat_id); log.info(`group     → the channel's discussion group (${config.groupId}); set TELEGRAM_GROUP_ID to use another`); }
      const me = await ctx.api.getChatMember(channel.id, ctx.me.id).catch(() => null);
      if (!me || me.status !== 'administrator') log.warn('I am not an admin of the channel; I cannot post the status pin or announcements there');
      else if (!me.can_post_messages || !me.can_edit_messages) log.warn('in the channel I need "Post messages" and "Edit messages of others" (and "Pin messages" for the status pin)');
    }
    if (config.groupId) {
      const group = await ctx.api.getChat(config.groupId).catch((err) => { log.error(`cannot see the group ${config.groupId}: ${err.description || err.message}`); return null; });
      if (group) {
        log.info(`group     → ${group.title} (${group.id})`);
        ctx.chatPermissions = group.permissions || FULL_PERMISSIONS;
        const me = await ctx.api.getChatMember(group.id, ctx.me.id).catch(() => null);
        if (!me || me.status !== 'administrator') log.warn('I am not an admin of the group; the gate, the link filter and the moderation commands will not work');
        else if (!me.can_restrict_members || !me.can_delete_messages) log.warn('in the group I need "Ban users" (restrict members) and "Delete messages"');
      }
    } else log.info('group     → none (set TELEGRAM_GROUP_ID, or link a discussion group to the channel)');
    if (config.logChatId) log.info(`staff     → ${config.logChatId}${config.supportChatId !== config.logChatId ? ` (support relay in ${config.supportChatId})` : ' (mod-log and support relay)'}`);
    else log.info('staff     → none (set TELEGRAM_LOG_CHAT_ID to a private group for the mod-log and support tickets)');

    await ctx.api.setMyCommands(PRIVATE_COMMANDS, { type: 'all_private_chats' }).catch(() => {});
    await ctx.api.setMyCommands(GROUP_COMMANDS, { type: 'all_group_chats' }).catch(() => {});
    await ctx.api.setMyCommands(ADMIN_COMMANDS, { type: 'all_chat_administrators' }).catch(() => {});
    return ctx.me;
  }

  async function start() {
    await settle();
    verify.resume(ctx);
    await status.start(ctx);
    poller = new Poller(ctx.api, handle, { log });
    log.info('listening');
    return poller.start();
  }

  function stop() {
    status.stop();
    if (poller) poller.stop();
  }

  return { ctx, api: ctx.api, handle, settle, start, stop, helpText, PRIVATE_COMMANDS, GROUP_COMMANDS, ADMIN_COMMANDS };
}

module.exports = { createBot, PRIVATE_COMMANDS, GROUP_COMMANDS, ADMIN_COMMANDS };
