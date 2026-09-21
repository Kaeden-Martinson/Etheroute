/**
 * DexService - swaps between two assets on the same chain, through a router
 * contract the wallet calls itself.
 *
 * USDC to ETH on Base, ETH to USDT on BNB Chain: an aggregator (KyberSwap,
 * ParaSwap) finds the route across the chain's pools and returns calldata
 * for its router; the merchant's wallet signs and sends it. Nothing is
 * deposited anywhere, no account is involved and nothing can be held: if the
 * aggregator's API is down we lose the quote, never the money. The calldata
 * carries a minimum output (the quote less the slippage allowance) and a
 * deadline, so a route that moves against us reverts instead of settling
 * short.
 *
 * Which aggregators serve a chain is a registry fact (`dex`), written and
 * proved by the chain tooling. A quote is taken from every one that serves
 * the chain and the best net output wins.
 */
const { ethers } = require('ethers');
const chains = require('../config/chains');
const PriceService = require('./PriceService');

// The address every aggregator uses for a chain's own coin.
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// How far below the quote the swap may settle before it reverts, in basis
// points. Half a percent covers a block's worth of movement on a deep pool.
const SLIPPAGE_BPS = 50;

// A quote that returns this much less value than went in is a thin pool, not
// a rate. The leg is refused rather than settled at a loss the merchant did
// not see coming.
const MAX_IMPACT = 0.03;

// How long the calldata stays valid. Long enough for an approval to confirm
// first, short enough that a stale route cannot be replayed hours later.
const DEADLINE_SEC = 20 * 60;

const REQUEST_TIMEOUT_MS = 15_000;

const CLIENT_ID = 'etheroute';

class DexError extends Error {
  constructor(message, code = 'DEX_ERROR') {
    super(message);
    this.code = code;
  }
}

// A public aggregator that answers "overloaded" once is asked once more,
// a moment later, before its refusal counts.
const RETRY_ON = /overload|rate limit|too many|HTTP 5\d\d|HTTP 429|aborted/i;

async function getJson(url, init = {}) {
  try {
    const first = await getJsonOnce(url, init);
    if (first && typeof first === 'object' && first.code && RETRY_ON.test(String(first.message || ''))) throw new Error(String(first.message));
    return first;
  } catch (error) {
    if (!RETRY_ON.test(error.message)) throw error;
    await new Promise((r) => setTimeout(r, 1500));
    return getJsonOnce(url, init);
  }
}

