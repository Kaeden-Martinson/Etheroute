const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');

// Individual chains are no longer listed here: with a chain registry that
// grows, a row per coin is noise. Chain reachability shows up under the
// platform services that depend on it (wallet sync, checkout, payouts).
const CHAIN_SERVICES = [];

const PLATFORM_SERVICES = [
  { key: 'API', label: 'API', kind: 'platform', description: 'Public and authenticated API endpoints' },
  { key: 'WALLET_SYNC', label: 'Wallet Sync', kind: 'platform', description: 'On-chain balance and transaction refresh' },
  { key: 'CHECKOUTS', label: 'Checkouts', kind: 'platform', description: 'Payment links and settlement' },
  { key: 'PAYOUTS', label: 'Payout Engine', kind: 'platform', description: 'Withdrawals, swaps and payout execution' },
];

const WINDOW_DAYS = 30;

class StatusService {
  getDefinitions() {
    return [...CHAIN_SERVICES, ...PLATFORM_SERVICES];
  }

  getIncidents() {
    return (db.getAll('statusIncidents') || []).slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  _getWindows() {
    const now = new Date();
    return {
      now,
      windowStart: new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000),
      windowMinutes: WINDOW_DAYS * 24 * 60,
    };
  }

  _incidentOverlapMinutes(incident, windowStart, windowEnd) {
    const startedAt = new Date(incident.startedAt);
    const resolvedAt = incident.resolvedAt ? new Date(incident.resolvedAt) : windowEnd;
    const start = startedAt > windowStart ? startedAt : windowStart;
    const end = resolvedAt < windowEnd ? resolvedAt : windowEnd;
    const overlap = end.getTime() - start.getTime();
    return overlap > 0 ? overlap / 60000 : 0;
  }

  /**
   * One entry per day in the window, oldest first, for the uptime bar on the
   * status page.
   *
   * Days are bucketed in UTC so the same incident never lands on a different
   * tick for two viewers in different timezones; the date is sent as an ISO day
   * and formatted client-side. Today's bucket only counts the minutes that have
   * actually elapsed, otherwise every day would open at "100% so far" and then
   * appear to degrade as the hours pass.
   */
  _buildDailyHistory(scoped, now) {
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = [];

    for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const dayStart = new Date(startOfToday - offset * dayMs);
      const dayEnd = new Date(Math.min(dayStart.getTime() + dayMs, now.getTime()));
      const elapsedMinutes = Math.max(1, (dayEnd.getTime() - dayStart.getTime()) / 60000);
      const downtimeMinutes = scoped.reduce(
        (sum, incident) => sum + this._incidentOverlapMinutes(incident, dayStart, dayEnd),
        0,
      );
      const uptimePercentage = Math.max(0, 100 - (downtimeMinutes / elapsedMinutes) * 100);

      let status = 'operational';
      if (downtimeMinutes > 0) {
        // A blip and an all-day outage should not paint the same tick.
        status = downtimeMinutes >= elapsedMinutes * 0.25 ? 'down' : 'partial';
      }

      days.push({
        date: dayStart.toISOString().slice(0, 10),
        status,
        downtimeMinutes: Number(downtimeMinutes.toFixed(1)),
        uptimePercentage: Number(uptimePercentage.toFixed(2)),
      });
    }

