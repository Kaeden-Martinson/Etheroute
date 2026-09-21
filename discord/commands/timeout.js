'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption, memberOf, sayOk, sayFail, when } = require('../lib/slash');
const { canActOn, caseEmbed, modLog, tell, noticeEmbed } = require('../lib/moderation');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../lib/duration');

module.exports = {
  data: command('timeout', 'Mute a member for a while: they can read but not post, react or join voice', PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who to time out').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('How long: 10m, 2h, 1d, 1h30m (up to 28d)').setRequired(true).setMaxLength(20))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.ModerateMembers,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const ms = parseDuration(interaction.options.getString('duration', true));
    const reason = interaction.options.getString('reason') || undefined;
    if (!ms) return sayFail(interaction, 'I did not understand that duration. Try 10m, 2h, 1d or 1h30m.');
    if (ms > MAX_TIMEOUT_MS) return sayFail(interaction, 'Discord allows a timeout of at most 28 days.');
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);
    if (!target.moderatable) return sayFail(interaction, 'I cannot time them out - an administrator, or above my role.');

    await target.timeout(ms, `${reason || 'No reason given'} - by ${interaction.user.tag}`);
    const until = new Date(Date.now() + ms);
    const told = await tell(user, noticeEmbed(interaction.guild.name, 'timeout', reason, [{ name: 'For', value: formatDuration(ms) }, { name: 'Until', value: when(until) }]));
    ctx.log.info(`timed out ${user.tag} (${user.id}) for ${formatDuration(ms)} by ${interaction.user.tag}: ${reason || 'no reason'}`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'timeout', target, moderator: interaction.member, reason, fields: [
      { name: 'For', value: formatDuration(ms) },
      { name: 'Until', value: when(until) },
      { name: 'Told them', value: told ? 'Yes (DM)' : 'No (DMs closed)' },
    ] }));
    return sayOk(interaction, `**${user.tag}** is timed out for **${formatDuration(ms)}** (until ${when(until)}).`);
  },
};
