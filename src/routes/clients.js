const { Router } = require('express');
const { db } = require('../config/database');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Get authenticated user profile
 * GET /api/clients/me
 */
router.get('/me', (req, res, next) => {
  try {
    const clientId = req.body.clientId || req.clientId;

    if (!clientId) {
      throw new ApiError(401, 'API Key is required');
    }

    const user = db.getById('users', clientId);

    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    res.json({
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      developer: !!user.developer,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get all users
 * GET /api/clients
 */
router.get('/', (req, res, next) => {
  try {
    const users = db.getAll('users');

    res.json(
      users.map((user) => ({
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
        developer: !!user.developer,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// Get user by ID
router.get('/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    const user = db.getById('users', id);

    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    res.json({
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      developer: !!user.developer,
    });
  } catch (error) {
    next(error);
  }
});

// Update user by ID
router.put('/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    const user = db.getById('users', id);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Only username is stored, cannot update other fields
    res.json({
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
