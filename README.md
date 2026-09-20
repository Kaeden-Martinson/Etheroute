# Etheroute

Cryptocurrency payment infrastructure. Accept payments on Bitcoin, Ethereum,
Litecoin and Solana through a hosted checkout, and cash out to any one of those
four chains via SideShift.

## Quick start

```bash
npm install
cp .env.example .env
```

Generate the two required secrets and put them in `.env`:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # KEY_ENCRYPTION_KEY
```

Then:

```bash
npm run migrate   # only needed on an existing database
npm run dev
```

The dashboard is at `http://localhost:3000`.

> **`KEY_ENCRYPTION_KEY` decrypts every stored wallet key.** Back it up. Losing
> it means losing access to the funds at those addresses.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development server with reload |
| `npm start` | Production server |
| `npm test` | Test suite |
| `npm run migrate` | Migrate the database forward (idempotent) |
| `npm run migrate:dry` | Preview a migration without writing |

## Layout

```
src/
  app.js              Express setup, middleware order, graceful shutdown
  config/
    env.js            Configuration with fail-fast validation
    database.js       JSON store: atomic writes, deep-copy reads, backup recovery
  middleware/
    auth.js           Credential verification -> req.auth
    rateLimit.js      Per-client and per-IP limiters
    idempotency.js    Replay protection for money-moving endpoints
  routes/             HTTP layer, one file per resource
  services/
    crypto/KeyVault   AES-256-GCM encryption for wallet keys
    wallets/          Per-chain address generation, balances, signing
    PayoutService     Withdrawal planning, broadcast, monitoring
    WebhookService    Signed delivery with retries
    MaintenanceService  Stuck-transaction reaper, reconciliation
public/               Dashboard and hosted checkout
tests/                Test suite
```

## Checkout

Create a session, send the buyer to the returned URL, and receive a signed
webhook when it settles:

```bash
curl -X POST http://localhost:3000/api/checkout/create \
  -H "Authorization: Bearer ethr_..." \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "<wallet id>",
    "usdAmount": 25.00,
    "successRoute": "https://shop.example.com/thanks",
    "failureRoute": "https://shop.example.com/failed",
    "webhookUrl": "https://shop.example.com/hooks/etheroute"
  }'
```

The buyer enters their sending address, gets a QR code and the destination
address, and the page polls until the payment reaches the configured
confirmation depth.

The dashboard's **Checkout** page does the same thing without code: pick a
wallet, set an amount, and get a link to send. The table beside it shows every
link and refreshes on its own, so a payment landing is visible as it happens.
The same data is available at `GET /api/checkout/sessions`.

Session states: `PENDING` → `AWAITING_PAYMENT` → `VERIFYING` → `PAID` /
`INSUFFICIENT` / `EXPIRED`. **`VERIFYING` does not mean paid** — it means a
payment was seen but is not yet confirmed, or chain data is temporarily
unreadable. Settlement never assumes success.

## Payouts

Withdraw across all your wallets into a single chain of your choosing:

```bash
curl -X POST http://localhost:3000/api/withdrawal   -H "Authorization: Bearer ethr_..."   -H "Idempotency-Key: $(uuidgen)"   -H "Content-Type: application/json"   -d '{
    "recipientAddress": "bc1q...",
    "payoutChain": "BTC"
  }'
```

`payoutChain` accepts `ETH`, `BTC`, `LTC` or `SOL`, and defaults to `ETH` when
omitted. The recipient address is validated against the chain you pick, so a
BTC payout will not accept an ETH address.

**A wallet already on the chain you are cashing out in is sent directly** — no
SideShift order, no swap spread, and none of SideShift's $5 swap minimum. Only
the network fee comes off. That makes small balances withdrawable that would
otherwise be stranded: $3 of LTC cannot be swapped to ETH, but it can be sent
as LTC. Everything else is swapped into the payout chain as before.

`POST /api/withdrawal/preview` takes the same arguments and returns the plan,
the fee breakdown and any ineligible wallets with the reason — including how
much each would need to qualify.

## Authentication

Two credential types, both sent as `Authorization: Bearer <credential>`:

- **Session tokens** — HS256 JWTs from `/api/auth/login`, for the dashboard.
- **API keys** — `ethr_`-prefixed, for server-to-server use. Stored as a hash
  and shown only once at creation.

Identity comes from the credential alone. A `clientId` in a request body or
query string is ignored.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md). It covers required environment, the
single-instance constraint, backups, webhook verification, and the outstanding
work before this handles significant volume.

## Licence

MIT — see [LICENSE](LICENSE).
