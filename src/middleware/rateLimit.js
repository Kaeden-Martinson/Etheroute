/**
 * Rate limiters.
 *
 * Two layers. The global limiter runs before authentication, so it can only
 * key by IP: it is a coarse ceiling against floods. The per-client limiter
 * runs after `requireAuth` and keys by account, which is what actually keeps
 * one customer's traffic from exhausting another's budget - and what lets an
 * integration partner calling from one server address be measured on its own
 * terms rather than sharing a bucket with everyone behind the same NAT.
 *
 * Limits are relaxed outside production so tests and local work are not
 * throttled, and can be tuned per deployment with RATE_LIMIT_* variables.
 */
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { config } = require('../config/env');

const shared = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'TooManyRequests', message: 'Rate limit exceeded. Please slow down.' },
};

/**
 * Key on the authenticated client, falling back to IP.
 *
 * The IP fallback goes through ipKeyGenerator, which collapses an IPv6 address
 * to its /64 prefix. Keying on the raw address would let an IPv6 client hop
 * between addresses in its own allocation and bypass the limit entirely.
 */
function keyByClientOrIp(req) {
  if (req.auth && req.auth.clientId) return `client:${req.auth.clientId}`;
  return ipKeyGenerator(req.ip);
}

const limits = config.rateLimits;

/**
 * Coarse per-IP ceiling on the whole API. Runs before authentication, so
 * `req.auth` is never set here and the key is always the address.
 */
const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: config.isProduction ? limits.perIpPerMinute : 100000,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});

/**
 * Per-account budget for authenticated endpoints. Mount after requireAuth.
 */
const clientLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: config.isProduction ? limits.perClientPerMinute : 100000,
  keyGenerator: keyByClientOrIp,
});

/** Login and registration - the brute-force surface. */
const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: config.isProduction ? 10 : 100000,
  skipSuccessfulRequests: true,
  message: { error: 'TooManyRequests', message: 'Too many attempts. Try again in 15 minutes.' },
});

/** Anything that moves money. */
const withdrawalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: config.isProduction ? limits.withdrawalsPerMinute : 100000,
  keyGenerator: keyByClientOrIp,
});

/** Public checkout endpoints, keyed by IP since buyers are unauthenticated. */
const checkoutLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: config.isProduction ? limits.checkoutPerIpPerMinute : 100000,
});

module.exports = { globalLimiter, clientLimiter, authLimiter, withdrawalLimiter, checkoutLimiter };