    return days;
  }

  _buildSummary(definition, incidents, windowStart, windowEnd, windowMinutes) {
    const scoped = incidents.filter((incident) => incident.scope === definition.kind && incident.key === definition.key);
    const activeIncident = scoped.find((incident) => !incident.resolvedAt) || null;
    const downtimeMinutes = scoped.reduce((sum, incident) => sum + this._incidentOverlapMinutes(incident, windowStart, windowEnd), 0);
    const uptimePercentage = Math.max(0, 100 - (downtimeMinutes / windowMinutes) * 100);

    return {
      days: this._buildDailyHistory(scoped, windowEnd),
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      description: definition.description,
      status: activeIncident ? 'degraded' : 'operational',
      statusLabel: activeIncident ? 'Degraded' : 'Operational',
      statusTone: activeIncident ? 'warning' : 'healthy',
      uptimePercentage: Number(uptimePercentage.toFixed(2)),
      downtimeMinutes: Number(downtimeMinutes.toFixed(1)),
      activeIncident: activeIncident ? this._formatIncident(activeIncident) : null,
      latestIncidentAt: scoped[0] ? scoped[0].startedAt : null,
      incidentCount: scoped.length,
    };
  }

  _formatIncident(incident) {
    return {
      ...incident,
      durationMinutes: incident.resolvedAt
        ? Number(((new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()) / 60000).toFixed(1))
        : null,
    };
  }

  getStatusSnapshot() {
    const incidents = this.getIncidents();
    const { now, windowStart, windowMinutes } = this._getWindows();
    const services = this.getDefinitions().map((definition) => this._buildSummary(definition, incidents, windowStart, now, windowMinutes));
    const activeIncidents = incidents.filter((incident) => !incident.resolvedAt).map((incident) => this._formatIncident(incident));
    const recentIncidents = incidents.slice(0, 12).map((incident) => this._formatIncident(incident));
    const operationalCount = services.filter((service) => service.status === 'operational').length;

    return {
      generatedAt: now.toISOString(),
      windowDays: WINDOW_DAYS,
      overallStatus: activeIncidents.length > 0 ? 'degraded' : 'operational',
      overallStatusLabel: activeIncidents.length > 0 ? 'Partial outage' : 'Fully operational',
      uptimePercentage: Number((services.reduce((sum, service) => sum + service.uptimePercentage, 0) / services.length).toFixed(2)),
      operationalCount,
      totalCount: services.length,
      activeIncidents,
      services,
      incidents: recentIncidents,
    };
  }

  getViewerContext(clientId) {
    if (!clientId) {
      return {
        clientId: null,
        isAuthenticated: false,
        isDeveloper: false,
        canViewIncidents: false,
        canRecordIncidents: false,
      };
    }

    const user = db.getById('users', clientId);
    const isDeveloper = !!user?.developer;

    return {
      clientId,
      isAuthenticated: !!user,
      isDeveloper,
      canViewIncidents: isDeveloper,
      canRecordIncidents: isDeveloper,
    };
  }

  recordIncident(payload = {}) {
    const scope = String(payload.scope || '').toLowerCase();
    const key = String(payload.key || '').toUpperCase();
    const service = this.getDefinitions().find((item) => item.kind === scope && item.key === key);

    if (!service) {
      throw new Error(`Unknown status target: ${scope}:${key}`);
    }

    const startedAt = payload.startedAt ? new Date(payload.startedAt).toISOString() : new Date().toISOString();
    const resolvedAt = payload.resolvedAt ? new Date(payload.resolvedAt).toISOString() : null;

    const incident = {
      id: uuidv4(),
      scope,
      key,
      label: service.label,
      title: payload.title || `${service.label} incident`,
      message: payload.message || 'Recorded service downtime',
      severity: payload.severity || 'major',
      status: resolvedAt ? 'resolved' : 'investigating',
      startedAt,
      resolvedAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedBy: payload.resolvedBy || null,
    };

    return db.create('statusIncidents', incident);
  }

  resolveIncident(incidentId, payload = {}) {
    const incident = db.getById('statusIncidents', incidentId);
    if (!incident) {
      throw new Error(`Status incident not found: ${incidentId}`);
    }

    const resolvedAt = payload.resolvedAt ? new Date(payload.resolvedAt).toISOString() : new Date().toISOString();
    return db.update('statusIncidents', incidentId, {
      status: 'resolved',
      resolvedAt,
      updatedAt: new Date().toISOString(),
      resolvedBy: payload.resolvedBy || null,
      message: payload.message || incident.message,
    });
  }

  deleteIncident(incidentId) {
    const incident = db.getById('statusIncidents', incidentId);
    if (!incident) {
      throw new Error(`Status incident not found: ${incidentId}`);
    }

    db.delete('statusIncidents', incidentId);
    return incident;
  }
}

module.exports = new StatusService();