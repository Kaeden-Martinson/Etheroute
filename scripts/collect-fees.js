#!/usr/bin/env node
/**
 * The platform's fees: what is held in the merchants' wallets, what has
 * been collected, and a sweep of what is worth collecting now.
 *
 *   node scripts/collect-fees.js                 # the book: held and collected
 *   node scripts/collect-fees.js --dry-run       # what a sweep would send, and why not the rest
 *   node scripts/collect-fees.js --collect       # send it
 *   node scripts/collect-fees.js --collect --chain ETH
 *   node scripts/collect-fees.js --reconcile     # cap held figures at what the wallets hold
 *
 * Needs PLATFORM_FEE_ADDRESS_* in the environment for the families to
 * collect on. Runs against the same DATA_DIR as the server; a sweep from
 * here while the server runs is safe (each send is one wallet's, and the
 * server sees the transaction like any other).
 */
'use strict';

const { validate } = require('../src/config/env');
validate();

const FeeCollectionService = require('../src/services/FeeCollectionService');
const chains = require('../src/config/chains');

// The logger takes over console.log; this speaks to the terminal directly.
const say = (line = '') => process.stdout.write(`${line}\n`);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function printBook() {
  const summary = FeeCollectionService.summary();
  say('Platform fee addresses');
  for (const [family, address] of Object.entries(summary.addresses)) say(`  ${family.padEnd(5)} ${address || '(not set - fees on this family stay held)'}`);
  say();
  say(`Held in merchants' wallets: ${money(summary.held.usd)} across ${summary.held.wallets} wallet(s)`);
  for (const row of summary.held.rows.sort((a, b) => b.usd - a.usd)) {
    const over = row.held > row.onChain ? `  (wallet holds only ${row.onChain} ${row.asset}: run --reconcile)` : '';
    say(`  ${row.chain.padEnd(6)} ${String(row.held).padEnd(14)} ${row.asset.padEnd(5)} ${money(row.usd).padStart(9)}  ${row.address}${over}`);
  }
  say();
  say(`Collected: ${money(summary.collected.usd)} in ${summary.collected.count} transaction(s)`);
  for (const c of summary.collected.byChain.sort((a, b) => b.usd - a.usd)) say(`  ${c.chain.padEnd(6)} ${money(c.usd).padStart(9)} in ${c.count}`);
  if (summary.recent.length) {
    say();
    say('Recent');
    for (const r of summary.recent.slice(0, 10)) say(`  ${String(r.createdAt).slice(0, 16)} ${r.chain.padEnd(6)} ${String(r.amount).padEnd(14)} ${r.asset.padEnd(5)} ${money(r.usd).padStart(9)}  ${r.via.padEnd(6)} ${r.status.padEnd(10)} ${r.txHash || ''}`);
  }
  say();
  say(`Thresholds: over ${money(summary.thresholds.minUsd)} and ${summary.thresholds.gasMultiple}x the gas.`);
}

/** The book is in dollars; the rates must have arrived first. */
async function pricesReady() {
  const PriceService = require('../src/services/PriceService');
  for (let i = 0; i < 20 && !PriceService.updatedAt; i += 1) await new Promise((r) => setTimeout(r, 500));
  if (!PriceService.updatedAt) say(`(prices have not loaded${PriceService.lastError ? `: ${PriceService.lastError}` : ''}; coin figures show as $0.00 and nothing is collected on them)`);
}

async function main() {
  const chain = option('--chain') ? String(option('--chain')).toUpperCase() : null;
  await pricesReady();
  if (chain && !chains.has(chain)) {
    say(`Unknown chain ${chain}`);
    process.exit(1);
  }

  if (flag('--reconcile')) {
    const changed = FeeCollectionService.reconcileHeld();
    say(`Reconciled: ${changed} held figure(s) capped at what the wallet holds.`);
  }

  if (flag('--dry-run') || flag('--collect')) {
    const result = await FeeCollectionService.collect({ chain, dryRun: flag('--dry-run') });
    if (result.note) say(result.note);
    const planned = result.planned || result.collected;
    say(`${flag('--dry-run') ? 'Would collect' : 'Collected'}: ${planned.length}`);
    for (const c of planned) say(`  ${c.chain.padEnd(6)} ${String(c.amount).padEnd(14)} ${c.asset.padEnd(5)} ${money(c.usd).padStart(9)}  gas ${money(c.gasUsd || 0)}  ${c.address || c.wallet?.address || ''} -> ${c.to || c.address}${c.txHash ? `  ${c.txHash}` : ''}`);
    if (result.failed && result.failed.length) {
      say('Failed:');
      for (const f of result.failed) say(`  ${f.chain.padEnd(6)} ${f.amount} ${f.asset}: ${f.error}`);
    }
    say(`Not collected: ${result.skipped.length}`);
    for (const s of result.skipped) say(`  ${s.chain.padEnd(6)} ${String(s.held).padEnd(14)} ${s.asset.padEnd(5)} ${money(s.usd).padStart(9)}  ${s.reason}`);
    say();
  }

  printBook();
}

main().then(() => process.exit(0)).catch((error) => {
  say(`Failed: ${error.message}`);
  process.exit(1);
});
