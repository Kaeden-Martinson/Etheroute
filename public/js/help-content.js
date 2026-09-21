/**
 * The Help Center, as structured content. help.js renders it — the same
 * data-driven approach as the docs, so the sidebar, search index and page body
 * stay in step and the answers are maintained in one place.
 *
 * Block types mirror the docs renderer: 'p' (HTML string), 'lead', 'h3',
 * 'list', 'callout' ({tone, title, body}), 'faq' ({items:[{q,a}]}) and
 * 'channels' ({items:[{label, href, external, svg}]}) for the contact grid.
 */
window.HELP_CONTENT = {
  sections: [
    {
      id: 'getting-started', title: 'Getting started', icon: 'gettingStarted', group: 'Getting Started',
      blocks: [
        { type: 'lead', html: 'New to Etheroute? These are the questions people ask first. For a walkthrough of the whole flow, see the <a href="/docs">documentation</a>.' },
        { type: 'faq', items: [
          { q: 'How do I create an account?', a: 'Visit the <a href="/auth">sign-up page</a>, choose a username and a password of at least 12 characters, and select "Get Started". No personal information is required, and your account is ready immediately.' },
          { q: 'What can I do once I have signed in?', a: 'Create receiving wallets across 65 blockchain networks, take payments with hosted checkout links, watch your balances, generate an API key, and withdraw or swap your funds to any supported chain — all from the dashboard.' },
          { q: 'Is there any KYC?', a: 'Not for a basic account. Depending on where you operate and what you do with the platform, financial regulation may still apply to you — see the <a href="/compliance">Compliance</a> page.' },
        ] },
      ],
    },
    {
      id: 'wallets', title: 'Wallets', icon: 'walletIcon', group: 'Using Etheroute',
      blocks: [
        { type: 'faq', items: [
          { q: 'How do I create a wallet?', a: 'Open the Wallets section of your dashboard and select "Add Wallet". Pick a network, optionally give the wallet a name, and a fresh receiving address is generated for you. The key is held server-side and encrypted at rest — you never handle a seed phrase.' },
          { q: 'Which blockchain networks are supported?', a: '65 networks across four families: Ethereum, Polygon, Base, Arbitrum, Optimism, BNB Chain and Avalanche, then Linea, Scroll, ZKsync Era, Gnosis, Celo, Cronos, opBNB, Sonic, Sei, Berachain, Monad, HyperEVM, Core, Kaia, Ronin, World Chain, Unichain, Ink, Soneium, Taiko, Lisk, Abstract, Plasma, Mantle, Mode, Fraxtal, Immutable zkEVM, Telos EVM, Aurora, Metis Andromeda, Boba Network, Gravity Alpha, Cyber, Superseed, Hemi, Katana, ApeChain, Flare, PulseChain, Bitlayer, Merlin, Kava, Arbitrum Nova, ZetaChain, Hedera, Fuse, Plume, Morph, Cronos zkEVM, Blast, Zora and BitTorrent Chain (all EVM), plus Bitcoin, Litecoin, Bitcoin Cash, Dogecoin, Solana and the XRP Ledger. Every EVM chain also takes USDC and USDT. The dashboard and the API read the live list from <code>GET /api/chains</code>, so it never falls out of step with what the server offers.' },
          { q: 'Can I name my wallets?', a: 'Yes. Give each wallet a name so a page of addresses becomes "Shop payouts", "Client A", "Cold storage". Set the name when you create a wallet, or rename any wallet later — hover it on the Wallets page, click the pencil, edit inline and press Save. The name follows the wallet everywhere it appears.' },
          { q: 'Can I manage multiple wallets?', a: 'Yes, create as many wallets as you like on any chain. Each has its own balance and history. The Wallets page has a search box that filters by name, address or chain as you type.' },
          { q: 'What do the different balances mean?', a: '<strong>Balance</strong> is what you can withdraw now. <strong>On-chain balance</strong> is what the address actually holds, verifiable on a block explorer. <strong>Platform fee held</strong> is the difference — fees from earlier withdrawals awaiting collection, shown openly rather than hidden.' },
          { q: 'How do I delete a wallet?', a: 'On the Wallets page, open the wallet and choose delete. A wallet that still holds a balance, or has a transaction in flight, cannot be removed — withdraw first. Deletion is a soft delete, so the key is retained and the wallet is never truly destroyed.' },
        ] },
      ],
    },
    {
      id: 'payments', title: 'Accepting payments', icon: 'checkmark', group: 'Using Etheroute',
      blocks: [
        { type: 'faq', items: [
          { q: 'How do I take a payment from a customer?', a: 'Create a checkout link on the dashboard\'s Checkout page (or with <code>POST /api/checkout/create</code>): pick the receiving wallet and an amount in USD or the coin, then send the customer the link. The hosted page shows the amount, a QR code, and — on EVM chains — a one-click "Connect wallet" button.' },
          { q: 'Do my customers need an Etheroute account?', a: 'No. A checkout link works for anyone with a wallet, by scanning the QR code, pasting their address, or connecting a browser wallet such as MetaMask.' },
          { q: 'What is "wallet pay" versus paying manually?', a: 'On every EVM chain a customer can connect a browser wallet and pay in one click — the page switches them to the right network and sends the exact amount, and the payment is verified instantly. Paying manually means sending from any wallet and pasting the sending address so we can match the payment on-chain.' },
          { q: 'Does BNB Chain support checkout?', a: 'Yes, both ways. A payment sent by hand is found by reading the chain\'s own blocks over RPC from the moment the customer gives their address (BNB has no free public transaction index, so it is read directly), and wallet-pay reports its own transaction, as it does on every EVM chain. The one thing BNB lacks is a history on the transactions tab.' },
          { q: 'How do I know when a payment settles?', a: 'Watch the session on the dashboard, or give the checkout link a <code>webhookUrl</code> and receive a signed update the moment it settles, underpays or expires — even if the customer closed the tab. Verify the redirect token or the webhook signature before releasing goods.' },
        ] },
      ],
    },
    {
      id: 'withdrawals', title: 'Withdrawals & transactions', icon: 'transactionsIcon', group: 'Using Etheroute',
      blocks: [
        { type: 'faq', items: [
          { q: 'What is the minimum withdrawal amount?', a: 'The minimum is $5 USD equivalent per transaction, per network. Each chain is counted independently.' },
          { q: 'How long do withdrawals take?', a: 'A direct transfer confirms in the payout chain\'s normal block time — seconds on an L2 or Solana, up to an hour on Bitcoin. A swap into another chain adds the swap provider\'s processing time on top. A payout sitting in "processing" while a Bitcoin transfer confirms is normal, not a failure.' },
          { q: 'What is the difference between a direct transfer and a swap?', a: 'If a holding is already the payout asset on the payout chain, it is a plain on-chain send — no swap, no spread. A holding on the payout chain but in another asset there (USDC when you asked for ETH) is swapped on the chain itself, through a router contract your wallet calls directly, and the router pays your address. Anything on another chain crosses through THORChain where it serves both ends - your wallet pays the network\'s vault with a memo and the network pays you, no custodian - or through a fixed-rate swap otherwise; both are quoted and the one that pays more wins, and the review says which. Cashing out in an asset you already hold is cheapest.' },
          { q: 'Does a cross-chain withdrawal go through a custodian?', a: 'Not when THORChain serves both ends. Ethereum, Base, BNB Chain, Avalanche, Bitcoin, Litecoin, Solana, Bitcoin Cash, Dogecoin and XRP Ledger and the USDC and USDT on the EVM ones travel through THORChain: a decentralised network of vaults that swaps native coins with nothing wrapped and no account. Your wallet pays the vault with a memo naming what you want and where; the memo carries a floor, so a swap that moves too far is refunded rather than settled short. Other pairs go through a fixed-rate swap provider, which holds the funds only while the shift runs.' },
          { q: 'Can I withdraw USDC or USDT?', a: 'Yes. A dollar token is swept like the coin: paid out as itself to an address on its chain, swapped on its chain for the coin, or converted across chains where the swap provider takes it. You can also ask to be paid in USDC or USDT on a chain that carries them, and the coin you hold there is swapped on-chain into it. On-chain swaps run on 16 chains (Ethereum, Polygon, Base, Arbitrum One, Optimism, BNB Chain, Avalanche, Linea, Gnosis, Sonic, Berachain, Monad, HyperEVM, Ronin, Unichain and Plasma); elsewhere a token is paid out as itself. Gas is always the chain\'s coin, so a wallet holding USDC but no ETH needs a few cents of ETH before the USDC can move; the review says so.' },
          { q: 'What happens if a transaction fails?', a: 'If a swap cannot complete, the funds are refunded to the source wallet and the transfer is marked failed with the reason recorded. Funds are never lost, and you can run the withdrawal again.' },
          { q: 'Can I cancel a withdrawal?', a: 'No. Once broadcast, an on-chain transfer is irreversible — check the recipient address and amount on the review screen first. Only one withdrawal runs per account at a time; start another and it waits.' },
          { q: 'Where do I see my history?', a: 'The Transactions section of your dashboard lists every payout and transfer with its status, amount, chain and timestamp. The same records are available through the API.' },
        ] },
      ],
    },
    {
      id: 'account', title: 'Security & account', icon: 'security', group: 'Using Etheroute',
      blocks: [
        { type: 'faq', items: [
          { q: 'Is my account secure?', a: 'Passwords are hashed with scrypt and never stored in plain text, and wallet keys are encrypted at rest. Use a unique, long passphrase, and treat your API key like a password.' },
          { q: 'Can I delete my account?', a: 'Yes, you can request account deletion. Associated data is securely removed from our systems, and the action is permanent.' },
          { q: 'What if I lose my API key?', a: 'The key is shown only once, at generation. If you lose it or it leaks, generate a new one from the dashboard\'s API section — the old key stops working immediately.' },
        ] },
      ],
    },
    {
      id: 'developers', title: 'API & developers', icon: 'apiKeys', group: 'Developers',
      blocks: [
        { type: 'faq', items: [
          { q: 'How do I get an API key?', a: 'Sign in, open the API section of your dashboard and generate a key. It is displayed once — store it in a secrets manager. Send it as <code>Authorization: Bearer ethr_…</code> on every request.' },
          { q: 'Where is the API documentation?', a: 'The full <a href="/api-reference">API Reference</a> covers every endpoint with copy-paste examples in cURL, Node.js, Python, Go, Ruby, C++ and C, plus authentication, webhooks and error handling.' },
          { q: 'Are there rate limits?', a: 'Yes — 300 requests per minute per account by default, and 5 withdrawals per minute. Responses carry <code>RateLimit-*</code> headers, and a 429 tells you when to retry.' },
          { q: 'How do I revoke or delete an API key?', a: 'Revoke a key from the API section of your dashboard. It stops working immediately; generate a new one when you are ready.' },
        ] },
        { type: 'callout', tone: 'info', title: 'Building an integration?', body: 'Start with the <a href="/docs">documentation</a> for the concepts, then the <a href="/api-reference">API Reference</a> for the endpoints. Build against <code>GET /api/chains</code> rather than hardcoding the chain list.' },
      ],
    },
    {
      id: 'support', title: 'Get in touch', icon: 'support', group: 'Support',
      blocks: [
        { type: 'p', html: 'Need more help? Our support team is available through the channels below. For anything security-related, reach out right away so we can prioritise it.' },
        { type: 'channels', items: [
          { label: 'Discord Community', href: 'https://discord.gg/etheroute', external: true,
            svg: '<path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.607 1.25a18.27 18.27 0 0 0-5.487 0c-.162-.385-.395-.875-.607-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.294.075.075 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.075.075 0 0 1 .079.009c.12.098.246.198.373.295a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.076.076 0 0 0-.041.107c.352.699.764 1.365 1.225 1.994a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-4.786-.838-8.95-3.549-12.617a.06.06 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-.965-2.157-2.156 0-1.193.948-2.157 2.157-2.157 1.211 0 2.176.964 2.157 2.157 0 1.19-.946 2.156-2.157 2.156zm7.975 0c-1.183 0-2.157-.965-2.157-2.156 0-1.193.948-2.157 2.157-2.157 1.211 0 2.176.964 2.157 2.157 0 1.19-.946 2.156-2.157 2.156z"/>' },
          { label: 'Telegram Support', href: 'https://t.me/etheroute', external: true,
            svg: '<path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.869 4.332-2.96-.924c-.644-.203-.658-.644.136-.954l11.566-4.461c.542-.203 1.013.131.832.941z"/>' },
          { label: 'Email Support', href: 'mailto:support@etheroute.io', external: false,
            svg: '<rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" fill="none" stroke="currentColor" stroke-width="2"/>' },
        ] },
        { type: 'faq', items: [
          { q: 'How do I report a bug or a security issue?', a: 'Report bugs through any of our support channels. For security-related concerns, contact us immediately via Discord, Telegram or email so your report is handled with priority.' },
          { q: 'How can I suggest a feature?', a: 'We love hearing from users. Share feature ideas with the team through Discord, Telegram or email — your feedback shapes what we build next.' },
        ] },
      ],
    },
  ],
};
