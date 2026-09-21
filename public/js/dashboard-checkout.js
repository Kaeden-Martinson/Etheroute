/**
 * Checkout page: create payment links and watch them settle.
 *
 * Kept separate from dashboard.js, which is already long. Depends on
 * API_URL, showToast() and copyToClipboard() from the surrounding page.
 */

let checkoutPollTimer = null;

const CHECKOUT_STATUS_LABELS = {
    PENDING: 'Awaiting customer',
    AWAITING_PAYMENT: 'Awaiting payment',
    VERIFYING: 'Confirming',
    PAID: 'Paid',
    INSUFFICIENT: 'Underpaid',
    EXPIRED: 'Expired',
};

const OPEN_STATUSES = ['PENDING', 'AWAITING_PAYMENT', 'VERIFYING'];

// Block explorers, for the transaction link in a row's details. Filled from
// /api/chains by ensureChains(); these four are the fallback until it loads.
const EXPLORERS = {
    BTC: (hash) => `https://mempool.space/tx/${hash}`,
    LTC: (hash) => `https://litecoinspace.org/tx/${hash}`,
    ETH: (hash) => `https://etherscan.io/tx/${hash}`,
    SOL: (hash) => `https://solscan.io/tx/${hash}`,
};
const CHAIN_INFO = {};

async function ensureChains() {
    if (Object.keys(CHAIN_INFO).length > 0) return;
    try {
        const response = await fetch(`${API_URL}/chains`);
        if (!response.ok) return;
        const data = await response.json();
        for (const chain of data.chains || []) {
            CHAIN_INFO[chain.code] = chain;
            EXPLORERS[chain.code] = (hash) => `${chain.explorerTx}${hash}`;
        }
    } catch { /* fall back to the built-in four */ }
}

function symbolFor(code) {
    return (CHAIN_INFO[code] && CHAIN_INFO[code].symbol) || code;
}

// Rows whose details are open. The table re-renders every 15 seconds while
// the page is visible; without this the panel the merchant is reading would
// close under them.
const expandedCheckoutSessions = new Set();

// The filter chips and search, and the last status seen per link so a change
// while the page is open can land with a highlight rather than silently.
let checkoutFilter = '';
let checkoutSearch = '';
const lastSeenStatus = new Map();
let checkoutSessionsCache = [];

