const PriceService = require('./PriceService');
const SideshiftService = require('./SideshiftService');
const DexService = require('./DexService');
const ThorchainService = require('./ThorchainService');
const GasFloatService = require('./GasFloatService');
const FeeCollectionService = require('./FeeCollectionService');
const chains = require('../config/chains');
const { validateCryptoAddress } = require('../utils/validators');
const { config } = require('../config/env');
const EthereumProvider = require('./EthereumProvider');
const GasEstimator = require('./GasEstimator');

// Reserve this multiple of the estimated network fee, so a transaction is not
// rejected if the fee market moves between the estimate and the broadcast.
const GAS_SAFETY_MULTIPLIER = 1.5;

// The least that must stay in a wallet after a send, regardless of the fee.
//
// Solana refuses a transfer that would leave the sender with a non-zero
// balance below the rent-exempt minimum (890,880 lamports for a bare
// account). The fee-based reserve is a hundred times smaller than that, so a
// small SOL wallet passed every check here and then failed at broadcast with
// "insufficient funds for rent". The platform fee left behind usually covers
// it, but not for a wallet under about $3.
const MIN_RESERVE_NATIVE = Object.fromEntries(
  chains.list().filter((c) => c.minReserveNative > 0).map((c) => [c.code, c.minReserveNative])
);

// How many transactions each route costs the wallet's coin in gas. A token
// swap is an approval and the swap; a token that is swapped on the chain and
// then shifted is those plus the send of what came out. A THORChain deposit
// of a token on an EVM chain is an approval and the router call.
const TX_COUNT = { direct: 1, sideshift: 1, thorchain: 1, dex: 2, 'dex+sideshift': 3, 'dex+thorchain': 3 };

// The plan's `type` for each route - the vocabulary the API and dashboard
// have always spoken, extended.
const TYPE_OF = { direct: 'DIRECT_TRANSFER', sideshift: 'SWAP', thorchain: 'SWAP', dex: 'DEX_SWAP', 'dex+sideshift': 'DEX_THEN_SWAP', 'dex+thorchain': 'DEX_THEN_SWAP' };

// The cross-chain providers, best first: THORChain holds nothing and asks
// for no account; SideShift is the custodial fallback.
const CROSS_CHAIN = ['thorchain', 'sideshift'];

// Which provider wins when both serve a pair: 'best' takes the higher
// output; naming a provider takes it whenever it serves the pair (a
// no-custodian policy, or a test of one route), with the other as the
// fallback when it refuses.
const CROSS_CHAIN_PREFER = ['thorchain', 'sideshift'].includes(String(process.env.CROSS_CHAIN_PREFER || '').toLowerCase())
    ? String(process.env.CROSS_CHAIN_PREFER).toLowerCase()
    : 'best';

/**
 * SwapService - turns what a merchant's wallets hold into what they asked to
 * be paid.
 *
 * Every wallet holds its chain's coin and, on an EVM chain, perhaps a dollar
 * token or two. Each holding is a "leg" of the withdrawal, and each leg has
 * a route to the payout asset:
 *
 *   direct         the same asset on the same chain: a plain send
 *   dex            another asset on the same chain: a router swap on the
 *                  chain itself, paid straight to the recipient (DexService)
 *   thorchain      another chain: a deposit to THORChain's vault with a
 *                  memo; the network pays the destination, no custodian
 *   sideshift      another chain: a shift SideShift serves end to end
 *   dex+thorchain  another chain, when only the chain's coin can travel:
 *   dex+sideshift  swap the token to the coin first, then send it across
 *
 * Both cross-chain providers are quoted when both serve a pair, and the one
 * that pays more wins. A leg with no route stays in the wallet and says why.
 */

class SwapService {
    constructor() {
        // Providers come from the shared factory, which fails over between
        // endpoints. Constructing one here pinned every call to a single URL.
        this.providers = {
            get mainnet() { return EthereumProvider.getProvider(); },
        };

        this.priceService = PriceService;
        this.sideshift = new SideshiftService(this.priceService);
        this.thorchain = ThorchainService;
        this.dex = DexService;
        this.gasFloat = GasFloatService;
        this.feeCollection = FeeCollectionService;
        this.preference = CROSS_CHAIN_PREFER;
    }

