'use strict';

/**
 * Verification: one panel in #verify with a button; pressing it gives the
 * Member role, which is what the rest of the server is gated on. The
 * panel is posted once and remembered, so a restart does not post it
 * again; /panel verify posts a fresh one.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { embed, ok, fail, COLORS } = require('./embeds');

const BUTTON_ID = 'verify:member';

function panel(config, { roleName = 'Member', rulesChannel = null } = {}) {
  const rules = rulesChannel ? ` Read ${rulesChannel.toString()} first.` : '';
  return {
    embeds: [embed({
      title: `Welcome to ${config.brand.name}`,
      description: `Press **Verify** below to confirm you are a person and unlock the server.${rules}\n\nYou will receive the **${roleName}** role and see every channel it opens.`,
      color: COLORS.brand,
      footer: `${config.brand.name} · ${config.brand.site.replace(/^https?:\/\//, '')}`,
      timestamp: false,
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success),
    )],
  };
}

/** Post the panel unless the one we remember is still there. */
async function ensurePanel(ctx, guild, { force = false } = {}) {
  const channel = ctx.found.channels.verify;
  if (!channel) {
    ctx.log.warn('no verify channel found - set DISCORD_VERIFY_CHANNEL to its name or id');
    return null;
  }
  const remembered = ctx.store.data.panels.verify;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const roleName = ctx.found.roles.member ? ctx.found.roles.member.name : ctx.config.roles.member;
  const message = await channel.send(panel(ctx.config, { roleName, rulesChannel: ctx.found.channels.rules }));
  ctx.store.update('panels', (p) => { p.verify = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`verification panel posted in #${channel.name}`);
  return message;
}

/** The button was pressed. */
async function handleButton(interaction, ctx) {
  const role = ctx.found.roles.member;
  if (!role) {
    return interaction.reply({ embeds: [fail('There is no Member role to give yet - tell an admin.')], flags: MessageFlags.Ephemeral });
  }
  const member = interaction.member;
  if (member.roles.cache.has(role.id)) {
    return interaction.reply({ embeds: [ok('You are already verified. Welcome back.')], flags: MessageFlags.Ephemeral });
  }
  try {
    await member.roles.add(role, 'Verified through the panel');
  } catch (err) {
    ctx.log.error('could not give the member role:', err.message);
    return interaction.reply({ embeds: [fail('I could not give you the role. An admin needs to move my role above **' + role.name + '** in Server Settings → Roles.')], flags: MessageFlags.Ephemeral });
  }
  ctx.log.info(`verified ${interaction.user.tag} (${interaction.user.id})`);
  return interaction.reply({ embeds: [ok(`You are verified - welcome to **${interaction.guild.name}**.`)], flags: MessageFlags.Ephemeral });
}

module.exports = { BUTTON_ID, panel, ensurePanel, handleButton };
