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

function formatDuration(minutes) {
  if (minutes == null) return '--';
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function setHeroState(data) {
  const pill = document.getElementById('heroStatusPill');
  const title = document.getElementById('heroTitle');
  const copy = document.getElementById('heroCopy');

  pill.textContent = data.overallStatusLabel;
  pill.classList.toggle('down', data.overallStatus !== 'operational');
  title.textContent = data.overallStatus === 'operational' ? 'All systems are operational' : 'Some services are degraded';
  copy.textContent = data.overallStatus === 'operational'
    ? 'Chain services and platform operations are running normally.'
    : 'One or more services are currently affected. We are tracking the active incident(s) below.';

  document.getElementById('overallUptime').textContent = `${data.uptimePercentage.toFixed(2)}%`;
  document.getElementById('operationalCount').textContent = `${data.operationalCount}/${data.totalCount}`;
  document.getElementById('generatedAt').textContent = formatTimestamp(data.generatedAt);
}

function renderServices(services) {
  const grid = document.getElementById('serviceGrid');

  grid.innerHTML = services.map((service) => `
    <article class="service-card">
      <div class="service-head">
        <div class="service-name">
          <strong>${service.label}</strong>
          <span>${service.description}</span>
        </div>
        <div class="pill ${service.statusTone}">${service.statusLabel}</div>
      </div>
      <div class="metric-row">
        <div class="metric-card">
          <span class="label">Uptime</span>
          <strong>${service.uptimePercentage.toFixed(2)}%</strong>
        </div>
        <div class="metric-card">
          <span class="label">Last Incident</span>
          <strong>${service.latestIncidentAt ? formatTimestamp(service.latestIncidentAt) : 'None'}</strong>
        </div>
      </div>
      ${service.activeIncident ? `
        <div class="incident-card" style="margin-top: 12px; background: #fff8f1; border-color: #f6d5bd;">
          <h3>Active incident</h3>
          <div class="incident-meta">${service.activeIncident.title} · ${formatTimestamp(service.activeIncident.startedAt)}</div>
          <div class="incident-message">${service.activeIncident.message}</div>
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
          <h3>${incident.label} · ${incident.title}</h3>
          <div class="incident-meta">
            ${formatTimestamp(incident.startedAt)}${incident.resolvedAt ? ` · Resolved ${formatTimestamp(incident.resolvedAt)}` : ' · Ongoing'}
            ${incident.durationMinutes != null ? ` · Duration ${formatDuration(incident.durationMinutes)}` : ''}
          </div>
        </div>
        <div class="incident-actions" data-dev-only="true">
          <button class="danger-btn" type="button" onclick="openDeleteIncidentModal('${incident.id}', '${incident.label.replace(/'/g, "\\'")}', '${incident.title.replace(/'/g, "\\'")}')">Remove</button>
        </div>
      </div>
      <div class="incident-message">${incident.message}</div>
    </article>
  `).join('');
}

function populateTargets(scope) {
  const select = document.getElementById('incidentKey');
  const options = scope === 'platform'
    ? [
        { value: 'API', label: 'API' },
        { value: 'WALLET_SYNC', label: 'Wallet Sync' },
        { value: 'WITHDRAWALS', label: 'Withdrawals' },
        { value: 'PAYOUTS', label: 'Payout Engine' },
      ]
    : [
        { value: 'ETH', label: 'Ethereum' },
        { value: 'BTC', label: 'Bitcoin' },
        { value: 'SOL', label: 'Solana' },
        { value: 'LTC', label: 'Litecoin' },
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
    message.style.color = '#b45309';
    message.textContent = data.message || 'Failed to record incident';
    return;
  }

  message.style.color = '#0f8a5f';
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
    document.getElementById('heroStatusPill').textContent = 'Status unavailable';
    document.getElementById('heroStatusPill').classList.add('down');
    document.getElementById('heroTitle').textContent = 'Unable to load status';
    document.getElementById('heroCopy').textContent = error.message;
  }
});