    /**
     * Generate a random ID for swap orders
     * @returns {string} Random ID
     */

    generateRandomId() {
        return Math.random().toString(36).substr(2, 9);
    }

    /**
     * Load what the plan needs before routes can be judged: which tokens
     * SideShift takes right now. Cached an hour; a failure keeps the coins'
     * routes and treats the tokens as not served.
     */
    async ready() {
        await Promise.all([
            typeof this.sideshift.loadCoins === 'function' ? this.sideshift.loadCoins() : null,
            typeof this.thorchain.ready === 'function' ? this.thorchain.ready() : null,
        ]);
    }

    /** The provider object for a cross-chain route name. */
    providerFor(name) {
        return name === 'thorchain' ? this.thorchain : this.sideshift;
    }

    /** Whether a cross-chain provider takes and pays an asset on a chain right now. */
    served(provider, chain, asset) {
        const service = this.providerFor(provider);
        return typeof service.serves === 'function' && service.serves(chain, asset);
    }

    /**
     * The cross-chain providers that carry `asset` on `chain` all the way to
     * `payoutAsset` on `payoutChain`, best first.
     */
    crossChainRoutes(chain, asset, payoutChain, payoutAsset) {
        return CROSS_CHAIN.filter((p) => this.served(p, chain, asset) && this.served(p, payoutChain, payoutAsset));
    }

    /**
     * How many transactions a leg's route costs the wallet's coin: a
     * THORChain deposit of a token on an EVM chain needs an approval first.
     */
    txCountFor(kind, chain, asset) {
        const base = TX_COUNT[kind] || 1;
        const isToken = asset && asset !== this.coinOf(chain);
        if (kind === 'thorchain' && isToken && chains.get(chain).family === 'evm') return base + 1;
        return base;
    }

    /** The chain's own coin, by symbol. */
    coinOf(chain) {
        return chains.get(chain).symbol;
    }

    /** What an asset on a chain is worth: the coin at its rate, a dollar token at par. */
    rateFor(chain, asset) {
        const symbol = String(asset || this.coinOf(chain)).toUpperCase();
        if (symbol !== this.coinOf(chain)) return 1;
        return this.priceService.rateFor(chain) || 0;
    }

    /**
     * How a holding reaches the payout asset, or why it cannot.
     * @returns {{kind: 'direct'|'dex'|'sideshift'|'dex+sideshift'|'none', reason?: string}}
     */
    routeFor(chain, asset, payoutChain, payoutAsset) {
        const source = chains.get(chain);
        const target = chains.get(payoutChain);
        const held = String(asset || source.symbol).toUpperCase();
        const wanted = String(payoutAsset || target.symbol).toUpperCase();

        if (chain === payoutChain) {
            if (held === wanted) return { kind: 'direct' };
            if (chains.swappableOnChain(chain)) return { kind: 'dex' };
            return { kind: 'none', reason: `${source.name} has no on-chain swap route yet, so ${held} there can only be cashed out as ${held}` };
        }

        const targetServed = CROSS_CHAIN.some((p) => this.served(p, payoutChain, wanted));
        if (!targetServed) {
            return {
                kind: 'none',
                reason: wanted === target.symbol
                    ? `${target.name} has no swap route; only a wallet already on it can be cashed out there`
                    : `No swap route settles ${wanted} on ${target.name}; only ${wanted} already on ${target.name} can be paid out as ${wanted} there`,
            };
        }
        // Straight across: every provider that carries the held asset end to
        // end, best first. The plan quotes them all and keeps the best.
        const direct = this.crossChainRoutes(chain, held, payoutChain, wanted);
        if (direct.length) return { kind: direct[0], alternatives: direct.slice(1) };
        // Via the coin: a token no provider takes is swapped on the chain for
        // the coin, which then travels.
        if (held !== source.symbol && chains.swappableOnChain(chain)) {
            const viaCoin = this.crossChainRoutes(chain, source.symbol, payoutChain, wanted).map((p) => `dex+${p}`);
            if (viaCoin.length) return { kind: viaCoin[0], alternatives: viaCoin.slice(1) };
        }
        return {
            kind: 'none',
            reason: held === source.symbol
                ? `${source.name} has no swap route; this wallet can only be cashed out in ${held} on ${source.name}`
                : `${held} on ${source.name} has no swap route off the chain; it can be cashed out as ${held}${chains.swappableOnChain(chain) ? ` or ${source.symbol}` : ''} on ${source.name}`,
        };
    }

