const { config, validate } = require('./config/env');

// Refuse to start on an invalid or insecure configuration, before anything
// else is wired up.
validate();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const logger = require('./services/logger');
const { ApiError } = require('./utils/errors');
const UsageLog = require('./services/UsageLog');
const MaintenanceService = require('./services/MaintenanceService');
const ChainHealthService = require('./services/ChainHealthService');
const BalanceWatcher = require('./services/BalanceWatcher');
const BackupService = require('./services/BackupService');
const FeeCollectionService = require('./services/FeeCollectionService');
const AlertService = require('./services/AlertService');

const { requireAuth } = require('./middleware/auth');
const { globalLimiter, clientLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const walletRoutes = require('./routes/wallets');
const withdrawalRoutes = require('./routes/withdrawal');
const transactionRoutes = require('./routes/transactions');
const payoutRoutes = require('./routes/payouts');
const apiKeysRoutes = require('./routes/api-keys');
const apiCallsRoutes = require('./routes/api-calls');
const statusRoutes = require('./routes/status');
const checkoutRoutes = require('./routes/checkout');
const ownerRoutes = require('./routes/owner');

const app = express();
const PUBLIC_DIR = path.join(__dirname, '../public');

// Behind a load balancer, req.ip and req.secure must come from the forwarded
// headers - otherwise every client rate-limits against the proxy's address.
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

// ── Security headers ─────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // Helmet sets this by default. Over plain http on localhost it makes the
      // browser upgrade every asset request to https and fail, so it is only
      // switched on where there is actually TLS to upgrade to.
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// Same-origin by default. An explicit allowlist is only needed when the
// dashboard is served from a different host than the API.
app.use(cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}));

// ── Body parsing ─────────────────────────────────────────────────────────────
// Bounded, so a large POST cannot exhaust memory.

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Request logging ──────────────────────────────────────────────────────────

app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    logger.request(`${req.method} ${req.path} ${res.statusCode} - client: ${req.auth?.clientId || 'anonymous'} - req: ${req.id}`);
  });

  next();
});

// ── Static assets and pages ──────────────────────────────────────────────────

// Redirect .html to the clean URL. This must run BEFORE express.static,
// otherwise static serves the .html directly and the redirect never fires.
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.endsWith('.html')) {
    const clean = req.path.slice(0, -5);
    return res.redirect(301, clean === '/index' ? '/' : clean);
  }
  next();
});

// __dirname-relative, so the app works regardless of the working directory it
// was started from.
app.use(express.static(PUBLIC_DIR, { extensions: false, index: false }));

// Only pages that actually exist are routed; a missing file used to reach
// sendFile and throw a 500.
const PAGES = {
  '/': 'index.html',
  '/auth': 'auth.html',
  '/dashboard': 'dashboard.html',
  '/faq': 'faq.html',
  '/about': 'about.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
  '/docs': 'docs.html',
  '/api-reference': 'api-reference.html',
  '/help': 'help.html',
  '/compliance': 'compliance.html',
  '/status': 'status.html',
  '/owner': 'owner.html',
};

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res, next) => {
    res.sendFile(path.join(PUBLIC_DIR, file), (error) => {
      if (error) next(error);
    });
  });
}

app.get('/checkout/:sessionId', (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'checkout.html'), (error) => {
    if (error) next(error);
  });
});

// ── Health checks ────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/readyz', async (req, res) => {
  const PriceService = require('./services/PriceService');
  const EthereumProvider = require('./services/EthereumProvider');

  const pricesLoaded = Boolean(PriceService.ethToUsdRate);
  const pricesFresh = PriceService.isFresh();

  // Report which Ethereum endpoint is in use. When every candidate is
  // unreachable - a dead provider, or DNS filtering intercepting them - this is
  // where it shows up, rather than only in a failed withdrawal.
  let ethRpc = EthereumProvider.activeUrl();
  let ethError = null;
  if (!ethRpc) {
    try {
      await EthereumProvider.getProvider();
      ethRpc = EthereumProvider.activeUrl();
    } catch (error) {
      // First line only - the full message lists every endpoint tried.
      [ethError] = error.message.split('\n');
    }
  }

  const ready = pricesLoaded && pricesFresh && Boolean(ethRpc);

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    prices: !pricesLoaded ? 'pending' : (pricesFresh ? 'loaded' : 'stale'),
    priceAgeSeconds: PriceService.ageSeconds(),
    ...(PriceService.lastError && { priceError: PriceService.lastError }),
    ethRpc: ethRpc || 'unreachable',
    ...(ethError && { ethRpcError: ethError }),
  });
});

