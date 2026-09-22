'use strict';

/**
 * What every moderation command shares: whether the person asking may act
 * on the person named, whether the bot can, the note to the mod-log
 * channel, and the word to the person acted on.
 *
 * The rule is Discord's own: nobody acts on themselves, on the server's
 * owner, on the bot, or on anyone whose highest role is at or above their
 * own - and the bot's highest role must be above the target's too, or
 * Discord refuses the call anyway.
 */

const { PermissionFlagsBits } = require('discord.js');
const { embed, COLORS, who } = require('./embeds');

/** { ok: true } or { ok: false, reason } for actor acting on target. Both are GuildMembers; target may be null (not in the server). */
function canActOn(actor, target, guild, { botMember = guild && guild.members && guild.members.me } = {}) {
  if (!target) return { ok: true };
  if (target.id === actor.id) return { ok: false, reason: 'You cannot do that to yourself.' };
  if (guild && target.id === guild.ownerId) return { ok: false, reason: 'That is the server owner.' };
  if (botMember && target.id === botMember.id) return { ok: false, reason: 'Not on myself.' };
  const actorIsOwner = guild && actor.id === guild.ownerId;
  if (!actorIsOwner && position(target) >= position(actor)) {
    return { ok: false, reason: 'Their highest role is at or above yours.' };
  }
  if (botMember && position(target) >= position(botMember)) {
    return { ok: false, reason: 'Their highest role is at or above mine - move my role up in Server Settings → Roles.' };
  }
  return { ok: true };
}

function position(member) {
  const highest = member && member.roles && member.roles.highest;
  return highest ? highest.position : 0;
}

/** Someone the anti-bot trap and similar automatic actions must leave alone. */
function isStaff(member) {
  if (!member) return false;
  if (member.guild && member.id === member.guild.ownerId) return true;
  const perms = member.permissions;
  if (!perms || typeof perms.has !== 'function') return false;
  return [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageMessages]
    .some((flag) => perms.has(flag));
}

const ACTION_COLORS = { kick: COLORS.warn, ban: COLORS.danger, unban: COLORS.ok, timeout: COLORS.warn, untimeout: COLORS.ok, warn: COLORS.warn, purge: COLORS.muted, lock: COLORS.warn, unlock: COLORS.ok, 'anti-bot': COLORS.critical, role: COLORS.brand, nick: COLORS.brand, slowmode: COLORS.muted };

/** The card for the mod-log: who did what to whom, and why. */
function caseEmbed({ action, target, moderator, reason, fields = [], color }) {
  return embed({
    title: `${label(action)}`,
    color: color || ACTION_COLORS[action] || COLORS.brand,
    fields: [
      target ? { name: 'Member', value: `${target.toString ? target.toString() : ''} ${who(target.user || target)}`.trim() } : null,
      moderator ? { name: 'By', value: who(moderator.user || moderator) } : null,
      ...fields,
      { name: 'Reason', value: reason || 'No reason given', inline: false },
    ].filter(Boolean),
    thumbnail: target && typeof target.displayAvatarURL === 'function' ? target.displayAvatarURL({ size: 128 }) : undefined,
  });
}

function label(action) {
  return { kick: '👢 Kicked', ban: '🔨 Banned', unban: '🔓 Unbanned', timeout: '⏳ Timed out', untimeout: '⏱️ Timeout lifted', warn: '⚠️ Warned', purge: '🧹 Purged', lock: '🔒 Locked', unlock: '🔓 Unlocked', 'anti-bot': '🪤 Anti-bot', role: '🏷️ Role', nick: '✏️ Nickname', slowmode: '🐢 Slowmode' }[action] || action;
}

/** A copy of the card to the mod-log channel, if the server has one. Never throws. */
async function modLog(ctx, guild, card) {
  return Boolean(await require('./modlog').post(ctx, card));
}

/** A DM to the person acted on. Closed DMs are common; failure is fine. */
async function tell(user, card) {
  try {
    await user.send({ embeds: [card] });
    return true;
  } catch {
    return false;
  }
}

/** The DM a member gets for an action, in the server's voice. */
function noticeEmbed(guildName, action, reason, extra = []) {
  const said = { kick: `You were kicked from **${guildName}**.`, ban: `You were banned from **${guildName}**.`, timeout: `You were timed out in **${guildName}**.`, warn: `You were warned in **${guildName}**.`, 'anti-bot': `You posted in the anti-bot channel of **${guildName}**, which no person should, and were removed.` }[action] || `Action in **${guildName}**: ${label(action)}`;
  return embed({ description: said, color: ACTION_COLORS[action] || COLORS.brand, fields: [...extra, { name: 'Reason', value: reason || 'No reason given', inline: false }] });
}

module.exports = { canActOn, isStaff, caseEmbed, modLog, tell, noticeEmbed, label, ACTION_COLORS, position };
