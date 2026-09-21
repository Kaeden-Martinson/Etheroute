'use strict';

/**
 * Giveaways: a message with an Enter button, a prize, a number of winners
 * and an end time. Entrants press the button (and press it again to
 * leave); at the end the winners are drawn at random, the message is
 * edited to show them and they are pinged in the channel. Everything is
 * in the store, so a restart picks the running ones up again, and one
 * that ended while the bot was down is drawn as soon as it is back.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { embed, COLORS, ok, fail } = require('./embeds');
const { formatDuration, UNITS } = require('./duration');

const BUTTON_ID = 'giveaway:enter';
const MAX_MS = 4 * UNITS.w;
const timers = new Map();

/** `count` distinct picks from `entrants`, or all of them if there are fewer. */
function pickWinners(entrants, count, rng = Math.random) {
  const pool = Array.from(new Set(entrants));
  const picked = [];
  while (pool.length && picked.length < count) {
    const i = Math.floor(rng() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function giveawayEmbed(g) {
  const ends = Math.floor(g.endsAt / 1000);
  const fields = [
    { name: 'Winners', value: String(g.winners) },
    { name: 'Entries', value: String((g.entrants || []).length) },
    { name: 'Hosted by', value: `<@${g.hostId}>` },
  ];
  if (g.ended) {
    fields.push({ name: 'Won by', value: g.winnerIds && g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'Nobody entered', inline: false });
  } else {
    fields.push({ name: 'Ends', value: `<t:${ends}:R> (<t:${ends}:f>)`, inline: false });
  }
  return embed({
    title: `🎉 ${g.prize}`,
    description: g.ended ? 'This giveaway has ended.' : 'Press **Enter** to be in the draw. Press it again to leave.',
    color: g.ended ? COLORS.muted : COLORS.brand,
    fields,
    footer: g.ended ? 'Ended' : `Giveaway · ${formatDuration(g.endsAt - Date.now())} left`,
    timestamp: new Date(g.endsAt),
  });
}

function components(g) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTON_ID).setLabel(g.ended ? 'Ended' : 'Enter').setEmoji('🎉').setStyle(ButtonStyle.Primary).setDisabled(Boolean(g.ended)),
  )];
}

async function start(ctx, { channel, prize, winners, durationMs, host }) {
  const endsAt = Date.now() + Math.min(durationMs, MAX_MS);
  const draft = { prize, winners, endsAt, hostId: host.id, entrants: [], ended: false, winnerIds: [] };
  const message = await channel.send({ embeds: [giveawayEmbed(draft)], components: components(draft) });
  const g = { ...draft, messageId: message.id, channelId: channel.id, guildId: channel.guild.id, startedAt: new Date().toISOString() };
  ctx.store.update('giveaways', (all) => { all[message.id] = g; });
  schedule(ctx, g);
  ctx.log.info(`giveaway started: "${prize}" in #${channel.name}, ${winners} winner(s), ends ${new Date(endsAt).toISOString()}`);
  return g;
}

/** The Enter button: in, or out again. */
async function enter(interaction, ctx) {
  const g = ctx.store.data.giveaways[interaction.message.id];
  if (!g || g.ended) {
    return interaction.reply({ embeds: [fail('That giveaway is over.')], flags: MessageFlags.Ephemeral });
  }
  const id = interaction.user.id;
  const was = g.entrants.includes(id);
  ctx.store.update('giveaways', (all) => {
    const cur = all[g.messageId];
    cur.entrants = was ? cur.entrants.filter((e) => e !== id) : [...cur.entrants, id];
  });
  const fresh = ctx.store.data.giveaways[g.messageId];
  interaction.message.edit({ embeds: [giveawayEmbed(fresh)], components: components(fresh) }).catch(() => {});
  return interaction.reply({ embeds: [was ? ok('You left the giveaway.') : ok(`You are in the draw for **${g.prize}**. Good luck!`)], flags: MessageFlags.Ephemeral });
}

async function fetchMessage(ctx, g) {
  const channel = await ctx.client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return { channel: null, message: null };
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  return { channel, message };
}

/** Draw the winners and say so. `count` overrides the giveaway's winner count for a reroll. */
async function end(ctx, messageId, { reroll = false, count, rng } = {}) {
  const g = ctx.store.data.giveaways[messageId];
  if (!g) return { ok: false, reason: 'No giveaway with that message id.' };
  if (g.ended && !reroll) return { ok: false, reason: 'That giveaway already ended.' };
  clearTimer(messageId);

  const winnerIds = pickWinners(g.entrants, count || g.winners, rng);
  ctx.store.update('giveaways', (all) => { Object.assign(all[messageId], { ended: true, endedAt: new Date().toISOString(), winnerIds }); });
  const fresh = ctx.store.data.giveaways[messageId];

  const { channel, message } = await fetchMessage(ctx, fresh);
  if (message) await message.edit({ embeds: [giveawayEmbed(fresh)], components: components(fresh) }).catch(() => {});
  if (channel) {
    const text = winnerIds.length
      ? `🎉 ${reroll ? 'New draw' : 'Congratulations'} ${winnerIds.map((id) => `<@${id}>`).join(', ')} - you won **${fresh.prize}**!`
      : `Nobody entered the giveaway for **${fresh.prize}**, so there is no winner.`;
    await channel.send({ content: text, reply: message ? { messageReference: message.id } : undefined, allowedMentions: { users: winnerIds } }).catch(() => {});
  }
  ctx.log.info(`giveaway ${reroll ? 'rerolled' : 'ended'}: "${fresh.prize}" → ${winnerIds.join(', ') || 'no winner'}`);
  return { ok: true, giveaway: fresh, winnerIds };
}

function schedule(ctx, g) {
  clearTimer(g.messageId);
  const wait = Math.max(0, g.endsAt - Date.now());
  // setTimeout tops out short of 25 days; a long one is checked in steps
  const step = Math.min(wait, 2 ** 31 - 1000);
  timers.set(g.messageId, setTimeout(() => {
    if (Date.now() < g.endsAt) return schedule(ctx, g);
    end(ctx, g.messageId).catch((err) => ctx.log.error('giveaway end failed:', err.message));
  }, step));
}

function clearTimer(messageId) {
  const t = timers.get(messageId);
  if (t) clearTimeout(t);
  timers.delete(messageId);
}

/** After a restart: every giveaway still open gets its timer back. */
function resume(ctx) {
  const open = Object.values(ctx.store.data.giveaways).filter((g) => !g.ended);
  for (const g of open) schedule(ctx, g);
  if (open.length) ctx.log.info(`resumed ${open.length} giveaway(s)`);
  return open.length;
}

function active(ctx) {
  return Object.values(ctx.store.data.giveaways).filter((g) => !g.ended).sort((a, b) => a.endsAt - b.endsAt);
}

module.exports = { BUTTON_ID, MAX_MS, pickWinners, giveawayEmbed, components, start, enter, end, resume, active, schedule, clearTimer };
