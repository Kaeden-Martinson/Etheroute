'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { command, reasonOption } = require('../lib/slash');
const { setLocked } = require('./lock');

module.exports = {
  data: command('unlock', 'Let members post in a locked channel again', PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('channel').setDescription('Another channel than this one'))
    .addStringOption(reasonOption),
  requires: PermissionFlagsBits.ManageChannels,
  execute: (interaction, ctx) => setLocked(interaction, ctx, false),
};
