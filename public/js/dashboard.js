const API_URL = `${window.location.origin}/api`;
let totalBalanceUSD = 0;
let currentDashboardPage = 'overview';  // Track current page to prevent auto-refresh during withdrawal
let wallets = [];  // Make wallets globally accessible for withdrawal.js

// Withdrawal module variables
let currentStep = 1;
let previewData = null;

// Toast Notification System
function showToast(message, type = 'success', duration = 4000) {
    let container = document.getElementById('toastContainer');
    
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, duration);
}

/**
 * A themed confirmation prompt, replacing the browser's native confirm().
 *
 * Slides in at the top-centre in the same visual language as the toasts, and
 * resolves to true/false so callers can `await confirmDialog(...)`. Only one
 * shows at a time; Escape or the backdrop cancels.
 */
function confirmDialog(options = {}) {
    const {
        title = 'Are you sure?',
        message = '',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        danger = false,
    } = typeof options === 'string' ? { message: options } : options;

    return new Promise((resolve) => {
        // Never stack two.
        document.getElementById('confirmDialogBackdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.id = 'confirmDialogBackdrop';
        backdrop.className = 'confirm-dialog-backdrop';

        const card = document.createElement('div');
        card.className = 'confirm-dialog';
        card.setAttribute('role', 'alertdialog');
        card.setAttribute('aria-modal', 'true');

        const heading = document.createElement('div');
        heading.className = 'confirm-dialog__title';
        heading.textContent = title;

        const body = document.createElement('div');
        body.className = 'confirm-dialog__body';
        body.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'confirm-dialog__actions';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn-small btn-ghost';
        cancel.textContent = cancelText;

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = `btn-small${danger ? ' btn-danger' : ''}`;
        confirm.textContent = confirmText;

        actions.append(cancel, confirm);
        card.append(heading);
        if (message) card.append(body);
        card.append(actions);
        backdrop.append(card);
        document.body.append(backdrop);

        let done = false;
        const close = (result) => {
            if (done) return;
            done = true;
            backdrop.classList.add('closing');
            document.removeEventListener('keydown', onKey);
            setTimeout(() => backdrop.remove(), 200);
            resolve(result);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') close(false);
            if (event.key === 'Enter') close(true);
        };

        cancel.addEventListener('click', () => close(false));
        confirm.addEventListener('click', () => close(true));
        backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(false); });
        document.addEventListener('keydown', onKey);

        requestAnimationFrame(() => backdrop.classList.add('open'));
        confirm.focus();
    });
}

/**
 * Send the user back to sign in with a stale session cleared out.
 *
 * A token that the server no longer accepts - expired, or issued under a
 * previous JWT_SECRET - used to leave the dashboard rendered but dead: every
 * request came back 401, every action reported a generic failure, and nothing
 * said why.
 */
function endSession(reason = 'expired') {
    localStorage.removeItem('authToken');
    localStorage.removeItem('clientId');
    localStorage.removeItem('username');
    window.location.replace(`/auth?reason=${encodeURIComponent(reason)}`);
}

/**
 * fetch() for the API. Every dashboard call goes through here so a 401 is
 * handled in exactly one place.
 */
async function apiFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401) {
        endSession('expired');
        // The redirect is in flight; stop the caller from acting on the body.
        throw new Error('Session expired');
    }
    return response;
}

/**
 * The server's own message for a failed response, or a fallback.
 */
async function errorMessageFrom(response, fallback) {
    try {
        const data = await response.json();
        return data.message || data.error || fallback;
    } catch {
        return fallback;
    }
}

