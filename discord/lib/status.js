'use strict';

/**
 * The status embed in #status: one message, edited on a timer, that says
 * what the status page says - the four platform services, how many
 * networks are up, which are degraded or down, the last few changes -
 * the picture src/utils/statusPicture reads from the API on the same box
 * (shared with the Telegram bot). When the picture changes - a service
 * degrades, a network goes down or comes back, the API stops answering -
 * a short note is posted under it. The Status Updates role is pinged for
 * the changes that matter: a platform service, the API itself, or one of
 * the main networks (DISCORD_MAIN_CHAINS - Bitcoin, Ethereum, Solana and
 * the like) going down or coming back. One of the sixty other networks
 * going down is noted without a ping; networks merely degraded (some
 * endpoints not answering) are listed and are not a change at all.
 */

const { embed, COLORS } = require('./embeds');

const LOOK = {
  operational: { glyph: '🟢', color: COLORS.ok, label: 'Fully operational' },
  degraded: { glyph: '🟠', color: COLORS.warn, label: 'Partial outage' },
  unreachable: { glyph: '🔴', color: COLORS.danger, label: 'API unreachable' },
};
const SERVICE_GLYPH = { operational: '✅', degraded: '⚠️', down: '⛔' };

const picture = require('../../src/utils/statusPicture');
const { gather, summarise, signature, isMain, sortMainFirst, diff, keep } = picture;

const ts = (iso, style = 'R') => (iso ? `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>` : 'unknown');
/** Main networks first and in bold, the rest after. */
const chainList = (arr, config) => sortMainFirst(arr, config)
  .map((c) => (config && isMain(config, c.code) ? `**${c.name} (${c.code})**` : `${c.name} (${c.code})`))
  .join(', ');

function statusEmbed(summary, config) {
  const look = LOOK[summary.overall] || LOOK.degraded;
  const site = config.brand.site.replace(/\/+$/, '');
  const fields = [];
  if (summary.ok) {
    for (const s of summary.platform) fields.push({ name: s.label, value: `${SERVICE_GLYPH[s.status] || '⚠️'} ${s.statusLabel}` });
    if (summary.counts) {
      fields.push({ name: `Networks (${summary.total})`, value: `🟢 ${summary.counts.up} up · 🟠 ${summary.counts.degraded} degraded · 🔴 ${summary.counts.down} down`, inline: false });
    } else {
      fields.push({ name: 'Networks', value: `⚠️ not reported${summary.chainsError ? ` (${summary.chainsError})` : ''}`, inline: false });
    }
    if (summary.down.length) fields.push({ name: 'Down', value: chainList(summary.down, config), inline: false });
    if (summary.degraded.length) fields.push({ name: 'Degraded (some endpoints not answering)', value: chainList(summary.degraded, config), inline: false });
    if (summary.events.length) {
      fields.push({ name: 'Recent changes', value: summary.events.map((e) => `${e.name || e.chain}: ${e.component} ${e.from} → ${e.to} ${ts(e.at)}`).join('\n'), inline: false });
    }
  } else {
    fields.push({ name: 'Problem', value: summary.error || 'no answer', inline: false });
  }
  const checked = summary.ok ? `Checked ${ts(summary.generatedAt)}${summary.checkedAt ? ` · networks swept ${ts(summary.checkedAt)}` : ''}` : `Tried ${ts(summary.generatedAt)}`;
  const uptime = summary.uptime !== null && summary.uptime !== undefined ? ` · 30-day uptime **${summary.uptime}%**` : '';
  return embed({
    title: `${look.glyph} ${config.brand.name} status - ${summary.label}`,
    description: `${checked}${uptime}\n[Status page](${site}/status)`,
    color: look.color,
    fields,
    footer: `Updates every ${Math.round(config.status.intervalMs / 60000)} min`,
  });
}

