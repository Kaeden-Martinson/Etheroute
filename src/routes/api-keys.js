const { Router } = require('express');
const crypto = require('crypto');
const { db } = require('../config/database');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Get API keys for a user
 * GET /api/api-keys?clientId=USER_ID
 */
router.get('/', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key or clientId is required');
    }

    const user = db.getById('users', clientId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Get active API key for user (only one per account)
    const apiKey = user.apiKey || null;

    res.json({
      success: true,
      apiKey: apiKey,
      hasKey: !!apiKey,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Generate a new API key for a user
 * POST /api/api-keys/generate
 */
router.post('/generate', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key or clientId is required');
    }

    const user = db.getById('users', clientId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Generate new API key (32 characters, alphanumeric only)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let newApiKey = '';
    for (let i = 0; i < 32; i++) {
      newApiKey += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Update user with new API key
    const updatedUser = db.update('users', clientId, {
      apiKey: newApiKey,
      apiKeyGeneratedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      apiKey: updatedUser.apiKey,
      generatedAt: updatedUser.apiKeyGeneratedAt,
      message: 'API key generated successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Revoke/delete API key for a user
 * DELETE /api/api-keys
 */
router.delete('/', (req, res, next) => {
  try {
    const { clientId } = req.body;

    if (!clientId) {
      throw new ApiError(400, 'API Key or clientId is required');
    }

    const user = db.getById('users', clientId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Remove API key
    const updatedUser = db.update('users', clientId, {
      apiKey: null,
      apiKeyGeneratedAt: null,
    });

    res.json({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
