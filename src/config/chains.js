/**
 * Chain registry - the one place a chain is described.
 *
 * Before this, adding a chain meant editing twelve files: validators, the gas
 * estimator, status lookups, the SideShift asset map, checkout URIs, config,
 * and three front-end scripts, each with its own switch statement. Now every
 * one of those reads from here, and a new chain is one entry plus - for a new
 * signing family - one wallet service.
 *
 * Three families exist:
 *   evm    - Ethereum and anything that speaks its JSON-RPC (secp256k1,
 *            EIP-1559 or legacy gas). One wallet service, parameterised.
 *   utxo   - Bitcoin-likes with a mempool.space-style explorer.
 *   solana - on its own.
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
    directGasUsd: 0.15,
    fallbackGasNative: 0.0008,
    minReserveNative: 0,
    walletPay: true,
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
    directGasUsd: 0.01,
    fallbackGasNative: 0.00002,
    minReserveNative: 0,
    walletPay: true,
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
    blockTimeSec: 3,
    sideshift: { coin: 'bnb', network: 'bsc' },
    directGasUsd: 0.02,
    fallbackGasNative: 0.0001,
    minReserveNative: 0,
    walletPay: true,
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
    directGasUsd: 0.02,
    fallbackGasNative: 0.001,
    minReserveNative: 0,
    walletPay: true,
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
    directGasUsd: 0.001,
    fallbackGasNative: 0.00001,
    // Rent-exempt minimum for a bare account, plus a fee's worth of headroom.
    minReserveNative: 0.00089088 + 0.00001,
    walletPay: false,
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
  };
}

module.exports = { CHAINS, CODES, get, has, list, byFamily, coingeckoIds, rpcUrls, publicInfo };
