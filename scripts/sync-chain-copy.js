#!/usr/bin/env node
/**
 * Bring every page's chain copy in line with the registry.
 *
 * The landing page, the about page, the docs, the help centre, the API
 * reference and the FAQ all state how many chains there are, name the ones
 * added since the founding ten, and two of them carry a table with a row
 * per chain. Typed by hand, those drifted ("ten chains" outlived ten chains
 * by a while). This regenerates all of it from src/config/chains.js, so the
 * copy is a function of the registry.
 *
 *   node scripts/sync-chain-copy.js          # rewrite the pages
 *   node scripts/sync-chain-copy.js --check  # exit 1 if anything would change
 *
 * scripts/add-chain.js runs it after adding a chain; tests pin the result.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const chains = require('../src/config/chains');

const PUBLIC = path.join(__dirname, '../public');
const CHECK = process.argv.includes('--check');

const list = chains.list();
const N = list.length;
const FOUNDING = ['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX', 'BTC', 'LTC', 'SOL'];
const added = list.filter((c) => !FOUNDING.includes(c.code));
// The chains added since the founding ten, by kind: the EVM ones came in by
// the importer; the others (Bitcoin Cash, Dogecoin) by hand, with a wallet
// service of their own.
const addedEvm = added.filter((c) => c.family === 'evm');
const addedOther = added.filter((c) => c.family !== 'evm');
const utxo = list.filter((c) => c.family === 'utxo');
const directOnly = list.filter((c) => !chains.swappable(c.code));
const onChain = list.filter((c) => chains.swappableOnChain(c.code));
const thor = list.filter((c) => chains.thorchainChain(c.code));
// how a chain's coin crosses chains, for the tables
const crossing = (c) => {
  const p = chains.crossChainProviders(c.code);
  if (p.length === 0) return 'direct only';
  return p.map((x) => (x === 'thorchain' ? 'THORChain' : 'SideShift')).join(' + ');
};

// A count as the copy may already state it: digits, or a word from before.
const COUNT = '(?:\\d+|[Tt]en|[Tt]welve|[Tt]wenty(?:-\\w+)?|[Tt]hirty(?:-\\w+)?|[Ff]orty(?:-\\w+)?|[Ff]ifty(?:-\\w+)?)';
const EM = '\\u2014';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const oxford = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** "~40 seconds (3 blocks)", from the registry's own figures. */
function waitFor(c) {
  if (c.code === 'BTC') return '~10 minutes (1 block)';
  if (c.code === 'LTC') return '~5 minutes (2 blocks)';
  if (c.code === 'SOL') return 'under a second';
  const secs = c.confirmations * c.blockTimeSec;
  if (secs < 1) return 'under a second';
  const blocks = `${c.confirmations} block${c.confirmations === 1 ? '' : 's'}`;
  if (secs < 5) return `a few seconds (${blocks})`;
  if (secs < 60) return `~${Math.round(secs)} seconds (${blocks})`;
  return `~${Math.round(secs / 60)} minute${Math.round(secs / 60) === 1 ? '' : 's'} (${blocks})`;
}

let changed = 0;
function rewrite(file, transform) {
  const full = path.join(PUBLIC, file);
  const before = fs.readFileSync(full, 'utf-8');
  const crlf = (before.match(/\r\n/g) || []).length;
  const nl = crlf > (before.match(/\n/g) || []).length - crlf ? '\r\n' : '\n';
  const after = transform(before, nl);
  if (after === before) return;
  changed += 1;
  if (CHECK) { process.stdout.write(`  would change ${file}\n`); return; }
  fs.writeFileSync(full, after);
  process.stdout.write(`  wrote ${file}\n`);
}

/** Replace exactly one match, or throw: drift has to be loud, not silent. */
function one(text, source, replacement, what) {
  const re = new RegExp(source, 'g');
  const matches = text.match(re) || [];
  if (matches.length !== 1) throw new Error(`${what}: expected one match, found ${matches.length}`);
  return text.replace(re, replacement);
}

