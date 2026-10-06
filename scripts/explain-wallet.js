#!/usr/bin/env node
/**
 * Where a wallet's held fee came from.
 *
 *   node scripts/explain-wallet.js 0x8462Dc…50df6E
 *   node scripts/explain-wallet.js <wallet id>
 *
 * "Held for fees" on the dashboard is `serviceSubtractions`: the platform's
 * money that is still sitting at the merchant's address, waiting for the
 * sweep. It is shown capped at what the wallet actually holds, so a figure
 * that equals the whole balance means the book says the platform is owed at
 * least everything there - and that is usually the thing worth explaining.
 *
 * This reads the books and replays how the figure got there: every payment
 * in, every withdrawal that booked a fee (and the gas the float advanced,
 * which is charged back the same way), every sweep that took one out, and
 * what closing the wallet forfeited. It then compares the sum with the
 * stored figure, so a mismatch - a fee booked twice, a sweep that never
 * reduced it - shows up as a line rather than a feeling.
 *
 * Read-only: safe to run against production while the server is up.
 */
'use strict';

const { validate } = require('../src/config/env');
validate();

const { db } = require('../src/config/database');
const chains = require('../src/config/chains');
const PriceService = require('../src/services/PriceService');

const say = (line = '') => process.stdout.write(`${line}\n`);
const n = (v, places = 8) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(places)) : 0);
const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');

const query = process.argv[2];
if (!query) {
  say('Usage: node scripts/explain-wallet.js <address or wallet id>');
  process.exit(1);
}

const wallets = db.getAll('wallets');
const wallet = wallets.find((w) => w.id === query)
  || wallets.find((w) => String(w.address).toLowerCase() === query.toLowerCase());

if (!wallet) {
  say(`No wallet matches "${query}".`);
  const near = wallets.filter((w) => String(w.address).toLowerCase().includes(query.toLowerCase().slice(0, 6)));
  if (near.length) say(`Close: ${near.slice(0, 5).map((w) => `${w.chain} ${w.address}`).join(', ')}`);
  process.exit(1);
}

const symbol = chains.has(wallet.chain) ? chains.get(wallet.chain).symbol : wallet.chain;
const rate = PriceService.rateFor(wallet.chain) || 0;
const usd = (amount) => (rate > 0 ? ` ($${(amount * rate).toFixed(2)})` : '');

const balance = n(wallet.balance);
const held = n(wallet.serviceSubtractions);
const shownHeld = Math.min(held, balance);
const available = Math.max(0, balance - shownHeld);

say(`${wallet.chain} ${wallet.address}`);
say(`  wallet id      ${wallet.id}`);
say(`  client         ${wallet.clientId}`);
say(`  label          ${wallet.label || '(unnamed)'}`);
say(`  state          ${wallet.isActive === false ? `CLOSED ${when(wallet.closedAt)} by ${wallet.closedBy || '?'}` : 'active'}`);
say(`  created        ${when(wallet.createdAt)}`);
say(`  last read      ${when(wallet.lastUpdated || wallet.updatedAt)}`);
say();
say('As the dashboard shows it');
say(`  balance stored ${balance} ${symbol}${usd(balance)}`);
say(`  held for fees  ${shownHeld} ${symbol}${usd(shownHeld)}${held > balance ? `   (book says ${held}, capped at the balance)` : ''}`);
say(`  withdrawable   ${available} ${symbol}${usd(available)}`);
for (const [sym, amount] of Object.entries(wallet.serviceSubtractionsTokens || {})) {
  say(`  held ${sym.padEnd(9)} ${n(amount)} of ${n((wallet.tokenBalances || {})[sym])} on hand`);
}
if (wallet.forfeited) {
  say(`  forfeited on close: ${n(wallet.forfeited.coin)} ${symbol}${Object.keys(wallet.forfeited.tokens || {}).length ? `, ${JSON.stringify(wallet.forfeited.tokens)}` : ''}`);
}
say();

// ── what came in ─────────────────────────────────────────────────────────
const deposits = db.getAll('transactions')
  .filter((t) => t.type === 'DEPOSIT' && String(t.toAddress || '').toLowerCase() === wallet.address.toLowerCase())
  .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

say(`Payments in (${deposits.length})`);
if (!deposits.length) say('  none recorded');
for (const d of deposits) {
  say(`  ${when(d.createdAt)}  +${n(d.nativeAmount)} ${d.asset || symbol}${d.usdAmount ? ` ($${Number(d.usdAmount).toFixed(2)})` : ''}  ${d.status}  ${d.sessionId ? `session ${String(d.sessionId).slice(0, 8)}` : ''}`);
}
const paidIn = deposits.filter((d) => (d.asset || symbol) === symbol).reduce((sum, d) => sum + n(d.nativeAmount), 0);
say(`  total in ${n(paidIn)} ${symbol}${usd(paidIn)}`);
say();

