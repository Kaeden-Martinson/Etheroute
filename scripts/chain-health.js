#!/usr/bin/env node
/**
 * One sweep of every chain's health, printed: what the endpoints said, the
 * tip, and the routes off it (THORChain, SideShift, the aggregators). The
 * same probes the server runs every few minutes for the status page.
 *
 *   node scripts/chain-health.js            # every chain
 *   node scripts/chain-health.js BTC BASE   # some of them
 *   node scripts/chain-health.js --json     # the raw states
 *
 * Reads and writes nothing in the database it does not own: DATA_DIR is
 * pointed at a scratch directory unless you set it, so a running server's
 * data is never touched by this process.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

if (!process.env.DATA_DIR) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-health-'));
  process.env.DATA_DIR = scratch;
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chain-health-cli-secret-that-is-long-enough';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'chain-health-cli-key-that-is-long-enough';

const chains = require('../src/config/chains');
const ChainHealthService = require('../src/services/ChainHealthService');

const args = process.argv.slice(2);
const json = args.includes('--json');
const wanted = args.filter((a) => !a.startsWith('--')).map((c) => c.toUpperCase());

const ROUTE = { thorchain: 'THORChain', sideshift: 'SideShift', kyber: 'Kyber', paraswap: 'ParaSwap' };

async function main() {
  const list = chains.list().filter((c) => wanted.length === 0 || wanted.includes(c.code));
  ChainHealthService.thorchain.inbound.at = 0;
  ChainHealthService.thorchain.pools.at = 0;
  await ChainHealthService.thorchain.ready().catch(() => {});
  ChainHealthService._coins = await ChainHealthService.loadSideshiftCoins();
  const states = [];
  for (const chain of list) {
    states.push(await ChainHealthService.checkChain(chain));
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
    return;
  }
  const lines = states.map((s) => {
    const rpc = s.rpc.ok
      ? `${s.rpc.endpointsUp}/${s.rpc.endpoints} up · ${String(s.rpc.latencyMs).padStart(5)} ms · tip ${s.rpc.tip}${s.rpc.stalled ? ' STALLED' : ''}`
      : `DOWN · ${(s.rpc.error || '').slice(0, 80)}`;
    const routes = Object.entries(s.routes).map(([k, v]) => `${ROUTE[k] || k} ${v}`).join(' · ') || 'direct only';
    return `  ${s.status.padEnd(8)} ${s.code.padEnd(8)} ${rpc.padEnd(52)} ${routes}`;
  });
  const counts = states.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  process.stdout.write(`${lines.join('\n')}\n\n${states.length} chains: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
  process.exit(states.some((s) => s.status === 'down') ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(2);
});