// Check authentication
window.addEventListener('load', async () => {
    const token = localStorage.getItem('authToken');
    const username = localStorage.getItem('username');

    if (!token) {
        window.location.href = '/auth';
        return;
    }

    // The overview is shown by the markup rather than the switcher; give it
    // the same entrance while the token check runs. And, as reveal.js does,
    // never leave anything hidden because an animation did not run.
    enterDashboardPage(document.getElementById('overviewPage'));
    setTimeout(() => {
        document.querySelectorAll('.dashboard-page [data-reveal]:not(.is-revealed)').forEach((node) => node.classList.add('is-revealed'));
    }, 4000);

    // Confirm the token is still good before drawing anything. Rendering
    // first and discovering the 401 later left a dashboard that looked fine
    // and did nothing.
    try {
        const check = await fetch(`${API_URL}/auth/verify`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (check.status === 401) {
            endSession('expired');
            return;
        }
    } catch {
        // Network trouble is not a bad token; carry on and let the page's own
        // requests surface it.
    }

    document.getElementById('username').textContent = username;
    document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();

    loadChains();
    loadDashboardData();
    setupEventListeners();

    // Auto-refresh the overview's wallets and activity every 10 seconds (but
    // not on the withdrawal page, where a re-render would fight the form).
    setInterval(async () => {
        if (currentDashboardPage !== 'withdrawal') {
            await loadWallets();
            await loadTransactions();
        }
    }, 10000);
});

function setupEventListeners() {
    const withdrawalAmount = document.getElementById('withdrawalAmount');
    withdrawalAmount.addEventListener('input', calculateFees);

    document.getElementById('withdrawalForm').addEventListener('submit', submitWithdrawal);
    document.getElementById('createWalletForm').addEventListener('submit', createNewWallet);
}

async function loadDashboardData() {
    try {
        const response = await apiFetch(`${API_URL}/clients/me`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('Failed to load data');

        const client = await response.json();
        // Load wallets, payouts, and transactions for this client
        await loadWallets();
        await loadTransactions();
    } catch (error) {
    }
}

async function loadWallets() {
    try {
        const response = await apiFetch(`${API_URL}/wallets/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('Failed to load wallets');

        wallets = await response.json();
        displayWallets();
        calculateTotalBalance();
    } catch (error) {
    }
}

/**
 * Write a refreshed wallet list into rows that are already drawn - names,
 * balances, state - without replacing them. Returns false when the rows do
 * not match the list (a wallet added, removed or reordered) and the caller
 * has to draw afresh. A refresh used to rebuild the rows every time, which
 * closed whatever you had open and reset a rename you were typing.
 */
function syncWalletRows(container, list) {
    const rows = container.querySelectorAll('.wallet-row');
    if (rows.length !== list.length) return false;
    // The rows are grouped by chain in list order, so the ids must match in order.
    const grouped = [];
    const byChain = {};
    for (const w of list) { if (!byChain[w.chain]) { byChain[w.chain] = []; grouped.push(byChain[w.chain]); } byChain[w.chain].push(w); }
    const ordered = grouped.flat();
    for (let i = 0; i < rows.length; i += 1) if (rows[i].dataset.walletId !== ordered[i].id) return false;

    ordered.forEach((w, i) => {
        const row = rows[i];
        const symbol = chainSymbol(w.chain);
        const name = row.querySelector('.wallet-row__name');
        // Leave a name that is being edited alone.
        if (name && !name.querySelector('form')) {
            const text = w.label || 'Unnamed wallet';
            if (name.textContent !== text) name.textContent = text;
            name.classList.toggle('wallet-row__name--empty', !w.label);
        }
        const bal = row.querySelector('.wallet-row__bal b');
        const balText = `${formatBalance(w.balance)} ${symbol}`;
        if (bal && bal.textContent !== balText) { bal.textContent = balText; bal.title = `${w.balance} ${symbol}`; }
        const held = Number(w.platformFeeHeld) || 0;
        const sub = row.querySelector('.wallet-row__bal span');
        const subHtml = `${usd(w.balanceUSD)}${held > 0 ? ` <span class="held">· ${escapeHtml(formatBalance(held))} held for fees</span>` : ''}`;
        if (sub && sub.innerHTML !== subHtml) sub.innerHTML = subHtml;
        const state = row.querySelector('.wallet-row__state');
        const stateHtml = w.isProcessing ? '<span class="status-pill status-pill--verifying">Confirming</span>' : '<span class="status-pill status-pill--confirmed">Active</span>';
        if (state && state.innerHTML !== stateHtml) state.innerHTML = stateHtml;
        row.dataset.search = `${w.label || ''} ${w.address} ${w.chain} ${symbol} ${PAYOUT_CHAINS[w.chain]?.name || ''}`.toLowerCase();
        // An open row's figures follow too; its QR is kept rather than fetched again.
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('wallet-detail') && !detail.classList.contains('hidden') && detail.innerHTML) {
            const qr = detail.querySelector('.wallet-detail__qr');
            const drawn = qr ? qr.innerHTML : '';
            detail.innerHTML = renderWalletDetails(w);
            const again = detail.querySelector('.wallet-detail__qr');
            if (again && drawn) again.innerHTML = drawn;
            else loadWalletQr(w.id);
        }
    });
    return true;
}

/**
 * A wallet as a tile on the overview: the mark, the name and short address,
 * the balance in coin with the USD beneath, the state as the site's dot in
 * the corner. No buttons - the tile opens the Wallets tab with this wallet's
 * row open, where the actions live.
 */
function renderWalletTile(w) {
    const symbol = chainSymbol(w.chain);
    const chainName = PAYOUT_CHAINS[w.chain]?.name || w.chain;
    const short = `${w.address.substring(0, 8)}…${w.address.substring(w.address.length - 6)}`;
    const held = Number(w.platformFeeHeld) || 0;
    return `<button type="button" class="wtile" data-on-click="openWalletFromOverview" data-arg="${w.id}" data-wallet-id="${w.id}" title="${escapeHtml(chainName)} wallet · open it on the Wallets tab">
        <span class="wtile__mark chain-mark">${chainLogo(w.chain, escapeHtml(symbol))}</span>
        <span class="wtile__name${w.label ? '' : ' wtile__name--empty'}">${w.label ? escapeHtml(w.label) : 'Unnamed wallet'}</span>
        <span class="wtile__addr">${escapeHtml(short)}</span>
        <span class="wtile__amt">${escapeHtml(formatBalance(w.balance))} ${escapeHtml(symbol)}</span>
        <span class="wtile__usd">${usd(w.balanceUSD)}${held > 0 ? ' <span class="held">· fees held</span>' : ''}</span>
        <span class="wtile__dot${w.isProcessing ? ' wtile__dot--busy' : ''}" title="${w.isProcessing ? 'Confirming' : 'Active'}"></span>
    </button>`;
}

/** Refresh the tiles in place; false when the list no longer matches them. */
function syncWalletTiles(container, list) {
    const tiles = container.querySelectorAll('.wtile[data-wallet-id]');
    if (tiles.length !== list.length) return false;
    for (let i = 0; i < tiles.length; i += 1) if (tiles[i].dataset.walletId !== list[i].id) return false;
    list.forEach((w, i) => {
        const tile = tiles[i];
        const set = (selector, text) => { const el = tile.querySelector(selector); if (el && el.textContent !== text) el.textContent = text; };
        set('.wtile__name', w.label || 'Unnamed wallet');
        tile.querySelector('.wtile__name').classList.toggle('wtile__name--empty', !w.label);
        set('.wtile__amt', `${formatBalance(w.balance)} ${chainSymbol(w.chain)}`);
        const held = Number(w.platformFeeHeld) || 0;
        const usdHtml = `${usd(w.balanceUSD)}${held > 0 ? ' <span class="held">· fees held</span>' : ''}`;
        const usdEl = tile.querySelector('.wtile__usd');
        if (usdEl && usdEl.innerHTML !== usdHtml) usdEl.innerHTML = usdHtml;
        const dot = tile.querySelector('.wtile__dot');
        if (dot) { dot.classList.toggle('wtile__dot--busy', Boolean(w.isProcessing)); dot.title = w.isProcessing ? 'Confirming' : 'Active'; }
    });
    return true;
}

/** From a tile on the overview to that wallet's row on the Wallets tab, open. */
function openWalletFromOverview(walletId) {
    // A chip or a search left on the Wallets tab could hide the very row.
    walletChainFilter = '';
    const search = document.getElementById('walletSearch');
    if (search) search.value = '';
    switchDashboardPage('wallets');
    const row = document.querySelector(`#allWalletsList .wallet-row[data-wallet-id="${CSS.escape(String(walletId))}"]`);
    if (!row) return;
    if (!row.classList.contains('is-open')) toggleWalletDetails(row);
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function displayWallets() {
    const container = document.getElementById('walletsContainer');

    if (wallets.length === 0) {
        container.innerHTML = '<div class="dash-empty">No wallets yet. Add one to start receiving payments.</div>';
        // The bar has its own empty state; without this it stays on "Loading".
        displayDistribution();
        return;
    }

    // Tiles already there for this list: refresh them in place. The ten-second
    // refresh used to rebuild the section every time.
    if (syncWalletTiles(container, wallets)) {
        document.getElementById('walletCount').textContent = wallets.length;
        displayDistribution();
        return;
    }

    container.innerHTML = `<div class="wgrid">${wallets.map(renderWalletTile).join('')}<button type="button" class="wtile wtile--add" data-on-click="openCreateWalletModal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add a wallet</button></div>`;
    document.getElementById('walletCount').textContent = wallets.length;
    displayDistribution();
}

/**
 * Where the balance sits, chain by chain: one bar, segments proportional to
 * USD value, largest first. The dashboard's echo of the landing page's route
 * network - the same ten chains, shown as where the money is rather than
 * where it could go. Chains carrying nothing are named in the key rather than
 * drawn as empty slivers, and an account with no balance at all gets one quiet
 * segment.
 */
// What the bar last drew, chain by chain in USD, so a refresh that changed
// nothing worth seeing does not redraw it. Redrawing replays the entrance;
// every ten seconds that is a tic, not a chart.
let distDrawn = null;

/**
 * Whether the bar has to be drawn again - first time, a chain arriving or
 * leaving, the order changing, or any chain moving by more than a tenth.
 * Anything smaller is written into the segments that are already there.
 */
function distributionChanged(funded) {
    if (!distDrawn) return true;
    const before = Object.keys(distDrawn);
    const after = funded.map(([chain]) => chain);
    if (before.length !== after.length || before.some((chain, i) => chain !== after[i])) return true;
    return funded.some(([chain, v]) => {
        const was = distDrawn[chain];
        return Math.abs(v.usd - was) / Math.max(was, 0.01) > 0.10;
    });
}

function displayDistribution() {
    const host = document.getElementById('distribution');
    if (!host) return;

    const byChain = {};
    for (const w of wallets) {
        const usd = Number(w.balanceUSD) || 0;
        const native = Number(w.balance) || 0;
        if (!byChain[w.chain]) byChain[w.chain] = { usd: 0, native: 0 };
        byChain[w.chain].usd += usd;
        byChain[w.chain].native += native;
    }

    const funded = Object.entries(byChain)
        .filter(([, v]) => v.usd > 0)
        .sort((a, b) => b[1].usd - a[1].usd);
    const total = funded.reduce((sum, [, v]) => sum + v.usd, 0);
    const empty = Object.keys(byChain).filter((chain) => !(byChain[chain].usd > 0));

    if (total <= 0) {
        const message = wallets.length === 0
            ? 'No balance yet \u2014 add a wallet to start receiving.'
            : 'No balance yet \u2014 payments will appear here as they land.';
        const none = host.querySelector('.dist__none');
        if (none) { if (none.textContent !== message) none.textContent = message; }
        else host.innerHTML = `<div class="dist__bar"><div class="dist__none">${message}</div></div>`;
        distDrawn = null;
        return;
    }

    const tipFor = (chain, v) => `${PAYOUT_CHAINS[chain]?.name || chain} \u00b7 ${formatBalance(v.native)} ${chainSymbol(chain)} \u00b7 ${usd(v.usd)}`;
    // A sliver still gets its ticker; below ~6% there is no room for it.
    const labelFor = (chain, share) => (share >= 6 ? chainSymbol(chain) : '');

    const key = funded.map(([chain, v]) =>
        `<span><b>${escapeHtml(chainSymbol(chain))}</b>${((v.usd / total) * 100).toFixed(1)}%</span>`
    ).join('');
    const rest = empty.length
        ? `<span>${empty.length} more chain${empty.length === 1 ? '' : 's'} \u00b7 no balance</span>`
        : '';

    if (!distributionChanged(funded)) {
        // The same chains in the same order, none moved much: update the
        // figures in place. flex-grow transitions, so a small move glides.
        const segs = host.querySelectorAll('.dist__seg');
        funded.forEach(([chain, v], i) => {
            const seg = segs[i];
            if (!seg) return;
            const share = (v.usd / total) * 100;
            seg.style.flex = share.toFixed(3);
            const tip = tipFor(chain, v);
            if (seg.dataset.tip !== tip) { seg.dataset.tip = tip; seg.title = tip; }
            const label = labelFor(chain, share);
            const span = seg.querySelector('span');
            if (span && span.textContent !== label) span.textContent = label;
        });
        const keyEl = host.querySelector('.dist__key');
        if (keyEl && keyEl.innerHTML !== key + rest) keyEl.innerHTML = key + rest;
        distDrawn = Object.fromEntries(funded.map(([chain, v]) => [chain, v.usd]));
        return;
    }

    const segments = funded.map(([chain, v], i) => {
        const share = (v.usd / total) * 100;
        const tip = tipFor(chain, v);
        return `<div class="dist__seg" style="flex:${share.toFixed(3)};--d:${i * 90}ms" data-chain="${escapeHtml(chain)}" data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}"><span>${escapeHtml(labelFor(chain, share))}</span></div>`;
    }).join('');

    host.innerHTML = `<div class="dist__bar">${segments}</div><div class="dist__key">${key}${rest}</div>`;
    distDrawn = Object.fromEntries(funded.map(([chain, v]) => [chain, v.usd]));
}

function calculateTotalBalance() {
    totalBalanceUSD = 0;
    wallets.forEach(w => { totalBalanceUSD += w.balanceUSD; });

    document.getElementById('totalBalanceUSD').textContent = `$${totalBalanceUSD.toFixed(2)}`;
    document.getElementById('availableBalance').textContent = `$${totalBalanceUSD.toFixed(2)}`;
    
    updateWithdrawalStatus();
}

/**
 * The withdraw-readiness line under the balance. Runs on every wallet
 * refresh, so it decides what it wants to show first and touches the DOM
 * only when that differs from what is there - rewriting the badge's icon
 * every ten seconds made it blink, and a tooltip being read would vanish.
 */
function updateWithdrawalStatus() {
    const statusEl = document.getElementById('withdrawalStatus');
    if (!statusEl) return;
    const statusText = statusEl.querySelector('.status-text');
    const statusBadge = statusEl.querySelector('.status-badge');
    const tooltip = statusEl.querySelector('.info-tooltip');

    const processingWallets = wallets.filter(w => w.isProcessing);
    let want;
    if (processingWallets.length > 0 && totalBalanceUSD < 5) {
        want = { text: 'Transaction processing', tone: 'unavailable', icon: 'alert', tip: `${processingWallets.length} wallet${processingWallets.length === 1 ? ' has a transaction' : 's have transactions'} in progress, and the rest hold under $5.`, link: false };
    } else if (processingWallets.length > 0) {
        want = { text: 'Able to withdraw', tone: 'available', icon: 'check', tip: `${processingWallets.map(w => w.chain).join(', ')} locked while a transaction is in progress; the others can go.`, link: true };
    } else if (totalBalanceUSD >= 5) {
        want = { text: 'Able to withdraw', tone: 'available', icon: 'check', tip: '', link: true };
    } else {
        want = { text: 'Unable to withdraw', tone: 'unavailable', icon: 'alert', tip: `A wallet needs $5 in it before it can be withdrawn from. You have ${usd(totalBalanceUSD)} in total.`, link: false };
    }

    const key = JSON.stringify(want);
    if (statusEl.dataset.state === key) return;
    statusEl.dataset.state = key;

    statusText.textContent = want.text;
    statusBadge.className = `status-badge ${want.tone}`;
    statusBadge.setAttribute('data-icon', want.icon);
    statusBadge.textContent = '';
    tooltip.textContent = want.tip;
    tooltip.style.display = want.tip ? 'block' : 'none';
    statusEl.style.cursor = want.link ? 'pointer' : 'default';
    statusEl.onclick = want.link ? () => switchDashboardPage('withdrawal') : null;
    loadSVGIcons();

    // The tip's arrow points at the badge. The text before it changes width
    // with the state (and with the font arriving), so measure now and again
    // whenever the pointer comes in.
    placeStatusArrow();
    if (!statusEl.dataset.arrowWired) {
        statusEl.dataset.arrowWired = 'true';
        statusEl.addEventListener('mouseenter', placeStatusArrow);
        statusEl.addEventListener('focusin', placeStatusArrow);
    }
}

/** Where the badge's centre falls, written for the tip's arrow to sit under. */
function placeStatusArrow() {
    const statusEl = document.getElementById('withdrawalStatus');
    const badge = statusEl && statusEl.querySelector('.status-badge');
    const tooltip = statusEl && statusEl.querySelector('.info-tooltip');
    if (!badge || !tooltip) return;
    const x = badge.offsetLeft + badge.offsetWidth / 2;
    if (x > 0) tooltip.style.setProperty('--arrow-x', `${Math.round(x)}px`);
}

let allPayouts = [];
let payoutFilter = 'all';

const PAYOUT_PILL = { PENDING: 'pending', PROCESSING: 'verifying', COMPLETED: 'paid', PARTIAL: 'awaiting', FAILED: 'failed' };
const PAYOUT_LABEL = { PENDING: 'Pending', PROCESSING: 'Sending', COMPLETED: 'Paid', PARTIAL: 'Partial', FAILED: 'Failed' };

function payoutMatches(p) {
    const status = String(p.status || '').toUpperCase();
    switch (payoutFilter) {
        case 'done': return status === 'COMPLETED';
        case 'pending': return status === 'PENDING' || status === 'PROCESSING' || status === 'PARTIAL';
        case 'failed': return status === 'FAILED';
        default: return true;
    }
}

function applyPayoutFilter() {
    displayPayoutsList(allPayouts.filter(payoutMatches));
}

function displayPayoutsList(payouts) {
    const tbody = document.getElementById('allPayoutsList');
    if (!tbody) return;
    const countEl = document.getElementById('payoutCount');
    if (countEl) countEl.textContent = payouts.length === 1 ? '1 payout' : `${payouts.length} payouts`;

    if (payouts.length === 0) {
        tbody.innerHTML = `<tr class="dash-table__empty"><td colspan="8">${
            allPayouts.length === 0 ? 'No payouts yet. Your first withdrawal will appear here.' : 'No payout matches that filter.'
        }</td></tr>`;
        return;
    }

    const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    const money = (v) => Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : '\u2014';

    tbody.innerHTML = payouts.map((payout, i) => {
        const status = String(payout.status || '').toUpperCase();
        const when = txWhen(payout.createdAt);
        const gross = Number(payout.totalAmountUsd);
        const fee = Number(payout.platformFee);
        const gas = Number(payout.estimatedTotalGas) || 0;
        const net = Number(payout.netAmountUsd);
        // The rate is configuration, not a constant: say what this payout paid.
        const rate = gross > 0 && Number.isFinite(fee) ? ` (${((fee / gross) * 100).toFixed(1).replace(/\.0$/, '')}%)` : '';
        const paidIn = escapeHtml(payout.payoutChain || payout.chain || '');
        const paidInName = escapeHtml(PAYOUT_CHAINS[payout.payoutChain || payout.chain]?.name || payout.payoutChain || payout.chain || '');
        const transfers = payout.withdrawalPlan?.transfers || [];
        const detailId = `payout-detail-${i}`;
        const id = escapeHtml(String(payout.id || ''));

        const transferRows = transfers.length
            ? transfers.map((t) => `<div class="xfer">
                <span class="xfer__chain">${escapeHtml(PAYOUT_CHAINS[t.chain]?.name || t.chain || '')}</span>
                <span class="xfer__amt">${escapeHtml(formatBalance(t.nativeAmount))} ${escapeHtml(chainSymbol(t.chain))}</span>
                <span class="xfer__usd">${money(t.transactionValueUSD)}</span>
                <span class="xfer__how">${t.type === 'DIRECT_TRANSFER' ? 'Direct' : 'Swapped'}</span>
                <span class="status-pill status-pill--${PAYOUT_PILL[String(t.status || 'PENDING').toUpperCase()] || 'pending'}">${PAYOUT_LABEL[String(t.status || 'PENDING').toUpperCase()] || escapeHtml(String(t.status))}</span>
            </div>`).join('')
            : '<div class="xfer xfer--none">No transfer breakdown recorded.</div>';

        return `<tr class="row" tabindex="0" aria-expanded="false" aria-controls="${detailId}">
            <td class="when"><b>${escapeHtml(when.day)}</b><span>${escapeHtml(when.time)}</span></td>
            <td class="chain">${paidInName}${paidIn && paidIn !== paidInName ? ` <span class="muted">\u00b7 ${paidIn}</span>` : ''}</td>
            <td class="amt num"><b>${money(gross)}</b></td>
            <td class="num muted">\u2212${money(fee)}<span class="muted-sm">${rate}</span></td>
            <td class="num muted">\u2212${money(gas)}</td>
            <td class="amt num"><b>${money(net)}</b></td>
            <td><span class="status-pill status-pill--${PAYOUT_PILL[status] || 'pending'}">${PAYOUT_LABEL[status] || escapeHtml(status)}</span></td>
            <td>${CHEV}</td>
        </tr>
        <tr class="detail" id="${detailId}" hidden><td colspan="8"><div class="detail__wrap"><div class="detail__in">
            <div class="xfers">
                <div class="xfers__head"><span>From</span><span>Amount</span><span>Value</span><span>Route</span><span>State</span></div>
                ${transferRows}
            </div>
            <dl class="payout-meta"><div><dt>Payout id</dt><dd>${id}</dd></div><div><dt>Created</dt><dd>${escapeHtml(payout.createdAt ? new Date(payout.createdAt).toLocaleString() : '\u2014')}</dd></div></dl>
        </div></div></td></tr>`;
    }).join('');
}

let allTransactions = [];
let txFilter = 'all';

const TX_PILL = { PENDING: 'pending', PROCESSING: 'verifying', CONFIRMED: 'confirmed', COMPLETED: 'confirmed', FAILED: 'failed' };
const TX_LABEL = { PENDING: 'Pending', PROCESSING: 'Confirming', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', FAILED: 'Failed' };

function setTxCount(n) {
    const el = document.getElementById('txCount');
    if (el) el.textContent = n === 1 ? '1 transaction' : `${n} transactions`;
}

/** The search text for a transaction: hash, chain, type, amount, status. */
function txSearchText(tx) {
    return [tx.transactionHash, tx.chain, PAYOUT_CHAINS[tx.chain]?.name, tx.type, tx.nativeAmount,
        tx.usdAmount, tx.status, tx.failureReason].filter(Boolean).join(' ').toLowerCase();
}

function txMatchesFilter(tx) {
    const incoming = String(tx.type || '').toUpperCase() !== 'WITHDRAWAL';
    const status = String(tx.status || '').toUpperCase();
    switch (txFilter) {
        case 'in': return incoming;
        case 'out': return !incoming;
        case 'pending': return status === 'PENDING' || status === 'PROCESSING';
        case 'failed': return status === 'FAILED';
        default: return true;
    }
}

function applyTxFilter() {
    const needle = (document.getElementById('txSearch')?.value || '').trim().toLowerCase();
    const shown = allTransactions.filter((tx) => txMatchesFilter(tx) && (!needle || txSearchText(tx).includes(needle)));
    displayTransactionsList(shown, needle);
}

function txWhen(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return { day: '\u2014', time: '' };
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const day = sameDay ? 'Today' : d.toDateString() === yesterday.toDateString() ? 'Yesterday'
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return { day, time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) };
}

function displayTransactionsList(transactions, needle = '') {
    const tbody = document.getElementById('allTransactionsList');
    if (!tbody) return;
    setTxCount(transactions.length);

    if (transactions.length === 0) {
        tbody.innerHTML = `<tr class="dash-table__empty"><td colspan="7">${
            allTransactions.length === 0
                ? 'No transactions yet. Your first payment will appear here.'
                : `No transaction matches <b>${escapeHtml(needle || txFilter)}</b>.`
        }</td></tr>`;
        return;
    }

    const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

    tbody.innerHTML = transactions.map((tx, i) => {
        const status = String(tx.status || '').toUpperCase();
        const incoming = String(tx.type || '').toUpperCase() !== 'WITHDRAWAL';
        const chainInfo = PAYOUT_CHAINS[tx.chain] || {};
        const chainName = escapeHtml(chainInfo.name || tx.chain || '');
        const symbol = escapeHtml(chainSymbol(tx.chain));
        const when = txWhen(tx.createdAt);
        const usd = Number(tx.usdAmount);
        const hashFull = tx.transactionHash ? String(tx.transactionHash) : '';
        const hashShort = hashFull ? `${escapeHtml(hashFull.slice(0, 6))}\u2026${escapeHtml(hashFull.slice(-4))}` : '';
        const explorer = hashFull && chainInfo.explorerTx ? `${chainInfo.explorerTx}${hashFull}` : '';
        const hashCell = hashFull
            ? `<span class="hash">${explorer ? `<a href="${escapeHtml(explorer)}" target="_blank" rel="noopener" title="Open in explorer">${hashShort}</a>` : hashShort}<button type="button" title="Copy hash" data-on-click="copyToClipboard" data-arg="${escapeHtml(hashFull)}">${COPY}</button></span>`
            : '<span class="hash">not yet broadcast</span>';
        const needed = Number(chainInfo.confirmations) || 0;
        const done = status === 'CONFIRMED' || status === 'COMPLETED';
        const ticks = needed
            ? `<span class="confs">${Array.from({ length: Math.min(needed, 6) }, () => `<i class="${done ? 'on' : ''}"></i>`).join('')}</span>${done ? `${needed} of ${needed}` : `needs ${needed}`}`
            : (done ? 'Confirmed' : 'Awaiting');
        const detailId = `tx-detail-${i}`;
        const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '\u2014';

        return `<tr class="row" tabindex="0" aria-expanded="false" aria-controls="${detailId}">
            <td class="when"><b>${escapeHtml(when.day)}</b><span>${escapeHtml(when.time)}</span></td>
            <td><span class="type"><i class="${incoming ? 'in' : 'out'}"></i>${incoming ? 'Received' : 'Payout'}</span></td>
            <td class="amt num"><b>${incoming ? '' : '\u2212'}${escapeHtml(formatBalance(tx.nativeAmount))} ${symbol}</b>${Number.isFinite(usd) ? `<span>$${usd.toFixed(2)}</span>` : ''}</td>
            <td class="chain">${chainName}</td>
            <td>${hashCell}</td>
            <td><span class="status-pill status-pill--${TX_PILL[status] || 'pending'}">${TX_LABEL[status] || escapeHtml(status)}</span></td>
            <td>${CHEV}</td>
        </tr>
        <tr class="detail" id="${detailId}" hidden><td colspan="7"><div class="detail__wrap"><div class="detail__in"><dl>
            <div><dt>Transaction hash</dt><dd>${hashFull ? (explorer ? `<a href="${escapeHtml(explorer)}" target="_blank" rel="noopener">${escapeHtml(hashFull)}</a>` : escapeHtml(hashFull)) : '<span class="muted">Not yet broadcast</span>'}</dd></div>
            <div><dt>Confirmations</dt><dd>${ticks}</dd></div>
            <div><dt>Block</dt><dd>${tx.blockNumber ? escapeHtml(String(tx.blockNumber)) : '<span class="muted">\u2014</span>'}</dd></div>
            <div><dt>Created</dt><dd>${escapeHtml(fmt(tx.createdAt))}</dd></div>
            <div><dt>Broadcast</dt><dd>${escapeHtml(fmt(tx.broadcastedAt))}</dd></div>
            <div><dt>Completed</dt><dd>${escapeHtml(fmt(tx.completedAt))}</dd></div>
            <div><dt>USD at the time</dt><dd>${Number.isFinite(usd) ? `$${usd.toFixed(2)}` : '<span class="muted">\u2014</span>'}</dd></div>
            ${status === 'FAILED' ? `<div><dt>Failure</dt><dd>${escapeHtml(tx.failureReason || 'Unknown')}${tx.failureMessage ? ` \u00b7 ${escapeHtml(tx.failureMessage)}` : ''}</dd></div>` : ''}
        </dl></div></div></td></tr>`;
    }).join('');
}

/**
 * A row opens its detail in place. Delegated once from the table body, so
 * re-rendering the rows never has to re-bind anything. Enter and Space work
 * because the row is focusable and this listens for them.
 */
(function wireTransactionRows() {
    const table = document.getElementById('txTable');
    if (!table) return;

    function toggle(row) {
        const open = row.getAttribute('aria-expanded') === 'true';
        const detail = document.getElementById(row.getAttribute('aria-controls'));
        row.setAttribute('aria-expanded', String(!open));
        if (!detail) return;
        if (open) {
            detail.classList.remove('open');
            // let the grid-rows transition finish before removing from flow
            setTimeout(() => { if (!detail.classList.contains('open')) detail.hidden = true; }, 260);
        } else {
            detail.hidden = false;
            requestAnimationFrame(() => detail.classList.add('open'));
        }
    }

    table.addEventListener('click', (event) => {
        if (event.target.closest('a, button')) return;   // links and copy buttons do their own thing
        const row = event.target.closest('tr.row');
        if (row) toggle(row);
    });
    table.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('tr.row');
        if (!row || event.target !== row) return;
        event.preventDefault();
        toggle(row);
    });

    const search = document.getElementById('txSearch');
    const chips = document.getElementById('txChips');
    if (search) search.addEventListener('input', applyTxFilter);
    if (chips) chips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        txFilter = button.dataset.filter;
        chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        applyTxFilter();
    });
})();

async function loadTransactions() {
    try {
        const response = await apiFetch(`${API_URL}/transactions/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            return;
        }

        let transactions = await response.json();
        
        // Filter pending, processing, confirmed, completed, and failed transactions
        if (Array.isArray(transactions)) {
            transactions = transactions.filter(t => 
                t.status === 'PENDING' || t.status === 'PROCESSING' || t.status === 'CONFIRMED' || t.status === 'COMPLETED' || t.status === 'FAILED'
            ).slice(0, 10); // Show last 10 relevant transactions
        }

        displayTransactions(Array.isArray(transactions) ? transactions : []);
    } catch (error) {
    }
}

function displayTransactions(transactions) {
    // The activity rail on the overview. This used to render into
    // #transactionsList, which no page had - the fetch was made and thrown
    // away. Every value that came from the API is escaped on the way in.
    const rail = document.getElementById('activityRail');
    const pendingEl = document.getElementById('pendingCount');
    const pending = transactions.filter((tx) => tx.status === 'PENDING' || tx.status === 'PROCESSING').length;
    if (pendingEl) pendingEl.textContent = String(pending);
    if (!rail) return;

    const PILL = { PENDING: 'pending', PROCESSING: 'verifying', CONFIRMED: 'confirmed', COMPLETED: 'confirmed', FAILED: 'failed' };
    const LABEL = { PENDING: 'Pending', PROCESSING: 'Confirming', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', FAILED: 'Failed' };

    const rows = transactions.map((tx) => {
        const incoming = String(tx.type || '').toUpperCase() !== 'WITHDRAWAL';
        const what = incoming ? 'Payment received' : 'Payout sent';
        const chain = escapeHtml(PAYOUT_CHAINS[tx.chain]?.name || tx.chain || '');
        const symbol = escapeHtml(chainSymbol(tx.chain));
        const hash = tx.transactionHash
            ? `${escapeHtml(String(tx.transactionHash).slice(0, 6))}\u2026${escapeHtml(String(tx.transactionHash).slice(-4))}`
            : 'not yet broadcast';
        const usd = Number(tx.usdAmount);
        const when = relativeTime(tx.createdAt);
        const status = String(tx.status || '').toUpperCase();
        const detail = status === 'FAILED' && tx.failureReason ? ` \u00b7 ${escapeHtml(tx.failureReason)}` : '';
        return `<div class="act__row">
            <i class="act__dot ${incoming ? 'in' : 'out'}"></i>
            <div class="act__what"><b>${what}</b><span>${chain} \u00b7 ${hash}${detail}</span></div>
            <div class="act__amt">${incoming ? '' : '\u2212'}${escapeHtml(formatBalance(tx.nativeAmount))} ${symbol}${Number.isFinite(usd) ? `<span>$${usd.toFixed(2)}</span>` : ''}</div>
            <div class="act__when">${when}</div>
            <span class="status-pill status-pill--${PILL[status] || 'pending'}">${LABEL[status] || escapeHtml(status)}</span>
        </div>`;
    });

    rail.innerHTML = rows.length
        ? rows.join('')
        : '<div class="dash-empty">No activity yet. Your first payment will appear here.</div>';
}

/** "2 min ago", "3 h ago", "Yesterday", else the date. */
function relativeTime(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 172800) return 'Yesterday';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function calculateFees() {
    const amount = parseFloat(document.getElementById('withdrawalAmount').value) || 0;
    const fee = amount * 0.05;
    const receive = amount - fee;

    document.getElementById('feeAmount').textContent = `$${amount.toFixed(2)}`;
    document.getElementById('feeTotal').textContent = `$${fee.toFixed(2)}`;
    document.getElementById('youWillReceive').textContent = `$${receive.toFixed(2)}`;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!', 'success', 2000);
}

function openWithdrawalModal() {
    if (totalBalanceUSD < 5) {
        showToast('Minimum $5 per wallet/chain required', 'error');
        return;
    }
    document.getElementById('withdrawalModal').classList.add('show');
}

function closeWithdrawalModal() {
    document.getElementById('withdrawalModal').classList.remove('show');
}

/**
 * Add wallet opens in place on the Wallets page. The overview's button brings
 * you here with it open; the old modal names survive for the callers.
 */
function openCreateWalletModal() {
    if (currentDashboardPage !== 'wallets') switchDashboardPage('wallets');
    setAddWalletOpen(true);
}

function closeCreateWalletModal() {
    setAddWalletOpen(false);
}

function toggleAddWallet() {
    const panel = document.getElementById('addWalletPanel');
    setAddWalletOpen(Boolean(panel && panel.classList.contains('hidden')));
}

function setAddWalletOpen(open) {
    const panel = document.getElementById('addWalletPanel');
    const form = document.getElementById('createWalletForm');
    if (!panel) return;
    panel.classList.toggle('hidden', !open);
    if (form) form.reset();
    if (open) {
        const chain = document.getElementById('walletChain');
        if (chain) chain.focus();
    }
}

/** The API is a page now; anything that still asks for the modal gets the page. */
function openAPIModal() {
    switchDashboardPage('api');
}

async function submitWithdrawal(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const errorDiv = document.getElementById('withdrawalError');
    errorDiv.classList.remove('show');

    const amount = parseFloat(document.getElementById('withdrawalAmount').value);
    if (amount < 5) {
        errorDiv.textContent = 'Minimum withdrawal is $5 per wallet/chain';
        errorDiv.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        const response = await apiFetch(`${API_URL}/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Idempotency-Key': crypto.randomUUID()
            },
            body: JSON.stringify({
                recipientAddress: document.getElementById('withdrawalAddress').value
            })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(`Withdrawal Initiated! Amount: $${data.withdrawalAmount.toFixed(2)}, Fee: $${data.platformFee.toFixed(2)}`, 'success');
            closeWithdrawalModal();
            document.getElementById('withdrawalForm').reset();
            loadWallets(); // Refresh to update balances
        } else {
            errorDiv.textContent = data.message || 'Withdrawal failed';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'An error occurred: ' + error.message;
        errorDiv.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm Withdrawal';
    }
}

async function createNewWallet(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const chain = document.getElementById('walletChain').value;
    if (!chain) {
        showToast('Choose a chain for the wallet', 'error');
        return;
    }

    btn.disabled = true;
    btn.classList.add('is-busy');

    try {
        const response = await apiFetch(`${API_URL}/wallets/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Idempotency-Key': crypto.randomUUID()
            },
            body: JSON.stringify({
                chain,
                label: (document.getElementById('walletLabel')?.value || '').trim(),
            })
        });

        if (response.ok) {
            closeCreateWalletModal();
            await loadWallets();
            loadWalletsList();
            showToast('Wallet created successfully', 'success');
        } else {
            showToast(await errorMessageFrom(response, 'Failed to create wallet'), 'error');
        }
    } catch (error) {
        if (error.message !== 'Session expired') showToast(`Error creating wallet: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('is-busy');
    }
}

// ── API page ─────────────────────────────────────────────────────────────

const API_KEY_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
const PLUS_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CROSS_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** Opening the page: the key row, the quick start's prefix, and the usage. */
async function loadApiPage() {
    const url = document.getElementById('apiQuickStartUrl');
    if (url) url.textContent = `${window.location.origin}/api/wallets/list`;
    await Promise.all([loadAPIKeys(), loadApiUsage()]);
}

/**
 * The key as one row: glyph, prefix, when it was made, and what you can do
 * to it. Only the prefix is available - the server stores a hash, so the
 * full key exists in one place only: wherever it was saved when issued.
 */
async function loadAPIKeys() {
    const container = document.getElementById('apiKeysContainer');
    const quickKey = document.getElementById('apiQuickStartKey');
    if (!container) return;
    try {
        const response = await apiFetch(`${API_URL}/api-keys`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        const data = await response.json();

        if (!data.hasKey) {
            container.innerHTML = `<div class="api-key__row is-none">
                <span class="api-key__badge">${API_KEY_GLYPH}</span>
                <div class="api-key__who"><b>No key yet</b><span>Make one to call the API from your own code. Payment links and the dashboard do not need it.</span></div>
                <div class="api-key__acts">
                    <button type="button" class="btn-small btn-primary" data-on-click="generateNewAPIKey">${PLUS_GLYPH}Make a key</button>
                </div>
            </div>`;
            if (quickKey) quickKey.textContent = 'ethr_…';
            return;
        }

        const made = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown';
        const prefix = data.prefix || 'ethr_';
        container.innerHTML = `<div class="api-key__row">
            <span class="api-key__badge">${API_KEY_GLYPH}</span>
            <div class="api-key__who"><b>${escapeHtml(prefix)}…</b><span class="dot">Active · made ${escapeHtml(made)} · the rest of it lives only where you saved it</span></div>
            <div class="api-key__acts">
                <button type="button" class="btn-small btn-primary" data-on-click="generateNewAPIKey">${PLUS_GLYPH}New key</button>
                <button type="button" class="btn-small btn-danger" data-on-click="revokeAPIKey">${CROSS_GLYPH}Revoke</button>
            </div>
        </div>`;
        if (quickKey) quickKey.textContent = `${prefix}…`;
    } catch (error) {
        container.innerHTML = '<div class="dash-empty">Could not load your key. Try again in a moment.</div>';
    }
}

/** The curl in the quick start, as text, onto the clipboard. */
function copyQuickStart() {
    const pre = document.getElementById('apiQuickStart');
    if (pre) copyToClipboard(pre.textContent.replace(/^# .*\n/, ''));
}

/** How long ago, for the usage table. */
function agoText(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
}

/**
 * Usage: three honest figures and the last requests, from the call log the
 * server already keeps for every authenticated call - key or session.
 */
async function loadApiUsage() {
    const body = document.getElementById('apiRecentBody');
    if (!body) return;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    try {
        const response = await apiFetch(`${API_URL}/api-calls/recent?limit=20`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load usage');

        set('apiFactTotal', Number(data.totalCalls || 0).toLocaleString());
        set('apiFactDay', Number(data.last24h || 0).toLocaleString());
        set('apiFactErrors', Number(data.errors24h || 0).toLocaleString());

        const calls = Array.isArray(data.calls) ? data.calls : [];
        if (calls.length === 0) {
            body.innerHTML = '<tr class="dash-table__empty"><td colspan="3">No requests yet. Your first call will appear here.</td></tr>';
            return;
        }
        body.innerHTML = calls.map((call) => {
            const status = Number(call.statusCode) || 0;
            const tone = status >= 500 ? 'failed' : (status >= 400 ? (status === 401 || status === 403 ? 'insufficient' : 'pending') : 'confirmed');
            return `<tr>
                <td class="req"><b>${escapeHtml(call.method || '')}</b>${escapeHtml(call.endpoint || '')}</td>
                <td><span class="status-pill status-pill--${tone}">${status || '—'}</span></td>
                <td class="num">${escapeHtml(agoText(call.timestamp))}</td>
            </tr>`;
        }).join('');
    } catch (error) {
        body.innerHTML = '<tr class="dash-table__empty"><td colspan="3">Could not load recent requests.</td></tr>';
    }
}

let apiPollTimer = null;
function startApiPolling() {
    stopApiPolling();
    apiPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') loadApiUsage();
    }, 15000);
}

function stopApiPolling() {
    if (apiPollTimer) {
        clearInterval(apiPollTimer);
        apiPollTimer = null;
    }
}

/**
 * Present a newly issued API key.
 *
 * The server stores only a hash, so this is the single moment the key can be
 * read. It renders into #newApiKeyPanel — a sibling of the key list rather than
 * a child — because loadAPIKeys() replaces the list's innerHTML and would
 * otherwise wipe the key out from under the user. It stays until dismissed.
 */
function showNewApiKey(apiKey) {
    const panel = document.getElementById('newApiKeyPanel');

    if (!panel || !apiKey) {
        // Better a clumsy fallback than losing the key silently.
        showToast('API key generated, but it could not be displayed. Generate another.', 'error');
        return;
    }

    panel.innerHTML = `
        <div class="new-api-key__title">Copy this key now</div>
        <p class="new-api-key__note">This is the only time it will be shown. We store a hash, so it cannot be recovered — if you lose it you will need to generate a new one.</p>
        <div class="new-api-key__value" id="newApiKeyValue"></div>
        <div class="new-api-key__actions">
            <button type="button" class="btn-small btn-primary" data-on-click="copyNewApiKey"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy key</button>
            <button type="button" class="btn-small btn-primary" data-on-click="dismissNewApiKey"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>I've saved it</button>
        </div>
    `;

    // Assign as text, never as markup - the key is a credential and must not be
    // parsed as HTML.
    document.getElementById('newApiKeyValue').textContent = apiKey;

    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast('API key generated - copy it now', 'success');
}

/**
 * Copy the visible key. Reads from the DOM so the value is not held in a
 * closure any longer than the panel is open.
 */
function copyNewApiKey() {
    const value = document.getElementById('newApiKeyValue');
    if (value) copyToClipboard(value.textContent);
}

function dismissNewApiKey() {
    const panel = document.getElementById('newApiKeyPanel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.innerHTML = '';
}

/**
 * A new key replaces the old one, which stops working at once - so it asks
 * first, through the dashboard's own dialog rather than an overlay pinned
 * inside a modal. With no key yet there is nothing to lose, so no question.
 */
async function generateNewAPIKey() {
    const hasKey = Boolean(document.querySelector('#apiKeysContainer .api-key__row:not(.is-none)'));
    if (hasKey) {
        const ok = await confirmDialog({
            title: 'Make a new key?',
            message: 'The key you have now stops working the moment the new one is made. Anything using it will need the new key.',
            confirmText: 'Make a new key',
        });
        if (!ok) return;
    }
    confirmGenerateAPIKey();
}

/** Revoke the key. Nothing replaces it; the account is API-less until a new one is made. */
async function revokeAPIKey() {
    const ok = await confirmDialog({
        title: 'Revoke your API key?',
        message: 'It stops working at once. Anything using it will fail until you make a new key.',
        confirmText: 'Revoke key',
        danger: true,
    });
    if (!ok) return;
    try {
        const response = await apiFetch(`${API_URL}/api-keys`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not revoke the key');
        dismissNewApiKey();
        await loadAPIKeys();
        showToast('API key revoked', 'success');
    } catch (error) {
        if (error.message !== 'Session expired') showToast(error.message, 'error');
    }
}

async function confirmGenerateAPIKey() {
    try {
        const response = await apiFetch(`${API_URL}/api-keys/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // Refresh the list first and wait for it - it rewrites its own
            // container, and showing the key before that lands would let the
            // refresh erase it.
            await loadAPIKeys();
            showNewApiKey(data.apiKey);
        } else {
            showToast(data.message || 'Failed to generate new API key', 'error');
        }
    } catch (error) {
        showToast('Error generating API key', 'error');
    }
}

/**
 * The Account page: identity plus live stats, pulled from the same endpoints
 * the rest of the dashboard uses.
 */
async function loadAccountPage() {
    const username = localStorage.getItem('username') || '—';
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const when = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    };

    set('accountUsername', username);
    set('accountRowName', username);
    set('accountAvatar', username.charAt(0).toUpperCase());

    // The form and the codes panel start closed each visit.
    const form = document.getElementById('changePasswordForm');
    if (form) { form.classList.add('hidden'); form.reset(); }
    const msg = document.getElementById('changePasswordMessage');
    if (msg) msg.innerHTML = '';
    dismissRecoveryCodes();

    // This session: the token the browser holds says when it expires.
    set('accountSession', sessionExpiryText());

    // Wallets and balance (already loaded into `wallets`, but refresh to be current).
    try {
        const res = await apiFetch(`${API_URL}/wallets/list`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        if (res.ok) {
            const list = await res.json();
            const total = list.reduce((sum, w) => sum + (w.balanceUSD || 0), 0);
            const chainsUsed = new Set(list.map((w) => w.chain)).size;
            set('accountBalance', usd(total));
            set('accountBalanceNote', `across ${list.length} wallet${list.length === 1 ? '' : 's'}`);
            set('accountWallets', String(list.length));
            set('accountWalletsNote', `wallet${list.length === 1 ? '' : 's'} on ${chainsUsed} chain${chainsUsed === 1 ? '' : 's'}`);
        }
    } catch (e) { if (e.message === 'Session expired') return; }

    try {
        const res = await apiFetch(`${API_URL}/payouts/list`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        if (res.ok) { const d = await res.json(); set('accountPayouts', String(d.count ?? (d.payouts || []).length)); }
    } catch { /* leave 0 */ }

    try {
        const res = await apiFetch(`${API_URL}/api-calls/stats?period=day`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        if (res.ok) { const d = await res.json(); set('accountApiCalls', String(d.periodTotal ?? 0)); }
    } catch { /* leave 0 */ }

    try {
        const res = await apiFetch(`${API_URL}/clients/me`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        if (res.ok) {
            const me = await res.json();
            const lastIn = me.lastLogin ? agoText(me.lastLogin) : 'never';
            set('accountSince', `Member since ${when(me.createdAt)} · last signed in ${lastIn}.`);
            set('accountRowId', me.id || '—');
            set('accountRowCreated', when(me.createdAt));
            set('accountRowLogin', me.lastLogin ? new Date(me.lastLogin).toLocaleString() : '—');
            set('accountRowType', me.developer ? 'Developer' : 'Standard');
            showRecoveryCodeCount(me.recoveryCodesRemaining, me.recoveryCodesTotal);
        }
    } catch { /* identity from localStorage already shown */ }

    try {
        const res = await apiFetch(`${API_URL}/api-keys`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        if (res.ok) {
            const key = await res.json();
            const made = key.generatedAt ? when(key.generatedAt) : null;
            set('accountApiPrefix', key.hasKey ? `${key.prefix || 'ethr_'}…` : 'No key yet');
            set('accountApiStatus', key.hasKey ? `Active${made ? ` · made ${made}` : ''}.` : 'Make one on the API tab to call the API from your own code.');
            const state = document.getElementById('accountApiState');
            if (state) state.classList.toggle('dot', Boolean(key.hasKey));
        }
    } catch { /* leave defaults */ }
}

/** When the session token the browser holds runs out, from its own payload. */
function sessionExpiryText() {
    try {
        const token = localStorage.getItem('authToken') || '';
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (!payload.exp) return 'Expires when you sign out.';
        const at = new Date(payload.exp * 1000);
        return `Expires ${at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} unless you sign out first.`;
    } catch {
        return 'Expires when you sign out.';
    }
}

function copyAccountId() {
    const id = document.getElementById('accountRowId');
    if (id) copyToClipboard(id.textContent.trim());
}

/** The recovery-code row: how many are left, amber when running low. */
function showRecoveryCodeCount(remaining, total) {
    const row = document.getElementById('accountCodes');
    const count = document.getElementById('accountCodesCount');
    if (!row || !count) return;
    const left = Number(remaining) || 0;
    const of = Number(total) || 10;
    count.textContent = `${left} of ${of} unused`;
    row.classList.toggle('dot--warn', left <= 3);
}

function togglePasswordForm() {
    const form = document.getElementById('changePasswordForm');
    if (!form) return;
    const opening = form.classList.contains('hidden');
    form.classList.toggle('hidden', !opening);
    form.reset();
    const msg = document.getElementById('changePasswordMessage');
    if (msg) msg.innerHTML = '';
    if (opening) document.getElementById('currentPassword').focus();
}

/**
 * Change the password. The server refuses unless the current one verifies;
 * the two new ones are checked to match here, before the round trip.
 */
async function changePassword(event) {
    event.preventDefault();
    const msg = document.getElementById('changePasswordMessage');
    const button = document.getElementById('changePasswordBtn');
    const current = document.getElementById('currentPassword').value;
    const next = document.getElementById('newPassword').value;
    const again = document.getElementById('newPasswordAgain').value;

    const fail = (text) => { msg.innerHTML = `<div class="alert alert-error">${escapeHtml(text)}</div>`; };
    if (!current || !next || !again) return fail('Fill in all three fields.');
    if (next.length < 12) return fail('The new password needs at least 12 characters.');
    if (next !== again) return fail('The two new passwords do not match.');
    if (next === current) return fail('The new password is the same as the current one.');

    button.disabled = true;
    msg.innerHTML = '';
    try {
        const response = await apiFetch(`${API_URL}/auth/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
            body: JSON.stringify({ currentPassword: current, newPassword: next }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not change the password');
        togglePasswordForm();
        showToast('Password changed', 'success');
    } catch (error) {
        if (error.message !== 'Session expired') fail(error.message);
    } finally {
        button.disabled = false;
    }
}

/**
 * A fresh set of recovery codes. The old set stops working, so it asks
 * first; the new set is shown once, in the panel the API key uses.
 */
async function regenerateRecoveryCodes() {
    const ok = await confirmDialog({
        title: 'Make new recovery codes?',
        message: 'The codes you have now stop working the moment the new set is made. You will need to save the new ones.',
        confirmText: 'Make new codes',
    });
    if (!ok) return;
    try {
        const response = await apiFetch(`${API_URL}/auth/recovery-codes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.recoveryCodes)) throw new Error(data.message || 'Could not make new codes');
        showRecoveryCodes(data.recoveryCodes);
        showRecoveryCodeCount(data.recoveryCodes.length, data.recoveryCodes.length);
    } catch (error) {
        if (error.message !== 'Session expired') showToast(error.message, 'error');
    }
}

/** The codes, once. Assigned as text - they are credentials, not markup. */
function showRecoveryCodes(codes) {
    const panel = document.getElementById('recoveryCodesPanel');
    if (!panel) return;
    panel.innerHTML = `
        <div class="new-api-key__title">Save these codes now</div>
        <p class="new-api-key__note">This is the only time they will be shown. Each one resets your password once; the old set no longer works.</p>
        <div class="acct-codes" id="recoveryCodesList"></div>
        <div class="new-api-key__actions">
            <button type="button" class="btn-small btn-primary" data-on-click="copyRecoveryCodes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy all</button>
            <button type="button" class="btn-small btn-primary" data-on-click="dismissRecoveryCodes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>I've saved them</button>
        </div>
    `;
    const list = document.getElementById('recoveryCodesList');
    for (const code of codes) {
        const cell = document.createElement('span');
        cell.textContent = code;
        list.append(cell);
    }
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function copyRecoveryCodes() {
    const cells = document.querySelectorAll('#recoveryCodesList span');
    if (cells.length) copyToClipboard(Array.from(cells).map((c) => c.textContent).join('\n'));
}

function dismissRecoveryCodes() {
    const panel = document.getElementById('recoveryCodesPanel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.innerHTML = '';
}

// Dashboard Navigation
let currentChartPeriod = 'day';

/**
 * Back to the top of whatever scrolls. On a desktop that is the document;
 * on a phone the dashboard is the frame and the main column scrolls inside
 * it (dashboard.css, 860px), so both are reset.
 */
function scrollPageTop() {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    const main = document.getElementById('dashMain');
    if (main && main.scrollTop) main.scrollTop = 0;
}

/**
 * Show a page with its entrance: whatever it marks data-reveal comes in from
 * the left, staggered by data-reveal-delay, each time it is opened. The site's
 * reveal.js releases things as they scroll into view, which a page toggled
 * with display:none never does, so the switcher runs the entrance itself.
 *
 * The reset happens while the page is still hidden - a class removed from a
 * displayed element would fade it out first - and the hidden state is
 * committed with a reflow before the class goes back on, so the transition
 * has a starting frame. Reduced motion shows everything at once.
 */
function enterDashboardPage(pageEl) {
    const nodes = Array.from(pageEl.querySelectorAll('[data-reveal]'));
    const animate = nodes.length > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (animate) {
        for (const node of nodes) {
            node.classList.remove('is-revealed');
            const delay = node.getAttribute('data-reveal-delay');
            node.style.setProperty('--reveal-delay', delay ? `${delay}ms` : '0ms');
        }
    } else {
        for (const node of nodes) node.classList.add('is-revealed');
    }

    pageEl.style.display = 'block';

    // A page opens at its top; a scroll position from the last page would
    // otherwise carry over to this one.
    scrollPageTop();

    if (!animate) return;

    void pageEl.offsetWidth;
    requestAnimationFrame(() => {
        for (const node of nodes) node.classList.add('is-revealed');
    });
}

function switchDashboardPage(page) {
    currentDashboardPage = page;  // Update the current page tracker

    // Hide all pages
    document.querySelectorAll('.dashboard-page').forEach(el => {
        el.style.display = 'none';
    });

    // Show selected page, with its entrance
    const pageEl = document.getElementById(page + 'Page');
    if (pageEl) {
        enterDashboardPage(pageEl);
    }

    // Mark the matching nav item active. Matching on the link's own data-arg
    // rather than its position means adding or reordering nav items cannot
    // silently point the highlight at the wrong page.
    document.querySelectorAll('.nav-link').forEach((el) => {
        const on = el.getAttribute('data-arg') === page;
        el.classList.toggle('active', on);
        // The same state, readable to assistive tech.
        if (on) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });

    const loaders = {
        overview: loadDashboardData,
        transactions: loadTransactionsList,
        wallets: loadWalletsList,
        payouts: loadPayoutsList,
        withdrawal: loadWithdrawalPage,
        api: loadApiPage,
        checkout: loadCheckoutPage,
        createLink: loadCreateLinkPage,
        account: loadAccountPage,
    };

    if (typeof loaders[page] === 'function') {
        loaders[page]();
    }

    // Live session polling only makes sense while the checkout page is open,
    // and the price under the amount only while the form is.
    if (page === 'checkout') {
        startCheckoutPolling();
    } else {
        stopCheckoutPolling();
    }
    if (page !== 'createLink') stopCheckoutQuote();
    // and the API page's usage while it is open
    if (page === 'api') {
        startApiPolling();
    } else {
        stopApiPolling();
    }
}

function switchChartPeriod(period) {
    currentChartPeriod = period;
    // Update all period buttons
    document.getElementById('hourBtn').classList.remove('btn-primary');
    document.getElementById('hourBtn').classList.add('btn-secondary');
    document.getElementById('dayBtn').classList.remove('btn-primary');
    document.getElementById('dayBtn').classList.add('btn-secondary');
    document.getElementById('weekBtn').classList.remove('btn-primary');
    document.getElementById('weekBtn').classList.add('btn-secondary');
    
    // Set active button to black/primary
    const btnId = period + 'Btn';
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
    }
    
    loadAPICallsChart();
}

async function loadAPICallsChart() {
    try {
        const token = localStorage.getItem('authToken');

        // Fetch API calls data
        const response = await fetch(`/api/api-calls/stats?period=${currentChartPeriod}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) throw new Error('Failed to fetch API calls');

        const data = await response.json();
        const ctx = document.getElementById('apiCallsChart').getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.apiCallsChartInstance) {
            window.apiCallsChartInstance.destroy();
        }

        const chartTheme = readChartTheme();

        // Create new chart
        window.apiCallsChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.labels || [],
                datasets: [{
                    label: `API Calls (${currentChartPeriod})`,
                    data: data.values || [],
                    borderColor: chartTheme.line,
                    backgroundColor: chartTheme.fill,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 4,
                    pointBackgroundColor: chartTheme.line,
                    pointBorderColor: chartTheme.surface,
                    pointBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: chartTheme.grid },
                        ticks: { color: chartTheme.text }
                    },
                    x: {
                        grid: { color: chartTheme.grid },
                        ticks: { color: chartTheme.text }
                    }
                }
            }
        });

        // Update subtitle with live counts
        const periodLabel = { hour: 'last hour', day: 'last 24h', week: 'last 7 days' }[currentChartPeriod] || '';
        const periodTotal = data.periodTotal || 0;
        const subtitleEl = document.getElementById('apiCallsSubtitle');
        if (subtitleEl) {
            subtitleEl.textContent = `${periodTotal} call${periodTotal !== 1 ? 's' : ''} in the ${periodLabel} · ${data.totalCalls} total`;
        }
        // The same figure, in the fact strip at the top of the page.
        const totalEl = document.getElementById('apiCallsTotal');
        if (totalEl) totalEl.textContent = String(data.totalCalls ?? 0);
    } catch (error) {
    }
}

/**
 * Chart colours pulled from the CSS tokens, so the graph follows the theme.
 * Chart.js paints to a canvas and cannot use CSS variables directly, so the
 * values are read off the document at render time.
 */
function readChartTheme() {
    const styles = getComputedStyle(document.documentElement);
    const token = (name, fallback) => (styles.getPropertyValue(name) || '').trim() || fallback;

    const line = token('--ink', '#1a1a1a');
    return {
        line,
        surface: token('--surface', '#ffffff'),
        grid: token('--line', '#f0f0f0'),
        text: token('--ink-3', '#6b7280'),
        // A translucent wash under the line, matching the stroke colour.
        fill: `color-mix(in srgb, ${line} 8%, transparent)`,
    };
}

/** Repaint the chart when the theme changes - canvas colours are baked in. */
window.addEventListener('themechange', () => {
    if (window.apiCallsChartInstance && typeof loadAPICallsChart === 'function') {
        loadAPICallsChart();
    }
});

async function loadTransactionsList() {
    const tbody = document.getElementById('allTransactionsList');
    if (!tbody) return;

    const empty = (message, retry) => {
        tbody.innerHTML = `<tr class="dash-table__empty"><td colspan="7">${message}${retry ? ' <button type="button" data-on-click="loadTransactionsList">Retry</button>' : ''}</td></tr>`;
        setTxCount(0);
    };

    try {
        const response = await apiFetch(`${API_URL}/transactions/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            empty('Couldn\u2019t load transactions.', true);
            return;
        }

        let transactions = await response.json();
        if (Array.isArray(transactions)) {
            transactions = transactions.filter(t =>
                t.status === 'PENDING' || t.status === 'PROCESSING' || t.status === 'CONFIRMED' || t.status === 'COMPLETED' || t.status === 'FAILED'
            );
        } else {
            transactions = [];
        }

        allTransactions = transactions;
        applyTxFilter();
    } catch (error) {
        empty('Couldn\u2019t load transactions.', true);
    }
}

/**
 * One wallet row. The name, when set, leads; the address sits under it.
 */
// The row's glyphs, as the family draws them: filled buttons, icon only.
const WALLET_GLYPHS = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
    withdraw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V4M5 13l7 7 7-7"/></svg>',
};

/**
 * The block explorer's page for an address, from the registry's transaction
 * URL with /tx/ swapped for /address/. Left off, rather than guessed, for a
 * chain whose explorer does not follow that shape.
 */
function explorerAddressUrl(chain, address) {
    const tx = PAYOUT_CHAINS[chain] && PAYOUT_CHAINS[chain].explorerTx;
    if (!tx || !/\/tx\/$/.test(tx)) return null;
    return `${tx.replace(/\/tx\/$/, '/address/')}${address}`;
}

/**
 * A wallet as a row: chain badge, name and short address, balance in coin
 * and USD (with anything held for fees said in amber), state, and the
 * actions. Clicking the row itself opens it to the address, its three
 * balances and a QR; the buttons do not.
 */
function renderWalletCard(w, { deletable = false } = {}) {
    const chain = w.chain;
    const symbol = chainSymbol(chain);
    const shortAddress = `${w.address.substring(0, 8)}…${w.address.substring(w.address.length - 6)}`;
    const title = w.label
        ? `<span class="wallet-row__name" id="wallet-label-${w.id}">${escapeHtml(w.label)}</span>`
        : `<span class="wallet-row__name wallet-row__name--empty" id="wallet-label-${w.id}">Unnamed wallet</span>`;
    const held = Number(w.platformFeeHeld) || 0;
    const heldNote = held > 0 ? ` <span class="held">· ${escapeHtml(formatBalance(held))} held for fees</span>` : '';
    // Bake the searchable text into the row so filtering never depends on a
    // separate lookup that could be out of sync with what is on screen.
    const searchText = `${w.label || ''} ${w.address} ${chain} ${symbol} ${PAYOUT_CHAINS[chain]?.name || ''}`.toLowerCase();
    return `<div class="wallet-row" data-wallet-id="${w.id}" data-chain="${escapeHtml(chain)}" data-search="${escapeHtml(searchText)}" role="button" tabindex="0" aria-expanded="false">
        <span class="wallet-row__badge chain-mark" title="${escapeHtml(PAYOUT_CHAINS[chain]?.name || chain)}">${chainLogo(chain, escapeHtml(symbol))}</span>
        <div class="wallet-row__who">
            ${title}
            <span class="wallet-row__addr" title="${escapeHtml(w.address)}">${escapeHtml(shortAddress)}</span>
        </div>
        <div class="wallet-row__bal">
            <b title="${escapeHtml(String(w.balance))} ${escapeHtml(symbol)}">${escapeHtml(formatBalance(w.balance))} ${escapeHtml(symbol)}</b>
            <span>${usd(w.balanceUSD)}${heldNote}</span>
        </div>
        <span class="wallet-row__state">${w.isProcessing ? '<span class="status-pill status-pill--verifying">Confirming</span>' : '<span class="status-pill status-pill--confirmed">Active</span>'}</span>
        <div class="wallet-row__acts">
            <button type="button" class="btn-small btn-primary btn-icon" data-on-click="copyToClipboard" data-arg="${escapeHtml(w.address)}" title="Copy address" aria-label="Copy address">${WALLET_GLYPHS.copy}</button>
            <button type="button" class="btn-small btn-primary btn-icon" data-on-click="renameWallet" data-arg="${w.id}" title="Rename" aria-label="Rename wallet">${WALLET_GLYPHS.rename}</button>
            ${deletable ? `<button type="button" class="btn-small btn-danger btn-icon" data-on-click="deleteWallet" data-arg="${w.id}" data-arg2="${escapeHtml(chain)}" title="Delete" aria-label="Delete wallet">${WALLET_GLYPHS.remove}</button>` : ''}
        </div>
    </div>
    <div class="wallet-detail hidden" data-wallet-id="${w.id}"></div>`;
}

/** The row, open: the address, its three balances, a QR, and the ways on. */
function renderWalletDetails(w) {
    const chain = w.chain;
    const symbol = chainSymbol(chain);
    const explorer = explorerAddressUrl(chain, w.address);
    const made = w.createdAt ? new Date(w.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
    const fact = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
    const muted = (text) => `<span class="muted">· ${text}</span>`;
    return `<div class="wallet-detail__in">
        <div class="wallet-detail__qr" data-wallet-qr="${w.id}" aria-label="QR code of the address"></div>
        <div class="wallet-detail__facts">
            ${fact('Address', `<span class="mono">${escapeHtml(w.address)}</span>`)}
            ${fact('Available', `${escapeHtml(formatBalance(w.balance))} ${escapeHtml(symbol)} ${muted(`${usd(w.balanceUSD)} · yours to withdraw`)}`)}
            ${fact('On chain', `${escapeHtml(formatBalance(w.onChainBalance))} ${escapeHtml(symbol)} ${muted('what the address holds')}`)}
            ${fact('Held for fees', `${escapeHtml(formatBalance(w.platformFeeHeld))} ${escapeHtml(symbol)} ${muted('from earlier withdrawals, awaiting collection')}`)}
            ${fact('Made', escapeHtml(made))}
            ${explorer ? fact('Explorer', `<a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer">${escapeHtml(explorer.replace(/^https?:\/\//, '').slice(0, 40))}…</a>`) : ''}
        </div>
        <div class="wallet-detail__foot">
            <button type="button" class="btn-small btn-primary" data-on-click="copyToClipboard" data-arg="${escapeHtml(w.address)}">${WALLET_GLYPHS.copy}Copy address</button>
            <button type="button" class="btn-small btn-primary" data-on-click="switchDashboardPage" data-arg="withdrawal">${WALLET_GLYPHS.withdraw}Withdraw from it</button>
        </div>
    </div>`;
}

/** The address as a QR, drawn by the server. Without it the address is still there. */
async function loadWalletQr(walletId) {
    const holders = document.querySelectorAll(`[data-wallet-qr="${CSS.escape(String(walletId))}"]`);
    if (holders.length === 0) return;
    try {
        const response = await apiFetch(`${API_URL}/wallets/${encodeURIComponent(walletId)}/qr`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
        const data = await response.json();
        holders.forEach((holder) => {
            if (response.ok && data.svg) holder.innerHTML = data.svg;
            else dropWalletQr(holder);
        });
    } catch {
        holders.forEach(dropWalletQr);
    }
}

/** No QR to show: the column goes with it, so the facts take the width. */
function dropWalletQr(holder) {
    const panel = holder.closest('.wallet-detail__in');
    if (panel) panel.classList.add('no-qr');
    holder.remove();
}

/** Open or close a row. The details are drawn the first time it opens. */
function toggleWalletDetails(row) {
    const walletId = row.dataset.walletId;
    const detail = row.nextElementSibling;
    if (!detail || !detail.classList.contains('wallet-detail')) return;
    const opening = detail.classList.contains('hidden');
    if (opening && !detail.innerHTML) {
        const wallet = (Array.isArray(wallets) ? wallets : []).find((w) => w.id === walletId);
        if (!wallet) return;
        detail.innerHTML = renderWalletDetails(wallet);
        loadWalletQr(walletId);
    }
    detail.classList.toggle('hidden', !opening);
    row.classList.toggle('is-open', opening);
    row.setAttribute('aria-expanded', String(opening));
}

// One delegated listener for every wallet row, wherever it is rendered: a
// click or Enter/Space on the row opens it; its buttons and the rename form
// keep their own jobs.
(function wireWalletRows() {
    const isControl = (target) => Boolean(target.closest('button, a, input, form, select'));
    document.addEventListener('click', (event) => {
        const row = event.target.closest('.wallet-row');
        if (!row || isControl(event.target)) return;
        toggleWalletDetails(row);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest && event.target.closest('.wallet-row');
        if (!row || event.target !== row) return;
        event.preventDefault();
        toggleWalletDetails(row);
    });
})();

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Turn a wallet's name into an inline editor. Saving PATCHes the label and
 * re-renders; Escape or Cancel puts the name back.
 */
function renameWallet(walletId) {
    const wallet = wallets.find((w) => w.id === walletId);
    const holder = document.getElementById(`wallet-label-${walletId}`);
    if (!wallet || !holder || holder.querySelector('form')) return;

    holder.innerHTML = `
        <form class="wallet-rename" data-on-submit="saveWalletLabel" data-wallet-id="${walletId}">
            <input type="text" maxlength="40" value="${escapeHtml(wallet.label || '')}" placeholder="Wallet name" aria-label="Wallet name" autocomplete="off" />
            <button type="submit" class="btn-small btn-primary btn-icon" title="Save" aria-label="Save name"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></button>
            <button type="button" class="btn-small btn-primary btn-icon" data-on-click="cancelRenameWallet" data-arg="${walletId}" title="Cancel" aria-label="Cancel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </form>`;
    const input = holder.querySelector('input');
    input.focus();
    input.select();
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancelRenameWallet(walletId); });
}

/** Put the name back in the editor's place, so a refresh can write to it. */
function restoreWalletName(walletId) {
    const wallet = wallets.find((w) => w.id === walletId);
    document.querySelectorAll(`[id="wallet-label-${CSS.escape(String(walletId))}"]`).forEach((holder) => {
        holder.textContent = wallet && wallet.label ? wallet.label : 'Unnamed wallet';
        holder.classList.toggle('wallet-row__name--empty', !(wallet && wallet.label));
    });
}

function cancelRenameWallet(walletId) {
    restoreWalletName(walletId);
    displayWallets();
    loadWalletsList();
}

async function saveWalletLabel(event) {
    event.preventDefault();
    const form = event.target;
    const walletId = form.dataset.walletId;
    const input = form.querySelector('input');
    const label = input ? input.value : '';

    try {
        const response = await apiFetch(`${API_URL}/wallets/${encodeURIComponent(walletId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
            body: JSON.stringify({ label }),
        });
        if (!response.ok) {
            showToast(await errorMessageFrom(response, 'Could not rename the wallet'), 'error');
            return;
        }
        const updated = await response.json();
        const index = wallets.findIndex((w) => w.id === walletId);
        if (index !== -1) wallets[index] = { ...wallets[index], label: updated.label };
        restoreWalletName(walletId);
        displayWallets();
        loadWalletsList();
        showToast(updated.label ? `Renamed to "${updated.label}"` : 'Name cleared', 'success');
    } catch (error) {
        if (error.message !== 'Session expired') showToast('Could not rename the wallet', 'error');
    }
}

// The chain chip in force on the Wallets page; '' is all of them.
let walletChainFilter = '';

/** Chips for the chains the account actually has, in the order they appear. */
function renderWalletChips() {
    const host = document.getElementById('walletChips');
    if (!host) return;
    const chains = [];
    for (const w of (Array.isArray(wallets) ? wallets : [])) if (!chains.includes(w.chain)) chains.push(w.chain);
    if (chains.length < 2) { host.innerHTML = ''; walletChainFilter = ''; return; }
    if (walletChainFilter && !chains.includes(walletChainFilter)) walletChainFilter = '';
    host.innerHTML = [['', 'All'], ...chains.map((c) => [c, c])].map(([value, label]) =>
        `<button type="button" data-on-click="setWalletChip" data-arg="${escapeHtml(value)}" aria-pressed="${walletChainFilter === value}">${escapeHtml(label)}</button>`).join('');
}

function setWalletChip(chain) {
    walletChainFilter = typeof chain === 'string' ? chain : '';
    document.querySelectorAll('#walletChips button').forEach((chip) => {
        chip.setAttribute('aria-pressed', String((chip.getAttribute('data-arg') || '') === walletChainFilter));
    });
    filterWallets();
}

/** Filter the Wallets page by the search and the chain chip together. */
function filterWallets() {
    const query = (document.getElementById('walletSearch')?.value || '').trim().toLowerCase();
    const items = document.querySelectorAll('#allWalletsList .wallet-row');
    let shown = 0;
    items.forEach((item) => {
        // Read the haystack straight off the row (see renderWalletCard).
        const hay = item.dataset.search || '';
        const match = (!query || hay.includes(query)) && (!walletChainFilter || item.dataset.chain === walletChainFilter);
        item.classList.toggle('hidden', !match);
        // an open row's details go with it
        const detail = item.nextElementSibling;
        if (detail && detail.classList.contains('wallet-detail') && !match) detail.classList.add('hidden');
        if (match && item.classList.contains('is-open') && detail) detail.classList.remove('hidden');
        if (match) shown += 1;
    });
    // Hide chain groups that have nothing left in them.
    document.querySelectorAll('#allWalletsList .wallet-group').forEach((group) => {
        group.classList.toggle('hidden', !group.querySelector('.wallet-row:not(.hidden)'));
    });
    const empty = document.getElementById('walletSearchEmpty');
    if (empty) empty.classList.toggle('hidden', shown > 0 || items.length === 0);
    const countEl = document.getElementById('walletsPageCount');
    if (countEl && items.length > 0) {
        countEl.textContent = shown === items.length
            ? (items.length === 1 ? '1 wallet' : `${items.length} wallets`)
            : `${shown} of ${items.length} wallets`;
    }
}

function loadWalletsList() {
    // Display all wallets for the wallets page, grouped by chain
    const countEl = document.getElementById('walletsPageCount');
    if (countEl) countEl.textContent = wallets.length === 1 ? '1 wallet' : `${wallets.length} wallets`;
    if (!wallets || wallets.length === 0) {
        document.getElementById('allWalletsList').innerHTML = '<div class="dash-empty">No wallets yet. Add one to start receiving payments.</div>';
        renderWalletChips();
        return;
    }

    // Rows already there for this list: refresh in place, keep what is open.
    const list = document.getElementById('allWalletsList');
    if (!list.querySelector('form.wallet-rename') && syncWalletRows(list, wallets)) {
        renderWalletChips();
        filterWallets();
        return;
    }

    // Group wallets by chain
    const byChain = {};
    wallets.forEach(w => {
        if (!byChain[w.chain]) byChain[w.chain] = [];
        byChain[w.chain].push(w);
    });

    let html = '';
    Object.entries(byChain).forEach(([chain, chainWallets]) => {
        html += `<div class="wallet-group">
            <div class="wallet-group__title">${PAYOUT_CHAINS[chain]?.name || chain}${chainSymbol(chain) !== chain ? ` · ${chainSymbol(chain)}` : ''}</div>
        `;

        chainWallets.forEach(w => {
            html += renderWalletCard(w, { deletable: true });
        });

        html += '</div>';
    });

    document.getElementById('allWalletsList').innerHTML = html + '<div id="walletSearchEmpty" class="wallet-search-empty hidden">No wallets match that search.</div>';
    loadSVGIcons();
    renderWalletChips();
    filterWallets();
}

async function deleteWallet(walletId, chain) {
    const ok = await confirmDialog({
        title: `Delete this ${chain} wallet?`,
        message: 'Its address stops receiving and cannot be restored. Anything already in it is swept out first.',
        confirmText: 'Delete wallet',
        cancelText: 'Keep it',
        danger: true,
    });
    if (!ok) return;

    try {
        const response = await apiFetch(`${API_URL}/wallets/delete`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId'),
                walletId
            })
        });
        if (!response.ok) {
            const data = await response.json();
            showToast(data.message || 'Failed to delete wallet', 'error');
            return;
        }
        showToast(`${chain} wallet deleted`, 'success');
        await loadWallets();
        loadWalletsList();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function loadPayoutsList() {
    const tbody = document.getElementById('allPayoutsList');
    if (!tbody) return;
    const fail = () => {
        tbody.innerHTML = '<tr class="dash-table__empty"><td colspan="8">Couldn\u2019t load payouts. <button type="button" data-on-click="loadPayoutsList">Retry</button></td></tr>';
    };
    try {
        const response = await apiFetch(`${API_URL}/payouts/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (!response.ok) { fail(); return; }
        const payload = await response.json();
        const payouts = Array.isArray(payload) ? payload : payload.payouts || [];
        allPayouts = Array.isArray(payouts) ? payouts.filter(p =>
            p.status === 'PENDING' || p.status === 'PROCESSING' || p.status === 'COMPLETED' || p.status === 'FAILED' || p.status === 'PARTIAL'
        ) : [];
        applyPayoutFilter();
    } catch (error) {
        fail();
    }
}

// The payout rows open like the transaction rows; the same delegated toggle.
(function wirePayoutRows() {
    const table = document.getElementById('payoutTable');
    const chips = document.getElementById('payoutChips');
    if (!table) return;
    function toggle(row) {
        const open = row.getAttribute('aria-expanded') === 'true';
        const detail = document.getElementById(row.getAttribute('aria-controls'));
        row.setAttribute('aria-expanded', String(!open));
        if (!detail) return;
        if (open) {
            detail.classList.remove('open');
            setTimeout(() => { if (!detail.classList.contains('open')) detail.hidden = true; }, 260);
        } else {
            detail.hidden = false;
            requestAnimationFrame(() => detail.classList.add('open'));
        }
    }
    table.addEventListener('click', (event) => {
        if (event.target.closest('a, button')) return;
        const row = event.target.closest('tr.row');
        if (row) toggle(row);
    });
    table.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('tr.row');
        if (!row || event.target !== row) return;
        event.preventDefault();
        toggle(row);
    });
    if (chips) chips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        payoutFilter = button.dataset.filter;
        chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        applyPayoutFilter();
    });
})();

