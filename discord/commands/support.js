'use strict';

const { MessageFlags } = require('discord.js');
const { command } = require('../lib/slash');
const { ok, fail } = require('../lib/embeds');
const tickets = require('../lib/tickets');

module.exports = {
  data: command('support', 'Open a private support ticket with the team')
    .addStringOption((o) => o.setName('subject').setDescription('What you need help with; leave it out to be asked').setMinLength(10).setMaxLength(400)),
  async execute(interaction, ctx) {
    const subject = interaction.options.getString('subject');
    if (!subject) return interaction.showModal(tickets.modal());
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await tickets.openTicket(ctx, interaction.guild, interaction.user, subject);
    if (result.error) return interaction.editReply({ embeds: [fail(result.error)] });
    return interaction.editReply({ embeds: [ok(`Your ticket is open: ${result.channel.toString()}`)] });
  },
};
