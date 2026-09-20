/**
 * Escape a value for interpolation into HTML.
 *
 * Incident labels, titles and messages are operator-supplied text. Pasting them
 * into markup unescaped lets a crafted incident inject arbitrary elements.
 */
function escapeAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const STATUS_API_URL = `${window.location.origin}/api/status`;

const STATE = {
  data: null,
  pendingDeleteId: null,
};

function getClientId() {
  return localStorage.getItem('clientId') || '';
}

function formatTimestamp(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

/** Just the time of day — the strip caption already says "last checked". */
function formatClockTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

function formatDuration(minutes) {
  if (minutes == null) return '--';
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** A short "Mar 4" style label for a tick's tooltip. */
function formatDayLabel(isoDay) {
  const [year, month, day] = String(isoDay).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function setHeroState(data) {
  const pill = document.getElementById('heroStatusPill');
  const title = document.getElementById('heroTitle');
  const copy = document.getElementById('heroCopy');
  const operational = data.overallStatus === 'operational';

  pill.textContent = data.overallStatusLabel;
  pill.classList.toggle('down', !operational);
  title.textContent = operational ? 'All systems operational' : 'Some services are degraded';
  copy.textContent = operational
    ? 'Live health for the platform, refreshed from the Etheroute status API.'
    : 'One or more services are currently affected. The active incidents are listed below.';

  document.getElementById('overallUptime').textContent = `${data.uptimePercentage.toFixed(2)}%`;
  document.getElementById('operationalCount').textContent = `${data.operationalCount}/${data.totalCount}`;
  document.getElementById('generatedAt').textContent = formatClockTime(data.generatedAt);

  const window = document.getElementById('uptimeWindow');
  if (window && data.windowDays) window.textContent = String(data.windowDays);
}

/**
 * One tick per day, oldest on the left.
 *
 * Every tick carries its own title, so the bar is readable on hover without a
 * tooltip component — and the `days` array is what the server computed, so a
 * day with no recorded incident is genuinely a day with no recorded incident.
 */
function renderUptimeBar(service) {
  const days = service.days || [];
  if (!days.length) return '';

  const ticks = days.map((day) => {
    const tone = day.status === 'down' ? 'down' : day.status === 'partial' ? 'partial' : 'operational';
    const label = day.downtimeMinutes > 0
      ? `${formatDayLabel(day.date)} — ${day.uptimePercentage.toFixed(2)}% (${formatDuration(day.downtimeMinutes)} down)`
      : `${formatDayLabel(day.date)} — no downtime`;
    return `<i class="tick tick--${tone}" title="${escapeAttr(label)}"></i>`;
  }).join('');

  return `
    <div class="uptime-bar" role="img" aria-label="${escapeAttr(
      `${service.label}: ${service.uptimePercentage.toFixed(2)}% uptime over the last ${days.length} days`,
    )}">${ticks}</div>
    <div class="uptime-scale"><span>${days.length} days ago</span><span>today</span></div>
  `;
}

function renderServices(services) {
  const rows = document.getElementById('serviceRows');

  rows.innerHTML = services.map((service) => `
    <article class="service-row">
      <div class="service-row__head">
        <span class="service-row__name">${escapeAttr(service.label)}</span>
        <span class="service-row__desc">${escapeAttr(service.description)}</span>
        <span class="service-row__uptime">${service.uptimePercentage.toFixed(2)}%</span>
      </div>
      ${renderUptimeBar(service)}
      ${service.activeIncident ? `
        <div class="service-row__active">
          <strong>${escapeAttr(service.activeIncident.title)} · since ${escapeAttr(formatTimestamp(service.activeIncident.startedAt))}</strong>
          <p>${escapeAttr(service.activeIncident.message)}</p>
        </div>
      ` : ''}
    </article>
  `).join('');
}

function renderIncidents(selector, incidents, emptyText) {
  const container = document.getElementById(selector);
  if (!incidents.length) {
    container.innerHTML = `<div class="incident-empty">${emptyText}</div>`;
    return;
  }

  container.innerHTML = incidents.map((incident) => `
    <article class="incident-card">
      <div class="incident-card-header">
        <div>
          <h3>${escapeAttr(incident.label)} · ${escapeAttr(incident.title)}</h3>
          <div class="incident-meta">
            ${formatTimestamp(incident.startedAt)}${incident.resolvedAt ? ` · Resolved ${formatTimestamp(incident.resolvedAt)}` : ' · Ongoing'}
            ${incident.durationMinutes != null ? ` · Duration ${formatDuration(incident.durationMinutes)}` : ''}
          </div>
        </div>
        <div class="incident-actions" data-dev-only="true">
          <button class="danger-btn" type="button" data-on-click="openDeleteIncidentModal" data-arg="${incident.id}" data-arg2="${escapeAttr(incident.label)}" data-arg3="${escapeAttr(incident.title)}">Remove</button>
        </div>
      </div>
      <div class="incident-message">${escapeAttr(incident.message)}</div>
    </article>
  `).join('');
}

function populateTargets(scope) {
  const select = document.getElementById('incidentKey');
  const options = scope === 'platform'
    ? [
        { value: 'API', label: 'API' },
        { value: 'WALLET_SYNC', label: 'Wallet Sync' },
        { value: 'CHECKOUTS', label: 'Checkouts' },
        { value: 'PAYOUTS', label: 'Payout Engine' },
      ]
    : [
        { value: 'API', label: 'API' },
        { value: 'WALLET_SYNC', label: 'Wallet Sync' },
        { value: 'CHECKOUTS', label: 'Checkouts' },
        { value: 'PAYOUTS', label: 'Payout Engine' },
      ];

  select.innerHTML = options.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
}

async function loadStatus() {
  const clientId = getClientId();
  const url = clientId ? `${STATUS_API_URL}?clientId=${encodeURIComponent(clientId)}` : STATUS_API_URL;
  const response = await fetch(url);
  const payload = await response.json();
  const data = payload;
  STATE.data = data;

  setHeroState(data);
  renderServices(data.services || []);

  const canViewIncidents = !!data.viewer?.canViewIncidents;
  document.querySelectorAll('[data-dev-only="true"]').forEach((element) => {
    element.style.display = canViewIncidents ? '' : 'none';
  });

  renderIncidents('activeIncidents', canViewIncidents ? (data.activeIncidents || []) : [], 'No active incidents.');
  renderIncidents('incidentHistory', canViewIncidents ? (data.incidents || []) : [], 'No recorded incidents yet.');
}

async function submitIncident(event) {
  event.preventDefault();
  const message = document.getElementById('formMessage');
  const scope = document.getElementById('incidentScope').value;
  const payload = {
    scope,
    key: document.getElementById('incidentKey').value,
    severity: document.getElementById('incidentSeverity').value,
    title: document.getElementById('incidentTitle').value.trim(),
    message: document.getElementById('incidentMessage').value.trim(),
    startedAt: document.getElementById('incidentStartedAt').value || undefined,
    resolvedAt: document.getElementById('incidentResolvedAt').value || undefined,
    clientId: getClientId() || undefined,
  };

  const response = await fetch(`${STATUS_API_URL}/incidents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    message.style.color = 'var(--danger)';
    message.textContent = data.message || 'Failed to record incident';
    return;
  }

  message.style.color = 'var(--ok)';
  message.textContent = 'Incident recorded successfully.';
  event.target.reset();
  populateTargets('chain');
  await loadStatus();
}

async function deleteIncident(incidentId) {
  const clientId = getClientId();
  if (!clientId) {
    return;
  }

  const payload = {
    clientId,
  };

  const response = await fetch(`${STATUS_API_URL}/incidents/${incidentId}?clientId=${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    alert(data.message || 'Failed to remove incident');
    return;
  }

  await loadStatus();
}

function openDeleteIncidentModal(incidentId, label, title) {
  STATE.pendingDeleteId = incidentId;
  const modal = document.getElementById('incidentDeleteModal');
  const message = document.getElementById('incidentDeleteMessage');
  message.textContent = `Remove ${label} incident "${title}"? This cannot be undone.`;
  modal.classList.add('show');
}

function closeDeleteIncidentModal() {
  STATE.pendingDeleteId = null;
  document.getElementById('incidentDeleteModal').classList.remove('show');
}

async function confirmDeleteIncident() {
  if (!STATE.pendingDeleteId) {
    closeDeleteIncidentModal();
    return;
  }

  const incidentId = STATE.pendingDeleteId;
  closeDeleteIncidentModal();
  await deleteIncident(incidentId);
}

window.addEventListener('DOMContentLoaded', async () => {
  const scopeEl = document.getElementById('incidentScope');
  if (scopeEl) scopeEl.addEventListener('change', (event) => populateTargets(event.target.value));
  document.getElementById('incidentForm').addEventListener('submit', submitIncident);
  document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus);
  document.getElementById('closeIncidentDeleteModal').addEventListener('click', closeDeleteIncidentModal);
  document.getElementById('denyIncidentDeleteBtn').addEventListener('click', closeDeleteIncidentModal);
  document.getElementById('confirmIncidentDeleteBtn').addEventListener('click', confirmDeleteIncident);
  document.getElementById('incidentDeleteModal').addEventListener('click', (event) => {
    if (event.target.id === 'incidentDeleteModal') {
      closeDeleteIncidentModal();
    }
  });
  populateTargets('chain');

  try {
    await loadStatus();
  } catch (error) {
    const pill = document.getElementById('heroStatusPill');
    pill.textContent = 'Status unavailable';
    pill.classList.remove('down');
    pill.classList.add('error');
    document.getElementById('heroTitle').textContent = 'Unable to load status';
    document.getElementById('heroCopy').textContent = error.message;
  }
});