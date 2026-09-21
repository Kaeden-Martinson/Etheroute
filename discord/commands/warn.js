'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, memberOf, sayOk, sayFail } = require('../lib/slash');
const { canActOn, caseEmbed, modLog, tell, noticeEmbed } = require('../lib/moderation');

/** The warnings on record for a user, newest last. */
function warningsFor(store, userId) {
  return (store.data.warnings[userId] || []).slice();
}

module.exports = {
  data: command('warn', 'Put a warning on a member\'s record and tell them', PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('What for').setRequired(true).setMaxLength(400)),
  requires: PermissionFlagsBits.ModerateMembers,
  warningsFor,
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const target = await memberOf(interaction.guild, user);
    if (!target) return sayFail(interaction, `${user.tag} is not in this server.`);
    const check = canActOn(interaction.member, target, interaction.guild);
    if (!check.ok) return sayFail(interaction, check.reason);

    let count = 0;
    ctx.store.update('warnings', (all) => {
      const list = all[user.id] || (all[user.id] = []);
      list.push({ id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, reason, by: interaction.user.id, byTag: interaction.user.tag, at: new Date().toISOString() });
      count = list.length;
    });
    const told = await tell(user, noticeEmbed(interaction.guild.name, 'warn', reason, [{ name: 'Warnings on record', value: String(count) }]));
    ctx.log.info(`warned ${user.tag} (${user.id}) by ${interaction.user.tag}: ${reason} (#${count})`);
    await modLog(ctx, interaction.guild, caseEmbed({ action: 'warn', target, moderator: interaction.member, reason, fields: [
      { name: 'Warnings now', value: String(count) },
      { name: 'Told them', value: told ? 'Yes (DM)' : 'No (DMs closed)' },
    ] }));
    return sayOk(interaction, `**${user.tag}** was warned (${count} on record). Reason: ${reason}`);
  },
};
