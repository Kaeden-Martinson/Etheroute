/**
 * Sideshift Service - Cross-chain swaps with simple order-based flow
 * Create order → Send tokens to deposit address → Sideshift handles swap
 */

const axios = require('axios');
const sideshiftAccountService = require('./SideshiftAccountService');
const ChainTxStatus = require('./ChainTxStatus');
const chains = require('../config/chains');

// How long to wait on Sideshift before giving up. A quote that takes longer
// than this is not going to be used anyway.
const REQUEST_TIMEOUT_MS = 20_000;

// How long the public coin list (which coins on which networks, and which
// are offline right now) is trusted before it is fetched again.
const COINS_TTL_MS = 60 * 60 * 1000;

// The coin list, shared by every instance: one fetch an hour, not one per
// service.
const coinsCache = { at: 0, byCoin: null, loading: null };

/**
 * The text Sideshift put in an error response, for the log line.
 */
function describeAxiosError(error) {
  if (error.response) {
    const body = error.response.data;
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    return `HTTP ${error.response.status} ${error.response.statusText || ''} - ${detail}`.trim();
  }
  if (error.code === 'ECONNABORTED') return `timed out after ${REQUEST_TIMEOUT_MS}ms`;
  return error.message;
}

/** A failure to reach the proxy at all, as opposed to an answer from Sideshift. */
function isProxyFailure(error) {
  if (error.response && error.response.status === 407) return true;
  if (error.response) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|tunneling socket|Proxy connection/i.test(`${error.code || ''} ${error.message || ''}`);
}

class SideshiftService {
  constructor(priceService) {
    this.priceService = priceService;
    this.apiUrl = 'https://sideshift.ai/api/v2';

    this.http = axios.create({
      baseURL: this.apiUrl,
      timeout: REQUEST_TIMEOUT_MS,
      // Each account carries its own proxy agent, passed per request. Turning
      // off axios's built-in proxy support stops it from also honouring an
      // HTTPS_PROXY environment variable and tunnelling twice.
      proxy: false,
    });

  }

  /**
   * Send a request through the account's proxy, falling back to a direct
   * connection if the proxy itself cannot be reached. The account is still
   * the one signing; only the route changes.
   */
  async request(method, url, { account, agent, secret }, body, extra = {}) {
    const config = { ...extra, headers: { 'x-sideshift-secret': secret } };
    const send = (httpsAgent) => (method === 'get'
      ? this.http.get(url, { ...config, httpsAgent })
      : this.http.post(url, body, { ...config, httpsAgent }));

    if (!agent) return send(undefined);

    try {
      return await send(agent);
    } catch (error) {
      if (!isProxyFailure(error)) throw error;
      sideshiftAccountService.markProxyBad(account.id, describeAxiosError(error));
      return send(undefined);
    }
  }

  /**
   * Sideshift's coin ticker and network name for an asset on one of our
   * chains. An L2 is the same coin on another network: BASE is `eth` on
   * `base`; a dollar token is its own coin on that network: USDC on Base is
   * `usdc` on `base`.
   */
  asset(code, symbol = null) {
    const chain = chains.get(code);
    if (!chains.swappable(code)) {
      throw new Error(`${chain.name} is not served by SideShift: a payout there can only be direct`);
    }
    const wanted = String(symbol || chain.symbol).toUpperCase();
    if (wanted === chain.symbol) return { coin: chain.sideshift.coin, network: chain.sideshift.network };
    if (!chains.tokenOf(code, wanted)) throw new Error(`${chain.name} has no ${wanted}`);
    if (!this.serves(code, wanted)) {
      throw new Error(`SideShift does not take ${wanted} on ${chain.name}: it can be paid out as ${wanted} there, or swapped on the chain first`);
    }
    return { coin: wanted.toLowerCase(), network: chain.sideshift.network };
  }

