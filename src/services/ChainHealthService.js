/**
 * ChainHealthService - which chains and routes are up, right now and lately.
 *
 * Every few minutes each chain in the registry is probed: its RPC endpoints
 * or explorer (does it answer, how fast, is the tip still moving), whether
 * THORChain has the chain open, whether SideShift is taking its coin, and
 * whether each on-chain aggregator still quotes it. A change in any of those
 * is an event with a time on it, kept in the database, and a transition to
 * down (or back up) is an alert. The status page draws the current picture
 * and the last thirty days from these events.
 *
 * `scripts/verify-chains.js` is the deep, on-demand check of what the
 * registry claims; this is the shallow, continuous one of what is answering.
 */
const { db } = require('../config/database');
const chains = require('../config/chains');
const logger = require('./logger');
const AlertService = require('./AlertService');
const ProxyService = require('./ProxyService');
const ThorchainService = require('./ThorchainService');
const SideshiftService = require('./SideshiftService');
const DexService = require('./DexService');
const PriceService = require('./PriceService');

const INTERVAL_MS = Number(process.env.CHAIN_HEALTH_INTERVAL_MS) || 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

// How many events to keep; older ones fall off the end.
const EVENTS_KEPT = 2000;

// A tip that has not moved for this long, relative to the chain's own block
// time, is a stalled chain (or a stalled endpoint): twenty blocks, and never
// under fifteen minutes so a quiet Bitcoin hour is not an incident.
const STALL_BLOCKS = 20;
const STALL_FLOOR_MS = 15 * 60 * 1000;

// An endpoint that has verified its chain id is not asked again for a day:
// the sweep costs each endpoint one call, not two. Public providers meter
// by the day per address, and the sweep is a large share of what we spend.
const CHAIN_ID_TTL_MS = 24 * 60 * 60 * 1000;
const chainIdVerifiedAt = new Map();

// A provider saying the day's free quota is spent, as opposed to being down.
const QUOTA = /usage limit|rate limit|too many requests|quota|429/i;

// An address the aggregators will build a quote for; nothing is sent. (Not
// the low precompile-like ones: ParaSwap refuses those.)
const PROBE_SENDER = '0x1111111111111111111111111111111111111111';

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

const WINDOW_DAYS = 30;

async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(url, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'rpc error');
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

class ChainHealthService {
  constructor() {
    this.timer = null;
    this.running = null;
    this.sideshift = new SideshiftService(PriceService);
    this.thorchain = ThorchainService;
    this.dex = DexService;
  }

  // ── probes ──────────────────────────────────────────────────────────────

  /**
   * Every RPC endpoint asked for the tip, in parallel - and for its chain id
   * the first time (then once a day), so an endpoint answering as the
   * wrong chain is caught without doubling the sweep's cost.
   */
  async probeEvm(chain) {
    const urls = chains.rpcUrls(chain.code);
    const results = await Promise.all(urls.map(async (url) => {
      const started = Date.now();
      try {
        const verified = chainIdVerifiedAt.get(url);
        if (!verified || Date.now() - verified > CHAIN_ID_TTL_MS) {
          const id = await rpcCall(url, 'eth_chainId');
          if (parseInt(id, 16) !== chain.chainId) throw new Error(`answers as chain ${parseInt(id, 16)}`);
          chainIdVerifiedAt.set(url, Date.now());
        }
        const tipHex = await rpcCall(url, 'eth_blockNumber');
        return { url, ok: true, tip: parseInt(tipHex, 16), latencyMs: Date.now() - started };
      } catch (error) {
        return { url, ok: false, error: error.message, quota: QUOTA.test(error.message), latencyMs: Date.now() - started };
      }
    }));
    const up = results.filter((r) => r.ok);
    return {
      ok: up.length > 0,
      endpointsUp: up.length,
      endpoints: results.length,
      tip: up.length ? Math.max(...up.map((r) => r.tip)) : null,
      latencyMs: up.length ? Math.min(...up.map((r) => r.latencyMs)) : null,
      error: up.length ? null : results.map((r) => `${r.url}: ${r.error}`).join(' | '),
      down: results.filter((r) => !r.ok).map((r) => r.url),
      // the subset of `down` that is a spent quota rather than an outage
      quota: results.filter((r) => !r.ok && r.quota).map((r) => r.url),
    };
  }

