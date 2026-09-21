/**
 * The Etheroute API, as data.
 *
 * The reference page renders from this, and a server-side test checks every
 * path here against the Express routes actually mounted - so the docs cannot
 * quietly drift from the code. Code samples are generated from `method`,
 * `path` and `body`, never hand-written.
 *
 * Each endpoint: { id, method, path, auth, summary, description, params,
 * query, body, response, notes, since }. `auth` is 'key' (API key or session
 * token), 'public', or 'developer'.
 */
window.API_SPEC = {
  baseUrl: '/api',
  version: '2026-09',

  sections: [
    {
      id: 'overview',
      title: 'Overview',
      icon: 'overview',
      intro: [
        'Etheroute lets you accept payments in 65 chains, hold the funds in wallets you control through the API, and cash out in whichever chain you like. Everything the dashboard does is available here.',
        'All requests and responses are JSON over HTTPS. The base URL is the host you are talking to plus <code>/api</code>. Timestamps are ISO 8601 in UTC. Amounts in a chain\'s own units are decimals (<code>0.0021</code>); USD amounts are decimals too.',
      ],
      facts: [
        ['Base URL', '<code>https://&lt;your-host&gt;/api</code>'],
        ['Auth', 'Bearer token — an <code>ethr_</code> API key or a session JWT'],
        ['Rate limits', '300 requests / minute per account (default), 5 withdrawals / minute'],
        ['Idempotency', 'Required on <code>POST /withdrawal</code> via the <code>Idempotency-Key</code> header'],
        ['Errors', '<code>{ "error": "…", "message": "…" }</code> with a 4xx/5xx status'],
      ],
    },

    {
      id: 'authentication',
      title: 'Authentication',
      icon: 'lock',
      intro: [
        'Send your credential as a Bearer token on every request to an authenticated endpoint. API keys start with <code>ethr_</code> and are shown once, at generation; only a hash is stored. Session tokens come from <code>/auth/login</code> and expire after 7 days.',
        'Identity is taken only from that header. Nothing in a request body, query string or other header can change who the request is treated as.',
      ],
      endpoints: [
        {
          id: 'auth-register', method: 'POST', path: '/auth/register', auth: 'public',
          summary: 'Create an account',
          description: 'Registers a merchant account and returns a session token. Rate-limited to 10 attempts per 15 minutes per address.',
          body: { username: 'acme-shop', password: 'a-long-passphrase-of-12-or-more' },
          bodyDoc: [
            ['username', 'string', 'Letters, digits, <code>_</code> and <code>-</code>.'],
            ['password', 'string', 'At least 12 characters.'],
          ],
          response: { success: true, token: 'eyJhbGciOi…', clientId: '3446068b-…', username: 'acme-shop', recoveryCodes: ['3f9a-1c00-be72', '…'], message: 'Registration successful' },
          notes: 'The <code>recoveryCodes</code> are returned once and never again. Save them — they are the only way to reset a forgotten password, as there is no email recovery.',
          status: 201,
        },
        {
          id: 'auth-login', method: 'POST', path: '/auth/login', auth: 'public',
          summary: 'Sign in',
          description: 'Exchanges a username and password for a session token.',
          body: { username: 'acme-shop', password: 'a-long-passphrase-of-12-or-more' },
          response: { success: true, token: 'eyJhbGciOi…', clientId: '3446068b-…', username: 'acme-shop', message: 'Login successful' },
        },
        {
          id: 'auth-reset-password', method: 'POST', path: '/auth/reset-password', auth: 'public',
          summary: 'Reset a forgotten password',
          description: 'Sets a new password using one of the account\'s one-time recovery codes. The code is consumed on success.',
          body: { username: 'acme-shop', recoveryCode: '3f9a-1c00-be72', newPassword: 'a-new-long-passphrase' },
          bodyDoc: [
            ['username', 'string', 'The account username.'],
            ['recoveryCode', 'string', 'One unused recovery code (dashes and case are ignored).'],
            ['newPassword', 'string', 'At least 12 characters.'],
          ],
          response: { success: true, recoveryCodesRemaining: 9, message: 'Password reset successful. You can now sign in with your new password.' },
        },
        {
          id: 'auth-recovery-codes', method: 'POST', path: '/auth/recovery-codes', auth: 'key',
          summary: 'Regenerate recovery codes',
          description: 'Replaces the account\'s recovery codes with a fresh set, invalidating the old ones. The new codes are returned once.',
          response: { success: true, recoveryCodes: ['a1b2-c3d4-e5f6', '…'] },
        },
        {
          id: 'auth-change-password', method: 'POST', path: '/auth/change-password', auth: 'key',
          summary: 'Change the password',
          description: 'Takes the current password and the new one, and refuses unless the current one verifies - a session alone is not enough to take the account. The new password must be 12 to 200 characters and different from the current one.',
          body: { currentPassword: '…', newPassword: '…' },
          response: { success: true, message: 'Password changed' },
        },
        {
          id: 'auth-check-username', method: 'GET', path: '/auth/check-username/:username', auth: 'public',
          summary: 'Check whether a username is free',
          response: { available: false, reason: 'Username taken' },
        },
        {
          id: 'auth-verify', method: 'GET', path: '/auth/verify', auth: 'key',
          summary: 'Verify a credential',
          description: 'Confirms the Bearer token is valid and says which kind it is. Useful as a health check for an integration.',
          response: { valid: true, clientId: '3446068b-…', username: 'acme-shop', method: 'apiKey' },
        },
        {
          id: 'api-keys-get', method: 'GET', path: '/api-keys', auth: 'key',
          summary: 'Current API key status',
          description: 'Whether a key exists and its prefix. The key itself is never returned here.',
          response: { success: true, hasKey: true, prefix: 'ethr_r6V3GYd', generatedAt: '2026-09-15T21:10:00.000Z' },
        },
        {
          id: 'api-keys-generate', method: 'POST', path: '/api-keys/generate', auth: 'key',
          summary: 'Generate an API key',
          description: 'Issues a new 46-character key and revokes any existing one. <strong>The plaintext is in this response and nowhere else.</strong>',
          response: { success: true, apiKey: 'ethr_r6V3GYdQyWkRbfrc8jJfZcBZnv-0SrEBPE6i8sgtS', prefix: 'ethr_r6V3GYd', generatedAt: '2026-09-15T21:10:00.000Z', message: 'Store this key now - it will not be shown again.' },
        },
        {
          id: 'api-keys-revoke', method: 'DELETE', path: '/api-keys', auth: 'key',
          summary: 'Revoke the API key',
          response: { success: true, message: 'API key revoked' },
        },
        {
          id: 'clients-me', method: 'GET', path: '/clients/me', auth: 'key',
          summary: 'The authenticated account',
          response: { id: '3446068b-…', username: 'acme-shop', createdAt: '2026-06-01T10:00:00.000Z', lastLogin: '2026-09-15T21:00:00.000Z', developer: false, recoveryCodesRemaining: 7, recoveryCodesTotal: 10 },
        },
      ],
    },

    {
      id: 'chains',
      title: 'Chains',
      icon: 'globalCheck',
      intro: [
        '65 chains are supported. A chain is identified by its <strong>code</strong> in every request and response (<code>payoutChain</code>, <code>wallet.chain</code>); its <strong>symbol</strong> is the ticker to show next to amounts. They differ on the L2s: <code>BASE</code>, <code>ARB</code> and <code>OP</code> are all <code>ETH</code>.',
      ],
      table: {
        head: ['Code', 'Coin', 'Family', 'Confirmations', 'Dollar tokens', 'Wallet-pay', 'Cross-chain swaps', 'On-chain swaps'],
        rows: [
          ['ETH', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'THORChain + SideShift', 'yes'],
          ['POL', 'POL', 'EVM', '20', 'USDC, USDT', 'yes', 'SideShift', 'yes'],
          ['BASE', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'THORChain + SideShift', 'yes'],
          ['ARB', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', 'yes'],
          ['OP', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', 'yes'],
          ['BNB', 'BNB', 'EVM', '3', 'USDC, USDT', 'yes', 'THORChain + SideShift', 'yes'],
          ['AVAX', 'AVAX', 'EVM', '3', 'USDC, USDT', 'yes', 'THORChain + SideShift', 'yes'],
          ['BTC', 'BTC', 'UTXO', '1', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['LTC', 'LTC', 'UTXO', '2', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['SOL', 'SOL', 'Solana', '1', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['BCH', 'BCH', 'UTXO', '1', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['DOGE', 'DOGE', 'UTXO', '2', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['XRP', 'XRP', 'XRP Ledger', '1', '\u2014', 'no', 'THORChain + SideShift', '\u2014'],
          ['LINEA', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', 'yes'],
          ['SCROLL', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['ZKSYNC', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', '\u2014'],
          ['GNOSIS', 'XDAI', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', 'yes'],
          ['CELO', 'CELO', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['CRO', 'CRO', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', '\u2014'],
          ['OPBNB', 'BNB', 'EVM', '3', 'USDT', 'yes', 'direct only', '\u2014'],
          ['SONIC', 'S', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', 'yes'],
          ['SEI', 'SEI', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', '\u2014'],
          ['BERA', 'BERA', 'EVM', '3', 'USDT', 'yes', 'SideShift', 'yes'],
          ['MON', 'MON', 'EVM', '3', 'USDT', 'yes', 'SideShift', 'yes'],
          ['HYPE', 'HYPE', 'EVM', '3', 'USDT', 'yes', 'SideShift', 'yes'],
          ['CORE', 'CORE', 'EVM', '3', 'USDT', 'yes', 'SideShift', '\u2014'],
          ['KAIA', 'KAIA', 'EVM', '3', 'USDT, USDC', 'yes', 'direct only', '\u2014'],
          ['RON', 'RON', 'EVM', '3', 'USDC', 'yes', 'SideShift', 'yes'],
          ['WORLD', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['UNI', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', 'yes'],
          ['INK', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['SONEIUM', 'ETH', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['TAIKO', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['LISK', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['ABS', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['XPL', 'XPL', 'EVM', '3', 'USDT', 'yes', 'SideShift', 'yes'],
          ['MANTLE', 'MNT', 'EVM', '3', 'USDC, USDT', 'yes', 'SideShift', '\u2014'],
          ['MODE', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['FRAX', 'FRAX', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['IMX', 'IMX', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['TELOS', 'TLOS', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['AURORA', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['METIS', 'METIS', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['BOBA', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['GRAVITY', 'G', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['CYETH', 'ETH', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['SSEED', 'ETH', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['HEMI', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['KATANA', 'ETH', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['APECHAIN', 'APE', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['FLR', 'FLR', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['PLS', 'PLS', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['BTR', 'BTC', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['MERLIN', 'BTC', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['KAVA', 'KAVA', 'EVM', '3', 'USDT', 'yes', 'direct only', '\u2014'],
          ['NOVA', 'ETH', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['ZETA', 'ZETA', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['HEDERA', 'HBAR', 'EVM', '3', 'USDT', 'yes', 'direct only', '\u2014'],
          ['FUSE', 'FUSE', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['PLUME', 'PLUME', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['MORPH', 'ETH', 'EVM', '3', 'USDC, USDT', 'yes', 'direct only', '\u2014'],
          ['ZKCRO', 'ZKCRO', 'EVM', '3', 'USDC', 'yes', 'direct only', '\u2014'],
          ['BLAST', 'ETH', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['ZORA', 'ETH', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
          ['BTT', 'BTT', 'EVM', '3', '\u2014', 'yes', 'direct only', '\u2014'],
        ],
      },
      endpoints: [
        {
          id: 'chains-list', method: 'GET', path: '/chains', auth: 'public',
          summary: 'List supported chains',
          description: 'The registry as integrators need it: codes, symbols, chain ids, confirmation thresholds, explorer links and which checkout modes each chain supports. Cached for a minute. Read this rather than hardcoding the list.',
          response: {
            chains: [
              { code: 'BASE', name: 'Base', symbol: 'ETH', family: 'evm', chainId: 8453, decimals: 18, confirmations: 3, blockTimeSec: 2, explorerTx: 'https://basescan.org/tx/', walletPay: true, manualCheckout: true, rpcForWallet: ['https://mainnet.base.org', 'https://1rpc.io/base'] },
              { code: 'BTC', name: 'Bitcoin', symbol: 'BTC', family: 'utxo', chainId: null, decimals: 8, confirmations: 1, blockTimeSec: 600, explorerTx: 'https://mempool.space/tx/', walletPay: false, manualCheckout: true, rpcForWallet: [] },
            ],
          },
        },
      ],
    },

    {
      id: 'wallets',
      title: 'Wallets',
      icon: 'walletIcon',
      intro: [
        'A wallet is a receiving address on one chain, with its key generated and held server-side, encrypted at rest. Create as many as you like per chain and give them names to tell them apart. Balances are re-read from the chain in the background at most every 30 seconds.',
        '<code>balance</code> is what you can withdraw. <code>onChainBalance</code> is what the address really holds; the difference, <code>platformFeeHeld</code>, is the platform fee from earlier withdrawals awaiting collection. <code>tokens</code> lists the chain\'s dollar tokens the same way, each with its own <code>balance</code> and <code>platformFeeHeld</code>; a token is withdrawable like the coin.',
      ],
      endpoints: [
        {
          id: 'wallets-list', method: 'GET', path: '/wallets/list', auth: 'key',
          summary: 'List your wallets',
          response: [
            { id: 'd3be47a8-…', address: '0x9Ba140Ff2333252F169E8c78cB171c107c9FF0C8', chain: 'ETH', label: 'Shop payouts', balance: 0.42, balanceUSD: 1004.51, onChainBalance: 0.44, onChainBalanceUSD: 1052.34, platformFeeHeld: 0.02, platformFeeHeldUSD: 47.83, tokens: [{ symbol: 'USDC', contract: '0xA0b8…', balance: 120, balanceUSD: 120, onChainBalance: 120, platformFeeHeld: 0 }], tokensUSD: 120, lastUpdated: '2026-09-21T03:10:04.000Z', createdAt: '2026-09-16T02:13:55.006Z', isProcessing: false },
          ],
        },
        {
          id: 'wallets-refresh', method: 'POST', path: '/wallets/refresh', auth: 'key',
          summary: 'Read every wallet from its chain now',
          description: 'Balances are otherwise read on a rolling sweep (every wallet at least every few minutes, sooner with a transaction in flight) and at once when the platform moves money through a wallet. Call this when you want the figures fresh right now - after a withdrawal, say. Throttled per account: a second call inside a few seconds returns what the first read. <code>lastUpdated</code> on each wallet says when its chain was last read; <code>balanceUSD</code> is always at the current rate.',
          response: [
            { id: 'd3be47a8-…', address: '0x9Ba140Ff2333252F169E8c78cB171c107c9FF0C8', chain: 'ETH', balance: 0.31, balanceUSD: 812.66, onChainBalance: 0.33, lastUpdated: '2026-09-21T03:12:40.512Z', isProcessing: true },
          ],
        },
        {
          id: 'wallets-generate', method: 'POST', path: '/wallets/generate', auth: 'key',
          summary: 'Create a wallet',
          body: { chain: 'BASE', label: 'Base checkout' },
          bodyDoc: [
            ['chain', 'string', 'A chain code from <code>/chains</code>.'],
            ['label', 'string', 'Optional. Up to 40 characters, shown wherever the wallet appears.'],
          ],
          response: { id: 'c0ee6f5b-…', address: '0xc064007984A5cF4d0914AEBf499dD4c49B40DCbB', chain: 'BASE', label: 'Base checkout', clientId: '3446068b-…', balance: 0, createdAt: '2026-09-16T02:13:55.216Z' },
          status: 201,
        },
        {
          id: 'wallets-qr', method: 'GET', path: '/wallets/:walletId/qr', auth: 'key',
          summary: 'The address as a QR code',
          description: 'An SVG encoding the wallet\'s address, for anyone who wants to pay it directly. Drawn the way the payment link\'s QR is.',
          response: { success: true, address: '0x9Ba1…', chain: 'ETH', svg: '<svg xmlns="http://www.w3.org/2000/svg" …>…</svg>' },
        },
        {
          id: 'wallets-rename', method: 'PATCH', path: '/wallets/:walletId', auth: 'key',
          summary: 'Rename a wallet',
          description: 'Sets the label. Send an empty string to clear it. Returns the wallet as <code>/wallets/list</code> would.',
          body: { label: 'Client A — invoices' },
          response: { id: 'd3be47a8-…', address: '0x9Ba1…', chain: 'ETH', label: 'Client A — invoices', balance: 0.42, balanceUSD: 1004.51, onChainBalance: 0.44, onChainBalanceUSD: 1052.34, platformFeeHeld: 0.02, platformFeeHeldUSD: 47.83, createdAt: '2026-09-16T02:13:55.006Z', isProcessing: false },
        },
        {
          id: 'wallets-delete', method: 'DELETE', path: '/wallets/delete', auth: 'key',
          summary: 'Close a wallet',
          description: 'A soft delete: the record keeps the only copy of the key. The wallet is read from its chain first, and closing is refused with <code>409</code> while it holds anything you could still withdraw (over the chain\'s withdrawal minimum) or has a transaction in flight. What remains at the address when it closes - the platform fee held from earlier withdrawals, and any remainder too small to withdraw - is retained by the platform; <code>forfeited</code> says what that was. A closed wallet cannot be reopened.',
          body: { walletId: 'd3be47a8-…' },
          response: { message: 'Wallet closed. 0.00034 ETH and 0.28 USDC left at the address is retained by the platform.', forfeited: { coin: { asset: 'ETH', amount: 0.00034, usd: 0.91 }, tokens: [{ asset: 'USDC', amount: 0.28, usd: 0.28 }], usd: 1.19 } },
        },
      ],
    },

    {
      id: 'checkout',
      title: 'Checkout',
      icon: 'checkmark',
      intro: [
        'A checkout session is a payment link. You create one for a wallet and an amount, send the customer to <code>checkoutUrl</code>, and watch it settle - by polling, or by webhook. The customer tells the page which address they are paying from, or connects a browser wallet on EVM chains and pays in one click; settlement matches a transaction from that address to your wallet and waits for the chain\'s confirmation threshold.',
        'States: <code>PENDING</code> (no payer address yet) → <code>AWAITING_PAYMENT</code> → <code>VERIFYING</code> (a transaction is seen and gaining confirmations, or the chain is briefly unreadable) → <code>PAID</code>, <code>INSUFFICIENT</code> (short by more than the tolerance) or <code>EXPIRED</code>. A session is only ever expired if <strong>nothing was sent</strong> in its 60-minute window; a payment seen at the deadline still settles.',
      ],
      endpoints: [
        {
          id: 'checkout-create', method: 'POST', path: '/checkout/create', auth: 'key',
          summary: 'Create a payment link',
          body: { walletId: 'c0ee6f5b-…', usdAmount: 25, reference: 'order-1042', successRoute: 'https://shop.example/thanks', failureRoute: 'https://shop.example/failed', webhookUrl: 'https://shop.example/hooks/etheroute' },
          bodyDoc: [
            ['walletId', 'string', 'The receiving wallet. Its chain is the session\'s chain.'],
            ['usdAmount <em>or</em> nativeAmount', 'number', 'Exactly one. A USD amount is converted at the moment of creation and fixed.'],
            ['reference', 'string', 'Optional, up to 120 characters. Your order id; returned in every view and webhook.'],
            ['successRoute', 'URL', 'Where the customer is sent after paying. A signed <code>token</code> is appended - verify it or call the API before releasing goods.'],
            ['failureRoute', 'URL', 'Where the customer is sent on underpayment or expiry.'],
            ['webhookUrl', 'URL', 'Optional. Public <code>https</code> only; private addresses and redirects are refused.'],
          ],
          response: { success: true, sessionId: '7bc9f3fa-…', checkoutUrl: 'https://your-host/checkout/7bc9f3fa-…', expiresAt: '2026-09-16T11:19:39.433Z', chain: 'BASE', chainSymbol: 'ETH', walletAddress: '0xc064…', nativeAmount: 0.00209179, usdAmount: 25, usdRate: 11951.5 },
          status: 201,
          notes: 'A link works the same way on every chain. BNB has no public transaction index, so a payment sent by hand there is found by reading the chain\'s blocks over RPC from the moment the customer gives their address; nothing changes for the integrator.',
        },
        {
          id: 'checkout-sessions', method: 'GET', path: '/checkout/sessions', auth: 'key',
          summary: 'List your payment links',
          query: [['status', 'Filter by state, e.g. <code>PAID</code>.'], ['limit', '1–200, default 50.'], ['offset', 'Default 0.']],
          response: { success: true, total: 11, totals: { PAID: 4, EXPIRED: 5, AWAITING_PAYMENT: 2 }, paidUsd: 16, limit: 50, offset: 0, sessions: [{ sessionId: '7bc9…', reference: 'order-1042', status: 'PAID', chain: 'BASE', chainSymbol: 'ETH', chainName: 'Base', walletId: 'c0ee…', walletAddress: '0xc064…', nativeAmount: 0.00209179, usdAmount: 25, clientWalletAddress: '0xdd19…', paidAmount: 0.00209179, paidTxHash: '0xabab…', pendingTxHash: null, paidAt: '2026-09-16T10:31:02.000Z', lastCheckedAt: '2026-09-16T10:31:02.000Z', confirmations: 3, requiredConfirmations: 3, successRoute: 'https://shop.example/thanks', failureRoute: 'https://shop.example/failed', webhookUrl: 'https://shop.example/hooks/etheroute', expiresAt: '…', createdAt: '…' }] },
        },
        {
          id: 'checkout-session-merchant', method: 'GET', path: '/checkout/sessions/:sessionId', auth: 'key',
          summary: 'One payment link, in full',
          description: 'The merchant view: everything in the list entry, including the transaction hash, the payer\'s address and both redirect routes.',
          response: { success: true, session: { sessionId: '7bc9…', reference: 'order-1042', status: 'INSUFFICIENT', chain: 'LTC', chainSymbol: 'LTC', chainName: 'Litecoin', nativeAmount: 0.5, paidAmount: 0.42, paidTxHash: '9f3c…', confirmations: 2, requiredConfirmations: 2, paidAt: '…' } },
        },
        {
          id: 'checkout-quote', method: 'GET', path: '/checkout/quote', auth: 'key',
          query: [['chain', 'A supported chain code, e.g. <code>ETH</code>. Required.']],
          summary: 'The rate a link would be quoted at now',
          description: 'The same price feed <code>/checkout/create</code> reads, so an amount can be previewed in the coin before the link exists. A preview only: the rate that counts is read when the link is created and fixed there. <code>usdRate</code> is 0 until the feed has loaded.',
          response: { success: true, chain: 'ETH', symbol: 'ETH', usdRate: 2640.34, ageSeconds: 40, fresh: true },
        },
        {
          id: 'checkout-session-qr', method: 'GET', path: '/checkout/sessions/:sessionId/qr', auth: 'key',
          summary: 'The link as a QR code',
          description: 'An SVG encoding the URL of the hosted checkout page, for showing a customer to scan. Distinct from the payment QR the checkout page itself draws, which encodes the pay-to address and only exists once the customer has given their sending address.',
          response: { success: true, url: 'https://etheroute.io/checkout/7bc9…', svg: '<svg xmlns="http://www.w3.org/2000/svg" …>…</svg>' },
        },
        {
          id: 'checkout-cancel', method: 'POST', path: '/checkout/sessions/:sessionId/cancel', auth: 'key',
          summary: 'Cancel an unpaid link',
          description: 'Only a link that has not settled can be cancelled; it moves to <code>EXPIRED</code>.',
          response: { success: true, session: { sessionId: '7bc9…', status: 'EXPIRED' } },
        },
        {
          id: 'checkout-session-public', method: 'GET', path: '/checkout/session/:sessionId', auth: 'public',
          summary: 'Public session view (used by the checkout page)',
          description: 'What the hosted page needs. The receiving address is withheld until the customer has submitted theirs.',
          response: { sessionId: '7bc9…', chain: 'BASE', chainInfo: { code: 'BASE', name: 'Base', symbol: 'ETH', family: 'evm', chainId: 8453, decimals: 18, confirmations: 3, walletPay: true, manualCheckout: true, tokens: [{ symbol: 'USDC', contract: '0x8335…2913', decimals: 6 }, { symbol: 'USDT', contract: '0xfde4…22b2', decimals: 6 }] }, walletAddress: null, nativeAmount: 0.00209179, usdAmount: 25, amounts: { ETH: 0.00209179, USDC: 25, USDT: 25 }, asset: 'ETH', paidAsset: null, status: 'PENDING', expiresAt: '…', createdAt: '…', hasClientAddress: false, paymentUri: null, paymentQr: null },
          notes: '<code>amounts</code> is the figure for each asset the link can be paid in - the coin\'s, fixed at creation, and the dollars for each dollar token the chain carries. <code>asset</code> is what the page is set to, the coin until the customer picks.',
        },
        {
          id: 'checkout-submit-wallet', method: 'POST', path: '/checkout/submit-wallet', auth: 'public',
          summary: 'Customer submits their paying address',
          description: 'Set once; a second submission is refused, so a session id alone cannot redirect the match to another payer.',
          body: { sessionId: '7bc9…', clientWalletAddress: '0xdd19…', asset: 'USDC' },
          response: { success: true, status: 'AWAITING_PAYMENT', walletAddress: '0xc064…', paymentUri: 'ethereum:0x8335…2913@8453/transfer?address=0xc064…&uint256=25000000', paymentQr: '<svg …>' },
          notes: '<code>asset</code> is optional: the chain\'s coin, or one of the dollar tokens the link carries a figure for (see <code>amounts</code> on the session). Left out, the coin.',
        },
        {
          id: 'checkout-pick-asset', method: 'POST', path: '/checkout/pick-asset', auth: 'public',
          summary: 'Customer changes what they will pay in',
          description: 'On an EVM chain a link can be paid in the chain\'s coin or in one of its dollar tokens (USDC, USDT); the customer picks on the page, normally with their address. This changes the pick afterwards - the QR and the figure - until a payment has been seen. Settlement watches every asset the link can be paid in regardless, so this only shapes the page.',
          body: { sessionId: '7bc9…', asset: 'USDC' },
          response: { success: true, asset: 'USDC', amount: 25, paymentUri: 'ethereum:0x8335…2913@8453/transfer?address=0xc064…&uint256=25000000', paymentQr: '<svg …>' },
        },
        {
          id: 'checkout-tx-hint', method: 'POST', path: '/checkout/tx-hint', auth: 'public',
          summary: 'Customer\'s wallet reports the transaction it sent',
          description: 'EVM chains only. The hash is a pointer, not a claim: settlement fetches the transaction itself over RPC and checks the sender, recipient, value and receipt before crediting anything. Lets a wallet-pay checkout settle without waiting for an explorer to index the transaction.',
          body: { sessionId: '7bc9…', txHash: '0xabab…' },
          response: { sessionId: '7bc9…', status: 'VERIFYING', detected: true, pendingTxHash: '0xabab…', confirmations: 0, requiredConfirmations: 3 },
        },
        {
          id: 'checkout-status', method: 'GET', path: '/checkout/status/:sessionId', auth: 'public',
          summary: 'Poll a session',
          description: 'Checks the chain (throttled to once per 15 seconds per session however often it is polled) and returns the current state. Terminal states carry <code>redirectUrl</code> with the signed token appended.',
          response: { sessionId: '7bc9…', status: 'PAID', chain: 'BASE', chainSymbol: 'ETH', walletAddress: '0xc064…', nativeAmount: 0.00209179, usdAmount: 25, asset: 'USDC', amounts: { ETH: 0.00209179, USDC: 25, USDT: 25 }, expiresAt: '…', paidAmount: 25, paidAsset: 'USDC', paidTxHash: '0xabab…', paidAt: '…', confirmations: 3, requiredConfirmations: 3, pendingTxHash: null, pendingAsset: null, detected: true, redirectUrl: 'https://shop.example/thanks?session=7bc9…&status=PAID&token=4zyEc6…' },
          notes: '<code>paidAsset</code> names what arrived - the coin, or a dollar token - and <code>paidAmount</code> is in that asset. The same two fields are on the merchant views and in the webhook.',
        },
      ],
    },

    {
      id: 'webhooks',
      title: 'Webhooks',
      icon: 'responses',
      intro: [
        'When a session settles, underpays or expires, we <code>POST</code> to the <code>webhookUrl</code> you gave it. Deliveries are retried with backoff (5 s, 30 s, 2 min, 10 min, 1 h) up to six times until your endpoint answers 2xx. Settlement runs server-side, so the webhook fires whether or not the customer kept the page open.',
        'Every delivery is signed. The header is <code>Etheroute-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code> where <code>v1</code> is HMAC-SHA256 over <code>&lt;t&gt;.&lt;raw body&gt;</code> with your signing secret. Compare in constant time and reject timestamps older than a few minutes.',
      ],
      events: [
        ['checkout.session.completed', 'Paid in full and confirmed.'],
        ['checkout.session.underpaid', 'A payment arrived but fell short by more than the tolerance (1% by default).'],
        ['checkout.session.expired', 'The window closed with nothing sent.'],
      ],
      payload: {
        event: 'checkout.session.completed',
        data: { sessionId: '7bc9…', status: 'PAID', chain: 'BASE', nativeAmount: 0.00209179, usdAmount: 25, paidAmount: 0.00209179, paidTxHash: '0xabab…', paidAt: '2026-09-16T10:31:02.000Z', walletAddress: '0xc064…', clientWalletAddress: '0xdd19…' },
        createdAt: '2026-09-16T10:31:02.000Z',
      },
      verify: `const crypto = require('crypto');

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!parts.t || !parts.v1 || age > toleranceSeconds) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  return expected.length === parts.v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}`,
    },

    {
      id: 'withdrawal',
      title: 'Withdrawals',
      icon: 'withdraw',
      intro: [
        'A withdrawal sweeps one or more of your wallets to an address of yours on the chain you choose, in the asset you choose: the chain\'s coin (the default) or, on an EVM chain, one of its dollar tokens. Everything a wallet holds is swept - its coin and any USDC or USDT - and each holding takes a route: <code>direct</code> (already the payout asset on the payout chain), <code>dex</code> (another asset on the payout chain, swapped on the chain itself through a router contract the wallet calls, paid straight to your address), <code>thorchain</code> (another chain, through THORChain\'s vaults: the wallet deposits with a memo and the network pays your address, no custodian), <code>sideshift</code> (another chain, converted at a fixed rate) or <code>dex+thorchain</code> / <code>dex+sideshift</code> (a token swapped for its chain\'s coin first, then sent across). Both cross-chain providers are quoted where both serve a pair and the one that pays more is used; <code>crossQuote</code> on a transfer says which and why. The network fee is reserved from live estimates, then the platform fee (5% by default) comes off what is swept, and the rest is sent.',
        'Withdrawals are asynchronous: the request returns a payout in <code>PENDING</code> and transfers are broadcast and watched in the background. Poll <code>/payouts/:id</code>. A Bitcoin confirmation or a swap out of Bitcoin can take an hour; <code>PROCESSING</code> for that long is normal, not an error.',
      ],
      endpoints: [
        {
          id: 'withdrawal-preview', method: 'POST', path: '/withdrawal/preview', auth: 'key',
          summary: 'Quote a withdrawal',
          description: 'Runs the same plan the withdrawal will, without creating anything. <code>transfers</code> is one line per holding - a wallet\'s coin, or a dollar token it holds - with the exact figures that will be used; they sum to the totals. <code>route</code> says how it travels. <code>gasUsd</code> is the cost line, the sum of <code>networkFeeUsd</code> (the transactions the leg sends) and <code>swapFeeUsd</code> (what a swap loses to spread). <code>skipped</code> lists holdings in the chosen wallets that stay put, with the reason: a coin kept back for gas, a token with no route, a balance under the minimum.',
          body: { recipientAddress: '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e', payoutChain: 'BASE', payoutAsset: 'ETH', selectedWallets: ['0x9Ba1…', 'bc1qq6v…'] },
          bodyDoc: [
            ['recipientAddress', 'string', 'Must be valid for <code>payoutChain</code>.'],
            ['payoutChain', 'string', 'Chain code to receive in. Default <code>ETH</code>.'],
            ['payoutAsset', 'string', 'Optional. The asset on that chain: its coin by default, or a dollar token it carries (<code>USDC</code>, <code>USDT</code>).'],
            ['selectedWallets', 'string[]', 'Optional. Wallet addresses to include; default all active wallets.'],
          ],
          response: { success: true, data: { payoutChain: 'BASE', payoutAsset: 'ETH', totalAmountUsd: 140, grossSweptUsd: 139.2, platformFee: 6.96, totalGasUsd: 1.43, netAmountUsd: 130.81, platformFeeRate: 0.05, eligibleCount: 2, ineligibleCount: 0, transfers: [{ chain: 'BASE', asset: 'ETH', payoutChain: 'BASE', payoutAsset: 'ETH', type: 'DIRECT_TRANSFER', route: 'direct', fromAddress: '0x9Ba1…', grossUsd: 19.6, platformFeeUsd: 0.98, gasUsd: 0.01, networkFeeUsd: 0.01, swapFeeUsd: 0, netUsd: 18.61, nativeAmount: 0.0082, expectedOutputAmount: 0.0082, gasIsLive: true }, { chain: 'BASE', asset: 'USDC', payoutChain: 'BASE', payoutAsset: 'ETH', type: 'DEX_SWAP', route: 'dex', fromAddress: '0x9Ba1…', grossUsd: 100, platformFeeUsd: 5, gasUsd: 0.12, networkFeeUsd: 0.02, swapFeeUsd: 0.1, netUsd: 94.88, nativeAmount: 95, expectedOutputAmount: 0.0361, gasIsLive: true, dexQuote: { provider: 'kyber', to: 'ETH', amountOut: 0.0361, minAmountOut: 0.0359, impact: 0.001, router: '0x6131…' } }, { chain: 'BTC', asset: 'BTC', payoutChain: 'BASE', payoutAsset: 'ETH', type: 'SWAP', route: 'thorchain', fromAddress: 'bc1qq6v…', grossUsd: 19.6, platformFeeUsd: 0.98, gasUsd: 1.3, networkFeeUsd: 0.8, swapFeeUsd: 0.5, gasAdvanceUsd: 0, netUsd: 17.32, nativeAmount: 0.00026, expectedOutputAmount: 0.0066, gasIsLive: true, crossQuote: { provider: 'thorchain', outputAmount: 0.0066, inboundAddress: 'bc1qp0j…', memo: '=:f:0xDd19…:645000/1/0', totalSeconds: 1272, feesBps: 23, alternatives: [{ provider: 'sideshift', outputAmount: 0.0064 }], refusals: [] } }], skipped: [{ chain: 'BASE', asset: 'USDT', fromAddress: '0x9Ba1…', reason: 'balance $0.40 below $0.53 minimum for a ETH@BASE payout' }], ineligibleWallets: [] } },
        },
        {
          id: 'withdrawal-create', method: 'POST', path: '/withdrawal', auth: 'key',
          summary: 'Create a withdrawal',
          description: 'Requires an <code>Idempotency-Key</code> header: a retry after a timeout must not broadcast a second set of transfers. Use one key per intended withdrawal and reuse it on retry; the first successful response is replayed. One withdrawal at a time per account - a second while one is being planned returns <code>409</code>. Rate-limited to 5 per minute.',
          headers: [['Idempotency-Key', 'Any unique string, e.g. a UUID.']],
          body: { recipientAddress: '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e', payoutChain: 'BASE', payoutAsset: 'USDC', selectedWallets: ['0x9Ba1…', 'bc1qq6v…'] },
          bodyDoc: [
            ['recipientAddress', 'string', 'Must be valid for <code>payoutChain</code>.'],
            ['payoutChain', 'string', 'Chain code to receive in. Default <code>ETH</code>.'],
            ['payoutAsset', 'string', 'Optional. The asset on that chain: its coin by default, or a dollar token it carries.'],
            ['selectedWallets', 'string[]', 'Optional. Wallet addresses to include; default all active wallets.'],
          ],
          response: { id: 'a1e2…', clientId: '3446…', recipientAddress: '0xDd19…', payoutChain: 'BASE', payoutAsset: 'USDC', netAmountUsd: 130.81, totalAmountUsd: 140, chain: 'BASE', platformFee: 6.96, estimatedTotalGas: 1.43, status: 'PENDING' },
          status: 201,
        },
      ],
    },

    {
      id: 'payouts',
      title: 'Payouts',
      icon: 'payouts',
      intro: [
        'A payout is a withdrawal\'s record: its plan, each transfer\'s progress, and the outcome. States: <code>PENDING</code> → <code>PROCESSING</code> → <code>COMPLETED</code>, <code>PARTIAL</code> (some transfers failed) or <code>FAILED</code>. Each transfer in <code>withdrawalPlan.transfers</code> carries its asset and route, its own status, transaction id and, for a failure, the reason. A <code>dex+thorchain</code> or <code>dex+sideshift</code> transfer also records <code>preSwapTxHash</code>, the on-chain swap that ran before the send; a <code>thorchain</code> transfer records the vault and memo it deposited with; a transfer the gas float funded records <code>gasAdvanceTxHash</code>.',
      ],
      endpoints: [
        {
          id: 'payouts-list', method: 'GET', path: '/payouts/list', auth: 'key',
          summary: 'List your payouts',
          response: { success: true, count: 1, payouts: [{ id: 'a1e2…', status: 'COMPLETED', totalAmountUsd: 140, platformFee: 6.96, estimatedTotalGas: 1.43, gasPerChain: { BASE: 0.13, BTC: 1.3 }, netAmountUsd: 130.81, chain: 'BASE', payoutChain: 'BASE', payoutAsset: 'ETH', recipientAddress: '0xDd19…', type: 'WITHDRAWAL', createdAt: '…', completedAt: '…', withdrawalPlan: { payoutChain: 'BASE', payoutAsset: 'ETH', transfers: [{ chain: 'BASE', asset: 'USDC', route: 'dex', type: 'DEX_SWAP', status: 'CONFIRMED', nativeAmount: 95, txHash: '0x7c2e…' }, { chain: 'BTC', asset: 'BTC', route: 'thorchain', type: 'SWAP', status: 'CONFIRMED', nativeAmount: 0.00026, txHash: 'e3a1…', thorSwap: { vault: 'bc1qp0j…', memo: '=:f:0xDd19…:645000/1/0', expectedOut: 0.0066, minOut: 0.00647 } }] } }] },
        },
        {
          id: 'payouts-get', method: 'GET', path: '/payouts/:payoutId', auth: 'key',
          summary: 'One payout',
          response: { success: true, payout: { id: 'a1e2…', status: 'PROCESSING', withdrawalPlan: { transfers: [{ chain: 'BTC', status: 'PROCESSING', txHash: 'e3a1…' }] } } },
        },
      ],
    },

    {
      id: 'transactions',
      title: 'Transactions',
      icon: 'transactionsIcon',
      intro: [
        'Transactions are the individual on-chain transfers a payout broadcasts. Statuses: <code>PENDING</code>, <code>PROCESSING</code> (broadcast, awaiting confirmation), <code>CONFIRMED</code>, <code>FAILED</code> with a <code>failureReason</code> such as <code>INSUFFICIENT_FUNDS</code>, <code>ORDER_REFUNDED</code> or <code>QUOTE_EXPIRED</code>.',
        'Types: <code>DIRECT_TRANSFER</code>, <code>DEX_SWAP</code> and <code>SWAP</code> are a payout\'s legs; <code>DEPOSIT</code> is a checkout that settled into one of your wallets; <code>FEE_COLLECTION</code> is the platform collecting the fee it had held from earlier withdrawals (<code>platformFeeHeld</code> on the wallet comes down by the same amount). On Bitcoin-style chains the fee usually leaves in the withdrawal\'s own transaction instead, as a second output.',
      ],
      endpoints: [
        {
          id: 'transactions-list', method: 'GET', path: '/transactions/list', auth: 'key',
          summary: 'List your transactions',
          response: [{ id: 't1…', transactionHash: 'e3a1…', type: 'SWAP', chain: 'BTC', nativeAmount: 0.00026, usdAmount: 19.6, status: 'CONFIRMED', createdAt: '…', completedAt: '…', failedAt: null, failureReason: null }],
        },
        {
          id: 'transactions-get', method: 'GET', path: '/transactions/:transactionId', auth: 'key',
          summary: 'One transaction',
          response: { id: 't1…', clientId: '3446…', transactionHash: 'e3a1…', orderId: 'sideshift-…', type: 'SWAP', chain: 'BTC', nativeAmount: 0.00026, usdAmount: 19.6, status: 'CONFIRMED', fromAddress: 'bc1qq6v…', toAddress: 'bc1qdeposit…', finalAddress: '0xDd19…', blockNumber: 912345, createdAt: '…', completedAt: '…' },
        },
        {
          id: 'transactions-wallet', method: 'POST', path: '/transactions/wallet', auth: 'key',
          summary: 'On-chain history for a wallet',
          description: 'The raw recent transactions at a wallet address, from the chain\'s explorer or index. The shape varies by chain family.',
          body: { walletId: 'd3be47a8-…' },
          response: { address: '0x9Ba1…', network: 'mainnet', transactions: [{ hash: '0x…', from: '0x…', to: '0x9Ba1…', value: '2091790000000000', timeStamp: '1758018662', confirmations: '18' }], timestamp: '…' },
        },
      ],
    },

    {
      id: 'usage',
      title: 'Usage & status',
      icon: 'barChart',
      endpoints: [
        {
          id: 'api-calls-stats', method: 'GET', path: '/api-calls/stats', auth: 'key',
          summary: 'Your API call volume',
          query: [['period', '<code>day</code> (default), <code>week</code> or <code>month</code>.']],
          response: { success: true, period: 'day', labels: ['00:00', '01:00', '…'], values: [3, 0, 12], periodTotal: 15 },
        },
        {
          id: 'api-calls-recent', method: 'GET', path: '/api-calls/recent', auth: 'key',
          summary: 'Your last requests',
          description: 'The newest calls the account made, key or session, with method, path, status and time, plus the figures the dashboard shows beside them. Calls to this log itself are left out.',
          query: [['limit', '1–100, default 20.']],
          response: { success: true, totalCalls: 1284, last24h: 36, errors24h: 2, calls: [{ method: 'GET', endpoint: '/api/wallets/list', statusCode: 200, timestamp: '2026-09-19T14:02:11.000Z' }] },
        },
        {
          id: 'status', method: 'GET', path: '/status', auth: 'public',
          summary: 'Service status',
          response: { success: true, overall: 'operational', services: [{ name: 'API', status: 'operational' }], viewer: { canViewIncidents: false }, incidents: [], activeIncidents: [] },
        },
        {
          id: 'status-incidents', method: 'GET', path: '/status/incidents', auth: 'public',
          summary: 'Recent incidents',
          response: { success: true, incidents: [] },
        },
        {
          id: 'status-chains', method: 'GET', path: '/status/chains', auth: 'public',
          summary: 'Chain health',
          description: 'What every chain answered on the last sweep (every five minutes): how many of its endpoints replied and how fast, the tip and whether it is still moving, and which routes off it are open - THORChain, SideShift, and each on-chain aggregator. <code>status</code> is <code>up</code>, <code>degraded</code> (a route off, or a tip that has stopped) or <code>down</code> (nothing answering). <code>since</code> is when it last changed. <code>days</code> is thirty days of daily uptime from the recorded changes; <code>events</code> the most recent changes across every chain.',
          response: { success: true, checkedAt: '…', intervalMs: 300000, counts: { up: 62, degraded: 2, down: 0, unknown: 0 }, chains: [{ code: 'BASE', name: 'Base', symbol: 'ETH', family: 'evm', status: 'up', rpc: { ok: true, endpointsUp: 3, endpoints: 3, tip: 51582778, latencyMs: 178, stalled: false }, routes: { thorchain: 'open', sideshift: 'open', kyber: 'open', paraswap: 'open' }, since: '…', checkedAt: '…', days: [{ date: '2026-09-20', status: 'operational', downtimeMinutes: 0, uptimePercentage: 100 }] }], events: [{ at: '…', chain: 'SOL', name: 'Solana', component: 'thorchain', from: 'open', to: 'halted', detail: '' }] },
        },
      ],
    },

    {
      id: 'errors',
      title: 'Errors & limits',
      icon: 'security',
      intro: [
        'Errors are JSON with a name and a message. Nothing internal is leaked; a 500 carries a <code>requestId</code> to quote to support. The same id is on every response as the <code>X-Request-Id</code> header.',
      ],
      table: {
        head: ['Status', 'When'],
        rows: [
          ['400', 'A malformed request: missing field, bad amount, unknown chain, invalid address for the chain.'],
          ['401', 'No credential, or one that is expired or revoked.'],
          ['403', 'A developer-only endpoint.'],
          ['404', 'The resource does not exist - or belongs to another account. The two are not distinguished.'],
          ['409', 'A conflict: a withdrawal already in progress, a wallet that still holds funds, an Idempotency-Key in use, a second address for a session.'],
          ['410', 'The checkout session has expired.'],
          ['413', 'The body is over 100 KB.'],
          ['422', 'An Idempotency-Key reused with a different body.'],
          ['429', 'Rate limited. <code>RateLimit-*</code> headers say when to retry.'],
          ['503', 'Not ready: price data missing or stale, or no RPC reachable.'],
        ],
      },
      payload: { error: 'ValidationError', message: 'recipientAddress must be a valid BTC address' },
      facts: [
        ['Per account', '300 requests / minute'],
        ['Per address', '600 requests / minute, before authentication'],
        ['Withdrawals', '5 / minute'],
        ['Checkout page', '60 / minute per customer address'],
        ['Sign in / register', '10 attempts / 15 minutes'],
      ],
    },
  ],
};
