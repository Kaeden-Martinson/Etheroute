'use strict';

const { PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { command, sayOk, sayFail, when } = require('../lib/slash');
const { embed, note, ok, fail, COLORS } = require('../lib/embeds');
const { parseDuration } = require('../lib/duration');
const giveaways = require('../lib/giveaways');
const { botCan } = require('../lib/guild');

module.exports = {
  data: command('giveaway', 'Run a giveaway: start one, end it early, draw again, or see what is running', PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway with an Enter button')
      .addStringOption((o) => o.setName('duration').setDescription('How long: 30m, 2h, 1d, 3d (up to 4 weeks)').setRequired(true).setMaxLength(20))
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
      .addIntegerOption((o) => o.setName('winners').setDescription('How many winners (default 1)').setMinValue(1).setMaxValue(20))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and draw the winners')
      .addStringOption((o) => o.setName('message_id').setDescription('The giveaway message id (right-click → Copy Message ID)').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Draw new winners for a giveaway that ended')
      .addStringOption((o) => o.setName('message_id').setDescription('The giveaway message id').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('How many to draw (default: as before)').setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName('list').setDescription('The giveaways still running')),
  requires: PermissionFlagsBits.ManageGuild,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      const ms = parseDuration(interaction.options.getString('duration', true));
      const prize = interaction.options.getString('prize', true).trim();
      const winners = interaction.options.getInteger('winners') || 1;
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      if (!ms) return sayFail(interaction, 'I did not understand that duration. Try 30m, 2h, 1d or 3d.');
      if (ms > giveaways.MAX_MS) return sayFail(interaction, 'A giveaway can run for up to 4 weeks.');
      if (!botCan(channel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks)) return sayFail(interaction, `I cannot post in ${channel.toString()}.`);
      const g = await giveaways.start(ctx, { channel, prize, winners, durationMs: ms, host: interaction.user });
      return sayOk(interaction, `Giveaway for **${prize}** is up in ${channel.toString()} - ${winners} winner(s), ends ${when(g.endsAt)}.`, { flags: MessageFlags.Ephemeral });
    }

    if (sub === 'list') {
      const open = giveaways.active(ctx);
      if (!open.length) return interaction.reply({ embeds: [note('No giveaway is running.')], flags: MessageFlags.Ephemeral });
      const lines = open.map((g) => `**${g.prize}** in <#${g.channelId}> - ${g.entrants.length} entered, ${g.winners} winner(s), ends ${when(g.endsAt)} (\`${g.messageId}\`)`);
      return interaction.reply({ embeds: [embed({ title: `${open.length} giveaway(s) running`, description: lines.join('\n'), color: COLORS.brand, timestamp: false })], flags: MessageFlags.Ephemeral });
    }

    const messageId = interaction.options.getString('message_id', true).trim();
    if (!/^\d{15,22}$/.test(messageId)) return sayFail(interaction, 'That is not a message id. Right-click the giveaway message → Copy Message ID.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = sub === 'reroll'
      ? await giveaways.end(ctx, messageId, { reroll: true, count: interaction.options.getInteger('winners') || undefined })
      : await giveaways.end(ctx, messageId);
    if (!result.ok) return interaction.editReply({ embeds: [fail(result.reason)] });
    const won = result.winnerIds.length ? result.winnerIds.map((id) => `<@${id}>`).join(', ') : 'nobody (no entries)';
    return interaction.editReply({ embeds: [ok(`**${result.giveaway.prize}** ${sub === 'reroll' ? 'redrawn' : 'ended'}: ${won}.`)] });
  },
};
