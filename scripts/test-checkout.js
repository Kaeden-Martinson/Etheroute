/**
 * Checkout flow integration test
 * Run:  node scripts/test-checkout.js
 * Requires the server to be running on PORT (default 3000).
 */

'use strict';

const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL  = `http://localhost:${process.env.PORT || 3000}`;
// Never hardcode a live credential in a file that can be committed.
const API_KEY   = process.env.ETHEROUTE_API_KEY;
const WALLET_ID = process.env.ETHEROUTE_WALLET_ID;

// The address that will act as the simulated buyer (the "from" address)
// Change this to any valid ETH address you want to test with
const BUYER_ADDRESS = '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e';

const SUCCESS_URL  = 'https://example.com/payment/success';
const FAILURE_URL  = 'https://example.com/payment/failure';
// Use ONE of these per run — the other should be undefined/removed
const USD_AMOUNT    = .50;   // $5.00 USD  → server converts to native
const NATIVE_AMOUNT = undefined; // e.g. 0.001 ETH (set to override USD_AMOUNT)

if (!API_KEY || !WALLET_ID) {
  console.error('');
  console.error('Set both of these before running:');
  console.error('');
  console.error('  ETHEROUTE_API_KEY=<your key> ETHEROUTE_WALLET_ID=<a wallet id> node scripts/test-checkout.js');
  console.error('');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: process.env.PORT || 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function log(label, data) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(50));
  console.log(JSON.stringify(data, null, 2));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Etheroute Checkout — Integration Test');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  Wallet   : ${WALLET_ID}`);
  console.log(`  Buyer    : ${BUYER_ADDRESS}`);
  console.log(NATIVE_AMOUNT !== undefined
    ? `  Amount   : ${NATIVE_AMOUNT} (native)`
    : `  Amount   : $${USD_AMOUNT} USD`);

  // ── 1. Create checkout session ─────────────────────────────────────────────
  console.log('\n[1/5] Creating checkout session...');
  const createBody = {
    walletId: WALLET_ID,
    successRoute: SUCCESS_URL,
    failureRoute: FAILURE_URL,
    ...(NATIVE_AMOUNT !== undefined ? { nativeAmount: NATIVE_AMOUNT } : { usdAmount: USD_AMOUNT }),
  };
  const create = await request(
    'POST',
    '/api/checkout/create',
    createBody,
    { Authorization: `Bearer ${API_KEY}` }
  );
  log('POST /api/checkout/create', { status: create.status, ...create.body });

  if (create.status !== 201) {
    console.error('\n✗ Session creation failed. Is the server running and the wallet/API key valid?');
    process.exit(1);
  }

  const { sessionId, checkoutUrl, expiresAt } = create.body;
  console.log(`\n  ✓ Session ID  : ${sessionId}`);
  console.log(`  ✓ Checkout    : ${checkoutUrl}`);
  console.log(`  ✓ Native amt  : ${create.body.nativeAmount} ${create.body.chain}`);
  console.log(`  ✓ USD amt     : $${create.body.usdAmount}`);
  console.log(`  ✓ Expires at  : ${expiresAt}`);

  // ── 2. Fetch public session details ───────────────────────────────────────
  console.log('\n[2/5] Fetching public session details...');
  const sessionInfo = await request('GET', `/api/checkout/session/${sessionId}`);
  log('GET /api/checkout/session/:id', { status: sessionInfo.status, ...sessionInfo.body });

  if (sessionInfo.status !== 200) {
    console.error('\n✗ Could not fetch session details.');
    process.exit(1);
  }
  console.log(`  ✓ Status  : ${sessionInfo.body.status}`);
  console.log(`  ✓ Chain   : ${sessionInfo.body.chain}`);
  console.log(`  ✓ Address : ${sessionInfo.body.walletAddress}`);

  // ── 3. Check status before wallet submission ──────────────────────────────
  console.log('\n[3/5] Polling status (should be PENDING)...');
  const statusBefore = await request('GET', `/api/checkout/status/${sessionId}`);
  log('GET /api/checkout/status/:id (before submit)', { status: statusBefore.status, ...statusBefore.body });

//   // ── 4. Submit buyer wallet address ────────────────────────────────────────
//   console.log(`\n[4/5] Submitting buyer address (${BUYER_ADDRESS})...`);
//   const submit = await request(
//     'POST',
//     '/api/checkout/submit-wallet',
//     { sessionId, clientWalletAddress: BUYER_ADDRESS }
//   );
//   log('POST /api/checkout/submit-wallet', { status: submit.status, ...submit.body });

//   if (submit.status !== 200) {
//     console.error('\n✗ Wallet submission failed.');
//     process.exit(1);
//   }
//   console.log(`  ✓ Status updated to: ${submit.body.status}`);

  // ── 5. Poll status (watching for payment) ─────────────────────────────────
  console.log('\n[5/5] Polling status 3× (2 s apart) — expecting AWAITING_PAYMENT...');
  for (let i = 1; i <= 3; i++) {
    await sleep(2000);
    const poll = await request('GET', `/api/checkout/status/${sessionId}`);
    console.log(`\n  Poll ${i}/3  →  status: ${poll.body.status ?? '?'}`);
    if (['PAID', 'INSUFFICIENT', 'EXPIRED'].includes(poll.body.status)) {
      log(`Terminal state reached on poll ${i}`, poll.body);
      if (poll.body.redirectUrl) {
        console.log(`\n  ✓ Redirect URL: ${poll.body.redirectUrl}`);
      }
      break;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('  All test steps completed successfully.');
  console.log(`  Open the checkout page to complete manually:`);
  console.log(`  ${checkoutUrl}`);
  console.log('══════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('\n✗ Unexpected error:', err.message);
  process.exit(1);
});
