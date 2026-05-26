require('dotenv').config();
const logger = require('./services/logger');
const express = require('express');
const { ApiError } = require('./utils/errors');
const { db } = require('./config/database');

// Authentication service
const AuthService = require('./services/AuthService');

// Routes
const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const walletRoutes = require('./routes/wallets');
const withdrawalRoutes = require('./routes/withdrawal');
const transactionRoutes = require('./routes/transactions');
const payoutRoutes = require('./routes/payouts');
const apiKeysRoutes = require('./routes/api-keys');
const apiCallsRoutes = require('./routes/api-calls');
const statusRoutes = require('./routes/status');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static('public'));

// Clean URL routing middleware - redirect .html to clean URLs
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const cleanPath = req.path.slice(0, -5); // Remove .html extension
    return res.redirect(301, cleanPath);
  }
  next();
});

// Clean URL handler - serve HTML files without extension
const path = require('path');
app.get(['/', '/auth', '/dashboard', '/withdrawal', '/transactions', '/faq', '/about', '/terms', '/privacy', '/docs', '/api-reference', '/help', '/compliance', '/status'], (req, res) => {
  let filename = 'index.html';
  
  if (req.path === '/auth') filename = 'auth.html';
  else if (req.path === '/dashboard') filename = 'dashboard.html';
  else if (req.path === '/withdrawal') filename = 'withdrawal.html';
  else if (req.path === '/transactions') filename = 'transactions.html';
  else if (req.path === '/faq') filename = 'faq.html';
  else if (req.path === '/about') filename = 'about.html';
  else if (req.path === '/terms') filename = 'terms.html';
  else if (req.path === '/privacy') filename = 'privacy.html';
  else if (req.path === '/docs') filename = 'docs.html';
  else if (req.path === '/api-reference') filename = 'api-reference.html';
  else if (req.path === '/help') filename = 'help.html';
  else if (req.path === '/compliance') filename = 'compliance.html';
  else if (req.path === '/status') filename = 'status.html';

  res.sendFile(path.join(__dirname, '../public', filename));
});

// Resolve client identity from Authorization, then body/query/params fallback.
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  let authClientId;

  if (!req.body || typeof req.body !== 'object') {
    req.body = {};
  }

  // Browsers cannot send bodies on GET requests. Promote query params into body as compatibility input.
  if (req.query && typeof req.query === 'object') {
    Object.entries(req.query).forEach(([key, value]) => {
      if (req.body[key] === undefined) {
        req.body[key] = value;
      }
    });
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (apiKey.length !== 32) {
      AuthService.verifyTokenMiddleware(req, res, next);
      return;
    };

    res.on('finish', () => {
      try {
        const clientId = req.body && req.body.clientId;
        if (clientId) {
          db.create('apiCalls', {
            id: require('crypto').randomUUID(),
            clientId,
            endpoint: req.path,
            method: req.method,
            statusCode: res.statusCode,
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error('[APICallTracker] Failed to log API call:', err.message);
      }
    });
    
    // Find user by API key
    const allUsers = db.getAll('users') || [];
    const user = allUsers.find(u => u.apiKey === apiKey);
    
    if (user) {
      authClientId = user.id;
    }
  }

  const bodyClientId = req.body && typeof req.body === 'object' ? req.body.clientId : undefined;
  const resolvedClientId = authClientId || bodyClientId;

  if (resolvedClientId) {
    if (req.body && typeof req.body === 'object' && !req.body.clientId) {
      req.body.clientId = resolvedClientId;
    }
  }

  logger.request(`Incoming request: ${req.method} ${req.path} - Client ID: ${resolvedClientId || 'None'}`);
  next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/withdrawal', withdrawalRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/api-keys', apiKeysRoutes);
app.use('/api/api-calls', apiCallsRoutes);
app.use('/api/status', statusRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// Error handler middleware
app.use((err, _req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
    });
  }

  logger.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'Something went wrong',
  });
});

// Start server
const startServer = () => {
  try {
    app.listen(PORT, () => {
      logger.info(`Etheroute API server is running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
