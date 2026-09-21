'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption, memberOf, sayOk, sayFail } = require('../lib/slash');
const { canActOn, caseEmbed, modLog } = require('../lib/moderation');

module.exports = {
  data: command('untimeout', 'Lift a member\'s timeout early', PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Whose timeout to lift').setRequired(true))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.ModerateMembers,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || undefined;
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    if (!target.isCommunicationDisabled()) return sayFail(interaction, `${user.tag} is not timed out.`);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);

    await target.timeout(null, `${reason || 'No reason given'} - by ${interaction.user.tag}`);
    ctx.log.info(`timeout lifted for ${user.tag} (${user.id}) by ${interaction.user.tag}: ${reason || 'no reason'}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'untimeout', target, moderator: interaction.member, reason }));
    return sayOk(interaction, `**${user.tag}** can talk again.`);
  },
};