// ── link previews, on every public page ──────────────────────────────────────
// The preview tags say "on N chains" wherever they count; every page gets
// the same pass, however many times (or few) it says it.
for (const page of ['index', 'about', 'docs', 'api-reference', 'faq', 'help', 'status', 'terms', 'privacy', 'compliance', 'auth', 'checkout']) {
  // only inside a meta tag's content: the FAQ counts other things in its body
  rewrite(`${page}.html`, (s) => s.replace(new RegExp(`(<meta [^>]*content="[^"]*?on )${COUNT}( chains)`, 'g'), `$1${N}$2`));
}

// ── landing ──────────────────────────────────────────────────────────────────
rewrite('index.html', (s) => {
  s = one(s, `supporting ${COUNT} networks including`, `supporting ${N} networks including`, 'landing meta');
  s = one(s, `Accept payments across ${COUNT} networks`, `Accept payments across ${N} networks`, 'landing hero');
  s = one(s, `${COUNT} chains behind one integration, confirmation`, `${N} chains behind one integration, confirmation`, 'landing settle lede');
  s = one(s, `<span class="live-line__item"><b>\\d+</b> networks</span>`, `<span class="live-line__item"><b>${N}</b> networks</span>`, 'landing live line');
  s = one(s, `${COUNT} networks behind one integration, and no documents`, `${N} networks behind one integration, and no documents`, 'landing closing');
  s = one(s, `Accept and pay out crypto across ${COUNT} networks`, `Accept and pay out crypto across ${N} networks`, 'landing footer');
  const chips = `<i>ETH</i><i>POL</i><i>BASE</i><i>ARB</i><i>OP</i><i>BNB</i><i>AVAX</i><i>BTC</i><i>LTC</i><i>SOL</i><i>USDC</i><i>USDT</i><i title="${esc(oxford(added.map((c) => c.name)))}">+${added.length} chains</i>`;
  s = one(s, `<i>ETH</i><i>POL</i><i>BASE</i><i>ARB</i><i>OP</i><i>BNB</i><i>AVAX</i><i>BTC</i><i>LTC</i><i>SOL</i>(?:<i>USDC</i><i>USDT</i><i title="[^"]*">\\+\\d+ chains</i>)?`, chips, 'landing chips');
  return s;
});

// ── about ────────────────────────────────────────────────────────────────────
rewrite('about.html', (s) => {
  s = one(s, `accepts crypto payments on ${COUNT} networks`, `accepts crypto payments on ${N} networks`, 'about meta');
  s = one(s, `<p>Accept on ${COUNT} networks and pay out`, `<p>Accept on ${N} networks and pay out`, 'about lede');
  s = one(s, `checkable in the repo: ${COUNT} chains in`, `checkable in the repo: ${N} chains in`, 'about comment');
  s = one(s, `<div data-reveal><b>\\d+</b><span>Networks, one integration</span></div>`, `<div data-reveal><b>${N}</b><span>Networks, one integration</span></div>`, 'about strip');
  s = one(s, `<h3>${COUNT} chains, one integration</h3>`, `<h3>${N} chains, one integration</h3>`, 'about rule');
  const others = addedOther.length ? `, plus ${oxford(addedOther.map((c) => c.name))}` : '';
  const body = `<p>Ethereum and its L2s, BNB Chain, Avalanche, Bitcoin, Litecoin and Solana &mdash; and ${addedEvm.length} more EVM networks, with USDC and USDT on every EVM chain${others} &mdash; behind one API`;
  s = one(s, `<p>Ethereum and its L2s, BNB Chain, Avalanche, Bitcoin, Litecoin and Solana(?: &mdash; and \\d+ more EVM networks, with USDC and USDT on every EVM chain(?:, plus [^&]*?)? &mdash;|,) behind one API`, body, 'about rule body');
  return s;
});