function checkoutAuthHeaders(extra) {
    return Object.assign(
        { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
        extra || {}
    );
}

/**
 * Escape text destined for markup. References come from the merchant and
 * addresses from the customer, so nothing here is interpolated raw.
 */
function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatWhen(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

/** Everything the checkout page needs on open. */
async function loadCheckoutPage() {
    await ensureChains();
    await loadCheckoutSessions();
}

/** The New payment link page: the wallet picker, and the form rather than a
 *  link left over from last time. */
async function loadCreateLinkPage() {
    await ensureChains();
    dismissCheckoutResult();
    await loadCheckoutWallets();
    startCheckoutQuote();
}

// ── Live quote ────────────────────────────────────────────────────────────
// The rate the link would be made at right now, from the feed the create
// call reads. Fetched when the wallet changes and every 30 s while the form
// is open; the age under it ticks every second; the figure is redrawn on
// every keystroke. It is marked ≈ because the rate that counts is the one
// read when the link is made, and the ready panel shows that one.
let checkoutQuote = null;   // { chain, symbol, usdRate, ageSeconds, fresh, fetchedAt }
let checkoutQuoteTimer = null;

function checkoutChainSelected() {
    const select = document.getElementById('checkoutWallet');
    const option = select && select.options[select.selectedIndex];
    return option && option.dataset ? option.dataset.chain || '' : '';
}

async function loadCheckoutQuote() {
    const chain = checkoutChainSelected();
    if (!chain) { checkoutQuote = null; drawCheckoutQuote(); return; }
    try {
        const response = await apiFetch(`${API_URL}/checkout/quote?chain=${encodeURIComponent(chain)}`, { headers: checkoutAuthHeaders() });
        const data = await response.json();
        checkoutQuote = response.ok && data.usdRate > 0 ? { ...data, fetchedAt: Date.now() } : null;
    } catch {
        checkoutQuote = null;
    }
    drawCheckoutQuote();
}

function drawCheckoutQuote() {
    const text = document.getElementById('checkoutAmountHint');
    const age = document.getElementById('checkoutQuoteAge');
    if (!text) return;

    const chain = checkoutChainSelected();
    const symbol = chain ? symbolFor(chain) : 'the coin';
    const inUsd = (document.querySelector('input[name="checkoutCurrency"]:checked') || {}).value !== 'native';
    const amount = Number((document.getElementById('checkoutAmount') || {}).value);
    const quote = checkoutQuote && checkoutQuote.chain === chain ? checkoutQuote : null;
    const usd = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (!quote) {
        text.textContent = inUsd
            ? `Quoted in ${symbol} at today's rate when the link is made. The customer pays that figure, not the USD.`
            : `The customer pays exactly this much ${symbol}. The USD equivalent is fixed alongside it when the link is made.`;
        if (age) age.hidden = true;
        return;
    }

    const rate = `${usd(quote.usdRate)} / ${esc(symbol)}`;
    const tokens = chainTokens(chain);
    if (amount > 0) {
        // The server's own rounding, so the figure here is the one the ready panel will show.
        const figure = inUsd
            ? `${esc(String(parseFloat((amount / quote.usdRate).toFixed(8))))} ${esc(symbol)}`
            : usd(parseFloat((amount * quote.usdRate).toFixed(6)));
        // ...and the same money in the chain's dollar tokens, which is the
        // dollar figure itself: a dollar is a dollar.
        const dollars = inUsd ? amount : parseFloat((amount * quote.usdRate).toFixed(6));
        const orTokens = tokens.length > 0
            ? ` \u00b7 or <b>${esc(Number(dollars).toFixed(2))}</b> in ${tokens.map(esc).join(' or ')}`
            : '';
        text.innerHTML = `\u2248 <b>${figure}</b> at ${rate}${orTokens}`;
    } else {
        text.innerHTML = `1 ${esc(symbol)} = <b>${usd(quote.usdRate)}</b> right now. The ${inUsd ? esc(symbol) : 'USD'} figure is fixed when the link is made.`;
    }

    if (age) {
        const seconds = (quote.ageSeconds || 0) + Math.round((Date.now() - quote.fetchedAt) / 1000);
        age.textContent = seconds < 60 ? `price ${seconds} s old` : `price ${Math.round(seconds / 60)} min old`;
        age.classList.toggle('quote__age--stale', !quote.fresh);
        age.hidden = false;
    }
}

function startCheckoutQuote() {
    stopCheckoutQuote();
    let tick = 0;
    checkoutQuoteTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        tick += 1;
        if (tick % 30 === 0) loadCheckoutQuote();
        else drawCheckoutQuote();
    }, 1000);
}

function stopCheckoutQuote() {
    if (checkoutQuoteTimer) {
        clearInterval(checkoutQuoteTimer);
        checkoutQuoteTimer = null;
    }
}

/** Show the chosen wallet's coin on the currency toggle, and say under the
 *  amount what the customer will actually be asked for. */
function syncCheckoutCurrencyLabel() {
    const select = document.getElementById('checkoutWallet');
    const label = document.getElementById('checkoutCurrencyNativeLabel');
    if (!select || !label) return;
    const option = select.options[select.selectedIndex];
    const chain = option && option.dataset ? option.dataset.chain : '';
    const symbol = chain ? symbolFor(chain) : 'the coin';
    label.textContent = chain ? symbol : 'Coin';

    // The line under the amount: a fresh rate for this chain if we have one,
    // prose about the conversion if not yet.
    if (checkoutQuote && checkoutQuote.chain !== chain) checkoutQuote = null;
    drawCheckoutQuote();
    if (chain && !checkoutQuote) loadCheckoutQuote();

    // What the wallet takes. On a chain with dollar tokens the customer
    // picks between the coin and the tokens on the payment page; the merchant
    // has nothing to choose here, only to know. (Every chain in the registry
    // takes a manual payment today; the wording for one that could not stays.)
    const hint = document.getElementById('checkoutWalletHint');
    const info = CHAIN_INFO[chain];
    if (hint) {
        const tokens = chainTokens(chain);
        if (info && !info.manualCheckout) {
            hint.textContent = `${info.name} has no free transaction index: payments are verified only when the customer pays from a connected wallet on the checkout page.`;
        } else if (tokens.length > 0) {
            hint.innerHTML = `The customer pays into this wallet, in <b>${esc(symbol)}, ${tokens.map(esc).join(' or ')}</b> \u2014 their choice on the payment page. It settles here.`;
        } else {
            hint.textContent = "The customer pays in this wallet's coin and it settles here.";
        }
    }
}

/** The dollar tokens a chain's wallets take, by symbol; none outside the EVM chains. */
function chainTokens(chain) {
    const info = CHAIN_INFO[chain];
    return info && Array.isArray(info.tokens) ? info.tokens.map((t) => t.symbol) : [];
}

