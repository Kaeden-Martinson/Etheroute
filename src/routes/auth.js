const { Router } = require('express');
const { db } = require('../config/database');
const AuthService = require('../services/AuthService');
const { ApiError } = require('../utils/errors');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = Router();

const MAX_PASSWORD_LENGTH = 200;

/**
 * Register
 * POST /api/auth/register
 */
router.post('/register', authLimiter, (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ApiError(400, 'Username and password are required');
    }
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new ApiError(400, 'Username and password must be strings');
    }
    if (username.length < 3 || username.length > 32) {
      throw new ApiError(400, 'Username must be between 3 and 32 characters');
    }
    if (password.length < 12) {
      throw new ApiError(400, 'Password must be at least 12 characters');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      // Unbounded input into a memory-hard KDF is a denial-of-service vector.
      throw new ApiError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new ApiError(400, 'Username can only contain letters, numbers, underscores, and hyphens');
    }

    const result = AuthService.register(db, { username, password });

    res.status(201).json({
      success: true,
      token: result.token,
      clientId: result.clientId,
      username: result.username,
      // Shown exactly once — the user must save these to recover a lost password.
      recoveryCodes: result.recoveryCodes,
      message: 'Registration successful',
    });
  } catch (error) {
    if (error.message && error.message.includes('already')) {
      return next(new ApiError(409, error.message));
    }
    next(error);
  }
});

/**
 * Login
 * POST /api/auth/login
 */
router.post('/login', authLimiter, (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ApiError(400, 'Username and password are required');
    }
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      throw new ApiError(400, 'Invalid credentials');
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
    if (error.message && error.message.includes('Invalid')) {
      return next(new ApiError(401, 'Invalid username or password'));
    }
    next(error);
  }
});

/**
 * Reset a forgotten password with a recovery code
 * POST /api/auth/reset-password
 */
router.post('/reset-password', authLimiter, (req, res, next) => {
  try {
    const { username, recoveryCode, newPassword } = req.body;

    if (!username || !recoveryCode || !newPassword) {
      throw new ApiError(400, 'Username, recovery code, and new password are required');
    }
    if (typeof newPassword !== 'string' || typeof recoveryCode !== 'string' || typeof username !== 'string') {
      throw new ApiError(400, 'Invalid request');
    }
    if (newPassword.length < 12) {
      throw new ApiError(400, 'Password must be at least 12 characters');
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new ApiError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }

    const result = AuthService.resetPassword(db, { username, recoveryCode, newPassword });

    res.json({
      success: true,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
      message: 'Password reset successful. You can now sign in with your new password.',
    });
  } catch (error) {
    if (error.message && error.message.includes('Invalid')) {
      return next(new ApiError(400, 'Invalid username or recovery code'));
    }
    next(error);
  }
});

/**
 * Change the signed-in user's password. Needs the current one: a session
 * alone must not be enough to take the account.
 * POST /api/auth/change-password
 */
router.post('/change-password', requireAuth, authLimiter, (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new ApiError(400, 'Current password and new password are required');
    }
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw new ApiError(400, 'Invalid request');
    }
    if (newPassword.length < 12) {
      throw new ApiError(400, 'Password must be at least 12 characters');
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new ApiError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }
    if (newPassword === currentPassword) {
      throw new ApiError(400, 'The new password is the same as the current one');
    }

    AuthService.changePassword(db, req.auth.clientId, { currentPassword, newPassword });

    res.json({ success: true, message: 'Password changed' });
  } catch (error) {
    if (error.message && error.message.includes('incorrect')) {
      return next(new ApiError(400, 'Current password is incorrect'));
    }
    next(error);
  }
});

/**
 * Regenerate the account's recovery codes (invalidates the old set)
 * POST /api/auth/recovery-codes
 */
router.post('/recovery-codes', requireAuth, authLimiter, (req, res, next) => {
  try {
    const result = AuthService.regenerateRecoveryCodes(db, req.auth.clientId);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (error) {
    next(error);
  }
});

/**
 * Check username availability
 * GET /api/auth/check-username/:username
 */
router.get('/check-username/:username', authLimiter, (req, res, next) => {
  try {
    const { username } = req.params;

    if (!username || username.length < 3) {
      return res.json({ available: false, reason: 'Username too short' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.json({ available: false, reason: 'Invalid characters' });
    }
    if (db.findOneBy('users', { username })) {
      return res.json({ available: false, reason: 'Username taken' });
    }

    res.json({ available: true });
  } catch (error) {
    next(error);
  }
});

/**
 * Verify the caller's credential
 * GET /api/auth/verify
 */
router.get('/verify', requireAuth, (req, res) => {
  res.json({
    valid: true,
    clientId: req.auth.clientId,
    username: req.auth.username,
    method: req.auth.method,
    // the dashboard shows the owner panel's link to the owner alone
    owner: !!req.auth.owner,
  });
});

module.exports = router;
