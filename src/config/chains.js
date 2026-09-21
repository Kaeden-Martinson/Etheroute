/**
 * Chain registry - the one place a chain is described.
 *
 * Before this, adding a chain meant editing twelve files: validators, the gas
 * estimator, status lookups, the SideShift asset map, checkout URIs, config,
 * and three front-end scripts, each with its own switch statement. Now every
 * one of those reads from here, and a new chain is one entry plus - for a new
 * signing family - one wallet service.
 *
 * Four families exist:
 *   evm    - Ethereum and anything that speaks its JSON-RPC (secp256k1,
 *            EIP-1559 or legacy gas). One wallet service, parameterised.
 *   utxo   - Bitcoin-likes: Bitcoin and Litecoin with a mempool.space-style
 *            explorer, Bitcoin Cash and Dogecoin with their own.
 *   solana - on its own.
 *   xrp    - the XRP Ledger: accounts, sequences, a reserve.
 *
 * `code` is what the API speaks (`payoutChain`, `wallet.chain`). `symbol` is
 * the ticker shown next to amounts - the two differ on L2s, where the code is
 * the network and the coin is still ETH.
 */

const CHAINS = {
  ETH: {
    code: 'ETH',
    name: 'Ethereum',
    symbol: 'ETH',
    family: 'evm',
    chainId: 1,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'ETH_RPC_URLS',
    rpc: [
      'https://eth-pokt.nodies.app',
      'https://eth.rpc.blxrbdn.com',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://eth-mainnet.public.blastapi.io',
    ],
    // Sources for an address's transaction list, tried in order.
    history: [{ kind: 'etherscan', chainId: 1 }],
    explorer: { tx: 'https://etherscan.io/tx/', address: 'https://etherscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 12,
    sideshift: { coin: 'eth', network: 'ethereum' },
    thorchain: 'ETH',
    directGasUsd: 0.15,
    fallbackGasNative: 0.0008,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'ethereum', paraswap: true },
    tokens: {
      USDC: { contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      USDT: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    },
  },

  POL: {
    code: 'POL',
    name: 'Polygon',
    symbol: 'POL',
    family: 'evm',
    chainId: 137,
    decimals: 18,
    coingeckoId: 'polygon-ecosystem-token',
    rpcEnv: 'POL_RPC_URLS',
    rpc: [
      'https://1rpc.io/matic',
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
    ],
    history: [
      { kind: 'etherscan', chainId: 137 },
      { kind: 'blockscout', url: 'https://polygon.blockscout.com/api' },
    ],
    explorer: { tx: 'https://polygonscan.com/tx/', address: 'https://polygonscan.com/address/' },
    // Polygon reorgs a few blocks deep now and then; wait for more of them.
    confirmations: 20,
    blockTimeSec: 2,
    sideshift: { coin: 'pol', network: 'polygon' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.01,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'polygon', paraswap: true },
    tokens: {
      USDC: { contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      // Tether's Polygon issue moved to USDT0 in 2025; same contract, new name.
      USDT: { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },

  BASE: {
    code: 'BASE',
    name: 'Base',
    symbol: 'ETH',
    family: 'evm',
    chainId: 8453,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'BASE_RPC_URLS',
    rpc: ['https://mainnet.base.org', 'https://1rpc.io/base', 'https://base-rpc.publicnode.com'],
    history: [{ kind: 'blockscout', url: 'https://base.blockscout.com/api' }],
    explorer: { tx: 'https://basescan.org/tx/', address: 'https://basescan.org/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    sideshift: { coin: 'eth', network: 'base' },
    thorchain: 'BASE',
    directGasUsd: 0.01,
    fallbackGasNative: 0.00002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'base', paraswap: true },
    tokens: {
      USDC: { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      USDT: { contract: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    },
  },

  ARB: {
    code: 'ARB',
    name: 'Arbitrum One',
    symbol: 'ETH',
    family: 'evm',
    chainId: 42161,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'ARB_RPC_URLS',
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb', 'https://arbitrum-one-rpc.publicnode.com'],
    history: [{ kind: 'etherscan', chainId: 42161 }],
    explorer: { tx: 'https://arbiscan.io/tx/', address: 'https://arbiscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 0.25,
    sideshift: { coin: 'eth', network: 'arbitrum' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.00002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'arbitrum', paraswap: true },
    tokens: {
      USDC: { contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      // Tether's native issue here (USDT0); the contract calls itself USD₮0.
      USDT: { contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },

  OP: {
    code: 'OP',
    name: 'Optimism',
    symbol: 'ETH',
    family: 'evm',
    chainId: 10,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'OP_RPC_URLS',
    rpc: ['https://mainnet.optimism.io', 'https://1rpc.io/op', 'https://optimism-rpc.publicnode.com'],
    history: [{ kind: 'blockscout', url: 'https://explorer.optimism.io/api' }],
    explorer: { tx: 'https://optimistic.etherscan.io/tx/', address: 'https://optimistic.etherscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    sideshift: { coin: 'eth', network: 'optimism' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.00002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'optimism', paraswap: true },
    tokens: {
      USDC: { contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      USDT: { contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    },
  },

  BNB: {
    code: 'BNB',
    name: 'BNB Chain',
    symbol: 'BNB',
    family: 'evm',
    chainId: 56,
    decimals: 18,
    coingeckoId: 'binancecoin',
    rpcEnv: 'BNB_RPC_URLS',
    rpc: ['https://bsc-dataseed.bnbchain.org', 'https://1rpc.io/bnb', 'https://bsc-rpc.publicnode.com'],
    // No free indexer answers for BSC (Etherscan gates it, Routescan and
    // Blockscout do not cover it), so the transactions tab has no history to
    // show. Checkout does not need one: with the block time this short, a
    // manual payment is attributed by reading the blocks since the buyer
    // gave their address straight off the RPC (checkout.js, the RPC scan).
    history: [],
    explorer: { tx: 'https://bscscan.com/tx/', address: 'https://bscscan.com/address/' },
    confirmations: 3,
    // Sub-second since the 2025 Maxwell fork; scripts/verify-chains.js measures it.
    blockTimeSec: 0.5,
    sideshift: { coin: 'bnb', network: 'bsc' },
    thorchain: 'BSC',
    directGasUsd: 0.02,
    fallbackGasNative: 0.0001,
    minReserveNative: 0,
    walletPay: true,
    // Both are 18-decimal on BNB Chain, not the 6 every other chain uses:
    // the one place a copied entry would be off by a trillion.
    dex: { kyber: 'bsc', paraswap: true },
    tokens: {
      USDC: { contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      USDT: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    },
  },

  AVAX: {
    code: 'AVAX',
    name: 'Avalanche',
    symbol: 'AVAX',
    family: 'evm',
    chainId: 43114,
    decimals: 18,
    coingeckoId: 'avalanche-2',
    rpcEnv: 'AVAX_RPC_URLS',
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://1rpc.io/avax/c', 'https://avalanche-c-chain-rpc.publicnode.com'],
    history: [{ kind: 'blockscout', url: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api' }],
    explorer: { tx: 'https://snowtrace.io/tx/', address: 'https://snowtrace.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    sideshift: { coin: 'avax', network: 'avax' },
    thorchain: 'AVAX',
    directGasUsd: 0.02,
    fallbackGasNative: 0.001,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'avalanche', paraswap: true },
    tokens: {
      USDC: { contract: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
      // Tether's native issue on Avalanche; the contract calls itself USDt.
      USDT: { contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, onChainSymbol: 'USDt' },
    },
  },

  BTC: {
    code: 'BTC',
    name: 'Bitcoin',
    symbol: 'BTC',
    family: 'utxo',
    decimals: 8,
    coingeckoId: 'bitcoin',
    explorer: { tx: 'https://mempool.space/tx/', address: 'https://mempool.space/address/' },
    explorerApi: 'https://mempool.space/api',
    confirmations: 1,
    blockTimeSec: 600,
    sideshift: { coin: 'btc', network: 'bitcoin' },
    thorchain: 'BTC',
    directGasUsd: 0.50,
    fallbackGasNative: 0.00005,
    minReserveNative: 0,
    walletPay: false,
  },

  LTC: {
    code: 'LTC',
    name: 'Litecoin',
    symbol: 'LTC',
    family: 'utxo',
    decimals: 8,
    coingeckoId: 'litecoin',
    explorer: { tx: 'https://litecoinspace.org/tx/', address: 'https://litecoinspace.org/address/' },
    explorerApi: 'https://litecoinspace.org/api',
    confirmations: 2,
    blockTimeSec: 150,
    sideshift: { coin: 'ltc', network: 'litecoin' },
    thorchain: 'LTC',
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: false,
  },

  SOL: {
    code: 'SOL',
    name: 'Solana',
    symbol: 'SOL',
    family: 'solana',
    decimals: 9,
    coingeckoId: 'solana',
    explorer: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
    confirmations: 1,
    blockTimeSec: 0.4,
    sideshift: { coin: 'sol', network: 'solana' },
    thorchain: 'SOL',
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    // Rent-exempt minimum for a bare account, plus a fee's worth of headroom.
    minReserveNative: 0.00089088 + 0.00001,
    walletPay: false,
  },

  // Bitcoin Cash and Dogecoin are Bitcoin's transaction format without
  // segwit, each with its own addresses, digest and fee floor; one wallet
  // service handles both (LegacyUtxoWalletService). Neither has a
  // mempool.space-style explorer: the service names its own, and reads the
  // tip and a transaction's status itself. Both cross chains through
  // THORChain and SideShift.
  BCH: {
    code: 'BCH',
    name: 'Bitcoin Cash',
    symbol: 'BCH',
    family: 'utxo',
    decimals: 8,
    coingeckoId: 'bitcoin-cash',
    explorer: { tx: 'https://blockchair.com/bitcoin-cash/transaction/', address: 'https://blockchair.com/bitcoin-cash/address/' },
    explorerApi: 'https://api.haskoin.com/bch',
    explorerKind: 'haskoin',
    confirmations: 1,
    blockTimeSec: 600,
    sideshift: { coin: 'bch', network: 'bitcoincash' },
    thorchain: 'BCH',
    directGasUsd: 0.01,
    fallbackGasNative: 0.000005,
    minReserveNative: 0,
    walletPay: false,
  },

  DOGE: {
    code: 'DOGE',
    name: 'Dogecoin',
    symbol: 'DOGE',
    family: 'utxo',
    decimals: 8,
    coingeckoId: 'dogecoin',
    explorer: { tx: 'https://blockchair.com/dogecoin/transaction/', address: 'https://blockchair.com/dogecoin/address/' },
    explorerApi: 'https://api.blockcypher.com/v1/doge/main',
    explorerKind: 'blockcypher',
    confirmations: 2,
    blockTimeSec: 60,
    sideshift: { coin: 'doge', network: 'doge' },
    thorchain: 'DOGE',
    directGasUsd: 0.01,
    fallbackGasNative: 0.05,
    minReserveNative: 0,
    walletPay: false,
  },

  // The XRP Ledger: its own family. A payment is final in the next
  // validated ledger (a few seconds); an account must keep a reserve (one
  // XRP, read live), which the sweep leaves behind. Crosses chains through
  // THORChain and SideShift (which needs a destination tag on deposits).
  XRP: {
    code: 'XRP',
    name: 'XRP Ledger',
    symbol: 'XRP',
    family: 'xrp',
    decimals: 6,
    coingeckoId: 'ripple',
    explorer: { tx: 'https://xrpscan.com/tx/', address: 'https://xrpscan.com/account/' },
    confirmations: 1,
    blockTimeSec: 4,
    sideshift: { coin: 'xrp', network: 'ripple' },
    thorchain: 'XRP',
    directGasUsd: 0.001,
    fallbackGasNative: 0.000012,
    // The account reserve: what a sweep must leave behind.
    minReserveNative: 1,
    walletPay: false,
  },

  LINEA: {
    code: 'LINEA',
    name: 'Linea',
    symbol: 'ETH',
    family: 'evm',
    chainId: 59144,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'LINEA_RPC_URLS',
    rpc: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com', 'https://1rpc.io/linea'],
    history: [{ kind: 'etherscan', chainId: 59144 }],
    explorer: { tx: 'https://lineascan.build/tx/', address: 'https://lineascan.build/address/' },
    confirmations: 3,
    blockTimeSec: 6,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'linea' },
    tokens: {
      USDC: { contract: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6 },
      USDT: { contract: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', decimals: 6 },
    },
  },
  SCROLL: {
    code: 'SCROLL',
    name: 'Scroll',
    symbol: 'ETH',
    family: 'evm',
    chainId: 534352,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'SCROLL_RPC_URLS',
    rpc: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com', 'https://1rpc.io/scroll'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://scrollscan.com/tx/', address: 'https://scrollscan.com/address/' },
    confirmations: 3,
    // Blocks come on demand, three seconds apart when busy and ten when quiet.
    blockTimeSec: 5,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', decimals: 6 },
      USDT: { contract: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', decimals: 6 },
    },
  },
  ZKSYNC: {
    code: 'ZKSYNC',
    name: 'ZKsync Era',
    symbol: 'ETH',
    family: 'evm',
    chainId: 324,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'ZKSYNC_RPC_URLS',
    rpc: ['https://mainnet.era.zksync.io', 'https://zksync-era.blockpi.network/v1/rpc/public', 'https://1rpc.io/zksync2-era'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.zksync.io/tx/', address: 'https://explorer.zksync.io/address/' },
    confirmations: 3,
    blockTimeSec: 3,
    sideshift: { coin: 'eth', network: 'zksyncera' },
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    // A ZKsync-stack chain meters a plain transfer in the hundreds of
    // thousands of gas units; sends estimate live, this is the floor.
    transferGasLimit: 400000,
    tokens: {
      USDC: { contract: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', decimals: 6 },
      USDT: { contract: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', decimals: 6 },
    },
  },
  GNOSIS: {
    code: 'GNOSIS',
    name: 'Gnosis',
    symbol: 'XDAI',
    family: 'evm',
    chainId: 100,
    decimals: 18,
    coingeckoId: 'xdai',
    rpcEnv: 'GNOSIS_RPC_URLS',
    rpc: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://1rpc.io/gnosis'],
    history: [{ kind: 'etherscan', chainId: 100 }],
    explorer: { tx: 'https://gnosisscan.io/tx/', address: 'https://gnosisscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 5,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { paraswap: true },
    tokens: {
      USDC: { contract: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', decimals: 6 },
    },
  },
  CELO: {
    code: 'CELO',
    name: 'Celo',
    symbol: 'CELO',
    family: 'evm',
    chainId: 42220,
    decimals: 18,
    coingeckoId: 'celo',
    rpcEnv: 'CELO_RPC_URLS',
    rpc: ['https://forno.celo.org', 'https://celo-rpc.publicnode.com', 'https://1rpc.io/celo'],
    history: [{ kind: 'etherscan', chainId: 42220 }],
    explorer: { tx: 'https://celoscan.io/tx/', address: 'https://celoscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
      USDT: { contract: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, onChainSymbol: 'USD₮' },
    },
  },
  CRO: {
    code: 'CRO',
    name: 'Cronos',
    symbol: 'CRO',
    family: 'evm',
    chainId: 25,
    decimals: 18,
    coingeckoId: 'crypto-com-chain',
    rpcEnv: 'CRO_RPC_URLS',
    rpc: ['https://evm.cronos.org', 'https://cronos-evm-rpc.publicnode.com', 'https://1rpc.io/cro'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://cronoscan.com/tx/', address: 'https://cronoscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 0.5,
    sideshift: { coin: 'cro', network: 'cronos' },
    directGasUsd: 0.05,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59', decimals: 6 },
      USDT: { contract: '0x66e428c3f67a68878562e79A0234c1F83c208770', decimals: 6 },
    },
  },
  OPBNB: {
    code: 'OPBNB',
    name: 'opBNB',
    symbol: 'BNB',
    family: 'evm',
    chainId: 204,
    decimals: 18,
    coingeckoId: 'binancecoin',
    rpcEnv: 'OPBNB_RPC_URLS',
    rpc: ['https://opbnb-mainnet-rpc.bnbchain.org', 'https://opbnb-rpc.publicnode.com', 'https://1rpc.io/opbnb'],
    history: [{ kind: 'etherscan', chainId: 204 }],
    explorer: { tx: 'https://opbnbscan.com/tx/', address: 'https://opbnbscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 0.3,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDT: { contract: '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3', decimals: 18 },
    },
  },
  SONIC: {
    code: 'SONIC',
    name: 'Sonic',
    symbol: 'S',
    family: 'evm',
    chainId: 146,
    decimals: 18,
    coingeckoId: 'sonic-3',
    rpcEnv: 'SONIC_RPC_URLS',
    rpc: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com', 'https://sonic.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 146 }],
    explorer: { tx: 'https://sonicscan.org/tx/', address: 'https://sonicscan.org/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    sideshift: { coin: 's', network: 'sonic' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    // ParaSwap lists Sonic but its Sonic pricing answers 503; Kyber alone.
    dex: { kyber: 'sonic' },
    tokens: {
      USDC: { contract: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', decimals: 6 },
      USDT: { contract: '0x6047828dc181963ba44974801FF68e538dA5eaF9', decimals: 6 },
    },
  },
  SEI: {
    code: 'SEI',
    name: 'Sei',
    symbol: 'SEI',
    family: 'evm',
    chainId: 1329,
    decimals: 18,
    coingeckoId: 'sei-network',
    rpcEnv: 'SEI_RPC_URLS',
    rpc: ['https://evm-rpc.sei-apis.com', 'https://sei-evm-rpc.publicnode.com', 'https://sei.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 1329 }],
    explorer: { tx: 'https://seitrace.com/tx/', address: 'https://seitrace.com/address/' },
    confirmations: 3,
    blockTimeSec: 0.4,
    sideshift: { coin: 'sei', network: 'seievm' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6 },
      USDT: { contract: '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1', decimals: 6 },
    },
  },
  BERA: {
    code: 'BERA',
    name: 'Berachain',
    symbol: 'BERA',
    family: 'evm',
    chainId: 80094,
    decimals: 18,
    coingeckoId: 'berachain-bera',
    rpcEnv: 'BERA_RPC_URLS',
    rpc: ['https://rpc.berachain.com', 'https://berachain-rpc.publicnode.com', 'https://berachain.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 80094 }],
    explorer: { tx: 'https://berascan.com/tx/', address: 'https://berascan.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    sideshift: { coin: 'bera', network: 'berachain' },
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'berachain' },
    tokens: {
      USDT: { contract: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },
  MON: {
    code: 'MON',
    name: 'Monad',
    symbol: 'MON',
    family: 'evm',
    chainId: 143,
    decimals: 18,
    coingeckoId: 'monad',
    rpcEnv: 'MON_RPC_URLS',
    rpc: ['https://rpc.monad.xyz', 'https://monad-rpc.publicnode.com', 'https://rpc1.monad.xyz'],
    history: [{ kind: 'etherscan', chainId: 143 }],
    explorer: { tx: 'https://monadscan.com/tx/', address: 'https://monadscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 0.4,
    sideshift: { coin: 'mon', network: 'monad' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'monad' },
    tokens: {
      USDT: { contract: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },
  HYPE: {
    code: 'HYPE',
    name: 'HyperEVM',
    symbol: 'HYPE',
    family: 'evm',
    chainId: 999,
    decimals: 18,
    coingeckoId: 'hyperliquid',
    rpcEnv: 'HYPE_RPC_URLS',
    rpc: ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid-json-rpc.stakely.io', 'https://hyperliquid.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 999 }],
    explorer: { tx: 'https://hyperevmscan.io/tx/', address: 'https://hyperevmscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    sideshift: { coin: 'hype', network: 'hyperevm' },
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'hyperevm' },
    tokens: {
      USDT: { contract: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },
  CORE: {
    code: 'CORE',
    name: 'Core',
    symbol: 'CORE',
    family: 'evm',
    chainId: 1116,
    decimals: 18,
    coingeckoId: 'coredaoorg',
    rpcEnv: 'CORE_RPC_URLS',
    rpc: ['https://rpc.coredao.org', 'https://core.public.infstones.com', 'https://1rpc.io/core'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://scan.coredao.org/tx/', address: 'https://scan.coredao.org/address/' },
    confirmations: 3,
    blockTimeSec: 3,
    sideshift: { coin: 'core', network: 'core' },
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDT: { contract: '0x900101d06A7426441Ae63e9AB3B9b0F63Be145F1', decimals: 6 },
    },
  },
  KAIA: {
    code: 'KAIA',
    name: 'Kaia',
    symbol: 'KAIA',
    family: 'evm',
    chainId: 8217,
    decimals: 18,
    coingeckoId: 'kaia',
    rpcEnv: 'KAIA_RPC_URLS',
    rpc: ['https://public-en.node.kaia.io', 'https://kaia.blockpi.network/v1/rpc/public', 'https://rpc.ankr.com/kaia'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://kaiascan.io/tx/', address: 'https://kaiascan.io/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDT: { contract: '0xd077A400968890Eacc75cdc901F0356c943e4fDb', decimals: 6, onChainSymbol: 'USD₮' },
      USDC: { contract: '0xE2053BCf56D2030d2470Fb454574237cF9ee3D4B', decimals: 6, onChainSymbol: 'USDC.e' },
    },
  },
  RON: {
    code: 'RON',
    name: 'Ronin',
    symbol: 'RON',
    family: 'evm',
    chainId: 2020,
    decimals: 18,
    coingeckoId: 'ronin',
    rpcEnv: 'RON_RPC_URLS',
    rpc: ['https://api.roninchain.com/rpc', 'https://ronin.drpc.org', 'https://ronin.lgns.net/rpc'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://app.roninchain.com/tx/', address: 'https://app.roninchain.com/address/' },
    confirmations: 3,
    blockTimeSec: 3,
    sideshift: { coin: 'ron', network: 'ronin' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'ronin' },
    tokens: {
      USDC: { contract: '0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc', decimals: 6 },
    },
  },
  WORLD: {
    code: 'WORLD',
    name: 'World Chain',
    symbol: 'ETH',
    family: 'evm',
    chainId: 480,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'WORLD_RPC_URLS',
    rpc: ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain.drpc.org', 'https://480.rpc.thirdweb.com'],
    history: [{ kind: 'etherscan', chainId: 480 }],
    explorer: { tx: 'https://worldscan.org/tx/', address: 'https://worldscan.org/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6 },
      USDT: { contract: '0x102d758f688a4C1C5a80b116bD945d4455460282', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },
  UNI: {
    code: 'UNI',
    name: 'Unichain',
    symbol: 'ETH',
    family: 'evm',
    chainId: 130,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'UNI_RPC_URLS',
    rpc: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com', 'https://unichain.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 130 }],
    explorer: { tx: 'https://uniscan.xyz/tx/', address: 'https://uniscan.xyz/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'unichain', paraswap: true },
    tokens: {
      USDC: { contract: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6 },
      USDT: { contract: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },
  INK: {
    code: 'INK',
    name: 'Ink',
    symbol: 'ETH',
    family: 'evm',
    chainId: 57073,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'INK_RPC_URLS',
    rpc: ['https://rpc-gel.inkonchain.com', 'https://ink.drpc.org', 'https://rpc-qnd.inkonchain.com'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.inkonchain.com/tx/', address: 'https://explorer.inkonchain.com/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xF1815bd50389c46847f0Bda824eC8da914045D14', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x0200C29006150606B650577BBE7B6248F58470c1', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },
  SONEIUM: {
    code: 'SONEIUM',
    name: 'Soneium',
    symbol: 'ETH',
    family: 'evm',
    chainId: 1868,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'SONEIUM_RPC_URLS',
    rpc: ['https://rpc.soneium.org', 'https://soneium.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://soneium.blockscout.com/tx/', address: 'https://soneium.blockscout.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369', decimals: 6, onChainSymbol: 'USDC.e' },
    },
  },
  TAIKO: {
    code: 'TAIKO',
    name: 'Taiko',
    symbol: 'ETH',
    family: 'evm',
    chainId: 167000,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'TAIKO_RPC_URLS',
    rpc: ['https://rpc.mainnet.taiko.xyz', 'https://taiko-rpc.publicnode.com', 'https://taiko.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 167000 }],
    explorer: { tx: 'https://taikoscan.io/tx/', address: 'https://taikoscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.02,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b', decimals: 6 },
      USDT: { contract: '0x9c2dc7377717603eB92b2655c5f2E7997a4945BD', decimals: 6 },
    },
  },
  LISK: {
    code: 'LISK',
    name: 'Lisk',
    symbol: 'ETH',
    family: 'evm',
    chainId: 1135,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'LISK_RPC_URLS',
    rpc: ['https://rpc.api.lisk.com', 'https://lisk.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://blockscout.lisk.com/tx/', address: 'https://blockscout.lisk.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    tokens: {
      USDC: { contract: '0xF242275d3a6527d877f2c927a82D9b057609cc71', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x05D032ac25d322df992303dCa074EE7392C117b9', decimals: 6 },
    },
  },
  ABS: {
    code: 'ABS',
    name: 'Abstract',
    symbol: 'ETH',
    family: 'evm',
    chainId: 2741,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'ABS_RPC_URLS',
    rpc: ['https://api.mainnet.abs.xyz', 'https://abstract.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 2741 }],
    explorer: { tx: 'https://abscan.org/tx/', address: 'https://abscan.org/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    // A ZKsync-stack chain meters a plain transfer in the hundreds of
    // thousands of gas units; sends estimate live, this is the floor.
    transferGasLimit: 400000,
    tokens: {
      USDC: { contract: '0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x0709F39376dEEe2A2dfC94A58EdEb2Eb9DF012bD', decimals: 6 },
    },
  },
  XPL: {
    code: 'XPL',
    name: 'Plasma',
    symbol: 'XPL',
    family: 'evm',
    chainId: 9745,
    decimals: 18,
    coingeckoId: 'plasma',
    rpcEnv: 'XPL_RPC_URLS',
    rpc: ['https://rpc.plasma.to', 'https://plasma.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 9745 }],
    explorer: { tx: 'https://plasmascan.to/tx/', address: 'https://plasmascan.to/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    sideshift: { coin: 'xpl', network: 'plasma' },
    directGasUsd: 0.01,
    fallbackGasNative: 0.0002,
    minReserveNative: 0,
    walletPay: true,
    dex: { kyber: 'plasma' },
    tokens: {
      USDT: { contract: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },

  MANTLE: {
    code: 'MANTLE',
    name: 'Mantle',
    symbol: 'MNT',
    family: 'evm',
    chainId: 5000,
    decimals: 18,
    coingeckoId: 'mantle',
    rpcEnv: 'MANTLE_RPC_URLS',
    rpc: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'],
    history: [{ kind: 'etherscan', chainId: 5000 }],
    explorer: { tx: 'https://mantlescan.xyz/tx/', address: 'https://mantlescan.xyz/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    sideshift: { coin: 'mnt', network: 'mantle' },
    directGasUsd: 0.001,
    fallbackGasNative: 0.00315001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', decimals: 6 },
      USDT: { contract: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },

  MODE: {
    code: 'MODE',
    name: 'Mode',
    symbol: 'ETH',
    family: 'evm',
    chainId: 34443,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'MODE_RPC_URLS',
    rpc: ['https://mainnet.mode.network', 'https://mode.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.mode.network/tx/', address: 'https://explorer.mode.network/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xd988097fb8612cc24eeC14542bC03424c656005f', decimals: 6 },
      USDT: { contract: '0xf0F161fDA2712DB8b566946122a5af183995e2eD', decimals: 6 },
    },
  },

  FRAX: {
    code: 'FRAX',
    name: 'Fraxtal',
    symbol: 'FRAX',
    family: 'evm',
    chainId: 252,
    decimals: 18,
    coingeckoId: 'frax-share',
    rpcEnv: 'FRAX_RPC_URLS',
    rpc: ['https://rpc.frax.com', 'https://fraxtal-rpc.publicnode.com'],
    history: [{ kind: 'etherscan', chainId: 252 }],
    explorer: { tx: 'https://fraxscan.com/tx/', address: 'https://fraxscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xDcc0F2D8F90FDe85b10aC1c8Ab57dc0AE946A543', decimals: 6 },
    },
  },

  IMX: {
    code: 'IMX',
    name: 'Immutable zkEVM',
    symbol: 'IMX',
    family: 'evm',
    chainId: 13371,
    decimals: 18,
    coingeckoId: 'immutable-x',
    rpcEnv: 'IMX_RPC_URLS',
    rpc: ['https://rpc.immutable.com', 'https://immutable-zkevm.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.immutable.com/tx/', address: 'https://explorer.immutable.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.000693,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x6de8aCC0D406837030CE4dd28e7c08C5a96a30d2', decimals: 6 },
    },
  },

  TELOS: {
    code: 'TELOS',
    name: 'Telos EVM',
    symbol: 'TLOS',
    family: 'evm',
    chainId: 40,
    decimals: 18,
    coingeckoId: 'telos',
    rpcEnv: 'TELOS_RPC_URLS',
    rpc: ['https://rpc.telos.net', 'https://telos.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://teloscan.io/tx/', address: 'https://teloscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 0.5,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.002,
    fallbackGasNative: 0.33102538,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xF1815bd50389c46847f0Bda824eC8da914045D14', decimals: 6, onChainSymbol: 'USDC.e' },
    },
  },

  AURORA: {
    code: 'AURORA',
    name: 'Aurora',
    symbol: 'ETH',
    family: 'evm',
    chainId: 1313161554,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'AURORA_RPC_URLS',
    rpc: ['https://mainnet.aurora.dev', 'https://aurora.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.aurora.dev/tx/', address: 'https://explorer.aurora.dev/address/' },
    confirmations: 3,
    blockTimeSec: 0.6,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.005,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xB12BFcA5A55806AaF64E99521918A4bf0fC40802', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x4988a896b1227218e4A686fdE5EabdcAbd91571f', decimals: 6, onChainSymbol: 'USDT.e' },
    },
  },

  METIS: {
    code: 'METIS',
    name: 'Metis Andromeda',
    symbol: 'METIS',
    family: 'evm',
    chainId: 1088,
    decimals: 18,
    coingeckoId: 'metis-token',
    rpcEnv: 'METIS_RPC_URLS',
    rpc: ['https://andromeda.metis.io/?owner=1088', 'https://metis.drpc.org', 'https://metis-rpc.publicnode.com', 'https://metis-andromeda.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://andromeda-explorer.metis.io/tx/', address: 'https://andromeda-explorer.metis.io/address/' },
    confirmations: 3,
    blockTimeSec: 23,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00105731,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  BOBA: {
    code: 'BOBA',
    name: 'Boba Network',
    symbol: 'ETH',
    family: 'evm',
    chainId: 288,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'BOBA_RPC_URLS',
    rpc: ['https://mainnet.boba.network', 'https://boba-ethereum.gateway.tenderly.co', 'https://boba-eth.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://bobascan.com/tx/', address: 'https://bobascan.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc', decimals: 6 },
      USDT: { contract: '0x5DE1677344D3Cb0D7D465c10b72A8f60699C062d', decimals: 6 },
    },
  },

  GRAVITY: {
    code: 'GRAVITY',
    name: 'Gravity Alpha',
    symbol: 'G',
    family: 'evm',
    chainId: 1625,
    decimals: 18,
    coingeckoId: 'g-token',
    rpcEnv: 'GRAVITY_RPC_URLS',
    rpc: ['https://rpc.gravity.xyz', 'https://gravity-alpha.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.gravity.xyz/tx/', address: 'https://explorer.gravity.xyz/address/' },
    confirmations: 3,
    blockTimeSec: 20,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.1134,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xFbDa5F676cB37624f28265A144A48B0d6e87d3b6', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0x816E810f9F787d669FB71932DeabF6c83781Cd48', decimals: 6 },
    },
  },

  CYETH: {
    code: 'CYETH',
    name: 'Cyber',
    symbol: 'ETH',
    family: 'evm',
    chainId: 7560,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'CYETH_RPC_URLS',
    rpc: ['https://cyber.alt.technology/', 'https://rpc.cyber.co/'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://cyberscan.co/tx/', address: 'https://cyberscan.co/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  SSEED: {
    code: 'SSEED',
    name: 'Superseed',
    symbol: 'ETH',
    family: 'evm',
    chainId: 5330,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'SSEED_RPC_URLS',
    rpc: ['https://mainnet.superseed.xyz', 'https://superseed.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.superseed.xyz/tx/', address: 'https://explorer.superseed.xyz/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xC316C8252B5F2176d0135Ebb0999E99296998F2e', decimals: 6 },
    },
  },

  HEMI: {
    code: 'HEMI',
    name: 'Hemi',
    symbol: 'ETH',
    family: 'evm',
    chainId: 43111,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'HEMI_RPC_URLS',
    rpc: ['https://rpc.hemi.network/rpc', 'https://hemi.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.hemi.xyz/tx/', address: 'https://explorer.hemi.xyz/address/' },
    confirmations: 3,
    blockTimeSec: 12,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0xbB0D083fb1be0A9f6157ec484b6C79E0A4e31C2e', decimals: 6 },
    },
  },

  KATANA: {
    code: 'KATANA',
    name: 'Katana',
    symbol: 'ETH',
    family: 'evm',
    chainId: 747474,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'KATANA_RPC_URLS',
    rpc: ['https://rpc.katana.network', 'https://katana.gateway.tenderly.co/', 'https://rpc.katanarpc.com/', 'https://katana.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 747474 }],
    explorer: { tx: 'https://katanascan.com/tx/', address: 'https://katanascan.com/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  APECHAIN: {
    code: 'APECHAIN',
    name: 'ApeChain',
    symbol: 'APE',
    family: 'evm',
    chainId: 33139,
    decimals: 18,
    coingeckoId: 'apecoin',
    rpcEnv: 'APECHAIN_RPC_URLS',
    rpc: ['https://rpc.apechain.com', 'https://apechain.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 33139 }],
    explorer: { tx: 'https://apescan.io/tx/', address: 'https://apescan.io/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00645757,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xF1815bd50389c46847f0Bda824eC8da914045D14', decimals: 6, onChainSymbol: 'USDC.e' },
    },
  },

  FLR: {
    code: 'FLR',
    name: 'Flare',
    symbol: 'FLR',
    family: 'evm',
    chainId: 14,
    decimals: 18,
    coingeckoId: 'flare-networks',
    rpcEnv: 'FLR_RPC_URLS',
    rpc: ['https://flare-api.flare.network/ext/C/rpc', 'https://flare.rpc.thirdweb.com', 'https://rpc.ankr.com/flare', 'https://rpc.au.cc/flare'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://flare-explorer.flare.network/tx/', address: 'https://flare-explorer.flare.network/address/' },
    confirmations: 3,
    blockTimeSec: 1,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.04095,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xFbDa5F676cB37624f28265A144A48B0d6e87d3b6', decimals: 6, onChainSymbol: 'USDC.e' },
      USDT: { contract: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, onChainSymbol: 'USD₮0' },
    },
  },

  PLS: {
    code: 'PLS',
    name: 'PulseChain',
    symbol: 'PLS',
    family: 'evm',
    chainId: 369,
    decimals: 18,
    coingeckoId: 'pulsechain',
    rpcEnv: 'PLS_RPC_URLS',
    rpc: ['https://rpc.pulsechain.com', 'https://pulsechain-rpc.publicnode.com', 'https://rpc-pulsechain.g4mm4.io'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://ipfs.scan.pulsechain.com/tx/', address: 'https://ipfs.scan.pulsechain.com/address/' },
    confirmations: 3,
    blockTimeSec: 10,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 130.41879304,
    minReserveNative: 0,
    walletPay: true,
    // A plain transfer is metered well above 21000 units here; sends
    // estimate live, this is the floor.
    transferGasLimit: 125000,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  BTR: {
    code: 'BTR',
    name: 'Bitlayer',
    symbol: 'BTC',
    family: 'evm',
    chainId: 200901,
    decimals: 18,
    coingeckoId: 'bitcoin',
    rpcEnv: 'BTR_RPC_URLS',
    rpc: ['https://rpc.bitlayer.org', 'https://bitlayer.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://www.btrscan.com/tx/', address: 'https://www.btrscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 3,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.042,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  MERLIN: {
    code: 'MERLIN',
    name: 'Merlin',
    symbol: 'BTC',
    family: 'evm',
    chainId: 4200,
    decimals: 18,
    coingeckoId: 'bitcoin',
    rpcEnv: 'MERLIN_RPC_URLS',
    rpc: ['https://rpc.merlinchain.io', 'https://merlin-mainnet.drpc.org', 'https://merlin.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://scan.merlinchain.io/tx/', address: 'https://scan.merlinchain.io/address/' },
    confirmations: 3,
    blockTimeSec: 4,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.01,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  KAVA: {
    code: 'KAVA',
    name: 'Kava',
    symbol: 'KAVA',
    family: 'evm',
    chainId: 2222,
    decimals: 18,
    coingeckoId: 'kava',
    rpcEnv: 'KAVA_RPC_URLS',
    rpc: ['https://evm.kava.io', 'https://kava-evm-rpc.publicnode.com', 'https://evm.kava-rpc.com', 'https://rpc.ankr.com/kava_evm'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://kavascan.com/tx/', address: 'https://kavascan.com/address/' },
    confirmations: 3,
    blockTimeSec: 6,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.000063,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDT: { contract: '0x919C1c267BC06a7039e03fcc2eF738525769109c', decimals: 6, onChainSymbol: 'USDt' },
    },
  },

  NOVA: {
    code: 'NOVA',
    name: 'Arbitrum Nova',
    symbol: 'ETH',
    family: 'evm',
    chainId: 42170,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'NOVA_RPC_URLS',
    rpc: ['https://nova.arbitrum.io/rpc', 'https://arbitrum-nova-rpc.publicnode.com', 'https://arbitrum-nova.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://nova-explorer.arbitrum.io/tx/', address: 'https://nova-explorer.arbitrum.io/address/' },
    confirmations: 3,
    blockTimeSec: 73,
    // SideShift's "arbitrum" is Arbitrum One, not Nova: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.013,
    fallbackGasNative: 0.00001504,
    minReserveNative: 0,
    walletPay: true,
    // A plain transfer is metered well above 21000 units here; sends
    // estimate live, this is the floor.
    transferGasLimit: 377000,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x750ba8b76187092B0D1E87E28daaf484d1b5273b', decimals: 6 },
    },
  },

  ZETA: {
    code: 'ZETA',
    name: 'ZetaChain',
    symbol: 'ZETA',
    family: 'evm',
    chainId: 7000,
    decimals: 18,
    coingeckoId: 'zetachain',
    rpcEnv: 'ZETA_RPC_URLS',
    rpc: ['https://zetachain-evm.blockpi.network/v1/rpc/public', 'https://zetachain-mainnet.g.allthatnode.com/archive/evm', 'https://zeta-chain.drpc.org', 'https://7000.rpc.thirdweb.com'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://zetascan.com/tx/', address: 'https://zetascan.com/address/' },
    confirmations: 3,
    blockTimeSec: 4,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.0006363,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  HEDERA: {
    code: 'HEDERA',
    name: 'Hedera',
    symbol: 'HBAR',
    family: 'evm',
    chainId: 295,
    decimals: 18,
    coingeckoId: 'hedera-hashgraph',
    rpcEnv: 'HEDERA_RPC_URLS',
    rpc: ['https://mainnet.hashio.io/api', 'https://hedera.linkpool.pro'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.arkhia.io/tx/', address: 'https://explorer.arkhia.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift settles HBAR to a Hedera account id, not an EVM address; direct only.
    sideshift: null,
    directGasUsd: 0.002,
    fallbackGasNative: 0.06574464,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDT: { contract: '0x00000000000000000000000000000000009Ce723', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },

  FUSE: {
    code: 'FUSE',
    name: 'Fuse',
    symbol: 'FUSE',
    family: 'evm',
    chainId: 122,
    decimals: 18,
    coingeckoId: 'fuse-network-token',
    rpcEnv: 'FUSE_RPC_URLS',
    rpc: ['https://rpc.fuse.io', 'https://fuse.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.fuse.io/tx/', address: 'https://explorer.fuse.io/address/' },
    confirmations: 3,
    blockTimeSec: 5,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00112058,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x620fd5fa44BE6af63715Ef4E65DDFA0387aD13F5', decimals: 6 },
      USDT: { contract: '0x68c9736781E9316ebf5c3d49FE0C1f45D2D104Cd', decimals: 6 },
    },
  },

  PLUME: {
    code: 'PLUME',
    name: 'Plume',
    symbol: 'PLUME',
    family: 'evm',
    chainId: 98866,
    decimals: 18,
    coingeckoId: 'plume',
    rpcEnv: 'PLUME_RPC_URLS',
    rpc: ['https://rpc.plume.org', 'https://plume-mainnet.drpc.org', 'https://plume.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.plume.org/tx/', address: 'https://explorer.plume.org/address/' },
    confirmations: 3,
    blockTimeSec: 0.4,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.063,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0x222365EF19F7947e5484218551B56bb3965Aa7aF', decimals: 6 },
      USDT: { contract: '0xda6087E69C51E7D31b6DBAD276a3c44703DFdCAd', decimals: 6 },
    },
  },

  MORPH: {
    code: 'MORPH',
    name: 'Morph',
    symbol: 'ETH',
    family: 'evm',
    chainId: 2818,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'MORPH_RPC_URLS',
    rpc: ['https://rpc.morphl2.io', 'https://rpc-quicknode.morphl2.io', 'https://morph.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.morphl2.io/tx/', address: 'https://explorer.morphl2.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B', decimals: 6 },
      USDT: { contract: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6, onChainSymbol: 'USDT0' },
    },
  },

  ZKCRO: {
    code: 'ZKCRO',
    name: 'Cronos zkEVM',
    symbol: 'ZKCRO',
    family: 'evm',
    chainId: 388,
    decimals: 18,
    coingeckoId: 'cronos-zkevm-cro',
    rpcEnv: 'ZKCRO_RPC_URLS',
    rpc: ['https://mainnet.zkevm.cronos.org', 'https://cronos-zkevm.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.zkevm.cronos.org/tx/', address: 'https://explorer.zkevm.cronos.org/address/' },
    confirmations: 3,
    blockTimeSec: 140,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.002,
    fallbackGasNative: 0.07875,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
    tokens: {
      USDC: { contract: '0xaa5b845F8C9c047779bEDf64829601d8B264076c', decimals: 6 },
    },
  },

  BLAST: {
    code: 'BLAST',
    name: 'Blast',
    symbol: 'ETH',
    family: 'evm',
    chainId: 81457,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'BLAST_RPC_URLS',
    rpc: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com', 'https://blast.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 81457 }],
    explorer: { tx: 'https://blastscan.io/tx/', address: 'https://blastscan.io/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  ZORA: {
    code: 'ZORA',
    name: 'Zora',
    symbol: 'ETH',
    family: 'evm',
    chainId: 7777777,
    decimals: 18,
    coingeckoId: 'ethereum',
    rpcEnv: 'ZORA_RPC_URLS',
    rpc: ['https://rpc.zora.energy/', 'https://zora.drpc.org'],
    // No index on the free tier; checkout reads the blocks over RPC.
    history: [],
    explorer: { tx: 'https://explorer.zora.energy/tx/', address: 'https://explorer.zora.energy/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },

  BTT: {
    code: 'BTT',
    name: 'BitTorrent Chain',
    symbol: 'BTT',
    family: 'evm',
    chainId: 199,
    decimals: 18,
    coingeckoId: 'bittorrent',
    rpcEnv: 'BTT_RPC_URLS',
    rpc: ['https://rpc.bt.io', 'https://bittorrent.drpc.org'],
    history: [{ kind: 'etherscan', chainId: 199 }],
    explorer: { tx: 'https://bttcscan.com/tx/', address: 'https://bttcscan.com/address/' },
    confirmations: 3,
    blockTimeSec: 2,
    // SideShift does not serve this network: payouts here are direct only.
    sideshift: null,
    directGasUsd: 0.001,
    fallbackGasNative: 31.5,
    minReserveNative: 0,
    walletPay: true,
    // Added by scripts/add-chain.js from chainid.network and CoinGecko, verified on chain.
  },
};

const CODES = Object.keys(CHAINS);

function get(code) {
  const chain = CHAINS[String(code || '').toUpperCase()];
  if (!chain) throw new Error(`Unsupported chain: ${code}`);
  return chain;
}

function has(code) {
  return Object.prototype.hasOwnProperty.call(CHAINS, String(code || '').toUpperCase());
}

function list() {
  return CODES.map((code) => CHAINS[code]);
}

function byFamily(family) {
  return list().filter((chain) => chain.family === family);
}

/**
 * The dollar tokens a chain carries, as `{ symbol, contract, decimals }`.
 * Only EVM chains list any; a token lives at the same address as the coin.
 * Both trade at par, so an amount in one is its USD figure.
 */
function tokensOf(code) {
  const chain = get(code);
  return Object.entries(chain.tokens || {}).map(([symbol, token]) => ({ symbol, ...token }));
}

/** One token of a chain by symbol, or null. */
function tokenOf(code, symbol) {
  const wanted = String(symbol || '').toUpperCase();
  return tokensOf(code).find((token) => token.symbol === wanted) || null;
}

/**
 * Everything a chain can be paid in: its coin first, then its tokens. The
 * coin is named by its symbol (ETH on Base), which is also how a checkout
 * session names the asset that was picked or paid.
 */
function assetsOf(code) {
  const chain = get(code);
  return [chain.symbol, ...tokensOf(code).map((token) => token.symbol)];
}

/**
 * Whether SideShift serves a chain, i.e. whether a payout can be swapped
 * into or out of it. A chain it does not serve still receives and pays out
 * directly; a withdrawal just cannot cross into or out of it.
 */
function swappable(code) {
  const chain = get(code);
  return Boolean(chain.sideshift && chain.sideshift.coin && chain.sideshift.network);
}

/**
 * The on-chain swap aggregators that serve a chain, as `{ kyber: <slug>,
 * paraswap: true }`, or null. A swap between two assets on the same chain
 * (USDC to ETH on Base) goes through one of these: a router contract the
 * wallet calls itself, no custodian in between. A chain with none can still
 * pay a token out as that token, and swap across chains where SideShift
 * serves it.
 */
function dexOf(code) {
  const chain = get(code);
  const dex = chain.dex && Object.keys(chain.dex).length > 0 ? chain.dex : null;
  return dex;
}

/** Whether one asset can be swapped for another on the chain itself. */
function swappableOnChain(code) {
  return dexOf(code) !== null;
}

/**
 * The THORChain chain a code maps to (`BSC` for BNB Chain), or null. A
 * chain with one can be swapped across chains with no custodian: the
 * merchant's wallet pays THORChain's vault with a memo and the network pays
 * the destination. Whether it is open right now, and for which assets, is
 * read live by ThorchainService.
 */
function thorchainChain(code) {
  const chain = get(code);
  return chain.thorchain || null;
}

/** The cross-chain swap providers a chain's coin can travel through. */
function crossChainProviders(code) {
  const providers = [];
  if (thorchainChain(code)) providers.push('thorchain');
  if (swappable(code)) providers.push('sideshift');
  return providers;
}

/** Distinct CoinGecko ids across every chain (L2s share Ethereum's). */
function coingeckoIds() {
  return [...new Set(list().map((chain) => chain.coingeckoId))];
}

/** RPC endpoints for an EVM chain: the env override if set, else the defaults. */
function rpcUrls(code) {
  const chain = get(code);
  const configured = (process.env[chain.rpcEnv] || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : chain.rpc || [];
}

/**
 * What the front end needs to know about a chain. No RPC URLs or keys.
 */
function publicInfo(chain) {
  return {
    code: chain.code,
    name: chain.name,
    symbol: chain.symbol,
    family: chain.family,
    chainId: chain.chainId ?? null,
    decimals: chain.decimals,
    confirmations: chain.confirmations,
    blockTimeSec: chain.blockTimeSec,
    explorerTx: chain.explorer.tx,
    walletPay: Boolean(chain.walletPay),
    // Whether a manual (non-wallet) checkout payment can be attributed to
    // its sender. UTXO and Solana chains read an index; an EVM chain reads
    // its index when it has one and its own blocks over RPC when it has not
    // (or while the index is not answering), so every chain in the registry
    // can.
    manualCheckout: true,
    rpcForWallet: chain.family === 'evm' ? (chain.rpc || []).slice(0, 2) : [],
    // The dollar tokens the chain's wallets take, with the contracts a
    // customer can check them against.
    tokens: tokensOf(chain.code),
    // Whether a withdrawal can be swapped into or out of this chain.
    swappable: swappable(chain.code),
    // Whether the chain's coin and tokens can be swapped for each other on
    // the chain itself (a payout in USDC from an ETH balance, or the reverse).
    onChainSwaps: swappableOnChain(chain.code),
    // The cross-chain routes: THORChain (no custodian) and/or SideShift.
    crossChain: crossChainProviders(chain.code),
  };
}

module.exports = { CHAINS, CODES, get, has, list, byFamily, coingeckoIds, rpcUrls, publicInfo, tokensOf, tokenOf, assetsOf, swappable, dexOf, swappableOnChain, thorchainChain, crossChainProviders };
