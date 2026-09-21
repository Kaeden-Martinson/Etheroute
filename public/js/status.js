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

// ── Chains ──────────────────────────────────────────────────────────────────

const ROUTE_LABEL = { thorchain: 'THORChain', sideshift: 'SideShift', kyber: 'Kyber', paraswap: 'ParaSwap' };
const GOOD_STATES = ['up', 'open'];
const BAD_STATES = ['down', 'stalled', 'halted', 'offline', 'unlisted', 'no-pool', 'thin', 'degraded'];

/** "3 min ago" / "2 h ago" / "4 d ago", from an ISO time. */
function ago(value) {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 90 * 1000) return 'just now';
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)} min ago`;
  if (ms < 48 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)} h ago`;
  return `${Math.round(ms / 86400000)} d ago`;
}

function toneOf(state) {
  if (GOOD_STATES.includes(state)) return 'up';
  if (BAD_STATES.includes(state)) return state === 'thin' || state === 'stalled' || state === 'degraded' ? 'degraded' : 'down';
  return 'unknown';
}

/** The endpoints' word: how many answered, how fast, and the tip. */
function rpcText(chain) {
  const rpc = chain.rpc;
  if (!rpc) return 'not checked yet';
  if (!rpc.ok) return `no endpoint answering${rpc.error ? ` · ${rpc.error.split(' | ')[0].replace(/^https?:\/\/[^:]+: /, '')}` : ''}`;
  const tip = rpc.tip != null ? ` · ${chain.family === 'solana' ? 'slot' : chain.family === 'xrp' ? 'ledger' : 'block'} ${Number(rpc.tip).toLocaleString('en-US')}` : '';
  const stall = rpc.stalled ? ' · tip not moving' : '';
  return `${rpc.endpointsUp}/${rpc.endpoints} endpoint${rpc.endpoints === 1 ? '' : 's'} · ${rpc.latencyMs} ms${tip}${stall}`;
}

function renderChainRow(chain, hidden) {
  const routes = Object.entries(chain.routes || {}).map(([name, state]) =>
    `<span title="${escapeAttr(`${ROUTE_LABEL[name] || name}: ${state}`)}"><i class="dot dot--${toneOf(state)}"></i>${escapeAttr(ROUTE_LABEL[name] || name)}</span>`).join('');
  const days = chain.days || [];
  const bar = days.length ? `<div class="uptime-bar" role="img" aria-label="${escapeAttr(`${chain.name}: last ${days.length} days`)}">${days.map((d) => `<i class="tick tick--${d.status === 'down' ? 'down' : d.status === 'partial' ? 'partial' : 'operational'}" title="${escapeAttr(d.downtimeMinutes > 0 ? `${formatDayLabel(d.date)} — ${formatDuration(d.downtimeMinutes)} unreachable` : `${formatDayLabel(d.date)} — no downtime`)}"></i>`).join('')}</div>` : '';
  return `<article class="chain-row" data-status="${escapeAttr(chain.status)}"${hidden ? ' hidden' : ''}>
    <i class="dot dot--${toneOf(chain.status === 'up' ? 'up' : chain.status)}" title="${escapeAttr(chain.status)}"></i>
    <div class="chain-row__name">${escapeAttr(chain.name)}<span>${escapeAttr(chain.code)}</span></div>
    <div class="chain-row__rpc${chain.rpc && !chain.rpc.ok ? ' is-bad' : ''}">${escapeAttr(rpcText(chain))}</div>
    <div class="chain-row__routes">${routes || '<span>direct only</span>'}</div>
    <div class="chain-row__since" title="${escapeAttr(chain.since ? `${chain.status} since ${formatTimestamp(chain.since)}` : '')}">${chain.since ? `${escapeAttr(chain.status)} · ${escapeAttr(ago(chain.since))}` : 'not checked yet'}</div>
    ${bar}
  </article>`;
}

function renderChains(data) {
  const rows = document.getElementById('chainRows');
  const summary = document.getElementById('chainsSummary');
  const more = document.getElementById('chainMore');
  if (!rows || !data) return;
  const list = (data.chains || []).slice().sort((a, b) => {
    const rank = { down: 0, degraded: 1, unknown: 2, up: 3 };
    return (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || a.name.localeCompare(b.name);
  });
  const problems = list.filter((c) => c.status !== 'up');
  const healthy = list.filter((c) => c.status === 'up');
  const c = data.counts || {};
  const every = data.intervalMs ? ` every ${Math.round(data.intervalMs / 60000)} min` : '';
  summary.textContent = data.checkedAt
    ? `${c.up || 0} up${c.degraded ? ` · ${c.degraded} degraded` : ''}${c.down ? ` · ${c.down} down` : ''} · checked ${ago(data.checkedAt)}${every}. Endpoints, the tip, and the swap routes off each chain.`
    : 'The first sweep runs shortly after the server starts.';
  STATE.showAllChains = STATE.showAllChains || problems.length === 0;
  rows.innerHTML = problems.map((chain) => renderChainRow(chain, false)).join('') + healthy.map((chain) => renderChainRow(chain, !STATE.showAllChains)).join('');
  if (more) {
    more.hidden = problems.length === 0 || healthy.length === 0;
    more.textContent = STATE.showAllChains ? `Hide the ${healthy.length} healthy chains` : `Show the ${healthy.length} healthy chains`;
  }
  renderChainEvents(data.events || []);
}

function renderChainEvents(events) {
  const host = document.getElementById('chainEvents');
  if (!host) return;
  if (!events.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<h3>Recent changes</h3>${events.slice(0, 20).map((e) => `<div class="chain-event">
    <time datetime="${escapeAttr(e.at)}" title="${escapeAttr(formatTimestamp(e.at))}">${escapeAttr(ago(e.at))}</time>
    <div><b>${escapeAttr(e.name || e.chain)}</b> · ${escapeAttr(ROUTE_LABEL[e.component] || e.component)}: ${escapeAttr(e.from)} → <span class="${BAD_STATES.includes(e.to) ? 'to-bad' : 'to-good'}">${escapeAttr(e.to)}</span>${e.detail ? `<small>${escapeAttr(e.detail)}</small>` : ''}</div>
  </div>`).join('')}`;
}

function toggleAllChains() {
  STATE.showAllChains = !STATE.showAllChains;
  if (STATE.chains) renderChains(STATE.chains);
}

async function loadChains() {
  try {
    const response = await fetch(`${STATUS_API_URL}/chains`);
    const data = await response.json();
    STATE.chains = data;
    renderChains(data);
  } catch (error) {
    const summary = document.getElementById('chainsSummary');
    if (summary) summary.textContent = `Chain health unavailable: ${error.message}`;
  }
}

async function loadStatus() {
  loadChains();
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