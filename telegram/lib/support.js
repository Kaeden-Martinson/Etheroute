'use strict';

/**
 * Support by private message. A person writes to the bot; the first
 * message opens a ticket and every message is copied to the staff chat
 * with a header saying who it is from. Staff reply to that copy, in the
 * staff chat, and the reply is copied back to the person - they never see
 * a staff member's account, and staff never open a DM with a stranger.
 * "/close" as a reply ends the ticket and tells them so. Without a staff
 * chat configured, /support says where else to turn.
 */

const { esc, b, i, code, mention, who, card } = require('./format');

const number = (ctx) => (ctx.store.data.ticketCounter || 0) + 1;
const ticketOf = (ctx, userId) => (ctx.store.data.tickets || {})[String(userId)] || null;
const openTicket = (ctx, userId) => { const t = ticketOf(ctx, userId); return t && t.status === 'open' ? t : null; };

function header(ticket, user) {
  return `${b(`Ticket #${ticket.number}`)} from ${mention(user)} ${code(user.id)}${user.username ? ` @${esc(user.username)}` : ''}\n${i('Reply to this message to answer them; /close as a reply ends the ticket.')}`;
}

/** /support in a private chat. */
async function start(ctx, message) {
  if (!ctx.config.supportChatId) {
    await ctx.api.sendMessage(message.chat.id, `Support tickets are not set up here yet. You can reach the team at ${esc(ctx.config.brand.site)}.`);
    return null;
  }
  const open = openTicket(ctx, message.from.id);
  if (open) {
    await ctx.api.sendMessage(message.chat.id, `Your ticket #${open.number} is open - just write here and the team sees it.`);
    return open;
  }
  await ctx.api.sendMessage(message.chat.id, [b('Tell us what you need'), '', 'Write it here - what happened, and where (a payment id, a network, an error). Screenshots are fine. The team answers in this chat.', '', i(`Never send your private keys or recovery phrase. Nobody from ${ctx.config.brand.name} will ask for them.`)].join('\n'));
  return null;
}

/** A person wrote to the bot: open the ticket if none is open, relay the message. */
async function onUserMessage(ctx, message) {
  if (!ctx.config.supportChatId) return null;
  const user = message.from;
  let ticket = openTicket(ctx, user.id);
  let opened = false;
  if (!ticket) {
    ticket = { number: number(ctx), userId: user.id, openedAt: new Date().toISOString(), status: 'open', messages: 0 };
    ctx.store.data.ticketCounter = ticket.number;
    ctx.store.update('tickets', (t) => { t[String(user.id)] = ticket; });
    opened = true;
  }
  const head = await ctx.api.sendMessage(ctx.config.supportChatId, header(ticket, user)).catch((err) => { ctx.log.warn('support relay failed:', err.description || err.message); return null; });
  if (!head) {
    await ctx.api.sendMessage(message.chat.id, 'I could not reach the team just now. Please try again in a little while.');
    return null;
  }
  const copy = await ctx.api.copyMessage(ctx.config.supportChatId, message.chat.id, message.message_id, { reply_parameters: { message_id: head.message_id } }).catch(() => null);
  ctx.store.update('relay', (r) => {
    r[String(head.message_id)] = user.id;
    if (copy) r[String(copy.message_id)] = user.id;
    const keys = Object.keys(r);
    if (keys.length > 4000) for (const k of keys.slice(0, 1000)) delete r[k];
  });
  ctx.store.update('tickets', (t) => { t[String(user.id)].messages += 1; t[String(user.id)].lastAt = new Date().toISOString(); });
  if (opened) {
    await ctx.api.sendMessage(message.chat.id, `Got it - ticket ${b(`#${ticket.number}`)} is open. Someone from the team will answer right here. Add anything that helps in the meantime.`);
    ctx.log.info(`ticket #${ticket.number} opened by ${user.id}`);
  }
  return { ticket, opened };
}

/** Staff wrote in the staff chat, replying to a relayed message: copy it back, or close. */
async function onStaffMessage(ctx, message, cmd) {
  const r = message.reply_to_message;
  if (!r) return null;
  const userId = (ctx.store.data.relay || {})[String(r.message_id)];
  if (!userId) return null;
  const ticket = openTicket(ctx, userId);
  if (cmd && cmd.name === 'close') {
    if (!ticket) { await ctx.api.sendMessage(message.chat.id, 'That ticket is already closed.', { reply_parameters: { message_id: message.message_id } }); return 'already-closed'; }
    const reason = cmd.args || 'Resolved';
    ctx.store.update('tickets', (t) => { Object.assign(t[String(userId)], { status: 'closed', closedAt: new Date().toISOString(), closedBy: message.from.id, reason }); });
    await ctx.api.sendMessage(userId, `Your ticket ${b(`#${ticket.number}`)} was closed: ${esc(reason)}\n\nThanks for reaching out to ${b(ctx.config.brand.name)}. Write again any time to open another.`).catch(() => {});
    await ctx.api.sendMessage(message.chat.id, card(`🔒 Ticket #${ticket.number} closed`, [['By', who(message.from)], ['Reason', esc(reason)]]), { reply_parameters: { message_id: message.message_id } });
    ctx.log.info(`ticket #${ticket.number} closed by ${message.from.id}: ${reason}`);
    return 'closed';
  }
  if (!ticket) {
    await ctx.api.sendMessage(message.chat.id, 'That ticket is closed; they will need to write again to open a new one.', { reply_parameters: { message_id: message.message_id } });
    return 'closed-ticket';
  }
  const sent = await ctx.api.copyMessage(userId, message.chat.id, message.message_id).catch((err) => { ctx.log.warn(`could not reach ${userId}:`, err.description || err.message); return null; });
  if (!sent) {
    await ctx.api.sendMessage(message.chat.id, 'Could not deliver that - they may have blocked me.', { reply_parameters: { message_id: message.message_id } });
    return 'undeliverable';
  }
  ctx.store.update('tickets', (t) => { t[String(userId)].answered = (t[String(userId)].answered || 0) + 1; t[String(userId)].lastAt = new Date().toISOString(); });
  return 'relayed';
}

const openTickets = (ctx) => Object.values(ctx.store.data.tickets || {}).filter((t) => t.status === 'open').sort((a, b) => a.number - b.number);

module.exports = { start, onUserMessage, onStaffMessage, ticketOf, openTicket, openTickets, header };
