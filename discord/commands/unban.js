'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption, sayOk, sayFail } = require('../lib/slash');
const { caseEmbed, modLog } = require('../lib/moderation');

module.exports = {
  data: command('unban', 'Lift a ban by user id', PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('The banned user\'s id (Server Settings → Bans)').setRequired(true).setMinLength(15).setMaxLength(22))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.BanMembers,
  async execute(interaction, ctx) {
    const id = interaction.options.getString('user_id', true).trim();
    const reason = interaction.options.getString('reason') || undefined;
    if (!/^\d{15,22}$/.test(id)) return sayFail(interaction, 'That is not a user id. Right-click the ban in Server Settings → Bans and copy the id.');
    const ban = await interaction.guild.bans.fetch(id).catch(() => null);
    if (!ban) return sayFail(interaction, 'Nobody with that id is banned here.');

    await interaction.guild.members.unban(id, `${reason || 'No reason given'} - by ${interaction.user.tag}`);
    ctx.log.info(`unbanned ${ban.user.tag} (${id}) by ${interaction.user.tag}: ${reason || 'no reason'}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'unban', target: ban.user, moderator: interaction.member, reason }));
    return sayOk(interaction, `**${ban.user.tag}** was unbanned.`);
  },
};