  /**
   * Fetch (and cache) which coins SideShift serves on which networks. Public,
   * no account involved. A failure keeps the last list; with none ever
   * loaded, only the registry's native routes are trusted.
   */
  async loadCoins() {
    if (coinsCache.byCoin && Date.now() - coinsCache.at < COINS_TTL_MS) return coinsCache.byCoin;
    if (coinsCache.loading) return coinsCache.loading;
    coinsCache.loading = (async () => {
      try {
        const response = await this.http.get('/coins');
        const byCoin = new Map();
        for (const entry of response.data || []) {
          // `depositOffline` / `settleOffline` are `true` for the whole coin,
          // or a list of the networks that are off right now.
          const offOn = (flag) => (flag === true ? (entry.networks || []) : Array.isArray(flag) ? flag : []);
          const off = new Set([...offOn(entry.depositOffline), ...offOn(entry.settleOffline)]);
          byCoin.set(String(entry.coin).toUpperCase(), new Set((entry.networks || []).filter((n) => !off.has(n))));
        }
        coinsCache.byCoin = byCoin;
        coinsCache.at = Date.now();
      } catch (error) {
        console.warn(`[SideshiftService] Coin list failed: ${describeAxiosError(error)}`);
      } finally {
        coinsCache.loading = null;
      }
      return coinsCache.byCoin;
    })();
    return coinsCache.loading;
  }

  /**
   * Whether SideShift takes and pays an asset on a chain. The chain's coin
   * is a registry fact; a token is checked against the live coin list, and
   * is not served until that list has loaded.
   */
  serves(code, symbol = null) {
    if (!chains.has(code) || !chains.swappable(code)) return false;
    const chain = chains.get(code);
    const wanted = String(symbol || chain.symbol).toUpperCase();
    if (wanted === chain.symbol) return true;
    if (!chains.tokenOf(code, wanted)) return false;
    const networks = coinsCache.byCoin && coinsCache.byCoin.get(wanted);
    return Boolean(networks && networks.has(chain.sideshift.network));
  }

  /**
   * Get gas quote for a swap
   * @param {string} fromChain - Source chain (BTC, ETH, SOL, LTC)
   * @param {string} toChain - Destination chain
   * @param {number} amount - Amount in source chain units
   * @returns {Promise<Object>} Gas quote
   */

  /**
   * Approximate cost in USD of a plain on-chain send, per network. Used for
   * same-chain payouts, which skip Sideshift entirely and are just a transfer.
   */
  static get DIRECT_TRANSFER_GAS_USD() {
    return Object.fromEntries(chains.list().map((c) => [c.code, c.directGasUsd]));
  }

  /**
   * USD rate for an asset on a chain: the coin's price, or par for a dollar
   * token. 0 when prices have not loaded.
   */
  usdRate(chain, symbol = null) {
    const wanted = String(symbol || '').toUpperCase();
    if (wanted && chains.has(chain) && wanted !== chains.get(chain).symbol) return 1;
    return this.priceService[`${String(chain).toLowerCase()}ToUsdRate`] || 0;
  }

