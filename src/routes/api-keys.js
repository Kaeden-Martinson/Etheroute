const { Router } = require('express');
const { db } = require('../config/database');
const AuthService = require('../services/AuthService');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Describe the caller's API key. The secret itself is never returned - only
 * metadata, so a compromised session cannot lift a long-lived credential.
 *
 * GET /api/api-keys
 */
router.get('/', (req, res, next) => {
  try {
    const user = db.getById('users', req.auth.clientId);
    if (!user) throw new ApiError(404, 'User not found');

    res.json({
      success: true,
      hasKey: !!user.apiKeyHash,
      prefix: user.apiKeyPrefix || null,
      generatedAt: user.apiKeyGeneratedAt || null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Issue a new API key, replacing any existing one.
 * The plaintext key is returned here and nowhere else, ever.
 *
 * POST /api/api-keys/generate
 */
router.post('/generate', (req, res, next) => {
  try {
    const issued = AuthService.issueApiKey(db, req.auth.clientId);
    if (!issued) throw new ApiError(404, 'User not found');

    res.json({
      success: true,
      apiKey: issued.apiKey,
      prefix: issued.prefix,
      generatedAt: issued.generatedAt,
      message: 'Store this key now - it will not be shown again.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Revoke the caller's API key.
 * DELETE /api/api-keys
 */
router.delete('/', (req, res, next) => {
  try {
    const updated = AuthService.revokeApiKey(db, req.auth.clientId);
    if (!updated) throw new ApiError(404, 'User not found');

    res.json({ success: true, message: 'API key revoked successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
