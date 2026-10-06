#!/usr/bin/env node
/**
 * Where a wallet's held fee came from - and, across every wallet, whether
 * the held figures agree with the withdrawals that booked them.
 *
 *   node scripts/explain-wallet.js 0x8462Dc…50df6E   # one wallet, in full
 *   node scripts/explain-wallet.js --audit           # every wallet that disagrees
 *   node scripts/explain-wallet.js --audit --yes     # ...and correct them
 *
 * "Held for fees" is the platform's money still sitting at a merchant's
 * address, waiting for the sweep. The dashboard caps the figure at what the
 * wallet holds, so a wrong one looks the same as a wallet whose balance
 * really is all fee - and there was no way to tell which from the outside.
 *
 * This replays the books: every payment in, every withdrawal that booked a
 * fee (with the gas the float advanced, charged back the same way), every
 * sweep that took one out, and what a closure forfeited. The sum is what
 * the record should say. Where it does not, the figure was written by
 * something other than arithmetic - most often the rule this project used
 * before fees were recorded natively, which divided a dollar fee by a price
 * it did not always have and fell back to 1, writing dollars into a figure
 * counted in coin. That mistake is worth about `0.05 x the coin's price`:
 * ten times the balance on Solana, five thousand on Bitcoin.
 *
 * Reading is safe against production with the server up. --yes writes.
 */
'use strict';

const { validate } = require('../src/config/env');
validate();

const { db } = require('../src/config/database');
const chains = require('../src/config/chains');
const PriceService = require('../src/services/PriceService');
const FeeCollectionService = require('../src/services/FeeCollectionService');

const say = (line = '') => process.stdout.write(`${line}\n`);
const n = (v, places = 8) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(places)) : 0);
const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const query = args.find((a) => !a.startsWith('--'));

/**
 * Replay one wallet's books. Returns the figures and the parts they came
 * from, so the caller can print a line or the whole story.
 */
function replay(wallet) {
  const symbol = chains.has(wallet.chain) ? chains.get(wallet.chain).symbol : wallet.chain;
  const address = String(wallet.address || '').toLowerCase();

  const deposits = db.getAll('transactions')
    .filter((t) => t.type === 'DEPOSIT' && String(t.toAddress || '').toLowerCase() === address)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const withdrawals = [];
  for (const payout of db.getAll('payouts')) {
    for (const t of (payout.withdrawalPlan && payout.withdrawalPlan.transfers) || []) {
      if (String(t.fromAddress || '').toLowerCase() === address) withdrawals.push({ payout, t });
    }
  }
  withdrawals.sort((a, b) => new Date(a.payout.createdAt) - new Date(b.payout.createdAt));

  let bookedFees = 0;
  let bookedAdvances = 0;
  // A payout from before fees were planned in the coin carries no
  // platformFeeNative at all. Its fee was real; it just cannot be read back
  // from the record, so a wallet with one of these is not something an
  // audit may set - it would forgive a fee that was genuinely charged.
  const unreadable = [];
  for (const { payout, t } of withdrawals) {
    const rode = Boolean(t.feeOutput && t.feeOutput.amount > 0);
    // only a leg that was broadcast books anything, and only when the fee
    // did not ride along in the transaction itself
    if (!t.txHash || rode) continue;
    if ((t.asset || symbol) !== symbol) continue;
    if (t.platformFeeNative === undefined || t.platformFeeNative === null) {
      unreadable.push({ payout, t, usd: n(t.platformFeeUSD) || null });
      continue;
    }
    bookedFees += n(t.platformFeeNative);
    bookedAdvances += n(t.gasTopUp && t.gasTopUp.chargedInAsset);
  }

  const collections = db.getAll('feeCollections')
    .filter((c) => c.walletId === wallet.id || String(c.fromAddress || '').toLowerCase() === address);
  const collected = collections
    .filter((c) => (c.asset || symbol) === symbol && c.status !== 'FAILED')
    .reduce((sum, c) => sum + n(c.amount), 0);

  const forfeited = wallet.isActive === false ? n(wallet.forfeited && wallet.forfeited.coin) : 0;
  const expected = Math.max(0, n(bookedFees + bookedAdvances + forfeited - collected));
  const held = n(wallet.serviceSubtractions);

  return {
    symbol, deposits, withdrawals, collections,
    paidIn: n(deposits.filter((d) => (d.asset || symbol) === symbol).reduce((s, d) => s + n(d.nativeAmount), 0)),
    bookedFees: n(bookedFees), bookedAdvances: n(bookedAdvances), collected: n(collected), forfeited,
    expected, held, balance: n(wallet.balance), drift: n(held - expected),
    unreadable,
  };
}

