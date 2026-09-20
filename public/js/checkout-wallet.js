/**
 * Pay from a browser wallet (MetaMask, Rabby, Coinbase Wallet, Brave, ...).
 *
 * Any extension exposing EIP-1193 `window.ethereum` works, on any EVM chain
 * the session is on. The flow:
 *
 *   1. Connect - eth_requestAccounts. The first account becomes the paying
 *      address; it is submitted to the session exactly as a typed address
 *      would be, so settlement matches on it the same way.
 *   2. Switch - wallet_switchEthereumChain to the session's chain id, adding
 *      the chain to the wallet first if it does not know it.
 *   3. Pay - eth_sendTransaction with the exact amount to the merchant
 *      address. The wallet shows the user the real recipient and value; we
 *      never see a key.
 *   4. Report - the returned hash goes to /api/checkout/tx-hint, so
 *      settlement can verify the transaction over RPC immediately rather
 *      than waiting for an explorer to index it.
 *
 * Everything the page needs (chain id, RPC URLs for the add-chain prompt,
 * symbol) comes with the session; nothing is hardcoded here.
 */
(() => {
  const sessionId = window.location.pathname.replace(/^\/checkout\//, '').split('/')[0];
  if (!sessionId) return;

  const state = {
    provider: null,
    account: null,
    chainInfo: null,
    session: null,
    sending: false,
  };

  // Detect a wallet. EIP-6963 announces multiple; the first announced is
  // used, falling back to the legacy window.ethereum.
  const providers = [];
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (event.detail && event.detail.provider) providers.push(event.detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function detectProvider() {
    if (providers.length > 0) {
      state.walletName = providers[0].info && providers[0].info.name;
      return providers[0].provider;
    }
    if (window.ethereum) {
      state.walletName = window.ethereum.isMetaMask ? 'MetaMask' : (window.ethereum.isRabby ? 'Rabby' : (window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : 'your wallet'));
      return window.ethereum;
    }
    return null;
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  const el = (id) => document.getElementById(id);
  const show = (id) => { const n = el(id); if (n) n.classList.remove('hidden'); };
  const hide = (id) => { const n = el(id); if (n) n.classList.add('hidden'); };

  // A button's words, leaving its glyph alone (see setLabel in checkout.js).
  const setLabel = (button, text) => {
    if (!button) return;
    const label = button.querySelector('.btn__label');
    if (label) label.textContent = text;
    else button.textContent = text;
  };

  function setNote(id, message, kind) {
    const node = el(id);
    if (!node) return;
    node.textContent = message || '';
    node.className = `wallet-note${kind ? ` wallet-note--${kind}` : ''}`;
    node.classList.toggle('hidden', !message);
  }

  function short(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  }

  // ── Session ───────────────────────────────────────────────────────────────

  async function loadSession() {
    try {
      const res = await fetch(`/api/checkout/session/${sessionId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function hexChainId(chainId) {
    return '0x' + Number(chainId).toString(16);
  }

  function toWeiHex(amount, decimals) {
    // Exact decimal -> integer string, no floating point.
    const [whole, frac = ''] = String(amount).split('.');
    const digits = (whole + frac.padEnd(decimals, '0').slice(0, decimals)).replace(/^0+(?=\d)/, '');
    return '0x' + BigInt(digits || '0').toString(16);
  }

  // ── Wallet actions ────────────────────────────────────────────────────────

  async function connect() {
    const provider = detectProvider();
    if (!provider) {
      setNote('wallet-note-address', 'No browser wallet found. Install MetaMask or a similar extension, or paste your address below.', 'warn');
      return;
    }
    state.provider = provider;

    const button = el('wallet-connect-btn');
    if (button) { button.disabled = true; setLabel(button, 'Connecting…'); }

    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const account = accounts && accounts[0];
      if (!account) throw new Error('No account was shared');
      state.account = account;

      // Submit it as the paying address, exactly like the typed path.
      const res = await fetch('/api/checkout/submit-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, clientWalletAddress: account }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'The session did not accept this address');

      // Hand the page over to the watching step through its own code path,
      // then offer the one-click payment on it.
      if (typeof window.__checkoutAddressSubmitted === 'function') {
        window.__checkoutAddressSubmitted(account, data);
      }
      showPayButton();
    } catch (error) {
      const message = error && error.code === 4001 ? 'Connection request was declined in the wallet.' : (error.message || 'Could not connect the wallet.');
      setNote('wallet-note-address', message, 'warn');
      if (button) { button.disabled = false; setLabel(button, `Connect ${state.walletName || 'wallet'}`); }
    }
  }

  function showPayButton() {
    const info = state.chainInfo;
    const amount = el('pay-amount-display');
    if (amount) amount.textContent = `${state.session.nativeAmount} ${info.symbol}`;
    const from = el('pay-from-display');
    if (from) from.textContent = short(state.account);
    const walletName = el('pay-wallet-name');
    if (walletName) walletName.textContent = state.walletName || 'wallet';
    show('wallet-pay-section');
    setNote('wallet-note-pay', '', null);
  }

  async function ensureChain() {
    const info = state.chainInfo;
    const wanted = hexChainId(info.chainId);
    const current = await state.provider.request({ method: 'eth_chainId' });
    if (String(current).toLowerCase() === wanted) return;

    try {
      await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wanted }] });
    } catch (error) {
      // 4902: the wallet does not know this chain. Offer to add it.
      if (error && (error.code === 4902 || /unrecognized chain|not added/i.test(error.message || ''))) {
        await state.provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: wanted,
            chainName: info.name,
            nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: info.decimals },
            rpcUrls: info.rpcForWallet,
            blockExplorerUrls: [info.explorerTx.replace(/\/tx\/$/, '')],
          }],
        });
        return;
      }
      throw error;
    }
  }

  async function pay() {
    if (state.sending || !state.provider || !state.account) return;
    state.sending = true;
    const button = el('wallet-pay-btn');
    if (button) { button.disabled = true; setLabel(button, 'Confirm in your wallet…'); }
    setNote('wallet-note-pay', '', null);

    try {
      await ensureChain();

      // The merchant address is only revealed once an address is on file -
      // re-read the session so we have it.
      const fresh = await loadSession();
      const to = fresh && fresh.walletAddress;
      if (!to) throw new Error('The receiving address is not available yet. Try again in a moment.');

      const txHash = await state.provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: state.account,
          to,
          value: toWeiHex(state.session.nativeAmount, state.chainInfo.decimals),
        }],
      });

      // Tell the server which transaction to watch.
      const res = await fetch('/api/checkout/tx-hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, txHash }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Not fatal: settlement will still find it through the explorer.
        console.warn('tx-hint not accepted:', data.message || res.status);
      }

      setNote('wallet-note-pay', `Sent. Transaction ${short(txHash)} — watching for confirmations.`, 'ok');
      if (button) setLabel(button, 'Payment sent');
      if (typeof window.__checkoutRefreshStatus === 'function') window.__checkoutRefreshStatus();
    } catch (error) {
      state.sending = false;
      const declined = error && (error.code === 4001 || /user rejected|denied/i.test(error.message || ''));
      setNote('wallet-note-pay', declined ? 'The transaction was declined in the wallet.' : (error.message || 'The wallet could not send the payment.'), 'warn');
      if (button) { button.disabled = false; setLabel(button, `Pay ${state.session.nativeAmount} ${state.chainInfo.symbol} with ${state.walletName || 'wallet'}`); }
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function init() {
    const session = await loadSession();
    if (!session || !session.chainInfo || !session.chainInfo.walletPay) return;
    state.session = session;
    state.chainInfo = session.chainInfo;

    // Chains with no public transaction index can only be paid by a connected
    // wallet; the manual path is hidden for them (see checkout.js).
    const walletPayOnly = !session.chainInfo.manualCheckout;

    // The option is only offered when a wallet is actually present. Most
    // extensions inject before any page script runs, but EIP-6963
    // announcements and a few wallets arrive late - keep looking for a few
    // seconds rather than deciding on the first tick.
    let attempts = 0;
    const look = () => {
      const provider = detectProvider();
      if (!provider) {
        if (++attempts < 12) setTimeout(look, 250);
        return;
      }

      const name = el('wallet-name-display');
      if (name) name.textContent = state.walletName || 'your wallet';
      // The button names the wallet it found.
      setLabel(el('wallet-connect-btn'), `Connect ${state.walletName || 'wallet'}`);

      if (!session.hasClientAddress && session.status === 'PENDING') {
        show('wallet-connect-section');
      }
    };
    setTimeout(look, 150);

    // If this chain needs a wallet and none turns up, say so plainly rather
    // than leaving the customer on a screen with nothing to do.
    if (walletPayOnly && session.status === 'PENDING' && !session.hasClientAddress) {
      setTimeout(() => {
        if (detectProvider()) return;
        const note = el('wallet-required-note');
        if (note) {
          note.textContent = `Paying on ${session.chainInfo.name} needs a browser wallet such as MetaMask. Install one and reload, or ask the merchant for a payment link on another chain.`;
          note.classList.remove('hidden');
        }
      }, 3200);
    }

    // Already on the watching step with a wallet account? Offer the button
    // once the wallet is connected again after a reload.
    window.__checkoutOfferWalletPay = async () => {
      const provider = detectProvider();
      if (!provider) return;
      state.provider = provider;
      try {
        const accounts = await provider.request({ method: 'eth_accounts' });
        const account = accounts && accounts[0];
        const fresh = await loadSession();
        if (account && fresh && fresh.status === 'AWAITING_PAYMENT') {
          state.account = account;
          state.session = fresh;
          showPayButton();
        }
      } catch { /* wallet locked; the QR path still works */ }
    };
  }

  window.checkoutWalletConnect = connect;
  window.checkoutWalletPay = pay;

  init();
})();
