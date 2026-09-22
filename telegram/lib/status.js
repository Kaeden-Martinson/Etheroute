'use strict';

/**
 * The status message in the channel (or the group, when there is no
 * channel): one pinned post, edited on a timer
 * with the picture src/utils/statusPicture reads from the API - the
 * platform services, how many networks are up, which are degraded or
 * down, the last few changes. A channel has no roles to ping, so a new
 * post - which every subscriber is told about - goes out only for the
 * changes that matter: a platform service, the API itself, or a main
 * network going down or coming back. Lesser changes only edit the pin.
 */

const picture = require('../../src/utils/statusPicture');
const { esc, b, i, code, link, cut, ago } = require('./format');

const GLYPH = { operational: '🟢', degraded: '🟠', unreachable: '🔴' };
const SERVICE_GLYPH = { operational: '✅', degraded: '⚠️', down: '⛔' };

const chainList = (arr, config) => picture.sortMainFirst(arr, config)
  .map((c) => (picture.isMain(config, c.code) ? b(`${c.name} (${c.code})`) : esc(`${c.name} (${c.code})`)))
  .join(', ');

function statusText(summary, config) {
  const site = config.brand.site.replace(/\/+$/, '');
  const lines = [`${GLYPH[summary.overall] || '🟠'} ${b(`${config.brand.name} status`)} - ${esc(summary.label)}`, ''];
  if (summary.ok) {
    for (const s of summary.platform) lines.push(`${SERVICE_GLYPH[s.status] || '⚠️'} ${esc(s.label)}: ${esc(s.statusLabel)}`);
    lines.push('');
    if (summary.counts) lines.push(`${b(`Networks (${summary.total})`)}: 🟢 ${summary.counts.up} up · 🟠 ${summary.counts.degraded} degraded · 🔴 ${summary.counts.down} down`);
    else lines.push(`${b('Networks')}: ⚠️ not reported${summary.chainsError ? ` (${esc(summary.chainsError)})` : ''}`);
    if (summary.down.length) lines.push(`${b('Down')}: ${chainList(summary.down, config)}`);
    if (summary.degraded.length) lines.push(`${b('Degraded')} ${i('(some endpoints not answering)')}: ${chainList(summary.degraded, config)}`);
    if (summary.events.length) {
      lines.push('', b('Recent changes'));
      for (const e of summary.events) lines.push(`• ${esc(e.name || e.chain)}: ${esc(e.component)} ${esc(e.from)} → ${esc(e.to)}, ${ago(e.at)}`);
    }
    lines.push('', `${i(`Checked ${ago(summary.generatedAt)}`)}${summary.uptime !== null && summary.uptime !== undefined ? ` · 30-day uptime ${b(`${summary.uptime}%`)}` : ''}`);
  } else {
    lines.push(`${b('Problem')}: ${code(summary.error || 'no answer')}`, '', i(`Tried ${ago(summary.generatedAt)}`));
  }
  lines.push(link('Status page', `${site}/status`));
  return cut(lines.join('\n'));
}

/** The post when the picture changes in a way worth telling everyone. */
function changeText(prev, next, config) {
  const d = picture.diff(prev, next, config);
  const lines = [`${GLYPH[next.overall] || '🟠'} ${b(prev ? `${prev.label} → ${next.label}` : next.label)}`];
  for (const c of d.mainDown) lines.push(`🔴 ${b(`${c.name} (${c.code}) is down.`)}`);
  for (const c of d.mainBack) lines.push(`🟢 ${b(`${c.name} (${c.code}) is back up.`)}`);
  const rows = [
    d.wentDown.length ? ['Went down', chainList(d.wentDown, config)] : null,
    d.cameBack.length ? ['Back up', chainList(d.cameBack, config)] : null,
    d.servicesOff.length ? ['Degraded', esc(d.servicesOff.join(', '))] : null,
    d.servicesOn.length ? ['Recovered', esc(d.servicesOn.join(', '))] : null,
    !next.ok ? ['Problem', code(next.error || 'no answer')] : null,
    prev && !prev.ok && next.ok ? ['API', 'answering again'] : null,
  ].filter(Boolean);
  if (rows.length) lines.push('');
  for (const [label, value] of rows) lines.push(`${b(`${label}:`)} ${value}`);
  lines.push('', link('Status page', `${config.brand.site.replace(/\/+$/, '')}/status`));
  return cut(lines.join('\n'));
}

/** The pinned message, posted and pinned if the one remembered is gone. */
async function ensureMessage(ctx, summary) {
  const remembered = ctx.store.data.panels.status;
  const text = statusText(summary, ctx.config);
  const where = ctx.config.postChatId;
  if (remembered && String(remembered.chatId) === String(where)) {
    try {
      await ctx.api.editMessageText(where, remembered.messageId, text);
      return remembered;
    } catch (err) {
      // the same text again is not an error worth a new post; a deleted message is
      if (/message is not modified/i.test(err.description || '')) return remembered;
      ctx.log.warn(`status message ${remembered.messageId} could not be edited (${err.description || err.message}); posting a new one`);
    }
  }
  const message = await ctx.api.sendMessage(where, text, { disable_notification: true });
  await ctx.api.pinChatMessage(where, message.message_id).catch((err) => ctx.log.warn('could not pin the status message:', err.description || err.message));
  const record = { chatId: where, messageId: message.message_id, at: new Date().toISOString() };
  ctx.store.update('panels', (p) => { p.status = record; });
  ctx.log.info(`status message posted in ${where} (${message.message_id})`);
  return record;
}

/** One tick: read the API, edit the pin, post if the picture changed in a way that matters. */
async function refresh(ctx, opts = {}) {
  const summary = picture.summarise(await picture.gather(ctx.config, opts));
  ctx.status = ctx.status || {};
  ctx.status.last = summary;
  await ensureMessage(ctx, summary);

  const sig = picture.signature(summary);
  const before = { ...(ctx.store.data.status || {}) };
  const changed = Boolean(before.signature) && before.signature !== sig;
  if (changed || !before.signature) {
    ctx.store.update('status', (s) => { s.signature = sig; s.changedAt = new Date().toISOString(); s.summary = picture.keep(summary); });
  }
  let posted = false;
  if (changed) {
    const what = picture.diff(before.summary, summary, ctx.config);
    if (what.ping) {
      await ctx.api.sendMessage(ctx.config.postChatId, changeText(before.summary, summary, ctx.config)).catch((err) => ctx.log.warn('status change post failed:', err.description || err.message));
      posted = true;
    }
    ctx.log.warn(`status changed: ${before.summary ? before.summary.label : '?'} → ${summary.label}${posted ? ' (posted)' : ' (pin edited only)'}`);
  }
  return { summary, changed, posted };
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

module.exports = { GLYPH, statusText, changeText, ensureMessage, refresh, start, stop };