// Initialize API calls chart on page load
window.addEventListener('DOMContentLoaded', () => {
    // Set initial button state - Day is active (black), others are normal
    document.getElementById('hourBtn').classList.add('btn-secondary');
    document.getElementById('hourBtn').classList.remove('btn-primary');
    document.getElementById('dayBtn').classList.add('btn-primary');
    document.getElementById('dayBtn').classList.remove('btn-secondary');
    document.getElementById('weekBtn').classList.add('btn-secondary');
    document.getElementById('weekBtn').classList.remove('btn-primary');
    loadAPICallsChart();

    // Auto-refresh the API calls chart every 30 seconds
    setInterval(loadAPICallsChart, 30000);
});

// ========== WITHDRAWAL SECTION (from withdrawal.js) ==========

/**
 * Three steps on a rail - Destination, Sources, Review - and a fourth stage,
 * Sent, that is not a step: once the payout exists the rail is all ticks and
 * the only way on is a new withdrawal.
 */
function goToStep(step) {
    if (step > 4 || step < 1) return;
    document.querySelectorAll('.wd-stage').forEach((el) => el.classList.remove('active'));
    const stage = document.getElementById(`step${step}`);
    if (stage) stage.classList.add('active');
    document.querySelectorAll('.wd-rail li').forEach((el, idx) => {
        el.classList.toggle('is-done', idx + 1 < step);
        el.classList.toggle('is-now', idx + 1 === step);
    });
    currentStep = step;
    scrollPageTop();
}