/**
 * Populate the wallet picker from the server. A link can only settle into a
 * wallet the merchant actually owns.
 */
async function loadCheckoutWallets() {
    const select = document.getElementById('checkoutWallet');
    const hint = document.getElementById('checkoutWalletHint');
    if (!select) return;

    try {
        const response = await apiFetch(`${API_URL}/wallets/list`, { headers: checkoutAuthHeaders() });
        const wallets = await response.json();

        if (!response.ok || !Array.isArray(wallets) || wallets.length === 0) {
            select.innerHTML = '<option value="">No wallets yet</option>';
            select.disabled = true;
            if (hint) hint.textContent = 'Create a wallet first — payments need somewhere to land.';
            return;
        }

        select.disabled = false;
        select.innerHTML = wallets.map((wallet) => {
            const short = `${wallet.address.slice(0, 10)}…${wallet.address.slice(-6)}`;
            const info = CHAIN_INFO[wallet.chain];
            const name = info ? (info.symbol === info.code ? info.symbol : `${info.symbol} on ${info.name}`) : wallet.chain;
            const text = wallet.label ? `${wallet.label} — ${name} ${short}` : `${name} — ${short}`;
            return `<option value="${esc(wallet.id)}" data-chain="${esc(wallet.chain)}">${esc(text)}</option>`;
        }).join('');

        syncCheckoutCurrencyLabel();
    } catch (error) {
        select.innerHTML = '<option value="">Could not load wallets</option>';
        syncCheckoutCurrencyLabel();
        select.disabled = true;
    }
}

/** Fetch and render the merchant's payment links. */
async function loadCheckoutSessions() {
    const body = document.getElementById('checkoutSessionsBody');
    const summary = document.getElementById('checkoutSummary');
    if (!body) return;

    // "open" is three server statuses; the chips fold them into one.
    const status = checkoutFilter === 'open' ? '' : checkoutFilter;
    const query = status ? `?status=${encodeURIComponent(status)}` : '';

    try {
        const response = await apiFetch(`${API_URL}/checkout/sessions${query}`, {
            headers: checkoutAuthHeaders(),
        });
        const data = await response.json();

        if (!response.ok) {
            body.innerHTML = `<tr class="dash-table__empty"><td colspan="5">${esc(data.message || 'Could not load payment links.')} <button type="button" data-on-click="loadCheckoutSessions">Retry</button></td></tr>`;
            return;
        }

        if (summary) {
            const totals = data.totals || {};
            const paid = totals.PAID || 0;
            const open = OPEN_STATUSES.reduce((sum, key) => sum + (totals[key] || 0), 0);
            summary.textContent = data.total === 0
                ? 'Links your customers open to pay you. None yet.'
                : `${data.total} link${data.total === 1 ? '' : 's'} \u00b7 ${open} open \u00b7 ${paid} paid \u00b7 $${Number(data.paidUsd || 0).toFixed(2)} collected`;
        }

        checkoutSessionsCache = Array.isArray(data.sessions) ? data.sessions : [];
        renderCheckoutSessions();
    } catch (error) {
        body.innerHTML = '<tr class="dash-table__empty"><td colspan="5">Could not reach the server. <button type="button" data-on-click="loadCheckoutSessions">Retry</button></td></tr>';
    }
}

/** Apply the chip and the search to the cached list and draw it. */
function renderCheckoutSessions() {
    const body = document.getElementById('checkoutSessionsBody');
    const count = document.getElementById('checkoutCount');
    if (!body) return;

    const needle = checkoutSearch.trim().toLowerCase();
    const shown = checkoutSessionsCache
        .filter((sn) => checkoutFilter !== 'open' || OPEN_STATUSES.includes(sn.status))
        .filter((sn) => !needle || [sn.reference, sn.chain, sn.chainName, sn.chainSymbol, sn.paidAsset, sn.nativeAmount, sn.usdAmount, sn.status, sn.sessionId]
            .filter(Boolean).join(' ').toLowerCase().includes(needle))
        .slice()
        .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));

    if (count) count.textContent = shown.length === 1 ? '1 link' : `${shown.length} links`;

    if (shown.length === 0) {
        body.innerHTML = `<tr class="dash-table__empty"><td colspan="5">${
            checkoutSessionsCache.length === 0
                ? 'No payment links yet. Make one and it appears here.'
                : 'No link matches that filter.'
        }</td></tr>`;
        return;
    }

    body.innerHTML = shown.map(renderCheckoutRow).join('');

    // Remember what each link looked like, so the next render can see change.
    for (const sn of checkoutSessionsCache) lastSeenStatus.set(sn.sessionId, sn.status);
    loadSVGIcons();
}

