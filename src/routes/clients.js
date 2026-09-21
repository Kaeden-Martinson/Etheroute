const { Router } = require('express');
const { db } = require('../config/database');
const AuthService = require('../services/AuthService');
const { ApiError } = require('../utils/errors');

const router = Router();

/**
 * The authenticated caller's own profile.
 *
 * There is deliberately no endpoint to list or read other users - the customer
 * table is not a public directory, and the previous `GET /` and `GET /:id`
 * routes exposed every account on the platform.
 *
 * GET /api/clients/me
 */
router.get('/me', (req, res, next) => {
  try {
    const user = db.getById('users', req.auth.clientId);
    if (!user) throw new ApiError(404, 'User not found');

    // How many recovery codes are left is the one security fact the account
    // page can show without revealing anything: the codes themselves were
    // shown once, at registration, and only their hashes are kept.
    const codes = AuthService.recoveryCodeStatus(db, user.id);

    res.json({
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      developer: !!user.developer,
      owner: !!user.owner,
      recoveryCodesRemaining: codes.remaining,
      recoveryCodesTotal: codes.total,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
