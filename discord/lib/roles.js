'use strict';

/**
 * Roles people give themselves: one panel in #roles with a button per
 * role. Merchant and Buyer say what someone is here for; Announcements
 * is the role /announce can ping; Status Updates is pinged when a service
 * or network changes state. A button toggles: press it again and the role is gone.
 * The panel is posted once and remembered; /panel roles posts a fresh one.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { embed, ok, fail, COLORS } = require('./embeds');
const { ensureRole } = require('./guild');

const PREFIX = 'role:';

const CLAIMABLE = [
  { key: 'merchant', emoji: '🏪', style: ButtonStyle.Primary, blurb: 'You accept payments with Etheroute, or mean to.' },
  { key: 'buyer', emoji: '🛒', style: ButtonStyle.Primary, blurb: 'You pay merchants in crypto and want the buyer side of things.' },
  { key: 'announcements', emoji: '📣', style: ButtonStyle.Secondary, blurb: 'Pinged for announcements: releases, new chains, product news.' },
  { key: 'status', emoji: '📡', style: ButtonStyle.Secondary, blurb: 'Pinged when a service or a network goes down or comes back.' },
];

const buttonId = (key) => `${PREFIX}${key}`;
const isRoleButton = (customId) => typeof customId === 'string' && customId.startsWith(PREFIX);

/** The embed and the row of buttons; roles the server lacks are left off the row. */
function panel(config, found) {
  const lines = CLAIMABLE.map((c) => {
    const role = found.roles[c.key];
    const name = role ? role.toString() : `**${config.roles[c.key]}**`;
    return `${c.emoji} ${name} - ${c.blurb}`;
  });
  const row = new ActionRowBuilder();
  for (const c of CLAIMABLE) {
    const role = found.roles[c.key];
    if (!role) continue;
    row.addComponents(new ButtonBuilder().setCustomId(buttonId(c.key)).setLabel(role.name).setEmoji(c.emoji).setStyle(c.style));
  }
  return {
    embeds: [embed({
      title: 'Pick your roles',
      description: `Press a button to take a role; press it again to drop it. Take as many as fit.\n\n${lines.join('\n')}`,
      color: COLORS.brand,
      footer: `${config.brand.name} · ${config.brand.site.replace(/^https?:\/\//, '')}`,
      timestamp: false,
    })],
    components: row.components.length ? [row] : [],
  };
}

/** Every claimable role exists after this; the ones made are named. */
async function ensureClaimable(ctx, guild) {
  const made = [];
  for (const c of CLAIMABLE) {
    if (ctx.found.roles[c.key]) continue;
    const { role, created } = await ensureRole(guild, ctx.config.roles[c.key], { reason: `Etheroute bot: the ${c.key} role people claim in #roles` });
    ctx.found.roles[c.key] = role;
    if (created) made.push(role.name);
  }
  return made;
}

/** Post the panel unless the one we remember is still there. */
async function ensurePanel(ctx, guild, { force = false } = {}) {
  const channel = ctx.found.channels.roles;
  if (!channel) {
    ctx.log.warn('no roles channel found - set DISCORD_ROLES_CHANNEL to its name or id');
    return null;
  }
  const remembered = ctx.store.data.panels.roles;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const message = await channel.send(panel(ctx.config, ctx.found));
  ctx.store.update('panels', (p) => { p.roles = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`roles panel posted in #${channel.name}`);
  return message;
}

/** A button was pressed: the role on, or off again. */
async function handleButton(interaction, ctx) {
  const key = interaction.customId.slice(PREFIX.length);
  const claim = CLAIMABLE.find((c) => c.key === key);
  const role = claim && ctx.found.roles[key];
  if (!role) return interaction.reply({ embeds: [fail('That role is not on this server any more - tell an admin.')], flags: MessageFlags.Ephemeral });
  const member = interaction.member;
  const has = member.roles.cache.has(role.id);
  try {
    if (has) await member.roles.remove(role, 'Dropped from the roles panel');
    else await member.roles.add(role, 'Claimed from the roles panel');
  } catch (err) {
    ctx.log.error(`could not ${has ? 'remove' : 'give'} ${role.name}:`, err.message);
    return interaction.reply({ embeds: [fail(`I could not change that role. An admin needs to move my role above **${role.name}** in Server Settings → Roles.`)], flags: MessageFlags.Ephemeral });
  }
  ctx.log.info(`${interaction.user.tag} (${interaction.user.id}) ${has ? 'dropped' : 'took'} ${role.name}`);
  return interaction.reply({ embeds: [ok(has ? `**${role.name}** removed.` : `You now have **${role.name}**.${key === 'status' ? ' You will be pinged when something goes down or comes back.' : key === 'announcements' ? ' You will be pinged for announcements.' : ''}`)], flags: MessageFlags.Ephemeral });
}

module.exports = { CLAIMABLE, PREFIX, buttonId, isRoleButton, panel, ensureClaimable, ensurePanel, handleButton };