/**
 * Order the links by the merchant's chosen sort: newest/oldest by creation
 * time, or grouped by chain name (newest first within each chain).
 */

function renderCheckoutRow(session) {
    // A merchant-cancelled link is stored as EXPIRED with a flag; to the merchant
    // it wasn't an expiry, they closed it, so it reads "Closed" here.
    const closedByMerchant = session.status === 'EXPIRED' && session.cancelledByMerchant;
    const label = closedByMerchant ? 'Closed' : (CHECKOUT_STATUS_LABELS[session.status] || session.status);
    const pillStatus = closedByMerchant ? 'closed' : session.status.toLowerCase();
    const url = `${window.location.origin}/checkout/${session.sessionId}`;
    const isOpen = OPEN_STATUSES.includes(session.status);
    const expanded = expandedCheckoutSessions.has(session.sessionId);
    const symbol = session.chainSymbol || symbolFor(session.chain);
    const changed = lastSeenStatus.has(session.sessionId) && lastSeenStatus.get(session.sessionId) !== session.status;

    // The one line under the pill that says where the link actually is.
    let sub = '';
    if (session.status === 'VERIFYING' && session.confirmations != null) {
        const need = Number(session.requiredConfirmations) || 1;
        const got = Number(session.confirmations) || 0;
        sub = `<span class="confs">${Array.from({ length: Math.min(need, 6) }, (_, i) => `<i class="${i < got ? 'on' : ''}"></i>`).join('')}</span>${esc(got)} of ${esc(need)} confirmations`;
    } else if (session.status === 'PAID' && session.paidAmount != null) {
        sub = `received ${esc(session.paidAmount)} ${esc(symbol)}`;
    } else if (session.status === 'INSUFFICIENT' && session.paidAmount != null) {
        sub = `only ${esc(session.paidAmount)} ${esc(symbol)} arrived`;
    } else if (session.status === 'PENDING') {
        sub = 'not opened yet';
    } else if (session.status === 'AWAITING_PAYMENT') {
        sub = 'customer is on the page';
    }

    const when = txWhen(session.createdAt);
    const detailId = `checkout-detail-${session.sessionId}`;

    return `
        <tr class="row${changed ? ' changed' : ''}" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${esc(detailId)}" data-session="${esc(session.sessionId)}">
            <td class="ref"><b>${esc(session.reference || '\u2014')}</b><span>${esc(session.chainName || session.chain)}</span></td>
            <td class="amt num"><b>${session.usdAmount != null ? '$' + Number(session.usdAmount).toFixed(2) : '\u2014'}</b><span>${paidIn(session, symbol)}</span></td>
            <td class="st"><span class="status-pill status-pill--${esc(pillStatus)}">${esc(label)}</span>${sub ? `<span class="st__sub">${sub}</span>` : ''}</td>
            <td class="when"><b>${esc(when.day)}</b><span>${esc(when.time)}${isOpen ? ` \u00b7 expires ${esc(formatWhen(session.expiresAt))}` : ''}</span></td>
            <td><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></td>
        </tr>
        <tr class="detail${expanded ? ' open' : ''}" id="${esc(detailId)}"${expanded ? '' : ' hidden'}>
            <td colspan="5"><div class="detail__wrap"><div class="detail__in">${renderCheckoutDetails(session, url)}</div></div></td>
        </tr>
    `;
}

/**
 * Everything known about one link: what was asked for, what arrived, the
 * transaction it arrived in, who sent it, and when each step happened.
 */
/** The list row's small print: the coin figure, or what was actually paid when it was a token. */
function paidIn(session, symbol) {
    const asset = session.paidAsset || session.pendingAsset;
    if (asset && asset !== symbol && session.paidAmount != null) return `${esc(Number(session.paidAmount).toFixed(2))} ${esc(asset)}`;
    if (asset && asset !== symbol) return `in ${esc(asset)}`;
    const ways = session.amounts ? Object.keys(session.amounts).filter((a) => a !== symbol) : [];
    return `${esc(session.nativeAmount)} ${esc(symbol)}${ways.length ? ` <span class="muted">or ${ways.map(esc).join('/')}</span>` : ''}`;
}

