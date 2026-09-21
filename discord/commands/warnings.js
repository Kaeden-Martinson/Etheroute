'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { command, sayOk, sayFail, when } = require('../lib/slash');
const { embed, COLORS, note } = require('../lib/embeds');
const { caseEmbed, modLog } = require('../lib/moderation');
const { warningsFor } = require('./warn');

module.exports = {
  data: command('warnings', 'See or clear the warnings on a member\'s record', PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) => s.setName('list').setDescription('The warnings on record')
      .addUserOption((o) => o.setName('user').setDescription('Whose').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove one warning by its id')
      .addUserOption((o) => o.setName('user').setDescription('Whose').setRequired(true))
      .addStringOption((o) => o.setName('id').setDescription('The warning id, from /warnings list').setRequired(true)))
    .addSubcommand((s) => s.setName('clear').setDescription('Wipe every warning on record')
      .addUserOption((o) => o.setName('user').setDescription('Whose').setRequired(true))),
  requires: PermissionFlagsBits.ModerateMembers,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user', true);
    const list = warningsFor(ctx.store, user.id);

    if (sub === 'list') {
      if (!list.length) return interaction.reply({ embeds: [note(`**${user.tag}** has no warnings on record.`)], flags: MessageFlags.Ephemeral });
      const lines = list.slice(-15).reverse().map((w) => `\`${w.id}\` ${when(w.at)} by ${w.byTag || `<@${w.by}>`}\n> ${w.reason}`);
      return interaction.reply({ embeds: [embed({ title: `Warnings for ${user.tag}`, description: lines.join('\n\n'), color: COLORS.warn, footer: `${list.length} on record${list.length > 15 ? ', latest 15 shown' : ''}`, thumbnail: user.displayAvatarURL({ size: 128 }) })], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remove') {
      const id = interaction.options.getString('id', true).trim();
      if (!list.some((w) => w.id === id)) return sayFail(interaction, `No warning \`${id}\` on ${user.tag}'s record.`);
      ctx.store.update('warnings', (all) => { all[user.id] = (all[user.id] || []).filter((w) => w.id !== id); if (!all[user.id].length) delete all[user.id]; });
      ctx.log.info(`warning ${id} removed from ${user.tag} (${user.id}) by ${interaction.user.tag}`);
      return sayOk(interaction, `Warning \`${id}\` removed from **${user.tag}**.`);
    }

    if (!list.length) return sayFail(interaction, `**${user.tag}** has no warnings to clear.`);
    ctx.store.update('warnings', (all) => { delete all[user.id]; });
    ctx.log.info(`cleared ${list.length} warning(s) for ${user.tag} (${user.id}) by ${interaction.user.tag}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'warn', target: user, moderator: interaction.member, reason: `Cleared ${list.length} warning(s)`, color: COLORS.ok }));
    return sayOk(interaction, `Cleared **${list.length}** warning(s) for **${user.tag}**.`);
  },
};
