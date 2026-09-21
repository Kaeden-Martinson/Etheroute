'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { command, sayFail } = require('../lib/slash');
const { caseEmbed, modLog } = require('../lib/moderation');
const { ok } = require('../lib/embeds');

const TWO_WEEKS = 14 * 86400000;

module.exports = {
  data: command('purge', 'Delete the last N messages in this channel (up to 100, newer than two weeks)', PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('amount').setDescription('How many to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Only messages by this user'))
    .addBooleanOption((o) => o.setName('bots').setDescription('Only messages by bots')),
  requires: PermissionFlagsBits.ManageMessages,
  async execute(interaction, ctx) {
    const amount = interaction.options.getInteger('amount', true);
    const user = interaction.options.getUser('user');
    const botsOnly = interaction.options.getBoolean('bots');
    const channel = interaction.channel;
    if (!channel || typeof channel.bulkDelete !== 'function') return sayFail(interaction, 'I cannot purge here.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Discord refuses to bulk-delete anything older than two weeks; those are left alone
    const fetched = await channel.messages.fetch({ limit: 100 });
    const cutoff = Date.now() - TWO_WEEKS;
    const picked = Array.from(fetched.values())
      .filter((m) => m.createdTimestamp > cutoff && !m.pinned)
      .filter((m) => (!user || m.author.id === user.id) && (!botsOnly || m.author.bot))
      .slice(0, amount);
    if (!picked.length) return interaction.editReply({ embeds: [ok('Nothing to delete that matches.')] });

    const deleted = await channel.bulkDelete(picked, true);
    ctx.log.info(`purged ${deleted.size} message(s) in #${channel.name} by ${interaction.user.tag}${user ? ` (by ${user.tag})` : ''}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'purge', moderator: interaction.member, reason: `${deleted.size} message(s) in ${channel.toString()}`, fields: [
      user ? { name: 'Only by', value: user.tag } : null,
      botsOnly ? { name: 'Only bots', value: 'Yes' } : null,
    ].filter(Boolean) }));
    return interaction.editReply({ embeds: [ok(`Deleted **${deleted.size}** message(s).`)] });
  },
};
