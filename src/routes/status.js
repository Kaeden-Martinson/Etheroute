const { Router } = require('express');
const StatusService = require('../services/StatusService');
const { ApiError } = require('../utils/errors');

const router = Router();

router.get('/', (req, res) => {
  const clientId = req.body?.clientId || req.query?.clientId || null;
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

router.get('/incidents', (req, res) => {
  const clientId = req.body?.clientId || req.query?.clientId || null;
  const viewer = StatusService.getViewerContext(clientId);

  if (!viewer.canViewIncidents) {
    return res.json({ success: true, incidents: [] });
  }

  res.json({
    success: true,
    incidents: StatusService.getIncidents().map((incident) => ({
      ...incident,
      durationMinutes: incident.resolvedAt
        ? Number(((new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()) / 60000).toFixed(1))
        : null,
    })),
  });
});

router.post('/incidents', (req, res, next) => {
  try {
    const clientId = req.body?.clientId || req.query?.clientId || null;
    const viewer = StatusService.getViewerContext(clientId);

    if (!viewer.canRecordIncidents) {
      throw new ApiError(403, 'Developer access required');
    }

    const incident = StatusService.recordIncident(req.body || {});
    res.status(201).json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

router.post('/incidents/:id/resolve', (req, res, next) => {
  try {
    const clientId = req.body?.clientId || req.query?.clientId || null;
    const viewer = StatusService.getViewerContext(clientId);

    if (!viewer.canRecordIncidents) {
      throw new ApiError(403, 'Developer access required');
    }

    const incident = StatusService.resolveIncident(req.params.id, req.body || {});
    res.json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

router.delete('/incidents/:id', (req, res, next) => {
  try {
    const clientId = req.body?.clientId || req.query?.clientId || null;
    const viewer = StatusService.getViewerContext(clientId);

    if (!viewer.canRecordIncidents) {
      throw new ApiError(403, 'Developer access required');
    }

    const incident = StatusService.deleteIncident(req.params.id);
    res.json({ success: true, incident });
  } catch (error) {
    next(error);
  }
});

module.exports = router;