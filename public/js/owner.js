/**
 * The owner panel: the platform as its operator sees it.
 *
 * Reads /api/owner/* with the same session token the dashboard uses. The
 * server decides who is an owner; this page only asks, and shows the
 * refusal when the answer is no. Every table is drawn from the server's
 * figures; nothing is computed here that the API could get wrong.
 */
'use strict';

const API_URL = `${window.location.origin}/api`;
const PAYOUT_PILL = { PENDING: 'pending', PROCESSING: 'verifying', COMPLETED: 'paid', PARTIAL: 'awaiting', FAILED: 'failed' };
const PAYOUT_LABEL = { PENDING: 'Pending', PROCESSING: 'Sending', COMPLETED: 'Paid', PARTIAL: 'Partial', FAILED: 'Failed' };
const TX_PILL = { PENDING: 'pending', PROCESSING: 'verifying', CONFIRMED: 'confirmed', COMPLETED: 'confirmed', FAILED: 'failed' };
const TX_LABEL = { PENDING: 'Pending', PROCESSING: 'Confirming', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', FAILED: 'Failed' };
const SESSION_PILL = { PENDING: 'pending', AWAITING_PAYMENT: 'awaiting_payment', VERIFYING: 'verifying', PAID: 'paid', INSUFFICIENT: 'insufficient', EXPIRED: 'expired' };
const FEE_PILL = { PROCESSING: 'verifying', CONFIRMED: 'confirmed', FAILED: 'failed' };
const REFRESH_MS = 30 * 1000;

const STATE = {
    page: 'overview',
    chains: {},          // code -> public chain info, for names and explorer links
    merchants: [],
    merchantQuery: '',
    payoutStatus: '',
    txStatus: '',
    sessionStatus: '',
    usagePeriod: 'day',
    usageChart: null,
    flowChart: null,
    merchantId: null,
    loadedAt: 0,
    chainFilter: 'problems',
    chainsSnapshot: null,
    openPayouts: new Set(),
    searchQuery: '',
    // pages that have drawn real data once: a refresh keeps what is there,
    // a first visit shows the skeleton
    loaded: new Set(),
    lastMerchantId: null,
    lastSearch: '',
};

// ── Plumbing ─────────────────────────────────────────────────────────────────

function token() {
    return localStorage.getItem('authToken');
}

async function api(route, options = {}) {
    const response = await fetch(`${API_URL}${route}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) },
    });
    if (response.status === 401) {
        logout();
        throw new Error('Session expired');
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) {
        denied();
        throw new Error(data.message || 'Owner access required');
    }
    if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    return data;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
    const v = Number(n) || 0;
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function count(n) {
    return (Number(n) || 0).toLocaleString('en-US');
}

function amount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '0';
    if (n > 0 && n < 0.00000001) return '<0.00000001';
    return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function when(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '<span class="when"><b>—</b></span>';
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const day = d.toDateString() === now.toDateString() ? 'Today' : d.toDateString() === yesterday.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `<span class="when"><b>${escapeHtml(day)}</b><span>${escapeHtml(d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span></span>`;
}

function ago(iso) {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return 'never';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

/** "4 h 12 min", "3 min", "40 s". */
function duration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h < 48) return `${h} h${m ? ` ${m} min` : ''}`;
    return `${(s / 86400).toFixed(1)} d`;
}

/** "▲ 18%" against the previous period, or "new" when there was nothing to compare. */
function delta(now, before, { goodWhenUp = true } = {}) {
    const a = Number(now) || 0;
    const b = Number(before) || 0;
    if (!b) return a ? { text: 'new', tone: 'flat' } : { text: '', tone: 'flat' };
    const pct = Math.round(((a - b) / b) * 100);
    if (pct === 0) return { text: '· unchanged', tone: 'flat' };
    const up = pct > 0;
    return { text: `${up ? '▲' : '▼'} ${Math.abs(pct)}%`, tone: up === goodWhenUp ? 'up' : 'down' };
}

function ink(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function chainName(code) {
    return (STATE.chains[code] && STATE.chains[code].name) || code || '';
}

function hashCell(chain, hash) {
    if (!hash) return '<span class="own-mono">—</span>';
    const info = STATE.chains[chain] || {};
    const short = `${escapeHtml(String(hash).slice(0, 8))}…${escapeHtml(String(hash).slice(-4))}`;
    const link = info.explorer && info.explorer.tx ? `${info.explorer.tx}${hash}` : null;
    return `<span class="own-mono" title="${escapeHtml(hash)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${short}</a>` : short}</span>`;
}

function addressCell(chain, address) {
    if (!address) return '<span class="own-mono">—</span>';
    const info = STATE.chains[chain] || {};
    const short = `${escapeHtml(String(address).slice(0, 8))}…${escapeHtml(String(address).slice(-4))}`;
    const link = info.explorer && info.explorer.address ? `${info.explorer.address}${address}` : null;
    return `<span class="own-mono" title="${escapeHtml(address)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${short}</a>` : short}</span>`;
}

function pill(map, labels, status) {
    const s = String(status || '').toUpperCase();
    return `<span class="status-pill status-pill--${map[s] || 'pending'}">${escapeHtml((labels && labels[s]) || s.toLowerCase().replace(/_/g, ' '))}</span>`;
}

function merchantLink(id, username) {
    return `<a class="own-link" data-on-click="openMerchant" data-arg="${escapeHtml(id)}">${escapeHtml(username || (id ? `${String(id).slice(0, 8)}…` : '—'))}</a>`;
}

function empty(colspan, text) {
    return `<tr class="dash-table__empty"><td colspan="${colspan}">${escapeHtml(text)}</td></tr>`;
}

// ── Skeletons ────────────────────────────────────────────────────────────────

const sk = (kind) => `<span class="sk sk--${kind}" aria-hidden="true"></span>`;
const skRows = (colspan, n = 5) => Array.from({ length: n }, () => `<tr class="sk-row"><td colspan="${colspan}">${sk('short')}${sk('num')}${sk('pill')}</td></tr>`).join('');
const skKv = (n = 6) => Array.from({ length: n }, () => `<div class="own-kv__row sk-row"><span>${sk('kv')}</span><span>${sk('kv')}</span></div>`).join('');

function setSk(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}
function setSkText(id) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = sk(el.classList.contains('dash-balance') || el.classList.contains('dash-head__title') ? 'big' : 'num');
}

/** What each page looks like before its first answer. */
const SKELETONS = {
    overview() {
        setSkText('ovVolume');
        for (const id of ['ovMerchants', 'ovOnChain', 'ovPayouts30', 'ovFees30', 'ovFeesHeld', 'ovChains']) setSkText(id);
        for (const id of ['ovMerchantsNew', 'ovPayouts30Count', 'ovFeesDelta', 'ovFeesNext', 'ovChainsProblems', 'ovVolumeDelta']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
        skeletonChart('ovChart', STATE.flowChart);
        setSk('ovAttention', Array.from({ length: 4 }, () => `<div class="own-attention__row sk-row">${sk('line')}</div>`).join(''));
        setSk('ovPayoutRows', skRows(4, 4));
    },
    search() {
        document.getElementById('searchTitle').textContent = STATE.searchQuery;
        document.getElementById('searchLede').innerHTML = sk('short');
        setSk('searchResults', `<div class="own-results__group">${sk('num')}</div>${Array.from({ length: 4 }, () => `<div class="own-results__row"><span>${sk('num')}</span><span>${sk('line')}</span><span>${sk('num')}</span><span>${sk('pill')}</span></div>`).join('')}`);
    },
    merchants() { setSk('merchantRows', skRows(9, 6)); },
    merchant() {
        setSkText('mName');
        document.getElementById('mLede').innerHTML = sk('line');
        setSk('mFacts', Array.from({ length: 4 }, () => `<div><b>${sk('num')}</b><span>${sk('short')}</span></div>`).join(''));
        setSk('mWalletRows', skRows(6, 4)); setSk('mPayoutRows', skRows(5, 3)); setSk('mSessionRows', skRows(5, 3)); setSk('mTxRows', skRows(6, 3));
    },
    payouts() { setSk('payoutRows', skRows(9, 6)); },
    inflight() { setSk('txRows', skRows(9, 4)); },
    checkout() { setSk('sessionRows', skRows(7, 6)); },
    fees() {
        setSkText('feeHeld');
        for (const id of ['feeCollected', 'feeHeldWallets', 'feeThreshold', 'feeConfigured']) setSkText(id);
        setSk('feeHeldRows', skRows(6, 4)); setSk('feeByChainRows', skRows(3, 3)); setSk('feeRecentRows', skRows(8, 4));
        setSk('feeAddresses', Array.from({ length: 7 }, () => `<div class="own-addresses__row"><b>${sk('num')}</b><span>${sk('line')}</span></div>`).join(''));
    },
    usage() {
        setSkText('usageTotal');
        skeletonChart('usageChart', STATE.usageChart);
        setSk('usageMerchantRows', skRows(2, 4)); setSk('usageEndpointRows', skRows(2, 4));
    },
    chains() { setSk('chainRows', skRows(6, 8)); setSk('chainEventRows', Array.from({ length: 4 }, () => `<div class="own-events__row"><time>${sk('num')}</time><b>${sk('num')}</b><span>${sk('line')}</span></div>`).join('')); },
    server() {
        setSkText('serverTitle');
        document.getElementById('serverLede').innerHTML = sk('line');
        setSk('serverFacts', Array.from({ length: 5 }, () => `<div><b>${sk('num')}</b><span>${sk('short')}</span></div>`).join(''));
        setSk('serverLog', Array.from({ length: 6 }, () => `<div class="line">${sk('line')}</div>`).join(''));
        setSk('serverConfig', skKv(8)); setSk('serverFloat', skKv(3));
    },
};

/** A chart not yet drawn hides behind one ghost; painting twice adds none. */
function skeletonChart(canvasId, drawn) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || drawn) return;
    if (!canvas.parentElement.querySelector('[data-sk-chart]')) canvas.insertAdjacentHTML('beforebegin', '<div class="sk sk--chart" data-sk-chart aria-hidden="true"></div>');
    canvas.hidden = true;
}

/** The canvas comes back before it is drawn, so the chart sizes to it. */
function unskeletonChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.hidden = false;
    canvas.parentElement.querySelectorAll('[data-sk-chart]').forEach((ghost) => ghost.remove());
}

/** The first time a page is opened (or a new merchant, a new search), it is drawn as a skeleton. */
function paintSkeleton(page) {
    const fresh = !STATE.loaded.has(page)
        || (page === 'merchant' && STATE.merchantId !== STATE.lastMerchantId)
        || (page === 'search' && STATE.searchQuery !== STATE.lastSearch);
    if (fresh && SKELETONS[page]) SKELETONS[page]();
}

function toast(message, type = 'success', duration = 4000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { el.classList.add('removing'); setTimeout(() => el.remove(), 300); }, duration);
}

function pressChips(groupEl, value) {
    if (!groupEl) return;
    groupEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.getAttribute('data-arg') || '') === value)));
}

function denied() {
    document.querySelectorAll('.dashboard-page').forEach((el) => { el.style.display = 'none'; });
    document.getElementById('dashNavLinks').hidden = true;
    document.getElementById('notOwner').hidden = false;
}

function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('clientId');
    localStorage.removeItem('username');
    window.location.href = '/auth';
}

// ── Pages ────────────────────────────────────────────────────────────────────

const LOADERS = {
    search: () => STATE.searchQuery ? loadSearch(STATE.searchQuery) : Promise.resolve(),
    overview: loadOverview,
    merchants: loadMerchants,
    merchant: () => STATE.merchantId ? loadMerchant(STATE.merchantId) : Promise.resolve(),
    payouts: loadPayouts,
    inflight: loadTransactions,
    checkout: loadSessions,
    fees: loadFees,
    usage: loadUsage,
    chains: loadChains,
    server: loadServer,
};

function switchOwnerPage(page) {
    if (!LOADERS[page]) return;
    STATE.page = page;
    document.querySelectorAll('.dashboard-page').forEach((el) => { el.style.display = 'none'; });
    const el = document.getElementById(`${page}Page`);
    if (el) el.style.display = 'block';
    document.querySelectorAll('.nav-link').forEach((link) => {
        const active = link.getAttribute('data-arg') === (page === 'merchant' ? 'merchants' : page) && page !== 'search';
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    window.scrollTo({ top: 0 });
    paintSkeleton(page);
    refreshCurrentPage();
}

function refreshCurrentPage() {
    const page = STATE.page;
    const loader = LOADERS[page];
    if (!loader) return;
    loader().then(() => {
        STATE.loaded.add(page);
        if (page === 'merchant') STATE.lastMerchantId = STATE.merchantId;
        if (page === 'search') STATE.lastSearch = STATE.searchQuery;
    }).catch((error) => {
        if (/Owner access|Session expired/.test(error.message)) return;
        toast(error.message, 'error');
        // a skeleton that never fills is a page that looks stuck
        document.querySelectorAll(`#${page}Page .sk-row`).forEach((row) => {
            if (row.tagName === 'TR') row.outerHTML = `<tr class="dash-table__empty"><td colspan="9">Could not load: ${escapeHtml(error.message)}</td></tr>`;
            else row.remove();
        });
        document.querySelectorAll(`#${page}Page .sk`).forEach((el) => { el.replaceWith(document.createTextNode('—')); });
    });
}

