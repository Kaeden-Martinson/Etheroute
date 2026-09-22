'use strict';

const { PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { command, sayOk, sayFail } = require('../lib/slash');
const { embed, COLORS } = require('../lib/embeds');
const { botCan } = require('../lib/guild');

module.exports = {
  data: command('announce', 'Post an announcement as an embed in the bot\'s voice', PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('title').setDescription('The headline').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('message').setDescription('The body; \\n starts a new line').setRequired(true).setMaxLength(2000))
    .addChannelOption((o) => o.setName('channel').setDescription('Where (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('color').setDescription('The edge colour').addChoices(
      { name: 'Brand blue', value: 'brand' }, { name: 'Green', value: 'ok' }, { name: 'Amber', value: 'warn' }, { name: 'Red', value: 'danger' },
    ))
    .addStringOption((o) => o.setName('ping').setDescription('Who to mention above it').addChoices(
      { name: 'Nobody', value: 'none' }, { name: 'The Updates role', value: 'updates' }, { name: '@everyone', value: 'everyone' },
    )),
  requires: PermissionFlagsBits.ManageMessages,
  async execute(interaction, ctx) {
    const title = interaction.options.getString('title', true);
    const body = interaction.options.getString('message', true).replace(/\\n/g, '\n');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const color = COLORS[interaction.options.getString('color') || 'brand'];
    const ping = interaction.options.getString('ping') || 'none';
    if (!botCan(channel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks)) return sayFail(interaction, `I cannot post in ${channel.toString()}.`);
    if (ping === 'everyone' && !interaction.memberPermissions.has(PermissionFlagsBits.MentionEveryone)) return sayFail(interaction, 'You cannot mention @everyone here.');
    const updates = ctx.found.roles.updates;
    if (ping === 'updates' && !updates) return sayFail(interaction, 'There is no Updates role to ping - restart me, or set DISCORD_UPDATES_ROLE.');

    await channel.send({
      content: ping === 'everyone' ? '@everyone' : ping === 'updates' ? updates.toString() : undefined,
      embeds: [embed({ title, description: body, color, footer: `${ctx.config.brand.name} · posted by ${interaction.user.tag}` })],
      allowedMentions: { parse: ping === 'everyone' ? ['everyone'] : [], roles: ping === 'updates' ? [updates.id] : [] },
    });
    ctx.log.info(`announcement "${title}" posted in #${channel.name} by ${interaction.user.tag}${ping !== 'none' ? ` (pinging ${ping})` : ''}`);
    return sayOk(interaction, `Posted in ${channel.toString()}.`, { flags: MessageFlags.Ephemeral });
  },
};