// ── docs ─────────────────────────────────────────────────────────────────────
rewrite('js/docs-content.js', (s, nl) => {
  s = one(s, `Accept payments across ${COUNT} chains, hold the fun`, `Accept payments across ${N} chains, hold the fun`, 'docs lead');
  s = one(s, `${COUNT} chains across (?:three|four) families\\. A chain is named`, `${N} chains across four families. A chain is named`, 'docs chains lede');
  // the table, whatever columns it had: from its head to the "] }," that closes it
  const headAt = s.search(/\{ type: 'table', head: \['Chain', 'Code', 'Coin'/);
  if (headAt === -1) throw new Error('docs chain table not found');
  const end = s.indexOf('] },', headAt);
  if (end === -1) throw new Error('docs chain table: no end');
  const rows = list.map((c) => `          ['${c.name}', '${c.code}', '${c.symbol}', '${chains.tokensOf(c.code).map((t) => t.symbol).join(', ') || EM}', '${chains.swappableOnChain(c.code) ? 'yes' : EM}', '${waitFor(c)}'],`).join(nl);
  const table = `{ type: 'table', head: ['Chain', 'Code', 'Coin', 'Dollar tokens', 'On-chain swaps', 'Typical confirmation wait'], rows: [${nl}${rows}${nl}        `;
  s = s.slice(0, headAt) + table + s.slice(end);
  const callout = `{ type: 'callout', tone: 'info', title: 'On-chain swaps', body: 'Available on ${onChain.length} chains: ${oxford(onChain.map((c) => c.name))}. A chain without one still pays a token out as that token.' },`;
  s = one(s, `\\{ type: 'callout', tone: 'info', title: 'On-chain swaps', body: '[^']*' \\},`, callout, 'docs on-chain callout');
  const thorCallout = `{ type: 'callout', tone: 'info', title: 'THORChain', body: 'Serves ${thor.length} of our chains: ${oxford(thor.map((c) => c.name))}, with the USDC and USDT on the EVM ones. Whether a chain is open right now is read live; a halted chain falls back to the fixed-rate swap.' },`;
  s = one(s, `\\{ type: 'callout', tone: 'info', title: 'THORChain', body: '[^']*' \\},`, thorCallout, 'docs thorchain callout');
  return s;
});

// ── help ─────────────────────────────────────────────────────────────────────
rewrite('js/help-content.js', (s) => {
  s = one(s, `Create receiving wallets across ${COUNT} blockchain networks`, `Create receiving wallets across ${N} blockchain networks`, 'help signed-in');
  const answer = `${N} networks across four families: Ethereum, Polygon, Base, Arbitrum, Optimism, BNB Chain and Avalanche, then ${oxford(addedEvm.map((c) => c.name))} (all EVM), plus ${oxford([...utxo.map((c) => c.name), 'Solana', 'the XRP Ledger'])}. Every EVM chain also takes USDC and USDT. The dashboard and the API read the live list from <code>GET /api/chains</code>, so it never falls out of step with what the server offers.`;
  s = one(s, `\\{ q: 'Which blockchain networks are supported\\?', a: '[^']*' \\}`, `{ q: 'Which blockchain networks are supported?', a: '${answer.replace(/'/g, "\\'")}' }`, 'help networks answer');
  const tokens = `Yes. A dollar token is swept like the coin: paid out as itself to an address on its chain, swapped on its chain for the coin, or converted across chains where the swap provider takes it. You can also ask to be paid in USDC or USDT on a chain that carries them, and the coin you hold there is swapped on-chain into it. On-chain swaps run on ${onChain.length} chains (${oxford(onChain.map((c) => c.name))}); elsewhere a token is paid out as itself. Gas is always the chain\\'s coin, so a wallet holding USDC but no ETH needs a few cents of ETH before the USDC can move; the review says so.`;
  s = one(s, `\\{ q: 'Can I withdraw USDC or USDT\\?', a: '(?:[^'\\\\]|\\\\.)*' \\}`, `{ q: 'Can I withdraw USDC or USDT?', a: '${tokens}' }`, 'help tokens answer');
  const custody = `Not when THORChain serves both ends. ${oxford(thor.map((c) => c.name))} and the USDC and USDT on the EVM ones travel through THORChain: a decentralised network of vaults that swaps native coins with nothing wrapped and no account. Your wallet pays the vault with a memo naming what you want and where; the memo carries a floor, so a swap that moves too far is refunded rather than settled short. Other pairs go through a fixed-rate swap provider, which holds the funds only while the shift runs.`;
  s = one(s, `\\{ q: 'Does a cross-chain withdrawal go through a custodian\\?', a: '(?:[^'\\\\]|\\\\.)*' \\}`, `{ q: 'Does a cross-chain withdrawal go through a custodian?', a: '${custody}' }`, 'help custody answer');
  return s;
});

// ── API reference ────────────────────────────────────────────────────────────
rewrite('js/api-spec.js', (s, nl) => {
  s = one(s, `accept payments in ${COUNT} chains,`, `accept payments in ${N} chains,`, 'spec overview');
  s = one(s, `'${COUNT} chains are supported\\. A chain is identified`, `'${N} chains are supported. A chain is identified`, 'spec chains lede');
  // the table, whatever columns it had: its head line, then the rows up to the "]," that closes them
  const headMatch = /head: \['Code', 'Coin', 'Family'[^\]]*\],/.exec(s);
  if (!headMatch) throw new Error('spec chain table not found');
  const start = headMatch.index;
  const rowsAt = s.indexOf('rows: [', start);
  if (rowsAt === -1) throw new Error('spec chain table: no rows');
  const rowsStart = rowsAt + 'rows: ['.length;
  const closing = /\r?\n\s*\],/.exec(s.slice(rowsStart));
  if (!closing) throw new Error('spec chain table: no end');
  const rowsEnd = rowsStart + closing.index;
  const FAM = { evm: 'EVM', utxo: 'UTXO', solana: 'Solana', xrp: 'XRP Ledger' };
  const rows = list.map((c) => `          ['${c.code}', '${c.symbol}', '${FAM[c.family]}', '${c.confirmations}', '${chains.tokensOf(c.code).map((t) => t.symbol).join(', ') || EM}', '${c.walletPay ? 'yes' : 'no'}', '${crossing(c)}', '${chains.swappableOnChain(c.code) ? 'yes' : EM}'],`).join(nl);
  return s.slice(0, start) + "head: ['Code', 'Coin', 'Family', 'Confirmations', 'Dollar tokens', 'Wallet-pay', 'Cross-chain swaps', 'On-chain swaps']," + s.slice(start + headMatch[0].length, rowsStart) + nl + rows + s.slice(rowsEnd);
});