    /**
     * Quote one cross-chain provider for a leg. Returns what comes out and
     * what the route loses, or throws with the provider's reason.
     */
    async quoteCrossChain(provider, chain, asset, payoutChain, payoutAsset, amount, recipientAddress) {
        if (provider === 'thorchain') {
            if (!recipientAddress) throw new Error('THORChain quotes need the destination address');
            const quote = await this.thorchain.quote({ fromChain: chain, fromAsset: asset, toChain: payoutChain, toAsset: payoutAsset, amount, destination: recipientAddress });
            if (quote.recommendedMin && amount < quote.recommendedMin) {
                throw new Error(`THORChain needs at least ${quote.recommendedMin} ${asset} for this route (${amount} offered)`);
            }
            return {
                provider,
                outputAmount: quote.expectedOut,
                swapFeeUsd: quote.fees.totalUsd,
                details: { inboundAddress: quote.inboundAddress, router: quote.router, memo: quote.memo, expiresAt: quote.expiresAt, minOut: quote.minOut, totalSeconds: quote.totalSeconds, feesBps: quote.fees.totalBps },
            };
        }
        const quote = await this.sideshift.getGasQuote(chain, payoutChain, amount, asset, payoutAsset);
        if (!quote) throw new Error('SideShift gave no quote');
        return { provider, outputAmount: quote.outputAmount, swapFeeUsd: quote.estimatedGasUsd, details: { quoteId: quote.quoteId || null, rate: quote.rate || null } };
    }

    /**
     * The best of the providers for a cross-chain leg: each is quoted, one
     * that refuses is dropped, and the one that pays out most wins. Throws
     * with every refusal when none will.
     */
    async bestCrossChain(providers, chain, asset, payoutChain, payoutAsset, amount, recipientAddress) {
        const refusals = [];
        const quotes = [];
        for (const provider of providers) {
            try {
                quotes.push(await this.quoteCrossChain(provider, chain, asset, payoutChain, payoutAsset, amount, recipientAddress));
            } catch (error) {
                refusals.push(`${provider}: ${error.message}`);
            }
        }
        if (quotes.length === 0) throw new Error(refusals.join('; ') || 'no cross-chain quote');
        quotes.sort((a, b) => b.outputAmount - a.outputAmount);
        const preferred = this.preference !== 'best' ? quotes.find((q) => q.provider === this.preference) : null;
        const chosen = preferred || quotes[0];
        return { ...chosen, preferred: Boolean(preferred), alternatives: quotes.filter((q) => q !== chosen).map((q) => ({ provider: q.provider, outputAmount: q.outputAmount })), refusals };
    }