/** The note under the embed when the picture changes. */
function changeEmbed(prev, next, config) {
  const look = LOOK[next.overall] || LOOK.degraded;
  const { wentDown, cameBack, servicesOff, servicesOn, mainDown, mainBack } = diff(prev, next, config);
  const headline = [
    ...mainDown.map((c) => `🔴 **${c.name} (${c.code}) is down.**`),
    ...mainBack.map((c) => `🟢 **${c.name} (${c.code}) is back up.**`),
  ].join('\n');
  const fields = [
    wentDown.length ? { name: 'Went down', value: chainList(wentDown, config), inline: false } : null,
    cameBack.length ? { name: 'Back up', value: chainList(cameBack, config), inline: false } : null,
    servicesOff.length ? { name: 'Degraded', value: servicesOff.join(', '), inline: false } : null,
    servicesOn.length ? { name: 'Recovered', value: servicesOn.join(', '), inline: false } : null,
    !next.ok ? { name: 'Problem', value: next.error || 'no answer', inline: false } : null,
    prev && !prev.ok && next.ok ? { name: 'API', value: 'Answering again', inline: false } : null,
  ].filter(Boolean);
  return embed({
    title: `${look.glyph} ${prev ? `${prev.label} → ` : ''}${next.label}`,
    description: headline || undefined,
    color: look.color,
    fields,
    footer: `${config.brand.name} status`,
  });
}

/** Post the embed unless the one we remember is still there; returns the message. */
async function ensureMessage(ctx, guild, { force = false, summary } = {}) {
  const channel = ctx.found.channels.status;
  if (!channel) {
    ctx.log.warn('no status channel found - set DISCORD_STATUS_CHANNEL to its name or id');
    return null;
  }
  const remembered = ctx.store.data.panels.status;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const current = summary || summarise(await gather(ctx.config));
  const message = await channel.send({ embeds: [statusEmbed(current, ctx.config)] });
  ctx.store.update('panels', (p) => { p.status = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`status embed posted in #${channel.name}`);
  return message;
}

/** One tick: read the API, edit the embed, and say so if the picture changed. */
async function refresh(ctx, opts = {}) {
  const guild = ctx.guild;
  const summary = summarise(await gather(ctx.config, opts));
  ctx.status = ctx.status || {};
  ctx.status.last = summary;
  const message = await ensureMessage(ctx, guild, { summary });
  if (!message) return { summary, changed: false };
  await message.edit({ embeds: [statusEmbed(summary, ctx.config)] }).catch((err) => ctx.log.warn('status embed edit failed:', err.message));

  const sig = signature(summary);
  // a copy: the update below writes into the same object
  const before = { ...(ctx.store.data.status || {}) };
  const changed = Boolean(before.signature) && before.signature !== sig;
  if (changed || !before.signature) {
    ctx.store.update('status', (s) => { s.signature = sig; s.changedAt = new Date().toISOString(); s.summary = keep(summary); });
  }
  let pinged = false;
  if (changed) {
    const role = ctx.found.roles.status;
    const channel = ctx.found.channels.updates;
    const what = diff(before.summary, summary, ctx.config);
    pinged = Boolean(role && what.ping);
    await channel.send({
      content: pinged ? role.toString() : undefined,
      embeds: [changeEmbed(before.summary, summary, ctx.config)],
      allowedMentions: { roles: pinged ? [role.id] : [] },
    }).catch((err) => ctx.log.warn('status change post failed:', err.message));
    ctx.log.warn(`status changed: ${before.summary ? before.summary.label : '?'} → ${summary.label}${pinged ? ' (pinged)' : ''}`);
  }
  return { summary, changed, pinged };
}

let timer = null;
function start(ctx, opts = {}) {
  stop();
  const tick = () => refresh(ctx, opts).catch((err) => ctx.log.error('status refresh failed:', err.message));
  timer = setInterval(tick, ctx.config.status.intervalMs);
  return tick();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { LOOK, gather, summarise, signature, diff, isMain, statusEmbed, changeEmbed, ensureMessage, refresh, start, stop };
