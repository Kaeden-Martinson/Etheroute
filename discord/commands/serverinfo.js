'use strict';

const { ChannelType, MessageFlags } = require('discord.js');
const { command, when } = require('../lib/slash');
const { embed } = require('../lib/embeds');

module.exports = {
  data: command('serverinfo', 'The server at a glance: members, channels, roles, boosts, age'),
  async execute(interaction) {
    const guild = interaction.guild;
    const channels = guild.channels.cache;
    const count = (...types) => channels.filter((c) => types.includes(c.type)).size;
    const owner = await guild.fetchOwner().catch(() => null);
    return interaction.reply({ embeds: [embed({
      title: guild.name,
      description: guild.description || undefined,
      thumbnail: guild.iconURL({ size: 256 }) || undefined,
      fields: [
        { name: 'Members', value: String(guild.memberCount) },
        { name: 'Owner', value: owner ? owner.user.tag : 'unknown' },
        { name: 'Made', value: when(guild.createdAt) },
        { name: 'Text channels', value: String(count(ChannelType.GuildText, ChannelType.GuildAnnouncement)) },
        { name: 'Voice channels', value: String(count(ChannelType.GuildVoice, ChannelType.GuildStageVoice)) },
        { name: 'Categories', value: String(count(ChannelType.GuildCategory)) },
        { name: 'Roles', value: String(guild.roles.cache.size - 1) },
        { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0} (tier ${guild.premiumTier})` },
        { name: 'Emoji', value: String(guild.emojis.cache.size) },
        { name: 'Id', value: `\`${guild.id}\``, inline: false },
      ],
    })], flags: MessageFlags.Ephemeral });
  },
};