/** The Requested fact: every way the link can be paid, when there is more than one. */
function requestedText(session, symbol, muted) {
    const amounts = session.amounts && typeof session.amounts === 'object' ? session.amounts : null;
    const tokens = amounts ? Object.keys(amounts).filter((a) => a !== symbol) : [];
    const coin = `${esc(session.nativeAmount)} ${esc(symbol)}`;
    if (tokens.length === 0 || session.usdAmount == null) {
        return `${coin}${session.usdAmount != null ? ` ${muted('\u00b7 $' + Number(session.usdAmount).toFixed(2))}` : ''}`;
    }
    return `$${esc(Number(session.usdAmount).toFixed(2))} ${muted(`\u00b7 ${coin}, ${tokens.map((t) => `${esc(Number(amounts[t]).toFixed(2))} ${esc(t)}`).join(' or ')}`)}`;
}

function renderCheckoutDetails(session, url) {
    const chain = session.chain;
    const symbol = session.chainSymbol || symbolFor(chain);
    const txHash = session.paidTxHash || session.pendingTxHash;
    const explorer = txHash && EXPLORERS[chain] ? EXPLORERS[chain](txHash) : null;
    // What arrived is measured against its own figure: the coin's, or a
    // dollar token's, which is the dollars.
    const paidAsset = session.paidAsset || session.pendingAsset || null;
    const paidSymbol = paidAsset && paidAsset !== symbol ? paidAsset : symbol;
    const received = session.paidAmount != null ? Number(session.paidAmount) : null;
    const requested = paidAsset && session.amounts && session.amounts[paidAsset] != null ? Number(session.amounts[paidAsset]) : Number(session.nativeAmount);
    const shortfall = received != null && received < requested ? requested - received : 0;
    const required = Number(session.requiredConfirmations) || 1;
    const confirmations = Number(session.confirmations) || 0;
    const isOpen = OPEN_STATUSES.includes(session.status);
    const host = (u) => { try { return new URL(u).host + new URL(u).pathname.replace(/\/$/, ''); } catch { return u; } };

    const fact = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
    const muted = (text) => `<span class="muted">${text}</span>`;

    const facts = [
        fact('Requested', requestedText(session, symbol, muted)),
        fact('Received', received == null ? muted('Nothing yet') : `${esc(received)} ${esc(paidSymbol)}${shortfall > 0 ? ` <span class="shortfall">short by ${esc(Number(shortfall.toFixed(8)))} ${esc(paidSymbol)}</span>` : ' \u00b7 exact'}`),
        fact('Transaction', txHash ? (explorer ? `<a href="${esc(explorer)}" target="_blank" rel="noopener noreferrer">${esc(txHash.slice(0, 10))}\u2026${esc(txHash.slice(-6))}</a>` : `<span class="mono">${esc(txHash)}</span>`) + (session.pendingTxHash && !session.paidTxHash ? ` ${muted('unconfirmed')}` : '') : muted('None seen')),
        fact('Customer sends from', session.clientWalletAddress ? `<span class="mono">${esc(session.clientWalletAddress)}</span>` : muted('Not given yet')),
        fact('Receiving wallet', `<span class="mono">${esc(session.walletAddress)}</span>`),
        fact('On success', esc(host(session.successRoute))),
        fact('On failure', esc(host(session.failureRoute))),
        fact('Webhook', session.webhookUrl ? esc(host(session.webhookUrl)) : muted('None')),
    ].join('');

    // The timeline: every stamp on it is already recorded by the server.
    const t = (when) => when ? esc(formatWhen(when)) : '';
    const steps = [
        { done: true, label: 'Link created', when: t(session.createdAt) },
        { done: session.status !== 'PENDING', label: 'Customer opened it', when: '' },
        { done: Boolean(session.clientWalletAddress), label: 'Sending address given', when: '' },
        { done: Boolean(txHash), label: 'Payment seen on chain', when: '' },
        { done: session.status === 'PAID', now: session.status === 'VERIFYING', label: session.status === 'VERIFYING' ? `Confirming \u00b7 ${confirmations} of ${required}` : `Confirmed \u00b7 ${required} of ${required}`, when: session.status === 'VERIFYING' ? 'now' : '' },
        { done: session.status === 'PAID', label: session.status === 'PAID' ? 'Paid' : 'Paid \u00b7 webhook sent', when: t(session.paidAt) },
    ];
    let timeline;
    if (session.status === 'INSUFFICIENT') {
        timeline = steps.slice(0, 4).concat([{ done: true, stop: true, label: `Underpaid \u00b7 short by ${esc(Number(shortfall.toFixed(8)))} ${esc(symbol)}`, when: t(session.paidAt) }]);
    } else if (session.status === 'EXPIRED') {
        timeline = steps.slice(0, session.clientWalletAddress ? 3 : (session.status === 'PENDING' ? 1 : 2)).concat([{ done: true, stop: true, label: session.cancelledByMerchant ? 'Closed by you' : 'Expired unpaid', when: t(session.expiresAt) }]);
    } else {
        timeline = steps;
    }
    const rail = timeline.map((st) => `<div><i class="${st.now ? 'now' : st.stop ? 'stop' : st.done ? 'on' : ''}"></i><span class="${st.done || st.now ? '' : 'todo'}">${st.label}</span><span>${st.when}</span></div>`).join('');

    return `
        <div class="ck-detail">
            <div>
                <div class="ck-link">
                    <input type="text" readonly value="${esc(url)}" aria-label="Checkout link">
                    <button type="button" class="btn-small btn-ghost" data-on-click="copyToClipboard" data-arg="${esc(url)}">Copy</button>
                    <a class="btn-small btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
                </div>
                <div class="ck-facts">${facts}</div>
            </div>
            <div class="ck-timeline"><div class="ck-timeline__t">Timeline</div>${rail}</div>
            ${isOpen ? `<div class="ck-detail__foot"><button type="button" class="btn-small btn-ghost btn-ghost--danger" data-on-click="cancelCheckoutSession" data-arg="${esc(session.sessionId)}">Close this link</button></div>` : ''}
        </div>`;
}

