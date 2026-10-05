const { Router } = require('express');
const WebhookService = require('../services/WebhookService');

const router = Router();

/**
 * The caller's own webhook signing secret.
 *
 * Deliveries are signed with a per-client secret derived from the master key
 * (see WebhookService.signingSecret) - nothing is stored, and it can always be
 * shown to the vendor again. There was no way to actually show it, so a vendor
 * could not verify our webhooks without recomputing the HMAC by hand. This
 * returns it, scoped to the authenticated caller: only ever your own secret.
 *
 * Treat it like a password - anyone who has it can forge signatures that pass
 * your verification.
 *
 * GET /api/webhook-secret
 */
router.get('/', (req, res) => {
  const webhookSecret = WebhookService.signingSecret(req.auth.clientId);
  res.json({
    success: true,
    webhookSecret,
    algorithm: 'HMAC-SHA256',
    header: 'Etheroute-Signature',
    format: 't=<unix seconds>,v1=<hex>, where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)',
    note: 'Verify every webhook against this before acting on it, and reject timestamps older than a few minutes. Keep it secret.',
  });
});

module.exports = router;
