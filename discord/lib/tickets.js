'use strict';

/**
 * Support tickets. A panel in #support has an "Open a ticket" button (and
 * /support does the same); the person says what they need in a short
 * form, and a private channel opens under the Tickets category that only
 * they, the Support role and admins can see. Staff talk to them there,
 * add or remove people with /ticket, and close it with the button or
 * /ticket close. On close the whole conversation is saved as a text
 * transcript to #ticket-logs (or the mod-log), a copy goes to the person
 * by DM, and the channel is removed. One open ticket per person; a cap on
 * how many are open at once, since a category holds fifty channels.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const { embed, ok, fail, COLORS, who, cut } = require('./embeds');
const { normalise } = require('./guild');
const modlog = require('./modlog');

const OPEN_BUTTON = 'ticket:open';
const CLOSE_BUTTON = 'ticket:close';
const MODAL = 'ticket:new';
const SUBJECT = 'subject';
const TRANSCRIPT_LIMIT = 500;
const DELETE_AFTER_MS = 5000;

// ── the panel and the form ───────────────────────────────────────────────
function panel(config, found) {
  const staff = found.roles.support ? ` Someone from ${found.roles.support.toString()} will answer there.` : ' Someone from the team will answer there.';
  return {
    embeds: [embed({
      title: '🎫 Need a hand?',
      description: `Press **Open a ticket** and say what you need. A private channel opens that only you and the team can see.${staff}\n\nGood for: a payment that has not settled, a payout question, an integration problem, anything about your account.`,
      color: COLORS.brand,
      footer: `${config.brand.name} · ${config.brand.site.replace(/^https?:\/\//, '')}`,
      timestamp: false,
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(OPEN_BUTTON).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    )],
  };
}

function modal() {
  return new ModalBuilder().setCustomId(MODAL).setTitle('Open a ticket').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(SUBJECT).setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(10).setMaxLength(400).setPlaceholder('A sentence or two: what happened, and where (a payment id, a chain, an error).'),
    ),
  );
}

const closeRow = () => [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(CLOSE_BUTTON).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
)];

/** Post the panel unless the one we remember is still there. */
async function ensurePanel(ctx, guild, { force = false } = {}) {
  const channel = ctx.found.channels.support;
  if (!channel) {
    ctx.log.warn('no support channel found - set DISCORD_SUPPORT_CHANNEL to its name or id');
    return null;
  }
  const remembered = ctx.store.data.panels.support;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const message = await channel.send(panel(ctx.config, ctx.found));
  ctx.store.update('panels', (p) => { p.support = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`support panel posted in #${channel.name}`);
  return message;
}

// ── the record ───────────────────────────────────────────────────────────
const all = (ctx) => Object.values(ctx.store.data.tickets || {});
const open = (ctx) => all(ctx).filter((t) => t.status === 'open');
const ticketOf = (ctx, channelId) => (ctx.store.data.tickets || {})[channelId] || null;
const openFor = (ctx, userId) => open(ctx).find((t) => t.userId === userId) || null;

/** Whether this person may run staff actions on tickets. */
function isStaff(member, ctx) {
  if (!member) return false;
  if (member.permissions && typeof member.permissions.has === 'function' && (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator))) return true;
  const support = ctx.found.roles.support;
  return Boolean(support && member.roles && member.roles.cache && member.roles.cache.has(support.id));
}

async function category(ctx, guild) {
  const want = normalise(ctx.config.tickets.category);
  const existing = Array.from(guild.channels.cache.values()).find((c) => c.type === ChannelType.GuildCategory && normalise(c.name) === want);
  if (existing) return existing;
  const me = guild.members.me;
  const support = ctx.found.roles.support;
  const made = await guild.channels.create({
    name: ctx.config.tickets.category,
    type: ChannelType.GuildCategory,
    reason: 'Etheroute bot: where support tickets open',
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      me ? { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] } : null,
      support ? { id: support.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] } : null,
    ].filter(Boolean),
  });
  ctx.log.info(`made the ${made.name} category for tickets`);
  return made;
}