    /**
     * Create the order a transfer settles through, before anything is
     * broadcast.
     *
     * A shift is created here (fixed-rate from a fresh quote where it can
     * be), so the deposit address is known when the transfer is sent. An
     * on-chain swap has no order: it is quoted fresh at broadcast and settles
     * straight to the recipient. A token that is swapped on the chain first
     * and then shifted gets a variable shift of the chain's coin, because the
     * exact amount the swap yields is not known until it lands.
     *
     * @param {Object} params - Swap parameters
     * @returns {Promise<Object>} Swap order with deposit details
     */
    async executeSwap(params) {
        const { chain, wallet, recipientAddress, payoutChain = 'ETH', nativeAmount = null, route = null } = params;
        const asset = String(params.asset || this.coinOf(chain)).toUpperCase();
        const payoutAsset = String(params.payoutAsset || this.coinOf(payoutChain)).toUpperCase();
        const kind = route || this.routeFor(chain, asset, payoutChain, payoutAsset).kind;

        try {
            if (!chain || !wallet || !recipientAddress) {
                throw new Error('Missing required swap parameters');
            }

            if (!validateCryptoAddress(recipientAddress, payoutChain)) {
                throw new Error(`Invalid ${payoutChain} address`);
            }

            // Source and destination on the same chain is a plain transfer:
            // send straight to the recipient, no Sideshift order, no swap fee
            // and no $5 swap minimum. This used to be an ETH-only path.
            if (kind === 'direct') {
                return {
                    status: 'order_created',
                    orderId: 'direct_transfer_' + this.generateRandomId(),
                    direct: true,
                    route: 'direct',
                    sideshiftOrder: {
                        depositAddress: recipientAddress,
                        expiresAt: new Date().toISOString(),
                        extraId: null,
                    }
                };
            }

            // A swap on the chain itself: the router pays the recipient. It
            // is quoted again when it is sent, so nothing is created now.
            if (kind === 'dex') {
                return {
                    status: 'order_created',
                    orderId: 'dex_swap_' + this.generateRandomId(),
                    direct: false,
                    route: 'dex',
                    dexSwap: { chain, from: asset, to: payoutAsset, recipient: recipientAddress },
                    sideshiftOrder: {
                        depositAddress: recipientAddress,
                        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
                        extraId: null,
                    }
                };
            }

            if (kind === 'none') {
                throw new Error(this.routeFor(chain, asset, payoutChain, payoutAsset).reason);
            }

            // The deposit the cross-chain leg makes: the asset held, or -
            // after an on-chain swap - the chain's coin.
            const depositAsset = kind.startsWith('dex+') ? this.coinOf(chain) : asset;

            // THORChain: nothing is created anywhere. The quote names the
            // vault to pay and the memo to attach; it is taken again at
            // broadcast, for the exact amount, because vaults rotate and
            // the quote carries an expiry.
            if (kind === 'thorchain' || kind === 'dex+thorchain') {
                const quote = await this.thorchain.quote({
                    fromChain: chain, fromAsset: depositAsset, toChain: payoutChain, toAsset: payoutAsset,
                    amount: nativeAmount && nativeAmount > 0 ? nativeAmount : 1, destination: recipientAddress,
                });
                console.log(`\n[SwapService] THORChain ${depositAsset}@${chain} -> ${payoutAsset}@${payoutChain}: vault ${quote.inboundAddress}, memo ${quote.memo}`);
                return {
                    status: 'order_created',
                    orderId: 'thor_' + this.generateRandomId(),
                    direct: false,
                    route: kind,
                    ...(kind === 'dex+thorchain' && { dexSwap: { chain, from: asset, to: depositAsset, recipient: wallet.address } }),
                    thorSwap: {
                        inboundAddress: quote.inboundAddress,
                        router: quote.router,
                        memo: quote.memo,
                        expiry: quote.expiry,
                        expectedOut: quote.expectedOut,
                        minOut: quote.minOut,
                        recommendedMin: quote.recommendedMin,
                        deposit: quote.deposit,
                    },
                    sideshiftOrder: {
                        type: 'thorchain',
                        depositAddress: quote.inboundAddress,
                        depositAsset,
                        expiresAt: quote.expiresAt,
                        extraId: null,
                        settleAmount: String(quote.expectedOut),
                    }
                };
            }

            // Quote now, at execution, and create a fixed-rate shift from it.
            // The preview's quote is minutes old by the time the client
            // confirms, and a fixed shift only lives fifteen minutes from its
            // quote, so it is taken fresh here and broadcast straight after.
            // A shift that follows an on-chain swap cannot be fixed: the swap
            // decides the deposit.
            let order = null;
            if (kind === 'sideshift' && nativeAmount && nativeAmount > 0) {
                const quote = await this.sideshift.getGasQuote(chain, payoutChain, nativeAmount, depositAsset, payoutAsset);
                if (quote && quote.quoteId) {
                    try {
                        console.log(`\n[SwapService] Creating fixed Sideshift order ${depositAsset}@${chain} -> ${payoutAsset}@${payoutChain} at rate ${quote.rate}...`);
                        order = await this.sideshift.createOrder({
                            fromChain: chain,
                            toChain: payoutChain,
                            fromAsset: depositAsset,
                            toAsset: payoutAsset,
                            destinationAddress: recipientAddress,
                            refundAddress: wallet.address,
                            quote,
                        });
                    } catch (error) {
                        console.warn(`[SwapService] Fixed order failed (${error.message}); falling back to a variable-rate shift`);
                    }
                } else {
                    console.warn(`[SwapService] No fixed quote for ${depositAsset}@${chain} -> ${payoutAsset}@${payoutChain}; falling back to a variable-rate shift`);
                }
            }

            if (!order) {
                console.log(`\n[SwapService] Creating variable Sideshift order ${depositAsset}@${chain} -> ${payoutAsset}@${payoutChain}...`);
                order = await this.sideshift.createOrder({
                    fromChain: chain,
                    toChain: payoutChain,
                    fromAsset: depositAsset,
                    toAsset: payoutAsset,
                    destinationAddress: recipientAddress,
                    refundAddress: wallet.address,
                });
            }

            console.log(`\n[SwapService] ✓ ${order.type} order ${order.orderId} created`);

            return {
                status: 'order_created',
                orderId: order.orderId,
                direct: false,
                route: kind,
                ...(kind === 'dex+sideshift' && { dexSwap: { chain, from: asset, to: depositAsset, recipient: wallet.address } }),
                sideshiftOrder: {
                    type: order.type,
                    depositAddress: order.depositAddress,
                    depositAsset,
                    expiresAt: order.expiresAt,
                    extraId: order.extraId,
                    // Set on a fixed shift: the deposit it will settle, exactly.
                    depositAmount: order.depositAmount,
                    settleAmount: order.settleAmount,
                    depositMin: order.depositMin,
                    depositMax: order.depositMax,
                    rate: order.rate,
                    quoteId: order.quoteId,
                }
            };
        } catch (error) {
            throw new Error(`Failed to execute ${asset}@${chain} to ${payoutAsset}@${payoutChain} swap: ${error.message}`);
        }
    }