  async getGasQuote(fromChain, toChain, amount, fromAsset = null, toAsset = null) {
    const fromSymbol = String(fromAsset || chains.get(fromChain).symbol).toUpperCase();
    const toSymbol = String(toAsset || chains.get(toChain).symbol).toUpperCase();
    // Same chain and asset in and out is not a swap at all - it is a direct
    // send, so there is no Sideshift order, no swap spread and no $5 minimum.
    // Only the network fee comes off.
    if (fromChain === toChain && fromSymbol === toSymbol) {
      const gasUsd = SideshiftService.DIRECT_TRANSFER_GAS_USD[fromChain] ?? 0.50;
      const rate = this.usdRate(fromChain);
      const gasNative = rate > 0 ? gasUsd / rate : 0;

      return {
        outputAmount: Math.max(0, amount - gasNative),
        changeInOutput: -gasNative,
        estimatedGasUsd: gasUsd,
      };
    }

    const selected = sideshiftAccountService.getAccount('quote');
    const { account, affiliateId } = selected;

    const deposit = this.asset(fromChain, fromSymbol);
    const settle = this.asset(toChain, toSymbol);
    const requestData = {
      depositCoin: deposit.coin,
      depositNetwork: deposit.network,
      settleCoin: settle.coin,
      settleNetwork: settle.network,
      depositAmount: amount.toFixed(8).toString(), // Sideshift expects string amounts with up to 8 decimals
      settleAmount: null,
      affiliateId,
    }

    try {
      let response;
      try {
        response = await this.request('post', '/quotes', selected, requestData);
      } finally {
        // The request counts against the account's limit whether or not
        // Sideshift liked it.
        sideshiftAccountService.recordUsage(account.id, 'quote');
      }

      const data = response.data;

      console.log('[SideshiftService] Received gas quote response:', data);

      // What the swap actually pays out, in the destination chain's units.
      const outputAmount = Number(data.settleAmount);

      // Cost of the swap in USD: what the input was worth, minus what the
      // output is worth. Previously this was computed through an ETH-only rate
      // pair, which gave a wrong figure for any other destination.
      const inputUsd = amount * this.usdRate(fromChain, fromSymbol);
      const outputUsd = outputAmount * this.usdRate(toChain, toSymbol);
      const estimatedGasUsd = Math.max(0, inputUsd - outputUsd);

      return {
        outputAmount,
        changeInOutput: outputAmount - amount,
        estimatedGasUsd,
        // Everything a fixed-rate shift needs to be created from this quote.
        // The deposit amount is kept as Sideshift's own string: a fixed shift
        // settles only a deposit of exactly that figure, so it must reach the
        // sender untouched by float arithmetic.
        quoteId: data.id,
        quoteExpiresAt: data.expiresAt,
        depositAmount: String(data.depositAmount),
        settleAmount: String(data.settleAmount),
        rate: data.rate,
        accountId: account.id,
        affiliateId: data.affiliateId || affiliateId,
      };
    } catch (error) {
      console.error(`[SideshiftService] Quote ${fromChain} -> ${toChain} failed: ${describeAxiosError(error)}`);
    }
  };