// ── every wallet at once ─────────────────────────────────────────────────
function audit() {
  const wallets = db.getAll('wallets').filter((w) => chains.has(w.chain));
  const all = wallets.map((w) => ({ wallet: w, ...replay(w) })).filter((r) => Math.abs(r.drift) > 1e-8);
  const blocked = all.filter((r) => r.unreadable.length);
  const rows = all.filter((r) => !r.unreadable.length);
  all.sort((a, b) => b.drift - a.drift);
  rows.sort((a, b) => b.drift - a.drift);

  say(`${wallets.length} wallet(s) read, ${all.length} whose held fee the withdrawals do not account for.`);
  if (!all.length) { say('Every held figure agrees with its book.'); return rows; }
  say();
  say('CHAIN  HELD NOW        SHOULD BE       WALLET HOLDS     OVER BY        ADDRESS');
  for (const r of rows) {
    const over = r.balance > 0 && r.drift > 0 ? `${(r.held / r.balance).toFixed(r.held / r.balance > 100 ? 0 : 1)}x bal` : '';
    say(`${r.wallet.chain.padEnd(6)} ${String(r.held).padEnd(15)} ${String(r.expected).padEnd(15)} ${String(r.balance).padEnd(16)} ${String(n(r.drift)).padEnd(14)} ${r.wallet.address}${over ? `  (${over})` : ''}`);
  }
  say();

  if (blocked.length) {
    say(`${blocked.length} of them cannot be audited, and are left alone:`);
    for (const r of blocked) {
      const usd = r.unreadable.reduce((sum, u) => sum + (u.usd || 0), 0);
      say(`  ${r.wallet.chain.padEnd(6)} ${r.wallet.address}  held ${r.held} ${r.symbol}, ${r.unreadable.length} withdrawal(s) with no fee recorded in the coin${usd ? ` (worth $${usd.toFixed(2)} at the time)` : ''}`);
    }
    say('  Their fees were charged before the plan recorded one in the coin, so the record');
    say('  cannot say what they were. Setting these to what the rest of the book accounts');
    say('  for would forgive a fee that was really taken; decide each with --set-held.');
    say();
  }

  const dollars = rows.reduce((sum, r) => sum + Math.max(0, r.drift) * (PriceService.rateFor(r.wallet.chain) || 0), 0);
  if (PriceService.updatedAt) say(`Booked to the platform beyond what the withdrawals explain: $${dollars.toFixed(2)} at today's prices.`);
  else say('(prices have not loaded in this process, so the figures above are in coin only)');
  say('Where a figure is many times the balance, it was written in dollars rather than in the coin:');
  say('the rule that did that divided by a price it did not always have, and fell back to 1.');
  say();
  if (!rows.length) { say('Nothing here can be set automatically.'); return rows; }
  if (!flag('--yes')) {
    say(`Nothing written. Run again with --yes to set ${rows.length} of these to what its withdrawals account for.`);
    return rows;
  }
  let fixed = 0;
  for (const r of rows) {
    const result = FeeCollectionService.setHeld(r.wallet.id, r.symbol, r.expected, {
      reason: 'audit: fees booked at withdrawal, less what was collected',
      by: 'explain-wallet.js --audit',
    });
    if (result.error) { say(`✗ ${r.wallet.address}: ${result.error}`); continue; }
    fixed += 1;
    say(`  ${r.wallet.chain.padEnd(6)} ${r.wallet.address}  ${result.from} -> ${result.to} ${r.symbol}`);
  }
  say();
  say(`${fixed} held figure(s) set. Each wallet keeps the previous value in heldCorrections, and the log has a line per change.`);
  return rows;
}

