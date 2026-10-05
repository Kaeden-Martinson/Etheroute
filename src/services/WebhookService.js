/**
 * Signed webhook delivery.
 *
 * Vendors should not have to poll for checkout results. Each delivery carries an
 * HMAC-SHA256 signature over the raw body so the receiver can prove the call
 * came from us, and failures are retried with exponential backoff.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { db } = require('../config/database');
const { config } = require('../config/env');
const logger = require('./logger');

const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000, 600_000, 3_600_000];

// ─── Target safety ───────────────────────────────────────────────────────────
//
// A webhook URL is supplied by the merchant and called from inside our
// network. Left unchecked, it is a way to make the server POST to localhost,
// to the cloud provider's metadata endpoint (169.254.169.254), or to anything
// else only reachable from here. The literal form is checked when the URL is
// saved; the resolved address is checked again at delivery time, so a hostname
// that later points somewhere private is still refused.

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224;                             // multicast and reserved
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped, in either spelling: ::ffff:10.0.0.1 or, as the URL parser
  // normalises it, ::ffff:a00:1.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return false;
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Why a parsed URL must not be used as a webhook target, or null if it is fine.
 * Only inspects the literal URL - see resolveTarget for the DNS check.
 */
function unsafeTargetReason(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'missing host';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'internal hostname';
  }
  if (net.isIP(host) && isPrivateAddress(host)) return 'private address';
  if (parsed.username || parsed.password) return 'credentials in URL';
  return null;
}

/**
 * Resolve the hostname and refuse if any answer is private.
 */
async function assertResolvesPublic(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('webhook target is a private address');
    return;
  }

  const answers = await dns.lookup(host, { all: true });
  for (const { address } of answers) {
    if (isPrivateAddress(address)) {
      throw new Error(`webhook host resolves to a private address (${address})`);
    }
  }
}

/**
 * The original per-client secret, derived from the master key. Used for any
 * client that has never rotated, so their existing verification keeps working.
 */
function derivedSigningSecret(clientId) {
  return crypto
    .createHmac('sha256', config.keyEncryptionKey)
    .update(`webhook-secret:${clientId}`)
    .digest('base64url');
}

/**
 * A client's effective webhook signing secret: the stored one if they have
 * rotated, otherwise the derived one. Used to sign every delivery and returned
 * by GET /api/webhook-secret.
 *
 * The derived value cannot be rotated on its own (it is tied to the master key,
 * which also decrypts wallets), so a leaked secret used to be stuck. A client
 * can now POST /api/webhook-secret/rotate for a fresh random secret stored on
 * their record; from then on this returns that, and the old value stops working.
 */
function signingSecret(clientId) {
  try {
    const user = db.getById('users', clientId);
    if (user && typeof user.webhookSecret === 'string' && user.webhookSecret) return user.webhookSecret;
  } catch (e) { /* fall back to derived */ }
  return derivedSigningSecret(clientId);
}

/**
 * Mint a fresh random secret for this client, store it, and return it. The
 * client's previous secret (rotated or derived) immediately stops verifying, so
 * the vendor must update their endpoint's configured secret to the new value.
 * Returns null if the client does not exist.
 */
function rotateSigningSecret(clientId) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const updated = db.update('users', clientId, { webhookSecret: secret, webhookSecretRotatedAt: new Date().toISOString() });
  return updated ? secret : null;
}

/** Whether this client is on a rotated (stored) secret rather than the derived one. */
function signingSecretIsRotated(clientId) {
  try { const user = db.getById('users', clientId); return !!(user && user.webhookSecret); } catch (e) { return false; }
}

/**
 * Signature header value, formatted like Stripe's so the verification snippet
 * vendors already know how to write applies here too.
 *
 * Receivers must compute HMAC over `${timestamp}.${rawBody}` and compare in
 * constant time, rejecting timestamps outside a few minutes to stop replays.
 */
function signPayload(secret, timestamp, rawBody) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verify an inbound signature. Exported so the delivery path and the tests use
 * exactly the same comparison.
 */
function verifySignature(secret, header, rawBody, toleranceSeconds = 300) {
  if (!header) return false;

  const parts = Object.fromEntries(
    String(header).split(',').map((piece) => piece.split('=').map((s) => s.trim()))
  );

  if (!parts.t || !parts.v1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(parts.v1, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Queue a webhook. Returns the delivery record; sending happens in the
 * background so the caller's response is never blocked on the vendor's server.
 */
function enqueue({ clientId, url, event, data }) {
  if (!url) return null;

  const delivery = db.create('webhookDeliveries', {
    id: crypto.randomUUID(),
    clientId,
    url,
    event,
    payload: { event, data, createdAt: new Date().toISOString() },
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  // Fire immediately; the sweeper picks up anything that fails.
  attempt(delivery.id).catch((error) => {
    logger.error(`[Webhook] Immediate delivery failed for ${delivery.id}: ${error.message}`);
  });

  return delivery;
}

/**
 * Attempt one delivery, scheduling a retry on failure.
 */
async function attempt(deliveryId) {
  const delivery = db.getById('webhookDeliveries', deliveryId);
  if (!delivery || delivery.status === 'DELIVERED') return;

  if (delivery.attempts >= config.webhooks.maxAttempts) {
    db.update('webhookDeliveries', deliveryId, { status: 'EXHAUSTED' });
    logger.error(`[Webhook] Giving up on ${deliveryId} after ${delivery.attempts} attempts`);
    return;
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(signingSecret(delivery.clientId), timestamp, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);

  try {
    const parsed = new URL(delivery.url);
    const unsafe = unsafeTargetReason(parsed);
    if (unsafe) throw new Error(`refused: ${unsafe}`);
    await assertResolvesPublic(parsed);

    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Etheroute-Signature': signature,
        'Etheroute-Event': delivery.event,
        'Etheroute-Delivery': deliveryId,
      },
      body: rawBody,
      signal: controller.signal,
      // A redirect could point the signed POST at an address that was never
      // checked. The vendor's endpoint should answer directly.
      redirect: 'manual',
    });

    if (response.ok) {
      db.update('webhookDeliveries', deliveryId, {
        status: 'DELIVERED',
        attempts: delivery.attempts + 1,
        deliveredAt: new Date().toISOString(),
        lastError: null,
      });
      logger.info(`[Webhook] Delivered ${delivery.event} to ${delivery.url}`);
      return;
    }

    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    const attempts = delivery.attempts + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];

    db.update('webhookDeliveries', deliveryId, {
      status: attempts >= config.webhooks.maxAttempts ? 'EXHAUSTED' : 'PENDING',
      attempts,
      lastError: error.message,
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
    });

    logger.warn(`[Webhook] Attempt ${attempts} failed for ${deliveryId}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry every delivery whose backoff has elapsed. Called on an interval by the
 * application, and safe to call at any time.
 */
async function sweep() {
  const now = Date.now();
  const due = db
    .getAll('webhookDeliveries')
    .filter((d) => d.status === 'PENDING' && new Date(d.nextAttemptAt).getTime() <= now);

  for (const delivery of due) {
    await attempt(delivery.id);
  }

  return due.length;
}

module.exports = {
  enqueue,
  attempt,
  sweep,
  signingSecret,
  derivedSigningSecret,
  rotateSigningSecret,
  signingSecretIsRotated,
  signPayload,
  verifySignature,
  unsafeTargetReason,
  isPrivateAddress,
};