  /**
   * Create a swap order.
   *
   * With a `quote` this is a fixed-rate shift: the rate the client was shown
   * is the rate they get, for 15 minutes from the quote, provided exactly
   * `quote.depositAmount` arrives. Without one it is a variable shift, whose
   * rate is set whenever the deposit lands - the previous behaviour, and the
   * reason the figure on the review screen was never actually honoured.
   *
   * @param {Object} params
   * @param {string} params.fromChain - Source chain (BTC, ETH, SOL, LTC)
   * @param {string} params.toChain - Destination chain
   * @param {string} [params.fromAsset] - Asset deposited; the source chain's coin by default
   * @param {string} [params.toAsset] - Asset settled; the destination chain's coin by default
   * @param {string} params.destinationAddress - Wallet to receive output
   * @param {string} params.refundAddress - Where a failed shift is refunded
   * @param {Object} [params.quote] - A result of getGasQuote, for a fixed shift
   * @returns {Promise<Object>} Order details with deposit address
   */
  async createOrder(params) {
    try {
      const {
        fromChain,
        toChain,
        fromAsset = null,
        toAsset = null,
        destinationAddress,
        refundAddress,
        quote = null,
      } = params;

      const fixed = Boolean(quote && quote.quoteId);

      // The shift must be created on the account that made the quote.
      const selected = sideshiftAccountService.getAccount('shift', fixed ? quote.accountId : null);
      const { account, affiliateId } = selected;

      let requestBody;
      let endpoint;

      if (fixed) {
        endpoint = '/shifts/fixed';
        requestBody = {
          quoteId: quote.quoteId,
          settleAddress: destinationAddress,
          refundAddress,
          affiliateId: quote.affiliateId || affiliateId,
        };
      } else {
        endpoint = '/shifts/variable';
        const deposit = this.asset(fromChain, fromAsset);
        const settle = this.asset(toChain, toAsset);
        requestBody = {
          depositCoin: deposit.coin,
          depositNetwork: deposit.network,
          settleCoin: settle.coin,
          settleNetwork: settle.network,
          settleAddress: destinationAddress,
          refundAddress,
          affiliateId,
        };
      }

      let response;
      try {
        response = await this.request('post', endpoint, selected, requestBody);
      } catch (error) {
        throw new Error(`Failed to create ${fixed ? 'fixed' : 'variable'} order: ${describeAxiosError(error)}`);
      } finally {
        sideshiftAccountService.recordUsage(account.id, 'shift');
      }

      const order = response.data;

      return {
        orderId: order.id,
        type: fixed ? 'fixed' : 'variable',
        status: order.status,
        depositAddress: order.depositAddress,
        depositCoin: order.depositCoin,
        settleCoin: order.settleCoin,
        settleAddress: order.settleAddress,
        refundAddress: order.refundAddress,
        expiresAt: order.expiresAt,
        extraId: order.extraId || order.depositMemo || null,
        // Fixed: the exact deposit the shift will settle, and what it pays
        // out. Variable: the acceptable deposit range.
        depositAmount: order.depositAmount != null ? String(order.depositAmount) : null,
        settleAmount: order.settleAmount != null ? String(order.settleAmount) : null,
        depositMin: order.depositMin != null ? Number(order.depositMin) : null,
        depositMax: order.depositMax != null ? Number(order.depositMax) : null,
        rate: order.rate ?? (quote ? quote.rate : null),
        quoteId: fixed ? quote.quoteId : null,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[SideshiftService] Error creating order:', error.message);
      throw error;
    }
  }

  /**
   * Whether an order id names something that settles on its own chain - a
   * direct transfer or an on-chain swap - rather than a Sideshift shift.
   */
  static isOnChainOrder(orderId) {
    return /^(direct_transfer_|dex_swap_)/.test(String(orderId || ''));
  }

  /**
   * Get order status - handles Sideshift orders, direct transfers and
   * on-chain swaps.
   *
   * @param {string} orderId - "direct_transfer_xxx", "dex_swap_xxx" or a Sideshift order id
   * @param {string} txHash - Transaction hash (required for on-chain orders)
   * @param {string} chain - Chain the transfer or swap was broadcast on
   * @returns {Promise<Array<Object>>} Order status, as a one-element array to
   *   match the shape of Sideshift's /shifts?ids= response
   */
  async getOrderStatus(orderId, txHash, chain = 'ETH') {
    try {
      if (SideshiftService.isOnChainOrder(orderId)) {
        if (!txHash) {
          throw new Error('An on-chain order requires its transaction hash');
        }

        // A direct transfer settles on its own chain, so it is checked there.
        // This used to ask the Ethereum RPC regardless of chain, which could
        // never find a BTC, LTC or SOL hash - every non-ETH direct payout
        // "waited" until the monitor gave up and marked it failed.
        const onChain = await ChainTxStatus.getTransferStatus(chain, txHash);
        console.log(`[SideshiftService] Direct ${chain} transfer ${txHash}: ${onChain.status} (${onChain.confirmations} conf)`);

        return [{
          id: orderId,
          status: onChain.status === 'not_found' ? 'waiting' : onChain.status,
          onChainStatus: onChain.status,
          confirmations: onChain.confirmations,
          transactionHash: txHash,
          blockNumber: onChain.blockHeight,
          type: orderId.startsWith('dex_swap_') ? 'dex_swap' : 'direct_transfer',
          chain,
        }];
      }

      // Handle Sideshift order
      const selected = sideshiftAccountService.getAccount('quote');

      let response;
      try {
        response = await this.request('get', '/shifts', selected, null, { params: { ids: orderId } });
      } catch (error) {
        throw new Error(`Failed to fetch order: ${describeAxiosError(error)}`);
      }

      return response.data;
    } catch (error) {
      console.error('[SideshiftService] Error fetching order status:', error.message);
      throw error;
    }
  }
}

module.exports = SideshiftService;
