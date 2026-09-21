'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, sayOk, sayFail } = require('../lib/slash');
const { caseEmbed, modLog } = require('../lib/moderation');
const { parseDuration, formatDuration } = require('../lib/duration');

const MAX_SECONDS = 6 * 3600;

module.exports = {
  data: command('slowmode', 'Set how long members must wait between messages here; off to remove it', PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('wait').setDescription('5s, 30s, 2m, 1h (up to 6h), or off').setRequired(true).setMaxLength(10))
    .addChannelOption((o) => o.setName('channel').setDescription('Another channel than this one')),
  requires: PermissionFlagsBits.ManageChannels,
  async execute(interaction, ctx) {
    const text = interaction.options.getString('wait', true).trim().toLowerCase();
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel || typeof channel.setRateLimitPerUser !== 'function') return sayFail(interaction, 'That channel cannot have slowmode.');
    let seconds = 0;
    if (!['off', '0', 'none'].includes(text)) {
      const ms = parseDuration(/^\d+$/.test(text) ? `${text}s` : text);
      if (!ms) return sayFail(interaction, 'I did not understand that. Try 5s, 30s, 2m, 1h or off.');
      seconds = Math.round(ms / 1000);
      if (seconds > MAX_SECONDS) return sayFail(interaction, 'Slowmode goes up to 6 hours.');
    }
    await channel.setRateLimitPerUser(seconds, `Slowmode by ${interaction.user.tag}`);
    ctx.log.info(`slowmode in #${channel.name} set to ${seconds}s by ${interaction.user.tag}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'slowmode', moderator: interaction.member, reason: seconds ? `${formatDuration(seconds * 1000)} in ${channel.toString()}` : `Off in ${channel.toString()}` }));
    return sayOk(interaction, seconds ? `Slowmode in ${channel.toString()} is **${formatDuration(seconds * 1000)}**.` : `Slowmode in ${channel.toString()} is off.`);
  },
};
