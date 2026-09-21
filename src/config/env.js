/**
 * Environment configuration with fail-fast validation.
 *
 * Production refuses to boot when a security-critical secret is missing or weak,
 * rather than silently falling back to a default. Development generates ephemeral
 * secrets and warns loudly.
 */
// The test suite runs against its own settings, as CI does with no .env at
// all: the box's confirmations, tokens and addresses must not reach it.
if (process.env.NODE_ENV !== 'test') require('dotenv').config();

const crypto = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const errors = [];
const warnings = [];

/**
 * Read a required secret. In production a missing or too-short value is fatal.
 * Outside production we generate an ephemeral value so `npm run dev` still works,
 * accepting that restarts invalidate previously issued tokens.
 */
function requireSecret(name, minLength = 32) {
  const value = process.env[name];

  if (!value) {
    if (IS_PRODUCTION) {
      errors.push(`${name} is required in production and is not set.`);
      return null;
    }
    warnings.push(`${name} is not set - generated an ephemeral value for this process. Tokens and encrypted data will not survive a restart.`);
    return crypto.randomBytes(32).toString('hex');
  }

  if (value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters (got ${value.length}).`);
    return null;
  }

  const insecureDefaults = ['your-secret-key', 'secret', 'changeme', 'change-me', 'password'];
  if (insecureDefaults.includes(value.toLowerCase())) {
    errors.push(`${name} is set to a well-known placeholder value. Generate one with: openssl rand -hex 32`);
    return null;
  }

  return value;
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    errors.push(`${name} must be an integer (got "${raw}").`);
    return fallback;
  }
  return parsed;
}

function listFromEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const config = {
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  port: intFromEnv('PORT', 3000),

  // Signs session tokens.
  jwtSecret: requireSecret('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Encrypts wallet private keys and seed phrases at rest (AES-256-GCM).
  // Rotating this requires re-encrypting stored keys - see scripts/rotate-key-encryption-key.js
  keyEncryptionKey: requireSecret('KEY_ENCRYPTION_KEY'),

  // Empty list means same-origin only, which is correct when the API and the
  // dashboard are served from one host. Set explicitly for a split deployment.
  corsOrigins: listFromEnv('CORS_ORIGINS'),

  trustProxy: process.env.TRUST_PROXY === 'true',

  checkout: {
    ttlMinutes: intFromEnv('CHECKOUT_TTL_MINUTES', 60),
    // Confirmations required before a checkout session settles as PAID.
    // Defaults come from the chain registry; CONFIRMATIONS_<CODE> overrides.
    confirmations: Object.fromEntries(
      require('./chains').list().map((chain) => [chain.code, intFromEnv(`CONFIRMATIONS_${chain.code}`, chain.confirmations)])
    ),
    // Accept payments within this fraction of the requested amount.
    underpaymentTolerance: Number(process.env.CHECKOUT_UNDERPAYMENT_TOLERANCE || '0.01'),
  },

  webhooks: {
    timeoutMs: intFromEnv('WEBHOOK_TIMEOUT_MS', 10000),
    maxAttempts: intFromEnv('WEBHOOK_MAX_ATTEMPTS', 6),
  },

  // Requests per minute. The per-IP figure is a flood ceiling applied before
  // authentication; the per-client figure is each account's own budget. Raise
  // perClientPerMinute for a partner integration that legitimately polls hard.
  rateLimits: {
    perIpPerMinute: intFromEnv('RATE_LIMIT_PER_IP_PER_MINUTE', 600),
    perClientPerMinute: intFromEnv('RATE_LIMIT_PER_CLIENT_PER_MINUTE', 300),
    withdrawalsPerMinute: intFromEnv('RATE_LIMIT_WITHDRAWALS_PER_MINUTE', 5),
    checkoutPerIpPerMinute: intFromEnv('RATE_LIMIT_CHECKOUT_PER_IP_PER_MINUTE', 60),
  },

  // Third-party API keys. Optional; the services degrade or fall back when
  // missing.
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,

  // How old the cached price may be before it is refused for a new checkout
  // amount or a withdrawal quote.
  priceMaxAgeMinutes: intFromEnv('PRICE_MAX_AGE_MINUTES', 15),

  payouts: {
    platformFeeRate: Number(process.env.PLATFORM_FEE_RATE || '0.05'),
    // A transfer still unconfirmed after this window is failed out by the reaper
    // so it stops blocking the wallet from future withdrawals.
    stuckTransactionMinutes: intFromEnv('STUCK_TRANSACTION_MINUTES', 60),
  },

  dataDir: process.env.DATA_DIR || null,
  logLevel: process.env.LOG_LEVEL || (IS_PRODUCTION ? 'info' : 'debug'),
};

if (config.checkout.underpaymentTolerance < 0 || config.checkout.underpaymentTolerance > 0.5) {
  errors.push('CHECKOUT_UNDERPAYMENT_TOLERANCE must be between 0 and 0.5.');
}

if (config.payouts.platformFeeRate < 0 || config.payouts.platformFeeRate >= 1) {
  errors.push('PLATFORM_FEE_RATE must be between 0 and 1.');
}

function validate() {
  for (const warning of warnings) {
    console.warn(`[config] WARNING: ${warning}`);
  }

  if (errors.length > 0) {
    console.error('\n[config] Refusing to start - configuration is invalid:\n');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error('\nSee .env.example for the full list of settings.\n');
    process.exit(1);
  }
}

module.exports = { config, validate };
