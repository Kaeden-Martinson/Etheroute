/**
 * On-chain swaps and token payouts.
 *
 * A dollar token is swept like the coin. On its own chain it is swapped
 * through an aggregator's router contract that the wallet calls itself
 * (DexService); across chains it is shifted where SideShift takes it, or
 * swapped for the chain's coin first. Every route is chosen by
 * SwapService.routeFor and planned per holding.
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
const Dex = require('../src/services/DexService');
const { DexService, DexError, NATIVE, SLIPPAGE_BPS } = Dex;
const SwapService = require('../src/services/SwapService');
const SideshiftService = require('../src/services/SideshiftService');
const GasEstimator = require('../src/services/GasEstimator');
const PriceService = require('../src/services/PriceService');
const PayoutService = require('../src/services/PayoutService');

const SENDER = '0x4e58c1183b91df3708FB5861ff3531dc128E6e11';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const USDC_BASE = chains.tokenOf('BASE', 'USDC').contract;
const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const AUGUSTUS = '0x6a000f20005980200259b80c5102003040001068';

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

// ── a fetch that plays both aggregators ──────────────────────────────────────
function fakeFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      for (const [pattern, reply] of handlers) {
        if (String(url).includes(pattern)) {
          const body = typeof reply === 'function' ? reply(url, init) : reply;
          if (body instanceof Error) return { ok: false, status: 500, text: async () => JSON.stringify({ message: body.message }) };
          return { ok: true, status: 200, text: async () => JSON.stringify(body) };
        }
      }
      return { ok: false, status: 404, text: async () => 'no handler' };
    },
  };
}

// 0.01 ETH -> 26.27 USDC on Base, as Kyber answers it
const KYBER_ROUTES = { code: 0, data: { routeSummary: { amountIn: '10000000000000000', amountOut: '26270551', amountInUsd: '26.24', amountOutUsd: '26.24', gas: '549248', gasUsd: '0.0107' }, routerAddress: KYBER_ROUTER } };
const KYBER_BUILD = { code: 0, data: { amountIn: '10000000000000000', amountOut: '26270551', amountInUsd: '26.24', amountOutUsd: '26.24', gas: '549248', gasUsd: '0.0107', data: '0xe21fd0e9deadbeef', routerAddress: KYBER_ROUTER } };
// the same swap as ParaSwap prices it, a shade worse
const PARASWAP_PRICES = { priceRoute: { srcAmount: '10000000000000000', destAmount: '26200000', srcUSD: '26.24', destUSD: '26.17', gasCost: '300000', gasCostUSD: '0.006', contractAddress: AUGUSTUS, tokenTransferProxy: AUGUSTUS } };
const PARASWAP_TX = { to: AUGUSTUS, data: '0xparaswapcalldata', value: '10000000000000000' };

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  PriceService.ethToUsdRate = 2624;
  PriceService.btcToUsdRate = 60000;
  PriceService.baseToUsdRate = 2624;
  PriceService.bnbToUsdRate = 600;
  PriceService.scrollToUsdRate = 2624;
});
afterEach(() => { global.fetch = realFetch; });

describe('The registry says where on-chain swaps run', () => {
  test('dex names the aggregators, and only on EVM chains with a dollar token', () => {
    const served = chains.list().filter((c) => chains.swappableOnChain(c.code));
    assert.ok(served.length >= 15, `${served.length} chains with on-chain swaps`);
    for (const chain of served) {
      assert.strictEqual(chain.family, 'evm', `${chain.code} must be EVM`);
      assert.ok(chains.tokensOf(chain.code).length > 0, `${chain.code} must carry a dollar token to route`);
      const dex = chains.dexOf(chain.code);
      for (const [provider, key] of Object.entries(dex)) {
        assert.ok(['kyber', 'paraswap'].includes(provider), `${chain.code}: unknown aggregator ${provider}`);
        if (provider === 'kyber') assert.match(key, /^[a-z0-9-]+$/, `${chain.code}: kyber wants a slug`);
        if (provider === 'paraswap') assert.strictEqual(key, true);
      }
    }
    for (const code of ['BTC', 'LTC', 'SOL', 'SCROLL']) {
      assert.strictEqual(chains.swappableOnChain(code), false, `${code} has no on-chain route`);
      assert.strictEqual(chains.dexOf(code), null);
    }
  });

  test('the founding EVM chains all have one, and the public info says so', () => {
    for (const code of ['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX']) {
      assert.strictEqual(chains.publicInfo(chains.get(code)).onChainSwaps, true, code);
    }
    assert.strictEqual(chains.publicInfo(chains.get('BTC')).onChainSwaps, false);
  });
});

describe('DexService quotes through the aggregators', () => {
  test('a coin-to-token swap on Base: Kyber routes it, the calldata carries the value, no approval', async () => {
    const fake = fakeFetch([
      ['kyberswap.com/base/api/v1/routes', KYBER_ROUTES],
      ['kyberswap.com/base/api/v1/route/build', KYBER_BUILD],
      ['paraswap.io/prices', PARASWAP_PRICES],
      ['paraswap.io/transactions/8453', PARASWAP_TX],
    ]);
    global.fetch = fake.fetch;
    const dex = new DexService();
    const quote = await dex.quote({ chain: 'BASE', from: 'ETH', to: 'USDC', amount: 0.01, sender: SENDER, recipient: RECIPIENT });

    assert.strictEqual(quote.provider, 'kyber', 'Kyber pays more net of gas');
    assert.strictEqual(quote.amountIn, 0.01);
    assert.strictEqual(quote.amountInUnits, '10000000000000000');
    assert.strictEqual(quote.amountOut, 26.270551);
    assert.strictEqual(quote.amountOutUnits, '26270551');
    // the floor is half a percent under, in units
    assert.strictEqual(quote.minAmountOutUnits, String((26270551n * BigInt(10000 - SLIPPAGE_BPS)) / 10000n));
    assert.strictEqual(quote.slippageBps, 50);
    assert.strictEqual(quote.tx.to, KYBER_ROUTER);
    assert.strictEqual(quote.tx.value, '10000000000000000', 'the coin rides as value');
    assert.strictEqual(quote.approval, null, 'the coin needs no approval');
    assert.strictEqual(quote.alternatives.length, 1);
    assert.strictEqual(quote.alternatives[0].provider, 'paraswap');
    assert.deepStrictEqual(quote.failures, []);

    // the build asked for the sender and recipient we gave, with the slippage and a deadline
    const build = fake.calls.find((c) => c.url.includes('route/build'));
    const body = JSON.parse(build.init.body);
    assert.strictEqual(body.sender, SENDER);
    assert.strictEqual(body.recipient, RECIPIENT);
    assert.strictEqual(body.slippageTolerance, SLIPPAGE_BPS);
    assert.ok(body.deadline > Math.floor(Date.now() / 1000), 'a deadline in the future');
    assert.strictEqual(build.init.headers['x-client-id'], 'etheroute');
  });

  test('a token-to-coin swap names the token approval for exactly the amount, to the router that takes it', async () => {
    const routes = { code: 0, data: { routeSummary: { amountIn: '25000000', amountOut: '9518911444505432', amountInUsd: '25', amountOutUsd: '24.98', gas: '500000', gasUsd: '0.0067' }, routerAddress: KYBER_ROUTER } };
    const build = { code: 0, data: { amountOut: '9518911444505432', amountInUsd: '25', amountOutUsd: '24.98', gas: '500000', gasUsd: '0.0067', data: '0xcalldata', routerAddress: KYBER_ROUTER } };
    global.fetch = fakeFetch([['routes', routes], ['route/build', build], ['paraswap', new Error('down')]]).fetch;
    const quote = await new DexService().quote({ chain: 'BASE', from: 'USDC', to: 'ETH', amount: 25, sender: SENDER });

    assert.strictEqual(quote.provider, 'kyber');
    assert.strictEqual(quote.recipient, SENDER, 'the sender by default');
    assert.deepStrictEqual(quote.approval, { token: USDC_BASE, spender: KYBER_ROUTER, amountUnits: '25000000' });
    assert.strictEqual(quote.tx.value, '0', 'a token swap sends no value');
    assert.strictEqual(quote.amountOut, 0.009518911444505432);
    assert.ok(quote.spreadUsd > 0 && quote.spreadUsd < 0.05, `spread $${quote.spreadUsd}`);
    assert.deepStrictEqual(quote.failures, ['paraswap: HTTP 500 - down']);
  });

  test('ParaSwap wins when it nets more, and its proxy is the spender', async () => {
    const better = { priceRoute: { ...PARASWAP_PRICES.priceRoute, destAmount: '26400000', destUSD: '26.40' } };
    global.fetch = fakeFetch([
      ['routes', KYBER_ROUTES], ['route/build', KYBER_BUILD],
      ['paraswap.io/prices', better], ['paraswap.io/transactions/8453', PARASWAP_TX],
    ]).fetch;
    const quote = await new DexService().quote({ chain: 'BASE', from: 'ETH', to: 'USDC', amount: 0.01, sender: SENDER });
    assert.strictEqual(quote.provider, 'paraswap');
    assert.strictEqual(quote.amountOut, 26.4);
    assert.strictEqual(quote.tx.to, AUGUSTUS);
    assert.strictEqual(quote.tx.data, '0xparaswapcalldata');
  });

  test('a thin pool is refused rather than settled at a loss', async () => {
    const thin = { code: 0, data: { routeSummary: { amountIn: '10000000000000000', amountOut: '24000000', amountInUsd: '26.24', amountOutUsd: '24.00', gas: '1', gasUsd: '0.01' }, routerAddress: KYBER_ROUTER } };
    const build = { code: 0, data: { amountOut: '24000000', amountInUsd: '26.24', amountOutUsd: '24.00', gas: '1', gasUsd: '0.01', data: '0x00', routerAddress: KYBER_ROUTER } };
    global.fetch = fakeFetch([['routes', thin], ['route/build', build], ['paraswap', new Error('down')]]).fetch;
    await assert.rejects(
      () => new DexService().quote({ chain: 'BASE', from: 'ETH', to: 'USDC', amount: 0.01, sender: SENDER }),
      (error) => error instanceof DexError && error.code === 'PRICE_IMPACT' && /8\.5% to price impact/.test(error.message)
    );
  });

  test('no aggregator, no route, the same asset and a bad address are each refused by name', async () => {
    global.fetch = fakeFetch([['kyberswap', { code: 4000, message: 'no route found' }], ['paraswap', new Error('No routes found')]]).fetch;
    const dex = new DexService();
    await assert.rejects(() => dex.quote({ chain: 'SCROLL', from: 'ETH', to: 'USDC', amount: 1, sender: SENDER }), (e) => e.code === 'NO_DEX');
    await assert.rejects(() => dex.quote({ chain: 'BASE', from: 'ETH', to: 'USDC', amount: 1, sender: SENDER }), (e) => e.code === 'NO_ROUTE' && /kyber: no route found/.test(e.message));
    await assert.rejects(() => dex.quote({ chain: 'BASE', from: 'USDC', to: 'USDC', amount: 1, sender: SENDER }), (e) => e.code === 'SAME_ASSET');
    await assert.rejects(() => dex.quote({ chain: 'BASE', from: 'ETH', to: 'USDC', amount: 1, sender: 'nope' }), (e) => e.code === 'BAD_ADDRESS');
    await assert.rejects(() => dex.quote({ chain: 'BASE', from: 'ETH', to: 'DAI', amount: 1, sender: SENDER }), (e) => e.code === 'UNKNOWN_ASSET');
  });

  test('assets are named the way the aggregators name them', () => {
    const dex = new DexService();
    assert.deepStrictEqual(dex.assetOn('BASE', 'ETH'), { symbol: 'ETH', address: NATIVE, decimals: 18, native: true });
    assert.deepStrictEqual(dex.assetOn('BASE', 'usdc'), { symbol: 'USDC', address: USDC_BASE, decimals: 6, native: false });
    assert.strictEqual(dex.usdRate('BASE', 'USDC'), 1, 'a dollar token is a dollar');
    assert.strictEqual(dex.usdRate('BASE', 'ETH'), 2624);
    assert.deepStrictEqual(dex.providersFor('BASE').map((p) => p.name), ['kyber', 'paraswap']);
    assert.deepStrictEqual(dex.providersFor('LINEA').map((p) => p.name), ['kyber']);
    assert.deepStrictEqual(dex.providersFor('BTC'), []);
  });
});

describe('SideShift knows its tokens', () => {
  const COINS = [
    { coin: 'ETH', networks: ['ethereum', 'base', 'arbitrum'], depositOffline: [], settleOffline: [] },
    { coin: 'USDC', networks: ['ethereum', 'base', 'bsc', 'polygon'], depositOffline: ['polygon'], settleOffline: [] },
    { coin: 'USDT', networks: ['ethereum', 'bsc'], depositOffline: false, settleOffline: false },
    { coin: 'BTC', networks: ['bitcoin'], depositOffline: false, settleOffline: false },
    { coin: 'DAI', networks: ['ethereum'], depositOffline: true, settleOffline: false },
  ];

  test('serves() reads the live coin list for tokens and the registry for coins', async () => {
    const service = new SideshiftService(PriceService);
    service.http = { get: async (url) => { assert.strictEqual(url, '/coins'); return { data: COINS }; } };
    await service.loadCoins();
    assert.strictEqual(service.serves('BASE'), true, 'the coin is a registry fact');
    assert.strictEqual(service.serves('BASE', 'USDC'), true);
    assert.strictEqual(service.serves('BASE', 'USDT'), false, 'USDT on Base is not in the list');
    assert.strictEqual(service.serves('POL', 'USDC'), false, 'an offline network is not served');
    assert.strictEqual(service.serves('BNB', 'USDT'), true);
    assert.strictEqual(service.serves('SCROLL'), false, 'no sideshift entry at all');
    assert.strictEqual(service.serves('BNB', 'USDC'), true, 'a coin whose flags are plain false is on');
    assert.deepStrictEqual(service.asset('BASE', 'USDC'), { coin: 'usdc', network: 'base' });
    assert.deepStrictEqual(service.asset('BASE'), { coin: 'eth', network: 'base' });
    assert.throws(() => service.asset('BASE', 'USDT'), /does not take USDT on Base/);
    assert.throws(() => service.asset('SCROLL'), /not served by SideShift/);
  });

  test('a token is priced at par, a coin at its rate', () => {
    const service = new SideshiftService(PriceService);
    assert.strictEqual(service.usdRate('BASE', 'USDC'), 1);
    assert.strictEqual(service.usdRate('BASE'), 2624);
    assert.strictEqual(service.usdRate('BASE', 'ETH'), 2624);
  });

  test('an on-chain order id is a direct transfer or a dex swap', () => {
    assert.strictEqual(SideshiftService.isOnChainOrder('direct_transfer_abc'), true);
    assert.strictEqual(SideshiftService.isOnChainOrder('dex_swap_abc'), true);
    assert.strictEqual(SideshiftService.isOnChainOrder('3f9a1c'), false);
    assert.strictEqual(SideshiftService.isOnChainOrder(null), false);
  });
});

// THORChain out of the picture: these tests are about the other routes.
const NO_THOR = { ready: async () => {}, serves: () => false, quote: async () => { throw new Error('off'); } };

describe('Every holding takes a route', () => {
  let originalServes;
  let originalThor;
  beforeEach(() => {
    originalServes = SwapService.sideshift.serves;
    originalThor = SwapService.thorchain;
    SwapService.thorchain = NO_THOR;
    // SideShift takes the coins it lists, and USDC on Base and BNB, and USDT on BNB
    SwapService.sideshift.serves = (code, symbol) => {
      const chain = chains.get(code);
      const wanted = String(symbol || chain.symbol).toUpperCase();
      if (!chains.swappable(code)) return false;
      if (wanted === chain.symbol) return true;
      return (code === 'BASE' && wanted === 'USDC') || (code === 'BNB' && ['USDC', 'USDT'].includes(wanted));
    };
  });
  afterEach(() => { SwapService.sideshift.serves = originalServes; SwapService.thorchain = originalThor; });

  test('the same asset on the same chain is direct', () => {
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'ETH', 'BASE', 'ETH'), { kind: 'direct' });
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDC', 'BASE', 'USDC'), { kind: 'direct' });
    assert.deepStrictEqual(SwapService.routeFor('BTC', 'BTC', 'BTC', 'BTC'), { kind: 'direct' });
  });

  test('another asset on the same chain is an on-chain swap where one runs', () => {
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDC', 'BASE', 'ETH'), { kind: 'dex' });
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'ETH', 'BASE', 'USDT'), { kind: 'dex' });
    const none = SwapService.routeFor('SCROLL', 'USDC', 'SCROLL', 'ETH');
    assert.strictEqual(none.kind, 'none');
    assert.match(none.reason, /Scroll has no on-chain swap route yet, so USDC there can only be cashed out as USDC/);
  });

  test('another chain is a shift where SideShift takes both ends', () => {
    assert.deepStrictEqual(SwapService.routeFor('BTC', 'BTC', 'BASE', 'ETH'), { kind: 'sideshift', alternatives: [] });
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDC', 'BTC', 'BTC'), { kind: 'sideshift', alternatives: [] });
    assert.deepStrictEqual(SwapService.routeFor('BTC', 'BTC', 'BNB', 'USDT'), { kind: 'sideshift', alternatives: [] });
  });

  test('a token SideShift will not take is swapped for the coin first, when the chain can', () => {
    assert.deepStrictEqual(SwapService.routeFor('BASE', 'USDT', 'BTC', 'BTC'), { kind: 'dex+sideshift', alternatives: [] });
    // Scroll: SideShift takes nothing there and there is no dex either
    const none = SwapService.routeFor('SCROLL', 'USDC', 'BTC', 'BTC');
    assert.strictEqual(none.kind, 'none');
    assert.match(none.reason, /USDC on Scroll has no swap route off the chain; it can be cashed out as USDC on Scroll/);
  });

  test('a destination SideShift cannot settle says so, for a coin and for a token', () => {
    const coin = SwapService.routeFor('BTC', 'BTC', 'SCROLL', 'ETH');
    assert.strictEqual(coin.kind, 'none');
    assert.match(coin.reason, /Scroll has no swap route; only a wallet already on it/);
    const token = SwapService.routeFor('BTC', 'BTC', 'BASE', 'USDT');
    assert.strictEqual(token.kind, 'none');
    assert.match(token.reason, /No swap route settles USDT on Base/);
  });
});

describe('Planning sweeps tokens with the coin', () => {
  const GAS = { BASE: 0.00001, BTC: 0.00002, SCROLL: 0.00001 };
  let originalServes, originalQuote, originalDex, originalEstimate, originalLoad, originalThor;
  const dexCalls = [];

  beforeEach(() => {
    dexCalls.length = 0;
    originalThor = SwapService.thorchain;
    SwapService.thorchain = NO_THOR;
    originalServes = SwapService.sideshift.serves;
    originalQuote = SwapService.sideshift.getGasQuote;
    originalLoad = SwapService.sideshift.loadCoins;
    originalDex = SwapService.dex;
    originalEstimate = GasEstimator.estimate;
    SwapService.sideshift.loadCoins = async () => null;
    SwapService.sideshift.serves = (code, symbol) => {
      const chain = chains.get(code);
      const wanted = String(symbol || chain.symbol).toUpperCase();
      return chains.swappable(code) && (wanted === chain.symbol || (code === 'BASE' && wanted === 'USDC'));
    };
    SwapService.sideshift.getGasQuote = async (from, to, amount, fromAsset, toAsset) => {
      const rateIn = SwapService.rateFor(from, fromAsset);
      const rateOut = SwapService.rateFor(to, toAsset);
      const output = (amount * rateIn * 0.98) / rateOut;
      return { outputAmount: output, changeInOutput: output - amount, estimatedGasUsd: amount * rateIn * 0.02 };
    };
    SwapService.dex = {
      quote: async (p) => {
        dexCalls.push(p);
        const rateIn = SwapService.rateFor(p.chain, p.from);
        const rateOut = SwapService.rateFor(p.chain, p.to);
        const amountOut = (p.amount * rateIn * 0.999) / rateOut;
        return { provider: 'kyber', to: p.to, amountOut, minAmountOut: amountOut * 0.995, amountInUsd: p.amount * rateIn, amountOutUsd: amountOut * rateOut, spreadUsd: p.amount * rateIn * 0.001, impact: 0.001, router: KYBER_ROUTER, gasUsd: 0.01, quotedAt: 'now' };
      },
    };
    GasEstimator.clear();
    GasEstimator.estimate = async (chain) => {
      const native = GAS[chain.toUpperCase()] ?? 0.001;
      return { native, usd: native * PriceService.rateFor(chain), live: true };
    };
  });
  afterEach(() => {
    SwapService.sideshift.serves = originalServes;
    SwapService.sideshift.getGasQuote = originalQuote;
    SwapService.sideshift.loadCoins = originalLoad;
    SwapService.dex = originalDex;
    SwapService.thorchain = originalThor;
    GasEstimator.estimate = originalEstimate;
    GasEstimator.clear();
  });

  const wallet = (chain, balance, tokenBalances = {}) => ({ chain, address: `${chain}-addr`, balance, balanceUSD: balance * PriceService.rateFor(chain), tokenBalances });

  test('a wallet holding ETH and USDC on Base, paid in ETH on Base: one direct leg, one on-chain swap', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.1, { USDC: 120, USDT: 0 })], 0, 'BASE', 'ETH', RECIPIENT);
    assert.strictEqual(plan.payoutAsset, 'ETH');
    assert.strictEqual(plan.transfers.length, 2);
    const [eth, usdc] = plan.transfers;
    assert.strictEqual(eth.asset, 'ETH');
    assert.strictEqual(eth.route, 'direct');
    assert.strictEqual(eth.type, 'DIRECT_TRANSFER');
    assert.strictEqual(usdc.asset, 'USDC');
    assert.strictEqual(usdc.route, 'dex');
    assert.strictEqual(usdc.type, 'DEX_SWAP');
    assert.strictEqual(usdc.payoutAsset, 'ETH');
    // the coin keeps back its own send plus the token's approval and swap
    const perTx = GAS.BASE * 1.5;
    assert.ok(Math.abs(eth.networkReserveNative - perTx * 3) < 1e-12, `reserve ${eth.networkReserveNative}`);
    assert.strictEqual(usdc.networkReserveNative, 0, 'a token has no reserve of its own');
    // the token leg: all of it swapped, quoted to the recipient - the
    // platform's share came off the payment that brought it in
    assert.strictEqual(usdc.nativeAmount, 120);
    assert.strictEqual(usdc.platformFeeNative, 0);
    assert.strictEqual(usdc.platformFeeUSD, 0);
    assert.strictEqual(dexCalls.length, 1);
    assert.strictEqual(dexCalls[0].recipient, RECIPIENT);
    assert.strictEqual(dexCalls[0].sender, 'BASE-addr');
    assert.strictEqual(dexCalls[0].from, 'USDC');
    assert.strictEqual(dexCalls[0].to, 'ETH');
    assert.ok(usdc.swapFeeUsd > 0, 'the spread is its own figure');
    assert.ok(Math.abs(usdc.gasUsd - GAS.BASE * 2624 * 2) < 1e-9, 'two transactions of gas');
    assert.ok(Math.abs(usdc.estimatedGas - (usdc.gasUsd + usdc.swapFeeUsd)) < 1e-12, 'the cost line is both');
    assert.strictEqual(usdc.dexQuote.provider, 'kyber');
    assert.strictEqual(usdc.dexQuote.router, KYBER_ROUTER);
    assert.deepStrictEqual(plan.skipped, []);
  });

  test('paid in USDC on Base: the coin is swapped on-chain, the USDC goes direct', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.1, { USDC: 120 })], 0, 'BASE', 'USDC', RECIPIENT);
    const eth = plan.transfers.find((t) => t.asset === 'ETH');
    const usdc = plan.transfers.find((t) => t.asset === 'USDC');
    assert.strictEqual(eth.route, 'dex');
    assert.strictEqual(usdc.route, 'direct');
    assert.strictEqual(dexCalls[0].from, 'ETH');
    assert.strictEqual(dexCalls[0].to, 'USDC');
    assert.ok(eth.expectedOutputAmount > 200, `${eth.expectedOutputAmount} USDC for ~0.1 ETH`);
  });

  test('a token-only wallet cannot move its token, and the reason names the gas it lacks', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0, { USDC: 120 })], 0, 'BASE', 'ETH', RECIPIENT);
    assert.strictEqual(plan.transfers.length, 0);
    assert.strictEqual(plan.skipped.length, 1);
    assert.strictEqual(plan.skipped[0].asset, 'USDC');
    assert.match(plan.skipped[0].reason, /holds 120 USDC but only 0\.000000 ETH; sending it needs about 0\.000030 ETH/);
    assert.strictEqual(dexCalls.length, 0, 'nothing was quoted');
  });

  test('a little coin is kept for the tokens\' gas rather than swept', async () => {
    // 0.00004 ETH covers the token's two transactions (0.00003) but not a send of its own as well
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.00004, { USDC: 120 })], 0, 'BASE', 'ETH', RECIPIENT);
    assert.strictEqual(plan.transfers.length, 1);
    assert.strictEqual(plan.transfers[0].asset, 'USDC');
    assert.strictEqual(plan.transfers[0].route, 'dex');
    assert.ok(plan.skipped.some((k) => k.asset === 'ETH'), 'the coin is listed as staying behind');
  });

  test('USDC on Base to Bitcoin is one shift; USDT on Base is swapped for ETH first, then shifted', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.1, { USDC: 120, USDT: 80 })], 0, 'BTC', 'BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    const byAsset = Object.fromEntries(plan.transfers.map((t) => [t.asset, t]));
    assert.strictEqual(byAsset.ETH.route, 'sideshift');
    assert.strictEqual(byAsset.USDC.route, 'sideshift');
    assert.strictEqual(byAsset.USDC.type, 'SWAP');
    assert.strictEqual(byAsset.USDT.route, 'dex+sideshift');
    assert.strictEqual(byAsset.USDT.type, 'DEX_THEN_SWAP');
    // the pre-swap is quoted to the wallet itself, to the chain's coin
    const pre = dexCalls.find((c) => c.from === 'USDT');
    assert.strictEqual(pre.to, 'ETH');
    assert.strictEqual(pre.recipient, 'BASE-addr');
    assert.ok(byAsset.USDT.expectedOutputAmount > 0.001, `${byAsset.USDT.expectedOutputAmount} BTC`);
    // the coin reserved gas for 1 + 1 + 3 transactions
    assert.ok(Math.abs(byAsset.ETH.networkReserveNative - GAS.BASE * 1.5 * 5) < 1e-12, byAsset.ETH.networkReserveNative);
  });

  test('a chain with no on-chain route leaves the token behind and says why', async () => {
    const plan = await SwapService.planBatchWithdrawal([wallet('SCROLL', 0.1, { USDC: 50 })], 0, 'SCROLL', 'ETH', RECIPIENT);
    assert.strictEqual(plan.transfers.length, 1);
    assert.strictEqual(plan.transfers[0].asset, 'ETH');
    assert.match(plan.skipped[0].reason, /Scroll has no on-chain swap route yet/);
  });

  test('an aggregator that refuses the leg skips it with its own words', async () => {
    SwapService.dex = { quote: async () => { throw new DexError('would lose 8.5% to price impact', 'PRICE_IMPACT'); } };
    const plan = await SwapService.planBatchWithdrawal([wallet('BASE', 0.1, { USDC: 120 })], 0, 'BASE', 'ETH', RECIPIENT);
    assert.strictEqual(plan.transfers.length, 1, 'the coin still goes');
    assert.match(plan.skipped[0].reason, /8\.5% to price impact/);
  });

  test('the orders: a dex leg needs none, a shift after a swap is variable-rate in the coin', async () => {
    const original = SwapService.sideshift.createOrder;
    const orders = [];
    SwapService.sideshift.createOrder = async (p) => { orders.push(p); return { orderId: 'shift-1', type: 'variable', depositAddress: 'bc1qdeposit', depositMin: 0.0001, depositMax: 1 }; };
    try {
      const dex = await SwapService.executeSwap({ chain: 'BASE', asset: 'USDC', wallet: { address: SENDER }, recipientAddress: RECIPIENT, payoutChain: 'BASE', payoutAsset: 'ETH', route: 'dex', nativeAmount: 100 });
      assert.match(dex.orderId, /^dex_swap_/);
      assert.strictEqual(dex.route, 'dex');
      assert.deepStrictEqual(dex.dexSwap, { chain: 'BASE', from: 'USDC', to: 'ETH', recipient: RECIPIENT });
      assert.strictEqual(dex.sideshiftOrder.depositAddress, RECIPIENT);
      assert.strictEqual(orders.length, 0);

      const two = await SwapService.executeSwap({ chain: 'BASE', asset: 'USDT', wallet: { address: SENDER }, recipientAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', payoutChain: 'BTC', payoutAsset: 'BTC', route: 'dex+sideshift', nativeAmount: 80 });
      assert.strictEqual(two.route, 'dex+sideshift');
      assert.strictEqual(two.orderId, 'shift-1');
      assert.deepStrictEqual(two.dexSwap, { chain: 'BASE', from: 'USDT', to: 'ETH', recipient: SENDER });
      assert.strictEqual(two.sideshiftOrder.depositAsset, 'ETH', 'the shift takes the coin the swap yields');
      assert.strictEqual(orders.length, 1);
      assert.strictEqual(orders[0].fromAsset, 'ETH');
      assert.strictEqual(orders[0].toAsset, 'BTC');
      assert.strictEqual(orders[0].quote, undefined, 'variable: the swap decides the deposit');
    } finally {
      SwapService.sideshift.createOrder = original;
    }
  });
});

describe('The payout service moves tokens', () => {
  test('the payout asset is checked against the chain', () => {
    assert.strictEqual(PayoutService.resolvePayoutAsset('BASE', undefined), 'ETH');
    assert.strictEqual(PayoutService.resolvePayoutAsset('BASE', 'usdc'), 'USDC');
    assert.strictEqual(PayoutService.resolvePayoutAsset('BTC', ''), 'BTC');
    assert.throws(() => PayoutService.resolvePayoutAsset('BTC', 'USDC'), /payoutAsset must be one of BTC for Bitcoin/);
    assert.throws(() => PayoutService.resolvePayoutAsset('BASE', 'DAI'), /must be one of ETH, USDC, USDT for Base/);
  });

  test('what a swap yields is clamped to the shift it feeds', () => {
    assert.strictEqual(PayoutService.clampToShift(0.05, { depositMin: 0.001, depositMax: 1 }), 0.05);
    assert.strictEqual(PayoutService.clampToShift(0.0005, { depositMin: 0.001, depositMax: 1 }), null);
    assert.strictEqual(PayoutService.clampToShift(2, { depositMin: 0.001, depositMax: 1 }), 1);
    assert.strictEqual(PayoutService.clampToShift(0, {}), null);
  });

  test('the broadcast branches on the route, and a token send goes through the token sender', () => {
    const source = read('src/services/PayoutService.js');
    const broadcast = source.slice(source.indexOf('async executeAndMonitorTransfers'), source.indexOf('async monitorTransactionConfirmation'));
    assert.ok(broadcast.includes("if (transfer.route === 'dex') {"));
    assert.ok(broadcast.includes("} else if (transfer.route === 'dex+sideshift') {"));
    assert.ok(broadcast.includes('this.sendDexSwap(transfer, sourceWallet, asset, transfer.payoutAsset, depositAddress, transfer.nativeAmount)'));
    assert.ok(broadcast.includes('this.swapToCoin(transfer, sourceWallet, asset, transfer.nativeAmount)'));
    assert.ok(broadcast.includes('this.clampToShift(preSwap.received, order)'));
    assert.ok(broadcast.includes("skip(transfer, 'BELOW_SHIFT_MINIMUM'"));
    // a token's balance is read as a token before the send
    assert.ok(broadcast.includes('await walletService.getTokenBalances(transfer.fromAddress)'));
    // the record names the asset, the route, and a pre-swap when there was one
    assert.strictEqual((broadcast.match(/\{ asset, route: transfer\.route, preSwapTxHash: preSwap && preSwap\.hash \}/g) || []).length, 3);
    // the sender

    assert.ok(source.includes('? await service.sendToken(wallet.privateKey, asset, toAddress, amount)'));
    assert.ok(source.includes('async sendTransfer(chain, wallet, toAddress, amount, asset = null, options = {}) {'));
    // the swap re-quotes fresh and approves exactly the amount first
    const swap = source.slice(source.indexOf('async sendDexSwap'), source.indexOf('async swapToCoin'));
    assert.ok(swap.includes('this.swapService.dex.quote({ chain: transfer.chain, from, to, amount, sender: wallet.address, recipient })'));
    assert.ok(swap.includes('service.ensureAllowance(wallet.privateKey, quote.approval.token, quote.approval.spender, quote.approval.amountUnits)'));
    assert.ok(swap.includes('service.sendCall(wallet.privateKey, { to: quote.tx.to, data: quote.tx.data, value: quote.tx.value, gasLimit }'));
    // a token's fee is held in the token
    assert.ok(source.includes('serviceSubtractionsTokens'));
    // the maintenance reconcile treats a dex swap like a direct transfer
    assert.ok(source.includes('SideshiftService.isOnChainOrder(transaction.orderId)'));
  });

  test('the EVM wallet service can approve, transfer a token and send calldata', () => {
    const source = read('src/services/wallets/EvmWalletService.js');
    assert.ok(source.includes("'function transfer(address to, uint256 amount) returns (bool)'"));
    assert.ok(source.includes("'function approve(address spender, uint256 amount) returns (bool)'"));
    assert.ok(source.includes('async sendCall(privateKey, { to, data, value = 0n, gasLimit = null }, what = \'call\')'));
    assert.ok(source.includes('async sendToken(privateKey, symbol, toAddress, amount)'));
    assert.ok(source.includes('async ensureAllowance(privateKey, tokenAddress, spender, amountUnits)'));
    assert.ok(source.includes('if (current >= wanted) return null;'), 'an allowance that already covers it is not re-sent');
    assert.ok(source.includes('await this.waitForReceipt(sent.hash)'), 'the approval is mined before the swap');
    // the balance check covers value plus gas at the cap
    assert.ok(source.includes('const need = valueWei + cap * limit;'));
  });

  test('the wallets route holds a token\'s fee back the way it holds the coin\'s', () => {
    const source = read('src/routes/wallets.js');
    assert.ok(source.includes('const feesHeld = wallet.serviceSubtractionsTokens || {};'));
    assert.ok(source.includes('platformFeeHeld: feeHeldToken'));
    assert.ok(!source.includes('Nothing moves a token out yet'));
  });

  test('the withdrawal routes take payoutAsset and check it against the chain', () => {
    const source = read('src/routes/withdrawal.js');
    assert.ok(source.includes('function resolvePayoutAsset(raw, payoutChain)'));
    assert.strictEqual((source.match(/resolvePayoutAsset\(req\.body\.payoutAsset, payoutChain\)/g) || []).length, 2);
    assert.ok(source.includes('payoutAsset: payout.payoutAsset,'));
    const payouts = read('src/routes/payouts.js');
    assert.ok(payouts.includes('payoutAsset: payout.payoutAsset || null,'));
    const tx = read('src/services/TransactionService.js');
    assert.ok(tx.includes('asset: extra.asset || null,'));
    assert.ok(tx.includes('preSwapTxHash: extra.preSwapTxHash || null,'));
  });
});

describe('The pages say it', () => {
  test('the withdrawal page offers the asset on chains that carry tokens', () => {
    const html = read('public/dashboard.html');
    assert.ok(html.includes('id="payoutAssetField" hidden'));
    assert.ok(html.includes('id="payoutAssetPick" data-on-change="onPayoutAssetChange"'));
    const js = read('public/js/dashboard.js');
    assert.ok(js.includes('function selectedPayoutAsset()'));
    assert.ok(js.includes('function renderPayoutAssetPick()'));
    assert.strictEqual((js.match(/payoutAsset: selectedPayoutAsset\(\),/g) || []).length, 2, 'the preview and the withdrawal both send it');
    assert.ok(js.includes("case 'dex': return"), 'the receipt names an on-chain swap');
    assert.ok(js.includes('Swap spread'));
    assert.ok(js.includes('Left in wallet'));
    assert.ok(js.includes("'On-chain swap'"));
    assert.ok(js.includes('walletTokensUSD(wallet)'), 'the tally counts the tokens');
    // money in is a deposit; a withdrawal's transfer is money out whatever its route
    assert.ok(js.includes("return String(tx.type || '').toUpperCase() === 'DEPOSIT';"));
    assert.ok(!js.includes("!== 'WITHDRAWAL'"), 'the type no transfer record carried is gone');
    assert.strictEqual((js.match(/const incoming = isIncoming\(tx\);/g) || []).length, 3);
  });

  test('the docs, help, API reference and FAQ describe token payouts and on-chain swaps', () => {
    const docs = read('public/js/docs-content.js');
    assert.ok(docs.includes("'<strong>On-chain swap</strong>"));
    assert.ok(docs.includes("head: ['Chain', 'Code', 'Coin', 'Dollar tokens', 'On-chain swaps', 'Typical confirmation wait']"));
    assert.ok(docs.includes("title: 'A token needs a little of the coin'"));
    const help = read('public/js/help-content.js');
    assert.ok(help.includes("q: 'Can I withdraw USDC or USDT?'"));
    const spec = read('public/js/api-spec.js');
    assert.ok(spec.includes("['payoutAsset', 'string'"));
    assert.ok(spec.includes("head: ['Code', 'Coin', 'Family', 'Confirmations', 'Dollar tokens', 'Wallet-pay', 'Cross-chain swaps', 'On-chain swaps']"));
    assert.ok(spec.includes("route: 'dex'"));
    assert.ok(spec.includes('<code>dex+sideshift</code>'));
    const faq = read('public/faq.html');
    assert.ok(faq.includes('through a router contract your wallet calls directly'));
    assert.ok(!faq.includes('moving them out is the next thing we are building'));
  });

  test('the generated copy names the on-chain chains from the registry', () => {
    const served = chains.list().filter((c) => chains.swappableOnChain(c.code));
    const docs = read('public/js/docs-content.js');
    assert.ok(docs.includes(`Available on ${served.length} chains:`));
    for (const chain of served) assert.ok(docs.includes(chain.name), `docs name ${chain.name}`);
    const help = read('public/js/help-content.js');
    assert.ok(help.includes(`On-chain swaps run on ${served.length} chains`));
    const faq = read('public/faq.html');
    assert.ok(faq.includes(`That runs on ${served.length} chains:`));
    // the tables mark them
    const spec = read('public/js/api-spec.js');
    for (const chain of chains.list()) {
      const row = new RegExp(`\\['${chain.code}', '${chain.symbol}', '[A-Za-z ]+', '\\d+', '[^']*', '(?:yes|no)', '[^']*', '(yes|\\\\u2014)'\\],`).exec(spec);
      assert.ok(row, `${chain.code} row in the API table`);
      assert.strictEqual(row[1], chains.swappableOnChain(chain.code) ? 'yes' : '\\u2014', `${chain.code} on-chain column`);
    }
  });

  test('the chain tooling probes and proves on-chain routes', () => {
    const add = read('scripts/add-chain.js');
    assert.ok(add.includes('async function dexFor(entry, tokens)'));
    assert.ok(add.includes('dex: await dexFor(entry, tokens),'));
    assert.ok(add.includes('lines.push(`    dex: {'));
    const verify = read('scripts/verify-chains.js');
    assert.ok(verify.includes('if (chains.swappableOnChain(chain.code)) {'));
    assert.ok(verify.includes('too thin'));
  });
});