async function loadOverview() {
    const d = await api('/owner/overview');
    STATE.loadedAt = Date.now();
    const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

    // the head: the month's payout volume, against the month before
    document.getElementById('ovVolume').textContent = money(d.payouts.last30d.volumeUsd);
    const vd = delta(d.payouts.last30d.volumeUsd, d.payouts.previous30d.volumeUsd);
    const vdEl = document.getElementById('ovVolumeDelta');
    vdEl.textContent = vd.text ? `${vd.text} vs the 30 days before` : '';
    vdEl.className = `own-delta ${vd.tone}`;
    tickLive();

    // six facts, each with direction where there is something to compare
    document.getElementById('ovMerchants').textContent = count(d.merchants.total);
    document.getElementById('ovMerchantsNew').textContent = d.merchants.newLast7d ? `· ${d.merchants.newLast7d} new this week` : `· ${count(d.merchants.activeLast30d)} active`;
    document.getElementById('ovOnChain').textContent = money(d.wallets.onChainUsd);
    document.getElementById('ovPayouts30').textContent = money(d.payouts.last30d.volumeUsd);
    document.getElementById('ovPayouts30Count').textContent = `· ${plural(d.payouts.last30d.count, 'payout')}`;
    document.getElementById('ovFees30').textContent = money(d.payouts.last30d.feesUsd);
    const fd = delta(d.payouts.last30d.feesUsd, d.payouts.previous30d.feesUsd);
    const fdEl = document.getElementById('ovFeesDelta');
    fdEl.textContent = fd.text ? `· ${fd.text}` : '';
    fdEl.className = fd.tone;
    document.getElementById('ovFeesHeld').textContent = money(d.fees.heldUsd);
    document.getElementById('ovFeesNext').textContent = d.fees.nextRunAt ? `· sweep in ${duration((new Date(d.fees.nextRunAt).getTime() - Date.now()) / 1000)}` : (d.fees.configured ? '' : '· no address set');
    const up = d.chains.counts ? d.chains.counts.up || 0 : 0;
    const total = d.chains.counts ? Object.values(d.chains.counts).reduce((s, n) => s + n, 0) : 0;
    document.getElementById('ovChains').textContent = total ? `${up} / ${total}` : '–';
    const probs = document.getElementById('ovChainsProblems');
    probs.textContent = d.chains.problems.length ? `· ${d.chains.problems.map((p) => p.code).join(', ')}` : (d.chains.checkedAt ? '· all clear' : '· not checked yet');
    probs.className = d.chains.problems.length ? 'is-bad' : 'is-ok';

    unskeletonChart('ovChart');
    drawFlowChart(d.trend || []);

    document.getElementById('ovPayoutsSub').textContent = `${plural(d.payouts.total, 'payout')} across every merchant`;
    document.getElementById('ovPayoutRows').innerHTML = d.latest.payouts.length
        ? d.latest.payouts.map((p) => `<tr>
            <td>${when(p.createdAt)}</td>
            <td>${merchantLink(p.clientId, p.username)}<span class="own-sub">${escapeHtml(chainName(p.payoutChain))}${p.payoutAsset && p.payoutAsset !== (STATE.chains[p.payoutChain] || {}).symbol ? ` · ${escapeHtml(p.payoutAsset)}` : ''}</span></td>
            <td class="num">${money(p.totalAmountUsd)}<span class="own-sub">fee ${money(p.platformFee)}</span></td>
            <td>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</td>
        </tr>`).join('')
        : empty(4, 'No payouts yet.');

    // attention, ranked: money at risk first, then things to top up or look at, then the scheduled
    const attention = [];
    const stuck = d.transactions.stuck || [];
    if (stuck.length) attention.push({ tone: 'bad', text: `<b>${plural(stuck.length, 'transfer')}</b> in flight past the usual time · ${[...new Set(stuck.map((t) => chainName(t.chain)))].join(', ')}`, page: 'inflight' });
    if (d.transactions.failedLast7d) attention.push({ tone: 'bad', text: `<b>${plural(d.transactions.failedLast7d, 'failed transfer')}</b> this week`, page: 'inflight' });
    for (const p of d.chains.problems) attention.push({ tone: p.status === 'down' ? 'bad' : 'warn', text: `<b>${escapeHtml(p.name)}</b> is ${escapeHtml(p.status)}`, page: 'chains' });
    if (d.server && d.server.errorsLastHour) attention.push({ tone: 'warn', text: `<b>${plural(d.server.errorsLastHour, 'error')}</b> logged in the last hour`, page: 'server' });
    if (d.server && d.server.pricesFresh === false) attention.push({ tone: 'warn', text: '<b>Prices</b> are stale · payouts are refused until the feed answers', page: 'server' });
    if (d.gasFloat && d.gasFloat.enabled) {
        // running low is worth a line each; never funded is one line, quietly
        const low = (d.gasFloat.balances || []).filter((b) => b.balance != null && b.balance > 0 && b.balance < 0.002);
        const unfunded = (d.gasFloat.balances || []).filter((b) => b.balance === 0);
        for (const b of low) attention.push({ tone: 'warn', text: `<b>Gas float</b> on ${escapeHtml(chainName(b.chain))} holds ${escapeHtml(amount(b.balance))} ${escapeHtml((STATE.chains[b.chain] || {}).symbol || '')} · about ${Math.floor(b.balance / 0.0002)} advances left`, page: 'server' });
        if (unfunded.length && unfunded.length < (d.gasFloat.balances || []).length) attention.push({ tone: 'none', text: `<b>Gas float</b> not funded on ${unfunded.map((b) => escapeHtml(chainName(b.chain))).join(', ')}`, page: 'server' });
    }
    if (d.payouts.byStatus.PARTIAL) attention.push({ tone: 'warn', text: `<b>${plural(d.payouts.byStatus.PARTIAL, 'partial payout')}</b>`, page: 'payouts' });
    if (d.transactions.inFlight - stuck.length > 0) attention.push({ tone: 'info', text: `<b>${plural(d.transactions.inFlight - stuck.length, 'transfer')}</b> in flight, within the usual time`, page: 'inflight' });
    if (!d.fees.configured) attention.push({ tone: 'warn', text: `No fee address set: <b>${money(d.fees.heldUsd)}</b> stays held in merchants' wallets`, page: 'fees' });
    else if (d.fees.heldUsd > 0) attention.push({ tone: 'info', text: `<b>${money(d.fees.heldUsd)}</b> in fees held across ${plural(d.fees.heldWallets, 'wallet')}${d.fees.nextRunAt ? ` · next sweep in ${duration((new Date(d.fees.nextRunAt).getTime() - Date.now()) / 1000)}` : ''}`, page: 'fees' });
    if (d.checkout.open) attention.push({ tone: 'none', text: `<b>${plural(d.checkout.open, 'payment link')}</b> open${d.checkout.oldestOpenAt ? `, oldest ${escapeHtml(ago(d.checkout.oldestOpenAt))}` : ''}`, page: 'checkout' });
    document.getElementById('ovAttention').innerHTML = attention.length
        ? attention.map((a) => `<div class="own-attention__row is-${a.tone}"><span>${a.text}</span><a data-on-click="switchOwnerPage" data-arg="${a.page}">Open ›</a></div>`).join('')
        : '<div class="dash-empty">Nothing needs a look.</div>';
}

