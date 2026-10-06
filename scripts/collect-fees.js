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
 *   node scripts/collect-fees.js --set-held <address|id> <amount> [--asset USDC] [--reason "..."]
 *                                                # correct one wrong figure by hand
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
const { db } = require('../src/config/database');

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

/** A wallet by id or address, for the hand corrections. */
function findWallet(query) {
  const wallets = db.getAll('wallets');
  return wallets.find((w) => w.id === query)
    || wallets.find((w) => String(w.address).toLowerCase() === String(query).toLowerCase())
    || null;
}

/**
 * Set one wallet's held figure. Guarded: it says what it is about to do and
 * does nothing without --yes, since this is the one command that can hand a
 * merchant money that was the platform's, or take money that was theirs.
 */
function setHeld() {
  const i = args.indexOf('--set-held');
  const [query, amount] = [args[i + 1], args[i + 2]];
  if (!query || amount === undefined || String(query).startsWith('--') || String(amount).startsWith('--')) {
    say('Usage: node scripts/collect-fees.js --set-held <address|wallet id> <amount> [--asset USDC] [--reason "..."] [--yes]');
    process.exit(1);
  }
  const wallet = findWallet(query);
  if (!wallet) { say(`No wallet matches "${query}".`); process.exit(1); }
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) { say(`"${amount}" is not an amount.`); process.exit(1); }
  const coin = chains.has(wallet.chain) ? chains.get(wallet.chain).symbol : wallet.chain;
  const asset = option('--asset') ? String(option('--asset')).toUpperCase() : coin;
  const onChain = asset === coin ? Number(wallet.balance) || 0 : Number((wallet.tokenBalances || {})[asset]) || 0;
  const from = asset === coin
    ? Number(wallet.serviceSubtractions) || 0
    : Number((wallet.serviceSubtractionsTokens || {})[asset]) || 0;
  const to = Number(amount);

  say(`${wallet.chain} ${wallet.address}  (wallet ${wallet.id}, client ${wallet.clientId})`);
  say(`  the wallet holds   ${onChain} ${asset}`);
  say(`  held for fees      ${from} ${asset}  ->  ${to} ${asset}`);
  say(`  the merchant could withdraw ${Math.max(0, onChain - Math.min(from, onChain))} ${asset}  ->  ${Math.max(0, onChain - Math.min(to, onChain))} ${asset}`);
  if (to > onChain) say(`  note: that is more than the wallet holds, so the merchant sees nothing withdrawable either way.`);
  if (!flag('--yes')) {
    say();
    say('Nothing written. Add --yes to make the change.');
    return;
  }
  const result = FeeCollectionService.setHeld(wallet.id, asset, to, { reason: option('--reason') || null, by: 'collect-fees.js' });
  if (result.error) { say(`✗ ${result.error}`); process.exit(1); }
  say();
  say(`Set. ${asset} held on ${wallet.address}: ${result.from} -> ${result.to}${option('--reason') ? ` (${option('--reason')})` : ''}`);
  say('The change is on the wallet record as a correction, and in the log.');
}

async function main() {
  const chain = option('--chain') ? String(option('--chain')).toUpperCase() : null;
  if (flag('--set-held')) { setHeld(); return; }
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
