'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { command, sayOk } = require('../lib/slash');
const { ok, fail } = require('../lib/embeds');
const verify = require('../lib/verify');
const antibot = require('../lib/antibot');

module.exports = {
  data: command('panel', 'Post the verification panel or the anti-bot notice again', PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('verify').setDescription('A fresh verification panel in the verify channel'))
    .addSubcommand((s) => s.setName('antibot').setDescription('A fresh notice in the anti-bot channel'))
    .addSubcommand((s) => s.setName('status').setDescription('Which channels and role the bot found')),
  requires: PermissionFlagsBits.ManageGuild,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const f = ctx.found;
      const line = (label, thing) => `**${label}:** ${thing ? thing.toString() : '_not found_'}`;
      return sayOk(interaction, [
        line('Welcome', f.channels.welcome), line('Verify', f.channels.verify), line('Anti-bot', f.channels.antibot),
        line('Mod-log', f.channels.log), line('Rules', f.channels.rules), line('Member role', f.roles.member),
        `**Anti-bot action:** ${ctx.config.antibot.action}`,
      ].join('\n'), { flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = sub === 'verify'
      ? await verify.ensurePanel(ctx, interaction.guild, { force: true })
      : await antibot.ensureNotice(ctx, interaction.guild, { force: true });
    if (!message) return interaction.editReply({ embeds: [fail(`I could not find the ${sub === 'verify' ? 'verify' : 'anti-bot'} channel. Set ${sub === 'verify' ? 'DISCORD_VERIFY_CHANNEL' : 'DISCORD_ANTIBOT_CHANNEL'} in .env and restart me.`)] });
    return interaction.editReply({ embeds: [ok(`Posted in ${message.channel.toString()}.`)] });
  },
};