// ── FAQ: two answers, rebuilt whole so their search text follows ─────────────
const CHEV = '<svg class="qa__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
function dataText(question, answerHtml) {
  const text = (question + ' ' + answerHtml).replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return esc(text);
}
function item(anchor, question, answerHtml, nl) {
  return [
    `                <div class="qa" data-text="${dataText(question, answerHtml)}">`,
    `                    <button class="qa__q" type="button" aria-controls="${anchor}">`,
    `                        <h3>${question}</h3>${CHEV}`,
    '                    </button>',
    `                    <div class="qa__a" id="${anchor}"><div class="qa__inner">`,
    answerHtml.replace(/\n/g, nl),
    '                    </div></div>',
    '                </div>',
    '',
  ].join(nl);
}
rewrite('faq.html', (s, nl) => {
  const replaceItem = (qLower, nextLower, html) => {
    const start = s.indexOf(`                <div class="qa" data-text="${qLower}`);
    const end = s.indexOf(`                <div class="qa" data-text="${nextLower}`);
    if (start === -1 || end === -1) throw new Error(`faq: could not find "${qLower}"`);
    s = s.slice(0, start) + html + s.slice(end);
  };
  const support = `<p>${N} networks across four families, all behind one account and one API:</p>
                        <ul>
                            <li><strong>Ethereum (ETH)</strong> and its L2s <strong>Base</strong>, <strong>Arbitrum One</strong> and <strong>Optimism</strong> &mdash; the coin on all three L2s is ETH</li>
                            <li><strong>Polygon (POL)</strong>, <strong>BNB Chain (BNB)</strong> and <strong>Avalanche (AVAX)</strong></li>
                            <li>${addedEvm.length} more EVM networks: ${oxford(addedEvm.map((c) => esc(c.name)))}</li>
                            <li>${oxford(utxo.map((c) => `<strong>${esc(c.name)} (${esc(c.symbol)})</strong>`))}</li>
                            <li><strong>Solana (SOL)</strong> and the <strong>XRP Ledger (XRP)</strong></li>
                        </ul>
                        <p>Each chain pays in its own native coin: a wallet on Base receives ETH, a wallet on BNB Chain receives BNB. On every EVM chain a wallet also takes that chain&#x27;s dollar tokens &mdash; <strong>USDC and USDT</strong> &mdash; and your customer picks which to send on the payment page. Every chain takes payments, has an address you can generate from the dashboard, and can be withdrawn from. The live list, with confirmation thresholds and explorer links, is at <code>GET /api/chains</code>.</p>`;
  const withdraw = `<p>The coin of any of the ${N} chains we support, and the USDC and USDT on the EVM ones, into whichever chain and asset you like: a chain&#x27;s coin, or USDC or USDT on a chain that carries them.</p>
                        <p>A withdrawal sweeps everything you have received &mdash; each wallet&#x27;s coin and any dollar tokens it holds &mdash; into one destination address. A holding that is already the asset you asked for, on that chain, is sent directly with no swap. A holding on that chain in another asset (USDC when you asked for ETH, or the reverse) is swapped on the chain itself, through a router contract your wallet calls directly: no custodian, no account, and the swap reverts rather than settling short if the price moves. That runs on ${onChain.length} chains: ${oxford(onChain.map((c) => esc(c.name)))}. Anything on another chain crosses through <strong>THORChain</strong> where it serves both ends &mdash; ${oxford(thor.map((c) => esc(c.name)))}, and the USDC and USDT on the EVM ones: your wallet pays the network&#x27;s vault with a memo and the network pays you, nothing wrapped and no custodian &mdash; or otherwise at a fixed rate that is quoted on the review screen before you confirm, so the figure you see is the figure that arrives. Both are quoted where both exist and the one that pays more wins. ${directOnly.length} of the newer chains (${oxford(directOnly.map((c) => esc(c.name)))}) have no cross-chain route yet, so they pay out on their own chain only.</p>
                        <p>Gas is always the chain&#x27;s coin: a wallet holding USDC but no ETH needs a few cents of ETH before the USDC can move, and the review says so.</p>`;
  replaceItem('which chains and coins do you support?', 'which cryptocurrencies can i withdraw?', item('faq-a18', 'Which chains and coins do you support?', support, nl));
  replaceItem('which cryptocurrencies can i withdraw?', 'what are the fees?', item('faq-a5', 'Which cryptocurrencies can I withdraw?', withdraw, nl));
  return s;
});

if (CHECK) {
  process.stdout.write(changed ? `${changed} file(s) out of step with the registry; run scripts/sync-chain-copy.js\n` : 'copy is in step with the registry\n');
  process.exit(changed ? 1 : 0);
}
process.stdout.write(`${N} chains, ${added.length} beyond the founding ten (${addedEvm.length} EVM, ${addedOther.length} other), ${directOnly.length} direct-only, ${onChain.length} with on-chain swaps, ${thor.length} on THORChain · ${changed ? `${changed} file(s) rewritten` : 'nothing to change'}\n`);
