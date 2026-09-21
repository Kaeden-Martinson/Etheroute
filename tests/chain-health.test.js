/**
 * Chain health: the continuous probe of every chain and route, the events
 * it records when something changes, and the status page that shows them.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const chains = require('../src/config/chains');
const { db } = require('../src/config/database');
const Health = require('../src/services/ChainHealthService');
const { ChainHealthService } = Health;
const AlertService = require('../src/services/AlertService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

/** A service whose probes answer as told, with no network. */
function stubbed(answers) {
  const service = new ChainHealthService();
  service.probeRpc = async (chain) => {
    const a = answers.rpc[chain.code] || { ok: true, tip: 100, latencyMs: 50, endpointsUp: 2, endpoints: 2, error: null };
    return { ...a };
  };
  service.thorchain = {
    inbound: { byChain: new Map(Object.entries(answers.inbound || {}).map(([k, v]) => [k, v])), at: 0 },
    pools: { at: 0 },
    ready: async () => {},
    serves: (code) => Boolean((answers.pools || []).includes(`${chains.get(code).thorchain}.${chains.get(code).symbol}`)),
  };
  service._coins = new Map(Object.entries(answers.coins || {}).map(([k, v]) => [k, new Set(v)]));
  service.loadSideshiftCoins = async () => service._coins;
  service.dex = {
    providersFor: (code) => (answers.dex && answers.dex[code] ? Object.keys(answers.dex[code]).map((name) => ({ name })) : []),
  };
  service.probeDex = async (chain, provider) => ({ state: answers.dex[chain.code][provider.name], latencyMs: 10 });
  return service;
}

const HEALTHY = {
  rpc: {},
  inbound: { BTC: { chain: 'BTC', halted: false }, BASE: { chain: 'BASE', halted: false, router: '0xr' }, SOL: { chain: 'SOL', halted: true } },
  pools: ['BTC.BTC', 'BASE.ETH', 'SOL.SOL'],
  coins: { BTC: ['bitcoin'], ETH: ['base', 'ethereum'], SOL: ['solana'] },
  dex: { BASE: { kyber: 'open', paraswap: 'open' } },
};

function wipe() {
  for (const table of ['chainHealth', 'chainHealthEvents']) {
    for (const row of db.getAll(table)) db.delete(table, row.id);
  }
}

let notified;
let originalNotify;
beforeEach(() => {
  wipe();
  notified = [];
  originalNotify = AlertService.notify;
  AlertService.notify = (subject, detail, key) => notified.push({ subject, detail, key });
});
afterEach(() => { AlertService.notify = originalNotify; wipe(); });

