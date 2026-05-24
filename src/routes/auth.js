const { Router } = require('express');
const { db } = require('../config/database');
const AuthService = require('../services/AuthService');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * Register endpoint
 * POST /api/auth/register
 */
router.post('/register', (req, res, next) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      throw new ApiError(400, 'Username and password are required');
    }

    if (username.length < 3) {
      throw new ApiError(400, 'Username must be at least 3 characters');
    }

    if (password.length < 8) {
      throw new ApiError(400, 'Password must be at least 8 characters');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new ApiError(400, 'Username can only contain letters, numbers, underscores, and hyphens');
    }

    const result = AuthService.register(db, {
      username,
      password,
    });

    res.status(201).json({
      success: true,
      token: result.token,
      clientId: result.clientId,
      username: result.username,
      message: 'Registration successful',
    });
  } catch (error) {
    if (error.message.includes('already')) {
      next(new ApiError(409, error.message));
    } else {
      next(error);
    }
  }
});

/**
 * Login endpoint
 * POST /api/auth/login
 */
router.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ApiError(400, 'Username and password are required');
    }

    const result = AuthService.login(db, { username, password });

    res.json({
      success: true,
      token: result.token,
      clientId: result.clientId,
      username: result.username,
      message: 'Login successful',
    });
  } catch (error) {
    if (error.message.includes('Invalid')) {
      next(new ApiError(401, error.message));
    } else {
      next(error);
    }
  }
});

/**
 * Check username availability
 * GET /api/auth/check-username/:username
 */
router.get('/check-username/:username', (req, res, next) => {
  try {
    const { username } = req.params;

    if (!username || username.length < 3) {
      return res.json({ available: false, reason: 'Username too short' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.json({ available: false, reason: 'Invalid characters' });
    }

    const existingUser = db.findOneBy('users', { username });
    
    if (existingUser) {
      return res.json({ available: false, reason: 'Username taken' });
    }

    res.json({ available: true });
  } catch (error) {
    next(error);
  }
});

// Verify token endpoint
router.get('/verify', (req, res, next) => {
  try {
    AuthService.verifyTokenMiddleware(req, res, () => {
      res.json({
        valid: true,
        clientId: req.user.clientId,
        username: req.user.username,
      });
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
