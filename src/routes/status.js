const { Router } = require('express');
const StatusService = require('../services/StatusService');
const ChainHealthService = require('../services/ChainHealthService');
const { optionalAuth, requireAuth, requireDeveloper } = require('../middleware/auth');

const router = Router();

/**
 * Every chain's health: what answered on the last sweep, which routes are
 * open, when it last changed, and thirty days of daily uptime from the
 * recorded changes. Public - it names public endpoints and public networks.
 * GET /api/status/chains
 */
router.get('/chains', (req, res) => {
  res.json({ success: true, ...ChainHealthService.getSnapshot() });
});

/**
 * Public status snapshot. Incident detail is included only for developers.
 * GET /api/status
 */
router.get('/', optionalAuth, (req, res) => {
  const clientId = req.auth ? req.auth.clientId : null;
  const viewer = StatusService.getViewerContext(clientId);
  const snapshot = StatusService.getStatusSnapshot();

  res.json({
    success: true,
    ...snapshot,
    viewer,
    incidents: viewer.canViewIncidents ? snapshot.incidents : [],
    activeIncidents: viewer.canViewIncidents ? snapshot.activeIncidents : [],
  });
});

/**
 * GET /api/status/incidents
 */
router.get('/incidents', optionalAuth, (req, res) => {
  const clientId = req.auth ? req.auth.clientId : null;
  const viewer = StatusService.getViewerContext(clientId);

  if (!viewer.canViewIncidents) {
    return res.json({ success: true, incidents: [] });
  }

  res.json({
    success: true,
    incidents: StatusService.getIncidents().map((incident) => ({
      ...incident,
      durationMinutes: incident.resolvedAt
        ? Number(
            ((new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()) / 60000).toFixed(1)
          )
        : null,
    })),
  });
});

/**
 * Incident management. Requires an authenticated developer account - previously
 * these were gated on a caller-supplied clientId, which anyone could set.
 */
router.post('/incidents', requireAuth, requireDeveloper, (req, res, next) => {
  try {
    const incident = StatusService.recordIncident(req.body || {});
    res.status(201).json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

router.post('/incidents/:id/resolve', requireAuth, requireDeveloper, (req, res, next) => {
  try {
    const incident = StatusService.resolveIncident(req.params.id, req.body || {});
    res.json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

router.delete('/incidents/:id', requireAuth, requireDeveloper, (req, res, next) => {
  try {
    const incident = StatusService.deleteIncident(req.params.id);
    res.json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
