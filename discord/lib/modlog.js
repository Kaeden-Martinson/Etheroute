'use strict';

/**
 * The mod-log: a card in #mod-log for everything that happens to the
 * server, not only what the bot's own commands do. Messages deleted or
 * edited, members joining and leaving, bans and kicks and timeouts done by
 * hand in the Discord client, roles and nicknames changing, channels and
 * roles made or removed. Where Discord's audit log says who did it, the
 * card says so; when the bot itself did it, the command already posted
 * its card, so the event is let go rather than logged twice.
 *
 * What a deleted message said is only visible with the Message Content
 * intent (DISCORD_MESSAGE_CONTENT=true, and the switch in the portal);
 * without it the card names the author and the channel and says so.
 */

const { AuditLogEvent, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embed, COLORS, who, cut } = require('./embeds');

const YOUNG_ACCOUNT_MS = 7 * 86400000;

// The audit log trails the gateway by a moment, so a lookup waits a beat
// first; the tests set this to nothing.
const AUDIT = { delayMs: 800, window: 15000 };
// Discord folds repeated deletions by one moderator of one person's
// messages in one channel into a single entry whose count grows and whose
// time does not, so a stale entry with a grown count is a fresh deletion.
const seenCounts = new Map();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** The card to the mod-log channel, if the server has one. Never throws. */
async function post(ctx, card, extra = {}) {
  const channel = ctx.found && ctx.found.channels && ctx.found.channels.log;
  if (!channel) return false;
  try {
    return await channel.send({ embeds: [card], ...extra });
  } catch (err) {
    ctx.log.warn('mod-log post failed:', err.message);
    return false;
  }
}

/**
 * Who did a thing, from the audit log: the newest entry of `type` for the
 * target within a few seconds. Null when the bot may not read the log,
 * when nothing matches, or when the thing was done by the person it
 * happened to (leaving, deleting their own message), which leaves no entry.
 */
