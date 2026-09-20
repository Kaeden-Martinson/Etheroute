/**
 * Authentication middleware.
 *
 * Identity is derived ONLY from a verified credential and exposed on `req.auth`.
 * Nothing a caller can write - body, query, params, or any header other than
 * Authorization - can influence who the request is treated as.
 */
const { db } = require('../config/database');
const AuthService = require('../services/AuthService');
const { UnauthorizedError, ForbiddenError, NotFoundError } = require('../utils/errors');

/**
 * Pull the Bearer credential out of the Authorization header.
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve a credential to an identity. Accepts either a session JWT or an API
 * key; API keys are recognised by their `ethr_` prefix and matched by hash.
 * Returns null when the credential is not valid.
 */
function asIdentity(user, method) {
  return {
    clientId: user.id,
    username: user.username,
    method,
    developer: !!user.developer,
  };
}

function resolveIdentity(credential) {
  if (!credential) return null;

  // A JWT always has three dot-separated segments. Anything else is an API key.
  // Keys issued before the `ethr_` prefix existed are still matched by hash, so
  // the migration does not lock existing integrations out.
  const looksLikeJwt = credential.split('.').length === 3;

  if (looksLikeJwt) {
    const payload = AuthService.verifyToken(credential);
    if (!payload || !payload.clientId) return null;

    // The signature is valid, but the account may have been deleted since.
    const user = db.getById('users', payload.clientId);
    if (!user) return null;

    return asIdentity(user, 'jwt');
  }

  const user = AuthService.findUserByApiKey(db, credential);
  if (!user) return null;

  return asIdentity(user, 'apiKey');
}

/**
 * Reject the request unless it carries a valid credential.
 */
function requireAuth(req, res, next) {
  const identity = resolveIdentity(bearerToken(req));

  if (!identity) {
    return next(new UnauthorizedError('A valid API key or session token is required'));
  }

  req.auth = identity;
  next();
}

/**
 * Attach `req.auth` when a valid credential is present, but allow the request
 * through either way. For endpoints with a public view and a richer
 * authenticated view, such as the status page.
 */
function optionalAuth(req, res, next) {
  req.auth = resolveIdentity(bearerToken(req)) || null;
  next();
}

/**
 * Require the developer flag. Must run after requireAuth.
 */
function requireDeveloper(req, res, next) {
  if (!req.auth || !req.auth.developer) {
    return next(new ForbiddenError('Developer access required'));
  }
  next();
}

/**
 * Assert that a record belongs to the authenticated caller.
 *
 * Reports NotFound rather than Forbidden for records owned by someone else, so
 * the response does not confirm that the id exists.
 */
function assertOwnership(record, req, label = 'Resource') {
  if (!record || record.clientId !== req.auth.clientId) {
    throw new NotFoundError(`${label} not found`);
  }
  return record;
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireDeveloper,
  assertOwnership,
  resolveIdentity,
};
