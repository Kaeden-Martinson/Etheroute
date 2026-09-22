'use strict';

const { MessageFlags } = require('discord.js');
const { command, sayOk, sayFail, when } = require('../lib/slash');
const { embed, note, fail, COLORS } = require('../lib/embeds');
const tickets = require('../lib/tickets');

module.exports = {
  // no default permission: the person who opened a ticket may close it, so
  // everyone sees the command and each action checks for itself
  data: command('ticket', 'Work a support ticket: close it, let someone in or out, see what is open')
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket; the transcript is saved')
      .addStringOption((o) => o.setName('reason').setDescription('Why, in a few words').setMaxLength(200)))
    .addSubcommand((s) => s.setName('add').setDescription('Let someone else into this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Take someone out of this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('The tickets open right now')),
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const staff = tickets.isStaff(interaction.member, ctx);

    if (sub === 'list') {
      if (!staff) return sayFail(interaction, 'Only the team can list tickets.');
      const open = tickets.open(ctx).sort((a, b) => a.number - b.number);
      if (!open.length) return interaction.reply({ embeds: [note('No ticket is open.')], flags: MessageFlags.Ephemeral });
      const lines = open.map((t) => `**#${t.number}** <#${t.channelId}> - <@${t.userId}>, opened ${when(t.openedAt)}\n> ${t.subject.length > 120 ? `${t.subject.slice(0, 119)}…` : t.subject}`);
      return interaction.reply({ embeds: [embed({ title: `${open.length} ticket(s) open`, description: lines.join('\n\n'), color: COLORS.brand, timestamp: false })], flags: MessageFlags.Ephemeral });
    }

    const ticket = tickets.ticketOf(ctx, interaction.channelId);
    if (!ticket) return sayFail(interaction, 'This is not a ticket channel. Run this inside the ticket.');

    if (sub === 'close') {
      if (interaction.user.id !== ticket.userId && !staff) return sayFail(interaction, 'Only the person who opened the ticket, or the team, can close it.');
      const reason = interaction.options.getString('reason') || undefined;
      await interaction.reply({ embeds: [note('Closing…')], flags: MessageFlags.Ephemeral });
      const result = await tickets.closeTicket(ctx, interaction.channel, { by: interaction.user, reason });
      if (result.error) return interaction.editReply({ embeds: [fail(result.error)] });
      return result;
    }

    if (!staff) return sayFail(interaction, 'Only the team can add or remove people.');
    const user = interaction.options.getUser('user', true);
    const result = await tickets.setAccess(ctx, interaction.channel, user, sub === 'add');
    if (result.error) return sayFail(interaction, result.error);
    ctx.log.info(`${user.tag} ${sub === 'add' ? 'added to' : 'removed from'} ticket #${ticket.number} by ${interaction.user.tag}`);
    return sayOk(interaction, sub === 'add' ? `${user.toString()} can see this ticket now.` : `${user.toString()} was removed from this ticket.`);
  },
};