async function executorFor(guild, type, { targetId = null, within = AUDIT.window, match = null } = {}) {
  const me = guild.members && guild.members.me;
  if (me && me.permissions && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  await sleep(AUDIT.delayMs);
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  if (!logs) return null;
  const now = Date.now();
  for (const entry of logs.entries.values()) {
    const count = entry.extra && typeof entry.extra.count === 'number' ? entry.extra.count : null;
    const grown = count !== null && seenCounts.has(entry.id) && count > seenCounts.get(entry.id);
    if (count !== null) seenCounts.set(entry.id, count);
    if (now - entry.createdTimestamp > within && !grown) continue;
    if (targetId && entry.targetId !== targetId) continue;
    if (match && !match(entry)) continue;
    if (seenCounts.size > 500) seenCounts.clear();
    return { executor: entry.executor, reason: entry.reason || null, entry };
  }
  return null;
}

const isBot = (ctx, user) => Boolean(user && ctx.client && ctx.client.user && user.id === ctx.client.user.id);
const inGuild = (ctx, guild) => Boolean(guild && guild.id === ctx.config.guildId);
const byLine = (found) => (found && found.executor ? who(found.executor) : 'unknown - done by the person themselves, or before I could look');
const avatar = (user) => (user && typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : undefined);

function contentOf(ctx, message) {
  if (message.partial) return '_not cached - the message was sent before I started_';
  if (message.content) return cut(message.content, 1000);
  if (!ctx.config.log.messageContent) return '_not available - turn on the Message Content intent and set DISCORD_MESSAGE_CONTENT=true_';
  return '_(no text)_';
}

// ── messages ─────────────────────────────────────────────────────────────
async function onMessageDelete(message, ctx) {
  const guild = message.guild;
  if (!inGuild(ctx, guild)) return false;
  const log = ctx.found.channels.log;
  if (log && message.channelId === log.id) return false;
  if (message.author && message.author.bot) return false;
  const found = await executorFor(guild, AuditLogEvent.MessageDelete, {
    targetId: message.author ? message.author.id : null,
    match: (e) => !e.extra || !e.extra.channel || e.extra.channel.id === message.channelId,
  });
  if (found && isBot(ctx, found.executor)) return false; // the anti-bot trap or /purge already said so
  const attachments = message.attachments && message.attachments.size ? Array.from(message.attachments.values()).map((a) => a.name || a.url).join(', ') : '';
  await post(ctx, embed({
    title: '🗑️ Message deleted',
    color: COLORS.muted,
    fields: [
      { name: 'Author', value: message.author ? `${message.author.toString()} ${who(message.author)}` : 'unknown' },
      { name: 'Channel', value: `<#${message.channelId}>` },
      { name: 'Deleted by', value: found && found.executor ? who(found.executor) : 'the author, or unknown' },
      { name: 'Content', value: contentOf(ctx, message), inline: false },
      attachments ? { name: 'Attachments', value: cut(attachments, 500), inline: false } : null,
    ].filter(Boolean),
    thumbnail: avatar(message.author),
  }));
  return true;
}

async function onMessageDeleteBulk(messages, channel, ctx) {
  const guild = channel.guild;
  if (!inGuild(ctx, guild)) return false;
  const found = await executorFor(guild, AuditLogEvent.MessageBulkDelete, { targetId: channel.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({
    title: '🧹 Messages deleted in bulk',
    color: COLORS.muted,
    fields: [
      { name: 'Channel', value: channel.toString() },
      { name: 'How many', value: String(messages.size !== undefined ? messages.size : messages.length) },
      { name: 'By', value: byLine(found) },
    ],
  }));
  return true;
}

async function onMessageUpdate(before, after, ctx) {
  const guild = after.guild;
  if (!inGuild(ctx, guild)) return false;
  if (after.author && after.author.bot) return false;
  if (before.partial || after.partial) return false;
  if (before.content === after.content) return false; // an embed unfurling, a pin: not an edit
  await post(ctx, embed({
    title: '✏️ Message edited',
    color: COLORS.brand,
    url: after.url,
    fields: [
      { name: 'Author', value: `${after.author.toString()} ${who(after.author)}` },
      { name: 'Channel', value: `<#${after.channelId}>` },
      { name: 'Before', value: before.content ? cut(before.content, 1000) : '_(no text)_', inline: false },
      { name: 'After', value: after.content ? cut(after.content, 1000) : '_(no text)_', inline: false },
    ],
    thumbnail: avatar(after.author),
  }));
  return true;
}

// ── members ──────────────────────────────────────────────────────────────
async function onMemberAdd(member, ctx) {
  if (!inGuild(ctx, member.guild)) return false;
  const user = member.user;
  const age = user.createdTimestamp ? Date.now() - user.createdTimestamp : null;
  const young = age !== null && age < YOUNG_ACCOUNT_MS;
  await post(ctx, embed({
    title: user.bot ? '🤖 Bot added' : '📥 Member joined',
    color: young ? COLORS.warn : COLORS.ok,
    fields: [
      { name: 'Member', value: `${member.toString()} ${who(user)}` },
      { name: 'Account made', value: user.createdTimestamp ? `<t:${Math.floor(user.createdTimestamp / 1000)}:R>${young ? ' ⚠️ under a week old' : ''}` : 'unknown' },
      { name: 'Members now', value: String(member.guild.memberCount) },
    ],
    thumbnail: avatar(user),
  }));
  return true;
}

async function onMemberRemove(member, ctx) {
  if (!inGuild(ctx, member.guild)) return false;
  const user = member.user;
  // a kick leaves an audit entry; a leave does not
  const kicked = await executorFor(member.guild, AuditLogEvent.MemberKick, { targetId: user.id });
  if (kicked && isBot(ctx, kicked.executor)) return false;
  const banned = !kicked && await executorFor(member.guild, AuditLogEvent.MemberBanAdd, { targetId: user.id, within: 5000 });
  if (banned) return false; // onBanAdd covers it
  const roles = member.roles && member.roles.cache ? Array.from(member.roles.cache.values()).filter((r) => r.id !== member.guild.id).map((r) => r.name).join(', ') : '';
  await post(ctx, embed({
    title: kicked ? '👢 Member kicked' : '📤 Member left',
    color: kicked ? COLORS.warn : COLORS.muted,
    fields: [
      { name: 'Member', value: who(user) },
      kicked ? { name: 'By', value: byLine(kicked) } : null,
      kicked ? { name: 'Reason', value: kicked.reason || 'No reason given', inline: false } : null,
      member.joinedTimestamp ? { name: 'Was here since', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` } : null,
      roles ? { name: 'Had roles', value: cut(roles, 500), inline: false } : null,
    ].filter(Boolean),
    thumbnail: avatar(user),
  }));
  return true;
}

async function onBanAdd(ban, ctx) {
  if (!inGuild(ctx, ban.guild)) return false;
  const found = await executorFor(ban.guild, AuditLogEvent.MemberBanAdd, { targetId: ban.user.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({
    title: '🔨 Member banned',
    color: COLORS.danger,
    fields: [
      { name: 'Member', value: who(ban.user) },
      { name: 'By', value: byLine(found) },
      { name: 'Reason', value: (found && found.reason) || ban.reason || 'No reason given', inline: false },
    ],
    thumbnail: avatar(ban.user),
  }));
  return true;
}

async function onBanRemove(ban, ctx) {
  if (!inGuild(ctx, ban.guild)) return false;
  const found = await executorFor(ban.guild, AuditLogEvent.MemberBanRemove, { targetId: ban.user.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({
    title: '🔓 Member unbanned',
    color: COLORS.ok,
    fields: [{ name: 'Member', value: who(ban.user) }, { name: 'By', value: byLine(found) }, { name: 'Reason', value: (found && found.reason) || 'No reason given', inline: false }],
    thumbnail: avatar(ban.user),
  }));
  return true;
}

async function onMemberUpdate(before, after, ctx) {
  if (!inGuild(ctx, after.guild)) return false;
  const cards = [];
  const beforeRoles = before.roles && before.roles.cache ? before.roles.cache : new Map();
  const afterRoles = after.roles && after.roles.cache ? after.roles.cache : new Map();
  const added = Array.from(afterRoles.values()).filter((r) => !beforeRoles.has(r.id));
  const removed = Array.from(beforeRoles.values()).filter((r) => !afterRoles.has(r.id));
  if (added.length || removed.length) {
    const found = await executorFor(after.guild, AuditLogEvent.MemberRoleUpdate, { targetId: after.id });
    if (!(found && isBot(ctx, found.executor))) {
      cards.push(embed({
        title: '🏷️ Roles changed',
        color: COLORS.brand,
        fields: [
          { name: 'Member', value: `${after.toString()} ${who(after.user)}` },
          { name: 'By', value: byLine(found) },
          added.length ? { name: 'Added', value: added.map((r) => r.toString()).join(' '), inline: false } : null,
          removed.length ? { name: 'Removed', value: removed.map((r) => r.toString()).join(' '), inline: false } : null,
        ].filter(Boolean),
      }));
    }
  }
  if (before.nickname !== after.nickname) {
    const found = await executorFor(after.guild, AuditLogEvent.MemberUpdate, { targetId: after.id, match: (e) => e.changes && e.changes.some((c) => c.key === 'nick') });
    if (!(found && isBot(ctx, found.executor))) {
      cards.push(embed({
        title: '✏️ Nickname changed',
        color: COLORS.brand,
        fields: [
          { name: 'Member', value: `${after.toString()} ${who(after.user)}` },
          { name: 'By', value: found && found.executor ? who(found.executor) : 'themselves, or unknown' },
          { name: 'Change', value: `${before.nickname || after.user.username} → ${after.nickname || after.user.username}`, inline: false },
        ],
      }));
    }
  }
  const beforeUntil = before.communicationDisabledUntilTimestamp || null;
  const afterUntil = after.communicationDisabledUntilTimestamp || null;
  const nowTimedOut = afterUntil && afterUntil > Date.now();
  const wasTimedOut = beforeUntil && beforeUntil > Date.now();
  if (Boolean(nowTimedOut) !== Boolean(wasTimedOut)) {
    const found = await executorFor(after.guild, AuditLogEvent.MemberUpdate, { targetId: after.id, match: (e) => e.changes && e.changes.some((c) => c.key === 'communication_disabled_until') });
    if (!(found && isBot(ctx, found.executor))) {
      cards.push(embed({
        title: nowTimedOut ? '⏳ Member timed out' : '⏱️ Timeout lifted',
        color: nowTimedOut ? COLORS.warn : COLORS.ok,
        fields: [
          { name: 'Member', value: `${after.toString()} ${who(after.user)}` },
          { name: 'By', value: byLine(found) },
          nowTimedOut ? { name: 'Until', value: `<t:${Math.floor(afterUntil / 1000)}:R>` } : null,
          { name: 'Reason', value: (found && found.reason) || 'No reason given', inline: false },
        ].filter(Boolean),
      }));
    }
  }
  for (const card of cards) await post(ctx, card);
  return cards.length > 0;
}

// ── the server itself ────────────────────────────────────────────────────
const CHANNEL_KIND = { [ChannelType.GuildText]: 'text channel', [ChannelType.GuildVoice]: 'voice channel', [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement channel', [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage' };

async function onChannelCreate(channel, ctx) {
  if (!inGuild(ctx, channel.guild)) return false;
  const found = await executorFor(channel.guild, AuditLogEvent.ChannelCreate, { targetId: channel.id });
  if (found && isBot(ctx, found.executor)) return false; // a ticket: logged by the ticket itself
  await post(ctx, embed({ title: `➕ ${CHANNEL_KIND[channel.type] || 'channel'} created`, color: COLORS.ok, fields: [{ name: 'Channel', value: `${channel.toString()} (${channel.name})` }, { name: 'By', value: byLine(found) }] }));
  return true;
}

async function onChannelDelete(channel, ctx) {
  if (!inGuild(ctx, channel.guild)) return false;
  const found = await executorFor(channel.guild, AuditLogEvent.ChannelDelete, { targetId: channel.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({ title: `➖ ${CHANNEL_KIND[channel.type] || 'channel'} deleted`, color: COLORS.danger, fields: [{ name: 'Channel', value: `#${channel.name}` }, { name: 'By', value: byLine(found) }] }));
  return true;
}

async function onChannelUpdate(before, after, ctx) {
  if (!inGuild(ctx, after.guild)) return false;
  if (before.name === after.name) return false; // permission and topic churn is not worth a card
  const found = await executorFor(after.guild, AuditLogEvent.ChannelUpdate, { targetId: after.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({ title: '✏️ Channel renamed', color: COLORS.brand, fields: [{ name: 'Channel', value: `#${before.name} → ${after.toString()}` }, { name: 'By', value: byLine(found) }] }));
  return true;
}

async function onRoleCreate(role, ctx) {
  if (!inGuild(ctx, role.guild)) return false;
  const found = await executorFor(role.guild, AuditLogEvent.RoleCreate, { targetId: role.id });
  if (found && isBot(ctx, found.executor)) return false;
  await post(ctx, embed({ title: '➕ Role created', color: COLORS.ok, fields: [{ name: 'Role', value: `${role.toString()} (${role.name})` }, { name: 'By', value: byLine(found) }] }));
  return true;
}

async function onRoleDelete(role, ctx) {
  if (!inGuild(ctx, role.guild)) return false;
  const found = await executorFor(role.guild, AuditLogEvent.RoleDelete, { targetId: role.id });
  await post(ctx, embed({ title: '➖ Role deleted', color: COLORS.danger, fields: [{ name: 'Role', value: `@${role.name}` }, { name: 'By', value: byLine(found) }] }));
  return true;
}

/** Wire every handler to the client. Each one is guarded so a bad event cannot bring the bot down. */
function attach(client, ctx) {
  const guard = (fn) => (...args) => fn(...args, ctx).catch((err) => ctx.log.warn(`mod-log ${fn.name} failed:`, err.message));
  client.on('messageDelete', guard(onMessageDelete));
  client.on('messageDeleteBulk', guard(onMessageDeleteBulk));
  client.on('messageUpdate', guard(onMessageUpdate));
  client.on('guildMemberAdd', guard(onMemberAdd));
  client.on('guildMemberRemove', guard(onMemberRemove));
  client.on('guildBanAdd', guard(onBanAdd));
  client.on('guildBanRemove', guard(onBanRemove));
  client.on('guildMemberUpdate', guard(onMemberUpdate));
  client.on('channelCreate', guard(onChannelCreate));
  client.on('channelDelete', guard(onChannelDelete));
  client.on('channelUpdate', guard(onChannelUpdate));
  client.on('roleCreate', guard(onRoleCreate));
  client.on('roleDelete', guard(onRoleDelete));
}

module.exports = { AUDIT, post, executorFor, attach, onMessageDelete, onMessageDeleteBulk, onMessageUpdate, onMemberAdd, onMemberRemove, onBanAdd, onBanRemove, onMemberUpdate, onChannelCreate, onChannelDelete, onChannelUpdate, onRoleCreate, onRoleDelete, YOUNG_ACCOUNT_MS };
