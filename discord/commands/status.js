'use strict';

const { MessageFlags } = require('discord.js');
const { command } = require('../lib/slash');
const status = require('../lib/status');

module.exports = {
  data: command('status', 'How Etheroute is doing right now: services, networks, recent changes'),
  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const summary = status.summarise(await status.gather(ctx.config));
    return interaction.editReply({ embeds: [status.statusEmbed(summary, ctx.config)] });
  },
};
