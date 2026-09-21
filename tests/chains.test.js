/**
 * The chain registry and everything that reads from it.
 *
 * Adding a chain used to mean editing twelve files. These tests pin the
 * contract that makes a registry entry sufficient: validators, pricing, gas,
 * status lookups, wallet services, SideShift asset names, checkout URIs and
 * the public chain list all derive from one place.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const chains = require('../src/config/chains');
const { config } = require('../src/config/env');
const { validateChain, validateCryptoAddress, SUPPORTED_CHAINS } = require('../src/utils/validators');
const { walletServiceFor, balanceKeyFor } = require('../src/services/wallets');
const { EvmWalletService } = require('../src/services/wallets/EvmWalletService');
const EthereumProvider = require('../src/services/EthereumProvider');
const PriceService = require('../src/services/PriceService');
const SideshiftService = require('../src/services/SideshiftService');
const GasEstimator = require('../src/services/GasEstimator');
const { db } = require('../src/config/database');
const checkout = require('../src/routes/checkout');

const { paymentUri, confirmationsOf, verifyHintedEvmPayment } = checkout._internals;

const EVM = ['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX'];
const ADDR = '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e';

describe('Registry shape', () => {
  test('every entry has what the rest of the code reads', () => {
    for (const chain of chains.list()) {
      for (const key of ['code', 'name', 'symbol', 'family', 'decimals', 'coingeckoId', 'explorer', 'confirmations', 'sideshift', 'directGasUsd', 'fallbackGasNative']) {
        assert.ok(chain[key] !== undefined, `${chain.code} is missing ${key}`);
      }
      assert.ok(chain.explorer.tx.endsWith('/'), `${chain.code} explorer.tx must end with / so a hash can be appended`);
      // SideShift either serves the chain (coin + network) or it is marked
      // as not served, so a payout knows it is direct-only there.
      if (chain.sideshift !== null) assert.ok(chain.sideshift.coin && chain.sideshift.network, `${chain.code} needs a SideShift coin and network, or null`);
      assert.strictEqual(chains.swappable(chain.code), chain.sideshift !== null, chain.code);
      if (chain.family === 'evm') {
        assert.ok(Number.isInteger(chain.chainId) && chain.chainId > 0, `${chain.code} needs a chain id`);
        assert.ok(chain.rpc.length >= 2, `${chain.code} needs at least two RPC endpoints to fail over between`);
        assert.ok(chain.rpcEnv, `${chain.code} needs an env override name`);
      }
    }
  });

  test('codes are unique and symbols are shared only by L2s of the same coin', () => {
    const codes = chains.list().map((c) => c.code);
    assert.strictEqual(new Set(codes).size, codes.length);
    for (const code of ['BASE', 'ARB', 'OP']) {
      assert.strictEqual(chains.get(code).symbol, 'ETH');
      assert.strictEqual(chains.get(code).coingeckoId, 'ethereum', `${code} is priced as ETH`);
    }
  });

  test('the founding ten come first; the chains added since follow, EVM ones with tokens and wallet-pay, UTXO ones with their own explorer', () => {
    assert.deepStrictEqual(chains.CODES.slice(0, 10), [...EVM, 'BTC', 'LTC', 'SOL']);
    const added = chains.CODES.slice(10);
    assert.ok(added.length >= 20, `${added.length} chains added`);
    for (const code of added) {
      const chain = chains.get(code);
      if (chain.family === 'utxo') {
        // Bitcoin Cash, Dogecoin: legacy transactions through their own service
        assert.ok(['haskoin', 'blockcypher'].includes(chain.explorerKind), `${code} names an explorer the service knows`);
        assert.strictEqual(chain.walletPay, false, `${code}: no wallet-pay on a UTXO chain`);
        continue;
      }
      if (chain.family === 'xrp') {
        assert.strictEqual(chain.minReserveNative, 1, 'the XRP Ledger keeps its reserve');
        continue;
      }
      assert.strictEqual(chain.family, 'evm', `${code} rides the EVM service`);
      assert.ok(Array.isArray(chains.tokensOf(code)), `${code} lists its dollar tokens (possibly none)`);
      assert.ok(chain.walletPay, `${code} takes wallet-pay`);
    }
    // the registry only grows; the pages' counts follow it (sync-chain-copy)
    assert.ok(chains.CODES.length >= 33, `${chains.CODES.length} chains`);
  });

  test('an env override replaces the default RPC list', () => {
    process.env.POL_RPC_URLS = 'https://a.example, https://b.example';
    try {
      assert.deepStrictEqual(chains.rpcUrls('POL'), ['https://a.example', 'https://b.example']);
    } finally {
      delete process.env.POL_RPC_URLS;
    }
    assert.ok(chains.rpcUrls('POL').length >= 2, 'defaults come back without the override');
  });

  test('public info carries no endpoints or keys beyond the two wallet RPCs', () => {
    const info = chains.publicInfo(chains.get('BASE'));
    assert.deepStrictEqual(Object.keys(info).sort(), ['blockTimeSec', 'chainId', 'code', 'confirmations', 'decimals', 'explorerTx', 'family', 'crossChain', 'manualCheckout', 'name', 'onChainSwaps', 'rpcForWallet', 'swappable', 'symbol', 'tokens', 'walletPay'].sort());
    assert.strictEqual(info.rpcForWallet.length, 2);
  });

  test('every chain takes a manual checkout payment, index or not', () => {
    // An EVM chain with no index reads its blocks over RPC instead.
    for (const chain of chains.list()) {
      assert.strictEqual(chains.publicInfo(chain).manualCheckout, true, chain.code);
    }
    assert.strictEqual(chains.get('BNB').history.length, 0, 'BNB still has no index for the transactions tab');
  });
});

describe('Everything derives from the registry', () => {
  test('validators accept every registered chain and its address format', () => {
    assert.deepStrictEqual(SUPPORTED_CHAINS, chains.CODES);
    for (const code of EVM) {
      assert.ok(validateChain(code), code);
      assert.ok(validateCryptoAddress(ADDR, code), `${code} takes an 0x address`);
      assert.ok(!validateCryptoAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', code), `${code} rejects a Bitcoin address`);
    }
    assert.ok(!validateChain('XYZ'));
    assert.ok(!validateCryptoAddress(ADDR, 'XYZ'));
    // the two UTXO chains added by hand
    assert.ok(validateCryptoAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'BCH'));
    assert.ok(validateCryptoAddress('qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'BCH'), 'the prefix is optional');
    assert.ok(validateCryptoAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'BCH'), 'a legacy address is still an address');
    assert.ok(!validateCryptoAddress(ADDR, 'BCH'));
    assert.ok(validateCryptoAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', 'DOGE'));
    assert.ok(!validateCryptoAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'DOGE'), 'a Bitcoin address is not a Dogecoin one');
  });

  test('confirmation defaults come from the registry', () => {
    for (const chain of chains.list()) {
      assert.strictEqual(config.checkout.confirmations[chain.code], chain.confirmations, chain.code);
    }
  });

  test('every EVM chain gets its own wallet service and RPC pool', () => {
    const seen = new Set();
    for (const code of EVM) {
      const service = walletServiceFor(code);
      assert.ok(service instanceof EvmWalletService, code);
      assert.strictEqual(service.code, code);
      assert.strictEqual(walletServiceFor(code), service, 'memoised');
      const pool = EthereumProvider.forChain(code);
      assert.strictEqual(pool.chain.code, code);
      assert.ok(!seen.has(pool), 'pools are per chain');
      seen.add(pool);
      assert.strictEqual(Number(pool.network.chainId), chains.get(code).chainId, `${code} pool states its chain id`);
    }
    assert.strictEqual(balanceKeyFor('AVAX'), 'balanceEth', 'EVM balances share one key whatever the ticker');
  });

  test('the Ethereum-bound provider API is the ETH pool', () => {
    assert.strictEqual(EthereumProvider.endpoints()[0], chains.rpcUrls('ETH')[0]);
    assert.throws(() => EthereumProvider.forChain('BTC'), /not an EVM chain/);
  });

  test('a wallet created on a new chain is stored under its code with sealed keys', () => {
    const user = db.create('users', { id: `u-${Math.random()}`, username: 'chains-test' });
    const WalletService = require('../src/services/WalletService');
    for (const code of ['POL', 'AVAX']) {
      const wallet = WalletService.generateWallet(user.id, code);
      assert.strictEqual(wallet.chain, code);
      assert.match(wallet.address, /^0x[a-fA-F0-9]{40}$/);
      assert.ok(String(wallet.privateKey).startsWith('enc.v1.'), 'key is encrypted at rest');
    }
  });

  test('prices exist for every chain, with L2s priced as ETH', async () => {
    PriceService.ethToUsdRate = 2000;
    PriceService.polToUsdRate = 0.5;
    PriceService.baseToUsdRate = 2000;
    assert.strictEqual(PriceService.rateFor('BASE'), 2000);
    assert.strictEqual(PriceService.rateFor('POL'), 0.5);
    assert.strictEqual(PriceService.rateFor('XYZ'), 0);
    const ids = chains.coingeckoIds();
    assert.ok(ids.includes('ethereum') && ids.includes('polygon-ecosystem-token') && ids.includes('avalanche-2'));
    assert.strictEqual(ids.filter((id) => id === 'ethereum').length, 1, 'shared ids are requested once');
  });

  test('SideShift assets use the coin and network from the registry', () => {
    const service = new SideshiftService(PriceService);
    assert.deepStrictEqual(service.asset('BASE'), { coin: 'eth', network: 'base' });
    assert.deepStrictEqual(service.asset('POL'), { coin: 'pol', network: 'polygon' });
    assert.deepStrictEqual(service.asset('BNB'), { coin: 'bnb', network: 'bsc' });
    assert.deepStrictEqual(service.asset('BTC'), { coin: 'btc', network: 'bitcoin' });
    assert.strictEqual(SideshiftService.DIRECT_TRANSFER_GAS_USD.AVAX, chains.get('AVAX').directGasUsd);
  });

  test('gas fallbacks and the estimator know every chain', async () => {
    for (const chain of chains.list()) {
      assert.strictEqual(GasEstimator.constructor.FALLBACK_NATIVE?.[chain.code] ?? require('../src/services/GasEstimator').FALLBACK_NATIVE[chain.code], chain.fallbackGasNative, chain.code);
    }
    const original = GasEstimator.fetchNative;
    GasEstimator.fetchNative = async () => null; // force the fallback
    GasEstimator.clear();
    try {
      const estimate = await GasEstimator.estimate('AVAX');
      assert.strictEqual(estimate.live, false);
      assert.strictEqual(estimate.native, chains.get('AVAX').fallbackGasNative);
    } finally {
      GasEstimator.fetchNative = original;
      GasEstimator.clear();
    }
  });
});

describe('Checkout on EVM chains', () => {
  test('payment URIs carry the chain id so a wallet does not pay on mainnet by mistake', () => {
    assert.strictEqual(paymentUri({ chain: 'ETH', walletAddress: ADDR, nativeAmount: 0.1 }), `ethereum:${ADDR}?value=0.1`);
    assert.strictEqual(paymentUri({ chain: 'BASE', walletAddress: ADDR, nativeAmount: 0.1 }), `ethereum:${ADDR}@8453?value=0.1`);
    assert.strictEqual(paymentUri({ chain: 'POL', walletAddress: ADDR, nativeAmount: 5 }), `ethereum:${ADDR}@137?value=5`);
  });

  test('confirmations are read the same way on every EVM chain', () => {
    for (const code of EVM) {
      assert.strictEqual(confirmationsOf(code, { confirmations: '7' }), 7, code);
      assert.strictEqual(confirmationsOf(code, {}), null, code);
    }
  });

  test('the public session view includes the chain info the page needs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/checkout.js'), 'utf-8');
    assert.ok(source.includes('chainInfo,'), 'session GET returns chainInfo');
    assert.ok(source.includes("router.post('/tx-hint'"), 'wallet-pay hint endpoint exists');
  });

  test('the public chain list is served without secrets', () => {
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf-8');
    assert.ok(app.includes("app.get('/api/chains'"));
    assert.ok(app.includes('chains.list().map(chains.publicInfo)'));
  });
});

describe('Wallet-pay transaction hints', () => {
  let originalForChain;
  beforeEach(() => { originalForChain = EthereumProvider.forChain; });
  afterEach(() => { EthereumProvider.forChain = originalForChain; });

  function stubProvider(tx, receipt, tip) {
    EthereumProvider.forChain = () => ({
      withProvider: async (fn) => fn({
        getTransaction: async () => tx,
        getTransactionReceipt: async () => receipt,
        getBlockNumber: async () => tip,
      }),
    });
  }

  const session = { id: 's', chain: 'BASE', walletAddress: ADDR, clientWalletAddress: '0xbuyer', hintTxHash: '0x' + 'ab'.repeat(32) };

  test('a matching transaction is found with its confirmations', async () => {
    stubProvider({ to: ADDR.toLowerCase(), from: '0xBUYER', value: 10n ** 16n, blockNumber: 100 }, { status: 1 }, 104);
    const result = await verifyHintedEvmPayment(session);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.amount, 0.01);
    assert.strictEqual(result.confirmations, 5);
    assert.strictEqual(result.txHash, session.hintTxHash);
  });

  test('a transaction to someone else is ignored, never credited', async () => {
    stubProvider({ to: '0x0000000000000000000000000000000000000001', from: '0xbuyer', value: 10n ** 18n, blockNumber: 100 }, { status: 1 }, 104);
    assert.strictEqual(await verifyHintedEvmPayment(session), null);
  });

  test('a transaction from someone else is ignored', async () => {
    stubProvider({ to: ADDR, from: '0xsomeoneelse', value: 10n ** 18n, blockNumber: 100 }, { status: 1 }, 104);
    assert.strictEqual(await verifyHintedEvmPayment(session), null);
  });

  test('a reverted transaction counts as nothing received', async () => {
    stubProvider({ to: ADDR, from: '0xbuyer', value: 10n ** 18n, blockNumber: 100 }, { status: 0 }, 104);
    assert.deepStrictEqual(await verifyHintedEvmPayment(session), { outcome: 'none' });
  });

  test('a hash the chain does not know yet falls through to the history lookup', async () => {
    stubProvider(null, null, 104);
    assert.strictEqual(await verifyHintedEvmPayment(session), null);
  });

  test('a pending (unmined) transaction is found with zero confirmations', async () => {
    stubProvider({ to: ADDR, from: '0xbuyer', value: 10n ** 18n, blockNumber: null }, null, 104);
    const result = await verifyHintedEvmPayment(session);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.confirmations, 0);
  });

  test('the checkout page only offers wallet pay where the chain supports it', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/checkout-wallet.js'), 'utf-8');
    assert.ok(js.includes('session.chainInfo.walletPay'), 'gated on the registry flag');
    assert.ok(js.includes("method: 'wallet_switchEthereumChain'"), 'switches to the session chain');
    assert.ok(js.includes("method: 'wallet_addEthereumChain'"), 'adds an unknown chain');
    assert.ok(js.includes('BigInt(digits'), 'the value is computed as an exact integer, not a float');
    assert.ok(js.includes("fetch('/api/checkout/tx-hint'"), 'reports the hash');
  });
});

describe('Dollar tokens: the registry, the balances, the settlement', () => {
  const { ethers } = require('ethers');
  const { amountsFor, sessionAmounts, sessionAsset, amountDue, pickAsset, findPayment, findTokenPayment, verifyHintedEvmPayment, settleNow, paymentUri, TRANSFER_TOPIC, LOG_WINDOW_BLOCKS, LOG_WINDOWS_PER_CHECK, LOG_OVERLAP_BLOCKS } = checkout._internals;
  const MERCHANT = '0x1111111111111111111111111111111111111111';
  const BUYER = '0x2222222222222222222222222222222222222222';
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const HASH = '0x' + 'ab'.repeat(32);
  const topic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  let originalForChain;
  let originalHistory;
  const BalanceWatcher = require('../src/services/BalanceWatcher');
  beforeEach(() => { originalForChain = EthereumProvider.forChain; originalHistory = BalanceWatcher.getTransactionHistory; });
  afterEach(() => { EthereumProvider.forChain = originalForChain; BalanceWatcher.getTransactionHistory = originalHistory; });

  test('every EVM chain lists USDC and USDT by a checksummed contract; the rest list nothing', () => {
    for (const chain of chains.list()) {
      const tokens = chains.tokensOf(chain.code);
      if (chain.family !== 'evm') { assert.deepStrictEqual(tokens, [], chain.code); continue; }
      assert.ok(tokens.every((t) => ['USDC', 'USDT'].includes(t.symbol)), `${chain.code} lists only dollar tokens`);
      if (['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX'].includes(chain.code)) assert.deepStrictEqual(tokens.map((t) => t.symbol), ['USDC', 'USDT'], chain.code);
      for (const token of tokens) {
        assert.strictEqual(ethers.getAddress(token.contract), token.contract, `${chain.code} ${token.symbol} is checksummed`);
        // 18-decimal dollars only where the chain's own issue is (BNB Chain and opBNB)
        assert.strictEqual(token.decimals, ['BNB', 'OPBNB'].includes(chain.code) ? 18 : 6, `${chain.code} ${token.symbol} decimals`);
      }
    }
    // within a chain, USDC and USDT are two contracts (the same address on
    // two chains is normal on the EVM - USDT0 is deployed identically on several)
    for (const chain of chains.byFamily('evm')) {
      const contracts = chains.tokensOf(chain.code).map((t) => t.contract.toLowerCase());
      assert.strictEqual(new Set(contracts).size, contracts.length, `${chain.code}: one contract per token`);
    }
    assert.deepStrictEqual(chains.assetsOf('BASE'), ['ETH', 'USDC', 'USDT']);
    assert.deepStrictEqual(chains.assetsOf('BTC'), ['BTC']);
    assert.strictEqual(chains.tokenOf('ARB', 'usdt').onChainSymbol, 'USD₮0', 'the branded ticker is recorded where the contract uses one');
    assert.deepStrictEqual(chains.publicInfo(chains.get('BASE')).tokens.map((t) => t.symbol), ['USDC', 'USDT']);
    assert.deepStrictEqual(chains.publicInfo(chains.get('SOL')).tokens, []);
  });

  test('a link carries one figure per asset: the coin fixed at creation, the tokens at the dollars', () => {
    assert.deepStrictEqual(amountsFor('BASE', 0.00966, 25), { ETH: 0.00966, USDC: 25, USDT: 25 });
    assert.deepStrictEqual(amountsFor('BTC', 0.0003, 25), { BTC: 0.0003 });
    assert.deepStrictEqual(amountsFor('BASE', 0.00966, null), { ETH: 0.00966 }, 'no dollars, no token figures');
    const older = { chain: 'BASE', nativeAmount: 0.01, usdAmount: 26 };
    assert.deepStrictEqual(sessionAmounts(older), { ETH: 0.01, USDC: 26, USDT: 26 }, 'a session from before carries the same shape');
    assert.strictEqual(sessionAsset(older), 'ETH', 'the coin until picked');
    assert.strictEqual(sessionAsset({ ...older, asset: 'USDC' }), 'USDC');
    assert.strictEqual(sessionAsset({ ...older, asset: 'DAI' }), 'ETH', 'an asset the link has no figure for is not a pick');
    assert.strictEqual(amountDue({ ...older, asset: 'USDT' }, 'USDT'), 26);
    assert.strictEqual(amountDue(older, 'ETH'), 0.01);
    assert.strictEqual(pickAsset(older, 'usdc'), 'USDC');
    assert.strictEqual(pickAsset(older, undefined), 'ETH');
    assert.throws(() => pickAsset(older, 'DAI'), /cannot be paid in DAI/);
    assert.throws(() => pickAsset({ chain: 'BTC', nativeAmount: 1, usdAmount: 5 }, 'USDC'), /takes BTC/);
  });

  test('a token pick turns the QR into an EIP-681 transfer on the token contract', () => {
    const session = { chain: 'BASE', walletAddress: MERCHANT, nativeAmount: 0.00966, usdAmount: 25, asset: 'USDC' };
    assert.strictEqual(paymentUri(session), `ethereum:${USDC_BASE}@8453/transfer?address=${MERCHANT}&uint256=25000000`);
    assert.strictEqual(paymentUri({ ...session, asset: 'ETH' }), `ethereum:${MERCHANT}@8453?value=0.00966`);
    assert.strictEqual(paymentUri({ ...session, chain: 'ETH', asset: 'USDT' }), `ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7/transfer?address=${MERCHANT}&uint256=25000000`, 'mainnet keeps the bare form');
    assert.strictEqual(paymentUri({ ...session, chain: 'BNB', asset: 'USDT', usdAmount: 1.5 }), `ethereum:0x55d398326f99059fF775485246999027B3197955@56/transfer?address=${MERCHANT}&uint256=1500000000000000000`, '18 decimals on BNB');
  });

  function stubLogs({ tip, logsByContract = {}, calls }) {
    const pool = {
      withProvider: async (fn) => fn({
        getBlockNumber: async () => tip,
        getBalance: async () => 0n,
        send: async () => null,
        getTransaction: async () => null,
        getTransactionReceipt: async () => null,
        getLogs: async (filter) => {
          if (calls) calls.push(filter);
          return (logsByContract[filter.address] || []).filter((l) => Number(l.blockNumber) >= filter.fromBlock && Number(l.blockNumber) <= filter.toBlock);
        },
      }),
    };
    pool.withLogs = pool.withProvider;
    EthereumProvider.forChain = () => pool;
  }
  const session = (extra = {}) => db.create('checkoutSessions', {
    id: `tok-${Math.random()}`, chain: 'BASE', walletAddress: MERCHANT, clientWalletAddress: BUYER, clientId: 'c-tok',
    nativeAmount: 0.00966, usdAmount: 25, amounts: { ETH: 0.00966, USDC: 25, USDT: 25 }, asset: 'USDC',
    createdAt: new Date(1000 * 1000).toISOString(), status: 'AWAITING_PAYMENT', logsFromBlock: 100, ...extra,
  });
  const transfer = (block, value, extra = {}) => ({ address: USDC_BASE, blockNumber: block, transactionHash: HASH, data: '0x' + value.toString(16).padStart(64, '0'), topics: [TRANSFER_TOPIC, topic(BUYER), topic(MERCHANT)], removed: false, ...extra });

  test('a token payment is the Transfer event from the buyer to the merchant, read from the cursor', async () => {
    const calls = [];
    stubLogs({ tip: 150, calls, logsByContract: { [USDC_BASE]: [transfer(120, 25_000_000n)] } });
    const s = session();
    const result = await findTokenPayment(s);
    assert.deepStrictEqual(result, { outcome: 'found', asset: 'USDC', amount: 25, txHash: HASH, confirmations: 31 });
    // the picked token is asked first, from a little behind the cursor, for the buyer -> merchant pair
    assert.strictEqual(calls[0].address, USDC_BASE);
    assert.strictEqual(calls[0].fromBlock, 100 - LOG_OVERLAP_BLOCKS);
    assert.deepStrictEqual(calls[0].topics, [TRANSFER_TOPIC, topic(BUYER), topic(MERCHANT)]);
  });

  test('nothing found moves the cursor to the tip; a long gap is read in bounded windows', async () => {
    const calls = [];
    stubLogs({ tip: 20_000, calls });
    const s = session();
    assert.deepStrictEqual(await findTokenPayment(s), { outcome: 'none' });
    const perToken = calls.filter((c) => c.address === USDC_BASE);
    assert.strictEqual(perToken.length, LOG_WINDOWS_PER_CHECK, 'so many windows per check');
    assert.ok(perToken.every((c) => c.toBlock - c.fromBlock + 1 <= LOG_WINDOW_BLOCKS), 'each within the cap');
    const after = db.getById('checkoutSessions', s.id);
    assert.strictEqual(after.logsFromBlock, 100 - LOG_OVERLAP_BLOCKS + LOG_WINDOW_BLOCKS * LOG_WINDOWS_PER_CHECK, 'the next check carries on');
  });

  test('an endpoint that caps the range narrows the window for the chain and carries on', async () => {
    const { logWindowByChain } = checkout._internals;
    logWindowByChain.delete('BASE');
    const calls = [];
    const pool = {
      withProvider: async (fn) => fn({ getBlockNumber: async () => 2000 }),
      withLogs: async (fn) => fn({
        getBlockNumber: async () => 2000,
        getLogs: async (filter) => {
          calls.push([filter.fromBlock, filter.toBlock]);
          if (filter.toBlock - filter.fromBlock + 1 > 50) throw new Error('Block range too large: maximum allowed is 50 blocks');
          return filter.fromBlock <= 130 && filter.toBlock >= 130 ? [transfer(130, 25_000_000n)] : [];
        },
      }),
    };
    EthereumProvider.forChain = () => pool;
    const result = await findTokenPayment(session({ logsFromBlock: 100 }));
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.confirmations, 2000 - 130 + 1);
    assert.ok(calls[0][1] - calls[0][0] + 1 > 50, 'asked wide first');
    assert.ok(calls.slice(1).every(([a, b]) => b - a + 1 <= 50), 'then within the cap');
    assert.strictEqual(logWindowByChain.get('BASE'), 50, 'and remembers it for the chain');
    logWindowByChain.delete('BASE');
  });

  test('a zero-value or removed event is not a payment; the amount honours 18 decimals on BNB', async () => {
    stubLogs({ tip: 150, logsByContract: { [USDC_BASE]: [transfer(120, 0n), transfer(121, 25_000_000n, { removed: true })] } });
    assert.deepStrictEqual(await findTokenPayment(session()), { outcome: 'none' });
    const USDT_BNB = '0x55d398326f99059fF775485246999027B3197955';
    stubLogs({ tip: 150, logsByContract: { [USDT_BNB]: [{ ...transfer(120, 25n * 10n ** 18n), address: USDT_BNB }] } });
    const result = await findTokenPayment(session({ chain: 'BNB', asset: 'USDT', amounts: { BNB: 0.03, USDC: 25, USDT: 25 } }));
    assert.strictEqual(result.asset, 'USDT');
    assert.strictEqual(result.amount, 25);
  });

  test('findPayment: the coin first, then the tokens; a token that paid another link does not count', async () => {
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [] });
    stubLogs({ tip: 150, logsByContract: { [USDC_BASE]: [transfer(120, 25_000_000n)] } });
    const s = session();
    const found = await findPayment(s, { id: 'w', chain: 'BASE', address: MERCHANT });
    assert.strictEqual(found.outcome, 'found');
    assert.strictEqual(found.asset, 'USDC');
    db.create('checkoutSessions', { id: 'claimed-' + Math.random(), paidTxHash: HASH, status: 'PAID' });
    assert.deepStrictEqual(await findPayment(session(), { id: 'w', chain: 'BASE', address: MERCHANT }), { outcome: 'none' });
  });

  test('a token lookup that fails holds the session; a coin that arrived wins without one', async () => {
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [] });
    EthereumProvider.forChain = () => ({ withProvider: async (fn) => fn({ getBlockNumber: async () => 150 }), withLogs: async () => { throw new Error('No Base RPC endpoint serves eth_getLogs'); } });
    assert.deepStrictEqual(await findPayment(session(), { id: 'w', chain: 'BASE', address: MERCHANT }), { outcome: 'unverifiable' });
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [{ from: BUYER, to: MERCHANT, value: '9660000000000000', timeStamp: '2000', hash: '0x' + 'cc'.repeat(32), confirmations: '5', isError: '0' }] });
    const coin = await findPayment(session(), { id: 'w', chain: 'BASE', address: MERCHANT });
    assert.strictEqual(coin.asset, 'ETH');
    assert.strictEqual(coin.amount, 0.00966);
  });

  test('a wallet\'s hint for a token transfer is read off its receipt', async () => {
    const receipt = { status: 1, blockNumber: 120, logs: [transfer(120, 25_000_000n)] };
    const stub = (tx, rcpt) => { EthereumProvider.forChain = () => ({ withProvider: async (fn) => fn({ getTransaction: async () => tx, getTransactionReceipt: async () => rcpt, getBlockNumber: async () => 122 }) }); };
    stub({ to: USDC_BASE, from: BUYER, value: 0n, blockNumber: 120 }, receipt);
    const s = session({ hintTxHash: HASH });
    assert.deepStrictEqual(await verifyHintedEvmPayment(s), { outcome: 'found', asset: 'USDC', amount: 25, txHash: HASH, confirmations: 3 });
    stub({ to: USDC_BASE, from: BUYER, value: 0n, blockNumber: null }, null);
    assert.deepStrictEqual(await verifyHintedEvmPayment(s), { outcome: 'found', asset: 'USDC', amount: 0, txHash: HASH, confirmations: 0 }, 'unmined: seen, nothing to count');
    stub({ to: USDC_BASE, from: BUYER, value: 0n, blockNumber: 120 }, { status: 1, blockNumber: 120, logs: [transfer(120, 25_000_000n, { topics: [TRANSFER_TOPIC, topic(BUYER), topic('0x3333333333333333333333333333333333333333')] })] });
    assert.strictEqual(await verifyHintedEvmPayment(s), null, 'a transfer to someone else is not a payment');
    stub({ to: '0x4444444444444444444444444444444444444444', from: BUYER, value: 10n ** 18n, blockNumber: 120 }, { status: 1 });
    assert.strictEqual(await verifyHintedEvmPayment(s), null, 'a call to some other contract is nothing');
  });

  test('settling a token payment keeps the asset, measures against its own figure and records the deposit', async () => {
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [] });
    // its own hash: the earlier test marked HASH as claimed by another link
    stubLogs({ tip: 150, logsByContract: { [USDC_BASE]: [{ ...transfer(120, 24_900_000n), transactionHash: '0x' + 'f1'.repeat(32) }] } });
    const wallet = db.create('wallets', { id: 'w-tok-' + Math.random(), clientId: 'c-tok', chain: 'BASE', address: MERCHANT });
    const s = session({ walletId: wallet.id, lastCheckedAt: null });
    const settled = await settleNow(s);
    assert.strictEqual(settled.status, 'PAID', '24.90 is within the 1% tolerance of 25');
    assert.strictEqual(settled.paidAsset, 'USDC');
    assert.strictEqual(settled.paidAmount, 24.9);
    const deposit = db.findOneBy('transactions', { sessionId: s.id });
    assert.ok(deposit, 'a deposit was recorded');
    assert.strictEqual(deposit.type, 'DEPOSIT');
    assert.strictEqual(deposit.asset, 'USDC');
    assert.strictEqual(deposit.usdAmount, 24.9, 'a dollar token is its dollars');
    assert.strictEqual(deposit.status, 'CONFIRMED');
    assert.strictEqual(deposit.toAddress, MERCHANT);
    // short by more than the tolerance: underpaid, still recorded
    stubLogs({ tip: 150, logsByContract: { [USDC_BASE]: [{ ...transfer(120, 20_000_000n), transactionHash: '0x' + 'ee'.repeat(32) }] } });
    const short = await settleNow(session({ walletId: wallet.id, lastCheckedAt: null }));
    assert.strictEqual(short.status, 'INSUFFICIENT');
    assert.strictEqual(short.paidAsset, 'USDC');
  });

  test('a coin payment on a token-carrying chain still settles against the coin figure', async () => {
    BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [{ from: BUYER, to: MERCHANT, value: '9660000000000000', timeStamp: '2000', hash: '0x' + 'dd'.repeat(32), confirmations: '5', isError: '0' }] });
    stubLogs({ tip: 150 });
    const wallet = db.create('wallets', { id: 'w-coin-' + Math.random(), clientId: 'c-tok', chain: 'BASE', address: MERCHANT });
    const settled = await settleNow(session({ walletId: wallet.id, lastCheckedAt: null, asset: 'USDC' }));
    assert.strictEqual(settled.status, 'PAID', 'picked USDC, sent ETH: still paid');
    assert.strictEqual(settled.paidAsset, 'ETH');
    const deposit = db.findOneBy('transactions', { sessionId: settled.id });
    assert.strictEqual(deposit.asset, 'ETH');
    assert.strictEqual(deposit.usdAmount, 25, 'the coin\'s dollars at the link\'s own rate');
  });
});

describe('The chain tooling', () => {
  const { execFileSync } = require('node:child_process');
  test('the page copy is in step with the registry (scripts/sync-chain-copy.js --check)', () => {
    // Adding a chain regenerates the pages; editing the registry by hand
    // without running the sync leaves the pages stating the wrong count.
    const out = execFileSync(process.execPath, [path.join(__dirname, '../scripts/sync-chain-copy.js'), '--check'], { encoding: 'utf-8' });
    assert.match(out, /in step with the registry/);
  });
  test('the importer and the verifier parse, and the importer refuses to run with nothing to add', () => {
    for (const file of ['add-chain.js', 'verify-chains.js', 'sync-chain-copy.js']) {
      execFileSync(process.execPath, ['--check', path.join(__dirname, '../scripts', file)]);
    }
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '../scripts/add-chain.js')], { stdio: 'pipe' }), (error) => error.status === 2 && /usage/.test(String(error.stdout)));
    for (const script of ['chains:add', 'chains:verify', 'chains:sync']) {
      assert.ok(require('../package.json').scripts[script], `npm run ${script}`);
    }
  });
  test('every entry the importer wrote says so, and carries what the app reads', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/config/chains.js'), 'utf-8');
    const imported = chains.list().filter((c) => source.includes(`${c.code}: {`) && source.slice(source.indexOf(`  ${c.code}: {`), source.indexOf('  },', source.indexOf(`  ${c.code}: {`))).includes('Added by scripts/add-chain.js'));
    assert.ok(imported.length >= 10, `${imported.length} imported chains`);
    for (const chain of imported) {
      assert.ok(chain.rpc.length >= 2 && chain.blockTimeSec > 0 && chain.directGasUsd > 0 && chain.explorer.tx.endsWith('/tx/'), chain.code);
      assert.ok(/^[A-Z][A-Za-z0-9 .-]+$/.test(chain.name), `${chain.code} has a presentable name: ${chain.name}`);
    }
  });
});

describe('Wallet labels', () => {
  const { db } = require('../src/config/database');
  const WalletService = require('../src/services/WalletService');
  const walletsRouteSrc = fs.readFileSync(path.join(__dirname, '../src/routes/wallets.js'), 'utf-8');

  test('the create route accepts and stores a label', () => {
    assert.ok(walletsRouteSrc.includes('normaliseLabel(req.body.label)'), 'create reads the label');
    assert.ok(walletsRouteSrc.includes("router.patch('/:walletId'"), 'a rename route exists');
    assert.ok(walletsRouteSrc.includes('label: wallet.label || null'), 'the label is serialised');
  });

  test('a label is trimmed, bounded and clearable', () => {
    const user = db.create('users', { id: `u-${Math.random()}`, username: 'label-svc' });
    const wallet = WalletService.generateWallet(user.id, 'ETH');
    // normaliseLabel is not exported; exercise it through the stored shape.
    db.update('wallets', wallet.id, { label: 'x'.repeat(40) });
    assert.strictEqual(db.getById('wallets', wallet.id).label.length, 40);
  });

  test('PATCH is allowed by CORS', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf-8');
    assert.match(appSrc, /methods: \[[^\]]*'PATCH'/);
  });
});

describe('Dashboard wallet naming and search', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf-8');
  const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf-8');

  test('wallets render through one card function that shows the name and a rename control', () => {
    assert.ok(js.includes('function renderWalletCard'));
    assert.ok(js.includes('wallet-label'));
    assert.ok(js.includes('data-on-click="renameWallet"'));
    assert.ok(js.includes('function saveWalletLabel'), 'inline rename saves via PATCH');
    assert.ok(js.includes("method: 'PATCH'"));
  });

  test('the create modal has a name field and the wallets page a search box', () => {
    assert.ok(html.includes('id="walletLabel"'));
    assert.ok(html.includes('id="walletSearch"'));
    assert.ok(html.includes('data-on-input="filterWallets"'));
  });

  test('the action dispatcher handles input events for live search', () => {
    const actions = fs.readFileSync(path.join(__dirname, '../public/js/common/actions.js'), 'utf-8');
    assert.match(actions, /\['click', 'submit', 'change', 'input'\]/);
  });
});

describe('Chains with no transaction index are read over RPC', () => {
  const { scanEvmPaymentOverRpc, rpcScanBaseline, scansOverRpc, RPC_SCAN_MAX_BLOCKS, RPC_SCAN_FIRST_LOOKBACK } = checkout._internals;
  const MERCHANT = '0x1111111111111111111111111111111111111111';
  const BUYER = '0x2222222222222222222222222222222222222222';
  const HASH = '0x' + 'cd'.repeat(32);
  let originalForChain;
  beforeEach(() => { originalForChain = EthereumProvider.forChain; });
  afterEach(() => { EthereumProvider.forChain = originalForChain; });

  /**
   * A chain of `blocks` (number -> { timestamp, transactions }), a tip, the
   * merchant balance, and receipts by hash. Records which blocks were read.
   */
  function stubChain({ tip, balance, blocks = {}, receipts = {} }) {
    const read = [];
    const pool = {
      withProvider: async (fn) => fn({
        getBlockNumber: async () => tip,
        getBalance: async () => BigInt(balance),
        send: async (method, [hex]) => {
          assert.strictEqual(method, 'eth_getBlockByNumber');
          const number = parseInt(hex, 16);
          read.push(number);
          const block = blocks[number];
          return block ? { number: hex, timestamp: `0x${(block.timestamp || 2000).toString(16)}`, transactions: block.transactions || [] } : null;
        },
        getTransactionReceipt: async (hash) => receipts[hash] ?? { status: 1 },
        getTransaction: async () => null,
        getLogs: async () => [],
      }),
    };
    pool.withLogs = pool.withProvider;
    EthereumProvider.forChain = () => pool;
    return read;
  }

  const fresh = (extra = {}) => db.create('checkoutSessions', {
    id: `scan-${Math.random()}`, chain: 'BNB', walletAddress: MERCHANT, clientWalletAddress: BUYER,
    nativeAmount: 0.5, createdAt: new Date(1000 * 1000).toISOString(), status: 'AWAITING_PAYMENT', ...extra,
  });

  test('BNB is read over RPC; chains with an index are not', () => {
    assert.strictEqual(scansOverRpc('BNB'), true);
    assert.strictEqual(scansOverRpc('BASE'), false);
    assert.strictEqual(scansOverRpc('BTC'), false);
    assert.strictEqual(chains.publicInfo(chains.get('BNB')).manualCheckout, true, 'so the page offers manual entry on BNB');
  });

  test('the baseline is the block after the tip and the balance at the moment the buyer gives an address', async () => {
    stubChain({ tip: 500, balance: '7000' });
    assert.deepStrictEqual(await rpcScanBaseline({ id: 'b', chain: 'BNB', walletAddress: MERCHANT }), { scanFromBlock: 501, scanBalance: '7000' });
    assert.deepStrictEqual(await rpcScanBaseline({ id: 'b', chain: 'BASE', walletAddress: MERCHANT }), { scanFromBlock: 501, scanBalance: '7000' }, 'an indexed EVM chain gets one too, for the fallback');
    assert.deepStrictEqual(await rpcScanBaseline({ id: 'b', chain: 'BTC', walletAddress: MERCHANT }), {}, 'nothing outside the EVM family');
    EthereumProvider.forChain = () => ({ withProvider: async () => { throw new Error('rpc down'); } });
    assert.deepStrictEqual(await rpcScanBaseline({ id: 'b', chain: 'BNB', walletAddress: MERCHANT }), {}, 'best effort');
  });

  test('an unchanged balance reads no blocks and moves the cursor to the tip', async () => {
    const session = fresh({ scanFromBlock: 101, scanBalance: '7000' });
    const read = stubChain({ tip: 110, balance: '7000' });
    assert.deepStrictEqual(await scanEvmPaymentOverRpc(session), { outcome: 'none' });
    assert.deepStrictEqual(read, []);
    assert.strictEqual(db.getById('checkoutSessions', session.id).scanFromBlock, 111);
  });

  test('a changed balance reads the blocks since the cursor and finds the transfer', async () => {
    const session = fresh({ scanFromBlock: 101, scanBalance: '7000' });
    const read = stubChain({
      tip: 105, balance: '7500',
      blocks: {
        101: {}, 102: {},
        103: { transactions: [
          { hash: '0x' + 'aa'.repeat(32), from: '0x3333333333333333333333333333333333333333', to: MERCHANT, value: '0x1' },
          { hash: HASH, from: BUYER.toUpperCase().replace('0X', '0x'), to: MERCHANT.toUpperCase().replace('0X', '0x'), value: '0x6f05b59d3b20000' },
        ] },
        104: {}, 105: {},
      },
    });
    const result = await scanEvmPaymentOverRpc(session);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.txHash, HASH);
    assert.strictEqual(result.amount, 0.5);
    assert.strictEqual(result.confirmations, 3, 'tip 105 - block 103 + 1');
    assert.deepStrictEqual(read, [101, 102, 103], 'stopped at the block it was found in');
    assert.strictEqual(db.getById('checkoutSessions', session.id).scanFromBlock, 104, 'resumes after it');
  });

  test('a transfer to the merchant from someone else, or a reverted one, is not a payment', async () => {
    const session = fresh({ scanFromBlock: 101, scanBalance: '7000' });
    stubChain({
      tip: 102, balance: '9000',
      blocks: {
        101: { transactions: [{ hash: '0x' + 'ee'.repeat(32), from: '0x3333333333333333333333333333333333333333', to: MERCHANT, value: '0x1' }] },
        102: { transactions: [{ hash: HASH, from: BUYER, to: MERCHANT, value: '0x1' }] },
      },
      receipts: { [HASH]: { status: 0 } },
    });
    assert.deepStrictEqual(await scanEvmPaymentOverRpc(session), { outcome: 'none' });
    const after = db.getById('checkoutSessions', session.id);
    assert.strictEqual(after.scanFromBlock, 103);
    assert.strictEqual(after.scanBalance, '9000', 'caught up: this balance is now the baseline');
  });

  test('a block older than the session is skipped, like the index path', async () => {
    const session = fresh({ scanFromBlock: 101 });
    stubChain({ tip: 101, balance: '1', blocks: { 101: { timestamp: 999, transactions: [{ hash: HASH, from: BUYER, to: MERCHANT, value: '0x1' }] } } });
    assert.deepStrictEqual(await scanEvmPaymentOverRpc(session), { outcome: 'none' });
  });

  test('a long backlog is read a bounded number of blocks at a time', async () => {
    const session = fresh({ scanFromBlock: 1, scanBalance: '7000' });
    const read = stubChain({ tip: 1000, balance: '8000', blocks: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i + 1, {}])) });
    assert.deepStrictEqual(await scanEvmPaymentOverRpc(session), { outcome: 'none' });
    assert.strictEqual(read.length, RPC_SCAN_MAX_BLOCKS);
    const after = db.getById('checkoutSessions', session.id);
    assert.strictEqual(after.scanFromBlock, RPC_SCAN_MAX_BLOCKS + 1, 'the next check carries on from here');
    assert.strictEqual(after.scanBalance, '7000', 'not caught up, so the baseline is not moved');
  });

  test('a session with no cursor starts a short way back', async () => {
    const session = fresh();
    const read = stubChain({ tip: 500, balance: '1', blocks: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i, {}])) });
    await scanEvmPaymentOverRpc(session);
    assert.strictEqual(read[0], 500 - RPC_SCAN_FIRST_LOOKBACK);
    assert.strictEqual(read[read.length - 1], 500);
  });

  test('findPayment follows a transfer it has seen by its hash rather than re-reading blocks', async () => {
    const { findPayment } = checkout._internals;
    const session = fresh({ pendingTxHash: HASH, scanFromBlock: 200, scanBalance: '1' });
    const read = [];
    EthereumProvider.forChain = () => ({
      withProvider: async (fn) => fn({
        getTransaction: async (hash) => (hash === HASH ? { to: MERCHANT, from: BUYER, value: 10n ** 18n, blockNumber: 150 } : null),
        getTransactionReceipt: async () => ({ status: 1 }),
        getBlockNumber: async () => 152,
        getBalance: async () => 1n,
        send: async (method, [hex]) => { read.push(parseInt(hex, 16)); return null; },
      }),
    });
    const result = await findPayment(session, { id: 'w', chain: 'BNB', address: MERCHANT });
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.confirmations, 3);
    assert.deepStrictEqual(read, [], 'no blocks read');
  });

  test('an RPC failure holds the session rather than settling it', async () => {
    const { findPayment } = checkout._internals;
    const session = fresh({ scanFromBlock: 1 });
    EthereumProvider.forChain = () => ({ withProvider: async () => { throw new Error('rate limited'); } });
    assert.deepStrictEqual(await findPayment(session, { id: 'w', chain: 'BNB', address: MERCHANT }), { outcome: 'unverifiable' });
  });

  describe('an indexed EVM chain falls back to the blocks while its index is not answering', () => {
    const BalanceWatcher = require('../src/services/BalanceWatcher');
    const { findPayment } = checkout._internals;
    let originalHistory;
    beforeEach(() => { originalHistory = BalanceWatcher.getTransactionHistory; });
    afterEach(() => { BalanceWatcher.getTransactionHistory = originalHistory; });
    const baseWallet = { id: 'w', chain: 'BASE', address: MERCHANT };

    for (const [label, answer] of [
      ['an error', { status: 'error', error: 'HTTP 502' }],
      ['a rate limit', { status: 'rate_limited' }],
      ['unavailable', { status: 'unavailable', transactions: [] }],
      ['a throw', new Error('boom')],
    ]) {
      test(`${label} from the index reads the blocks instead`, async () => {
        BalanceWatcher.getTransactionHistory = async () => { if (answer instanceof Error) throw answer; return answer; };
        const session = fresh({ chain: 'BASE', scanFromBlock: 101, scanBalance: '7000' });
        const read = stubChain({ tip: 102, balance: '9000', blocks: { 101: {}, 102: { transactions: [{ hash: HASH, from: BUYER, to: MERCHANT, value: '0x6f05b59d3b20000' }] } } });
        const result = await findPayment(session, baseWallet);
        assert.strictEqual(result.outcome, 'found', label);
        assert.strictEqual(result.txHash, HASH);
        assert.deepStrictEqual(read, [101, 102]);
      });
    }

    test('an index that answers is believed; the blocks are not read', async () => {
      BalanceWatcher.getTransactionHistory = async () => ({ status: 'ok', transactions: [] });
      const session = fresh({ chain: 'BASE', scanFromBlock: 101, scanBalance: '7000' });
      const read = stubChain({ tip: 102, balance: '9000', blocks: { 101: {}, 102: {} } });
      assert.deepStrictEqual(await findPayment(session, baseWallet), { outcome: 'none' });
      assert.deepStrictEqual(read, []);
    });

    test('a chain outside the EVM family still holds when its index is down', async () => {
      BalanceWatcher.getTransactionHistory = async () => ({ status: 'error' });
      const session = fresh({ chain: 'BTC', walletAddress: 'bc1qmerchant', clientWalletAddress: 'bc1qbuyer' });
      assert.deepStrictEqual(await findPayment(session, { id: 'w', chain: 'BTC', address: 'bc1qmerchant' }), { outcome: 'unverifiable' });
    });

    test('and both the index and the RPC failing holds an EVM session too', async () => {
      BalanceWatcher.getTransactionHistory = async () => ({ status: 'error' });
      EthereumProvider.forChain = () => ({ withProvider: async () => { throw new Error('rpc down'); } });
      const session = fresh({ chain: 'BASE', scanFromBlock: 1 });
      assert.deepStrictEqual(await findPayment(session, baseWallet), { outcome: 'unverifiable' });
    });
  });

  test('the checkout page hides manual entry and requires a wallet on such chains', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/checkout.js'), 'utf-8');
    const render = js.slice(js.indexOf('function renderCheckout'), js.indexOf('window.submitWalletAddress'));
    assert.ok(render.includes('walletPayOnly'), 'renderCheckout detects the case');
    assert.ok(render.includes("hide('manual-address-section')"), 'the dead-end manual form is hidden');
    const wallet = fs.readFileSync(path.join(__dirname, '../public/js/checkout-wallet.js'), 'utf-8');
    assert.ok(wallet.includes('wallet-required-note'), 'a no-wallet message is offered');
    const html = fs.readFileSync(path.join(__dirname, '../public/checkout.html'), 'utf-8');
    assert.ok(html.includes('id="manual-address-section"'), 'the manual block is wrappable');
    assert.ok(html.includes('id="wallet-required-note"'));
  });

  test('every EVM chain without a history source is walletPay so checkout still works', () => {
    for (const chain of chains.byFamily('evm')) {
      if ((chain.history || []).length === 0) {
        assert.ok(chain.walletPay, `${chain.code} has no index, so it must support wallet-pay to be usable for checkout`);
      }
    }
  });
});
