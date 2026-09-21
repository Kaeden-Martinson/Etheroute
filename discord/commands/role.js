'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, memberOf, sayOk, sayFail } = require('../lib/slash');
const { caseEmbed, modLog, position } = require('../lib/moderation');

module.exports = {
  data: command('role', 'Give a member a role, or take one away', PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) => s.setName('add').setDescription('Give a role')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Which role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Take a role away')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Which role').setRequired(true))),
  requires: PermissionFlagsBits.ManageRoles,
  async execute(interaction, ctx) {
    const adding = interaction.options.getSubcommand() === 'add';
    const user = interaction.options.getUser('user', true);
    const role = interaction.options.getRole('role', true);
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    if (role.managed) return sayFail(interaction, `**${role.name}** belongs to an integration and cannot be given by hand.`);
    if (role.id === interaction.guild.id) return sayFail(interaction, 'Everyone already has @everyone.');
    const me = interaction.guild.members.me;
    const isOwner = interaction.user.id === interaction.guild.ownerId;
    if (!isOwner && role.position >= position(interaction.member)) return sayFail(interaction, `**${role.name}** is at or above your highest role.`);
    if (me && role.position >= position(me)) return sayFail(interaction, `**${role.name}** is at or above my highest role - move mine up in Server Settings → Roles.`);
    const has = target.roles.cache.has(role.id);
    if (adding && has) return sayFail(interaction, `${user.tag} already has **${role.name}**.`);
    if (!adding && !has) return sayFail(interaction, `${user.tag} does not have **${role.name}**.`);

    if (adding) await target.roles.add(role, `By ${interaction.user.tag}`);
    else await target.roles.remove(role, `By ${interaction.user.tag}`);
    ctx.log.info(`role ${role.name} ${adding ? 'given to' : 'taken from'} ${user.tag} (${user.id}) by ${interaction.user.tag}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'role', target, moderator: interaction.member, reason: `${adding ? 'Added' : 'Removed'} ${role.toString()}` }));
    return sayOk(interaction, `**${role.name}** ${adding ? 'given to' : 'taken from'} **${user.tag}**.`);
  },
};
