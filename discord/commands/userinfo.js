'use strict';

const { MessageFlags } = require('discord.js');
const { command, memberOf, when } = require('../lib/slash');
const { embed, COLORS } = require('../lib/embeds');
const { warningsFor } = require('./warn');

module.exports = {
  data: command('userinfo', 'Who someone is: account age, when they joined, roles, warnings')
    .addUserOption((o) => o.setName('user').setDescription('Whom (default: you)')),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user') || interaction.user;
    const member = await memberOf(interaction.guild, user);
    const roles = member ? member.roles.cache.filter((r) => r.id !== interaction.guild.id).sort((a, b) => b.position - a.position).map((r) => r.toString()) : [];
    const warnings = warningsFor(ctx.store, user.id).length;
    const fields = [
      { name: 'Id', value: `\`${user.id}\`` },
      { name: 'Account made', value: when(user.createdAt) },
      member && member.joinedAt ? { name: 'Joined', value: when(member.joinedAt) } : { name: 'In the server', value: 'No' },
      member && member.isCommunicationDisabled() ? { name: 'Timed out until', value: when(member.communicationDisabledUntil) } : null,
      member && member.premiumSince ? { name: 'Boosting since', value: when(member.premiumSince) } : null,
      { name: 'Warnings', value: String(warnings) },
      { name: `Roles (${roles.length})`, value: roles.length ? roles.slice(0, 20).join(' ') : 'None', inline: false },
    ].filter(Boolean);
    return interaction.reply({ embeds: [embed({
      title: member ? member.displayName : user.username,
      description: `${user.toString()}${user.bot ? ' · bot' : ''}`,
      color: member && member.displayColor ? member.displayColor : COLORS.brand,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      fields,
    })], flags: MessageFlags.Ephemeral });
  },
};