    /**
     * Minimum USD a wallet must hold to be worth withdrawing from.
     *
     * A shift through SideShift will not settle below about $5. THORChain
     * has no such floor of its own beyond a recommended minimum the quote
     * states (and the plan enforces), so a THORChain leg only has to be
     * worth a dollar here. A same-chain payout is just a transfer or an
     * on-chain swap, so it only has to clear its own network fee.
     *
     * `gasUsd` is the live cost of a send on that chain. It used to come from a
     * hardcoded table, which rejected withdrawable wallets when fees were low
     * and under-reserved when they were high.
     */
    minimumBalanceUsd(walletChain, payoutChain, feeRate, gasUsd, kind = null) {
        const gas = Number.isFinite(gasUsd) ? gasUsd : 1.0;
        const swapMinimum = walletChain === payoutChain ? 0 : (kind && /thorchain/.test(kind) ? 1 : 5);
        // Reserve headroom above the bare cost so a wallet that only just
        // qualifies does not end up sending dust.
        return (swapMinimum + gas * 2) / (1 - feeRate);
    }

    /**
     * The legs a wallet contributes: its coin, and on an EVM chain each
     * dollar token it holds. Amounts are what the wallet holds; the reserve
     * and fee come off in the plan.
     */
    legsOf(wallet) {
        const chain = wallet.chain.toUpperCase();
        const spec = chains.get(chain);
        // What the address holds is not all the merchant's: the platform's
        // fee was taken when the payment arrived and is waiting here for the
        // sweep. A withdrawal moves what is theirs and leaves that behind.
        const ours = (asset, balance) => Math.max(0, Number((balance - this.feeCollection.heldFor(wallet, asset)).toFixed(12)));
        const legs = [{ asset: spec.symbol, balance: ours(spec.symbol, parseFloat(wallet.balance) || 0), native: true }];
        if (spec.family === 'evm') {
            const held = wallet.tokenBalances || {};
            for (const token of chains.tokensOf(chain)) {
                const balance = ours(token.symbol, parseFloat(held[token.symbol]) || 0);
                if (balance > 0) legs.push({ asset: token.symbol, balance, native: false });
            }
        }
        return legs;
    }

