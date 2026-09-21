# Deployment runbook

Operational guide for running Etheroute in production. Read the whole of
**Before first deploy** — some of it is not optional.

---

## Before first deploy

### 1. The keys in git history are public

Every wallet private key and seed phrase was committed to `data/database.json`
across three commits, and 96 SideShift secrets plus 101 proxy credentials were
committed in `data/accounts.json` and `proxies/proxies.json`.

Encrypting the database (already done) does not undo this. Anyone who has ever
cloned, forked, or backed up this repository still holds the old plaintext.

**Nothing below matters until this is handled:**

```bash
# 1. Generate replacement wallets and sweep every balance into them.
#    Do this first — the old addresses are compromised, not at risk of becoming so.

# 2. Rotate all 96 SideShift affiliate secrets in the SideShift dashboard.

# 3. Rotate the proxy credentials with your proxy provider.

# 4. Purge the files from git history and force-push.
pip install git-filter-repo
git filter-repo --path data/ --path proxies/ --invert-paths --force
git push origin --force --all
git push origin --force --tags
```

Every collaborator must re-clone after the force-push. Old clones still contain
the secrets.

### 2. Rotate every API key

Existing keys were generated with `Math.random()`, which is predictable. The
migration hashed them so they keep working, but they are not safe.

Each customer should call `POST /api/api-keys/generate` and store the returned
key. It is displayed exactly once.

### 3. Set the environment