describe('One chain, one check', () => {
  test('a healthy chain is up, with its endpoints, tip and routes written down', async () => {
    const service = stubbed(HEALTHY);
    const state = await service.checkChain(chains.get('BASE'));
    assert.strictEqual(state.status, 'up');
    assert.deepStrictEqual(state.routes, { thorchain: 'open', sideshift: 'open', kyber: 'open', paraswap: 'open' });
    assert.strictEqual(state.rpc.endpointsUp, 2);
    assert.strictEqual(state.rpc.tip, 100);
    assert.strictEqual(state.rpc.stalled, false);
    assert.ok(state.since && state.checkedAt);
    assert.strictEqual(db.getById('chainHealth', 'BASE').status, 'up');
    assert.deepStrictEqual(db.getAll('chainHealthEvents'), [], 'the first check is a baseline, not a change');
    assert.deepStrictEqual(notified, []);
  });

  test('a halted THORChain chain is degraded; a chain THORChain does not serve has no such route', async () => {
    const service = stubbed(HEALTHY);
    const sol = await service.checkChain(chains.get('SOL'));
    assert.strictEqual(sol.status, 'degraded');
    assert.strictEqual(sol.routes.thorchain, 'halted');
    assert.strictEqual(sol.routes.sideshift, 'open');
    const pol = await service.checkChain(chains.get('POL'));
    assert.strictEqual(pol.routes.thorchain, undefined);
    assert.strictEqual(pol.routes.sideshift, 'offline', 'POL is not in this coin list');
    assert.strictEqual(pol.status, 'degraded');
    const scroll = await service.checkChain(chains.get('SCROLL'));
    assert.deepStrictEqual(scroll.routes, {}, 'direct-only: nothing to be off');
    assert.strictEqual(scroll.status, 'up');
  });

  test('no endpoint answering is down, and the change is an event and an alert', async () => {
    const service = stubbed(HEALTHY);
    await service.checkChain(chains.get('BTC'), new Date('2026-09-20T10:00:00Z'));
    service.probeRpc = async () => ({ ok: false, endpointsUp: 0, endpoints: 1, tip: null, latencyMs: 8000, error: 'https://mempool.space/api: timed out' });
    const down = await service.checkChain(chains.get('BTC'), new Date('2026-09-20T10:05:00Z'));
    assert.strictEqual(down.status, 'down');
    assert.strictEqual(down.since, '2026-09-20T10:05:00.000Z', 'since the change, not the first check');
    const events = db.getAll('chainHealthEvents');
    assert.deepStrictEqual(events.map((e) => [e.component, e.from, e.to]), [['rpc', 'up', 'down'], ['chain', 'up', 'down']]);
    assert.strictEqual(events[0].detail, 'https://mempool.space/api: timed out');
    assert.strictEqual(notified.length, 2);
    assert.strictEqual(notified[0].subject, 'Bitcoin rpc down');
    assert.strictEqual(notified[0].key, 'chain-health:BTC:rpc');

    // back up: another event, another alert, since resets
    service.probeRpc = async () => ({ ok: true, endpointsUp: 1, endpoints: 1, tip: 101, latencyMs: 300, error: null });
    const up = await service.checkChain(chains.get('BTC'), new Date('2026-09-20T10:20:00Z'));
    assert.strictEqual(up.status, 'up');
    assert.strictEqual(up.since, '2026-09-20T10:20:00.000Z');
    assert.strictEqual(notified[2].subject, 'Bitcoin rpc up');
    assert.strictEqual(db.getAll('chainHealthEvents').length, 4);
  });

  test('a tip that stops moving is a stall, after twenty blocks and never under fifteen minutes', async () => {
    const service = stubbed(HEALTHY);
    const t0 = new Date('2026-09-20T10:00:00Z');
    service.probeRpc = async () => ({ ok: true, endpointsUp: 3, endpoints: 3, tip: 500, latencyMs: 50, error: null });
    await service.checkChain(chains.get('BASE'), t0);
    // Base blocks every 2 s: twenty blocks is 40 s, so the floor of 15 min applies
    const later = await service.checkChain(chains.get('BASE'), new Date(t0.getTime() + 10 * 60 * 1000));
    assert.strictEqual(later.rpc.stalled, false, 'ten minutes is inside the floor');
    const stalled = await service.checkChain(chains.get('BASE'), new Date(t0.getTime() + 16 * 60 * 1000));
    assert.strictEqual(stalled.rpc.stalled, true);
    assert.strictEqual(stalled.status, 'degraded');
    assert.ok(db.getAll('chainHealthEvents').some((e) => e.component === 'rpc' && e.to === 'stalled'));
    // Bitcoin: twenty blocks is 200 minutes
    service.probeRpc = async () => ({ ok: true, endpointsUp: 1, endpoints: 1, tip: 900000, latencyMs: 50, error: null });
    await service.checkChain(chains.get('BTC'), t0);
    const btc = await service.checkChain(chains.get('BTC'), new Date(t0.getTime() + 60 * 60 * 1000));
    assert.strictEqual(btc.rpc.stalled, false, 'an hour without a Bitcoin block is quiet, not stalled');
  });

  test('a route going off is degraded and an event; coming back is an event too', async () => {
    const service = stubbed(HEALTHY);
    await service.checkChain(chains.get('BASE'));
    service.probeDex = async (chain, provider) => ({ state: provider.name === 'kyber' ? 'down' : 'open', latencyMs: 10, error: 'HTTP 503' });
    const off = await service.checkChain(chains.get('BASE'));
    assert.strictEqual(off.status, 'degraded');
    assert.strictEqual(off.routes.kyber, 'down');
    const events = db.getAll('chainHealthEvents');
    assert.ok(events.some((e) => e.component === 'kyber' && e.from === 'open' && e.to === 'down' && e.detail === 'HTTP 503'));
    assert.ok(notified.some((n) => n.subject === 'Base kyber down'));
  });
});

