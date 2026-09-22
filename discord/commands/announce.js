'use strict';

const { PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { command, sayOk, sayFail } = require('../lib/slash');
const { embed, COLORS } = require('../lib/embeds');
const { botCan } = require('../lib/guild');

module.exports = {
  data: command('announce', 'Post an announcement in the updates channel, pinging the Announcements role', PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('title').setDescription('The headline').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('message').setDescription('The body; \\n starts a new line').setRequired(true).setMaxLength(2000))
    .addChannelOption((o) => o.setName('channel').setDescription('Where (default: the updates channel, else here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('color').setDescription('The edge colour').addChoices(
      { name: 'Brand blue', value: 'brand' }, { name: 'Green', value: 'ok' }, { name: 'Amber', value: 'warn' }, { name: 'Red', value: 'danger' },
    ))
    .addStringOption((o) => o.setName('ping').setDescription('Who to mention above it (default: the Announcements role)').addChoices(
      { name: 'Nobody', value: 'none' }, { name: 'The Announcements role', value: 'announcements' }, { name: '@everyone', value: 'everyone' },
    )),
  requires: PermissionFlagsBits.ManageMessages,
  async execute(interaction, ctx) {
    const title = interaction.options.getString('title', true);
    const body = interaction.options.getString('message', true).replace(/\\n/g, '\n');
    // the updates channel the bot found, unless told otherwise; the Announcements role pinged, unless told otherwise
    const channel = interaction.options.getChannel('channel') || ctx.found.channels.updates || interaction.channel;
    const color = COLORS[interaction.options.getString('color') || 'brand'];
    const announcements = ctx.found.roles.announcements;
    const ping = interaction.options.getString('ping') || (announcements ? 'announcements' : 'none');
    if (!botCan(channel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks)) return sayFail(interaction, `I cannot post in ${channel.toString()}.`);
    if (ping === 'everyone' && !interaction.memberPermissions.has(PermissionFlagsBits.MentionEveryone)) return sayFail(interaction, 'You cannot mention @everyone here.');
    if (ping === 'announcements' && !announcements) return sayFail(interaction, 'There is no Announcements role to ping - restart me, or set DISCORD_ANNOUNCEMENTS_ROLE.');

    await channel.send({
      content: ping === 'everyone' ? '@everyone' : ping === 'announcements' ? announcements.toString() : undefined,
      embeds: [embed({ title, description: body, color, footer: `${ctx.config.brand.name} · posted by ${interaction.user.tag}` })],
      allowedMentions: { parse: ping === 'everyone' ? ['everyone'] : [], roles: ping === 'announcements' ? [announcements.id] : [] },
    });
    ctx.log.info(`announcement "${title}" posted in #${channel.name} by ${interaction.user.tag}${ping !== 'none' ? ` (pinging ${ping})` : ''}`);
    return sayOk(interaction, `Posted in ${channel.toString()}${ping === 'announcements' ? `, pinging ${announcements.toString()}` : ping === 'everyone' ? ', pinging @everyone' : ''}.`, { flags: MessageFlags.Ephemeral });
  },
};