async function getJsonOnce(url, { method = 'get', body = null, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!response.ok) {
      const detail = data && (data.message || data.error) ? String(data.message || data.error) : text.slice(0, 120);
      throw new Error(`HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
    }
    if (data === null) throw new Error('not JSON');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * KyberSwap's aggregator: GET a route, POST it back to have the calldata
 * built for a sender and recipient. Keyless; the client id is a courtesy.
 */
const kyber = {
  name: 'kyber',
  base: 'https://aggregator-api.kyberswap.com',
  serves: (chain) => Boolean(chain.dex && chain.dex.kyber),
  async quote({ chain, tokenIn, tokenOut, amountUnits, sender, recipient }) {
    const slug = chain.dex.kyber;
    const headers = { 'x-client-id': CLIENT_ID };
    const routes = await getJson(
      `${this.base}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountUnits}&gasInclude=true`,
      { headers }
    );
    if (routes.code !== 0 || !routes.data || !routes.data.routeSummary) {
      throw new Error(routes.message || 'no route');
    }
    const summary = routes.data.routeSummary;
    const built = await getJson(`${this.base}/${slug}/api/v1/route/build`, {
      method: 'post',
      headers,
      body: {
        routeSummary: summary,
        sender,
        recipient,
        slippageTolerance: SLIPPAGE_BPS,
        deadline: Math.floor(Date.now() / 1000) + DEADLINE_SEC,
        source: CLIENT_ID,
        enableGasEstimation: false,
      },
    });
    if (built.code !== 0 || !built.data || !built.data.data) {
      throw new Error(built.message || 'route would not build');
    }
    const router = built.data.routerAddress || routes.data.routerAddress;
    return {
      amountOutUnits: BigInt(built.data.amountOut || summary.amountOut),
      amountInUsd: Number(built.data.amountInUsd || summary.amountInUsd) || null,
      amountOutUsd: Number(built.data.amountOutUsd || summary.amountOutUsd) || null,
      gasUnits: Number(built.data.gas || summary.gas) || null,
      gasUsd: Number(built.data.gasUsd || summary.gasUsd) || null,
      router,
      spender: router,
      tx: { to: router, data: built.data.data, value: tokenIn === NATIVE ? amountUnits : '0' },
    };
  },
};

/**
 * ParaSwap: GET a price route, POST it to have the transaction built. The
 * balance and allowance checks on the build are skipped because the
 * approval is sent right before the swap, not before the quote.
 */
const paraswap = {
  name: 'paraswap',
  base: 'https://api.paraswap.io',
  serves: (chain) => Boolean(chain.dex && chain.dex.paraswap),
  async quote({ chain, tokenIn, tokenOut, decimalsIn, decimalsOut, amountUnits, sender, recipient }) {
    const query = new URLSearchParams({
      srcToken: tokenIn,
      destToken: tokenOut,
      amount: amountUnits,
      srcDecimals: String(decimalsIn),
      destDecimals: String(decimalsOut),
      side: 'SELL',
      network: String(chain.chainId),
      version: '6.2',
      partner: CLIENT_ID,
      userAddress: sender,
    });
    const priced = await getJson(`${this.base}/prices?${query}`);
    const route = priced.priceRoute;
    if (!route) throw new Error(priced.error || 'no route');
    const built = await getJson(`${this.base}/transactions/${chain.chainId}?ignoreChecks=true`, {
      method: 'post',
      body: {
        srcToken: tokenIn,
        destToken: tokenOut,
        srcAmount: amountUnits,
        slippage: SLIPPAGE_BPS,
        priceRoute: route,
        userAddress: sender,
        receiver: recipient,
        partner: CLIENT_ID,
        deadline: Math.floor(Date.now() / 1000) + DEADLINE_SEC,
      },
    });
    if (!built.to || !built.data) throw new Error(built.error || 'transaction would not build');
    return {
      amountOutUnits: BigInt(route.destAmount),
      amountInUsd: Number(route.srcUSD) || null,
      amountOutUsd: Number(route.destUSD) || null,
      gasUnits: Number(route.gasCost) || null,
      gasUsd: Number(route.gasCostUSD) || null,
      router: built.to,
      spender: route.tokenTransferProxy || built.to,
      tx: { to: built.to, data: built.data, value: tokenIn === NATIVE ? amountUnits : String(built.value || '0') },
    };
  },
};

const PROVIDERS = [kyber, paraswap];

class DexService {
  constructor() {
    this.providers = PROVIDERS;
  }

  /** The aggregators that serve a chain, in preference order. */
  providersFor(code) {
    const chain = chains.get(code);
    if (chain.family !== 'evm') return [];
    return this.providers.filter((provider) => provider.serves(chain));
  }

  /** Whether any aggregator serves the chain. */
  serves(code) {
    return this.providersFor(code).length > 0;
  }

  /**
   * An asset on a chain as the aggregators name it: the native placeholder
   * for the coin, the contract for a token, with its decimals.
   */
  assetOn(code, symbol) {
    const chain = chains.get(code);
    const wanted = String(symbol || chain.symbol).toUpperCase();
    if (wanted === chain.symbol) return { symbol: chain.symbol, address: NATIVE, decimals: chain.decimals, native: true };
    const token = chains.tokenOf(code, wanted);
    if (!token) throw new DexError(`${chain.name} has no ${wanted}`, 'UNKNOWN_ASSET');
    return { symbol: token.symbol, address: token.contract, decimals: token.decimals, native: false };
  }

  /** What an asset is worth: the chain's coin at its rate, a dollar token at par. */
  usdRate(code, symbol) {
    const asset = this.assetOn(code, symbol);
    return asset.native ? (PriceService.rateFor(code) || 0) : 1;
  }

  /**
   * The best quote for swapping `amount` of `from` into `to` on `chain`,
   * with calldata the sender can sign. Every serving aggregator is asked;
   * one that errors is skipped, and the best net output wins. Throws a
   * DexError when none can route it or the best route loses more than the
   * impact cap.
   *
   * @param {Object} p
   * @param {string} p.chain - registry code
   * @param {string} p.from - asset symbol held
   * @param {string} p.to - asset symbol wanted
   * @param {number|string} p.amount - decimal amount of `from`
   * @param {string} p.sender - the wallet that signs
   * @param {string} [p.recipient] - who receives `to`; the sender by default
   */
  async quote({ chain: code, from, to, amount, sender, recipient = sender }) {
    const chain = chains.get(code);
    const providers = this.providersFor(code);
    if (providers.length === 0) throw new DexError(`${chain.name} has no on-chain swap route`, 'NO_DEX');
    const assetIn = this.assetOn(code, from);
    const assetOut = this.assetOn(code, to);
    if (assetIn.symbol === assetOut.symbol) throw new DexError(`${assetIn.symbol} to ${assetOut.symbol} is not a swap`, 'SAME_ASSET');
    if (!ethers.isAddress(sender) || !ethers.isAddress(recipient)) throw new DexError('sender and recipient must be addresses', 'BAD_ADDRESS');

    const amountUnits = ethers.parseUnits(Number(amount).toFixed(assetIn.decimals), assetIn.decimals).toString();
    if (BigInt(amountUnits) <= 0n) throw new DexError('nothing to swap', 'ZERO_AMOUNT');

    const failures = [];
    const quotes = [];
    await Promise.all(providers.map(async (provider) => {
      try {
        const raw = await provider.quote({
          chain, tokenIn: assetIn.address, tokenOut: assetOut.address,
          decimalsIn: assetIn.decimals, decimalsOut: assetOut.decimals,
          amountUnits, sender, recipient,
        });
        quotes.push({ provider: provider.name, ...raw });
      } catch (error) {
        failures.push(`${provider.name}: ${error.message}`);
      }
    }));
    if (quotes.length === 0) {
      throw new DexError(`No on-chain route for ${assetIn.symbol} to ${assetOut.symbol} on ${chain.name} (${failures.join('; ')})`, 'NO_ROUTE');
    }

    // Net of gas where the aggregator priced it; a token is a dollar, the
    // coin is at its rate, so the comparison is in USD either way.
    const rateOut = this.usdRate(code, assetOut.symbol);
    const rateIn = this.usdRate(code, assetIn.symbol);
    const amountIn = Number(ethers.formatUnits(amountUnits, assetIn.decimals));
    const scored = quotes.map((q) => {
      const amountOut = Number(ethers.formatUnits(q.amountOutUnits, assetOut.decimals));
      const amountOutUsd = q.amountOutUsd || amountOut * rateOut;
      const amountInUsd = q.amountInUsd || amountIn * rateIn;
      return { ...q, amountOut, amountOutUsd, amountInUsd, net: amountOutUsd - (q.gasUsd || 0) };
    }).sort((a, b) => b.net - a.net);
    const best = scored[0];

    const impact = best.amountInUsd > 0 ? 1 - best.amountOutUsd / best.amountInUsd : 0;
    if (impact > MAX_IMPACT) {
      throw new DexError(
        `Swapping ${amountIn} ${assetIn.symbol} for ${assetOut.symbol} on ${chain.name} would lose ${(impact * 100).toFixed(1)}% to price impact; the pool is too thin for this amount`,
        'PRICE_IMPACT'
      );
    }

    const minUnits = (best.amountOutUnits * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    return {
      provider: best.provider,
      chain: code,
      from: assetIn.symbol,
      to: assetOut.symbol,
      amountIn,
      amountInUnits: amountUnits,
      amountOut: best.amountOut,
      amountOutUnits: best.amountOutUnits.toString(),
      minAmountOut: Number(ethers.formatUnits(minUnits, assetOut.decimals)),
      minAmountOutUnits: minUnits.toString(),
      amountInUsd: best.amountInUsd,
      amountOutUsd: best.amountOutUsd,
      // What the route costs beyond gas: the spread between what went in and
      // what comes out, never negative.
      spreadUsd: Math.max(0, best.amountInUsd - best.amountOutUsd),
      impact,
      gasUnits: best.gasUnits,
      gasUsd: best.gasUsd,
      router: best.router,
      // Set for a token in: the contract the token must be approved to.
      approval: assetIn.native ? null : { token: assetIn.address, spender: best.spender, amountUnits },
      tx: best.tx,
      sender,
      recipient,
      slippageBps: SLIPPAGE_BPS,
      expiresAt: new Date(Date.now() + DEADLINE_SEC * 1000).toISOString(),
      quotedAt: new Date().toISOString(),
      alternatives: scored.slice(1).map((q) => ({ provider: q.provider, amountOut: q.amountOut, gasUsd: q.gasUsd })),
      failures,
    };
  }
}

module.exports = new DexService();
module.exports.DexService = DexService;
module.exports.DexError = DexError;
module.exports.NATIVE = NATIVE;
module.exports.SLIPPAGE_BPS = SLIPPAGE_BPS;
module.exports.MAX_IMPACT = MAX_IMPACT;
module.exports.PROVIDERS = PROVIDERS;