describe('The snapshot and the days', () => {
  test('down-spans from the events become daily uptime, and the snapshot counts the chains', async () => {
    const service = stubbed(HEALTHY);
    const day = (h) => new Date(Date.UTC(2026, 8, 20, h, 0, 0));
    await service.checkChain(chains.get('BTC'), day(0));
    service.probeRpc = async () => ({ ok: false, endpointsUp: 0, endpoints: 1, tip: null, latencyMs: 1, error: 'gone' });
    await service.checkChain(chains.get('BTC'), day(6));
    service.probeRpc = async () => ({ ok: true, endpointsUp: 1, endpoints: 1, tip: 5, latencyMs: 1, error: null });
    await service.checkChain(chains.get('BTC'), day(12));
    const events = db.getAll('chainHealthEvents');
    assert.deepStrictEqual(service.downSpans('BTC', events), [{ startedAt: day(6).toISOString(), resolvedAt: day(12).toISOString() }]);
    const days = service.days('BTC', events, day(18));
    const today = days[days.length - 1];
    assert.strictEqual(today.date, '2026-09-20');
    assert.strictEqual(today.downtimeMinutes, 360);
    assert.strictEqual(today.status, 'down', 'six of eighteen elapsed hours is a third of the day');
    assert.strictEqual(days.length, 30);
    assert.ok(days.slice(0, -1).every((d) => d.status === 'operational' && d.downtimeMinutes === 0));

    const snapshot = service.getSnapshot();
    assert.strictEqual(snapshot.chains.length, chains.CODES.length);
    const btc = snapshot.chains.find((c) => c.code === 'BTC');
    assert.strictEqual(btc.status, 'up');
    assert.strictEqual(btc.days.length, 30);
    assert.strictEqual(snapshot.counts.up, 1);
    assert.strictEqual(snapshot.counts.unknown, chains.CODES.length - 1, 'the others were never checked');
    assert.ok(snapshot.events.length >= 2);
    assert.strictEqual(snapshot.events[0].chain, 'BTC');
  });

  test('the overall verdict: down beats degraded beats up', () => {
    const at = (rpc, routes) => ChainHealthService.overall({ rpc, routes });
    assert.strictEqual(at({ ok: false }, {}), 'down');
    assert.strictEqual(at({ ok: true, stalled: true }, {}), 'degraded');
    assert.strictEqual(at({ ok: true }, { thorchain: 'halted' }), 'degraded');
    assert.strictEqual(at({ ok: true }, { sideshift: 'offline' }), 'degraded');
    assert.strictEqual(at({ ok: true }, { kyber: 'down' }), 'degraded');
    assert.strictEqual(at({ ok: true }, { thorchain: 'open', kyber: 'open' }), 'up');
    assert.strictEqual(at({ ok: true }, { thorchain: 'unknown' }), 'up', 'a list that has not loaded is not an outage');
  });
});

describe('Wired in', () => {
  test('the server runs the sweep, the API serves it, the page draws it', () => {
    const app = read('src/app.js');
    assert.ok(app.includes("const ChainHealthService = require('./services/ChainHealthService');"));
    assert.ok(app.includes('ChainHealthService.start();'));
    assert.ok(app.includes('ChainHealthService.stop();'));
    const route = read('src/routes/status.js');
    assert.ok(route.includes("router.get('/chains', (req, res) => {"));
    assert.ok(route.includes('ChainHealthService.getSnapshot()'));
    const html = read('public/status.html');
    assert.ok(html.includes('id="chainRows"'));
    assert.ok(html.includes('id="chainEvents"'));
    assert.ok(html.includes('data-on-click="toggleAllChains"'));
    const js = read('public/js/status.js');
    assert.ok(js.includes('function renderChains(data)'));
    assert.ok(js.includes('fetch(`${STATUS_API_URL}/chains`)'));
    assert.ok(js.includes('function toggleAllChains()'));
    assert.ok(js.includes('rank = { down: 0, degraded: 1, unknown: 2, up: 3 }'), 'problems first');
    const css = read('public/css/status.css');
    for (const cls of ['.chain-row {', '.dot--degraded', '.dot--down', '.chain-event {', '.chain-more {']) assert.ok(css.includes(cls), cls);
    assert.ok(/@media \(max-width: 760px\) \{\s*\.chain-row \{/.test(css), 'a phone layout');
  });

  test('the CLI sweeps without touching a running server\'s data', () => {
    const cli = read('scripts/chain-health.js');
    assert.ok(cli.includes("fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-health-'))"));
    assert.ok(cli.includes('ChainHealthService.checkChain(chain)'));
    const pkg = JSON.parse(read('package.json'));
    assert.strictEqual(pkg.scripts['chains:health'], 'node scripts/chain-health.js');
  });

  test('the probes ask each endpoint for the tip, and for its chain id once a day', () => {
    const source = read('src/services/ChainHealthService.js');
    assert.ok(source.includes("const id = await rpcCall(url, 'eth_chainId');"));
    assert.ok(source.includes("const tipHex = await rpcCall(url, 'eth_blockNumber');"));
    assert.ok(source.includes('const CHAIN_ID_TTL_MS = 24 * 60 * 60 * 1000;'), 'one call per endpoint per sweep, not two');
    assert.ok(source.includes('answers as chain'));
    assert.ok(source.includes('quota: results.filter((r) => !r.ok && r.quota).map((r) => r.url),'), 'a spent quota is told apart from an outage');
    assert.ok(source.includes("ProxyService.fetch(`${chain.explorerApi}/blocks/tip/height`)"));
    assert.ok(source.includes("rpcCall(SOLANA_RPC, 'getSlot'"));
    assert.ok(source.includes("const PROBE_SENDER = '0x1111111111111111111111111111111111111111';"), 'an address ParaSwap accepts');
  });
});
