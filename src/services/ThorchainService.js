/**
 * ThorchainService - cross-chain swaps with no custodian.
 *
 * THORChain is a network of vaults: send the asset to the current inbound
 * vault with a memo naming what you want and where, and the network pays
 * the destination itself. Bitcoin, Litecoin and the other UTXO chains carry
 * the memo in an OP_RETURN output; an EVM chain deposits through the
 * network's router contract; Solana carries it in a memo instruction. No
 * order is created anywhere and no account is involved: the memo is the
 * order.
 *
 * Which chains and assets it takes is read live (`inbound_addresses` says
 * which chains are open and where their vault is, `pools` which assets
 * have depth); the registry only says which THORChain chain a code maps
 * to. Quotes come from `quote/swap`, rate-limited to one a second, and
 * carry the vault address and the memo. Every figure the API speaks is in
 * 1e8 units whatever the asset's own decimals.
 *
 * The public node: THORChain's own hosts went dark in 2026; Liquify's
 * gateway serves the same API keyless. THORNODE_URL / MIDGARD_URL override.
 */
const { ethers } = require('ethers');
const chains = require('../config/chains');
const PriceService = require('./PriceService');

const THORNODE_URL = process.env.THORNODE_URL || 'https://gateway.liquify.com/chain/thorchain_api/thorchain';
const MIDGARD_URL = process.env.MIDGARD_URL || 'https://gateway.liquify.com/chain/thorchain_midgard/v2';

// The vault addresses rotate and the API says not to cache them. A minute
// is short enough that a quote taken at broadcast is always fresh; the
// plan's earlier quote only sizes the figures shown.
const INBOUND_TTL_MS = 60 * 1000;
const POOLS_TTL_MS = 5 * 60 * 1000;

// How far under the quoted output the swap may settle before the network
// refunds it instead: the limit written into the memo.
const LIMIT_BPS = 200;

// The quote endpoint allows one request a second per address.
const QUOTE_GAP_MS = 1100;

const REQUEST_TIMEOUT_MS = 15_000;

// A memo rides in an OP_RETURN on the UTXO chains, which holds 80 bytes.
const MEMO_MAX = 80;

// THORChain's router on every EVM chain it serves: the deposit call that
// carries the memo. The vault is the `inbound_address`.
const ROUTER = new ethers.Interface([
  'function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable',
]);

class ThorchainError extends Error {
  constructor(message, code = 'THORCHAIN_ERROR') {
    super(message);
    this.code = code;
  }
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* below */ }
    if (data === null) throw new Error(`HTTP ${response.status}, not JSON`);
    if (!response.ok && !(data && data.message)) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

class ThorchainService {
  constructor() {
    this.inbound = { at: 0, byChain: null, loading: null };
    this.pools = { at: 0, assets: null, loading: null };
    this.lastQuoteAt = 0;
    this.quoteQueue = Promise.resolve();
    // An affiliate (a THORName) earns basis points on every swap, paid by the
    // network out of the swap. Optional.
    this.affiliate = process.env.THORCHAIN_AFFILIATE || null;
    this.affiliateBps = Number(process.env.THORCHAIN_AFFILIATE_BPS) || 0;
  }

  /** The THORChain chain a registry code maps to, or null. */
  chainOf(code) {
    return chains.has(code) ? (chains.get(code).thorchain || null) : null;
  }

  /**
   * An asset as THORChain names it: `BTC.BTC`, `BASE.ETH`, `BSC.BNB`, and for
   * a token the contract in upper case after the symbol:
   * `ETH.USDC-0XA0B8…`.
   */
  assetOf(code, symbol = null) {
    const chain = chains.get(code);
    const thorChain = this.chainOf(code);
    if (!thorChain) throw new ThorchainError(`${chain.name} is not on THORChain`, 'UNSERVED');
    const wanted = String(symbol || chain.symbol).toUpperCase();
    if (wanted === chain.symbol) return `${thorChain}.${chain.symbol}`;
    const token = chains.tokenOf(code, wanted);
    if (!token) throw new ThorchainError(`${chain.name} has no ${wanted}`, 'UNKNOWN_ASSET');
    return `${thorChain}.${token.symbol}-${token.contract.toUpperCase()}`;
  }