/** Open or close a row's details. */
function toggleCheckoutDetails(sessionId) {
    const row = document.querySelector(`tr.row[data-session="${CSS.escape(sessionId)}"]`);
    const detail = document.getElementById(`checkout-detail-${sessionId}`);
    if (!row || !detail) return;

    const open = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', String(!open));
    if (open) {
        expandedCheckoutSessions.delete(sessionId);
        detail.classList.remove('open');
        setTimeout(() => { if (!detail.classList.contains('open')) detail.hidden = true; }, 260);
    } else {
        expandedCheckoutSessions.add(sessionId);
        detail.hidden = false;
        requestAnimationFrame(() => detail.classList.add('open'));
    }
}

// Rows open on click or Enter/Space; delegated once so a poll re-render never
// has to re-bind. Chips and search filter the cached list without a fetch.
(function wireCheckoutList() {
    const table = document.getElementById('checkoutSessionsTable');
    const chips = document.getElementById('checkoutChips');
    const search = document.getElementById('checkoutSearch');
    if (table) {
        table.addEventListener('click', (event) => {
            if (event.target.closest('a, button, input')) return;
            const row = event.target.closest('tr.row');
            if (row) toggleCheckoutDetails(row.dataset.session);
        });
        table.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const row = event.target.closest('tr.row');
            if (!row || event.target !== row) return;
            event.preventDefault();
            toggleCheckoutDetails(row.dataset.session);
        });
    }
    if (chips) chips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        checkoutFilter = button.dataset.filter;
        chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        // A server status needs a fetch; "open" and "all" are already cached.
        if (checkoutFilter && checkoutFilter !== 'open') loadCheckoutSessions();
        else if (checkoutSessionsCache.length && checkoutFilter === 'open') renderCheckoutSessions();
        else loadCheckoutSessions();
    });
    if (search) search.addEventListener('input', () => { checkoutSearch = search.value; renderCheckoutSessions(); });
})();

