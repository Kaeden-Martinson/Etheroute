'use strict';

const { MessageFlags } = require('discord.js');
const { command, memberOf } = require('../lib/slash');
const { embed } = require('../lib/embeds');

module.exports = {
  data: command('avatar', 'Someone\'s avatar, full size')
    .addUserOption((o) => o.setName('user').setDescription('Whose (default: yours)')),
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const member = await memberOf(interaction.guild, user);
    const url = (member || user).displayAvatarURL({ size: 1024 });
    return interaction.reply({ embeds: [embed({ title: `${member ? member.displayName : user.username}'s avatar`, image: url, url, timestamp: false })], flags: MessageFlags.Ephemeral });
  },
};
