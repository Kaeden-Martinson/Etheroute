/**
 * provision-accounts.js
 *
 * Automatically creates Sideshift accounts via POST /api/v2/create-account,
 * routing each request through the corresponding proxy from proxies/proxies.json,
 * then registers the result in data/accounts.json via SideshiftAccountService.
 *
 * Rate: 3 account creations per minute (20 s gap between each request).
 *
 * Usage:
 *   node scripts/provision-accounts.js              # provision unprovisioned proxies
 *   node scripts/provision-accounts.js --count 5    # create 5 accounts on available proxies (round-robin)
 *   node scripts/provision-accounts.js --force      # re-provision proxies that already have an account
 *   node scripts/provision-accounts.js --status     # print current account roster and exit
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const sideshiftAccountService = require('../src/services/SideshiftAccountService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const STATUS_ONLY = args.includes('--status');

const countArg = args.indexOf('--count');
const EXPLICIT_COUNT = countArg !== -1 ? parseInt(args[countArg + 1], 10) : null;

const RATE_DELAY_MS = 250; // 4 per second = 250 ms between requests

function buildProxyUrl({ username, password, ip, port }) {
  return `http://${username}:${password}@${ip}:${port}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printTable(rows) {
  if (!rows.length) { console.log('  (none)'); return; }
  const headers = Object.keys(rows[0]);
  const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)));
  const line = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmt = row => headers.map((h, i) => ` ${String(row[h] ?? '').padEnd(widths[i])} `).join('|');
  console.log(line);
  console.log(fmt(Object.fromEntries(headers.map(h => [h, h]))));
  console.log(line);
  rows.forEach(r => console.log(fmt(r)));
  console.log(line);
}

async function createSideshiftAccount(proxyUrl) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const response = await fetch('https://sideshift.ai/api/v2/create-account', {
    method: 'POST',
    agent,
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();

  // Response shape: { id: "YQMi62XMb", secret: "2d880aab..." }
  if (!data.id || !data.secret) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(data)}`);
  }

  return { affiliateId: data.id, secret: data.secret };
}

// ---------------------------------------------------------------------------
// --status mode
// ---------------------------------------------------------------------------

if (STATUS_ONLY) {
  const status = sideshiftAccountService.getStatus();
  if (!status.length) {
    console.log('No accounts configured in data/accounts.json');
    process.exit(0);
  }
  console.log('\nCurrent Sideshift account status:\n');
  printTable(status.map(s => ({
    id: s.id,
    active: s.active,
    proxy: s.proxyUrl.replace(/\/\/.+@/, '//***@'),
    totalRequests: s.requestCount,
    quotesInWindow: s.windowUsage.quotes,
    shiftsInWindow: s.windowUsage.shifts,
    lastUsed: s.lastUsed ?? 'never',
  })));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main provisioning flow
// ---------------------------------------------------------------------------

async function main() {
  const proxiesFile = path.join(__dirname, '../proxies/proxies.json');
  if (!fs.existsSync(proxiesFile)) {
    console.error('proxies/proxies.json not found — nothing to provision.');
    process.exit(1);
  }

  const proxies = JSON.parse(fs.readFileSync(proxiesFile, 'utf-8'));
  if (!proxies.length) {
    console.log('No proxies found in proxies/proxies.json.');
    process.exit(0);
  }

  // Build list of (proxyUrl, index) pairs to work through
  let queue;

  if (EXPLICIT_COUNT !== null) {
    // --count N: round-robin across all proxies for N total accounts
    if (isNaN(EXPLICIT_COUNT) || EXPLICIT_COUNT < 1) {
      console.error('--count must be a positive integer');
      process.exit(1);
    }
    queue = Array.from({ length: EXPLICIT_COUNT }, (_, i) => proxies[i % proxies.length]);
    console.log(`\nCreating ${EXPLICIT_COUNT} account(s) across ${proxies.length} proxy/proxies (round-robin).\n`);
  } else {
    // Default: one account per unprovisioned proxy
    const existing = sideshiftAccountService.getStatus().map(s => s.proxyUrl);
    queue = proxies.filter(p => {
      const url = buildProxyUrl(p);
      const alreadyHas = existing.includes(url);
      if (alreadyHas && !FORCE) {
        console.log(`  [skip] ${url.replace(/\/\/.+@/, '//***@')} — already provisioned (use --force to add another)`);
      }
      return !alreadyHas || FORCE;
    });

    if (!queue.length) {
      console.log('\nAll proxies are already provisioned. Run with --status to inspect.');
      process.exit(0);
    }
    console.log(`\nProvisioning ${queue.length} proxy/account pair(s).\n`);
  }

  console.log(`Rate limit: 3 accounts/min — waiting ${RATE_DELAY_MS / 1000} s between requests.\n`);

  let created = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const proxy = queue[i];
    const proxyUrl = buildProxyUrl(proxy);
    const maskedUrl = proxyUrl.replace(/\/\/.+@/, '//***@');

    console.log(`[${i + 1}/${queue.length}] Creating account via ${maskedUrl} ...`);

    try {
      const { affiliateId, secret } = await createSideshiftAccount(proxyUrl);
      const account = sideshiftAccountService.addAccount({ affiliateId, secret, proxyUrl });
      console.log(`  [ok] affiliateId="${affiliateId}"  →  registered as "${account.id}"\n`);
      created++;
    } catch (err) {
      console.error(`  [fail] ${err.message}\n`);
      failed++;
    }

    // Respect the 3/min rate limit — no delay needed after the last request
    if (i < queue.length - 1) {
      console.log(`  Waiting ${RATE_DELAY_MS / 1000} s before next request...`);
      await sleep(RATE_DELAY_MS);
    }
  }

  console.log(`\nDone. ${created} created, ${failed} failed.\n`);
  console.log('Current account roster:\n');
  printTable(sideshiftAccountService.getStatus().map(s => ({
    id: s.id,
    active: s.active,
    proxy: s.proxyUrl.replace(/\/\/.+@/, '//***@'),
    affiliateId: s.affiliateId,
    totalRequests: s.requestCount,
    lastUsed: s.lastUsed ?? 'never',
  })));
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