  /**
   * A UTXO chain's explorers: every mirror and the fallback, each asked for
   * the tip, so the page can say "1/2 explorers" when one has gone away.
   */
  async probeUtxo(chain) {
    const service = require('./wallets').walletServiceFor(chain.code);
    if (typeof service.probeExplorers === 'function') {
      const results = await withTimeout(service.probeExplorers(), PROBE_TIMEOUT_MS * 3, `${chain.code} explorers`).catch((error) => [{ url: chain.explorerApi, ok: false, error: error.message, latencyMs: PROBE_TIMEOUT_MS * 3 }]);
      const up = results.filter((r) => r.ok);
      return {
        ok: up.length > 0,
        endpointsUp: up.length,
        endpoints: results.length,
        tip: up.length ? Math.max(...up.map((r) => r.tip)) : null,
        latencyMs: up.length ? Math.min(...up.map((r) => r.latencyMs)) : null,
        error: up.length ? null : results.map((r) => `${r.url}: ${r.error}`).join(' | '),
        down: results.filter((r) => !r.ok).map((r) => r.url),
      };
    }
    const started = Date.now();
    try {
      let tip;
      if (chain.explorerKind && chain.explorerKind !== 'mempool') {
        // Haskoin, BlockCypher: the wallet service knows the shape.
        const service = require('./wallets').walletServiceFor(chain.code);
        tip = await withTimeout(service.getTipHeight(), PROBE_TIMEOUT_MS, `${chain.code} explorer`);
        if (tip === null) throw new Error('explorer gave no tip');
      } else {
        const response = await withTimeout(ProxyService.fetch(`${chain.explorerApi}/blocks/tip/height`), PROBE_TIMEOUT_MS, `${chain.code} explorer`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        tip = parseInt(await response.text(), 10);
      }
      if (!Number.isFinite(tip)) throw new Error('no tip height');
      return { ok: true, endpointsUp: 1, endpoints: 1, tip, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return { ok: false, endpointsUp: 0, endpoints: 1, tip: null, latencyMs: Date.now() - started, error: error.message };
    }
  }

  async probeSolana() {
    const started = Date.now();
    try {
      const slot = await rpcCall(SOLANA_RPC, 'getSlot', [{ commitment: 'confirmed' }]);
      return { ok: true, endpointsUp: 1, endpoints: 1, tip: Number(slot), latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return { ok: false, endpointsUp: 0, endpoints: 1, tip: null, latencyMs: Date.now() - started, error: error.message };
    }
  }

  /** Every JSON-RPC endpoint the wallet service uses, asked for the validated ledger. */
  async probeXrp(chain) {
    const service = require('./wallets').walletServiceFor(chain.code);
    const results = await Promise.all(service.endpoints.map(async (url) => {
      const started = Date.now();
      try {
        const response = await withTimeout(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'ledger', params: [{ ledger_index: 'validated' }] }) }), PROBE_TIMEOUT_MS, url);
        const data = await response.json();
        const tip = Number(data && data.result && data.result.ledger_index);
        if (!tip) throw new Error('no validated ledger');
        return { url, ok: true, tip, latencyMs: Date.now() - started };
      } catch (error) {
        return { url, ok: false, error: error.message, latencyMs: Date.now() - started };
      }
    }));
    const up = results.filter((r) => r.ok);
    return {
      ok: up.length > 0,
      endpointsUp: up.length,
      endpoints: results.length,
      tip: up.length ? Math.max(...up.map((r) => r.tip)) : null,
      latencyMs: up.length ? Math.min(...up.map((r) => r.latencyMs)) : null,
      error: up.length ? null : results.map((r) => `${r.url}: ${r.error}`).join(' | '),
      down: results.filter((r) => !r.ok).map((r) => r.url),
    };
  }

  async probeRpc(chain) {
    if (chain.family === 'evm') return this.probeEvm(chain);
    if (chain.family === 'utxo') return this.probeUtxo(chain);
    if (chain.family === 'solana') return this.probeSolana(chain);
    if (chain.family === 'xrp') return this.probeXrp(chain);
    return { ok: false, endpointsUp: 0, endpoints: 0, tip: null, latencyMs: null, error: `no probe for family ${chain.family}` };
  }

  /** THORChain: open, halted, or not a THORChain chain (null). */
  thorchainState(chain) {
    if (!chains.thorchainChain(chain.code)) return null;
    const list = this.thorchain.inbound.byChain;
    if (!list) return 'unknown';
    const entry = list.get(chain.thorchain);
    if (!entry) return 'unlisted';
    if (entry.halted || entry.global_trading_paused || entry.chain_trading_paused) return 'halted';
    return this.thorchain.serves(chain.code) ? 'open' : 'no-pool';
  }

  /** SideShift: open, offline, or not served at all (null). */
  sideshiftState(chain) {
    if (!chains.swappable(chain.code)) return null;
    // a coin the live list marks offline on this network, or missing, is offline
    const coins = this.sideshiftCoins();
    if (!coins) return 'unknown';
    const networks = coins.get(String(chain.sideshift.coin).toUpperCase());
    return networks && networks.has(chain.sideshift.network) ? 'open' : 'offline';
  }

  /** The coin list SideshiftService cached, by coin. */
  sideshiftCoins() {
    return this._coins || null;
  }

  /** One aggregator asked for $100 of the chain's dollar token in its coin. */
  async probeDex(chain, provider) {
    const token = chains.tokensOf(chain.code)[0];
    if (!token) return { state: 'no-token', latencyMs: null };
    const started = Date.now();
    try {
      const chainSpec = chains.get(chain.code);
      const raw = await withTimeout(provider.quote({
        chain: chainSpec, tokenIn: token.contract, tokenOut: DexService.NATIVE,
        decimalsIn: token.decimals, decimalsOut: chainSpec.decimals,
        amountUnits: (10n ** BigInt(token.decimals) * 100n).toString(), sender: PROBE_SENDER, recipient: PROBE_SENDER,
      }), PROBE_TIMEOUT_MS * 2, `${provider.name} on ${chain.code}`);
      const outUsd = raw.amountOutUsd || 0;
      return { state: outUsd > 0 && outUsd < 97 ? 'thin' : 'open', latencyMs: Date.now() - started, outUsd: outUsd || null };
    } catch (error) {
      return { state: 'down', latencyMs: Date.now() - started, error: error.message };
    }
  }

  // ── the sweep ───────────────────────────────────────────────────────────

  /** The stored state of a chain, or a blank one. */
  stored(code) {
    return db.getById('chainHealth', code) || { id: code, status: null, rpc: {}, routes: {}, since: null, tipSeenAt: null, lastTip: null };
  }

  /** Overall: down when nothing answers, degraded when a route or the tip is off, else up. */
  static overall(state) {
    if (!state.rpc.ok) return 'down';
    if (state.rpc.stalled) return 'degraded';
    const routes = Object.values(state.routes || {});
    if (routes.some((r) => ['halted', 'offline', 'down', 'unlisted', 'no-pool'].includes(r))) return 'degraded';
    return 'up';
  }

  /**
   * Probe one chain and write what changed. Returns the new state.
   */
  async checkChain(chain, now = new Date()) {
    const before = this.stored(chain.code);
    const rpc = await this.probeRpc(chain);

    // the tip: moving, or not
    let tipSeenAt = before.tipSeenAt;
    let lastTip = before.lastTip;
    if (rpc.ok && rpc.tip !== null && rpc.tip !== lastTip) {
      lastTip = rpc.tip;
      tipSeenAt = now.toISOString();
    }
    const stallAfter = Math.max((chain.blockTimeSec || 12) * STALL_BLOCKS * 1000, STALL_FLOOR_MS);
    rpc.stalled = Boolean(rpc.ok && tipSeenAt && now.getTime() - new Date(tipSeenAt).getTime() > stallAfter);

    const routes = {};
    const thor = this.thorchainState(chain);
    if (thor) routes.thorchain = thor;
    const shift = this.sideshiftState(chain);
    if (shift) routes.sideshift = shift;
    const dexDetail = {};
    for (const provider of this.dex.providersFor(chain.code)) {
      const probe = await this.probeDex(chain, provider);
      routes[provider.name] = probe.state;
      dexDetail[provider.name] = probe;
    }

    // Some endpoints answering and some not is still up - the app fails
    // over - but it is worth a line on the page and an event when it changes.
    const down = (rpc.down || []).slice().sort();
    const quota = (rpc.quota || []).slice().sort();
    const state = {
      id: chain.code,
      code: chain.code,
      name: chain.name,
      symbol: chain.symbol,
      family: chain.family,
      rpc: { ok: rpc.ok, endpointsUp: rpc.endpointsUp, endpoints: rpc.endpoints, tip: rpc.tip, latencyMs: rpc.latencyMs, error: rpc.error, stalled: rpc.stalled, partial: rpc.ok && down.length > 0, down, quota },
      routes,
      dexDetail,
      lastTip,
      tipSeenAt,
      checkedAt: now.toISOString(),
    };
    state.status = ChainHealthService.overall(state);
    state.since = state.status === before.status && before.since ? before.since : now.toISOString();

    // what changed, as events, and alerts for the ones that matter
    const changes = [];
    const rpcState = rpc.ok ? (rpc.stalled ? 'stalled' : 'up') : 'down';
    const beforeRpc = before.rpc && before.rpc.ok !== undefined ? (before.rpc.ok ? (before.rpc.stalled ? 'stalled' : 'up') : 'down') : null;
    if (beforeRpc !== null && beforeRpc !== rpcState) changes.push({ component: 'rpc', from: beforeRpc, to: rpcState, detail: rpc.error || (rpc.stalled ? `tip ${rpc.tip} unchanged since ${tipSeenAt}` : `${rpc.endpointsUp}/${rpc.endpoints} endpoints, ${rpc.latencyMs} ms`) });
    for (const [component, to] of Object.entries(routes)) {
      const from = before.routes && before.routes[component] !== undefined ? before.routes[component] : null;
      if (from !== null && from !== to) changes.push({ component, from, to, detail: dexDetail[component] && dexDetail[component].error ? dexDetail[component].error : '' });
    }
    const beforeDown = (before.rpc && before.rpc.down) ? before.rpc.down.slice().sort() : null;
    if (beforeDown !== null && rpc.ok && beforeDown.join() !== down.join()) {
      changes.push({ component: 'endpoints', from: `${rpc.endpoints - beforeDown.length}/${rpc.endpoints}`, to: `${rpc.endpointsUp}/${rpc.endpoints}`, detail: down.length ? `not answering: ${down.map((u) => `${u.replace(/^https?:\/\//, '')}${quota.includes(u) ? ' (quota spent)' : ''}`).join(', ')}` : 'all answering', quiet: true });
    }
    if (before.status && before.status !== state.status) {
      changes.push({ component: 'chain', from: before.status, to: state.status, detail: '' });
    }
    for (const change of changes) this.recordEvent(chain, change, now);

    db.getById('chainHealth', chain.code) ? db.update('chainHealth', chain.code, state) : db.create('chainHealth', state);
    return state;
  }

  recordEvent(chain, change, now) {
    const event = {
      id: `${now.getTime().toString(36)}-${chain.code}-${change.component}`,
      at: now.toISOString(),
      chain: chain.code,
      name: chain.name,
      component: change.component,
      from: change.from,
      to: change.to,
      detail: String(change.detail || '').slice(0, 300),
    };
    db.create('chainHealthEvents', event);
    const all = db.getAll('chainHealthEvents');
    if (all.length > EVENTS_KEPT) {
      for (const old of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - EVENTS_KEPT)) db.delete('chainHealthEvents', old.id);
    }
    const bad = ['down', 'stalled', 'halted', 'offline', 'unlisted', 'no-pool', 'degraded'].includes(change.to);
    const recovered = ['up', 'open'].includes(change.to) && change.from && change.from !== 'unknown';
    logger[bad ? 'warn' : 'info'](`[ChainHealth] ${chain.name} ${change.component}: ${change.from} -> ${change.to}${change.detail ? ` (${change.detail})` : ''}`);
    if (!change.quiet && (bad || recovered)) {
      AlertService.notify(`${chain.name} ${change.component} ${change.to}`, change.detail || `${change.component} went from ${change.from} to ${change.to}`, `chain-health:${chain.code}:${change.component}`);
    }
  }

  /** Refresh the provider lists once, then check every chain. */
  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = new Date();
      // fresh lists for this sweep, whatever the caches think
      this.thorchain.inbound.at = 0;
      this.thorchain.pools.at = 0;
      await this.thorchain.ready().catch(() => {});
      this._coins = await this.loadSideshiftCoins();
      const states = [];
      for (const chain of chains.list()) {
        try {
          states.push(await this.checkChain(chain, now));
        } catch (error) {
          logger.warn(`[ChainHealth] ${chain.code} check failed: ${error.message}`);
        }
      }
      const down = states.filter((s) => s.status === 'down').map((s) => s.code);
      const degraded = states.filter((s) => s.status === 'degraded').map((s) => s.code);
      logger.info(`[ChainHealth] ${states.length} chains checked: ${states.length - down.length - degraded.length} up${degraded.length ? `, degraded ${degraded.join(', ')}` : ''}${down.length ? `, down ${down.join(', ')}` : ''}`);
      return states;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** SideShift's coin list as a map of coin -> networks open now, fresh. */
  async loadSideshiftCoins() {
    try {
      const response = await withTimeout(this.sideshift.http.get('/coins'), PROBE_TIMEOUT_MS * 2, 'sideshift coins');
      const byCoin = new Map();
      for (const entry of response.data || []) {
        const offOn = (flag) => (flag === true ? (entry.networks || []) : Array.isArray(flag) ? flag : []);
        const off = new Set([...offOn(entry.depositOffline), ...offOn(entry.settleOffline)]);
        byCoin.set(String(entry.coin).toUpperCase(), new Set((entry.networks || []).filter((n) => !off.has(n))));
      }
      return byCoin;
    } catch (error) {
      logger.warn(`[ChainHealth] SideShift coin list failed: ${error.message}`);
      return this._coins || null;
    }
  }

  // ── what the page reads ─────────────────────────────────────────────────

  /**
   * Down-spans for a chain from its rpc events, as `{ startedAt, resolvedAt }`
   * pairs, for the daily bars.
   */
  downSpans(code, events) {
    const spans = [];
    let open = null;
    for (const event of events.filter((e) => e.chain === code && e.component === 'rpc').sort((a, b) => a.at.localeCompare(b.at))) {
      if (event.to === 'down' && !open) open = event.at;
      if (event.to !== 'down' && open) { spans.push({ startedAt: open, resolvedAt: event.at }); open = null; }
    }
    if (open) spans.push({ startedAt: open, resolvedAt: null });
    return spans;
  }

  /** One entry per day, oldest first: uptime from the rpc down-spans. */
  days(code, events, now = new Date()) {
    const spans = this.downSpans(code, events);
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const overlap = (span, a, b) => {
      const s = Math.max(new Date(span.startedAt).getTime(), a);
      const e = Math.min(span.resolvedAt ? new Date(span.resolvedAt).getTime() : b, b);
      return e > s ? (e - s) / 60000 : 0;
    };
    const days = [];
    for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const dayStart = startOfToday - offset * dayMs;
      const dayEnd = Math.min(dayStart + dayMs, now.getTime());
      const elapsed = Math.max(1, (dayEnd - dayStart) / 60000);
      const downtime = spans.reduce((sum, span) => sum + overlap(span, dayStart, dayEnd), 0);
      days.push({
        date: new Date(dayStart).toISOString().slice(0, 10),
        status: downtime <= 0 ? 'operational' : (downtime >= elapsed * 0.25 ? 'down' : 'partial'),
        downtimeMinutes: Number(downtime.toFixed(1)),
        uptimePercentage: Number(Math.max(0, 100 - (downtime / elapsed) * 100).toFixed(2)),
      });
    }
    return days;
  }

  /** The current picture and the recent changes. */
  getSnapshot() {
    const now = new Date();
    const events = db.getAll('chainHealthEvents').sort((a, b) => b.at.localeCompare(a.at));
    const stored = new Map(db.getAll('chainHealth').map((s) => [s.id, s]));
    const list = chains.list().map((chain) => {
      const s = stored.get(chain.code);
      if (!s) return { code: chain.code, name: chain.name, symbol: chain.symbol, family: chain.family, status: 'unknown', rpc: null, routes: {}, since: null, checkedAt: null, days: this.days(chain.code, events, now) };
      return {
        code: s.code, name: s.name, symbol: s.symbol, family: s.family, status: s.status,
        rpc: { ok: s.rpc.ok, endpointsUp: s.rpc.endpointsUp, endpoints: s.rpc.endpoints, tip: s.rpc.tip, latencyMs: s.rpc.latencyMs, stalled: s.rpc.stalled, partial: Boolean(s.rpc.partial), down: s.rpc.down || [], quota: s.rpc.quota || [], error: s.rpc.error },
        routes: s.routes || {},
        since: s.since,
        checkedAt: s.checkedAt,
        days: this.days(chain.code, events, now),
      };
    });
    const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
    for (const c of list) counts[c.status] = (counts[c.status] || 0) + 1;
    const latest = list.reduce((max, c) => (c.checkedAt && (!max || c.checkedAt > max) ? c.checkedAt : max), null);
    return { generatedAt: now.toISOString(), checkedAt: latest, intervalMs: INTERVAL_MS, counts, chains: list, events: events.slice(0, 60) };
  }

  // ── the loop ────────────────────────────────────────────────────────────

  start(intervalMs = INTERVAL_MS) {
    if (this.timer) return this.timer;
    // the first sweep soon after boot, not on it: let the price feed and the
    // provider pools come up first
    const first = setTimeout(() => this.runOnce().catch((error) => logger.error(`[ChainHealth] sweep failed: ${error.message}`)), 15_000);
    if (typeof first.unref === 'function') first.unref();
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => logger.error(`[ChainHealth] sweep failed: ${error.message}`));
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.timer;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = new ChainHealthService();
module.exports.ChainHealthService = ChainHealthService;
module.exports.INTERVAL_MS = INTERVAL_MS;
module.exports.STALL_BLOCKS = STALL_BLOCKS;
module.exports.STALL_FLOOR_MS = STALL_FLOOR_MS;