Copy `.env.example` to `.env` and fill it in. The app refuses to boot in
production if a required secret is missing, under 32 characters, or set to a
known placeholder.

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # KEY_ENCRYPTION_KEY
```

**`KEY_ENCRYPTION_KEY` decrypts every wallet signing key.** Lose it and the
funds at those addresses are unrecoverable. Store it in a secrets manager
(AWS Secrets Manager, GCP Secret Manager, Vault) — not in a file, not in the
repo, not only on one machine. Keep an offline backup.

Set `TRUST_PROXY=true` only when actually behind a load balancer. Enabling it
without a proxy in front lets clients spoof their own IP via `X-Forwarded-For`
and bypass rate limits.

### 4. Run the migration

```bash
npm run migrate:dry   # review
npm run migrate       # apply — writes a timestamped backup first
```

Idempotent, so it is safe to re-run.

---

## Running

```bash
npm install --omit=dev
npm start
```

| Endpoint  | Purpose                                                       |
|-----------|---------------------------------------------------------------|
| `/healthz` | Liveness. Returns 200 whenever the process is up.            |
| `/readyz`  | Readiness. 503 until price data has loaded and is fresh, and an Ethereum RPC answers — the body says which. Keep the instance out of the load balancer pool until it returns 200. |

`SIGTERM` and `SIGINT` drain in-flight requests before exiting, with a 15-second
cap. Give your orchestrator at least 20 seconds of termination grace.

### Single instance only

State lives in one SQLite file (`database.sqlite`, write-ahead log, every
commit flushed), so a crash cannot corrupt it. Payout monitors, rate limits and
the balance sweep are in-process state, so run exactly one instance. Do not
scale horizontally, and do not run a second copy against the same `DATA_DIR`.
Requires Node 22.13 or newer for the built-in SQLite driver.

The first start after upgrading from a build that kept `database.json` imports
that file into `database.sqlite` and logs the count. The JSON file is not read
again; keep it until you have a snapshot you trust, then delete it.

### Back up `data/`

The directory holds the encrypted keys, the ledger, and every customer record.
Back it up on a schedule, and store the backups somewhere the
`KEY_ENCRYPTION_KEY` is *not*, so one compromise does not yield both.

The server writes its own timestamped snapshots to `<DATA_DIR>/backups` (daily
by default, keeping the last `BACKUP_KEEP=14`), each a consistent compacted copy
taken through SQLite while the server keeps running. These are for
*point-in-time* recovery — a bad migration, an accidental delete — and are
**not** a substitute for off-box backups, since they sit next to the live data.
Copy the snapshots off the box, not the live file: a plain copy of
`database.sqlite` misses what is still in its `-wal` log. To roll back:

```bash
node scripts/restore.js            # list available snapshots
node scripts/restore.js --latest   # restore the newest (stop the server first)
```

A restore snapshots the current database to `database.pre-restore.<ts>.sqlite`
first, so it is itself reversible. Snapshots from before the SQLite store
(`database-<stamp>.json`) restore too.

### Alerting

Set `ALERT_WEBHOOK_URL` to a Slack/Discord incoming webhook (or your own
endpoint) and unexpected 5xx errors and process crashes are POSTed to it, so a
money-path failure pages someone instead of waiting in the logs. Identical
alerts are de-duped for `ALERT_COOLDOWN_MS`. Unset, it is a no-op.

### TLS, process manager, CI

`deploy/` has ready-to-adapt configs: `nginx.conf` (TLS termination + reverse
proxy — pair with `certbot`), `etheroute.service` (hardened systemd unit), and
`ecosystem.config.js` (PM2). Run **one instance only** — the JSON datastore is
not safe for concurrent writers. `.github/workflows/ci.yml` runs the test suite
on every push and PR; keep `package-lock.json` committed so `npm ci` is
reproducible.

### Password recovery

There is no email channel, so a forgotten password is recovered with a one-time
recovery code shown once at sign-up (`POST /api/auth/reset-password`). Users can
regenerate the set from `POST /api/auth/recovery-codes`. Make sure your sign-up
UX tells people to save them — a lost password with no saved code means a lost
account.

---

## What runs in the background

A maintenance sweep runs every 60 seconds:

- **In-flight transfers** are re-checked against their own chain (or their
  SideShift order) and moved to CONFIRMED or FAILED. The payout pipeline only
  watches a transfer in-process for ten minutes; a Bitcoin confirmation, or a
  swap out of Bitcoin, routinely takes longer, and a restart loses the watcher.
  Transfers the window did not resolve are left PROCESSING and this sweep
  finishes them. They are **not** marked failed on timeout any more — that
  reported slow confirmations as lost money.
- **Stuck transactions** past `STUCK_TRANSACTION_MINUTES` are failed out —
  unless the sweep above has seen them pending on the network within the last
  two hours, in which case the funds are committed and the reaper leaves them.
- **Orphaned payouts** whose transfers all finished but whose status was never
  updated get reconciled.
- **Waiting checkout sessions** are checked against the chain, so a payment is
  noticed and the vendor's webhook fires even if the buyer closed the tab after
  paying. Each session is checked at most every 15 seconds, however many
  browsers are polling it.
- **Expired checkout sessions** are closed, sending `checkout.session.expired`.
- **Webhook retries** are dispatched with exponential backoff.
- **Idempotency keys** older than 24 hours are pruned, and usage rows older
  than `USAGE_RETENTION_DAYS` (30).

### Collecting the platform fee

A withdrawal keeps `PLATFORM_FEE_RATE` of what it sweeps. On Bitcoin, Litecoin,
Bitcoin Cash and Dogecoin that share leaves in the withdrawal's own transaction,
as a second output to your address; elsewhere a transfer has one recipient, so
the fee stays in the merchant's wallet (shown to them as `platformFeeHeld`, and
excluded from what they can withdraw) until it is worth a transaction of its
own. A daily sweep then sends each wallet's held fee to your address once it
clears `FEE_COLLECT_MIN_USD` (10) and `FEE_COLLECT_GAS_MULTIPLE` (20) times the
gas, one transaction per wallet, tokens as tokens. Set one address per family:

```
PLATFORM_FEE_ADDRESS_EVM=0x…      # every EVM chain
PLATFORM_FEE_ADDRESS_BTC=bc1…
PLATFORM_FEE_ADDRESS_LTC=…  PLATFORM_FEE_ADDRESS_BCH=…  PLATFORM_FEE_ADDRESS_DOGE=…
PLATFORM_FEE_ADDRESS_SOL=…  PLATFORM_FEE_ADDRESS_XRP=…
```

A family with no address keeps holding. Every collection is a `feeCollections`
row and, for a sweep, a `FEE_COLLECTION` transaction on the merchant's ledger,
watched to confirmation like any other; a sweep that fails on its chain is held
again. The book, a dry run, a sweep on demand:

```bash
node scripts/collect-fees.js              # held per wallet, collected per chain
node scripts/collect-fees.js --dry-run    # what a sweep would send, and why not the rest
node scripts/collect-fees.js --collect    # send it (add --chain ETH to limit)
node scripts/collect-fees.js --reconcile  # cap held figures at what the wallets hold
```

`--reconcile` is for figures recorded before fees were tracked exactly, which
can exceed what the wallet has; the sweep never sends more than the wallet can
spare after its gas reserve in any case.

### The owner panel

`/owner` is the platform as its operator sees it: every merchant with what
they hold and have moved, payouts and transfers across the platform, the
checkout links, the fee book with a dry run and a sweep button, usage, every
chain's health, and the process itself (what is configured, never the values).
It opens to an account flagged `owner` on the server, and only to a signed-in
session - never to an API key, however the account is flagged:

```bash
node scripts/owner.js grant <username>    # the flag is read on each request; no new login needed
node scripts/owner.js list
node scripts/owner.js revoke <username>
```

The dashboard shows an "Owner panel" link to owners alone. The API behind the
page is `/api/owner/*`; it returns no secret and is not part of the
integrator reference.

### Rate limits and the upstream APIs

Everything on-chain is read through free public services, and each of them
limits by source IP:

| Service | Used for | Limit (approx.) |
|---------|----------|-----------------|
| mempool.space / litecoinspace.org | BTC/LTC balances, history, UTXOs, fees, broadcast fallback | soft; bursts get 429 |
| api.mainnet-beta.solana.com | SOL balances, history, status, broadcast fallback | 100 req / 10 s, 40 per method |
| Etherscan v2 | incoming ETH payments (checkout) | 5 req / s, 100k / day per key |
| CoinGecko | prices, once a minute | ~10 / min keyless |
| SideShift | quotes and orders | 20 quotes, 5 shifts / min per account (96 accounts rotated) |
| gateway.tatum.io | LTC and SOL broadcast (primary) | works unauthenticated today; fallbacks exist |

The app protects those budgets in three places: a wallet's balance is re-read
at most every 30 seconds however often `/api/wallets/list` is called; a
checkout session is checked at most every 15 seconds however often its status
is polled; and `proxies/proxies.json`, when present, spreads the reads across
addresses (dead proxies are sidelined for ten minutes and the request goes
direct). Set `PROXY_MODE=off` to bypass the list.

The API's own limits are in `RATE_LIMIT_*`. They are two-layer: a per-IP
ceiling before authentication, and a per-account budget after it. **For a
partner integration**, the per-account figure is the one that matters — their
traffic is measured on their API key, not their address — and it is the one to
raise for them. Their `429` responses carry `RateLimit-*` headers (draft-7)
saying when to retry.

### Fee sizing on Bitcoin and Litecoin

The network fee is computed for the transaction actually being built — the
live sat/vB rate times the size for the number of inputs selected (68 vB each
on Bitcoin's SegWit wallets, 148 on Litecoin's legacy ones) — not a flat
one-input figure. Change below the dust limit is folded into the fee rather
than creating an output the network would reject. Inputs are selected largest
first, so a wallet that has accumulated many small deposits spends the fewest
of them.

### Solana rent

A Solana transfer that would leave the sender with a non-zero balance below
the rent-exempt minimum (~0.00089 SOL) is rejected by the runtime. The
withdrawal plan reserves at least that on SOL wallets regardless of the fee,
so small wallets no longer pass the preview and fail at broadcast.

---

## Integrating a partner

What to hand the other company, and what to set on your side:

1. **Issue them an API key** from the dashboard (`POST /api/api-keys/generate`).
   Keys are shown once, `ethr_`-prefixed, and hashed at rest. Everything they
   call goes `Authorization: Bearer ethr_...`.
2. **Set their budget.** `RATE_LIMIT_PER_CLIENT_PER_MINUTE` applies to every
   account; if they need more, raise it (it is per key, so this does not open
   the door for anyone else). The per-IP ceiling must stay above it.
3. **Webhook URL** must be public `https` — `localhost`, private ranges, the
   cloud metadata address and URLs with embedded credentials are refused at
   creation and again at delivery, and redirects are not followed. Give them
   the signing secret and the verification snippet below.
4. **Idempotency.** Withdrawals require an `Idempotency-Key` header. Tell them
   to generate one per intended withdrawal and reuse it on retry. A key whose
   first attempt died mid-request is released after five minutes.
5. **Concurrency.** One withdrawal at a time per account: a second request
   while one is being planned returns `409`. Wallets committed to a payout
   that has not finished are excluded from the next one.
6. **What they should poll.** `GET /api/checkout/sessions/:id` for a session,
   `GET /api/payouts/:id` for a payout. Payout statuses: `PENDING`,
   `PROCESSING`, `COMPLETED`, `PARTIAL`, `FAILED`. A payout can sit in
   `PROCESSING` for as long as the slowest chain takes — an hour is normal for
   Bitcoin — and that is not an error.
7. **Readiness.** `/readyz` returns 503 when prices are missing or stale
   (`PRICE_MAX_AGE_MINUTES`) or no Ethereum RPC answers, with the reason in the
   body. Point their health check, and your load balancer, at it.

---

## Checkout integration

### Creating a session

```bash
curl -X POST https://api.example.com/api/checkout/create \
  -H "Authorization: Bearer ethr_..." \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "<your wallet id>",
    "usdAmount": 25.00,
    "successRoute": "https://shop.example.com/thanks",
    "failureRoute": "https://shop.example.com/payment-failed",
    "webhookUrl": "https://shop.example.com/hooks/etheroute",
    "reference": "order-1234"
  }'
```

Send the buyer to the returned `checkoutUrl`. Pass either `usdAmount` or
`nativeAmount`, not both.

### Verifying the webhook

Deliveries carry `Etheroute-Signature: t=<unix>,v1=<hmac>`. The HMAC is
SHA-256 over `` `${t}.${rawBody}` `` using your client signing secret. Compare in
constant time and reject timestamps older than five minutes.

```js
const crypto = require('crypto');

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Verify against the **raw request body**, before any JSON parsing.

Events: `checkout.session.completed`, `checkout.session.underpaid`,
`checkout.session.expired`. Retried up to `WEBHOOK_MAX_ATTEMPTS` times with
backoff — make your handler idempotent.

### Do not trust the redirect alone

The success redirect carries `?session=...&status=PAID&token=...`. The token is
signed, but the safest check is a server-side call to
`GET /api/checkout/status/<sessionId>` before releasing goods. A redirect is a
browser navigation and a buyer can visit any URL they like.

### Managing links from the API

The dashboard's Checkout page is built on these; anything it does is available
programmatically.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/checkout/create` | Create a link. Returns `checkoutUrl`. |
| `GET /api/checkout/sessions` | List your links, newest first. Optional `status`, `limit`, `offset`. Includes counts by status and total USD collected. |
| `GET /api/checkout/sessions/:id` | One link in full, including the buyer's address and confirmation progress. |
| `POST /api/checkout/sessions/:id/cancel` | Expire an unpaid link. A paid link cannot be cancelled. |

```bash
curl https://api.example.com/api/checkout/sessions?status=PAID   -H "Authorization: Bearer ethr_..."
```

Sessions belonging to another account return 404 rather than 403 — the response
does not confirm that an id exists.

### Confirmation thresholds

Settlement waits for `CONFIRMATIONS_<CHAIN>` before reporting `PAID`. A session
sits in `VERIFYING` while a payment is seen but not yet deep enough — and also
when chain data is temporarily unreadable. **`VERIFYING` never means paid.**
Lower thresholds mean faster checkout and more reversal risk.

Depth on Bitcoin and Litecoin is counted from the chain tip, so any threshold
works. (Before this it was capped at one, which meant the default
`CONFIRMATIONS_LTC=2` could never be met and no LTC session ever settled.)

A `VERIFYING` session with a payment in sight is never expired. One with nothing
seen is given fifteen minutes past its deadline — long enough for a last-minute
payment to reach the explorer — and then expires.

---

## Front-end assets

The CSP allows scripts and styles from `'self'` only, and blocks inline
`onclick=` handlers (`script-src-attr 'none'`). Two consequences for anyone
editing the front end:

- **No inline handlers.** Use `data-on-click` / `data-on-submit` / `data-on-change`
  with an optional `data-arg`, `data-arg2`, `data-arg3`. `public/js/common/actions.js`
  binds them by delegation, so markup added at runtime works with no rebinding.
  `data-arg="@this"` passes the element and `@event` passes the event; with no
  `data-arg` the handler receives the event.

- **No CDN scripts.** Third-party libraries are bundled into
  `public/js/vendor`. A CDN script would execute on the dashboard origin, where
  the session token lives. Rebuild after upgrading chart.js or highlight.js:

  ```bash
  npm run build:vendor
  ```

### Theming

Colours come from `public/css/tokens.css`. Page stylesheets reference tokens
only — there are no hardcoded hexes left outside that file, which is what makes
a dark theme a matter of redefining a dozen variables.

Three theme states: `light`, `dark`, and `system` (follow the OS). The choice is
stored in `localStorage` and applied by `js/common/theme.js`, which **must stay
in `<head>` before the stylesheets** — loaded later the page paints light and
then flips.

Two rules when adding styles:

- `--ink` and `--surface` are a pair that swaps with the theme. A primary button
  is `background: var(--ink); color: var(--surface)`, which inverts correctly.
  Never set one from a token and the other from a literal.
- A section that is *deliberately* the inverse of the page — the footer, the
  closing call to action — uses `--inverse-surface` / `--inverse-ink`, which do
  **not** swap. Using `--ink` there gives dark text on a dark band in dark mode.

Canvas cannot read CSS variables, so the dashboard chart reads its palette at
render time via `readChartTheme()` and repaints on the `themechange` event.

### Motion

`data-reveal` fades an element in as it scrolls into view;
`data-reveal-delay="120"` staggers it. `js/common/reveal.js` drives this and is
deliberately defensive: anything already on screen is shown immediately, an
element scrolled past without intersecting is revealed anyway, and a 4-second
fallback reveals whatever is left. Content must never stay hidden because an
animation did not fire.

`prefers-reduced-motion: reduce` neutralises all of it to the finished state.


Both rules are enforced by `tests/frontend.test.js`, because a violation fails
silently in the browser rather than erroring on the server.

---

## Chains

Ten chains, described in one place: `src/config/chains.js`. Every part of the
system that needs to know something about a chain - address validation,
pricing, gas, status lookups, wallet services, SideShift asset names, checkout
URIs, confirmation defaults, the front ends - reads from that registry.
`GET /api/chains` publishes the public part of it for integrators.

| Code | Coin | Family | Checkout by hand | Wallet-pay |
|------|------|--------|------------------|------------|
| ETH  | ETH  | EVM    | yes (Etherscan)  | yes |
| POL  | POL  | EVM    | yes (Etherscan, Blockscout) | yes |
| BASE | ETH  | EVM    | yes (Blockscout) | yes |
| ARB  | ETH  | EVM    | yes (Etherscan)  | yes |
| OP   | ETH  | EVM    | yes (Blockscout) | yes |
| BNB  | BNB  | EVM    | **no** - no free transaction index | yes |
| AVAX | AVAX | EVM    | yes (Routescan)  | yes |
| BTC  | BTC  | UTXO   | yes (mempool.space) | no |
| LTC  | LTC  | UTXO   | yes (litecoinspace) | no |
| SOL  | SOL  | Solana | yes (RPC)        | no |

`code` is what the API speaks (`payoutChain`, `wallet.chain`); `symbol` is the
ticker shown next to amounts. They differ on the L2s, where the coin is still
ETH. Etherscan's free tier answers only for ETH, Polygon and Arbitrum; the
others use free Etherscan-compatible indexers. BNB Chain has none, so a manual
BNB payment cannot be attributed to its sender - the create-link form says so,
and wallet-pay (below) works there regardless.

### Adding a chain

An EVM chain is one registry entry: chain id, RPC list, a history source, the
explorer, the SideShift coin and network, and a CoinGecko id. Nothing else
changes; the EVM wallet service, RPC pool and every consumer pick it up. A new
signing family (Dogecoin, say) needs a wallet service as well - the UTXO one
takes network parameters, but there is no mempool.space-style API for those
coins, so a provider has to be chosen first.

### Wallet-pay on the checkout page

On any EVM chain, a customer with a browser wallet (MetaMask, Rabby, Coinbase
Wallet, Brave - anything exposing EIP-1193) can connect and pay in one click.
The page fills their address from the wallet, switches the wallet to the
session's chain (adding it if unknown), and sends the exact amount to the
merchant address; the wallet shows them the recipient and value before they
approve, and no key ever reaches the page. The transaction hash is reported
to `POST /api/checkout/tx-hint`, and settlement verifies **that transaction
over RPC** - sender, recipient, value, receipt - rather than waiting for an
explorer to index it. Nothing in the hint is trusted; a hash for a transaction
to someone else, from someone else, or reverted credits nothing.

## Payout chains

Clients cash out in any registered chain. `payoutChain` on
`POST /api/withdrawal` and `/api/withdrawal/preview` selects it; omitting it
means ETH, so integrations written before this keep working unchanged.

Two routes exist per wallet, chosen automatically:

- **Direct** — the wallet is already on the payout chain. A plain on-chain send
  to the recipient. No SideShift order, no swap spread, no $5 minimum; only the
  network fee applies.
- **Swap** — anything else. A SideShift order converts it into the payout chain
  and settles to the recipient.

### Swaps are fixed-rate

A swap is executed as a SideShift **fixed-rate shift**: a fresh quote is taken
at execution time and the shift is created from it, so the rate the client was
shown is the rate that settles. (Variable shifts, used previously, set the rate
whenever the deposit lands - the review screen's figure was never binding.)
Two constraints follow from SideShift's rules:

- **Exact amount, fifteen minutes.** Only a deposit of exactly the quoted
  `depositAmount`, seen by SideShift within fifteen minutes of the quote,
  settles. The broadcast uses SideShift's own amount string (no float
  rounding), happens seconds after the quote, and a shift found already
  expired is skipped rather than sent into. Anything that does miss is
  refunded to the source wallet - the transfer shows as `ORDER_REFUNDED`, the
  client's coins are back where they started, and the withdrawal can be run
  again.
- **Same account as the quote.** SideShift requires the shift's `affiliateId`
  to match the quote's, so the shift is pinned to the quoting account rather
  than taken from the rotation.

If a fixed quote or shift cannot be obtained, the code falls back to a
variable shift and logs a warning; the payout still completes, at the rate on
arrival.

Note that SideShift's rate limits (20 quotes, 5 shifts per minute) are
**per IP address**, not per account - see their docs. Rotating accounts does
not raise them; only distinct egress addresses do.

### SideShift and US addresses

SideShift answers reads from anywhere but refuses quotes and shifts from US
IP addresses (`ACCESS_DENIED`, see sideshift.ai/access-denied). If the server
egresses from the US, every swap fails unless the request leaves through a
proxy elsewhere - which is what `data/accounts.json`'s per-account proxies do.
When a proxy refuses the connection the app now sidelines it for ten minutes
and goes direct, which keeps swaps working wherever the server's own address
is allowed; from a US address the direct attempt is refused too.

This is a jurisdiction restriction, not a rate limit, and routing around it is
a decision with legal weight. The alternatives that do not depend on it:
same-chain payouts (a client cashing out in a chain they already hold never
touches SideShift), or a swap provider that serves your jurisdiction.

Eligibility follows from that. A swap needs roughly `($5 + gas) / (1 - fee)` to
be worth doing; a direct send only has to cover its own network fee. Both the
preview and the execution path read the same
`SwapService.minimumBalanceUsd()`, so what a client is shown is what runs.

Direct-send cost estimates live in `SideshiftService.DIRECT_TRANSFER_GAS_USD`;
swap eligibility and reserves use live figures from `GasEstimator`.

---

## Ethereum RPC

`src/services/EthereumProvider.js` owns the endpoint list. It probes candidates
in order, keeps the first that answers, and fails over when one stops working.
`GET /readyz` reports which endpoint is live.

Three separate modules previously constructed their own
`new ethers.JsonRpcProvider(<single hardcoded URL>)`, and the wallet service
held a list of three fallbacks but only ever read index 0 — so a single dead
endpoint broke every ETH balance read, fee estimate and broadcast, with the
spares untouched.

Set `ETH_RPC_URLS` to a comma-separated list to override. **Use a paid endpoint
in production** (Alchemy, Infura, QuickNode): the public ones rate-limit, and a
rate-limited endpoint is indistinguishable from a broken one at the worst moment.

### When ETH fails but BTC, LTC and SOL are fine

That pattern points at the network, not the code. Public Ethereum RPC hostnames
are a common target for DNS-based filtering — router "protection" features,
corporate resolvers, some ISPs. The filter answers with its own address, so TLS
fails with a certificate error naming a block page rather than the endpoint.

Confirm it by resolving several of them:

```bash
node -e "['ethereum-rpc.publicnode.com','eth.llamarpc.com','1rpc.io'].forEach(h=>require('dns').lookup(h,(e,a)=>console.log(h,a)))"
```

If unrelated hostnames resolve to the *same* IP, they are being intercepted.
Fix it on the network, or point `ETH_RPC_URLS` at an endpoint that is not
filtered. The provider raises this explanation directly when it detects
certificate errors across the whole candidate list.

### Retry policy

Reads (`getBalance`, `estimateFee`) run through `withProvider`, which retries
once on a different endpoint if the failure looks like transport rather than
application. **Broadcasts deliberately do not retry** — resending a transaction
that may already have reached the network risks paying twice.

---

## Fees and network costs

### How a withdrawal is broken down

```
on-chain balance
  − network reserve      live fee estimate × 1.5, left behind so the send broadcasts
  = swept
  − platform fee         PLATFORM_FEE_RATE of the swept amount
  − swap / transfer cost
  = client receives
```

The fee is deducted from the amount sent, and the quote is derived from the
same plan that gets broadcast — so what a client is shown and what they receive
cannot drift apart. Previously the planner sent 90% while the quote promised
95%, so every withdrawal under-paid by 5% on top of the disclosed fee.

### Estimates are live, not hardcoded

`GasEstimator` reads each chain's own live source — mempool.space for BTC, the
node's relay fee for LTC, `getRecentPrioritizationFees` for SOL, `getFeeData`
for ETH — caches for 60 seconds, and falls back to deliberately high constants
if a source is unreachable.

Eligibility and planning share one estimate per chain per request, so a wallet
cannot be judged withdrawable on one number and then planned with another.

This matters because fee markets move by an order of magnitude. The old fixed
table used $0.15 for an ETH send; a realistic figure is often ten times that.
When fees are low a fixed buffer wrongly rejects wallets as too small; when
they are high the reserve is too thin and the transaction will not broadcast.

### Fee collection

The fee currently stays at the customer's deposit address after a withdrawal
and is recorded in `serviceSubtractions` — per wallet, at the moment its
transfer is broadcast, using the exact amount the plan withheld. (It used to be
recorded for every wallet in the plan before anything was sent, so a transfer
that failed still cost the client the fee on their displayed balance.) The wallet API reports it honestly:
`balance` is what the client can withdraw, `onChainBalance` is what the address
really holds, and `platformFeeHeld` is the difference.

Two better options, when you want them:

1. **Pay the fee out in the same transaction.** On BTC and LTC a transaction
   can have two outputs — client and fee address — for the same network fee as
   one. Collection becomes free. ETH and SOL need a second transaction.
2. **Sweep to a float.** Move the whole balance to a platform wallet, credit the
   client's ledger with their share, and pay them from the float. One on-chain
   movement per deposit, the fee never sits at a customer address, and payouts
   can be batched. This is how payment processors normally do it, and it needs a
   ledger — see the Postgres note above.

Either way, do not leave fees to be collected later and show the client a zero
balance in the meantime: it costs a second network fee, it cannot be reconciled
against the chain, and it misstates a custodial balance.

---

## Security posture

| Area | Status |
|------|--------|
| Identity | Derived only from a verified Bearer credential, exposed on `req.auth`. Request bodies cannot influence it. |
| Passwords | scrypt (N=32768), salted. Legacy SHA-256 hashes upgrade on next login. |
| API keys | 256 bits from `crypto.randomBytes`, stored as SHA-256 hashes. Shown once. |
| Wallet keys | AES-256-GCM at rest, keyed by `KEY_ENCRYPTION_KEY`. |
| Sessions | HS256 JWTs via `jsonwebtoken`, algorithm pinned. |
| Transport | HSTS, CSP, `X-Frame-Options`, `nosniff` via helmet. |
| Rate limits | Global, plus tighter limits on auth and withdrawal. Keyed per client. |
| Idempotency | Required on `POST /api/withdrawal`. |
| Errors | Internal detail logged with a request id, never returned. |

### Still outstanding

- **Key custody.** Keys are encrypted, but the app can still decrypt every one
  of them. A compromised process reads them all. Move to KMS-backed signing or
  an external custodian (Fireblocks, BitGo).
- **Postgres.** Required before running more than one instance.
- **Durable job queue.** Payout execution is still in-process. The maintenance
  sweep now carries transfers to completion after a restart or a long
  confirmation, which removes the data-loss failure mode, but broadcast itself
  still happens on the request's own process.
- **Keyed RPC providers.** Every chain read and broadcast goes through free
  public endpoints, each with a fallback. They are fine for testing and thin
  for production. Before real volume: `ETH_RPC_URLS` on Alchemy/Infura, your
  own `ETHERSCAN_API_KEY`, and consider a paid Solana RPC (Helius, Triton).
- **On-chain execution is untested end-to-end.** Every code path that signs
  and broadcasts has been reviewed and its fee, reserve and status logic
  covered by tests, but no real transaction has been sent from this codebase
  during this work. The first live payout on each chain should be small and
  watched.
- **Per-session checkout addresses.** Settlement now claims a specific
  transaction hash, so concurrent sessions cannot cross-credit — but a derived
  address per session is the cleaner model.
- **Integer money.** Amounts are still floats; a minor-unit integer ledger
  avoids reconciliation drift.
- **Licensing.** Accepting funds for a merchant and paying them out is money
  transmission in most jurisdictions. Talk to a fintech lawyer.

---

## Testing

```bash
npm test
```

68 tests covering credential handling, encryption round-trips, address
validation across all four chains, webhook signatures, and fail-closed
settlement. Run them before every deploy.
