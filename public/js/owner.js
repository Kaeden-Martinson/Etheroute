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
    merchantId: null,
    loadedAt: 0,
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
        const active = link.getAttribute('data-arg') === (page === 'merchant' ? 'merchants' : page);
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    window.scrollTo({ top: 0 });
    refreshCurrentPage();
}

function refreshCurrentPage() {
    const loader = LOADERS[STATE.page];
    if (!loader) return;
    loader().catch((error) => { if (!/Owner access|Session expired/.test(error.message)) toast(error.message, 'error'); });
}

async function loadOverview() {
    const d = await api('/owner/overview');
    STATE.loadedAt = Date.now();
    document.getElementById('ovVolume').textContent = money(d.payouts.volumeUsd);
    document.getElementById('ovAge').textContent = `· ${count(d.payouts.total)} payouts · fees ${money(d.payouts.feesUsd)}`;
    document.getElementById('ovMerchants').textContent = count(d.merchants.total);
    document.getElementById('ovMerchantsNew').textContent = d.merchants.newLast7d ? `· ${d.merchants.newLast7d} new this week` : '';
    document.getElementById('ovOnChain').textContent = money(d.wallets.onChainUsd);
    document.getElementById('ovPayouts30').textContent = money(d.payouts.last30d.volumeUsd);
    document.getElementById('ovPayouts30Count').textContent = `· ${count(d.payouts.last30d.count)}`;
    document.getElementById('ovFees30').textContent = money(d.payouts.last30d.feesUsd);
    document.getElementById('ovCheckout30').textContent = money(d.checkout.last30d.paidUsd);
    document.getElementById('ovCheckout30Count').textContent = `· ${count(d.checkout.last30d.paid)} paid`;
    document.getElementById('ovInFlight').textContent = count(d.transactions.inFlight);
    document.getElementById('ovRequests').textContent = count(d.usage.last24h);
    const errs = document.getElementById('ovErrors');
    errs.textContent = d.usage.errorsLast24h ? `· ${count(d.usage.errorsLast24h)} errors` : '';
    errs.className = d.usage.errorsLast24h ? 'is-bad' : '';
    const up = d.chains.counts ? d.chains.counts.up || 0 : 0;
    const total = d.chains.counts ? Object.values(d.chains.counts).reduce((s, n) => s + n, 0) : 0;
    document.getElementById('ovChains').textContent = total ? `${up} / ${total}` : '–';
    const probs = document.getElementById('ovChainsProblems');
    probs.textContent = d.chains.problems.length ? `· ${d.chains.problems.map((p) => p.code).join(', ')}` : (d.chains.checkedAt ? '· all clear' : '· not checked yet');
    probs.className = d.chains.problems.length ? 'is-bad' : 'is-ok';

    document.getElementById('ovPayoutsSub').textContent = `${count(d.payouts.total)} across every merchant`;
    document.getElementById('ovPayoutRows').innerHTML = d.latest.payouts.length
        ? d.latest.payouts.map((p) => `<tr>
            <td>${when(p.createdAt)}</td>
            <td>${merchantLink(p.clientId, p.username)}</td>
            <td>${escapeHtml(chainName(p.payoutChain))}${p.payoutAsset && p.payoutAsset !== (STATE.chains[p.payoutChain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(p.payoutAsset)}</small>` : ''} ${addressCell(p.payoutChain, p.recipientAddress)}</td>
            <td class="num">${money(p.totalAmountUsd)}</td>
            <td class="num">${money(p.platformFee)}</td>
            <td>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</td>
        </tr>`).join('')
        : empty(6, 'No payouts yet.');

    const attention = [];
    if (d.transactions.inFlight) attention.push({ tone: 'verifying', text: `<b>${count(d.transactions.inFlight)}</b> transfer${d.transactions.inFlight === 1 ? '' : 's'} in flight`, page: 'inflight' });
    if (d.transactions.failedLast7d) attention.push({ tone: 'failed', text: `<b>${count(d.transactions.failedLast7d)}</b> failed transfer${d.transactions.failedLast7d === 1 ? '' : 's'} this week`, page: 'inflight' });
    if (d.payouts.byStatus.PARTIAL) attention.push({ tone: 'awaiting', text: `<b>${count(d.payouts.byStatus.PARTIAL)}</b> partial payout${d.payouts.byStatus.PARTIAL === 1 ? '' : 's'}`, page: 'payouts' });
    for (const p of d.chains.problems) attention.push({ tone: p.status === 'down' ? 'failed' : 'awaiting', text: `<b>${escapeHtml(p.name)}</b> is ${escapeHtml(p.status)}`, page: 'chains' });
    if (!d.fees.configured) attention.push({ tone: 'pending', text: `No fee address set: <b>${money(d.fees.heldUsd)}</b> stays held in merchants' wallets`, page: 'fees' });
    else if (d.fees.heldUsd > 0) attention.push({ tone: 'pending', text: `<b>${money(d.fees.heldUsd)}</b> in fees held across ${count(d.fees.heldWallets)} wallet${d.fees.heldWallets === 1 ? '' : 's'}`, page: 'fees' });
    if (d.checkout.open) attention.push({ tone: 'awaiting_payment', text: `<b>${count(d.checkout.open)}</b> payment link${d.checkout.open === 1 ? '' : 's'} open`, page: 'checkout' });
    document.getElementById('ovAttention').innerHTML = attention.length
        ? attention.map((a) => `<div class="own-attention__row"><span class="status-pill status-pill--${a.tone}">&nbsp;</span><span>${a.text}</span><a data-on-click="switchOwnerPage" data-arg="${a.page}">Open</a></div>`).join('')
        : '<div class="dash-empty">Nothing needs a look.</div>';
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
            <td class="chain">${escapeHtml(chainName(w.chain))}${w.label ? `<span class="own-sub">${escapeHtml(w.label)}</span>` : ''}${w.isActive === false ? ' <small class="asset-tag">inactive</small>' : ''}</td>
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

async function loadPayouts() {
    const d = await api(`/owner/payouts?limit=200${STATE.payoutStatus ? `&status=${STATE.payoutStatus}` : ''}`);
    document.getElementById('payoutsLede').textContent = `${count(d.total)} payout${d.total === 1 ? '' : 's'}${STATE.payoutStatus ? ` ${STATE.payoutStatus.toLowerCase()}` : ''}, newest first.`;
    document.getElementById('payoutRows').innerHTML = d.payouts.length
        ? d.payouts.map((p) => `<tr>
            <td>${when(p.createdAt)}</td>
            <td>${merchantLink(p.clientId, p.username)}</td>
            <td>${escapeHtml(chainName(p.payoutChain))} ${addressCell(p.payoutChain, p.recipientAddress)}</td>
            <td class="num">${money(p.totalAmountUsd)}</td>
            <td class="num">${money(p.platformFee)}</td>
            <td class="num">${money(p.netAmountUsd)}</td>
            <td>${Object.entries(p.transfersByStatus).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ') || '—'}</td>
            <td>${pill(PAYOUT_PILL, PAYOUT_LABEL, p.status)}</td>
        </tr>`).join('')
        : empty(8, 'No payouts.');
}

function filterPayouts(status) {
    STATE.payoutStatus = status || '';
    pressChips(document.getElementById('payoutChips'), STATE.payoutStatus);
    loadPayouts().catch((e) => toast(e.message, 'error'));
}

async function loadTransactions() {
    const d = await api(`/owner/transactions?limit=200${STATE.txStatus ? `&status=${STATE.txStatus}` : ''}`);
    document.getElementById('txRows').innerHTML = d.transactions.length
        ? d.transactions.map((t) => `<tr>
            <td>${when(t.createdAt)}</td>
            <td>${merchantLink(t.clientId, t.username)}</td>
            <td>${escapeHtml(kindOf(t))}</td>
            <td class="chain">${escapeHtml(chainName(t.chain))}${t.asset && t.asset !== (STATE.chains[t.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(t.asset)}</small>` : ''}</td>
            <td class="num">${escapeHtml(amount(t.nativeAmount))}<span class="own-sub">${money(t.usdAmount)}</span></td>
            <td>${hashCell(t.chain, t.transactionHash)}</td>
            <td>${t.lastKnownStatus ? `${escapeHtml(t.lastKnownStatus)}<span class="own-sub">${escapeHtml(ago(t.lastCheckedAt))}</span>` : '—'}</td>
            <td>${pill(TX_PILL, TX_LABEL, t.status)}${t.failureReason ? `<span class="own-sub">${escapeHtml(t.failureReason)}</span>` : ''}</td>
        </tr>`).join('')
        : empty(8, STATE.txStatus ? `No ${STATE.txStatus.toLowerCase()} transfers.` : 'Nothing in flight.');
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
    document.getElementById('feeCollected').textContent = money(d.collected.usd);
    document.getElementById('feeCollectedCount').textContent = `· ${count(d.collected.count)}`;
    document.getElementById('feeHeldWallets').textContent = count(d.held.wallets);
    document.getElementById('feeThreshold').textContent = money(d.thresholds.minUsd);
    const families = Object.entries(d.addresses);
    const set = families.filter(([, a]) => a).length;
    document.getElementById('feeConfigured').textContent = `${set} / ${families.length}`;
    document.getElementById('feeHeldRows').innerHTML = d.held.rows.length
        ? d.held.rows.sort((a, b) => b.usd - a.usd).map((r) => `<tr>
            <td class="chain">${escapeHtml(chainName(r.chain))}${r.asset !== (STATE.chains[r.chain] || {}).symbol ? ` <small class="asset-tag">${escapeHtml(r.asset)}</small>` : ''}</td>
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
            <td>${r.via === 'payout' ? 'In the withdrawal' : 'Swept'}</td>
            <td>${hashCell(r.chain, r.txHash)}</td>
            <td>${pill(FEE_PILL, null, r.status)}</td>
        </tr>`).join('')
        : empty(8, 'No collections yet.');
}

function renderPlan(out, title, result) {
    const planned = result.planned || result.collected || [];
    const lines = [];
    if (result.note) lines.push(`<p class="own-plan__note">${escapeHtml(result.note)}</p>`);
    lines.push(`<h3>${escapeHtml(title)}: ${planned.length}</h3>`);
    lines.push(planned.length
        ? `<ul>${planned.map((c) => `<li><b>${escapeHtml(amount(c.amount))} ${escapeHtml(c.asset)}</b> on ${escapeHtml(chainName(c.chain))} · ${money(c.usd)}${c.gasUsd != null ? ` · gas ${money(c.gasUsd)}` : ''} · from ${escapeHtml(c.address || (c.wallet && c.wallet.address) || '')}${c.txHash ? ` · ${hashCell(c.chain, c.txHash)}` : ''}</li>`).join('')}</ul>`
        : '<ul><li class="why">Nothing clears the thresholds right now.</li></ul>');
    if (result.failed && result.failed.length) {
        lines.push(`<h3>Failed: ${result.failed.length}</h3><ul>${result.failed.map((f) => `<li><b>${escapeHtml(amount(f.amount))} ${escapeHtml(f.asset)}</b> on ${escapeHtml(chainName(f.chain))} <span class="why">${escapeHtml(f.error)}</span></li>`).join('')}</ul>`);
    }
    lines.push(`<h3>Waiting: ${(result.skipped || []).length}</h3>`);
    lines.push((result.skipped || []).length
        ? `<ul>${result.skipped.map((s) => `<li><b>${escapeHtml(amount(s.held))} ${escapeHtml(s.asset)}</b> on ${escapeHtml(chainName(s.chain))} · ${money(s.usd)} <span class="why">${escapeHtml(s.reason)}</span></li>`).join('')}</ul>`
        : '<ul><li class="why">Nothing else held.</li></ul>');
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

async function loadChains() {
    const d = await api('/owner/chains');
    const order = { down: 0, degraded: 1, unknown: 2, up: 3 };
    const list = d.chains.slice().sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.name.localeCompare(b.name));
    const c = d.counts || {};
    document.getElementById('chainsLede').textContent = d.checkedAt
        ? `${c.up || 0} up${c.degraded ? ` · ${c.degraded} degraded` : ''}${c.down ? ` · ${c.down} down` : ''}${c.unknown ? ` · ${c.unknown} not yet checked` : ''} · checked ${ago(d.checkedAt)}. Problems first.`
        : 'The first sweep runs shortly after the server starts.';
    document.getElementById('chainRows').innerHTML = list.map((ch) => {
        const rpc = ch.rpc || {};
        const routes = Object.entries(ch.routes || {}).map(([name, state]) => `<span class="own-dot own-dot--${escapeHtml(String(state) === 'up' ? 'up' : (/down|off|error/.test(String(state)) ? 'down' : (String(state) === 'unlisted' || String(state) === 'none' ? 'unknown' : 'degraded')))}"></span>${escapeHtml(name)} ${escapeHtml(String(state))}`).join(' &nbsp; ');
        const endpoints = rpc.endpoints ? `${rpc.endpointsUp}/${rpc.endpoints}${rpc.latencyMs != null ? ` · ${rpc.latencyMs} ms` : ''}${rpc.down && rpc.down.length ? `<span class="own-sub">${rpc.down.map((u) => escapeHtml(String(u).replace(/^https?:\/\//, ''))).join(', ')} down</span>` : ''}` : (rpc.error ? escapeHtml(String(rpc.error).slice(0, 80)) : '—');
        return `<tr>
            <td class="chain"><span class="own-dot own-dot--${escapeHtml(ch.status || 'unknown')}"></span>${escapeHtml(ch.name)} <span class="own-sub">${escapeHtml(ch.code)} · ${escapeHtml(ch.family)}</span></td>
            <td>${escapeHtml(ch.status || 'unknown')}${rpc.stalled ? '<span class="own-sub is-bad">tip not moving</span>' : ''}</td>
            <td>${endpoints}</td>
            <td class="num">${rpc.tip != null ? count(rpc.tip) : '—'}</td>
            <td><span class="own-sub" style="font-size: 12px">${routes || '—'}</span></td>
            <td>${ch.since ? escapeHtml(ago(ch.since)) : '—'}</td>
        </tr>`;
    }).join('');
    document.getElementById('chainEventRows').innerHTML = (d.events || []).length
        ? d.events.slice(0, 40).map((e) => `<div class="own-events__row"><time>${escapeHtml(new Date(e.at).toLocaleString())}</time><b>${escapeHtml(e.chain)}</b><span>${escapeHtml(e.component || '')} ${escapeHtml(e.from || '')} → ${escapeHtml(e.to || '')}${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</span></div>`).join('')
        : '<div class="dash-empty">No changes recorded.</div>';
}

async function loadServer() {
    const d = await api('/owner/server');
    const up = d.uptimeSeconds;
    const uptime = up < 3600 ? `${Math.round(up / 60)} min` : up < 86400 ? `${(up / 3600).toFixed(1)} h` : `${(up / 86400).toFixed(1)} d`;
    document.getElementById('serverTitle').textContent = `Etheroute ${d.version} on Node ${d.node}`;
    document.getElementById('serverLede').textContent = `${d.environment} · up ${uptime} since ${new Date(d.startedAt).toLocaleString()} · ${d.memoryMb} MB resident`;
    document.getElementById('serverFacts').innerHTML = `
        <div><b>${uptime}</b><span>Uptime</span></div>
        <div><b>${d.database.bytes != null ? `${(d.database.bytes / 1048576).toFixed(1)} MB` : '—'}</b><span>${escapeHtml(d.database.file)}${d.database.usagePending ? ` <em>· ${d.database.usagePending} usage rows buffered</em>` : ''}</span></div>
        <div><b>${count(d.chains.total)}</b><span>Chains, ${d.chains.families.length} families</span></div>
        <div><b class="${d.prices.fresh ? '' : 'is-bad'}">${d.prices.fresh ? 'fresh' : 'stale'}</b><span>Prices${d.prices.updatedAt ? ` <em>· ${escapeHtml(ago(d.prices.updatedAt))}</em>` : ''}${d.prices.error ? ` <em class="is-bad">· ${escapeHtml(d.prices.error)}</em>` : ''}</span></div>`;
    const flag = (on, yes = 'set', no = 'not set') => `<span class="${on ? 'is-ok' : 'is-off'}">${on ? yes : no}</span>`;
    const rows = [
        ['Platform fee rate', `${(d.set.platformFeeRate * 100).toFixed(2)}%`],
        ['Cross-chain preference', d.set.crossChainPrefer ? escapeHtml(d.set.crossChainPrefer) : '<span class="is-off">best quote</span>'],
        ['Etherscan key', flag(d.set.etherscanKey, 'set', 'not set - Etherscan history off')],
        ['1rpc.io key', flag(d.set.oneRpcKey)],
        ['BlockCypher token', flag(d.set.blockcypherToken)],
        ['CoinGecko key', flag(d.set.coingeckoKey)],
        ['Alert webhook', flag(d.set.alertWebhook, 'set', 'not set - nobody is paged')],
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
Object.assign(window, { switchOwnerPage, refreshCurrentPage, openMerchant, filterMerchants, filterPayouts, filterTransactions, filterSessions, feePlan, feeCollect, feeReconcile, setUsagePeriod, logout });
