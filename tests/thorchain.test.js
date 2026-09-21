/**
 * Cross-chain through THORChain, and the gas float.
 *
 * THORChain has no orders: a quote names the vault to pay and the memo to
 * attach, the merchant's wallet pays it, and the network pays the
 * destination. The plan quotes it beside SideShift and keeps whichever pays
 * more. The float advances the coin a token-only wallet needs and charges
 * it back in the token.
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
const { ethers } = require('ethers');

const chains = require('../src/config/chains');
const Thor = require('../src/services/ThorchainService');
const { ThorchainService, ThorchainError, LIMIT_BPS } = Thor;
const { GasFloatService } = require('../src/services/GasFloatService');
const SwapService = require('../src/services/SwapService');
const GasEstimator = require('../src/services/GasEstimator');
const PriceService = require('../src/services/PriceService');
const PayoutService = require('../src/services/PayoutService');
const BitcoinModule = require('../src/services/wallets/BitcoinWalletService');
const LitecoinModule = require('../src/services/wallets/LitecoinWalletService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');
const ctor = (mod, name) => (typeof mod === 'function' ? mod : (mod[name] || Object.getPrototypeOf(mod).constructor));
const Bitcoin = ctor(BitcoinModule, 'BitcoinWalletService');
const Litecoin = ctor(LitecoinModule, 'LitecoinWalletService');

const EVM_DEST = '0x1111111111111111111111111111111111111111';
const BTC_DEST = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const USDC_BASE = chains.tokenOf('BASE', 'USDC').contract;

// ── THORChain as it answers ──────────────────────────────────────────────────
const INBOUND = [
  { chain: 'BTC', address: 'bc1qvault', halted: false, router: '', gas_rate: '3' },
  { chain: 'LTC', address: 'ltc1qvault', halted: false, router: '' },
  { chain: 'ETH', address: '0x0DB14a0288f4637F60b46690f1971b756c58A47e', halted: false, router: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146' },
  { chain: 'BASE', address: '0x0DB14a0288f4637F60b46690f1971b756c58A47e', halted: false, router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' },
  { chain: 'BSC', address: '0x0DB14a0288f4637F60b46690f1971b756c58A47e', halted: false, router: '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b' },
  { chain: 'SOL', address: 'solvault', halted: true, router: '' },
];
const POOLS = ['BTC.BTC', 'LTC.LTC', 'ETH.ETH', 'BASE.ETH', 'BSC.BNB', 'SOL.SOL', `BASE.USDC-${USDC_BASE.toUpperCase()}`, 'BSC.USDT-0X55D398326F99059FF775485246999027B3197955']
  .map((asset) => ({ asset, status: 'Available' }));
const QUOTE = {
  inbound_address: 'bc1qvault', memo: `=:f:${EVM_DEST}:0/1/0`, expected_amount_out: '30757533', expiry: Math.floor(Date.now() / 1000) + 600,
  fees: { asset: 'BASE.ETH', affiliate: '0', outbound: '9491', liquidity: '61643', total: '71134', slippage_bps: 19, total_bps: 23 },
  dust_threshold: '1000', recommended_min_amount_in: '6417', recommended_gas_rate: '3', gas_rate_units: 'satsperbyte', total_swap_seconds: 606, inbound_confirmation_seconds: 600,
};

function fakeThorFetch(overrides = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (u.includes('/inbound_addresses')) return reply(overrides.inbound || INBOUND);
    if (u.includes('/pools')) return reply(overrides.pools || POOLS);
    if (u.includes('/quote/swap')) return reply(typeof overrides.quote === 'function' ? overrides.quote(u) : (overrides.quote || QUOTE));
    if (u.includes('/tx/status/')) return reply(overrides.status || {});
    return { ok: false, status: 404, text: async () => 'no' };
  };
  return { fetch, calls };
}

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  PriceService.ethToUsdRate = 2624;
  PriceService.baseToUsdRate = 2624;
  PriceService.btcToUsdRate = 80000;
  PriceService.ltcToUsdRate = 80;
  PriceService.bnbToUsdRate = 600;
  PriceService.solToUsdRate = 150;
  PriceService.scrollToUsdRate = 2624;
});
afterEach(() => { global.fetch = realFetch; });

describe('The registry names the THORChain chains', () => {
  test('the chains THORChain serves, by its own names', () => {
    assert.deepStrictEqual(
      Object.fromEntries(chains.list().filter((c) => chains.thorchainChain(c.code)).map((c) => [c.code, c.thorchain])),
      { ETH: 'ETH', BASE: 'BASE', BNB: 'BSC', AVAX: 'AVAX', BTC: 'BTC', LTC: 'LTC', SOL: 'SOL', BCH: 'BCH', DOGE: 'DOGE', XRP: 'XRP' }
    );
    assert.deepStrictEqual(chains.crossChainProviders('BTC'), ['thorchain', 'sideshift']);
    assert.deepStrictEqual(chains.crossChainProviders('POL'), ['sideshift']);
    assert.deepStrictEqual(chains.crossChainProviders('LINEA'), []);
    assert.deepStrictEqual(chains.publicInfo(chains.get('BTC')).crossChain, ['thorchain', 'sideshift']);
  });
});

describe('ThorchainService', () => {
  test('assets are named the way THORChain names them', () => {
    const t = new ThorchainService();
    assert.strictEqual(t.assetOf('BTC'), 'BTC.BTC');
    assert.strictEqual(t.assetOf('BASE'), 'BASE.ETH');
    assert.strictEqual(t.assetOf('BNB'), 'BSC.BNB');
    assert.strictEqual(t.assetOf('BASE', 'usdc'), `BASE.USDC-${USDC_BASE.toUpperCase()}`);
    assert.throws(() => t.assetOf('POL'), (e) => e instanceof ThorchainError && e.code === 'UNSERVED');
    assert.throws(() => t.assetOf('BASE', 'DAI'), (e) => e.code === 'UNKNOWN_ASSET');
    assert.strictEqual(ThorchainService.toUnits(0.01), '1000000');
    assert.strictEqual(ThorchainService.toUnits(100), '10000000000');
    assert.strictEqual(ThorchainService.fromUnits('30757533'), 0.30757533);
    assert.strictEqual(ThorchainService.txId('0xabcDEF'), 'ABCDEF');
  });

  test('serves() reads the live lists: an open chain with a pool, not a halted one, not a token without a pool', async () => {
    global.fetch = fakeThorFetch().fetch;
    const t = new ThorchainService();
    assert.strictEqual(t.serves('BTC'), false, 'nothing is served before the lists load');
    await t.ready();
    assert.strictEqual(t.serves('BTC'), true);
    assert.strictEqual(t.serves('BASE'), true);
    assert.strictEqual(t.serves('BASE', 'USDC'), true);
    assert.strictEqual(t.serves('BASE', 'USDT'), false, 'no pool');
    assert.strictEqual(t.serves('BNB', 'USDT'), true);
    assert.strictEqual(t.serves('SOL'), false, 'halted right now');
    assert.strictEqual(t.serves('POL'), false, 'not on THORChain');
    assert.strictEqual(t.serves('LINEA'), false);
  });

  test('the memo gets a floor written in, and stays inside 80 bytes', () => {
    const memo = ThorchainService.memoWithLimit(`=:f:${EVM_DEST}:0/1/0`, '30757533');
    const limit = (30757533n * BigInt(10000 - LIMIT_BPS)) / 10000n;
    assert.strictEqual(memo, `=:f:${EVM_DEST}:${limit}/1/0`);
    // a taproot destination leaves little room: the limit loses digits to an exponent
    const long = ThorchainService.memoWithLimit('=:b:bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr:0/1/0', '1234567890123');
    assert.ok(Buffer.byteLength(long, 'utf8') <= 80, `${Buffer.byteLength(long, 'utf8')} bytes`);
    assert.match(long, /:\d+e\d+\/1\/0$/, 'exponent form');
  });

  test('a quote names the vault, the memo with its floor, what comes out and what it costs', async () => {
    const fake = fakeThorFetch();
    global.fetch = fake.fetch;
    const t = new ThorchainService();
    const q = await t.quote({ fromChain: 'BTC', toChain: 'BASE', amount: 0.01, destination: EVM_DEST });
    assert.strictEqual(q.provider, 'thorchain');
    assert.strictEqual(q.inboundAddress, 'bc1qvault');
    assert.strictEqual(q.router, null, 'no router on Bitcoin');
    assert.strictEqual(q.amountUnits, '1000000');
    assert.strictEqual(q.expectedOut, 0.30757533);
    assert.strictEqual(q.minOut, Number((30757533n * BigInt(10000 - LIMIT_BPS)) / 10000n) / 1e8);
    assert.match(q.memo, new RegExp(`^=:f:${EVM_DEST}:\\d+/1/0$`));
    assert.strictEqual(q.fees.total, 0.00071134);
    assert.ok(Math.abs(q.fees.totalUsd - 0.00071134 * 2624) < 1e-9);
    assert.strictEqual(q.fees.totalBps, 23);
    assert.strictEqual(q.totalSeconds, 606);
    assert.strictEqual(q.recommendedMin, 0.00006417);
    assert.strictEqual(q.deposit, 'memo');
    const call = fake.calls.find((c) => c.includes('/quote/swap'));
    assert.ok(call.includes('from_asset=BTC.BTC') && call.includes('to_asset=BASE.ETH') && call.includes('amount=1000000') && call.includes(`destination=${EVM_DEST}`));
    assert.ok(call.includes('streaming_interval=1'), 'streaming for the price');
  });

  test('a token deposit on an EVM chain goes through the router, with calldata for depositWithExpiry', async () => {
    global.fetch = fakeThorFetch({ quote: { ...QUOTE, inbound_address: '0x0DB14a0288f4637F60b46690f1971b756c58A47e', router: '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4', memo: `=:b:${BTC_DEST}:0/1/0`, expected_amount_out: '121771', fees: { ...QUOTE.fees, asset: 'BTC.BTC' } } }).fetch;
    const t = new ThorchainService();
    const q = await t.quote({ fromChain: 'BASE', fromAsset: 'USDC', toChain: 'BTC', amount: 100, destination: BTC_DEST });
    assert.strictEqual(q.deposit, 'router');
    assert.strictEqual(q.router, '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4');
    const data = ThorchainService.depositCalldata({ vault: q.inboundAddress, token: USDC_BASE, amountUnits: '100000000', memo: q.memo, expiry: q.expiry });
    const iface = new ethers.Interface(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable']);
    const decoded = iface.decodeFunctionData('depositWithExpiry', data);
    assert.strictEqual(decoded[0], q.inboundAddress);
    assert.strictEqual(decoded[1], USDC_BASE);
    assert.strictEqual(decoded[2], 100000000n);
    assert.strictEqual(decoded[3], q.memo);
    assert.strictEqual(decoded[4], BigInt(q.expiry));
    // the coin: a zero asset
    const native = iface.decodeFunctionData('depositWithExpiry', ThorchainService.depositCalldata({ vault: q.inboundAddress, amountUnits: '5', memo: 'm', expiry: 1 }));
    assert.strictEqual(native[1], ethers.ZeroAddress);
  });

  test('a refusal is a ThorchainError with the network\'s words', async () => {
    global.fetch = fakeThorFetch({ quote: { code: 3, message: 'amount less than dust threshold: invalid request' } }).fetch;
    const t = new ThorchainService();
    await assert.rejects(() => t.quote({ fromChain: 'BTC', toChain: 'BASE', amount: 0.000001, destination: EVM_DEST }), (e) => e instanceof ThorchainError && e.code === 'BELOW_DUST' && /less than dust threshold$/.test(e.message));
    await assert.rejects(() => t.quote({ fromChain: 'SOL', toChain: 'BTC', amount: 1, destination: BTC_DEST }), (e) => e.code === 'UNSERVED');
    await assert.rejects(() => t.quote({ fromChain: 'BTC', toChain: 'BASE', fromAsset: 'BTC', toAsset: 'USDT', amount: 1, destination: EVM_DEST }), (e) => e.code === 'UNSERVED');
  });

  test('status: waiting until observed, swapping while it runs, settled or refunded once signed', async () => {
    const t = new ThorchainService();
    global.fetch = fakeThorFetch({ status: { stages: { inbound_observed: { started: false, final_count: 0, completed: false } } } }).fetch;
    assert.strictEqual((await t.status('0xabc')).status, 'waiting');
    global.fetch = fakeThorFetch({ status: { tx: { id: 'ABC' }, stages: { inbound_observed: { completed: true }, swap_status: { pending: true } } } }).fetch;
    assert.strictEqual((await t.status('0xabc')).status, 'swapping');
    global.fetch = fakeThorFetch({ status: { tx: { id: 'ABC' }, planned_out_txs: [{ chain: 'BASE', refund: false }], out_txs: [{ chain: 'BASE', memo: 'OUT:ABC' }], stages: { inbound_observed: { completed: true }, outbound_signed: { completed: true } } } }).fetch;
    assert.strictEqual((await t.status('0xabc')).status, 'settled');
    global.fetch = fakeThorFetch({ status: { tx: { id: 'ABC' }, planned_out_txs: [{ chain: 'BTC', refund: true }], out_txs: [{ chain: 'BTC', memo: 'REFUND:ABC' }], stages: { inbound_observed: { completed: true }, outbound_signed: { completed: true } } } }).fetch;
    assert.strictEqual((await t.status('0xabc')).status, 'refunded');
  });
});

describe('The wallets carry a memo', () => {
  test('an OP_RETURN script holds up to 80 bytes, with PUSHDATA1 past 75', () => {
    const short = Bitcoin.opReturnScript('=:f:0x1111111111111111111111111111111111111111:30063120/1/0');
    assert.strictEqual(short[0], 0x6a);
    assert.strictEqual(short[1], 59);
    assert.strictEqual(short.length, 61);
    const long = Litecoin.opReturnScript('=:b:bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr:119186/1/0');
    assert.deepStrictEqual([...long.slice(0, 3)], [0x6a, 0x4c, 77]);
    assert.throws(() => Bitcoin.opReturnScript('x'.repeat(81)), /81 bytes; 80 is the most/);
  });

  test('the senders take a memo option and add it after the change, sized into the fee', () => {
    for (const file of ['BitcoinWalletService', 'LitecoinWalletService']) {
      const source = read(`src/services/wallets/${file}.js`);
      assert.ok(source.includes('async sendTransaction(privateKey, toAddress, amount, options = {}) {'), file);
      assert.ok(source.includes(`const memo = options && options.memo ? ${file}.opReturnScript(options.memo) : null;`), file);
      assert.ok(source.includes('virtualSize(selectedUtxos.length, 2 + extras.length) + memoBytes)'), `${file} sizes the memo (and any extra output) into the fee`);
      const send = source.slice(source.indexOf('async sendTransaction('));
      assert.ok(send.indexOf('// Add change output if needed') < send.indexOf('psbt.addOutput({ script: Uint8Array.from(memo), value: 0n });'), `${file}: recipient, change, then the memo`);
    }
    const sol = read('src/services/wallets/SolanaWalletService.js');
    assert.ok(sol.includes("static get MEMO_PROGRAM() { return 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'; }"));
    assert.ok(sol.includes('programId: new PublicKey(SolanaWalletService.MEMO_PROGRAM)'));
  });
});

describe('The gas float', () => {
  test('is off without a key, and on with one', async () => {
    const off = new GasFloatService(null);
    assert.strictEqual(off.enabled(), false);
    assert.strictEqual(await off.canCover('BASE', 0.001), false);
    await assert.rejects(() => off.topUp('BASE', EVM_DEST, 0.001), /No gas float is configured/);
    const key = '0x' + '11'.repeat(32);
    const on = new GasFloatService(key);
    assert.strictEqual(on.enabled(), true);
    assert.strictEqual(on.address, new ethers.Wallet(key).address);
    assert.strictEqual(new GasFloatService('not-a-key').enabled(), false);
  });

  test('covers a shortfall only from a balance that also leaves its own gas', async () => {
    const float = new GasFloatService('0x' + '22'.repeat(32));
    float.balanceOn = async () => 0.001;
    assert.strictEqual(await float.canCover('BASE', 0.0005, 0.0001), true);
    assert.strictEqual(await float.canCover('BASE', 0.0009, 0.0001), false, 'the float keeps two sends of gas for itself');
    assert.strictEqual(await float.canCover('BTC', 0.0005), false, 'not on Bitcoin');
    assert.strictEqual(float.usdOf('BASE', 0.001), 2.624);
  });
});

describe('Planning across chains', () => {
  const GAS = { BASE: 0.00001, BTC: 0.00002, LTC: 0.0001, POL: 0.001 };
  let saved;
  const dexCalls = [];
  const thorCalls = [];
  const shiftCalls = [];

  beforeEach(() => {
    dexCalls.length = 0; thorCalls.length = 0; shiftCalls.length = 0;
    saved = {
      serves: SwapService.sideshift.serves, getGasQuote: SwapService.sideshift.getGasQuote, loadCoins: SwapService.sideshift.loadCoins,
      thorchain: SwapService.thorchain, dex: SwapService.dex, gasFloat: SwapService.gasFloat, estimate: GasEstimator.estimate,
    };
    SwapService.sideshift.loadCoins = async () => null;
    // SideShift: the coins it lists, and USDC on Base
    SwapService.sideshift.serves = (code, symbol) => {
      const chain = chains.get(code);
      const wanted = String(symbol || chain.symbol).toUpperCase();
      return chains.swappable(code) && (wanted === chain.symbol || (code === 'BASE' && wanted === 'USDC'));
    };
    SwapService.sideshift.getGasQuote = async (from, to, amount, fromAsset, toAsset) => {
      shiftCalls.push({ from, to, amount, fromAsset, toAsset });
      const rateIn = SwapService.rateFor(from, fromAsset);
      const rateOut = SwapService.rateFor(to, toAsset);
      const output = (amount * rateIn * 0.98) / rateOut;
      return { outputAmount: output, changeInOutput: output - amount, estimatedGasUsd: amount * rateIn * 0.02, quoteId: 'q1', rate: rateIn / rateOut };
    };
    // THORChain: BTC, LTC, BASE (coin and USDC); pays 1% better than SideShift
    SwapService.thorchain = {
      ready: async () => {},
      serves: (code, symbol) => {
        const chain = chains.get(code);
        const wanted = String(symbol || chain.symbol).toUpperCase();
        if (!['BTC', 'LTC', 'BASE'].includes(code)) return false;
        return wanted === chain.symbol || (code === 'BASE' && wanted === 'USDC');
      },
      quote: async (p) => {
        thorCalls.push(p);
        const rateIn = SwapService.rateFor(p.fromChain, p.fromAsset);
        const rateOut = SwapService.rateFor(p.toChain, p.toAsset);
        const expectedOut = (p.amount * rateIn * 0.99) / rateOut;
        return { provider: 'thorchain', expectedOut, minOut: expectedOut * 0.98, inboundAddress: 'bc1qvault', router: p.fromChain === 'BASE' ? '0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4' : null, memo: `=:x:${p.destination}:1/1/0`, expiry: Math.floor(Date.now() / 1000) + 600, expiresAt: 'soon', recommendedMin: 0.00006, dustThreshold: 0.00001, deposit: p.fromChain === 'BASE' ? 'router' : 'memo', fees: { totalUsd: p.amount * rateIn * 0.01, totalBps: 100 }, totalSeconds: 600 };
      },
    };
    SwapService.dex = {
      quote: async (p) => {
        dexCalls.push(p);
        const rateIn = SwapService.rateFor(p.chain, p.from);
        const rateOut = SwapService.rateFor(p.chain, p.to);
        const amountOut = (p.amount * rateIn * 0.999) / rateOut;
        return { provider: 'kyber', to: p.to, amountOut, minAmountOut: amountOut * 0.995, spreadUsd: p.amount * rateIn * 0.001, impact: 0.001, router: '0xrouter', gasUsd: 0.01, quotedAt: 'now' };
      },
    };
    SwapService.gasFloat = { canCover: async () => false, usdOf: (c, a) => a * PriceService.rateFor(c) };
    GasEstimator.clear();
    GasEstimator.estimate = async (chain) => {
      const native = GAS[chain.toUpperCase()] ?? 0.001;
      return { native, usd: native * PriceService.rateFor(chain), live: true };
    };
  });
  afterEach(() => {
    SwapService.sideshift.serves = saved.serves;
    SwapService.sideshift.getGasQuote = saved.getGasQuote;
    SwapService.sideshift.loadCoins = saved.loadCoins;
    SwapService.thorchain = saved.thorchain;
    SwapService.dex = saved.dex;
    SwapService.gasFloat = saved.gasFloat;
    GasEstimator.estimate = saved.estimate;
    GasEstimator.clear();
  });

  const wallet = (chain, balance, tokenBalances = {}) => ({ chain, address: `${chain}-addr`, balance, balanceUSD: balance * PriceService.rateFor(chain), tokenBalances });

  test('routes: THORChain first where it serves both ends, SideShift as the alternative', () => {
    assert.deepStrictEqual(SwapService.routeFor('BTC', 'BTC', 'BASE', 'ETH'), { kind: 'thorchain', alternatives: ['sideshift'] });
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDC', 'BTC', 'BTC'), { kind: 'thorchain', alternatives: ['sideshift'] });
    // POL is SideShift only
    assert.deepStrictEqual(SwapService.routeFor('POL', 'POL', 'BTC', 'BTC'), { kind: 'sideshift', alternatives: [] });
    // USDT on Base: neither takes it; the coin travels through both
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDT', 'BTC', 'BTC'), { kind: 'dex+thorchain', alternatives: ['dex+sideshift'] });
    assert.strictEqual(SwapService.txCountFor('thorchain', 'BASE', 'USDC'), 2, 'an approval and the router call');
    assert.strictEqual(SwapService.txCountFor('thorchain', 'BASE', 'ETH'), 1);
    assert.strictEqual(SwapService.txCountFor('thorchain', 'BTC', 'BTC'), 1);
    assert.strictEqual(SwapService.txCountFor('dex+thorchain', 'BASE', 'USDT'), 3);
  });

  test("a THORChain leg is not held to SideShift's $5 floor", () => {
    const viaShift = SwapService.minimumBalanceUsd('LTC', 'BASE', 0.05, 0.01);
    const viaThor = SwapService.minimumBalanceUsd('LTC', 'BASE', 0.05, 0.01, 'thorchain');
    assert.ok(viaShift > 5, `SideShift: ${viaShift}`);
    assert.ok(viaThor > 1 && viaThor < 1.5, `THORChain: ${viaThor} - a dollar plus gas; the quote's recommended minimum decides the rest`);
    assert.ok(SwapService.minimumBalanceUsd('LTC', 'BASE', 0.05, 0.01, 'dex+thorchain') < 1.5);
    assert.strictEqual(SwapService.minimumBalanceUsd('LTC', 'LTC', 0.05, 0.01, 'direct'), 0.02 / 0.95);
  });

  test('a Bitcoin wallet paid out on Base: both are quoted, THORChain pays more and wins', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH', EVM_DEST);
    assert.strictEqual(plan.transfers.length, 1);
    const t = plan.transfers[0];
    assert.strictEqual(t.route, 'thorchain');
    assert.strictEqual(t.type, 'SWAP');
    assert.strictEqual(thorCalls.length, 1);
    assert.strictEqual(thorCalls[0].destination, EVM_DEST);
    assert.strictEqual(shiftCalls.length, 1, 'SideShift was quoted too');
    assert.strictEqual(t.crossQuote.provider, 'thorchain');
    assert.strictEqual(t.crossQuote.alternatives[0].provider, 'sideshift');
    assert.ok(t.crossQuote.alternatives[0].outputAmount < t.expectedOutputAmount);
    assert.strictEqual(t.crossQuote.inboundAddress, 'bc1qvault');
    assert.match(t.crossQuote.memo, /^=:x:0x1111/);
    assert.ok(t.swapFeeUsd > 0);
  });

  test('a stated preference takes its provider whenever it serves the pair', async () => {
    // SideShift pays more here; the preference still takes THORChain
    SwapService.thorchain.quote = async (p) => {
      thorCalls.push(p);
      const rateIn = SwapService.rateFor(p.fromChain, p.fromAsset);
      const rateOut = SwapService.rateFor(p.toChain, p.toAsset);
      const expectedOut = (p.amount * rateIn * 0.95) / rateOut;
      return { provider: 'thorchain', expectedOut, minOut: expectedOut, inboundAddress: 'bc1qvault', router: null, memo: 'm', expiry: 1, expiresAt: '', recommendedMin: 0, deposit: 'memo', fees: { totalUsd: 0, totalBps: 0 } };
    };
    const savedPreference = SwapService.preference;
    try {
      SwapService.preference = 'thorchain';
      const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH', EVM_DEST);
      assert.strictEqual(plan.transfers[0].route, 'thorchain');
      assert.strictEqual(plan.transfers[0].crossQuote.preferred, true);
      assert.ok(plan.transfers[0].crossQuote.alternatives[0].outputAmount > plan.transfers[0].expectedOutputAmount, 'the alternative paid more and is recorded');
      SwapService.preference = 'best';
      const best = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH', EVM_DEST);
      assert.strictEqual(best.transfers[0].route, 'sideshift');
    } finally {
      SwapService.preference = savedPreference;
    }
  });

  test('when THORChain refuses, SideShift carries it, and the refusal is kept', async () => {
    SwapService.thorchain.quote = async () => { throw new ThorchainError('THORChain is not taking BTC.BTC right now', 'UNSERVED'); };
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH', EVM_DEST);
    assert.strictEqual(plan.transfers[0].route, 'sideshift');
    assert.deepStrictEqual(plan.transfers[0].crossQuote.refusals, ['thorchain: THORChain is not taking BTC.BTC right now']);
  });

  test('too little for THORChain\'s minimum goes through SideShift instead', async () => {
    SwapService.thorchain.quote = async (p) => ({ expectedOut: 1, minOut: 1, recommendedMin: 5, fees: { totalUsd: 0 }, inboundAddress: 'v', memo: 'm', expiry: 1, expiresAt: '', deposit: 'memo' });
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH', EVM_DEST);
    assert.strictEqual(plan.transfers[0].route, 'sideshift');
    assert.match(plan.transfers[0].crossQuote.refusals[0], /needs at least 5 BTC/);
  });

  test('without a destination THORChain cannot be quoted; SideShift still can', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01)], 0, 'BASE', 'ETH');
    assert.strictEqual(plan.transfers[0].route, 'sideshift');
    assert.strictEqual(thorCalls.length, 0);
  });

  test('USDT on Base to Bitcoin: swapped for ETH on Base, then across through THORChain', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.1, { USDT: 80 })], 0, 'BTC', 'BTC', BTC_DEST);
    const usdt = plan.transfers.find((t) => t.asset === 'USDT');
    assert.strictEqual(usdt.route, 'dex+thorchain');
    assert.strictEqual(usdt.type, 'DEX_THEN_SWAP');
    const pre = dexCalls.find((c) => c.from === 'USDT');
    assert.strictEqual(pre.to, 'ETH');
    // the crossing was quoted on the swap's floor, in the coin
    const crossing = thorCalls.find((c) => c.fromChain === 'BASE' && c.fromAsset === 'ETH' && Math.abs(c.amount - usdt.dexQuote.minAmountOut) < 1e-12);
    assert.ok(crossing, `THORChain was quoted for the coin the swap yields (floor ${usdt.dexQuote.minAmountOut}); quoted amounts: ${thorCalls.map((c) => c.amount).join(', ')}`);
    const eth = plan.transfers.find((t) => t.asset === 'ETH');
    assert.strictEqual(eth.route, 'thorchain');
    // gas: the coin's own deposit (1) plus the token's swap and deposit (3)
    assert.ok(Math.abs(eth.networkReserveNative - GAS.BASE * 1.5 * 4) < 1e-12, eth.networkReserveNative);
  });

  test('the order for a THORChain leg is the quote: a vault, a memo, an expiry, no shift created', async () => {
    const created = [];
    const original = SwapService.sideshift.createOrder;
    SwapService.sideshift.createOrder = async (p) => { created.push(p); return {}; };
    try {
      const details = await SwapService.executeSwap({ chain: 'BTC', asset: 'BTC', wallet: { address: 'bc1qsource' }, recipientAddress: EVM_DEST, payoutChain: 'BASE', payoutAsset: 'ETH', route: 'thorchain', nativeAmount: 0.01 });
      assert.match(details.orderId, /^thor_/);
      assert.strictEqual(details.route, 'thorchain');
      assert.strictEqual(details.thorSwap.inboundAddress, 'bc1qvault');
      assert.match(details.thorSwap.memo, /^=:x:/);
      assert.strictEqual(details.sideshiftOrder.depositAddress, 'bc1qvault', 'the broadcast pays the vault');
      assert.strictEqual(details.sideshiftOrder.type, 'thorchain');
      assert.strictEqual(created.length, 0);
    } finally {
      SwapService.sideshift.createOrder = original;
    }
  });

  test('the float advances the gas a token-only wallet lacks and the token pays it back', async () => {
    const topUps = [];
    SwapService.gasFloat = { canCover: async (chain, amount, perTx) => { topUps.push({ chain, amount, perTx }); return true; }, usdOf: (c, a) => a * PriceService.rateFor(c) };
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0, { USDC: 120 })], 0, 'BASE', 'ETH', EVM_DEST);
    assert.strictEqual(plan.transfers.length, 1);
    const t = plan.transfers[0];
    assert.strictEqual(t.asset, 'USDC');
    assert.strictEqual(t.route, 'dex');
    // two transactions of gas, with the safety margin, and none held
    const need = GAS.BASE * 1.5 * 2;
    assert.ok(Math.abs(t.gasTopUp.amountNative - need) < 1e-12, t.gasTopUp.amountNative);
    assert.ok(Math.abs(t.gasTopUp.usd - need * 2624) < 1e-9);
    assert.ok(Math.abs(t.gasAdvanceUsd - t.gasTopUp.usd) < 1e-12);
    // charged in the token: 5% fee, then the advance at par, then the rest goes
    assert.ok(Math.abs(t.nativeAmount - (120 * 0.95 - t.gasTopUp.usd)) < 1e-9, t.nativeAmount);
    assert.ok(Math.abs(t.gasTopUp.chargedInAsset - t.gasTopUp.usd) < 1e-12, 'a dollar token at par');
    assert.deepStrictEqual(topUps[0], { chain: 'BASE', amount: need, perTx: GAS.BASE * 1.5 });
    assert.deepStrictEqual(plan.skipped, []);
  });

  test('with no float the token stays, as before', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0, { USDC: 120 })], 0, 'BASE', 'ETH', EVM_DEST);
    assert.strictEqual(plan.transfers.length, 0);
    assert.match(plan.skipped[0].reason, /holds 120 USDC but only 0\.000000 ETH/);
  });
});

describe('The payout service', () => {
  test('a THORChain order is watched by its deposit hash', async () => {
    const original = PayoutService.thorchain;
    PayoutService.thorchain = { status: async (hash) => ({ status: hash === '0xdone' ? 'settled' : 'swapping', outTxs: [] }) };
    try {
      const done = await PayoutService.orderStatus('thor_abc', '0xdone', 'BTC');
      assert.strictEqual(done[0].status, 'settled');
      assert.strictEqual(done[0].type, 'thorchain');
      const mid = await PayoutService.orderStatus('thor_abc', '0xmid', 'BTC');
      assert.strictEqual(mid[0].status, 'processing');
      assert.deepStrictEqual(PayoutService.constructor.classifyOrderStatus('settled'), { confirmed: true });
      assert.deepStrictEqual(PayoutService.constructor.classifyOrderStatus('refunded'), { failed: true, reason: 'ORDER_REFUNDED' });
      assert.deepStrictEqual(PayoutService.constructor.classifyOrderStatus('processing'), { pending: true });
      await assert.rejects(() => PayoutService.orderStatus('thor_abc', null, 'BTC'), /requires its deposit hash/);
    } finally {
      PayoutService.thorchain = original;
    }
  });

  test('the broadcast deposits through the router on EVM and with a memo elsewhere, after the float has funded the wallet', () => {
    const source = read('src/services/PayoutService.js');
    const broadcast = source.slice(source.indexOf('async executeAndMonitorTransfers'), source.indexOf('async monitorTransactionConfirmation'));
    assert.ok(broadcast.includes("} else if (transfer.route === 'thorchain') {"));
    assert.ok(broadcast.includes("} else if (transfer.route === 'dex+thorchain') {"));
    assert.ok(broadcast.includes('this.sendThorchainDeposit(transfer, sourceWallet, asset, transfer.nativeAmount, recipientAddress)'));
    assert.ok(broadcast.includes("const tag = transfer.route === 'sideshift' ? order.extraId : null;"), 'a shift deposit carries its tag');
    assert.ok(broadcast.includes('this.sendThorchainDeposit(transfer, sourceWallet, chains.get(transfer.chain).symbol, preSwap.received, recipientAddress)'));
    // the float runs before the leg, and a failed advance stops the leg
    assert.ok(broadcast.indexOf('await this.gasFloat.topUp(transfer.chain, transfer.fromAddress, transfer.gasTopUp.amountNative)') < broadcast.indexOf("if (transfer.route === 'dex') {"));
    assert.ok(broadcast.includes("skip(transfer, 'GAS_ADVANCE_FAILED'"));
    const deposit = source.slice(source.indexOf('async sendThorchainDeposit'), source.indexOf('async orderStatus'));
    assert.ok(deposit.includes('if (isToken) await service.ensureAllowance(wallet.privateKey, token.contract, quote.router, units.toString());'));
    assert.ok(deposit.includes('ThorchainService.ThorchainService.depositCalldata({ vault: quote.inboundAddress, token: token ? token.contract : null, amountUnits: units.toString(), memo: quote.memo, expiry: quote.expiry })'));
    assert.ok(deposit.includes('await service.sendTransaction(wallet.privateKey, quote.inboundAddress, amount, { ...PayoutService.signingKeys(wallet), memo: quote.memo })'));
    assert.ok(deposit.includes("throw new Error('THORChain quote expired before broadcast')"));
    assert.ok(deposit.includes('quote.recommendedMin && Number(amount) < quote.recommendedMin'));
    // the advance is held back with the fee
    assert.ok(source.includes('const feeNative = (Number(transfer.platformFeeNative) || 0) + advance;'));
    // totals
    assert.ok(source.includes('const netAmountUsd = grossSweptUsd - platformFee - totalGasUsd - gasAdvanceUsd;'));
  });
});

describe('The pages and tooling know THORChain', () => {
  test('docs, help, API reference and FAQ name it, from the registry', () => {
    const served = chains.list().filter((c) => chains.thorchainChain(c.code));
    const docs = read('public/js/docs-content.js');
    assert.ok(docs.includes("'<strong>Cross-chain through THORChain</strong>"));
    assert.ok(docs.includes(`title: 'THORChain', body: 'Serves ${served.length} of our chains:`));
    for (const chain of served) assert.ok(docs.includes(chain.name), chain.name);
    const help = read('public/js/help-content.js');
    assert.ok(help.includes("q: 'Does a cross-chain withdrawal go through a custodian?'"));
    assert.ok(help.includes('Not when THORChain serves both ends.'));
    const spec = read('public/js/api-spec.js');
    assert.ok(spec.includes('<code>thorchain</code> (another chain, through THORChain'));
    assert.ok(spec.includes("route: 'thorchain'"));
    assert.ok(spec.includes("'THORChain + SideShift'"));
    for (const chain of chains.list()) {
      const row = new RegExp(`\\['${chain.code}', '${chain.symbol}', '[A-Za-z ]+', '\\d+', '[^']*', '(?:yes|no)', '([^']*)', '[^']*'\\],`).exec(spec);
      assert.ok(row, `${chain.code} row`);
      const expected = chains.crossChainProviders(chain.code).map((p) => (p === 'thorchain' ? 'THORChain' : 'SideShift')).join(' + ') || 'direct only';
      assert.strictEqual(row[1], expected, `${chain.code} cross-chain column`);
    }
    const faq = read('public/faq.html');
    assert.ok(faq.includes('crosses through <strong>THORChain</strong> where it serves both ends'));
    const js = read('public/js/dashboard.js');
    assert.ok(js.includes("case 'thorchain': return"));
    assert.ok(js.includes("case 'dex+thorchain': return"));
    assert.ok(js.includes('Gas advanced'));
  });

  test('the verifier proves the route and the importer writes it', () => {
    const verify = read('scripts/verify-chains.js');
    assert.ok(verify.includes('async function checkThorchain(chain, report)'));
    assert.ok(verify.includes('if (chains.thorchainChain(chain.code)) await checkThorchain(chain, report);'));
    const add = read('scripts/add-chain.js');
    assert.ok(add.includes('async function thorchainFor(entry)'));
    assert.ok(add.includes('thorchain: await thorchainFor(entry),'));
  });
});
