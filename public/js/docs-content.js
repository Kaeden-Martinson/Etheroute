/**
 * The documentation, as structured content. docs.js renders it; keeping it
 * as data means the sidebar, search index and page body cannot fall out of
 * step, and the prose is verified against the code in one place.
 *
 * Block types: 'p' (HTML string), 'h3' (subheading), 'list'/'olist' (array
 * of HTML items), 'steps' (numbered cards), 'callout' ({tone, title, body}),
 * 'table' ({head, rows}), 'code' ({lang, code}).
 */
window.DOCS_CONTENT = {
  sections: [
    {
      id: 'introduction', title: 'Introduction', icon: 'overview', group: 'Getting Started',
      blocks: [
        { type: 'lead', html: 'Etheroute is a multi-chain crypto payments platform. Accept payments across ten chains, hold the funds in wallets you control, and cash out in whichever chain you like — through the dashboard or the API.' },
        { type: 'p', html: 'This guide covers the whole flow: creating an account, generating and naming wallets, taking payments with checkout links, and withdrawing. For the endpoint-by-endpoint reference, see the <a href="/api-reference">API Reference</a>.' },
        { type: 'callout', tone: 'info', title: 'No KYC for a basic account', body: 'Sign up with a username and password. Accepting funds on behalf of others and paying them out may be regulated where you operate — see <a href="/compliance">Compliance</a>.' },
      ],
    },
    {
      id: 'account-setup', title: 'Account setup', icon: 'security', group: 'Getting Started',
      blocks: [
        { type: 'steps', items: [
          { title: 'Create an account', body: 'On the <a href="/auth">sign-in page</a>, choose "Get Started" and pick a username and a password of at least 12 characters.' },
          { title: 'Sign in', body: 'Your session lasts 7 days. Signing out or a long gap means signing in again.' },
          { title: 'Generate an API key', body: 'For programmatic access, open the dashboard\'s API section and generate a key. It is shown once — store it in a secrets manager.' },
        ] },
        { type: 'h3', html: 'Keeping the account secure' },
        { type: 'list', items: [
          'Use a unique, long passphrase. Passwords are stored with scrypt, never in the clear.',
          'Treat an API key like a password: it carries full account access. Revoke and reissue it if it leaks — one click in the dashboard.',
          'The key is shown only at generation. If you lose it, generate a new one; the old one stops working immediately.',
        ] },
      ],
    },
    {
      id: 'chains', title: 'Supported chains', icon: 'globalCheck', group: 'Getting Started',
      blocks: [
        { type: 'p', html: 'Ten chains across three families. A chain is named by its <strong>code</strong> everywhere in the product; the <strong>coin</strong> is what shows next to amounts. They differ on Ethereum L2s, where the network is Base, Arbitrum or Optimism but the coin is still ETH.' },
        { type: 'table', head: ['Chain', 'Code', 'Coin', 'Typical confirmation wait'], rows: [
          ['Ethereum', 'ETH', 'ETH', '~40 seconds (3 blocks)'],
          ['Polygon', 'POL', 'POL', '~40 seconds (20 blocks)'],
          ['Base', 'BASE', 'ETH', '~6 seconds'],
          ['Arbitrum One', 'ARB', 'ETH', 'seconds'],
          ['Optimism', 'OP', 'ETH', '~6 seconds'],
          ['BNB Chain', 'BNB', 'BNB', '~9 seconds'],
          ['Avalanche', 'AVAX', 'AVAX', '~6 seconds'],
          ['Bitcoin', 'BTC', 'BTC', '~10 minutes (1 block)'],
          ['Litecoin', 'LTC', 'LTC', '~5 minutes (2 blocks)'],
          ['Solana', 'SOL', 'SOL', 'under a second'],
        ] },
        { type: 'callout', tone: 'info', title: 'The live list', body: 'The dashboard and the API read the supported chains from <code>GET /api/chains</code>, so this list stays in step with what the server actually offers. Build against that endpoint rather than hardcoding chains.' },
      ],
    },
    {
      id: 'wallets', title: 'Wallets', icon: 'walletIcon', group: 'Using Etheroute',
      blocks: [
        { type: 'p', html: 'A wallet is a receiving address on one chain. Its key is generated and held server-side, encrypted at rest; you never handle a seed phrase. Create as many as you like per chain.' },
        { type: 'h3', html: 'Naming your wallets' },
        { type: 'p', html: 'Give each wallet a name so a page of Ethereum addresses becomes "Shop payouts", "Client A", "Cold storage". Set the name when you create a wallet, or rename any wallet later from the Wallets page — hover a wallet and click the pencil, edit inline, and press Save. Names appear everywhere the wallet does: the wallet list, the withdrawal picker, and the checkout receiving-wallet dropdown.' },
        { type: 'callout', tone: 'tip', title: 'Search your wallets', body: 'The Wallets page has a search box that filters by name, address or chain as you type — useful once you have more than a handful.' },
        { type: 'h3', html: 'What the balances mean' },
        { type: 'list', items: [
          '<strong>Balance</strong> — what you can withdraw right now.',
          '<strong>On-chain balance</strong> — what the address actually holds, verifiable on a block explorer.',
          '<strong>Platform fee held</strong> — the difference: fees from earlier withdrawals still sitting at the address, awaiting collection. Shown openly rather than hidden.',
        ] },
        { type: 'h3', html: 'Removing a wallet' },
        { type: 'p', html: 'Deleting is a soft delete — the record keeps the only copy of the key, so it is never truly destroyed. A wallet that still holds a balance, or has a transaction in flight, cannot be removed; withdraw first.' },
      ],
    },
    {
      id: 'checkout', title: 'Accepting payments', icon: 'checkmark', group: 'Using Etheroute',
      blocks: [
        { type: 'p', html: 'A checkout link is a hosted payment page. Create one for a wallet and an amount, send the customer the link, and watch it settle from the dashboard or by webhook.' },
        { type: 'steps', items: [
          { title: 'Create the link', body: 'On the dashboard\'s Checkout page (or via <code>POST /api/checkout/create</code>), choose the receiving wallet, an amount in USD or the coin, and where to send the customer after paying. Price in USD and the coin amount is fixed at creation.' },
          { title: 'Share it', body: 'Send the customer the <code>checkoutUrl</code>. The page shows the amount, a QR code, and — on Ethereum-family chains — a one-click "Connect wallet" button.' },
          { title: 'They pay', body: 'The customer pays from their wallet. The page detects the transaction, shows confirmations landing block by block, and redirects them back to you when it settles.' },
          { title: 'You get told', body: 'Poll the session, or receive a signed webhook the moment it settles — even if the customer closed the tab.' },
        ] },
        { type: 'h3', html: 'Pay with a browser wallet' },
        { type: 'p', html: 'On every EVM chain, a customer with MetaMask, Rabby, Coinbase Wallet or any EIP-1193 extension can connect and pay in one click. The page fills their address, switches the wallet to the right network (adding it if the wallet does not know it), and sends the exact amount — the wallet shows them the recipient and value before they approve. This also means a payment can be verified instantly, without waiting for a block explorer to index it.' },
        { type: 'h3', html: 'Session states' },
        { type: 'table', head: ['State', 'Meaning'], rows: [
          ['Pending', 'Waiting for the customer to say which address they are paying from.'],
          ['Awaiting payment', 'Address known; watching the chain.'],
          ['Verifying', 'A payment has been seen and is gaining confirmations (or the chain is briefly unreadable).'],
          ['Paid', 'Received in full and confirmed to the chain\'s threshold.'],
          ['Underpaid', 'A payment arrived but fell short by more than the 1% tolerance.'],
          ['Expired', 'The 60-minute window closed with nothing sent.'],
        ] },
        { type: 'callout', tone: 'info', title: 'Expiry only means nothing was sent', body: 'A session is expired only when no funds arrived in its window. A payment seen right at the deadline still settles — full as Paid, short as Underpaid.' },
        { type: 'h3', html: 'Verifying the redirect' },
        { type: 'p', html: 'After paying, the customer is sent to your success URL with a signed <code>token</code> appended. Verify that token (or call the API) before releasing goods — do not trust the redirect alone. A matching failure URL is used for underpayment and expiry.' },
        { type: 'callout', tone: 'info', title: 'BNB Chain checkout', body: 'BNB has no free public transaction index, so the transactions tab cannot show a history for a BNB wallet. Checkout does not need one: a payment sent by hand is found by reading the chain\'s own blocks over RPC from the moment the customer gives their address, and a connected wallet reports its transaction as it does everywhere else.' },
      ],
    },
    {
      id: 'withdrawals', title: 'Withdrawals', icon: 'withdraw', group: 'Using Etheroute',
      blocks: [
        { type: 'p', html: 'A withdrawal sweeps one or more of your wallets to an address you choose, on the chain you choose. Pick the payout chain first, then the wallets to draw from.' },
        { type: 'h3', html: 'Direct transfer or swap' },
        { type: 'list', items: [
          '<strong>Direct</strong> — the wallet is already on the payout chain. A plain on-chain send, no swap, no spread, no minimum beyond the network fee.',
          '<strong>Swap</strong> — anything else is converted through a fixed-rate swap into the payout chain and sent to your address. The rate you are quoted on the review screen is the rate that settles.',
        ] },
        { type: 'h3', html: 'What comes off' },
        { type: 'p', html: 'The network fee is reserved from a live estimate. The platform fee (5% by default) is taken from what is swept — not left behind and quietly collected later — so the figure on the review screen is the figure that is sent. The review breaks this down per wallet, and the lines sum to the totals.' },
        { type: 'callout', tone: 'tip', title: 'Cashing out in a chain you hold is cheapest', body: 'A direct transfer skips the swap and its spread entirely. If most of your income is in one chain, cashing out in that chain keeps the most.' },
        { type: 'h3', html: 'How long it takes' },
        { type: 'p', html: 'Withdrawals run in the background. The dashboard shows each transfer\'s progress. A Bitcoin confirmation, or a swap out of Bitcoin, can take an hour — a payout sitting in "processing" for that long is normal, not a failure. If a swap can\'t complete it is refunded to the source wallet and the transfer is marked failed, so funds are never lost.' },
        { type: 'callout', tone: 'warn', title: 'One at a time', body: 'Only one withdrawal runs per account at once; start another and it waits. Through the API, a withdrawal needs an Idempotency-Key so a retry after a timeout cannot double-send.' },
      ],
    },
    {
      id: 'transactions', title: 'Transactions & payouts', icon: 'transactionsIcon', group: 'Using Etheroute',
      blocks: [
        { type: 'p', html: 'Every withdrawal creates a <strong>payout</strong> — the plan and its outcome — and one <strong>transaction</strong> per transfer it broadcasts. Both are on the dashboard and through the API.' },
        { type: 'table', head: ['Status', 'Meaning'], rows: [
          ['Pending', 'Created, not yet broadcast.'],
          ['Processing', 'Broadcast; waiting for confirmations.'],
          ['Confirmed / Completed', 'Settled on-chain.'],
          ['Partial', 'Some transfers in a payout succeeded, others failed.'],
          ['Failed', 'Did not settle. The reason is recorded — insufficient funds, a refunded swap, an expired quote.'],
        ] },
      ],
    },
    {
      id: 'api-access', title: 'API access', icon: 'apiKeys', group: 'Developers',
      blocks: [
        { type: 'p', html: 'Everything here is available over a JSON API. Generate a key in the dashboard, send it as <code>Authorization: Bearer ethr_…</code>, and see the <a href="/api-reference">API Reference</a> for every endpoint with copy-paste examples in cURL, Node.js and Python.' },
        { type: 'code', lang: 'bash', code: 'curl -X POST "https://<your-host>/api/wallets/generate" \\\n  -H "Authorization: Bearer ethr_YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"chain":"BASE","label":"Base checkout"}\'' },
        { type: 'h3', html: 'Webhooks' },
        { type: 'p', html: 'Give a checkout link a <code>webhookUrl</code> and Etheroute POSTs a signed update when it settles, underpays or expires — retried with backoff until your endpoint answers. Verify the <code>Etheroute-Signature</code> header (HMAC-SHA256); the reference has a ready-to-use snippet.' },
        { type: 'callout', tone: 'info', title: 'Rate limits', body: '300 requests per minute per account by default, 5 withdrawals per minute. Responses carry <code>RateLimit-*</code> headers; a 429 tells you when to retry.' },
      ],
    },
    {
      id: 'faq', title: 'FAQ', icon: 'faq', group: 'Help',
      blocks: [
        { type: 'faq', items: [
          { q: 'How long does a withdrawal take?', a: 'A direct transfer confirms in the payout chain\'s normal block time — seconds on an L2 or Solana, up to an hour on Bitcoin. A swap adds the swap provider\'s processing time on top.' },
          { q: 'Can I cancel a withdrawal?', a: 'No. Once broadcast, an on-chain transfer is irreversible. Check the recipient address and amount on the review screen first.' },
          { q: 'What happens if a swap fails?', a: 'The funds are refunded to the source wallet and the transfer is marked failed with the reason. You can run the withdrawal again.' },
          { q: 'Do my customers need an account?', a: 'No. A checkout link works for anyone with a wallet — by scanning the QR code, pasting an address, or connecting a browser wallet.' },
          { q: 'Is there KYC?', a: 'Not for a basic account. Depending on where you operate and what you do with the platform, regulation may apply to you — see Compliance.' },
        ] },
      ],
    },
    {
      id: 'support', title: 'Get support', icon: 'support', group: 'Help',
      blocks: [
        { type: 'p', html: 'Stuck on something this guide does not cover?' },
        { type: 'list', items: [
          'The <a href="/api-reference">API Reference</a> for endpoint details.',
          'The <a href="/help">Help Center</a> and <a href="/faq">FAQ</a>.',
          'The <a href="/status">status page</a> if something looks down.',
        ] },
      ],
    },
  ],
};