/** Three bars a day: paid in, withdrawn, fees. */
function drawFlowChart(trend) {
    const canvas = document.getElementById('ovChart');
    if (!canvas || !window.Chart) return;
    if (STATE.flowChart) STATE.flowChart.destroy();
    const labels = trend.map((b) => new Date(`${b.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }));
    STATE.flowChart = new window.Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [
            { label: 'Paid in', data: trend.map((b) => b.paidInUsd), backgroundColor: ink('--ink-3', '#6b7280'), borderRadius: 2 },
            { label: 'Withdrawn', data: trend.map((b) => b.withdrawnUsd), backgroundColor: ink('--ink', '#1a1a1a'), borderRadius: 2 },
            { label: 'Fees', data: trend.map((b) => b.feesUsd), backgroundColor: ink('--ok', '#1f7a43'), borderRadius: 2 },
        ] },
        options: {
            responsive: true, animation: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } } },
            scales: {
                x: { grid: { display: false }, ticks: { color: ink('--ink-3', '#6b7280'), maxTicksLimit: 8, font: { size: 10 } } },
                y: { beginAtZero: true, suggestedMax: 10, grid: { color: ink('--line', '#e5e5e5') }, ticks: { color: ink('--ink-3', '#6b7280'), font: { size: 10 }, maxTicksLimit: 6, callback: (v) => (v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${Math.round(v)}`) } },
            },
        },
    });
}

/** The head's pulse: how long since the page last asked the server. */
function tickLive() {
    const el = document.getElementById('ovLive');
    if (!el || !STATE.loadedAt) return;
    const s = Math.round((Date.now() - STATE.loadedAt) / 1000);
    el.textContent = s < 5 ? 'Live · just now' : `Live · ${s < 60 ? `${s}s` : `${Math.round(s / 60)} min`} ago`;
}

// ── Search ───────────────────────────────────────────────────────────────────

function submitSearch(event) {
    if (event && event.preventDefault) event.preventDefault();
    // whichever of the two search forms submitted (the rail's, or the page's on a tablet)
    const form = event && event.target && event.target.closest ? event.target.closest('form') : null;
    const input = (form && form.querySelector('input[type="search"]')) || document.getElementById('ownerSearch');
    const q = (input.value || '').trim();
    if (q.length < 3) { toast('Search needs at least three characters', 'error'); return; }
    document.querySelectorAll('.own-search input').forEach((el) => { el.value = q; });
    STATE.searchQuery = q;
    switchOwnerPage('search');
}

function mark(text, q) {
    const s = String(text || '');
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escapeHtml(s);
    return `${escapeHtml(s.slice(0, i))}<mark>${escapeHtml(s.slice(i, i + q.length))}</mark>${escapeHtml(s.slice(i + q.length))}`;
}

