'use strict';

const { MessageFlags } = require('discord.js');
const { command } = require('../lib/slash');
const { embed, COLORS } = require('../lib/embeds');

/** Commands grouped by what they are for; anything not named lands in "More". */
const GROUPS = [
  { name: 'Moderation', names: ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'warn', 'warnings', 'purge'] },
  { name: 'Channels', names: ['slowmode', 'lock', 'unlock', 'announce'] },
  { name: 'Members', names: ['role', 'nick', 'userinfo', 'avatar'] },
  { name: 'Support', names: ['support', 'ticket'] },
  { name: 'Server', names: ['status', 'giveaway', 'panel', 'serverinfo', 'ping', 'help'] },
];

module.exports = {
  data: command('help', 'Every command the bot has, and what each is for'),
  async execute(interaction, ctx) {
    const all = ctx.commands.list;
    const perms = interaction.memberPermissions;
    // only the commands this person can actually run
    const mine = all.filter((c) => !c.requires || (perms && perms.has(c.requires)));
    const named = new Set();
    const fields = [];
    for (const group of GROUPS) {
      const rows = group.names.map((n) => mine.find((c) => c.data.name === n)).filter(Boolean);
      rows.forEach((c) => named.add(c.data.name));
      if (rows.length) fields.push({ name: group.name, value: rows.map((c) => `**/${c.data.name}** - ${c.data.description}`).join('\n'), inline: false });
    }
    const rest = mine.filter((c) => !named.has(c.data.name));
    if (rest.length) fields.push({ name: 'More', value: rest.map((c) => `**/${c.data.name}** - ${c.data.description}`).join('\n'), inline: false });
    return interaction.reply({ embeds: [embed({
      title: `${ctx.config.brand.name} bot`,
      description: `${mine.length} of ${all.length} commands are yours to use. Verification is the button in ${ctx.found.channels.verify ? ctx.found.channels.verify.toString() : '#verify'}; roles are the buttons in ${ctx.found.channels.roles ? ctx.found.channels.roles.toString() : '#roles'}; the anti-bot channel removes anyone who posts in it.`,
      color: COLORS.brand,
      fields,
      footer: ctx.config.brand.site.replace(/^https?:\/\//, ''),
      timestamp: false,
    })], flags: MessageFlags.Ephemeral });
  },
};
