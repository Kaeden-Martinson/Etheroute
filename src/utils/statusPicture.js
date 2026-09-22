'use strict';

/**
 * The status picture the bots show: what the status page says, read from
 * the API over HTTP (GET /api/status and /api/status/chains, both public)
 * and flattened to one plain object - the platform services, how many
 * networks are up, which are degraded or down, the last few changes.
 *
 * Two pictures compare by a signature - the overall state, which services
 * are off, which networks are down - and diff() says what changed and
 * whether it deserves a ping: a platform service, the API itself, or one
 * of the main networks going down or coming back. Networks merely
 * degraded (some endpoints not answering) are listed and are not a change
 * at all, or the pings would never stop. Nothing here knows about Discord
 * or Telegram; each bot dresses the picture in its own format.
 *
 * `config` needs { status: { apiUrl, mainChains } }.
 */

const LABELS = {
  operational: 'Fully operational',
  degraded: 'Partial outage',
  unreachable: 'API unreachable',
};

/** "fetch failed" with the reason Node hides under it: ECONNREFUSED, a timeout. */
const why = (err) => (err && err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : (err && err.message) || String(err));

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

/** Both endpoints, each allowed to fail on its own. */
async function gather(config, opts) {
  const base = config.status.apiUrl;
  const [platform, chains] = await Promise.all([
    fetchJson(`${base}/api/status`, opts).then((d) => ({ data: d })).catch((err) => ({ error: why(err) })),
    fetchJson(`${base}/api/status/chains`, opts).then((d) => ({ data: d })).catch((err) => ({ error: why(err) })),
  ]);
  return { platform: platform.data || null, chains: chains.data || null, error: platform.error || null, chainsError: chains.error || null };
}

/** The picture, flattened: what is shown and what the signature is made of. */
function summarise({ platform, chains, error, chainsError }) {
  if (!platform) {
    return { ok: false, overall: 'unreachable', label: LABELS.unreachable, error: error || 'no answer', platform: [], uptime: null, counts: null, down: [], degraded: [], events: [], checkedAt: null, generatedAt: new Date().toISOString(), total: 0 };
  }
  const services = (platform.services || []).map((s) => ({ key: s.key, label: s.label, status: s.status, statusLabel: s.statusLabel || s.status }));
  const list = (chains && chains.chains) || [];
  const named = (c) => ({ code: c.code, name: c.name });
  const down = list.filter((c) => c.status === 'down').map(named);
  const degraded = list.filter((c) => c.status === 'degraded').map(named);
  const counts = chains ? chains.counts || { up: list.filter((c) => c.status === 'up').length, degraded: degraded.length, down: down.length, unknown: 0 } : null;
  const overall = platform.overallStatus !== 'operational' || down.length > 0 ? 'degraded' : 'operational';
  return {
    ok: true,
    overall,
    label: overall === 'operational' ? LABELS.operational : (platform.overallStatusLabel && platform.overallStatus !== 'operational' ? platform.overallStatusLabel : LABELS.degraded),
    error: null,
    chainsError: chainsError || null,
    platform: services,
    uptime: typeof platform.uptimePercentage === 'number' ? platform.uptimePercentage : null,
    counts,
    down,
    degraded,
    events: ((chains && chains.events) || []).slice(0, 3),
    checkedAt: chains ? chains.checkedAt : null,
    generatedAt: platform.generatedAt || new Date().toISOString(),
    total: list.length,
  };
}

/** What counts as a change: the overall state, which services are off, which networks are down. */
function signature(summary) {
  const services = summary.platform.filter((s) => s.status !== 'operational').map((s) => s.key).sort().join(',');
  const down = summary.down.map((c) => c.code).sort().join(',');
  return `${summary.overall}|${services}|${down}`;
}

const isMain = (config, code) => config.status.mainChains.includes(String(code || '').toUpperCase());

/** Main networks first. */
function sortMainFirst(arr, config) {
  return arr.slice().sort((a, b) => Number(isMain(config, b.code)) - Number(isMain(config, a.code)));
}

/** What changed between two pictures, and whether it deserves a ping. */
function diff(prev, next, config) {
  const was = new Set((prev && prev.down || []).map((c) => c.code));
  const now = new Set(next.down.map((c) => c.code));
  const wentDown = next.down.filter((c) => !was.has(c.code));
  const cameBack = (prev && prev.down || []).filter((c) => !now.has(c.code));
  const prevOff = new Set((prev && prev.platform || []).filter((s) => s.status !== 'operational').map((s) => s.key));
  const nowOff = new Set(next.platform.filter((s) => s.status !== 'operational').map((s) => s.key));
  const servicesOff = next.platform.filter((s) => nowOff.has(s.key) && !prevOff.has(s.key)).map((s) => s.label);
  const servicesOn = (prev && prev.platform || []).filter((s) => prevOff.has(s.key) && !nowOff.has(s.key)).map((s) => s.label);
  const apiFlipped = Boolean(prev) && Boolean(prev.ok) !== Boolean(next.ok);
  const mainDown = wentDown.filter((c) => isMain(config, c.code));
  const mainBack = cameBack.filter((c) => isMain(config, c.code));
  const ping = apiFlipped || servicesOff.length > 0 || servicesOn.length > 0 || mainDown.length > 0 || mainBack.length > 0;
  return { wentDown, cameBack, servicesOff, servicesOn, apiFlipped, mainDown, mainBack, ping };
}

/** The slice of a picture worth keeping to compare against next time. */
function keep(summary) {
  return { overall: summary.overall, label: summary.label, ok: summary.ok, error: summary.error, down: summary.down, platform: summary.platform };
}

module.exports = { LABELS, why, fetchJson, gather, summarise, signature, isMain, sortMainFirst, diff, keep };
