'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, memberOf, sayOk, sayFail } = require('../lib/slash');
const { canActOn, caseEmbed, modLog } = require('../lib/moderation');

module.exports = {
  data: command('nick', 'Change a member\'s nickname, or clear it', PermissionFlagsBits.ManageNicknames)
    .addUserOption((o) => o.setName('user').setDescription('Whose').setRequired(true))
    .addStringOption((o) => o.setName('name').setDescription('The new nickname; leave out to clear it').setMaxLength(32)),
  requires: PermissionFlagsBits.ManageNicknames,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const name = (interaction.options.getString('name') || '').trim() || null;
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);
    if (!target.manageable) return sayFail(interaction, 'I cannot change their nickname - above my role, or the owner.');

    const before = target.displayName;
    await target.setNickname(name, `By ${interaction.user.tag}`);
    ctx.log.info(`nickname of ${user.tag} (${user.id}) set to ${name || '(cleared)'} by ${interaction.user.tag}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'nick', target, moderator: interaction.member, reason: `${before} → ${name || user.username}` }));
    return sayOk(interaction, name ? `**${user.tag}** is now **${name}**.` : `**${user.tag}**'s nickname was cleared.`);
  },
};
