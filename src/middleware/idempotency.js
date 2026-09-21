/**
 * Idempotency for money-moving endpoints.
 *
 * A client retrying after a timeout must not create a second payout. The first
 * successful response for a given Idempotency-Key is stored and replayed on any
 * repeat of the same request.
 */
const crypto = require('crypto');
const { db } = require('../config/database');
const { ApiError } = require('../utils/errors');

const RETENTION_MS = 24 * 60 * 60 * 1000;

// A key still marked in_progress after this long belongs to a request whose
// process died before it could finish. Without a cutoff the key answered 409
// for a day, and the client could not retry the very request the header was
// meant to make safe.
const IN_PROGRESS_STALE_MS = 5 * 60 * 1000;

function fingerprint(req) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ path: req.path, body: req.body || {} }))
    .digest('hex');
}

/**
 * @param {Object} options
 * @param {boolean} options.required - reject requests with no Idempotency-Key.
 */
function idempotency({ required = true } = {}) {
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];

    if (!key) {
      if (required) {
        return next(new ApiError(400, 'An Idempotency-Key header is required for this endpoint'));
      }
      return next();
    }

    // Scope by client so two customers cannot collide on the same key string.
    const scopedKey = `${req.auth.clientId}:${key}`;
    const existing = db.getById('idempotencyKeys', scopedKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint(req)) {
        return next(new ApiError(422, 'This Idempotency-Key was already used with a different request body'));
      }

      if (existing.status === 'in_progress') {
        const startedAt = new Date(existing.createdAt).getTime();
        if (Date.now() - startedAt < IN_PROGRESS_STALE_MS) {
          return next(new ApiError(409, 'A request with this Idempotency-Key is still in progress'));
        }
        // Abandoned by a process that died mid-request. This attempt takes
        // over the key and runs.
        db.delete('idempotencyKeys', scopedKey);
      } else {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.statusCode).json(existing.response);
      }
    }

    db.create('idempotencyKeys', {
      id: scopedKey,
      clientId: req.auth.clientId,
      fingerprint: fingerprint(req),
      status: 'in_progress',
      statusCode: null,
      response: null,
      createdAt: new Date().toISOString(),
    });

    // Capture the response so a retry can replay it verbatim.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        db.update('idempotencyKeys', scopedKey, {
          status: 'complete',
          statusCode: res.statusCode,
          response: body,
          completedAt: new Date().toISOString(),
        });
      } else {
        // A failed attempt should not lock the key - let the client retry.
        db.delete('idempotencyKeys', scopedKey);
      }
      return originalJson(body);
    };

    next();
  };
}

/** Drop keys past the retention window. */
function pruneIdempotencyKeys() {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  return db.deleteOlderThan('idempotencyKeys', 'createdAt', cutoff);
}

module.exports = { idempotency, pruneIdempotencyKeys };