// ── what booked a fee ────────────────────────────────────────────────────
const booked = [];
for (const payout of db.getAll('payouts')) {
  const transfers = (payout.withdrawalPlan && payout.withdrawalPlan.transfers) || [];
  for (const t of transfers) {
    if (String(t.fromAddress || '').toLowerCase() !== wallet.address.toLowerCase()) continue;
    booked.push({ payout, t });
  }
}
booked.sort((a, b) => new Date(a.payout.createdAt) - new Date(b.payout.createdAt));

say(`Withdrawals from this wallet (${booked.length})`);
if (!booked.length) say('  none - so nothing should have booked a fee here');
let bookedFees = 0;
let bookedAdvances = 0;
for (const { payout, t } of booked) {
  const fee = n(t.platformFeeNative);
  const advance = n(t.gasTopUp && t.gasTopUp.chargedInAsset);
  const rode = Boolean(t.feeOutput && t.feeOutput.amount > 0);
  // only a broadcast leg books a fee, and only when it did not ride along
  const counts = Boolean(t.txHash) && !rode;
  if (counts && (t.asset || symbol) === symbol) { bookedFees += fee; bookedAdvances += advance; }
  say(`  ${when(payout.createdAt)}  payout ${String(payout.id).slice(0, 8)}  ${t.status || payout.status}  sent ${n(t.nativeAmount)} ${t.asset || symbol} -> ${t.payoutChain}/${t.payoutAsset || ''}`);
  say(`      fee ${fee} ${t.asset || symbol}${advance ? `  + gas advanced ${advance}` : ''}  ${rode ? 'rode in the transaction (collected, not held)' : counts ? 'held in the wallet' : 'not broadcast - books nothing'}`);
  if (t.txHash) say(`      tx ${t.txHash}`);
}
say(`  booked as held: fees ${n(bookedFees)} + gas advances ${n(bookedAdvances)} = ${n(bookedFees + bookedAdvances)} ${symbol}`);
say();

// ── what the sweep took back out ─────────────────────────────────────────
const collections = db.getAll('feeCollections').filter((c) => c.walletId === wallet.id || String(c.fromAddress || '').toLowerCase() === wallet.address.toLowerCase());
say(`Fee collections (${collections.length})`);
if (!collections.length) say('  none - nothing has been swept out of this wallet yet');
let collected = 0;
for (const c of collections) {
  if ((c.asset || symbol) === symbol && c.status !== 'FAILED') collected += n(c.amount);
  say(`  ${when(c.createdAt)}  -${n(c.amount)} ${c.asset || symbol}  via ${c.via || '?'}  ${c.status || 'SENT'}  ${c.txHash ? String(c.txHash).slice(0, 14) : ''}`);
}
say(`  collected ${n(collected)} ${symbol}`);
say();

// ── does the book add up? ────────────────────────────────────────────────
const forfeited = wallet.isActive === false ? n(wallet.forfeited && wallet.forfeited.coin) : 0;
const expected = Math.max(0, n(bookedFees + bookedAdvances + forfeited - collected));
say('Reconciliation');
say(`  fees booked at withdrawal   ${n(bookedFees)} ${symbol}`);
say(`  gas advanced, charged back  ${n(bookedAdvances)} ${symbol}`);
if (forfeited) say(`  forfeited when closed       ${forfeited} ${symbol}`);
say(`  less collected              ${n(collected)} ${symbol}`);
say(`  = expected held             ${expected} ${symbol}${usd(expected)}`);
say(`    stored held              ${held} ${symbol}${usd(held)}`);
const drift = n(held - expected);
if (Math.abs(drift) < 1e-8) {
  say('  the book agrees with the record.');
} else if (drift > 0) {
  say(`  ** the record holds ${drift} ${symbol}${usd(drift)} MORE than the withdrawals account for.`);
  say('     Something booked a fee the plans do not explain: a fee recorded twice for one');
  say('     transfer, a closure that forfeited a balance, or a figure carried over from');
  say('     before fees were recorded exactly. scripts/collect-fees.js --reconcile caps');
  say('     held figures at what each wallet holds, but it will not lower a wrong one');
  say('     below that; fixing this one means setting serviceSubtractions by hand.');
} else {
  say(`  ** the record holds ${Math.abs(drift)} ${symbol} LESS than the withdrawals account for (already swept, or reconciled down).`);
}
say();
if (held >= balance && balance > 0) {
  say(`Everything in this wallet is booked to the platform, which is why the merchant sees 0 ${symbol}.`);
}
