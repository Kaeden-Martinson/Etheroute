(() => {
  // Extract sessionId from URL: /checkout/<sessionId>
  const sessionId = window.location.pathname.replace(/^\/checkout\//, '').split('/')[0];

  let sessionData = null;
  let pollTimer = null;
  let countdownTimer = null;

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function init() {
    if (!sessionId) {
      showError('No checkout session ID found in URL.');
      return;
    }
    await loadSession();
  }

  // ── Session Loader ────────────────────────────────────────────────────────

  async function loadSession() {
    try {
      const res = await fetch(`/api/checkout/session/${sessionId}`);
      const data = await res.json();

      if (!res.ok) {
        showError(data.message || 'Checkout session not found.');
        return;
      }

      sessionData = data;
      renderCheckout();
    } catch {
      showError('Could not reach the server. Please try again.');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function renderCheckout() {
    // Populate the persistent payment summary
    document.getElementById('amount-value').textContent = sessionData.nativeAmount;
    document.getElementById('chain-badge').textContent  = sessionData.chainInfo && sessionData.chainInfo.symbol !== sessionData.chain
      ? `${sessionData.chainInfo.symbol} · ${sessionData.chainInfo.name}`
      : sessionData.chain;
    if (sessionData.usdAmount) {
      document.getElementById('amount-usd').textContent = `$${sessionData.usdAmount.toFixed(2)}`;
    }
    // The chain's mark beside the amount, in one colour, from the shared set.
    const mark = document.getElementById('chain-mark');
    if (mark && typeof window.chainLogo === 'function') mark.innerHTML = window.chainLogo(sessionData.chain, '');

    // Send-to address: only show it if the client already submitted their address
    if (sessionData.hasClientAddress && sessionData.walletAddress) {
      document.getElementById('wallet-address').textContent = sessionData.walletAddress;
      show('send-to-row');
    }

    // The clock only runs while a payment can still arrive. A paid, underpaid
    // or expired session has nothing to count down to - and it used to keep
    // ticking on those and replace the screen with "Session Expired" at zero.
    if (['PENDING', 'AWAITING_PAYMENT', 'VERIFYING'].includes(sessionData.status)) {
      startCountdown(sessionData.expiresAt);
    } else {
      hide('countdown-row');
    }

    // Show the correct step
    show('state-checkout');
    hide('state-loading');
    enterPage();

    // A chain that has no public transaction index (e.g. BNB) cannot verify a
    // hand-sent payment - only a connected wallet, which reports its own hash.
    // So on those chains the "paste an address" path is a dead end; hide it and
    // require connect-wallet.
    const info = sessionData.chainInfo;
    const walletPayOnly = Boolean(info && info.walletPay && !info.manualCheckout);

    switch (sessionData.status) {
      case 'PENDING': {
        showStep('step-address');
        const title = document.querySelector('#step-address .step-title');
        if (walletPayOnly) {
          // No transaction index for this chain: the manual path is a dead end.
          hide('manual-address-section');
          if (title) title.textContent = 'Connect your wallet to pay';
        } else if (info && !info.walletPay) {
          // No browser-wallet path on this chain (BTC/LTC/SOL): manual only.
          if (title) title.textContent = 'Pay manually';
          const inline = document.getElementById('chain-name-inline');
          if (inline) inline.textContent = chainName(sessionData.chain);
        }
        break;
      }
      case 'AWAITING_PAYMENT':
      case 'VERIFYING':
        showStep('step-watching');
        if (sessionData.walletAddress) revealSendToAddress(sessionData.walletAddress);
        renderQr(sessionData.paymentQr);
        populateWatchingStep();
        startPolling();
        // Hydrate from the full status straight away: a reload mid-payment
        // should land on the detected screen with its confirmations, not on
        // the QR code until the next ten-second tick.
        pollStatus({ initial: true });
        // A connected wallet gets its one-click button back after a reload.
        if (sessionData.status === 'AWAITING_PAYMENT' && typeof window.__checkoutOfferWalletPay === 'function') {
          setTimeout(() => window.__checkoutOfferWalletPay(), 300);
        }
        break;
      case 'PAID':
      case 'INSUFFICIENT':
      case 'EXPIRED':
        // The session endpoint says which screen; the status endpoint has the
        // details that belong on it - the amount that arrived, the transaction
        // hash, the redirect. Load those so a reload shows the same page the
        // customer saw when it settled, not a bare heading.
        pollStatus({ initial: true });
        break;
      default:
        showStep('step-address');
    }
  }

  // ── Wallet Address Submission ─────────────────────────────────────────────

  window.submitWalletAddress = async function (e) {
    e.preventDefault();

    const input = document.getElementById('client-address');
    const btn   = document.getElementById('submit-address-btn');
    const addr  = input.value.trim();

    input.classList.remove('error');
    removeFormError();

    if (!addr) {
      showFormError('Please enter your wallet address.');
      return;
    }

    btn.disabled = true;
    setLabel(btn, 'Checking…');

    try {
      const res = await fetch('/api/checkout/submit-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, clientWalletAddress: addr }),
      });

      const data = await res.json();

      if (!res.ok) {
        input.classList.add('error');
        showFormError(data.message || 'Invalid wallet address.');
        btn.disabled = false;
        setLabel(btn, 'Continue');
        return;
      }

      // Transition to watching step
      enterWatching(addr, data);
    } catch {
      showFormError('Network error. Please try again.');
      btn.disabled = false;
      setLabel(btn, 'Continue');
    }
  };

  /**
   * A button's words, leaving its glyph alone. The buttons carry an icon
   * beside a .btn__label span; writing textContent on the button would wipe
   * the icon along with the text.
   */
  function setLabel(button, text) {
    if (!button) return;
    const label = button.querySelector('.btn__label');
    if (label) label.textContent = text;
    else button.textContent = text;
  }
  window.__checkoutSetLabel = setLabel;

  /**
   * The page's entrance once the session is known: what is marked data-reveal
   * rises into place, staggered. tokens.css keeps those hidden until
   * .is-revealed, so a failsafe shows everything if this never runs to the end.
   */
  function enterPage() {
    const nodes = Array.from(document.querySelectorAll('#state-checkout [data-reveal]'));
    if (nodes.length === 0) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const node of nodes) {
      const delay = node.getAttribute('data-reveal-delay');
      node.style.setProperty('--reveal-delay', delay && !reduce ? `${delay}ms` : '0ms');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => nodes.forEach((node) => node.classList.add('is-revealed'))));
    setTimeout(() => nodes.forEach((node) => node.classList.add('is-revealed')), 4000);
  }

  /**
   * The rail under the amount follows the step: what is done wears the dot,
   * what is happening is inked.
   */
  function markRail(stepId) {
    const done = { 'step-address': 0, 'step-watching': 1, 'step-verifying': 2, 'step-paid': 3, 'step-insufficient': 2, 'step-expired': 2 }[stepId] ?? 0;
    const now = { 'step-address': 1, 'step-watching': 2, 'step-verifying': 3, 'step-paid': 0, 'step-insufficient': 3, 'step-expired': 3 }[stepId] ?? 1;
    document.querySelectorAll('#pay-rail li').forEach((item) => {
      const n = Number(item.dataset.rail);
      item.classList.toggle('is-done', n <= done);
      item.classList.toggle('is-now', n === now && n > done);
    });
  }

  /**
   * Move to the watching step after an address is on file - typed, or
   * supplied by a connected wallet.
   */
  function enterWatching(addr, data) {
    showStep('step-watching');
    revealSendToAddress(data.walletAddress);
    renderQr(data.paymentQr);
    populateWatchingStep(addr);
    startPolling();
  }

  // The wallet module drives the same transition and refreshes the status.
  window.__checkoutAddressSubmitted = (addr, data) => enterWatching(addr, data);
  window.__checkoutRefreshStatus = () => pollStatus();

  /**
   * Inject the server-generated QR SVG. The markup comes from our own API and
   * contains no script; if it is missing the address text alone still works.
   */
  function renderQr(svg) {
    const holder = document.getElementById('qr-code');
    const container = document.getElementById('qr-container');
    if (!holder || !container || !svg) return;
    holder.innerHTML = svg;
    container.classList.remove('hidden');
  }

  function revealSendToAddress(address) {
    if (!address) return;
    const el = document.getElementById('wallet-address');
    if (el) el.textContent = address;
    // Also update chain-specific labels now that we're past address entry
    const chain = sessionData?.chain || '';
    const chainInline = document.getElementById('chain-name-inline');
    const chainLabel  = document.getElementById('chain-label');
    if (chainInline) chainInline.textContent = chainName(chain);
    if (chainLabel)  chainLabel.textContent  = chainName(chain);
    const row = document.getElementById('send-to-row');
    if (row) {
      row.classList.remove('hidden');
      row.classList.add('reveal');
    }
  }

  function populateWatchingStep(clientAddr) {
    // On a reload the input is gone, so fall back to the address the session
    // itself remembers (echoed back by the API).
    const addr = clientAddr
      || sessionData?.clientWalletAddress
      || document.getElementById('client-address')?.value?.trim()
      || '—';
    document.getElementById('watch-amount').textContent = sessionData?.nativeAmount ?? '—';
    document.getElementById('watch-chain').textContent  = chainSymbol();
    document.getElementById('from-address-display').textContent = addr;
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  function startPolling() {
    if (pollTimer) return; // already running
    pollTimer = setInterval(pollStatus, 10_000); // check every 10 s
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * Fetch the live status and show it. `initial` marks the hydration on page
   * load: same screens, but no automatic redirect - the customer has come
   * back to look at the result, not just paid.
   */
  async function pollStatus({ initial = false } = {}) {
    try {
      const res = await fetch(`/api/checkout/status/${sessionId}`);
      if (!res.ok) return;

      const data = await res.json();

      switch (data.status) {
        case 'PAID':
          stopPolling();
          stopCountdown();
          handlePaid(data, { autoRedirect: !initial });
          break;
        case 'INSUFFICIENT':
          stopPolling();
          stopCountdown();
          handleInsufficient(data);
          break;
        case 'EXPIRED':
          stopPolling();
          stopCountdown();
          handleExpired(data);
          break;
        case 'VERIFYING':
          // Two very different situations share this status. A transaction
          // has been seen and is gaining confirmations - or the chain is
          // temporarily unreadable and nothing is known yet.
          if (data.pendingTxHash || data.detected) {
            handleDetected(data);
          } else {
            setWatchingNote('Checking the network… this page updates automatically.');
          }
          break;
        case 'AWAITING_PAYMENT':
          // Back from a transient VERIFYING with nothing seen: restore the
          // original hint.
          if (!detected) setWatchingNote(DEFAULT_WATCH_HINT);
          break;
        // PENDING — keep watching
      }
    } catch {
      // Swallow network errors — keep polling
    }
  }

  const DEFAULT_WATCH_HINT = 'This page updates automatically. Do not close it until payment is confirmed.';
  let detected = false;

  function setWatchingNote(message) {
    const hint = document.querySelector('#step-watching .watch-hint');
    if (hint) hint.textContent = message;
  }

  /** Rough wall-clock for the required depth, per chain. */
  function confirmationEta(chain, required) {
    const perBlockSec = { BTC: 600, LTC: 150, ETH: 12, SOL: 1 }[chain] || 60;
    const totalSec = perBlockSec * Math.max(1, required);
    if (totalSec < 60) return 'under a minute';
    const mins = Math.round(totalSec / 60);
    return mins <= 1 ? 'about a minute' : `about ${mins} minutes`;
  }

  let renderedBlocks = { have: -1, required: -1 };

  /**
   * Draw one tile per required confirmation. Only re-rendered when the count
   * changes, so the pulsing "next" tile is not restarted on every poll, and
   * only the newly landed tiles animate in - not the whole row.
   */
  function renderBlockChain(have, required) {
    const holder = document.getElementById('verify-blocks');
    if (!holder) return;
    if (renderedBlocks.have === have && renderedBlocks.required === required) return;

    const previouslyHad = renderedBlocks.required === required ? Math.max(0, renderedBlocks.have) : 0;
    renderedBlocks = { have, required };

    const shown = Math.min(required, 32);
    holder.classList.toggle('block-chain--dense', shown > 8);
    holder.setAttribute('aria-label', `${have} of ${required} confirmations`);

    const tick = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    let html = '';
    for (let i = 0; i < shown; i++) {
      const confirmed = i < have;
      const isNext = !confirmed && i === have;
      // Tiles that were already confirmed last render are "settled": drawn in
      // their final state with no landing animation. New ones land one after
      // another.
      const settled = confirmed && i < previouslyHad;
      const delay = confirmed && !settled ? (i - previouslyHad) * 140 : 0;
      const stateClass = `${confirmed ? ' block--confirmed' : ''}${settled ? ' block--settled' : ''}${isNext ? ' block--next' : ''}`;
      if (i > 0) {
        html += `<span class="block-link${i <= have ? ' block-link--done' : ''}${settled ? ' block--settled' : ''}" style="--land-delay:${delay}ms"></span>`;
      }
      html += `<span class="block${stateClass}" style="--land-delay:${delay}ms">${tick}</span>`;
    }
    holder.innerHTML = html;
  }

  /**
   * The payment is on the chain. Swap the QR code and "watching" copy for a
   * confirmation-progress view, and stop the expiry clock - a session with a
   * transaction in hand cannot expire.
   */
  function handleDetected(data) {
    const chain = sessionData?.chain || '';
    const required = Math.max(1, Number(data.requiredConfirmations) || 1);
    const have = Math.max(0, Math.min(required, Number(data.confirmations) || 0));

    document.getElementById('verify-chain').textContent = chainName(chain);
    document.getElementById('verify-eta').textContent = confirmationEta(chain, required);
    document.getElementById('verify-confirmations').textContent = String(have);
    document.getElementById('verify-required').textContent = String(required);
    document.getElementById('verify-bar').style.width = `${Math.round((have / required) * 100)}%`;
    renderBlockChain(have, required);

    if (data.pendingTxHash) {
      document.getElementById('verify-tx-hash').textContent = data.pendingTxHash;
      show('verify-tx-row');
    }

    if (!detected) {
      detected = true;
      stopCountdown();
      hide('countdown-row');
      showStep('step-verifying');
    }
  }

  // ── Terminal States ───────────────────────────────────────────────────────

  function handlePaid(data, { autoRedirect = true } = {}) {
    document.getElementById('paid-amount').textContent = data.paidAmount ?? sessionData?.nativeAmount ?? '—';
    document.getElementById('paid-chain').textContent  = chainSymbol();

    if (data.paidTxHash) {
      document.getElementById('tx-hash-display').textContent = data.paidTxHash;
      show('tx-hash-row');
    }

    const redirectBtn = document.getElementById('success-redirect-btn');
    if (data.redirectUrl) {
      redirectBtn.href = data.redirectUrl;
      // Named for where it goes, when the address says.
      let host = '';
      try { host = new URL(data.redirectUrl).host.replace(/^www\./, ''); } catch { /* keep the plain label */ }
      setLabel(redirectBtn, host ? `Back to ${host}` : 'Continue');
      // Auto-redirect after 3 s - only on the live transition to paid.
      if (autoRedirect) setTimeout(() => { window.location.href = data.redirectUrl; }, 3000);
    } else {
      redirectBtn.style.display = 'none';
    }

    hide('countdown-row');
    showStep('step-paid');
  }

  function handleInsufficient(data) {
    document.getElementById('received-amount').textContent = data.paidAmount ?? '?';
    document.getElementById('received-chain').textContent  = chainSymbol();
    document.getElementById('required-amount').textContent = sessionData?.nativeAmount ?? '—';

    const btn = document.getElementById('failure-redirect-btn-insuf');
    if (data.redirectUrl) {
      btn.href = data.redirectUrl;
    } else {
      btn.style.display = 'none';
    }

    stopCountdown();
    hide('countdown-row');
    showStep('step-insufficient');
  }

  function handleExpired(data) {
    const btn = document.getElementById('failure-redirect-btn-exp');
    if (data?.redirectUrl) {
      btn.href = data.redirectUrl;
    } else {
      btn.style.display = 'none';
    }

    // Closed by the merchant, or timed out? The two look the same to the
    // page otherwise, and "expired" is misleading when someone closed it.
    const cancelled = data?.cancelledByMerchant || sessionData?.cancelledByMerchant;
    const title = document.querySelector('#step-expired .step-title');
    const desc = document.querySelector('#step-expired .step-description');
    if (title) title.textContent = cancelled ? 'Payment closed' : 'Session expired';
    if (desc) {
      desc.textContent = cancelled
        ? 'The merchant closed this payment. Please contact them if you still need to pay.'
        : 'This checkout session has expired. Please contact the merchant to initiate a new payment.';
    }

    stopCountdown();
    hide('countdown-row');
    showStep('step-expired');
  }

  // ── Countdown ─────────────────────────────────────────────────────────────

  function startCountdown(expiresAt) {
    if (countdownTimer) clearInterval(countdownTimer);
    tick();
    countdownTimer = setInterval(tick, 1000);

    function tick() {
      const ms  = new Date(expiresAt) - Date.now();
      const el  = document.getElementById('countdown');
      if (!el) return;

      if (ms <= 0) {
        // Time is up on the client's clock, but only the server can say the
        // session is expired - it takes a final look at the chain first, and a
        // payment sent in the last seconds still counts. Ask it now and keep
        // polling until it answers with a terminal state.
        el.textContent = '00:00';
        el.classList.add('expiring');
        stopCountdown();
        setWatchingNote('Time is up — checking the network for a last-minute payment…');
        startPolling();
        pollStatus();
        return;
      }

      const totalSec = Math.floor(ms / 1000);
      const mins     = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const secs     = String(totalSec % 60).padStart(2, '0');
      el.textContent = `${mins}:${secs}`;

      if (ms < 5 * 60 * 1000) el.classList.add('expiring');

      // The hairline under the amount drains with the clock: seen as well as
      // read. Its full length is the session's whole life.
      const bar = document.getElementById('countdown-bar');
      const opened = sessionData && sessionData.createdAt ? new Date(sessionData.createdAt).getTime() : NaN;
      const life = new Date(expiresAt).getTime() - opened;
      if (bar && life > 0) bar.style.width = `${Math.max(0, Math.min(100, (ms / life) * 100)).toFixed(2)}%`;
    }
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // ── Copy Address ──────────────────────────────────────────────────────────

  window.copyAddress = function () {
    const addr = document.getElementById('wallet-address')?.textContent;
    if (!addr || addr === '—') return;

    navigator.clipboard.writeText(addr).then(() => {
      const btn = document.querySelector('.copy-btn');
      if (!btn) return;
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = addr;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  };

  // ── Copy Amount ─────────────────────────────────────────────────────────────

  window.copyAmount = function () {
    const value = document.getElementById('amount-value')?.textContent;
    if (!value || value === '—') return;
    const write = navigator.clipboard
      ? navigator.clipboard.writeText(value)
      : Promise.reject();
    write.then(() => showToast('Copied to clipboard')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('Copied to clipboard'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    });
  };

  // The same bottom-right notification used elsewhere in the app.
  function showToast(message) {
    let host = document.querySelector('.toast-container');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-container';
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 350);
    }, 2400);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function showError(message) {
    document.getElementById('error-message').textContent = message;
    show('state-error');
    hide('state-loading');
    hide('state-checkout');
  }

  function showStep(stepId) {
    ['step-address', 'step-watching', 'step-verifying', 'step-paid', 'step-insufficient', 'step-expired']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== stepId);
      });
    markRail(stepId);
  }

  // The clock's hairline track goes wherever the countdown row goes.
  const TWINS = { 'countdown-row': 'countdown-track' };

  function show(id) {
    for (const each of [id, TWINS[id]]) {
      const el = each && document.getElementById(each);
      if (el) el.classList.remove('hidden');
    }
  }

  function hide(id) {
    for (const each of [id, TWINS[id]]) {
      const el = each && document.getElementById(each);
      if (el) el.classList.add('hidden');
    }
  }

  function showFormError(msg) {
    removeFormError();
    const err = document.createElement('p');
    err.className = 'form-error';
    err.id = 'form-error-msg';
    err.textContent = msg;
    document.getElementById('address-form')?.appendChild(err);
  }

  function removeFormError() {
    document.getElementById('form-error-msg')?.remove();
  }

  function chainName(chain) {
    const info = sessionData && sessionData.chainInfo;
    if (info && info.code === chain) return info.name;
    const names = { ETH: 'Ethereum', BTC: 'Bitcoin', LTC: 'Litecoin', SOL: 'Solana' };
    return names[chain] || chain;
  }

  /** Ticker for the session's coin - ETH on Base, not "BASE". */
  function chainSymbol() {
    const info = sessionData && sessionData.chainInfo;
    return (info && info.symbol) || (sessionData && sessionData.chain) || '—';
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  init();
})();
