'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption, memberOf, sayOk, sayFail } = require('../lib/slash');
const { canActOn, caseEmbed, modLog, tell, noticeEmbed } = require('../lib/moderation');

module.exports = {
  data: command('kick', 'Remove a member from the server; they can come back with an invite', PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.KickMembers,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || undefined;
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);

    // the word to them goes first: once they are out, DMs cannot reach them
    const told = await tell(user, noticeEmbed(interaction.guild.name, 'kick', reason));
    await target.kick(`${reason || 'No reason given'} - by ${interaction.user.tag}`);
    ctx.log.info(`kicked ${user.tag} (${user.id}) by ${interaction.user.tag}: ${reason || 'no reason'}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'kick', target, moderator: interaction.member, reason, fields: [{ name: 'Told them', value: told ? 'Yes (DM)' : 'No (DMs closed)' }] }));
    return sayOk(interaction, `**${user.tag}** was kicked.${reason ? ` Reason: ${reason}` : ''}`);
  },
};