const slug = (name) => String(name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'user';

/**
 * Open a ticket for `user` about `subject`. Returns { ticket, channel } or
 * { error } in words for the person.
 */
async function openTicket(ctx, guild, user, subject) {
  const existing = openFor(ctx, user.id);
  if (existing) return { error: `You already have a ticket open: <#${existing.channelId}>.`, channel: existing.channelId };
  if (open(ctx).length >= ctx.config.tickets.max) return { error: 'Every ticket slot is taken right now. Try again in a little while, or ask in the server.' };

  const parent = await category(ctx, guild);
  const number = (ctx.store.data.ticketCounter || 0) + 1;
  const me = guild.members.me;
  const support = ctx.found.roles.support;
  const channel = await guild.channels.create({
    name: `ticket-${String(number).padStart(4, '0')}-${slug(user.username)}`,
    type: ChannelType.GuildText,
    parent: parent.id,
    topic: `Ticket #${number} · ${user.tag || user.username} (${user.id}) · ${cut(subject, 200)}`,
    reason: `Ticket #${number} for ${user.tag || user.username}`,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      me ? { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] } : null,
      support ? { id: support.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] } : null,
    ].filter(Boolean),
  });

  const ticket = { number, channelId: channel.id, userId: user.id, userTag: user.tag || user.username, subject: cut(subject, 400), openedAt: new Date().toISOString(), status: 'open', added: [] };
  ctx.store.update('tickets', (t) => { t[channel.id] = ticket; });
  ctx.store.data.ticketCounter = number;
  ctx.store.save();

  await channel.send({
    content: `${user.toString()}${support ? ` ${support.toString()}` : ''}`,
    embeds: [embed({
      title: `Ticket #${number}`,
      description: `Thanks, ${user.toString()} - someone from the team will be with you here. Add anything that helps: a payment id, the chain, a screenshot.\n\n**What you need help with**\n${ticket.subject}`,
      color: COLORS.brand,
      footer: 'Close ticket when it is sorted; a transcript is saved.',
    })],
    components: closeRow(),
    allowedMentions: { users: [user.id], roles: support ? [support.id] : [] },
  });
  ctx.log.info(`ticket #${number} opened by ${who(user)} in #${channel.name}`);
  await modlog.post(ctx, embed({
    title: `🎫 Ticket #${number} opened`,
    color: COLORS.brand,
    fields: [{ name: 'By', value: `${user.toString()} ${who(user)}` }, { name: 'Channel', value: channel.toString() }, { name: 'Subject', value: ticket.subject, inline: false }],
  }));
  return { ticket, channel };
}

/** The conversation as text, oldest first, up to TRANSCRIPT_LIMIT messages. */
async function transcript(channel) {
  const lines = [];
  let before;
  while (lines.length < TRANSCRIPT_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    const page = Array.from(batch.values());
    for (const m of page) {
      const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const files = m.attachments && m.attachments.size ? ` [${Array.from(m.attachments.values()).map((a) => a.url).join(' ')}]` : '';
      const embeds = m.embeds && m.embeds.length && !m.content ? ` [embed: ${m.embeds.map((e) => e.title || e.description || '').filter(Boolean).join(' | ').slice(0, 200)}]` : '';
      lines.push(`[${when}] ${m.author ? (m.author.tag || m.author.username) : 'unknown'}: ${m.content || ''}${files}${embeds}`);
    }
    before = page[page.length - 1].id;
    if (page.length < 100) break;
  }
  return lines.reverse().join('\n');
}