// ── one wallet, in full ──────────────────────────────────────────────────
function explain(wallet) {
  const r = replay(wallet);
  const { symbol } = r;
  const rate = PriceService.rateFor(wallet.chain) || 0;
  const usd = (amount) => (rate > 0 ? ` ($${(amount * rate).toFixed(2)})` : '');
  const shownHeld = Math.min(r.held, r.balance);
  const available = Math.max(0, r.balance - shownHeld);

  say(`${wallet.chain} ${wallet.address}`);
  say(`  wallet id      ${wallet.id}`);
  say(`  client         ${wallet.clientId}`);
  say(`  label          ${wallet.label || '(unnamed)'}`);
  say(`  state          ${wallet.isActive === false ? `CLOSED ${when(wallet.closedAt)} by ${wallet.closedBy || '?'}` : 'active'}`);
  say(`  created        ${when(wallet.createdAt)}`);
  say(`  last read      ${when(wallet.lastUpdated || wallet.updatedAt)}`);
  say();
  say('As the dashboard shows it');
  say(`  balance stored ${r.balance} ${symbol}${usd(r.balance)}`);
  say(`  held for fees  ${shownHeld} ${symbol}${usd(shownHeld)}${r.held > r.balance ? `   (book says ${r.held}, capped at the balance)` : ''}`);
  say(`  withdrawable   ${available} ${symbol}${usd(available)}`);
  for (const [sym, amount] of Object.entries(wallet.serviceSubtractionsTokens || {})) {
    say(`  held ${sym.padEnd(9)} ${n(amount)} of ${n((wallet.tokenBalances || {})[sym])} on hand`);
  }
  if (wallet.forfeited) {
    say(`  forfeited on close: ${n(wallet.forfeited.coin)} ${symbol}${Object.keys(wallet.forfeited.tokens || {}).length ? `, ${JSON.stringify(wallet.forfeited.tokens)}` : ''}`);
  }
  for (const c of wallet.heldCorrections || []) {
    say(`  corrected ${when(c.at)}: ${c.asset} ${c.from} -> ${c.to} by ${c.by}${c.reason ? ` (${c.reason})` : ''}`);
  }
  say();

  say(`Payments in (${r.deposits.length})`);
  if (!r.deposits.length) say('  none recorded');
  for (const d of r.deposits) {
    say(`  ${when(d.createdAt)}  +${n(d.nativeAmount)} ${d.asset || symbol}${d.usdAmount ? ` ($${Number(d.usdAmount).toFixed(2)})` : ''}  ${d.status}  ${d.sessionId ? `session ${String(d.sessionId).slice(0, 8)}` : ''}`);
  }
  say(`  total in ${r.paidIn} ${symbol}${usd(r.paidIn)}`);
  say();

  say(`Withdrawals from this wallet (${r.withdrawals.length})`);
  if (!r.withdrawals.length) say('  none - so nothing should have booked a fee here');
  for (const { payout, t } of r.withdrawals) {
    const fee = n(t.platformFeeNative);
    const advance = n(t.gasTopUp && t.gasTopUp.chargedInAsset);
    const rode = Boolean(t.feeOutput && t.feeOutput.amount > 0);
    const counts = Boolean(t.txHash) && !rode;
    say(`  ${when(payout.createdAt)}  payout ${String(payout.id).slice(0, 8)}  ${t.status || payout.status}  sent ${n(t.nativeAmount)} ${t.asset || symbol} -> ${t.payoutChain}/${t.payoutAsset || ''}`);
    say(`      fee ${fee} ${t.asset || symbol}${advance ? `  + gas advanced ${advance}` : ''}  ${rode ? 'rode in the transaction (collected, not held)' : counts ? 'held in the wallet' : 'not broadcast - books nothing'}`);
    if (t.txHash) say(`      tx ${t.txHash}`);
  }
  say(`  booked as held: fees ${r.bookedFees} + gas advances ${r.bookedAdvances} = ${n(r.bookedFees + r.bookedAdvances)} ${symbol}`);
  say();

  say(`Fee collections (${r.collections.length})`);
  if (!r.collections.length) say('  none - nothing has been swept out of this wallet yet');
  for (const c of r.collections) {
    say(`  ${when(c.createdAt)}  -${n(c.amount)} ${c.asset || symbol}  via ${c.via || '?'}  ${c.status || 'SENT'}  ${c.txHash ? String(c.txHash).slice(0, 14) : ''}`);
  }
  say(`  collected ${r.collected} ${symbol}`);
  say();

  say('Reconciliation');
  say(`  fees booked at withdrawal   ${r.bookedFees} ${symbol}`);
  say(`  gas advanced, charged back  ${r.bookedAdvances} ${symbol}`);
  if (r.forfeited) say(`  forfeited when closed       ${r.forfeited} ${symbol}`);
  say(`  less collected              ${r.collected} ${symbol}`);
  say(`  = expected held             ${r.expected} ${symbol}${usd(r.expected)}`);
  say(`    stored held              ${r.held} ${symbol}${usd(r.held)}`);
  if (Math.abs(r.drift) < 1e-8) {
    say('  the book agrees with the record.');
  } else if (r.drift > 0) {
    say(`  ** the record holds ${r.drift} ${symbol}${usd(r.drift)} MORE than the withdrawals account for.`);
    if (r.balance > 0 && r.held / r.balance > 2) {
      say(`     That is ${(r.held / r.balance).toFixed(1)}x what the wallet holds. A figure that size is a dollar`);
      say('     amount written into a figure counted in coin - the fee was divided by a price');
      say('     that had not loaded, and the fallback was 1.');
    }
    if (r.unreadable.length) {
      say(`     ${r.unreadable.length} withdrawal(s) here carry no fee in the coin - they predate the plan`);
      say('     recording one - so what they charged cannot be read back, and the figure above');
      say('     is only what the rest of the book accounts for. --audit leaves this wallet alone.');
    }
    say(`     Correct it with:  node scripts/collect-fees.js --set-held ${wallet.address} ${r.expected}${wallet.chain === symbol ? '' : ` --asset ${symbol}`} --yes`);
  } else {
    say(`  ** the record holds ${Math.abs(r.drift)} ${symbol} LESS than the withdrawals account for (already swept, or reconciled down).`);
  }
  say();
  if (r.held >= r.balance && r.balance > 0) {
    say(`Everything in this wallet is booked to the platform, which is why the merchant sees 0 ${symbol}.`);
  }
}

// ── which job ────────────────────────────────────────────────────────────
if (flag('--audit')) {
  audit();
} else if (!query) {
  say('Usage:');
  say('  node scripts/explain-wallet.js <address or wallet id>   one wallet, in full');
  say('  node scripts/explain-wallet.js --audit [--yes]          every wallet whose held fee does not add up');
  process.exit(1);
} else {
  const wallets = db.getAll('wallets');
  const wallet = wallets.find((w) => w.id === query)
    || wallets.find((w) => String(w.address).toLowerCase() === query.toLowerCase());
  if (!wallet) {
    say(`No wallet matches "${query}".`);
    const near = wallets.filter((w) => String(w.address).toLowerCase().includes(query.toLowerCase().slice(0, 6)));
    if (near.length) say(`Close: ${near.slice(0, 5).map((w) => `${w.chain} ${w.address}`).join(', ')}`);
    process.exit(1);
  }
  explain(wallet);
}
