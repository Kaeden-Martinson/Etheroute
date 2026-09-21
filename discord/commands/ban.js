'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption, memberOf, sayOk, sayFail } = require('../lib/slash');
const { canActOn, caseEmbed, modLog, tell, noticeEmbed } = require('../lib/moderation');

module.exports = {
  data: command('ban', 'Ban a user from the server, in it or not, and optionally delete their recent messages', PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
    .addStringOption(reasonOption)
    .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
  requires: PermissionFlagsBits.BanMembers,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || undefined;
    const days = interaction.options.getInteger('delete_days') || 0;
    const target = await memberOf(interaction.guild, user);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);

    const already = await interaction.guild.bans.fetch(user.id).catch(() => null);
    if (already) return sayFail(interaction, `${user.tag} is already banned.`);

    const told = target ? await tell(user, noticeEmbed(interaction.guild.name, 'ban', reason)) : false;
    await interaction.guild.members.ban(user.id, { reason: `${reason || 'No reason given'} - by ${interaction.user.tag}`, deleteMessageSeconds: days * 86400 });
    ctx.log.info(`banned ${user.tag} (${user.id}) by ${interaction.user.tag}: ${reason || 'no reason'}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'ban', target: target || user, moderator: interaction.member, reason, fields: [
      { name: 'Messages deleted', value: days ? `Last ${days} day(s)` : 'None' },
      { name: 'Told them', value: told ? 'Yes (DM)' : target ? 'No (DMs closed)' : 'Not in the server' },
    ] }));
    return sayOk(interaction, `**${user.tag}** was banned.${reason ? ` Reason: ${reason}` : ''}`);
  },
};
