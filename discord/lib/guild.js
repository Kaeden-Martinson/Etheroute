'use strict';

/**
 * Finding the server's furniture: the channels and roles the bot works
 * with, from what .env says they are called. Servers decorate channel
 * names - "👋-welcome", "✅︱verify", "anti・bot" - so a name is compared
 * with everything but letters and digits stripped, exact first, then as
 * a prefix, then anywhere in the name. An id is taken as it is.
 */

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/** "✅︱Verify-Here" → "verifyhere" */
function normalise(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isId(spec) {
  return /^\d{15,22}$/.test(String(spec || '').trim());
}

const specs = (spec) => String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The best match among `items` (anything with .id and .name) for a spec:
 * an id, a name, or a comma list tried in order. Null when nothing fits.
 */
function match(items, spec) {
  const list = Array.from(items && items.values ? items.values() : items || []);
  for (const want of specs(spec)) {
    if (isId(want)) {
      const byId = list.find((c) => c.id === want);
      if (byId) return byId;
      continue;
    }
    const key = normalise(want);
    if (!key) continue;
    const exact = list.find((c) => normalise(c.name) === key);
    if (exact) return exact;
    const prefix = list.find((c) => normalise(c.name).startsWith(key));
    if (prefix) return prefix;
    const inside = list.find((c) => normalise(c.name).includes(key));
    if (inside) return inside;
  }
  return null;
}

function textChannels(guild) {
  return Array.from(guild.channels.cache.values()).filter((c) => TEXT_TYPES.has(c.type));
}

function resolveChannel(guild, spec) {
  return match(textChannels(guild), spec);
}

function resolveRole(guild, spec) {
  return match(Array.from(guild.roles.cache.values()).filter((r) => r.id !== guild.id), spec);
}

/** The Member role, made if the server has none by that name. */
async function ensureRole(guild, spec, { reason = 'Etheroute bot: the role verified members receive' } = {}) {
  const found = resolveRole(guild, spec);
  if (found) return { role: found, created: false };
  const name = specs(spec).find((s) => !isId(s)) || 'Member';
  const role = await guild.roles.create({ name, reason, mentionable: false });
  return { role, created: true };
}

/** Whether the bot can do what a command needs in a channel. */
function botCan(channel, ...flags) {
  const me = channel.guild && channel.guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return Boolean(perms && flags.every((f) => perms.has(f)));
}

/** All the purposes the bot serves, resolved against the live server. */
function resolveAll(guild, config) {
  const out = { channels: {}, roles: {} };
  for (const [purpose, spec] of Object.entries(config.channels)) out.channels[purpose] = resolveChannel(guild, spec);
  out.roles.member = resolveRole(guild, config.roles.member);
  return out;
}

module.exports = { normalise, isId, match, resolveChannel, resolveRole, ensureRole, resolveAll, botCan, textChannels, TEXT_TYPES, PermissionFlagsBits };
