'use strict';

/**
 * The little every slash command needs: a builder that is server-only and
 * carries the permission Discord shows it to, the target as a member of
 * this server (or null when they have left), and replies in the house
 * embeds. A command module is { data, requires, execute }; `requires` is
 * checked again when the command runs, because the permission on the
 * builder is only Discord's default and an admin can loosen it.
 */

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const { ok, fail } = require('./embeds');

function command(name, description, permission) {
  const b = new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
  if (permission !== undefined && permission !== null) b.setDefaultMemberPermissions(permission);
  return b;
}

const reasonOption = (o) => o.setName('reason').setDescription('Why - goes to the log and to them').setMaxLength(400);

async function memberOf(guild, user) {
  if (!user) return null;
  return guild.members.fetch(user.id).catch(() => null);
}

const sayOk = (interaction, text, extra = {}) => interaction.reply({ embeds: [ok(text)], ...extra });
const sayFail = (interaction, text) => interaction.reply({ embeds: [fail(text)], flags: MessageFlags.Ephemeral });

/** A time as Discord renders it, relative and absolute. */
const when = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

module.exports = { command, reasonOption, memberOf, sayOk, sayFail, when };