  /** Fetch (and cache) the open chains with their vaults and routers. */
  async loadInbound() {
    if (this.inbound.byChain && Date.now() - this.inbound.at < INBOUND_TTL_MS) return this.inbound.byChain;
    if (this.inbound.loading) return this.inbound.loading;
    this.inbound.loading = (async () => {
      try {
        const list = await getJson(`${THORNODE_URL}/inbound_addresses`);
        if (!Array.isArray(list)) throw new Error('inbound_addresses is not a list');
        const byChain = new Map();
        for (const entry of list) byChain.set(String(entry.chain).toUpperCase(), entry);
        this.inbound.byChain = byChain;
        this.inbound.at = Date.now();
      } catch (error) {
        console.warn(`[ThorchainService] inbound_addresses failed: ${error.message}`);
      } finally {
        this.inbound.loading = null;
      }
      return this.inbound.byChain;
    })();
    return this.inbound.loading;
  }

  /** Fetch (and cache) the assets with an available pool. */
  async loadPools() {
    if (this.pools.assets && Date.now() - this.pools.at < POOLS_TTL_MS) return this.pools.assets;
    if (this.pools.loading) return this.pools.loading;
    this.pools.loading = (async () => {
      try {
        const list = await getJson(`${THORNODE_URL}/pools`);
        if (!Array.isArray(list)) throw new Error('pools is not a list');
        this.pools.assets = new Set(list.filter((p) => p.status === 'Available').map((p) => String(p.asset).toUpperCase()));
        this.pools.at = Date.now();
      } catch (error) {
        console.warn(`[ThorchainService] pools failed: ${error.message}`);
      } finally {
        this.pools.loading = null;
      }
      return this.pools.assets;
    })();
    return this.pools.loading;
  }

  /** Load both lists; the plan calls this once. */
  async ready() {
    await Promise.all([this.loadInbound(), this.loadPools()]);
  }

  /** The inbound entry for a code's chain, when loaded and open. */
  inboundFor(code) {
    const thorChain = this.chainOf(code);
    const entry = thorChain && this.inbound.byChain ? this.inbound.byChain.get(thorChain) : null;
    if (!entry || entry.halted || entry.global_trading_paused || entry.chain_trading_paused) return null;
    return entry;
  }

  /**
   * Whether THORChain takes and pays an asset on a chain right now: the
   * chain is one it serves and is not halted, and the asset has a pool.
   * False until the lists have loaded.
   */
  serves(code, symbol = null) {
    if (!chains.has(code) || !this.chainOf(code)) return false;
    if (!this.inboundFor(code) || !this.pools.assets) return false;
    let asset;
    try { asset = this.assetOf(code, symbol); } catch { return false; }
    return this.pools.assets.has(asset.toUpperCase());
  }

  /** Amount in THORChain's 1e8 units, whatever the asset's own decimals. */
  static toUnits(amount) {
    return BigInt(Math.round(Number(amount) * 1e8)).toString();
  }

  static fromUnits(units) {
    return Number(BigInt(units || '0')) / 1e8;
  }

  /** What an asset on a chain is worth: the coin at its rate, a dollar token at par. */
  usdRate(code, symbol = null) {
    const chain = chains.get(code);
    const wanted = String(symbol || chain.symbol).toUpperCase();
    if (wanted !== chain.symbol) return 1;
    return PriceService.rateFor(code) || 0;
  }