    /**
     * Build a withdrawal plan converting each wallet's holdings into
     * `payoutAsset` on `payoutChain`.
     *
     * @param {Array} wallets - Source wallets
     * @param {number} amount - Total USD across those wallets
     * @param {string} payoutChain - Chain the client is cashing out in
     * @param {string} [payoutAsset] - The asset on it: its coin by default
     * @param {string} [recipientAddress] - Where it goes; on-chain swaps are quoted to it
     * @returns {Promise<Object>} Withdrawal plan
     */
    async planBatchWithdrawal(wallets, amount, payoutChain = 'ETH', payoutAsset = null, recipientAddress = null) {
        const wanted = String(payoutAsset || this.coinOf(payoutChain)).toUpperCase();
        const plan = { payoutChain, payoutAsset: wanted, transfers: [], skipped: [] };
        const feeRate = config.payouts.platformFeeRate;
        const payoutRate = this.rateFor(payoutChain, wanted);

        // Which tokens SideShift takes is a live list; load it once here.
        await this.ready();

        // One live estimate per chain, shared across every wallet on it.
        const gas = await GasEstimator.estimateMany(wallets.map((w) => w.chain));

        for (const wallet of wallets) {
            const chain = wallet.chain.toUpperCase();
            const chainGas = gas[chain] || { native: 0, usd: 0 };
            const skip = (asset, reason) => {
                console.log(`[SwapService] Skipping ${asset}@${chain} - ${reason}`);
                plan.skipped.push({ chain, asset, fromAddress: wallet.address, reason });
            };

            const legs = this.legsOf(wallet).map((leg) => ({ ...leg, route: this.routeFor(chain, leg.asset, payoutChain, wanted) }));
            const native = legs.find((leg) => leg.native);
            const tokens = legs.filter((leg) => !leg.native);

            // The tokens' gas comes out of the coin. What the coin has to
            // keep back is the fee for every transaction the wallet will
            // send, with headroom for the fee market moving, and never less
            // than the chain's own floor for a funded account.
            const perTx = chainGas.native * GAS_SAFETY_MULTIPLIER;
            let tokenTxs = tokens.filter((leg) => leg.route.kind !== 'none').reduce((sum, leg) => sum + this.txCountFor(leg.route.kind, chain, leg.asset), 0);

            // A wallet holding tokens but not the coin to send them with. The
            // gas float advances the shortfall when there is one, charged to
            // the first token leg at par; otherwise the tokens stay, and the
            // reason says exactly what is missing.
            let gasTopUp = null;
            if (tokenTxs > 0 && native.balance < perTx * tokenTxs) {
                const need = perTx * tokenTxs;
                const shortfall = need - native.balance;
                const covered = await this.gasFloat.canCover(chain, shortfall, perTx);
                if (covered) {
                    gasTopUp = { amountNative: shortfall, usd: this.gasFloat.usdOf(chain, shortfall) };
                    console.log(`[SwapService] ${chain} ${wallet.address}: gas float advances ${shortfall.toFixed(8)} ${native.asset} ($${gasTopUp.usd.toFixed(2)}) for ${tokenTxs} token transaction(s)`);
                } else {
                    for (const leg of tokens) {
                        if (leg.route.kind === 'none') continue;
                        skip(leg.asset, `holds ${leg.balance} ${leg.asset} but only ${native.balance.toFixed(6)} ${native.asset}; sending it needs about ${need.toFixed(6)} ${native.asset} ($${(need * this.rateFor(chain)).toFixed(2)}) for the network fee`);
                        leg.route = { kind: 'none', reason: 'no gas', quiet: true };
                    }
                    tokenTxs = 0;
                }
            }

            // What the coin keeps back if it is sent too: its own fee and the
            // tokens' fees.
            const reserved = Math.max(perTx * (tokenTxs + 1), MIN_RESERVE_NATIVE[chain] || 0);

            for (const leg of legs) {
                // an empty holding is not a holding
                if (!(leg.balance > 0)) continue;
                if (leg.route.kind === 'none') {
                    if (!leg.route.quiet) skip(leg.asset, leg.route.reason);
                    continue;
                }
                const rate = this.rateFor(chain, leg.asset);
                const balanceUSD = leg.balance * rate;
                // The fee was taken on the way in, so the minimum is what it
                // costs to send, not that grossed up for a fee to come.
                const minBalanceUSD = this.minimumBalanceUsd(chain, payoutChain, 0, chainGas.usd * this.txCountFor(leg.route.kind, chain, leg.asset), leg.route.kind);
                if (balanceUSD < minBalanceUSD) {
                    skip(leg.asset, `balance $${balanceUSD.toFixed(2)} below $${minBalanceUSD.toFixed(2)} minimum for a ${wanted}@${payoutChain} payout`);
                    continue;
                }

                // Everything of theirs above the reserve is swept. The
                // platform's fee is not taken here - it was taken when the
                // payment arrived and is already out of `leg.balance` - so
                // what comes off is the network's reserve and, for a token
                // leg the float fronted gas for, that advance at par.
                const sweepable = Math.max(0, leg.balance - (leg.native ? reserved : 0));
                const feeAmount = 0;
                const advance = !leg.native && gasTopUp && !gasTopUp.charged ? gasTopUp : null;
                const advanceInAsset = advance ? advance.usd / rate : 0;
                const sendAmount = sweepable - advanceInAsset;
                if (sendAmount <= 0) {
                    skip(leg.asset, advance ? `nothing left after the ${advance.usd.toFixed(2)} USD gas advance` : 'nothing left to send');
                    continue;
                }
                if (advance) advance.charged = true;

                let kind = leg.route.kind;
                let expectedOutputAmount;
                let swapFeeUsd = 0;
                let dexQuote = null;
                let crossQuote = null;
                try {
                    if (kind === 'direct') {
                        expectedOutputAmount = sendAmount;
                    } else if (kind === 'dex') {
                        dexQuote = await this.dex.quote({ chain, from: leg.asset, to: wanted, amount: sendAmount, sender: wallet.address, recipient: recipientAddress || wallet.address });
                        expectedOutputAmount = dexQuote.amountOut;
                        swapFeeUsd = dexQuote.spreadUsd;
                    } else if (!kind.startsWith('dex+')) {
                        // Straight across: every provider that carries it,
                        // and the one that pays most.
                        const providers = [kind, ...(leg.route.alternatives || [])];
                        crossQuote = await this.bestCrossChain(providers, chain, leg.asset, payoutChain, wanted, sendAmount, recipientAddress);
                        kind = crossQuote.provider;
                        expectedOutputAmount = crossQuote.outputAmount;
                        swapFeeUsd = crossQuote.swapFeeUsd;
                    } else {
                        // Swap to the coin on the chain (to the wallet itself),
                        // then send the coin across. The crossing is quoted on
                        // the swap's floor, so the figure shown is the least it
                        // will be.
                        dexQuote = await this.dex.quote({ chain, from: leg.asset, to: this.coinOf(chain), amount: sendAmount, sender: wallet.address, recipient: wallet.address });
                        const providers = [kind, ...(leg.route.alternatives || [])].map((k) => k.replace(/^dex\+/, ''));
                        crossQuote = await this.bestCrossChain(providers, chain, this.coinOf(chain), payoutChain, wanted, dexQuote.minAmountOut, recipientAddress);
                        kind = `dex+${crossQuote.provider}`;
                        expectedOutputAmount = crossQuote.outputAmount;
                        swapFeeUsd = dexQuote.spreadUsd + crossQuote.swapFeeUsd;
                    }
                } catch (error) {
                    if (advance) advance.charged = false;
                    skip(leg.asset, error.message);
                    continue;
                }
                const gasUsd = chainGas.usd * this.txCountFor(kind, chain, leg.asset);

                // On a Bitcoin-style chain a plain send (direct, or the
                // deposit to a shift) can carry the fee already held out to
                // the platform as a second output, saving it a transaction of
                // its own later. A THORChain deposit is not given one - the
                // vault's parser is owed a transaction it expects.
                const feeOutput = leg.native && (kind === 'direct' || kind === 'sideshift')
                    ? this.feeCollection.feeOutputFor(chain, this.feeCollection.heldFor(wallet, leg.asset))
                    : null;

                plan.transfers.push({
                    type: TYPE_OF[kind],
                    route: kind,
                    chain,
                    asset: leg.asset,
                    payoutChain,
                    payoutAsset: wanted,
                    fromAddress: wallet.address,
                    // The amount sent, in `asset`. Named for the days when
                    // every leg was the chain's coin; the API still reads it.
                    nativeAmount: sendAmount,
                    expectedOutputAmount,
                    // What this leg contributes. The platform's fee is not
                    // in it: that was taken when the money arrived.
                    walletValueUSD: sweepable * rate,
                    platformFeeNative: feeAmount,
                    platformFeeUSD: feeAmount * rate,
                    // A fee held from earlier payments, leaving in this very
                    // transaction because the chain allows a second output.
                    ...(feeOutput && { feeOutput }),
                    // The gas the float advanced for this wallet's tokens,
                    // charged here in the token. Sent to the wallet right
                    // before this leg runs.
                    ...(advance && { gasTopUp: { amountNative: advance.amountNative, usd: advance.usd, chargedInAsset: advanceInAsset } }),
                    gasAdvanceUsd: advance ? advance.usd : 0,
                    networkReserveNative: leg.native ? reserved : 0,
                    transactionValueUSD: expectedOutputAmount * payoutRate,
                    // The network fees this leg's transactions cost, and what
                    // the route loses to spread. `estimatedGas` is their sum:
                    // the cost line the totals have always summed.
                    gasUsd,
                    swapFeeUsd,
                    estimatedGas: gasUsd + swapFeeUsd,
                    gasIsLive: chainGas.live !== false,
                    ...(dexQuote && {
                        dexQuote: {
                            provider: dexQuote.provider, to: dexQuote.to, amountOut: dexQuote.amountOut, minAmountOut: dexQuote.minAmountOut,
                            impact: dexQuote.impact, router: dexQuote.router, quotedAt: dexQuote.quotedAt,
                        },
                    }),
                    ...(crossQuote && {
                        crossQuote: { provider: crossQuote.provider, outputAmount: crossQuote.outputAmount, preferred: Boolean(crossQuote.preferred), ...crossQuote.details, alternatives: crossQuote.alternatives, refusals: crossQuote.refusals },
                    }),
                    status: 'PENDING',
                });
            }
        }

        console.log(`\n[SwapService] Withdrawal plan complete: ${plan.transfers.length} transfer(s) settling in ${wanted} on ${payoutChain}`);

        return plan;
    }
}

module.exports = new SwapService();
module.exports.MIN_RESERVE_NATIVE = MIN_RESERVE_NATIVE;
module.exports.TX_COUNT = TX_COUNT;
module.exports.TYPE_OF = TYPE_OF;
module.exports.CROSS_CHAIN = CROSS_CHAIN;