async function loadSearch(q) {
    const d = await api(`/owner/search?q=${encodeURIComponent(q)}`);
    document.getElementById('searchTitle').textContent = q;
    const kinds = ['merchants', 'wallets', 'transactions', 'sessions', 'payouts', 'fees'].filter((k) => d[k].length);
    document.getElementById('searchLede').textContent = d.total ? `${count(d.total)} match${d.total === 1 ? '' : 'es'} across ${kinds.length} kind${kinds.length === 1 ? '' : 's'}` : 'Nothing carries this term. Hashes and addresses must match whole; names and references match anywhere.';
    const short = (v) => (v ? `${String(v).slice(0, 8)}…${String(v).slice(-4)}` : '—');
    const groups = [];
    if (d.merchants.length) groups.push(`<div class="own-results__group">Merchants · ${d.merchants.length}</div>${d.merchants.map((m) => `<div class="own-results__row"><span>${escapeHtml(new Date(m.createdAt).toLocaleDateString())}</span><span><b>${mark(m.username, q)}</b><span class="own-sub">${mark(m.id, q)}</span></span><span class="own-sub">last signed in ${escapeHtml(ago(m.lastLogin))}</span><span>${merchantLink(m.id, 'Open merchant ›')}</span></div>`).join('')}`);
    if (d.wallets.length) groups.push(`<div class="own-results__group">Wallets · ${d.wallets.length}</div>${d.wallets.map((w) => `<div class="own-results__row"><span>${escapeHtml(chainName(w.chain))}</span><span><span class="own-mono">${mark(w.address, q)}</span><span class="own-sub">${escapeHtml(w.username || '')}${w.label ? ` · ${mark(w.label, q)}` : ''} · ${escapeHtml(amount(w.balance))} ${escapeHtml((STATE.chains[w.chain] || {}).symbol || '')}${w.platformFeeHeld > 0 ? ` · ${escapeHtml(amount(w.platformFeeHeld))} held` : ''}${w.closedAt ? ' · closed' : ''}</span></span><span class="own-sub">read ${escapeHtml(ago(w.lastUpdated))}</span><span>${merchantLink(w.clientId, 'Open merchant ›')}</span></div>`).join('')}`);
    if (d.transactions.length) groups.push(`<div class="own-results__group">Transfers · ${d.transactions.length}</div>${d.transactions.map((t) => `<div class="own-results__row"><span>${escapeHtml(new Date(t.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span><span>${escapeHtml(kindOf(t))} · ${escapeHtml(amount(t.nativeAmount))} ${escapeHtml(t.asset || (STATE.chains[t.chain] || {}).symbol || '')} on ${escapeHtml(chainName(t.chain))} · <span class="own-mono">${mark(t.transactionHash || '', q)}</span><span class="own-sub">from ${mark(t.fromAddress, q)}${t.toAddress ? ` · to ${mark(t.toAddress, q)}` : ''}${t.preSwapTxHash ? ` · pre-swap ${mark(t.preSwapTxHash, q)}` : ''} · ${escapeHtml(t.username || '')}</span></span><span class="own-sub">${money(t.usdAmount)}</span><span>${pill(TX_PILL, TX_LABEL, t.status)}</span></div>`).join('')}`);
    if (d.payouts.length) groups.push(`<div class="own-results__group">Payouts · ${d.payouts.length}</div>${d.payouts.map((p) => `<div class="own-results__row"><span>${escapeHtml(new Date(p.createdAt).toLocaleDateString())}</span><span><b>${escapeHtml(p.username || '')}</b> · ${money(p.totalAmountUsd)} to ${escapeHtml(chainName(p.payoutChain))} <span class="own-mono">${mark(p.recipientAddress, q)}</span><span class="own-sub">${p.legs.map((l) => `${escapeHtml(l.chain)} ${escapeHtml(l.route)} ${l.txHash ? mark(short(l.txHash), q) : ''}`).join(' · ')}</span></span><span class="own-sub">fee ${money(p.platformFee)}</span><span>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</span></div>`).join('')}`);
    if (d.sessions.length) groups.push(`<div class="own-results__group">Payment links · ${d.sessions.length}</div>${d.sessions.map((s) => `<div class="own-results__row"><span>${escapeHtml(new Date(s.createdAt).toLocaleDateString())}</span><span>${money(s.usdAmount)} on ${escapeHtml(chainName(s.chain))}${s.reference ? ` · ${mark(s.reference, q)}` : ''}<span class="own-sub">${mark(s.id, q)} · ${escapeHtml(s.username || '')}${s.paidTxHash ? ` · paid ${mark(short(s.paidTxHash), q)}` : ''}</span></span><span class="own-sub">${escapeHtml(s.paidAt ? `paid ${ago(s.paidAt)}` : '')}</span><span>${pill(SESSION_PILL, null, s.status)}</span></div>`).join('')}`);
    if (d.fees.length) groups.push(`<div class="own-results__group">Fee collections · ${d.fees.length}</div>${d.fees.map((f) => `<div class="own-results__row"><span>${escapeHtml(new Date(f.createdAt).toLocaleDateString())}</span><span>${escapeHtml(amount(f.amount))} ${escapeHtml(f.asset)} on ${escapeHtml(chainName(f.chain))} · <span class="own-mono">${mark(f.txHash || '', q)}</span><span class="own-sub">${f.via === 'payout' ? 'in the withdrawal' : (f.via === 'closure' ? 'closed wallet' : 'swept')} · ${escapeHtml(f.username || '')}</span></span><span class="own-sub">${money(f.usd)}</span><span>${pill(FEE_PILL, null, f.status)}</span></div>`).join('')}`);
    document.getElementById('searchResults').innerHTML = groups.join('') || '';
}

async function loadMerchants() {
    const d = await api('/owner/merchants?limit=500');
    STATE.merchants = d.merchants;
    renderMerchants();
}

function renderMerchants() {
    const q = STATE.merchantQuery.toLowerCase();
    const rows = STATE.merchants.filter((m) => !q || m.username.toLowerCase().includes(q) || m.id.toLowerCase().startsWith(q));
    document.getElementById('merchantRows').innerHTML = rows.length
        ? rows.map((m) => `<tr class="row" tabindex="0" data-on-click="openMerchant" data-arg="${escapeHtml(m.id)}">
            <td><b>${escapeHtml(m.username)}</b>${m.owner ? ' <small class="asset-tag">owner</small>' : ''}${m.developer ? ' <small class="asset-tag">dev</small>' : ''}<span class="own-sub">${m.apiKeyPrefix ? `key ${escapeHtml(m.apiKeyPrefix)}…` : 'no API key'} · joined ${escapeHtml(new Date(m.createdAt).toLocaleDateString())}</span></td>
            <td class="num">${count(m.wallets)}</td>
            <td class="num">${money(m.onChainUsd)}</td>
            <td class="num">${m.feesHeldUsd > 0 ? money(m.feesHeldUsd) : '—'}</td>
            <td class="num">${count(m.payouts)}</td>
            <td class="num">${money(m.payoutVolumeUsd)}</td>
            <td class="num">${count(m.paidSessions)}${m.paidUsd ? `<span class="own-sub">${money(m.paidUsd)}</span>` : ''}</td>
            <td>${escapeHtml(ago(m.lastActivity))}</td>
            <td>›</td>
        </tr>`).join('')
        : empty(9, STATE.merchants.length ? `No merchant matches "${STATE.merchantQuery}".` : 'No merchants yet.');
}

function filterMerchants(event) {
    STATE.merchantQuery = (event && event.target ? event.target.value : '').trim();
    renderMerchants();
}

function openMerchant(id) {
    STATE.merchantId = id;
    switchOwnerPage('merchant');
}

async function loadMerchant(id) {
    const d = await api(`/owner/merchants/${encodeURIComponent(id)}`);
    const m = d.merchant;
    document.getElementById('mName').textContent = m.username;
    document.getElementById('mLede').textContent = `Joined ${new Date(m.createdAt).toLocaleDateString()} · last signed in ${ago(m.lastLogin)} · ${m.apiKeyPrefix ? `API key ${m.apiKeyPrefix}…` : 'no API key'} · ${d.usage.last24h} requests today, ${count(d.usage.total)} all time`;
    const onChain = d.wallets.reduce((s, w) => s + (w.balanceUSD || 0) + (w.tokensUSD || 0), 0);
    const held = d.wallets.reduce((s, w) => s + (w.platformFeeHeldUSD || 0) + Object.values(w.platformFeeHeldTokens || {}).reduce((t, v) => t + (Number(v) || 0), 0), 0);
    document.getElementById('mFacts').innerHTML = `
        <div><b>${money(onChain)}</b><span>On chain across ${count(d.wallets.length)} wallet${d.wallets.length === 1 ? '' : 's'}</span></div>
        <div><b>${money(held)}</b><span>Platform fee held</span></div>
        <div><b>${money(d.payouts.reduce((s, p) => s + p.totalAmountUsd, 0))}</b><span>Withdrawn <em>· ${count(d.payouts.length)} payouts</em></span></div>
        <div><b>${money(d.sessions.filter((s) => s.status === 'PAID').reduce((s, x) => s + (Number(x.usdAmount) || 0), 0))}</b><span>Paid through links <em>· ${count(d.sessions.filter((s) => s.status === 'PAID').length)}</em></span></div>`;

    document.getElementById('mWalletsSub').textContent = `${count(d.wallets.length)} wallet${d.wallets.length === 1 ? '' : 's'}`;
    document.getElementById('mWalletRows').innerHTML = d.wallets.length
        ? d.wallets.map((w) => `<tr>
            <td class="chain">${escapeHtml(chainName(w.chain))}${w.label ? `<span class="own-sub">${escapeHtml(w.label)}</span>` : ''}${w.closedAt ? ` <small class="asset-tag" title="Closed ${escapeHtml(new Date(w.closedAt).toLocaleString())}">closed</small>` : (w.isActive === false ? ' <small class="asset-tag">inactive</small>' : '')}</td>
            <td>${addressCell(w.chain, w.address)}</td>
            <td class="num">${escapeHtml(amount(w.balance))} ${escapeHtml((STATE.chains[w.chain] || {}).symbol || '')}<span class="own-sub">${money(w.balanceUSD)}</span></td>
            <td class="num">${w.tokensUSD ? money(w.tokensUSD) : '—'}</td>
            <td class="num">${w.platformFeeHeld > 0 || Object.keys(w.platformFeeHeldTokens || {}).length ? `${escapeHtml(amount(w.platformFeeHeld))}${Object.entries(w.platformFeeHeldTokens || {}).map(([s, v]) => ` + ${escapeHtml(amount(v))} ${escapeHtml(s)}`).join('')}` : '—'}</td>
            <td>${escapeHtml(ago(w.lastUpdated))}</td>
        </tr>`).join('')
        : empty(6, 'No wallets.');

    document.getElementById('mPayoutsSub').textContent = `${count(d.payouts.length)} most recent`;
    document.getElementById('mPayoutRows').innerHTML = d.payouts.length
        ? d.payouts.map((p) => `<tr><td>${when(p.createdAt)}</td><td>${escapeHtml(chainName(p.payoutChain))} ${addressCell(p.payoutChain, p.recipientAddress)}</td><td class="num">${money(p.totalAmountUsd)}</td><td class="num">${money(p.platformFee)}</td><td>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</td></tr>`).join('')
        : empty(5, 'No payouts.');
    document.getElementById('mSessionsSub').textContent = `${count(d.sessions.length)} most recent`;
    document.getElementById('mSessionRows').innerHTML = d.sessions.length
        ? d.sessions.map((s) => `<tr><td>${when(s.createdAt)}</td><td class="chain">${escapeHtml(chainName(s.chain))}</td><td class="num">${money(s.usdAmount)}</td><td>${escapeHtml(s.reference || '—')}</td><td>${pill(SESSION_PILL, null, s.status)}</td></tr>`).join('')
        : empty(5, 'No payment links.');
    document.getElementById('mTxSub').textContent = `${count(d.transactions.length)} most recent`;
    document.getElementById('mTxRows').innerHTML = d.transactions.length
        ? d.transactions.map((t) => `<tr><td>${when(t.createdAt)}</td><td>${escapeHtml(kindOf(t))}</td><td class="chain">${escapeHtml(chainName(t.chain))}${t.asset && t.asset !== (STATE.chains[t.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(t.asset)}</small>` : ''}</td><td class="num">${escapeHtml(amount(t.nativeAmount))}<span class="own-sub">${money(t.usdAmount)}</span></td><td>${hashCell(t.chain, t.transactionHash)}</td><td>${pill(TX_PILL, TX_LABEL, t.status)}${t.failureReason ? `<span class="own-sub">${escapeHtml(t.failureReason)}</span>` : ''}</td></tr>`).join('')
        : empty(6, 'No transfers.');
}

function kindOf(t) {
    const type = String(t.type || '').toUpperCase();
    if (type === 'DEPOSIT') return 'Received';
    if (type === 'FEE_COLLECTION') return 'Platform fee';
    if (t.route === 'dex') return 'On-chain swap';
    if (t.route === 'thorchain') return 'THORChain';
    if (t.route === 'sideshift') return 'SideShift';
    if (t.route === 'dex+thorchain' || t.route === 'dex+sideshift') return 'Swapped twice';
    if (type === 'DIRECT_TRANSFER' || t.route === 'direct') return 'Direct';
    return type ? type.toLowerCase().replace(/_/g, ' ') : 'Transfer';
}

function legTone(status) {
    return status === 'CONFIRMED' ? 'up' : status === 'FAILED' ? 'down' : 'degraded';
}

function routeWords(l) {
    const out = l.payoutAsset || '';
    switch (l.route) {
        case 'direct': return 'Direct';
        case 'dex': return `On-chain swap${l.provider ? ` via ${l.provider}` : ''}`;
        case 'thorchain': return 'THORChain';
        case 'sideshift': return 'SideShift';
        case 'dex+thorchain': return `Swap${l.provider ? ` via ${l.provider}` : ''}, then THORChain`;
        case 'dex+sideshift': return `Swap${l.provider ? ` via ${l.provider}` : ''}, then SideShift`;
        default: return l.route || out;
    }
}

function legsHtml(p) {
    if (!p.legs || !p.legs.length) return '<div class="own-legs"><div class="own-leg"><span>No transfer breakdown recorded.</span></div></div>';
    return `<div class="own-legs">${p.legs.map((l) => `<div class="own-leg">
        <span><b>${escapeHtml(chainName(l.chain))} · ${escapeHtml(l.asset || '')}</b><span class="own-sub">${escapeHtml(amount(l.nativeAmount))} ${escapeHtml(l.asset || '')}${l.expectedOutputAmount ? ` → ${escapeHtml(amount(l.expectedOutputAmount))} ${escapeHtml(l.payoutAsset || '')}` : ''}</span></span>
        <span>${escapeHtml(routeWords(l))}${l.feeOutput ? '<span class="own-sub">fee paid in the transaction</span>' : ''}${l.gasAdvanceUsd ? `<span class="own-sub">gas advanced ${money(l.gasAdvanceUsd)}</span>` : ''}</span>
        <span>${l.txHash ? hashCell(l.chain, l.txHash) : '<span class="own-mono">—</span>'}${l.preSwapTxHash ? `<span class="own-sub">pre-swap ${hashCell(l.chain, l.preSwapTxHash)}</span>` : ''}${l.memo ? `<span class="own-sub own-mono" title="${escapeHtml(l.memo)}">memo ${escapeHtml(l.memo)}</span>` : ''}${l.failureReason ? `<span class="own-sub is-bad">${escapeHtml(l.failureReason)}${l.failureDetail ? ` · ${escapeHtml(l.failureDetail)}` : ''}</span>` : ''}</span>
        <span class="num">fee ${money(l.platformFeeUSD)}<span class="own-sub">gas ${money(l.gasUsd)}</span></span>
        <span>${pill(TX_PILL, TX_LABEL, l.status)}</span>
    </div>`).join('')}</div>`;
}

function togglePayout(id) {
    if (STATE.openPayouts.has(id)) STATE.openPayouts.delete(id); else STATE.openPayouts.add(id);
    const row = document.querySelector(`tr[data-payout="${CSS.escape(id)}"]`);
    const detail = document.querySelector(`tr[data-payout-detail="${CSS.escape(id)}"]`);
    if (!row || !detail) return;
    const open = STATE.openPayouts.has(id);
    row.classList.toggle('own-open', open);
    row.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
}

async function loadPayouts() {
    const d = await api(`/owner/payouts?limit=200${STATE.payoutStatus ? `&status=${STATE.payoutStatus}` : ''}`);
    document.getElementById('payoutsLede').textContent = `${count(d.total)} payout${d.total === 1 ? '' : 's'}${STATE.payoutStatus ? ` ${STATE.payoutStatus.toLowerCase()}` : ''}, newest first. Open a row for its legs.`;
    document.getElementById('payoutRows').innerHTML = d.payouts.length
        ? d.payouts.map((p) => {
            const open = STATE.openPayouts.has(p.id);
            const legs = Object.entries(p.transfersByStatus).map(([s, n]) => `<span class="own-dot own-dot--${legTone(s)}"></span>${n} ${s.toLowerCase()}`).join(' &nbsp;') || '—';
            return `<tr class="row${open ? ' own-open' : ''}" tabindex="0" aria-expanded="${open}" data-payout="${escapeHtml(p.id)}" data-on-click="togglePayout" data-arg="${escapeHtml(p.id)}">
            <td>${when(p.createdAt)}</td>
            <td>${merchantLink(p.clientId, p.username)}</td>
            <td>${escapeHtml(chainName(p.payoutChain))}${p.payoutAsset && p.payoutAsset !== (STATE.chains[p.payoutChain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(p.payoutAsset)}</small>` : ''} ${addressCell(p.payoutChain, p.recipientAddress)}</td>
            <td class="num">${money(p.totalAmountUsd)}</td>
            <td class="num">${money(p.platformFee)}</td>
            <td class="num">${money(p.netAmountUsd)}</td>
            <td>${legs}</td>
            <td>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</td>
            <td>${open ? '⌄' : '›'}</td>
        </tr><tr class="own-detail" data-payout-detail="${escapeHtml(p.id)}"${open ? '' : ' hidden'}><td colspan="9">${legsHtml(p)}</td></tr>`;
        }).join('')
        : empty(9, 'No payouts.');
}

function filterPayouts(status) {
    STATE.payoutStatus = status || '';
    pressChips(document.getElementById('payoutChips'), STATE.payoutStatus);
    loadPayouts().catch((e) => toast(e.message, 'error'));
}

function txRowHtml(t) {
    const inFlight = ['PENDING', 'PROCESSING'].includes(String(t.status).toUpperCase());
    const age = inFlight
        ? `<span class="own-age${t.stuck ? ' is-stuck' : ''}"><b>${escapeHtml(duration(t.ageSeconds))}</b><span class="own-sub">usual ~${escapeHtml(duration(t.usualSeconds))}</span></span>`
        : when(t.createdAt);
    return `<tr data-tx="${escapeHtml(t.id)}">
            <td>${age}</td>
            <td>${merchantLink(t.clientId, t.username)}</td>
            <td>${escapeHtml(kindOf(t))}</td>
            <td class="chain">${escapeHtml(chainName(t.chain))}${t.asset && t.asset !== (STATE.chains[t.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(t.asset)}</small>` : ''}</td>
            <td class="num">${escapeHtml(amount(t.nativeAmount))}<span class="own-sub">${money(t.usdAmount)}</span></td>
            <td>${hashCell(t.chain, t.transactionHash)}</td>
            <td>${t.lastKnownStatus ? `${escapeHtml(t.lastKnownStatus)}<span class="own-sub">${escapeHtml(ago(t.lastCheckedAt))}</span>` : '—'}</td>
            <td>${pill(TX_PILL, TX_LABEL, t.status)}${t.failureReason ? `<span class="own-sub">${escapeHtml(t.failureReason)}</span>` : ''}</td>
            <td>${inFlight ? `<button class="btn-small btn-secondary" type="button" data-on-click="recheckOne" data-arg="${escapeHtml(t.id)}">Re-check</button>` : ''}</td>
        </tr>`;
}

async function loadTransactions() {
    const d = await api(`/owner/transactions?limit=200${STATE.txStatus ? `&status=${STATE.txStatus}` : ''}`);
    const stuck = d.transactions.filter((t) => t.stuck).length;
    const btn = document.getElementById('recheckAllBtn');
    if (btn) btn.hidden = STATE.txStatus !== '';
    document.querySelector('#inflightPage .dash-head__title').textContent = STATE.txStatus
        ? `${count(d.total)} ${STATE.txStatus.toLowerCase()} transfer${d.total === 1 ? '' : 's'}`
        : (d.total ? `${count(d.total)} transfer${d.total === 1 ? '' : 's'} the chains have not settled${stuck ? ` · ${stuck} past the usual time` : ''}` : 'Nothing in flight');
    document.getElementById('txRows').innerHTML = d.transactions.length
        ? d.transactions.map(txRowHtml).join('')
        : empty(9, STATE.txStatus ? `No ${STATE.txStatus.toLowerCase()} transfers.` : 'Nothing in flight.');
}

async function recheckOne(id, event) {
    const button = document.querySelector(`tr[data-tx="${CSS.escape(id)}"] button`);
    if (button) button.classList.add('is-busy');
    try {
        const r = await api(`/owner/transactions/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: '{}' });
        const row = document.querySelector(`tr[data-tx="${CSS.escape(id)}"]`);
        if (row) row.outerHTML = txRowHtml(r.transaction);
        toast(r.error ? `Could not check: ${r.error}` : (r.outcome === 'pending' ? `Still ${r.transaction.lastKnownStatus || 'pending'} on the chain` : `Now ${r.outcome}`), r.error ? 'error' : 'success');
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) button.classList.remove('is-busy');
    }
}