/** Create a payment link from the form. */
async function createCheckoutSession(event) {
    event.preventDefault();

    const button = document.getElementById('checkoutCreateBtn');
    const message = document.getElementById('checkoutCreateMessage');
    const walletId = document.getElementById('checkoutWallet').value;
    const amount = document.getElementById('checkoutAmount').value;
    const currency = (document.querySelector('input[name="checkoutCurrency"]:checked') || {}).value || 'usd';

    message.innerHTML = '';

    if (!walletId) {
        message.innerHTML = '<div class="alert alert-error">Choose a wallet to receive the payment.</div>';
        return;
    }

    const payload = {
        walletId,
        successRoute: document.getElementById('checkoutSuccess').value.trim(),
        failureRoute: document.getElementById('checkoutFailure').value.trim(),
    };

    // The API takes exactly one of these, never both.
    if (currency === 'usd') {
        payload.usdAmount = Number(amount);
    } else {
        payload.nativeAmount = Number(amount);
    }

    const reference = document.getElementById('checkoutReference').value.trim();
    if (reference) payload.reference = reference;

    const webhook = document.getElementById('checkoutWebhook').value.trim();
    if (webhook) payload.webhookUrl = webhook;

    button.disabled = true;
    button.textContent = 'Creating…';

    try {
        const response = await apiFetch(`${API_URL}/checkout/create`, {
            method: 'POST',
            headers: checkoutAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
            message.innerHTML = `<div class="alert alert-error">${esc(data.message || 'Could not create the payment link.')}</div>`;
            return;
        }

        // The response carries what the server computed - id, URL, the coin
        // amount, expiry. What the merchant typed (routes, reference, webhook)
        // only exists in the payload, so the panel is drawn from both.
        showCheckoutResult({ ...payload, ...data, chainName: CHAIN_INFO[data.chain]?.name || data.chain });
        document.getElementById('checkoutCreateForm').reset();
        syncCheckoutCurrencyLabel();
    } catch (error) {
        message.innerHTML = '<div class="alert alert-error">Could not reach the server. Try again.</div>';
    } finally {
        button.disabled = false;
        button.textContent = 'Create payment link';
    }
}

/**
 * Show the new link. Rendered outside the form so resetting the form does not
 * wipe the link the merchant still has to copy.
 */
/**
 * The Amount and Rate rows of the ready panel. A link on a chain with dollar
 * tokens can be paid three ways, all worth the same: it leads with the
 * dollars and lists the ways; the rate row says the tokens are at par and
 * a Tokens row shows the contracts the page will name. Elsewhere, the coin
 * figure with its dollars, as before.
 */
function amountRows(data, symbol, rate, usd) {
    const amounts = data.amounts && typeof data.amounts === 'object' ? data.amounts : null;
    const tokens = amounts ? Object.keys(amounts).filter((asset) => asset !== symbol) : [];
    const info = CHAIN_INFO[data.chain];
    if (tokens.length === 0 || data.usdAmount == null) {
        return `<div><span>Amount</span><b>${esc(data.nativeAmount)} ${esc(symbol)}${data.usdAmount != null ? ` <span class="muted">\u00b7 ${usd(data.usdAmount)}</span>` : ''}</b></div>
                ${rate ? `<div><span>Rate</span><b>${usd(rate)} / ${esc(symbol)} <span class="muted">\u00b7 fixed at creation</span></b></div>` : ''}`;
    }
    const ways = [`${esc(data.nativeAmount)} ${esc(symbol)}`, ...tokens.map((t) => `${esc(Number(amounts[t]).toFixed(2))} ${esc(t)}`)];
    const list = ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}` : ways[0];
    const contracts = info && Array.isArray(info.tokens)
        ? info.tokens.filter((t) => tokens.includes(t.symbol)).map((t) => `${esc(t.symbol)} <span class="mono">${esc(t.contract.slice(0, 6))}\u2026${esc(t.contract.slice(-4))}</span>`).join(' <span class="muted">\u00b7</span> ')
        : '';
    return `<div><span>Amount</span><b>${usd(data.usdAmount)} <span class="muted">\u00b7 ${list} \u2014 the customer picks</span></b></div>
                ${rate ? `<div><span>Rate</span><b>${usd(rate)} / ${esc(symbol)} <span class="muted">\u00b7 fixed at creation \u00b7 stablecoins at par</span></b></div>` : ''}
                ${contracts ? `<div><span>Tokens</span><b>${contracts}</b></div>` : ''}`;
}

function showCheckoutResult(data) {
    const panel = document.getElementById('checkoutResult');
    const form = document.getElementById('checkoutCreateForm');
    if (!panel) return;

    const url = data.checkoutUrl || `${window.location.origin}/checkout/${data.sessionId}`;
    const symbol = data.chainSymbol || symbolFor(data.chain);
    const host = (u) => { try { return new URL(u).host + new URL(u).pathname.replace(/\/$/, ''); } catch { return u; } };
    const usd = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // The rate the coin amount was fixed at, as the server reports it; an
    // older response without it falls back to the ratio of its two amounts.
    const rate = data.usdRate > 0 ? Number(data.usdRate)
        : (data.usdAmount > 0 && data.nativeAmount > 0 ? Number(data.usdAmount) / Number(data.nativeAmount) : null);

    // The wallet as the picker named it - label and short address - falling
    // back to the address the server confirmed.
    const option = data.walletId ? document.querySelector(`#checkoutWallet option[value="${CSS.escape(String(data.walletId))}"]`) : null;
    const walletText = option ? option.textContent : (data.walletAddress ? `${data.walletAddress.slice(0, 10)}\u2026${data.walletAddress.slice(-6)}` : (data.chainName || data.chain));

    panel.innerHTML = `
        <div class="link-ready__head">
            <span class="link-ready__check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></span>
            <div>
                <div class="link-ready__title">Link ready</div>
                <div class="link-ready__sub">Expires in <b id="linkReadyCountdown">60:00</b>${data.reference ? ` \u00b7 ref <b>${esc(data.reference)}</b>` : ''}</div>
            </div>
        </div>
        <div class="link-ready__url">
            <input type="text" readonly value="${esc(url)}" id="linkReadyUrl" aria-label="Checkout link">
            <button type="button" class="btn-small btn-primary" data-on-click="copyToClipboard" data-arg="${esc(url)}">Copy</button>
        </div>
        <div class="link-ready__body">
            <div class="link-ready__qr" id="linkReadyQr" aria-label="QR code of the link"></div>
            <div class="link-ready__facts">
                ${amountRows(data, symbol, rate, usd)}
                <div><span>Pays into</span><b>${esc(walletText)}</b></div>
                <div><span>On payment</span><b>Redirect to ${esc(host(data.successRoute || ''))}</b></div>
                <div><span>Webhook</span><b>${data.webhookUrl ? esc(host(data.webhookUrl)) : '<span class="muted">none</span>'}</b></div>
            </div>
        </div>
        <div class="link-ready__foot">
            <a class="btn-small btn-primary" href="${esc(url)}" target="_blank" rel="noopener">Open link</a>
            <button type="button" class="btn-small btn-ghost" data-on-click="dismissCheckoutResult">Make another</button>
            <button type="button" class="btn-small btn-ghost" data-on-click="switchDashboardPage" data-arg="checkout">All links</button>
        </div>
    `;
    panel.classList.remove('hidden');
    if (form) form.classList.add('hidden');
    startLinkCountdown(data.expiresAt);
    loadLinkQr(data.sessionId);
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** The link as a QR a customer can scan; drawn by the server, like the
 *  customer page's. If it fails the URL field is still there. */
async function loadLinkQr(sessionId) {
    const holder = document.getElementById('linkReadyQr');
    if (!holder) return;
    try {
        const response = await apiFetch(`${API_URL}/checkout/sessions/${encodeURIComponent(sessionId)}/qr`, { headers: checkoutAuthHeaders() });
        const data = await response.json();
        if (response.ok && data.svg) holder.innerHTML = data.svg;
        else holder.remove();
    } catch {
        holder.remove();
    }
}

let linkCountdownTimer = null;
function startLinkCountdown(expiresAt) {
    clearInterval(linkCountdownTimer);
    const end = new Date(expiresAt).getTime();
    const tick = () => {
        const el = document.getElementById('linkReadyCountdown');
        if (!el) { clearInterval(linkCountdownTimer); return; }
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
        if (left === 0) { el.textContent = 'expired'; clearInterval(linkCountdownTimer); }
    };
    tick();
    linkCountdownTimer = setInterval(tick, 1000);
}

function dismissCheckoutResult() {
    const panel = document.getElementById('checkoutResult');
    const form = document.getElementById('checkoutCreateForm');
    clearInterval(linkCountdownTimer);
    if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
    if (form) form.classList.remove('hidden');
}

/** Cancel an unpaid link. */
async function cancelCheckoutSession(sessionId) {
    const ok = await confirmDialog({
        title: 'Close this payment link?',
        message: 'The customer will no longer be able to pay with it, and their checkout page will say you closed it.',
        confirmText: 'Close link',
        cancelText: 'Keep it open',
        danger: true,
    });
    if (!ok) return;

    try {
        const response = await apiFetch(`${API_URL}/checkout/sessions/${encodeURIComponent(sessionId)}/cancel`, {
            method: 'POST',
            headers: checkoutAuthHeaders(),
        });
        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || 'Could not cancel that link', 'error');
            return;
        }

        showToast('Payment link cancelled', 'success');
        await loadCheckoutSessions();
    } catch (error) {
        showToast('Could not reach the server', 'error');
    }
}

/**
 * Refresh while the page is open, so a merchant watching a customer pay sees it
 * land without touching anything. Skipped on a hidden tab to avoid pointless
 * polling in a background window.
 */
function startCheckoutPolling() {
    stopCheckoutPolling();
    checkoutPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') loadCheckoutSessions();
    }, 15000);
}

function stopCheckoutPolling() {
    if (checkoutPollTimer) {
        clearInterval(checkoutPollTimer);
        checkoutPollTimer = null;
    }
}
