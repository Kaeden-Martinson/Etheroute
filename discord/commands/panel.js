'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { command, sayOk } = require('../lib/slash');
const { ok, fail } = require('../lib/embeds');
const verify = require('../lib/verify');
const antibot = require('../lib/antibot');
const roles = require('../lib/roles');
const status = require('../lib/status');
const tickets = require('../lib/tickets');

const ENV = { verify: 'DISCORD_VERIFY_CHANNEL', antibot: 'DISCORD_ANTIBOT_CHANNEL', roles: 'DISCORD_ROLES_CHANNEL', status: 'DISCORD_STATUS_CHANNEL', support: 'DISCORD_SUPPORT_CHANNEL' };

module.exports = {
  data: command('panel', 'Post one of the bot\'s panels again, or see what it found on the server', PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('verify').setDescription('A fresh verification panel in the verify channel'))
    .addSubcommand((s) => s.setName('antibot').setDescription('A fresh notice in the anti-bot channel'))
    .addSubcommand((s) => s.setName('roles').setDescription('A fresh role-picker in the roles channel'))
    .addSubcommand((s) => s.setName('status').setDescription('A fresh status embed in the status channel'))
    .addSubcommand((s) => s.setName('support').setDescription('A fresh ticket panel in the support channel'))
    .addSubcommand((s) => s.setName('check').setDescription('Which channels and roles the bot found')),
  requires: PermissionFlagsBits.ManageGuild,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'check') {
      const f = ctx.found;
      const line = (label, thing) => `**${label}:** ${thing ? thing.toString() : '_not found_'}`;
      return sayOk(interaction, [
        line('Welcome', f.channels.welcome), line('Verify', f.channels.verify), line('Anti-bot', f.channels.antibot), line('Roles', f.channels.roles),
        line('Status', f.channels.status), line('Support', f.channels.support), line('Transcripts', f.channels.transcripts), line('Mod-log', f.channels.log), line('Rules', f.channels.rules),
        line('Member role', f.roles.member), line('Support role', f.roles.support), ...roles.CLAIMABLE.map((c) => line(`${c.emoji} ${c.key}`, f.roles[c.key])),
        `**Tickets open:** ${tickets.open(ctx).length} of ${ctx.config.tickets.max}`,
        `**Anti-bot action:** ${ctx.config.antibot.action}`,
        `**Status from:** ${ctx.config.status.apiUrl} every ${Math.round(ctx.config.status.intervalMs / 60000)} min`,
      ].join('\n'), { flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const post = {
      verify: () => verify.ensurePanel(ctx, interaction.guild, { force: true }),
      antibot: () => antibot.ensureNotice(ctx, interaction.guild, { force: true }),
      roles: () => roles.ensurePanel(ctx, interaction.guild, { force: true }),
      status: () => status.ensureMessage(ctx, interaction.guild, { force: true }),
      support: () => tickets.ensurePanel(ctx, interaction.guild, { force: true }),
    }[sub];
    const message = await post();
    if (!message) return interaction.editReply({ embeds: [fail(`I could not find the ${sub} channel. Set ${ENV[sub]} in .env and restart me.`)] });
    return interaction.editReply({ embeds: [ok(`Posted in ${message.channel.toString()}.`)] });
  },
};
