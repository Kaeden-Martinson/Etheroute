'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { command, reasonOption, sayOk, sayFail } = require('../lib/slash');
const { caseEmbed, modLog } = require('../lib/moderation');
const { embed, COLORS } = require('../lib/embeds');

/** Lock or unlock: @everyone's Send Messages in the channel, denied or back to inherited. */
async function setLocked(interaction, ctx, locked) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const reason = interaction.options.getString('reason') || undefined;
  if (!channel || !channel.permissionOverwrites) return sayFail(interaction, 'That channel cannot be locked.');
  const everyone = interaction.guild.roles.everyone;
  const current = channel.permissionOverwrites.cache.get(everyone.id);
  const isLocked = Boolean(current && current.deny.has(PermissionFlagsBits.SendMessages));
  if (locked === isLocked) return sayFail(interaction, `${channel.toString()} is already ${locked ? 'locked' : 'unlocked'}.`);

  await channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? false : null, SendMessagesInThreads: locked ? false : null, CreatePublicThreads: locked ? false : null }, { reason: `${locked ? 'Locked' : 'Unlocked'} by ${interaction.user.tag}${reason ? `: ${reason}` : ''}` });
  ctx.log.info(`#${channel.name} ${locked ? 'locked' : 'unlocked'} by ${interaction.user.tag}: ${reason || 'no reason'}`);
  await modLog(ctx, interaction.guild, caseEmbed({ action: locked ? 'lock' : 'unlock', moderator: interaction.member, reason, fields: [{ name: 'Channel', value: channel.toString() }] }));
  if (channel.id !== interaction.channelId || locked) {
    await channel.send({ embeds: [embed({ description: locked ? `🔒 This channel is locked${reason ? `: ${reason}` : '.'}` : '🔓 This channel is open again.', color: locked ? COLORS.warn : COLORS.ok, timestamp: false })] }).catch(() => {});
  }
  return sayOk(interaction, `${channel.toString()} is ${locked ? 'locked' : 'unlocked'}.`, { flags: MessageFlags.Ephemeral });
}

module.exports = {
  data: command('lock', 'Stop members posting in a channel until it is unlocked', PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('channel').setDescription('Another channel than this one'))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.ManageChannels,
  setLocked,
  execute: (interaction, ctx) => setLocked(interaction, ctx, true),
};
