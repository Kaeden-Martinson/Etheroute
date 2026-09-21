'use strict';

/**
 * The anti-bot channel is a trap. A notice at the top says no one should
 * post here; a person reads it and does not, a spam bot posting in every
 * channel it can see does, and is removed on the spot - kicked by
 * default, banned with DISCORD_ANTIBOT_ACTION=ban. Staff and bots are
 * left alone, so a moderator answering someone there is not thrown out.
 */

const { PermissionFlagsBits } = require('discord.js');
const { embed, COLORS, who } = require('./embeds');
const { isStaff, caseEmbed, modLog, tell, noticeEmbed } = require('./moderation');

function notice(config) {
  const verb = config.antibot.action === 'ban' ? 'banned' : 'kicked';
  return {
    embeds: [embed({
      title: '🪤 Do not post in this channel',
      description: `This channel exists to catch spam bots. **Anything posted here is removed and its author is ${verb} automatically** - no warning, no exceptions for people who did not read this.\n\nIf you are a person: there is nothing for you here. Please use the other channels.`,
      color: COLORS.critical,
      footer: `${config.brand.name} · automatic`,
      timestamp: false,
    })],
  };
}

/** Whether a message should trip the trap. Pure: a stub message will do. */
function shouldEnforce(message, ctx) {
  const channel = ctx.found && ctx.found.channels && ctx.found.channels.antibot;
  if (!channel || !message || !message.channelId || message.channelId !== channel.id) return false;
  if (!message.author || message.author.bot || message.system) return false;
  if (message.webhookId) return false;
  if (isStaff(message.member)) return false;
  return true;
}

async function enforce(message, ctx) {
  const guild = message.guild;
  const member = message.member;
  const action = ctx.config.antibot.action;
  const reason = `Posted in #${message.channel.name} (anti-bot channel)`;

  await message.delete().catch(() => {});
  const notified = member ? await tell(message.author, noticeEmbed(guild.name, 'anti-bot', reason)) : false;

  let done = false;
  let error = null;
  try {
    if (action === 'ban') {
      await guild.members.ban(message.author.id, { reason, deleteMessageSeconds: 24 * 3600 });
    } else if (member) {
      await member.kick(reason);
    }
    done = true;
  } catch (err) {
    error = err;
  }

  if (done) ctx.log.warn(`anti-bot: ${action === 'ban' ? 'banned' : 'kicked'} ${who(message.author)} for posting in #${message.channel.name}`);
  else ctx.log.error(`anti-bot: could not ${action} ${who(message.author)}:`, error && error.message);

  await modLog(ctx, guild, caseEmbed({
    action: 'anti-bot',
    target: member || message.author,
    reason,
    fields: [
      { name: 'Action', value: done ? (action === 'ban' ? 'Banned' : 'Kicked') : `Failed to ${action}: ${error ? error.message : 'unknown'}` },
      { name: 'Told them', value: notified ? 'Yes (DM)' : 'No (DMs closed)' },
    ],
  }));
  return done;
}

/** Post the notice unless the one we remember is still there. */
async function ensureNotice(ctx, guild, { force = false } = {}) {
  const channel = ctx.found.channels.antibot;
  if (!channel) {
    ctx.log.warn('no anti-bot channel found - set DISCORD_ANTIBOT_CHANNEL to its name or id');
    return null;
  }
  const me = guild.members.me;
  const perms = me && channel.permissionsFor(me);
  if (perms && !perms.has(PermissionFlagsBits.ManageMessages)) ctx.log.warn(`I cannot delete messages in #${channel.name}; give me Manage Messages there`);
  const remembered = ctx.store.data.panels.antibot;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const message = await channel.send(notice(ctx.config));
  ctx.store.update('panels', (p) => { p.antibot = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`anti-bot notice posted in #${channel.name}`);
  return message;
}

module.exports = { notice, shouldEnforce, enforce, ensureNotice };