/** Close a ticket: transcript out, a word to the person, the channel gone. */
async function closeTicket(ctx, channel, { by, reason } = {}) {
  const ticket = ticketOf(ctx, channel.id);
  if (!ticket) return { error: 'This is not a ticket channel.' };
  if (ticket.status !== 'open') return { error: 'This ticket is already closing.' };
  ctx.store.update('tickets', (t) => { Object.assign(t[channel.id], { status: 'closed', closedAt: new Date().toISOString(), closedBy: by ? by.id : null, reason: reason || null }); });

  const text = await transcript(channel);
  const header = `Ticket #${ticket.number} · ${ticket.userTag} (${ticket.userId})\nOpened ${ticket.openedAt} · closed ${new Date().toISOString()} by ${by ? (by.tag || by.username) : 'unknown'}${reason ? ` · ${reason}` : ''}\nSubject: ${ticket.subject}\n\n`;
  const file = new AttachmentBuilder(Buffer.from(header + text, 'utf8'), { name: `ticket-${String(ticket.number).padStart(4, '0')}.txt` });
  const card = embed({
    title: `🔒 Ticket #${ticket.number} closed`,
    color: COLORS.muted,
    fields: [
      { name: 'Opened by', value: `<@${ticket.userId}> ${ticket.userTag} (${ticket.userId})` },
      { name: 'Closed by', value: by ? who(by) : 'unknown' },
      { name: 'Open for', value: `<t:${Math.floor(new Date(ticket.openedAt).getTime() / 1000)}:R>` },
      { name: 'Subject', value: ticket.subject, inline: false },
      { name: 'Reason', value: reason || 'No reason given', inline: false },
    ],
  });
  const where = ctx.found.channels.transcripts || ctx.found.channels.log;
  if (where) await where.send({ embeds: [card], files: [file] }).catch((err) => ctx.log.warn('transcript post failed:', err.message));

  const opener = await ctx.client.users.fetch(ticket.userId).catch(() => null);
  let told = false;
  if (opener) {
    told = await opener.send({
      embeds: [embed({ title: `Your ticket #${ticket.number} was closed`, description: `Thanks for reaching out to **${ctx.config.brand.name}**. The conversation is attached. Open another ticket any time.`, color: COLORS.brand, fields: [{ name: 'Reason', value: reason || 'Resolved', inline: false }] })],
      files: [new AttachmentBuilder(Buffer.from(header + text, 'utf8'), { name: `ticket-${String(ticket.number).padStart(4, '0')}.txt` })],
    }).then(() => true).catch(() => false);
  }

  await channel.send({ embeds: [embed({ description: `🔒 Closing this ticket${reason ? `: ${reason}` : ''}. The transcript has been saved${told ? ' and sent to you' : ''}. This channel goes away in a few seconds.`, color: COLORS.muted, timestamp: false })] }).catch(() => {});
  ctx.log.info(`ticket #${ticket.number} closed by ${by ? who(by) : 'unknown'}: ${reason || 'no reason'}`);
  setTimeout(() => { channel.delete(`Ticket #${ticket.number} closed`).catch((err) => ctx.log.warn('ticket channel delete failed:', err.message)); }, DELETE_AFTER_MS);
  return { ticket, told };
}

/** Let someone else into a ticket, or out of it. */
async function setAccess(ctx, channel, user, allow) {
  const ticket = ticketOf(ctx, channel.id);
  if (!ticket) return { error: 'This is not a ticket channel.' };
  if (user.id === ticket.userId && !allow) return { error: 'The person who opened the ticket stays in it; close it instead.' };
  if (allow) {
    await channel.permissionOverwrites.edit(user, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { reason: `Added to ticket #${ticket.number}` });
  } else {
    await channel.permissionOverwrites.delete(user, `Removed from ticket #${ticket.number}`).catch(() => {});
  }
  ctx.store.update('tickets', (t) => {
    const cur = t[channel.id];
    cur.added = allow ? Array.from(new Set([...(cur.added || []), user.id])) : (cur.added || []).filter((id) => id !== user.id);
  });
  return { ticket };
}

// ── the interactions ─────────────────────────────────────────────────────
async function handleOpenButton(interaction) {
  return interaction.showModal(modal());
}

async function handleModal(interaction, ctx) {
  const subject = interaction.fields.getTextInputValue(SUBJECT);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await openTicket(ctx, interaction.guild, interaction.user, subject);
  if (result.error) return interaction.editReply({ embeds: [fail(result.error)] });
  return interaction.editReply({ embeds: [ok(`Your ticket is open: ${result.channel.toString()}`)] });
}

async function handleCloseButton(interaction, ctx) {
  const ticket = ticketOf(ctx, interaction.channelId);
  if (!ticket) return interaction.reply({ embeds: [fail('This is not a ticket channel.')], flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ticket.userId && !isStaff(interaction.member, ctx)) {
    return interaction.reply({ embeds: [fail('Only the person who opened the ticket, or the team, can close it.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ embeds: [ok('Closing…')], flags: MessageFlags.Ephemeral });
  const result = await closeTicket(ctx, interaction.channel, { by: interaction.user });
  if (result.error) await interaction.editReply({ embeds: [fail(result.error)] }).catch(() => {});
  return result;
}

module.exports = { OPEN_BUTTON, CLOSE_BUTTON, MODAL, SUBJECT, TRANSCRIPT_LIMIT, panel, modal, ensurePanel, openTicket, closeTicket, setAccess, transcript, ticketOf, openFor, open, all, isStaff, category, handleOpenButton, handleModal, handleCloseButton, slug };