  /**
   * The memo with a floor written in: the quoted output less LIMIT_BPS, so
   * a swap that moves further than that is refunded rather than settled
   * short. The quote's own memo carries a zero limit. Kept within the 80
   * bytes an OP_RETURN holds, dropping precision with an exponent (`123e4`)
   * when a long address leaves no room.
   */
  static memoWithLimit(memo, expectedOutUnits) {
    const limit = (BigInt(expectedOutUnits) * BigInt(10_000 - LIMIT_BPS)) / 10_000n;
    const parts = String(memo).split(':');
    // =:asset:dest:limit/interval/quantity[:affiliate:bps]
    if (parts.length < 4) return memo;
    const [limitPart, ...rest] = parts[3].split('/');
    void limitPart;
    let digits = limit.toString();
    const build = (l) => { const p = [...parts]; p[3] = [l, ...rest].join('/'); return p.join(':'); };
    let out = build(digits);
    // shave trailing digits into an exponent until it fits
    let exp = 0;
    while (Buffer.byteLength(out, 'utf8') > MEMO_MAX && digits.length > 3) {
      digits = digits.slice(0, -1);
      exp += 1;
      out = build(`${digits}e${exp}`);
    }
    return out;
  }

  /** Space the quote calls a second apart, as the API asks. */
  async throttled(fn) {
    const run = this.quoteQueue.then(async () => {
      const wait = this.lastQuoteAt + QUOTE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastQuoteAt = Date.now();
      return fn();
    });
    this.quoteQueue = run.catch(() => {});
    return run;
  }

  /**
   * A quote for swapping `amount` of `fromAsset` on `fromChain` into
   * `toAsset` on `toChain`, paid to `destination`. Returns the vault to pay,
   * the router for an EVM deposit, the memo with its floor, what comes out
   * and what it costs.
   */
  async quote({ fromChain, fromAsset = null, toChain, toAsset = null, amount, destination }) {
    await this.ready();
    const source = chains.get(fromChain);
    const target = chains.get(toChain);
    const from = this.assetOf(fromChain, fromAsset);
    const to = this.assetOf(toChain, toAsset);
    if (!this.serves(fromChain, fromAsset)) throw new ThorchainError(`THORChain is not taking ${from} right now`, 'UNSERVED');
    if (!this.serves(toChain, toAsset)) throw new ThorchainError(`THORChain is not paying ${to} right now`, 'UNSERVED');
    const units = ThorchainService.toUnits(amount);
    if (BigInt(units) <= 0n) throw new ThorchainError('nothing to swap', 'ZERO_AMOUNT');

    const query = new URLSearchParams({
      from_asset: from,
      to_asset: to,
      amount: units,
      destination,
      streaming_interval: '1',
      streaming_quantity: '0',
    });
    if (this.affiliate && this.affiliateBps > 0) {
      query.set('affiliate', this.affiliate);
      query.set('affiliate_bps', String(this.affiliateBps));
    }
    const data = await this.throttled(() => getJson(`${THORNODE_URL}/quote/swap?${query}`));
    if (!data || data.message || !data.inbound_address) {
      const text = String((data && data.message) || 'no quote');
      const code = /dust threshold/.test(text) ? 'BELOW_DUST' : /halted|paused/.test(text) ? 'HALTED' : 'NO_QUOTE';
      throw new ThorchainError(`THORChain would not quote ${from} to ${to}: ${text.replace(/: invalid request$/, '')}`, code);
    }

    const inbound = this.inboundFor(fromChain) || {};
    const expectedOut = ThorchainService.fromUnits(data.expected_amount_out);
    const fees = data.fees || {};
    const feeAsset = target;
    const feeRate = this.usdRate(toChain, toAsset);
    const totalFee = ThorchainService.fromUnits(fees.total);
    const memo = ThorchainService.memoWithLimit(data.memo, data.expected_amount_out);
    const limitUnits = memo.split(':')[3] ? memo.split(':')[3].split('/')[0] : '0';

    return {
      provider: 'thorchain',
      fromChain, fromAsset: from, toChain, toAsset: to,
      amount: Number(amount),
      amountUnits: units,
      expectedOut,
      minOut: ThorchainService.fromUnits(/e/.test(limitUnits) ? BigInt(limitUnits.split('e')[0]) * 10n ** BigInt(limitUnits.split('e')[1]) : limitUnits),
      // where and how to pay in
      inboundAddress: data.inbound_address,
      router: data.router || inbound.router || null,
      memo,
      expiry: Number(data.expiry),
      expiresAt: new Date(Number(data.expiry) * 1000).toISOString(),
      dustThreshold: ThorchainService.fromUnits(data.dust_threshold),
      recommendedMin: ThorchainService.fromUnits(data.recommended_min_amount_in),
      gasRate: data.recommended_gas_rate ? `${data.recommended_gas_rate} ${data.gas_rate_units || ''}`.trim() : null,
      // what it costs, in the output asset and in dollars
      fees: {
        asset: feeAsset.symbol,
        outbound: ThorchainService.fromUnits(fees.outbound),
        liquidity: ThorchainService.fromUnits(fees.liquidity),
        affiliate: ThorchainService.fromUnits(fees.affiliate),
        total: totalFee,
        totalUsd: totalFee * feeRate,
        slippageBps: Number(fees.slippage_bps) || 0,
        totalBps: Number(fees.total_bps) || 0,
      },
      totalSeconds: Number(data.total_swap_seconds) || null,
      inboundConfirmationSeconds: Number(data.inbound_confirmation_seconds) || 0,
      notes: data.notes || null,
      quotedAt: new Date().toISOString(),
      // the source family decides how the memo travels
      deposit: source.family === 'evm' ? 'router' : 'memo',
    };
  }

