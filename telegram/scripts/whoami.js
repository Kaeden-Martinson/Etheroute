#!/usr/bin/env node
/**
 * A look before the bot runs: who it is, whether it can see the channel,
 * the group and the staff chat from .env and what it may do in each, and
 * every chat that has sent it an update lately - which is how to find the
 * ids .env wants. Read-only, and it leaves the updates for the bot to
 * process (nothing is confirmed).
 *
 *   npm run telegram:whoami
 *
 * To find an id: add the bot to the chat (as an admin, for a channel),
 * post anything there, then run this. For a person's id, have them
 * message the bot privately first.
 */
'use strict';

const config = require('../config');
const { Api } = require('../lib/api');

const say = (line = '') => process.stdout.write(`${line}\n`);
const settings = config.read();
const wrong = config.problems(settings).filter((w) => !w.includes('TELEGRAM_CHANNEL_ID')); // the channel may be what we are here to find
if (wrong.length) {
  wrong.forEach((w) => say(`✗ ${w}`));
  process.exit(1);
}

const api = new Api(settings.token);

async function look(label, id, need) {
  if (!id) { say(`  ${label.padEnd(9)} not set`); return; }
  const chat = await api.getChat(id).catch((err) => ({ error: err.description || err.message }));
  if (chat.error) { say(`  ${label.padEnd(9)} ${id}: ✗ ${chat.error}`); return; }
  say(`  ${label.padEnd(9)} ${chat.title || chat.username || chat.first_name} (${chat.type}, ${chat.id})${chat.linked_chat_id ? ` · linked chat ${chat.linked_chat_id}` : ''}${chat.username ? ` · @${chat.username}` : ''}`);
  const me = await api.getChatMember(chat.id, meId).catch(() => null);
  if (!me) { say('            ✗ I cannot see my own membership there'); return; }
  if (me.status !== 'administrator') { say(`            ✗ I am "${me.status}" there; make me an admin`); return; }
  const missing = need.filter((right) => !me[right]);
  say(missing.length ? `            ✗ admin, but missing: ${missing.join(', ')}` : '            ✓ admin with what I need');
}

let meId = 0;
(async () => {
  try {
    const me = await api.getMe();
    meId = me.id;
    say(`I am @${me.username} (${me.id})${me.can_join_groups ? '' : ' · cannot join groups: allow it in @BotFather'}`);
    say();
    say('From .env');
    await look('channel', settings.channelId, ['can_post_messages', 'can_edit_messages', 'can_pin_messages']);
    await look('group', settings.groupId, ['can_restrict_members', 'can_delete_messages', 'can_pin_messages']);
    await look('staff', settings.logChatId, []);
    if (settings.supportChatId && settings.supportChatId !== settings.logChatId) await look('support', settings.supportChatId, []);
    say(`  admins    ${settings.adminIds.length ? settings.adminIds.join(', ') : 'none listed (channel admins may still /announce)'}`);
    say();

    say('Chats that have sent me something lately (unconfirmed updates, at most 100)');
    const updates = await api.getUpdates({ limit: 100, timeout: 0 });
    const seen = new Map();
    for (const u of updates) {
      const m = u.message || u.edited_message || u.channel_post || (u.callback_query && u.callback_query.message) || (u.chat_member && { chat: u.chat_member.chat }) || (u.my_chat_member && { chat: u.my_chat_member.chat });
      if (m && m.chat) seen.set(m.chat.id, m.chat);
      const from = (u.message && u.message.from) || (u.callback_query && u.callback_query.from);
      if (from && m && m.chat && m.chat.type === 'private') seen.set(`u${from.id}`, { ...from, type: 'person' });
    }
    if (!seen.size) say('  none yet - post in the group, forward a channel post to me, or message me privately, then run this again');
    for (const chat of seen.values()) say(`  ${String(chat.type).padEnd(10)} ${String(chat.id).padEnd(16)} ${chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || ''}${chat.username ? ` (@${chat.username})` : ''}`);
    say();
    say(`Status pin reads ${settings.status.apiUrl}/api/status every ${Math.round(settings.status.intervalMs / 60000)} min; pings for ${settings.status.mainChains.join(', ')}`);
  } catch (err) {
    say(`✗ ${err.code === 401 ? 'Telegram rejected the token' : err.description || err.message}`);
    process.exitCode = 1;
  }
})();
