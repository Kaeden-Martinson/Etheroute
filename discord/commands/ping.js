'use strict';

const { MessageFlags } = require('discord.js');
const { command } = require('../lib/slash');
const { note } = require('../lib/embeds');
const { formatDuration } = require('../lib/duration');

module.exports = {
  data: command('ping', 'Is the bot awake, and how far away is it'),
  async execute(interaction, ctx) {
    const before = Date.now();
    await interaction.reply({ embeds: [note('Pinging…')], flags: MessageFlags.Ephemeral });
    const roundTrip = Date.now() - before;
    const heartbeat = Math.round(interaction.client.ws.ping);
    const up = formatDuration(process.uptime() * 1000);
    return interaction.editReply({ embeds: [note(`🏓 **${roundTrip}ms** round trip · **${heartbeat}ms** to the gateway · up **${up}** · ${ctx.commands.list.length} commands`)] });
  },
};
