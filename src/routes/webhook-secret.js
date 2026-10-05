const { Router } = require('express');
const { ApiError } = require('../utils/errors');
const WebhookService = require('../services/WebhookService');

const router = Router();

const describe = (webhookSecret, rotated) => ({
  success: true,
  webhookSecret,
  rotated,
  algorithm: 'HMAC-SHA256',
  header: 'Etheroute-Signature',
  format: 't=<unix seconds>,v1=<hex>, where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)',
  note: 'Verify every webhook against this before acting on it, and reject timestamps older than a few minutes. Keep it secret.',
});

/**
 * The caller's current webhook signing secret, so a vendor can verify our signed
 * deliveries. Scoped to the authenticated caller - only ever your own secret.
 *
 * `rotated` is false while you are still on the original secret derived from the
 * master key, true once you have minted your own with /rotate.
 *
 * GET /api/webhook-secret
 */
router.get('/', (req, res) => {
  res.json(describe(WebhookService.signingSecret(req.auth.clientId), WebhookService.signingSecretIsRotated(req.auth.clientId)));
});

/**
 * Mint a FRESH random signing secret, store it, and return it. Your previous
 * secret stops verifying immediately, so update the secret configured at your
 * webhook endpoint to the new value right away. Use this if the current secret
 * may have leaked - the derived one can't be changed any other way.
 *
 * POST /api/webhook-secret/rotate
 */
router.post('/rotate', (req, res, next) => {
  const secret = WebhookService.rotateSigningSecret(req.auth.clientId);
  if (!secret) return next(new ApiError(404, 'User not found'));
  res.status(201).json({ ...describe(secret, true), rotatedNote: 'Your previous webhook secret no longer verifies. Update your endpoint to this value now.' });
});

module.exports = router;