/** A finished step on the rail is a way back; the sent stage is not. */
function goBackToStep(step) {
    if (currentStep === 4 || step >= currentStep) return;
    goToStep(step);
}

/** The head's figure: what could be withdrawn right now, from the wallet list. */
function updateWithdrawalAvailable() {
    const figure = document.getElementById('wdAvailable');
    const note = document.getElementById('wdAvailableNote');
    if (!figure || !note) return;
    const list = Array.isArray(wallets) ? wallets : [];
    const ready = list.filter((w) => (w.balanceUSD || 0) >= 5 && !w.isProcessing);
    figure.textContent = usd(ready.reduce((sum, w) => sum + (w.balanceUSD || 0), 0));
    note.textContent = list.length === 0
        ? 'no wallets yet'
        : `available across ${ready.length} of ${list.length} wallet${list.length === 1 ? '' : 's'}`;
}

/** Opening the page: the figure in the head, and the address line. After a
 *  payout the swept wallets are busy, so that call asks the server again. */
async function loadWithdrawalPage(refresh) {
    if (refresh || !Array.isArray(wallets) || wallets.length === 0) {
        try {
            const response = await apiFetch(`${API_URL}/wallets/list`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
            const data = await response.json();
            if (response.ok && Array.isArray(data)) wallets = data;
        } catch {
            // the figure stays a dash; the steps still work
        }
    }
    updateWithdrawalAvailable();
    checkRecipientAddress();
}

/** Start over after a payout: the form is empty and the rail is back at one. */
function newWithdrawal() {
    previewData = null;
    clearStep1();
    const container = document.getElementById('wallets-container');
    if (container) container.innerHTML = '';
    for (const id of ['step1-message', 'step2-message', 'step3-message', 'step4-message', 'wdSentReceipt', 'final-summary']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    updateWithdrawTally();
    checkRecipientAddress();
    goToStep(1);
    loadWithdrawalPage(true);
}

// ─── Payout chain ────────────────────────────────────────────────────────────

// Address shapes by signing family. The chain list itself comes from the
// server (/api/chains), so a chain added to the registry appears here on the
// next load without a front-end change.
const FAMILY_ADDRESS = {
    evm: { placeholder: '0x…', pattern: /^0x[a-fA-F0-9]{40}$/ },
    solana: { placeholder: 'Base58 address', pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
};
const UTXO_ADDRESS = {
    BTC: { placeholder: 'bc1… or 1… or 3…', pattern: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
    LTC: { placeholder: 'ltc1… or L… or M…', pattern: /^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/ },
};

// Filled from /api/chains: code -> { name, symbol, family, placeholder, pattern, ... }
const PAYOUT_CHAINS = {
    ETH: { name: 'Ethereum', symbol: 'ETH', family: 'evm', placeholder: '0x…', pattern: /^0x[a-fA-F0-9]{40}$/ },
};
let CHAIN_LIST = [];

/** Fetch the supported chains and fill every chain picker on the page. */
async function loadChains() {
    try {
        const response = await fetch(`${API_URL}/chains`);
        if (!response.ok) return;
        const data = await response.json();
        CHAIN_LIST = data.chains || [];
    } catch {
        return;
    }

    for (const chain of CHAIN_LIST) {
        const shape = FAMILY_ADDRESS[chain.family] || UTXO_ADDRESS[chain.code] || { placeholder: 'Address', pattern: /.+/ };
        PAYOUT_CHAINS[chain.code] = { ...chain, ...shape };
    }

    // Overview stat: how many chains this deployment supports, from the server.
    const chainCount = document.getElementById('supportedChainCount');
    if (chainCount && CHAIN_LIST.length) chainCount.textContent = String(CHAIN_LIST.length);

    const label = (chain) => (chain.symbol === chain.code ? `${chain.name} (${chain.symbol})` : `${chain.name} (${chain.symbol} on ${chain.name})`);

    const payout = document.getElementById('payoutChain');
    if (payout) {
        const keep = payout.value || 'ETH';
        payout.innerHTML = CHAIN_LIST.map((c) => `<option value="${c.code}">${label(c)}</option>`).join('');
        payout.value = PAYOUT_CHAINS[keep] ? keep : 'ETH';
    }

    const wallet = document.getElementById('walletChain');
    if (wallet) {
        wallet.innerHTML = '<option value="">Choose a chain...</option>' +
            CHAIN_LIST.map((c) => `<option value="${c.code}">${label(c)}</option>`).join('');
    }
}

/** Ticker for a chain code - "ETH" for BASE, not "BASE". */
function chainSymbol(code) {
    return (PAYOUT_CHAINS[code] && PAYOUT_CHAINS[code].symbol) || code;
}

/**
 * Crypto balances can carry ~18 decimals; showing them all overflows the card on
 * mobile. Cap at 8 decimals (plenty for display), trim trailing zeros, and flag
 * dust rather than rounding it to a bare "0".
 */
function formatBalance(value) {
    const n = Number(value);
    if (!isFinite(n) || n === 0) return '0';
    if (n > 0 && n < 0.00000001) return '<0.00000001';
    return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function selectedPayoutChain() {
    const select = document.getElementById('payoutChain');
    return select ? select.value : 'ETH';
}

/**
 * Retarget the address field when the payout chain changes. The previously
 * typed address is almost certainly for the old chain, so it is cleared rather
 * than left to fail validation later.
 */
function onPayoutChainChange() {
    const chain = selectedPayoutChain();
    const spec = PAYOUT_CHAINS[chain];
    const input = document.getElementById('recipientAddress');
    const hint = document.getElementById('payoutChainHint');

    if (input) {
        input.placeholder = spec.placeholder;
        input.value = '';
    }
    if (hint) {
        hint.textContent = `${spec.name} wallets are sent directly, with no swap and no $5 swap minimum. Everything else is swapped at a rate quoted on the review.`;
    }

    const msg = document.getElementById('step1-message');
    if (msg) msg.innerHTML = '';
    checkRecipientAddress();
}

/**
 * Client-side shape check. The server validates properly - this is only to
 * catch an obvious mistake before a round trip.
 */
function looksLikeAddressFor(chain, address) {
    const spec = PAYOUT_CHAINS[chain];
    return spec ? spec.pattern.test(address) : false;
}

/**
 * The line under the address, as it is typed: "looks like" an address for
 * the chosen chain, or what one would look like. Says "looks like" because a
 * shape check is all it knows.
 */
function checkRecipientAddress() {
    const input = document.getElementById('recipientAddress');
    const hint = document.getElementById('recipientHint');
    if (!input || !hint) return;
    const chain = selectedPayoutChain();
    const spec = PAYOUT_CHAINS[chain] || { name: chain, placeholder: 'an address' };
    const value = input.value.trim();
    hint.classList.remove('is-ok', 'is-bad');
    if (!value) {
        hint.textContent = 'The address you control on this chain. Checked for shape here; the server checks it properly.';
    } else if (looksLikeAddressFor(chain, value)) {
        hint.textContent = `Looks like a ${spec.name} address`;
        hint.classList.add('is-ok');
    } else {
        hint.textContent = `Does not look like a ${spec.name} address (expected ${spec.placeholder})`;
        hint.classList.add('is-bad');
    }
}

async function loadWithdrawalWallets() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const chain = selectedPayoutChain();
    const msg = document.getElementById('step1-message');

    if (!recipientAddress) {
        msg.innerHTML = `<div class="alert alert-error">Enter the ${PAYOUT_CHAINS[chain].name} address to receive your payout</div>`;
        return;
    }
    if (!looksLikeAddressFor(chain, recipientAddress)) {
        msg.innerHTML = `<div class="alert alert-error">That does not look like a ${PAYOUT_CHAINS[chain].name} address (expected ${PAYOUT_CHAINS[chain].placeholder})</div>`;
        return;
    }

    msg.innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Loading wallets...</div>';

    try {
        // If wallets are already loaded (from dashboard context), use them
        if (wallets && Array.isArray(wallets) && wallets.length > 0) {
            displayWalletSelection(wallets);
            msg.innerHTML = '';
            goToStep(2);
            return;
        }

        // Otherwise, fetch from API (for standalone page)
        const response = await apiFetch(`${API_URL}/wallets/list`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        wallets = await response.json();
        if (!response.ok || !Array.isArray(wallets) || wallets.length === 0) {
            msg.innerHTML = '<div class="alert alert-error">No wallets found</div>';
            return;
        }
        displayWalletSelection(wallets);
        msg.innerHTML = '';
        goToStep(2);
    } catch (error) {
        msg.innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
    }
}

/**
 * The wallet row with a checkbox. A wallet that cannot be withdrawn from
 * stays in the list and says why on its own row - confirming, or below $5 -
 * and an eligible one says whether it goes direct or through a swap.
 */
function displayWalletSelection(wallets) {
    const container = document.getElementById('wallets-container');
    const payoutChain = selectedPayoutChain();
    let eligible = 0;
    container.innerHTML = wallets.map((wallet) => {
        const balanceUSD = wallet.balanceUSD || 0;
        const isEligible = balanceUSD >= 5 && !wallet.isProcessing;
        if (isEligible) eligible++;
        const why = wallet.isProcessing
            ? '<span class="status-pill status-pill--verifying">Confirming</span>'
            : (isEligible
                ? `<span class="status-pill status-pill--confirmed">${wallet.chain === payoutChain ? 'Direct' : 'Swap'}</span>`
                : '<span class="status-pill status-pill--closed">Below $5</span>');
        const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
        return `<label class="wd-src${isEligible ? '' : ' is-off'}">
            <input type="checkbox" name="withdrawChain" value="${escapeHtml(wallet.address)}" ${isEligible ? '' : 'disabled'} />
            <span class="wd-src__badge chain-mark" title="${escapeHtml(PAYOUT_CHAINS[wallet.chain]?.name || wallet.chain)}">${chainLogo(wallet.chain, escapeHtml(wallet.chain))}</span>
            <span class="wd-src__who"><b>${wallet.label ? escapeHtml(wallet.label) : 'Unnamed wallet'}</b><span>${escapeHtml(short)}</span></span>
            <span class="wd-src__bal"><b>${formatBalance(wallet.balance)} ${escapeHtml(chainSymbol(wallet.chain))}</b><span>${usd(balanceUSD)}</span></span>
            ${why}
        </label>`;
    }).join('');
    // Zero eligible wallets is not a success, whatever the count says; with
    // some, the tally under the rows is the summary.
    document.getElementById('step2-message').innerHTML = eligible > 0
        ? ''
        : '<div class="alert alert-error"><span class="inline-icon" data-icon="close"></span>No wallets are ready to withdraw. Each needs at least $5 and no transaction in progress.</div>';
    updateWithdrawTally();
    loadSVGIcons();
}

/** The tally under the rows follows the checkboxes. */
function updateWithdrawTally() {
    const label = document.getElementById('wdTallyLabel');
    const tally = document.getElementById('wdTally');
    if (!label || !tally) return;
    const boxes = Array.from(document.querySelectorAll('#wallets-container input[name="withdrawChain"]'));
    const eligible = boxes.filter((box) => !box.disabled);
    const picked = eligible.filter((box) => box.checked);
    const list = Array.isArray(wallets) ? wallets : [];
    const sum = picked.reduce((total, box) => {
        const wallet = list.find((w) => w.address === box.value);
        return total + (wallet ? (wallet.balanceUSD || 0) : 0);
    }, 0);
    tally.textContent = usd(sum);
    label.textContent = eligible.length === 0
        ? 'No eligible wallets'
        : (picked.length === 0
            ? `Nothing selected · ${eligible.length} eligible`
            : `Selected · ${picked.length} of ${eligible.length} eligible`);
}

async function getPreview() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const selectedWallets = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    if (selectedWallets.length === 0) {
        document.getElementById('step2-message').innerHTML = '<div class="alert alert-error">Please select at least one wallet</div>';
        return;
    }
    document.getElementById('step2-message').innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Loading preview...</div>';
    try {
        const response = await apiFetch(`${API_URL}/withdrawal/preview`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                recipientAddress,
                payoutChain: selectedPayoutChain(),
                selectedWallets
            })
        });
        const result = await response.json();
        if (!response.ok) {
            document.getElementById('step2-message').innerHTML = `<div class="alert alert-error">Error: ${result.message || 'Unknown'}</div>`;
            return;
        }
        previewData = result.data;
        displayPreview();
        goToStep(3);
    } catch (error) {
        document.getElementById('step2-message').innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
    }
}

/**
 * Money formatting for the review screens.
 */
function usd(value) {
    return `$${(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A wallet's name for the receipt: its label, else its short address. */
function walletLabelFor(address) {
    const wallet = (Array.isArray(wallets) ? wallets : []).find((w) => w.address === address);
    if (wallet && wallet.label) return wallet.label;
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'wallet';
}

/**
 * One block per transfer in the plan. Every figure is the server's - the
 * same plan that will be broadcast - so the lines and the totals agree.
 */
function renderTransferBreakdown(data) {
    const transfers = Array.isArray(data.transfers) ? data.transfers : [];
    if (transfers.length === 0) return '';
    const rate = Math.round((data.platformFeeRate || 0.05) * 100);

    return transfers.map((t) => {
        const from = PAYOUT_CHAINS[t.chain] || { name: t.chain };
        const route = t.type === 'DIRECT_TRANSFER'
            ? 'direct, no swap'
            : `swapped to ${escapeHtml(chainSymbol(t.payoutChain))} at a fixed rate`;
        const gasNote = t.gasIsLive ? '' : ' <span class="muted">· estimate</span>';
        return `<div class="receipt__src">
            <div class="h"><span>${escapeHtml(from.name)} · ${escapeHtml(walletLabelFor(t.fromAddress))}</span><span>${route}</span></div>
            <div><span>Amount</span><span>${usd(t.grossUsd)}</span></div>
            <div><span>Platform fee (${rate}%)</span><span>−${usd(t.platformFeeUsd)}</span></div>
            <div><span>Network fee${gasNote}</span><span>−${usd(t.gasUsd)}</span></div>
        </div>`;
    }).join('');
}

function renderTotals(data) {
    return `<div class="receipt__tot">
        <div><span>Total</span><span>${usd(data.grossSweptUsd ?? data.totalAmountUsd)}</span></div>
        <div><span>Platform fee</span><span>−${usd(data.platformFee)}</span></div>
        <div><span>Network fees</span><span>−${usd(data.totalGasUsd)}</span></div>
        <div class="net"><span>You receive</span><span>${usd(data.netAmountUsd)}</span></div>
    </div>`;
}

/** The one button names what it sends. */
function setSendButton(netUsd, busy) {
    const button = document.getElementById('confirmBtn');
    const label = document.getElementById('confirmBtnLabel');
    if (!button) return;
    button.disabled = Boolean(busy);
    button.classList.toggle('is-busy', Boolean(busy));
    if (label) label.textContent = busy ? 'Sending…' : `Send ${usd(netUsd)}`;
}

/**
 * The receipt: per source, then the totals, then where it goes. This is the
 * review and the confirmation in one - the warning sits under it and the
 * button beneath names the figure.
 */
function displayPreview() {
    const data = previewData;
    const chain = PAYOUT_CHAINS[data.payoutChain] || { name: data.payoutChain, symbol: data.payoutChain };
    const transfers = Array.isArray(data.transfers) ? data.transfers : [];
    document.getElementById('preview-details').innerHTML = `<div class="receipt">
        <div class="receipt__cap"><span>Withdrawal</span><span>${transfers.length} source${transfers.length === 1 ? '' : 's'} → ${escapeHtml(chain.name)}</span></div>
        ${renderTransferBreakdown(data)}
        ${renderTotals(data)}
        <div class="receipt__to">
            <div><span>Paid in</span><b>${escapeHtml(chain.name)} · ${escapeHtml(chain.symbol)}</b></div>
            <div><span>To</span><b class="mono">${escapeHtml(data.recipientAddress || '')}</b></div>
        </div>
    </div>`;
    setSendButton(data.netAmountUsd, false);
}

/**
 * Sent: the payout the server created, and the transfers on their way. Drawn
 * from the response and the plan that was just confirmed.
 */
function displayFinalSummary(payout) {
    const plan = previewData || {};
    const transfers = Array.isArray(plan.transfers) ? plan.transfers : [];
    const to = payout.recipientAddress || plan.recipientAddress || '';
    const shortTo = to ? `${to.slice(0, 6)}…${to.slice(-4)}` : '';
    const dest = PAYOUT_CHAINS[payout.payoutChain || plan.payoutChain] || { name: payout.payoutChain || plan.payoutChain };

    document.getElementById('final-summary').innerHTML =
        `Payout <b>#${escapeHtml(String(payout.id || '').slice(0, 8))}</b> · ${transfers.length} transfer${transfers.length === 1 ? '' : 's'} on the way to <b>${escapeHtml(shortTo)}</b>`;

    document.getElementById('wdSentReceipt').innerHTML = `<div class="receipt">
        <div class="receipt__cap"><span>Transfers</span><span>Watching the chain</span></div>
        ${transfers.map((t) => {
            const from = PAYOUT_CHAINS[t.chain] || { name: t.chain };
            const route = t.type === 'DIRECT_TRANSFER' ? `→ ${escapeHtml(dest.name)}` : `→ swap → ${escapeHtml(dest.name)}`;
            const state = t.type === 'DIRECT_TRANSFER' ? 'Sending' : 'Swapping';
            return `<div class="receipt__src"><div class="h"><span>${escapeHtml(from.name)} · ${escapeHtml(walletLabelFor(t.fromAddress))} ${route}</span><span class="status-pill status-pill--verifying">${state}</span></div></div>`;
        }).join('')}
        <div class="receipt__tot"><div class="net"><span>Arriving</span><span>${usd(payout.netAmountUsd ?? plan.netAmountUsd)}</span></div></div>
    </div>`;
}

async function processWithdrawal() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const selectedWallets = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    const net = previewData ? previewData.netAmountUsd : 0;
    setSendButton(net, true);
    document.getElementById('step3-message').innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Sending…</div>';

    try {
        const response = await apiFetch(`${API_URL}/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Idempotency-Key': crypto.randomUUID()
            },
            body: JSON.stringify({
                recipientAddress,
                payoutChain: selectedPayoutChain(),
                selectedWallets
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Failed');

        document.getElementById('step3-message').innerHTML = '';
        showToast('Withdrawal sent', 'success');
        displayFinalSummary(result);
        goToStep(4);
        // The swept wallets are now busy; the head's figure says so.
        loadWithdrawalPage(true);
    } catch (error) {
        document.getElementById('step3-message').innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
        setSendButton(net, false);
    }
}

function clearStep1() { document.getElementById('recipientAddress').value = ''; }

function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('clientId');
    localStorage.removeItem('username');
    window.location.href = '/auth';
}

// Dashboard mobile nav toggle
(function () {
    var toggle = document.getElementById('dashNavToggle');
    var navLinks = document.getElementById('dashNavLinks');
    if (!toggle || !navLinks) return;
    // The toggle carries .open with the menu: its bars fold into a chevron.
    function setOpen(isOpen) {
        navLinks.classList.toggle('open', isOpen);
        toggle.classList.toggle('open', isOpen);
        toggle.setAttribute('aria-expanded', String(isOpen));
    }
    toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!navLinks.classList.contains('open'));
    });
    navLinks.addEventListener('click', function (e) {
        // closest, not classList: the links carry a glyph and a label, and a
        // tap lands on those, not on the link element itself.
        if (e.target.closest('.nav-link')) setOpen(false);
    });
    document.addEventListener('click', function (e) {
        if (!navLinks.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
}());

/**
 * Show the icon matching the current theme preference on the dashboard header
 * button. The navbar does this for every other page; the dashboard builds its
 * own header, so it needs its own hook.
 */
function syncThemeButton() {
    const button = document.getElementById('themeToggle');
    if (!button || !window.Theme) return;

    const preference = window.Theme.get();
    button.setAttribute('data-theme-state', preference);

    const next = { light: 'dark', dark: 'system', system: 'light' }[preference];
    const label = `Theme: ${preference}. Switch to ${next}.`;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
}

window.addEventListener('load', syncThemeButton);
window.addEventListener('themechange', syncThemeButton);