  /**
   * Calldata for the router's deposit: the vault, the token (zero for the
   * chain's coin), the amount in the asset's own units, the memo and the
   * quote's expiry.
   */
  static depositCalldata({ vault, token = null, amountUnits, memo, expiry }) {
    return ROUTER.encodeFunctionData('depositWithExpiry', [
      vault,
      token || ethers.ZeroAddress,
      BigInt(amountUnits),
      memo,
      BigInt(expiry),
    ]);
  }

  /** THORChain names a transaction by its hash, upper case, without 0x. */
  static txId(hash) {
    return String(hash || '').replace(/^0x/i, '').toUpperCase();
  }

  /**
   * Where a swap stands: `waiting` until the inbound is seen, `swapping`
   * while it confirms and swaps, `settled` once the outbound is signed,
   * `refunded` when the network sent the deposit back instead.
   */
  async status(txHash) {
    const id = ThorchainService.txId(txHash);
    const data = await getJson(`${THORNODE_URL}/tx/status/${id}`);
    const stages = (data && data.stages) || {};
    const observed = stages.inbound_observed || {};
    if (observed.started === false || (!observed.completed && !observed.started && !data.tx)) {
      return { status: 'waiting', stages, outTxs: [] };
    }
    const planned = data.planned_out_txs || [];
    const outTxs = data.out_txs || [];
    const refunded = planned.some((p) => p.refund) || outTxs.some((o) => /^REFUND:/i.test(o.memo || ''));
    const signed = Boolean(stages.outbound_signed && stages.outbound_signed.completed);
    if (signed && refunded) return { status: 'refunded', stages, outTxs };
    if (signed) return { status: 'settled', stages, outTxs };
    return { status: 'swapping', stages, outTxs };
  }
}

module.exports = new ThorchainService();
module.exports.ThorchainService = ThorchainService;
module.exports.ThorchainError = ThorchainError;
module.exports.LIMIT_BPS = LIMIT_BPS;
module.exports.MEMO_MAX = MEMO_MAX;
module.exports.THORNODE_URL = THORNODE_URL;
module.exports.MIDGARD_URL = MIDGARD_URL;
