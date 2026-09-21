'use strict';

/**
 * The link that adds the bot to a server, with the permissions it needs
 * and no more: to kick, ban and time out; to delete messages and lock
 * channels; to give the Member role and change nicknames; and to speak.
 * Administrator is not among them.
 */

const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');

const NEEDED = [
  P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis,
  P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ManageRoles, P.ManageChannels, P.ManageNicknames, P.MentionEveryone,
];

/** The gateway intents the bot asks for; "Server Members" is privileged and must be switched on in the portal. */
const INTENTS = ['Guilds', 'GuildMembers', 'GuildMessages', 'GuildModeration'];

function permissions() {
  return new PermissionsBitField(NEEDED).bitfield.toString();
}

function inviteUrl(clientId) {
  if (!clientId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=${permissions()}`;
}

module.exports = { NEEDED, INTENTS, permissions, inviteUrl };