// ── API ──────────────────────────────────────────────────────────────────────

app.use('/api', globalLimiter);

// Public: registration, login, the status page, and the hosted checkout the
// buyer uses. Everything else requires a verified credential.
app.use('/api/auth', authRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/checkout', checkoutRoutes);

// The chains this deployment supports, as the front ends and integrators
// need them: codes, symbols, confirmations, explorer links, wallet-pay
// support. No secrets. Cached by the browser for a minute.
app.get('/api/chains', (req, res) => {
  const chains = require('./config/chains');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ chains: chains.list().map(chains.publicInfo) });
});

/**
 * Record usage for billing and the dashboard chart. Runs after authentication so
 * the client is the verified one, and covers every authenticated endpoint rather
 * than only those that happened to carry a clientId in the body. The row is
 * buffered and written with its neighbours; the request does not wait on disk.
 */
function trackApiCall(req, res, next) {
  res.on('finish', () => {
    UsageLog.record({
      id: crypto.randomUUID(),
      clientId: req.auth.clientId,
      // The full path. Inside a mounted router req.path is relative to the
      // mount, which logged every list as "/list" whatever it listed.
      endpoint: `${req.baseUrl || ''}${req.path}`,
      method: req.method,
      statusCode: res.statusCode,
      timestamp: new Date().toISOString(),
    });
  });
  next();
}

// Per-account budget applies once the caller is known.
app.use('/api/clients', requireAuth, clientLimiter, trackApiCall, clientRoutes);
app.use('/api/wallets', requireAuth, clientLimiter, trackApiCall, walletRoutes);
app.use('/api/withdrawal', requireAuth, clientLimiter, trackApiCall, withdrawalRoutes);
app.use('/api/transactions', requireAuth, clientLimiter, trackApiCall, transactionRoutes);
app.use('/api/payouts', requireAuth, clientLimiter, trackApiCall, payoutRoutes);
app.use('/api/api-keys', requireAuth, clientLimiter, trackApiCall, apiKeysRoutes);
app.use('/api/api-calls', requireAuth, clientLimiter, apiCallsRoutes);
// The owner's view across every merchant. Guarded inside the router: a
// signed-in session on an account flagged owner, never an API key.
app.use('/api/owner', requireAuth, clientLimiter, ownerRoutes);

// ── 404 ──────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// ── Errors ───────────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PayloadTooLarge', message: 'Request body is too large' });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'BadRequest', message: 'Request body is not valid JSON' });
  }

  // Log the detail, return a generic message. Internal error text used to be
  // sent straight to the client.
  logger.error(`[${req.id}] Unhandled error on ${req.method} ${req.path}: ${err.stack || err.message}`);
  AlertService.notify(
    `500 on ${req.method} ${req.path}`,
    `Request ${req.id}\n${err.stack || err.message}`,
    `500:${req.method}:${req.path}`,
  );

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Something went wrong. Quote this request id if you contact support.',
    requestId: req.id,
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

let server = null;

function start() {
  server = app.listen(config.port, () => {
    logger.info(`Etheroute API listening on port ${config.port} (${config.nodeEnv})`);
  });

  server.on('error', (error) => {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });

  MaintenanceService.start();
  BackupService.start();
  ChainHealthService.start();
  BalanceWatcher.start();
  FeeCollectionService.start();

  return server;
}

/**
 * Stop accepting connections and let in-flight requests finish before exiting,
 * so a deploy does not cut off a request mid-write.
 */
function shutdown(signal) {
  logger.info(`Received ${signal} - shutting down`);
  MaintenanceService.stop();
  BackupService.stop();
  ChainHealthService.stop();
  BalanceWatcher.stop();
  FeeCollectionService.stop();
  UsageLog.flush();

  if (!server) process.exit(0);

  server.close(() => {
    logger.info('Closed out remaining connections');
    // the rows the last requests wrote while we were draining
    UsageLog.flush();
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Could not close connections in time - forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason && reason.stack ? reason.stack : reason}`);
  AlertService.notify('Unhandled promise rejection', reason && reason.stack ? reason.stack : String(reason), 'unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.stack || error.message}`);
  AlertService.notify('Uncaught exception — process is shutting down', error.stack || error.message, 'uncaughtException');
  shutdown('uncaughtException');
});

// Only listen when run directly, so tests can import the app.
if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