async function recheckAll(event) {
    const button = event && event.target ? event.target.closest('button') : null;
    if (button) button.classList.add('is-busy');
    try {
        const r = await api('/owner/transactions/recheck', { method: 'POST', body: '{}' });
        toast(r.resolved ? `${r.resolved} settled or failed; ${r.inFlight} still in flight` : `All ${r.inFlight} still in flight`);
        await loadTransactions();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) button.classList.remove('is-busy');
    }
}

function filterTransactions(status) {
    STATE.txStatus = status || '';
    pressChips(document.querySelector('#inflightPage .dash-chips'), STATE.txStatus);
    loadTransactions().catch((e) => toast(e.message, 'error'));
}

async function loadSessions() {
    const d = await api(`/owner/sessions?limit=200${STATE.sessionStatus ? `&status=${STATE.sessionStatus}` : ''}`);
    document.getElementById('checkoutLede').textContent = `${count(d.total)} payment link${d.total === 1 ? '' : 's'}${STATE.sessionStatus ? ` ${STATE.sessionStatus.toLowerCase().replace(/_/g, ' ')}` : ''}, newest first.`;
    document.getElementById('sessionRows').innerHTML = d.sessions.length
        ? d.sessions.map((s) => `<tr>
            <td>${when(s.createdAt)}</td>
            <td>${merchantLink(s.clientId, s.username)}</td>
            <td class="chain">${escapeHtml(chainName(s.chain))}${s.asset && s.asset !== (STATE.chains[s.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(s.asset)}</small>` : ''}</td>
            <td class="num">${money(s.usdAmount)}<span class="own-sub">${escapeHtml(amount(s.nativeAmount))}</span></td>
            <td>${escapeHtml(s.reference || '—')}</td>
            <td>${s.paidTxHash ? hashCell(s.chain, s.paidTxHash) : '—'}</td>
            <td>${pill(SESSION_PILL, null, s.status)}</td>
        </tr>`).join('')
        : empty(7, 'No payment links.');
}

function filterSessions(status) {
    STATE.sessionStatus = status || '';
    pressChips(document.querySelector('#checkoutPage .dash-chips'), STATE.sessionStatus);
    loadSessions().catch((e) => toast(e.message, 'error'));
}

async function loadFees() {
    const d = await api('/owner/fees');
    document.getElementById('feeHeld').textContent = money(d.held.usd);
    document.getElementById('feeNext').textContent = d.nextRunAt ? `· next sweep in ${duration((new Date(d.nextRunAt).getTime() - Date.now()) / 1000)}` : (d.configured ? '· no sweep scheduled' : '· no address set');
    document.getElementById('feeCollected').textContent = money(d.collected.usd);
    document.getElementById('feeCollectedCount').textContent = `· ${count(d.collected.count)}`;
    document.getElementById('feeHeldWallets').textContent = count(d.held.wallets);
    document.getElementById('feeThreshold').textContent = money(d.thresholds.minUsd);
    const families = Object.entries(d.addresses);
    const set = families.filter(([, a]) => a).length;
    document.getElementById('feeConfigured').textContent = `${set} / ${families.length}`;
    document.getElementById('feeHeldRows').innerHTML = d.held.rows.length
        ? d.held.rows.sort((a, b) => b.usd - a.usd).map((r) => `<tr>
            <td class="chain">${escapeHtml(chainName(r.chain))}${r.asset !== (STATE.chains[r.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(r.asset)}</small>` : ''}${r.closed ? ' <small class="asset-tag">closed</small>' : ''}</td>
            <td>${merchantLink(r.clientId, r.username)}</td>
            <td>${addressCell(r.chain, r.address)}</td>
            <td class="num">${escapeHtml(amount(r.held))}</td>
            <td class="num">${escapeHtml(amount(r.onChain))}${r.held > r.onChain ? '<span class="own-sub is-bad">less than held</span>' : ''}</td>
            <td class="num">${money(r.usd)}</td>
        </tr>`).join('')
        : empty(6, 'Nothing held.');
    document.getElementById('feeAddresses').innerHTML = families.map(([family, address]) => `<div class="own-addresses__row"><b>${escapeHtml(family)}</b>${address ? `<span class="own-mono" title="${escapeHtml(address)}">${escapeHtml(address)}</span>` : `<span class="unset">not set - PLATFORM_FEE_ADDRESS_${escapeHtml(family)}</span>`}</div>`).join('');
    document.getElementById('feeByChainRows').innerHTML = d.collected.byChain.length
        ? d.collected.byChain.sort((a, b) => b.usd - a.usd).map((c) => `<tr><td class="chain">${escapeHtml(chainName(c.chain))}</td><td class="num">${count(c.count)}</td><td class="num">${money(c.usd)}</td></tr>`).join('')
        : empty(3, 'Nothing collected yet.');
    document.getElementById('feeRecentRows').innerHTML = d.recent.length
        ? d.recent.map((r) => `<tr>
            <td>${when(r.createdAt)}</td>
            <td class="chain">${escapeHtml(chainName(r.chain))}</td>
            <td>${merchantLink(r.clientId, r.username)}</td>
            <td class="num">${escapeHtml(amount(r.amount))} ${escapeHtml(r.asset)}</td>
            <td class="num">${money(r.usd)}</td>
            <td>${r.via === 'payout' ? 'In the withdrawal' : (r.via === 'closure' ? 'Closed wallet' : 'Swept')}</td>
            <td>${hashCell(r.chain, r.txHash)}</td>
            <td>${pill(FEE_PILL, null, r.status)}</td>
        </tr>`).join('')
        : empty(8, 'No collections yet.');
}

function renderPlan(out, title, result) {
    const planned = result.planned || result.collected || [];
    const rows = (list, kind) => list.map((c) => `<tr>
        <td class="chain">${escapeHtml(chainName(c.chain))}${c.asset !== (STATE.chains[c.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(c.asset)}</small>` : ''}${c.closed ? ' <small class="asset-tag">closed</small>' : ''}</td>
        <td>${addressCell(c.chain, c.address || (c.wallet && c.wallet.address) || '')}</td>
        <td class="num">${escapeHtml(amount(kind === 'skipped' ? c.held : c.amount))}</td>
        <td class="num">${money(c.usd)}</td>
        <td class="num">${c.gasUsd != null ? money(c.gasUsd) : '—'}</td>
        <td>${kind === 'planned' ? (c.txHash ? hashCell(c.chain, c.txHash) : 'would send') : (kind === 'failed' ? `<span class="is-bad">${escapeHtml(c.error)}</span>` : `<span class="why">${escapeHtml(c.reason)}</span>`)}</td>
    </tr>`).join('');
    const table = (list, kind, emptyText) => `<div class="own-scroll"><table class="dash-table"><thead><tr><th>Chain</th><th>Wallet</th><th class="num">Amount</th><th class="num">USD</th><th class="num">Gas</th><th>${kind === 'planned' ? 'Transaction' : 'Why'}</th></tr></thead><tbody>${list.length ? rows(list, kind) : empty(6, emptyText)}</tbody></table></div>`;
    const lines = [];
    if (result.note) lines.push(`<p class="own-plan__note">${escapeHtml(result.note)}</p>`);
    lines.push(`<h3>${escapeHtml(title)}: ${planned.length}</h3>${table(planned, 'planned', 'Nothing clears the thresholds right now.')}`);
    if (result.failed && result.failed.length) lines.push(`<h3>Failed: ${result.failed.length}</h3>${table(result.failed, 'failed', '')}`);
    lines.push(`<h3>Waiting: ${(result.skipped || []).length}</h3>${table(result.skipped || [], 'skipped', 'Nothing else held.')}`);
    out.innerHTML = lines.join('');
    out.hidden = false;
}

async function feePlan(event) {
    const button = event && event.target ? event.target.closest('button') : null;
    if (button) button.classList.add('is-busy');
    try {
        const result = await api('/owner/fees/plan', { method: 'POST', body: '{}' });
        renderPlan(document.getElementById('feePlanOut'), 'Would collect', result);
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) button.classList.remove('is-busy');
    }
}

async function feeCollect(event) {
    if (!window.confirm('Sweep every held fee that clears the thresholds to the platform addresses now? Each is a real transaction from the merchant\'s wallet.')) return;
    const button = event && event.target ? event.target.closest('button') : null;
    if (button) button.classList.add('is-busy');
    try {
        const result = await api('/owner/fees/collect', { method: 'POST', body: '{}' });
        renderPlan(document.getElementById('feePlanOut'), 'Collected', result);
        toast(result.collected.length ? `${result.collected.length} collection${result.collected.length === 1 ? '' : 's'} sent` : 'Nothing to collect right now', result.failed && result.failed.length ? 'error' : 'success');
        await loadFees();
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) button.classList.remove('is-busy');
    }
}

async function feeReconcile() {
    try {
        const result = await api('/owner/fees/reconcile', { method: 'POST', body: '{}' });
        toast(`${result.changed} held figure${result.changed === 1 ? '' : 's'} capped at what the wallet holds`);
        await loadFees();
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function loadUsage() {
    const d = await api(`/owner/usage?period=${STATE.usagePeriod}`);
    document.getElementById('usageTotal').textContent = count(d.total);
    document.getElementById('usageLede').textContent = `Authenticated requests, last ${STATE.usagePeriod === 'week' ? '7 days' : '24 hours'} · ${count(d.errors.reduce((s, n) => s + n, 0))} answered 4xx or 5xx`;
    const labels = d.labels.map((iso) => {
        const t = new Date(iso);
        return STATE.usagePeriod === 'week' ? t.toLocaleDateString(undefined, { weekday: 'short' }) : `${String(t.getHours()).padStart(2, '0')}:00`;
    });
    const canvas = document.getElementById('usageChart');
    unskeletonChart('usageChart');
    if (STATE.usageChart) STATE.usageChart.destroy();
    if (window.Chart) {
        const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000';
        const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#b3261e';
        STATE.usageChart = new window.Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [
                { label: 'Requests', data: d.values, backgroundColor: ink, borderRadius: 3 },
                { label: 'Errors', data: d.errors, backgroundColor: danger, borderRadius: 3 },
            ] },
            options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: false, beginAtZero: true, ticks: { precision: 0 } } } },
        });
    }
    document.getElementById('usageMerchantRows').innerHTML = d.topMerchants.length
        ? d.topMerchants.map((m) => `<tr><td>${merchantLink(m.clientId, m.username)}</td><td class="num">${count(m.calls)}</td></tr>`).join('')
        : empty(2, 'No requests in the window.');
    document.getElementById('usageEndpointRows').innerHTML = d.topEndpoints.length
        ? d.topEndpoints.map((e) => `<tr><td><span class="own-mono" style="max-width: 40ch">${escapeHtml(e.endpoint)}</span></td><td class="num">${count(e.calls)}</td></tr>`).join('')
        : empty(2, 'No requests in the window.');
}

function setUsagePeriod(period) {
    STATE.usagePeriod = period === 'week' ? 'week' : 'day';
    pressChips(document.querySelector('#usagePage .dash-chips'), STATE.usagePeriod);
    loadUsage().catch((e) => toast(e.message, 'error'));
}

function ticksHtml(days) {
    if (!Array.isArray(days) || !days.length) return '<span class="own-sub">no history yet</span>';
    return `<span class="own-ticks" title="Last ${days.length} days">${days.map((d) => `<i class="${d.status === 'down' ? 'd' : d.status === 'partial' ? 'p' : (d.status === 'unknown' || d.status == null ? 'n' : '')}" title="${escapeHtml(d.date || '')}${d.downtimeMinutes ? ` · ${escapeHtml(duration(d.downtimeMinutes * 60))} unreachable` : ''}"></i>`).join('')}</span>`;
}

function renderChains() {
    const d = STATE.chainsSnapshot;
    if (!d) return;
    const order = { down: 0, degraded: 1, unknown: 2, up: 3 };
    const worth = (ch) => ch.status !== 'up' || (ch.rpc && (ch.rpc.partial || ch.rpc.stalled));
    let list = d.chains.slice().sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.name.localeCompare(b.name));
    if (STATE.chainFilter === 'problems') list = list.filter(worth);
    else if (STATE.chainFilter === 'evm') list = list.filter((ch) => ch.family === 'evm');
    else if (STATE.chainFilter === 'utxo') list = list.filter((ch) => ch.family === 'utxo');
    const c = d.counts || {};
    document.getElementById('chainsTitle').textContent = d.checkedAt ? `${c.up || 0} up${c.degraded ? ` · ${c.degraded} degraded` : ''}${c.down ? ` · ${c.down} down` : ''}` : 'Every chain, as the monitor sees it';
    document.getElementById('chainsLede').textContent = d.checkedAt
        ? `Checked ${ago(d.checkedAt)}; endpoints, the tip and the swap routes off each chain, probed every ${Math.round((d.intervalMs || 300000) / 60000)} minutes.${c.unknown ? ` ${c.unknown} not yet checked.` : ''} ${STATE.chainFilter === 'problems' ? `Showing the ${list.length} with something to look at.` : `Showing ${list.length}.`}`
        : 'The first sweep runs shortly after the server starts.';
    document.getElementById('chainRows').innerHTML = list.length ? list.map((ch) => {
        const rpc = ch.rpc || {};
        const routes = Object.entries(ch.routes || {}).map(([name, state]) => `<span class="own-dot own-dot--${escapeHtml(String(state) === 'up' ? 'up' : (/down|off|error/.test(String(state)) ? 'down' : (String(state) === 'unlisted' || String(state) === 'none' ? 'unknown' : 'degraded')))}"></span>${escapeHtml(name)} ${escapeHtml(String(state))}`).join(' &nbsp; ');
        const quota = new Set(rpc.quota || []);
        const endpoints = rpc.endpoints ? `${rpc.endpointsUp}/${rpc.endpoints}${rpc.latencyMs != null ? ` · ${rpc.latencyMs} ms` : ''}${rpc.down && rpc.down.length ? `<span class="own-sub is-bad">${rpc.down.map((u) => `${escapeHtml(String(u).replace(/^https?:\/\//, ''))}${quota.has(u) ? ' (quota spent)' : ''}`).join(', ')} down</span>` : ''}${rpc.stalled ? '<span class="own-sub is-bad">tip not moving</span>' : ''}` : (rpc.error ? `<span class="is-bad">${escapeHtml(String(rpc.error).slice(0, 80))}</span>` : '—');
        return `<tr>
            <td class="chain"><span class="own-dot own-dot--${escapeHtml(ch.status || 'unknown')}"></span><b>${escapeHtml(ch.name)}</b> <span class="own-sub" style="display:inline">${escapeHtml(ch.code)} · ${escapeHtml(ch.family)}</span></td>
            <td>${ticksHtml(ch.days)}</td>
            <td>${endpoints}</td>
            <td class="num">${rpc.tip != null ? count(rpc.tip) : '—'}</td>
            <td><span class="own-sub" style="font-size: 12px">${routes || 'direct only'}</span></td>
            <td>${ch.since ? escapeHtml(ago(ch.since)) : '—'}</td>
        </tr>`;
    }).join('') : empty(6, STATE.chainFilter === 'problems' ? 'Every chain is up with every endpoint answering.' : 'No chains match.');
    document.getElementById('chainEventRows').innerHTML = (d.events || []).length
        ? d.events.slice(0, 40).map((e) => `<div class="own-events__row"><time>${escapeHtml(new Date(e.at).toLocaleString())}</time><b>${escapeHtml(e.chain)}</b><span>${escapeHtml(e.component || '')} ${escapeHtml(e.from || '')} → ${escapeHtml(e.to || '')}${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</span></div>`).join('')
        : '<div class="dash-empty">No changes recorded.</div>';
}

async function loadChains() {
    STATE.chainsSnapshot = await api('/owner/chains');
    renderChains();
}

function filterChains(which) {
    STATE.chainFilter = which || 'problems';
    pressChips(document.getElementById('chainChips'), STATE.chainFilter);
    renderChains();
}

async function checkChainsNow(event) {
    const button = event && event.target ? event.target.closest('button') : null;
    if (button) { button.classList.add('is-busy'); button.textContent = 'Checking…'; }
    try {
        STATE.chainsSnapshot = await api('/owner/chains/check', { method: 'POST', body: '{}' });
        renderChains();
        toast('Every chain checked');
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) { button.classList.remove('is-busy'); button.textContent = 'Check now'; }
    }
}

async function loadServer() {
    const [d, logs] = await Promise.all([api('/owner/server'), api('/owner/logs?lines=200')]);
    const uptime = duration(d.uptimeSeconds);
    document.getElementById('serverTitle').textContent = `Etheroute ${d.version} on Node ${d.node}`;
    document.getElementById('serverLede').textContent = `${d.environment} · up ${uptime} since ${new Date(d.startedAt).toLocaleString()} · ${d.memoryMb} MB resident${d.commit ? ` · commit ${d.commit}` : ''}`;
    document.getElementById('serverFacts').innerHTML = `
        <div><b>${uptime}</b><span>Uptime</span></div>
        <div><b>${d.database.bytes != null ? `${(d.database.bytes / 1048576).toFixed(1)} MB` : '—'}</b><span>${escapeHtml(d.database.file)}${d.database.usagePending ? ` <em>· ${d.database.usagePending} usage rows buffered</em>` : ''}</span></div>
        <div><b>${count(d.chains.total)}</b><span>Chains, ${d.chains.families.length} families</span></div>
        <div><b class="${d.prices.fresh ? '' : 'is-bad'}">${d.prices.fresh ? 'fresh' : 'stale'}</b><span>Prices${d.prices.updatedAt ? ` <em>· ${escapeHtml(ago(d.prices.updatedAt))}</em>` : ''}${d.prices.error ? ` <em class="is-bad">· ${escapeHtml(d.prices.error)}</em>` : ''}</span></div>
        <div><b class="${d.errorsLastHour ? 'is-bad' : ''}">${count(d.errorsLastHour)}</b><span>Errors, last hour</span></div>`;
    document.getElementById('serverLogSub').textContent = `${count(logs.lines.length)} warning${logs.lines.length === 1 ? '' : 's'} and error${logs.lines.length === 1 ? '' : 's'} since the server started ${ago(logs.since)}, newest first`;
    document.getElementById('serverLog').innerHTML = logs.lines.length
        ? logs.lines.map((l) => `<div class="line"><span class="t">${escapeHtml(new Date(l.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span> <span class="${l.level === 'error' ? 'e' : 'w'}">${l.level === 'error' ? 'ERROR' : 'WARN '}</span> ${escapeHtml(l.message)}</div>`).join('')
        : '<div class="line t">Nothing logged at warning or error since the server started.</div>';
    const flag = (on, yes = 'set', no = 'not set', bad = false) => `<span class="${on ? 'is-ok' : (bad ? 'is-bad' : 'is-off')}">${on ? yes : no}</span>`;
    const rows = [
        ['Platform fee rate', `${(d.set.platformFeeRate * 100).toFixed(2)}%`],
        ['Cross-chain preference', d.set.crossChainPrefer ? escapeHtml(d.set.crossChainPrefer) : '<span class="is-off">best quote</span>'],
        ['Etherscan key', flag(d.set.etherscanKey, 'set', 'not set — Etherscan history off', true)],
        ['1rpc.io key', flag(d.set.oneRpcKey)],
        ['BlockCypher token', flag(d.set.blockcypherToken)],
        ['CoinGecko key', flag(d.set.coingeckoKey)],
        ['Alert webhook', flag(d.set.alertWebhook, 'set', 'not set — nobody is paged', true)],
        ['Gas float', flag(d.set.gasFloat, 'configured', 'not configured')],
        ...Object.entries(d.feeAddresses).map(([family, address]) => [`Fee address · ${family}`, address ? `<span class="own-mono" style="max-width: 100%">${escapeHtml(address)}</span>` : '<span class="is-off">not set</span>']),
        ['Fee sweep thresholds', `${money(d.feeThresholds.minUsd)} and ${d.feeThresholds.gasMultiple}× gas`],
    ];
    document.getElementById('serverConfig').innerHTML = rows.map(([k, v]) => `<div class="own-kv__row"><span>${escapeHtml(k)}</span><span>${v}</span></div>`).join('');
    document.getElementById('serverFloatSub').textContent = d.gasFloat.address ? `The coin a token needs to move, advanced from ${d.gasFloat.address}` : 'Not configured: a wallet holding tokens but no coin keeps its tokens.';
    document.getElementById('serverFloat').innerHTML = d.gasFloat.balances.length
        ? d.gasFloat.balances.map((b) => `<div class="own-kv__row"><span>${escapeHtml(chainName(b.chain))}</span><span>${b.balance != null ? `${escapeHtml(amount(b.balance))} ${escapeHtml((STATE.chains[b.chain] || {}).symbol || '')}` : `<span class="is-bad">${escapeHtml(b.error || 'unreadable')}</span>`}</span></div>`).join('')
        : '<div class="dash-empty">Set GAS_FLOAT_PRIVATE_KEY to advance gas for token withdrawals.</div>';
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function snapshotNow(event) {
    const button = event && event.target ? event.target.closest('button') : null;
    if (button) button.classList.add('is-busy');
    try {
        const r = await api('/owner/server/snapshot', { method: 'POST', body: '{}' });
        toast(`Snapshot written: ${r.file} (${r.snapshots} kept)`);
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        if (button) button.classList.remove('is-busy');
    }
}

async function loadChainRegistry() {
    try {
        const response = await fetch(`${API_URL}/chains`);
        const data = await response.json();
        for (const c of data.chains || []) STATE.chains[c.code] = c;
    } catch {
        // names fall back to codes
    }
}

window.addEventListener('load', async () => {
    if (!token()) {
        window.location.href = '/auth';
        return;
    }
    const username = localStorage.getItem('username') || 'User';
    document.getElementById('username').textContent = username;
    document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();
    // the overview is a skeleton from the first paint, not a page of zeros
    paintSkeleton('overview');

    let verify;
    try {
        const response = await fetch(`${API_URL}/auth/verify`, { headers: { Authorization: `Bearer ${token()}` } });
        if (response.status === 401) { logout(); return; }
        verify = await response.json();
    } catch {
        verify = null;
    }
    if (verify && verify.owner === false) {
        denied();
        return;
    }

    await loadChainRegistry();
    switchOwnerPage('overview');

    setInterval(() => {
        if (document.hidden) return;
        if (['overview', 'inflight', 'payouts', 'fees', 'chains'].includes(STATE.page)) refreshCurrentPage();
    }, REFRESH_MS);
    setInterval(tickLive, 5000);

    // "/" focuses the search from anywhere that is not already a field
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        const boxes = [...document.querySelectorAll('.own-search input')].filter((el) => el.offsetParent !== null);
        (boxes[0] || document.getElementById('ownerSearch')).focus();
    });
});

// Dashboard mobile nav toggle, as the dashboard has it.
(function () {
    const toggle = document.getElementById('dashNavToggle');
    const navLinks = document.getElementById('dashNavLinks');
    if (!toggle || !navLinks) return;
    function setOpen(isOpen) {
        navLinks.classList.toggle('open', isOpen);
        toggle.classList.toggle('open', isOpen);
        toggle.setAttribute('aria-expanded', String(isOpen));
    }
    toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!navLinks.classList.contains('open')); });
    navLinks.addEventListener('click', (e) => { if (e.target.closest('.nav-link')) setOpen(false); });
    document.addEventListener('click', (e) => { if (!navLinks.contains(e.target) && !toggle.contains(e.target)) setOpen(false); });
}());

// The handlers the markup names (actions.js resolves them on window).
Object.assign(window, { switchOwnerPage, refreshCurrentPage, openMerchant, filterMerchants, filterPayouts, filterTransactions, filterSessions, feePlan, feeCollect, feeReconcile, setUsagePeriod, logout, submitSearch, togglePayout, recheckOne, recheckAll, filterChains, checkChainsNow, snapshotNow });
