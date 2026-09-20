const { ethers } = require('ethers');
const PriceService = require('./PriceService');
const SideshiftService = require('./SideshiftService')
const BitcoinWalletService = require('./wallets/BitcoinWalletService');
const SolanaWalletService = require('./wallets/SolanaWalletService');
const LitecoinWalletService = require('./wallets/LitecoinWalletService');
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
  require('../config/chains').list().filter((c) => c.minReserveNative > 0).map((c) => [c.code, c.minReserveNative])
);

/**
 * SwapService - Handles token swaps using Sideshift
 * Simple order-based flow:
 * 1. Create order between any two of BTC / ETH / LTC / SOL
 * 2. Get deposit address
 * 3. User sends tokens to deposit address
 * 4. Sideshift automatically swaps and sends to destination
 * 5. No wrapping, native token swaps on all chains
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
    }

    /**
     * Get current ETH to SOL exchange rate
     */
    getEthSolRate() {
        return this.priceService.getEthRate('sol') || 0;
    }

    /**
     * Get current ETH to BTC exchange rate
     */
    getEthBtcRate() {
        return this.priceService.getEthRate('btc') || 0;
    }

    /**
     * Get current ETH to LTC exchange rate
     */
    getEthLtcRate() {
        return this.priceService.getEthRate('ltc') || 0;
    }

    /**
     * Calculate how much ETH you'd get from swapping native token
     * @param {string} chain - Chain to swap from (SOL, BTC, LTC)
     * @param {number} amount - Amount in native token
     * @returns {number} Amount in ETH
     */
    calculateSwapAmount(chain, amount) {
        let rate;

        if (chain === 'SOL') {
            rate = this.getEthSolRate();
        } else if (chain === 'BTC') {
            rate = this.getEthBtcRate();
        } else if (chain === 'LTC') {
            rate = this.getEthLtcRate();
        } else {
            throw new Error(`No swap rate available for ${chain}`);
        }

        return amount * rate;
    }

    /**
     * Calculate swap with slippage (legacy fallback)
     * @param {string} chain - Chain to swap from
     * @param {number} amount - Amount in native token
     * @param {number} slippagePercent - Slippage tolerance (default 0.5%)
     * @returns {Object} Swap details with slippage
     */
    getSwapQuote(chain, amount, slippagePercent = 0.5) {
        const ethAmount = this.calculateSwapAmount(chain, amount);
        const slippageAmount = ethAmount * (slippagePercent / 100);
        const minReceived = ethAmount - slippageAmount;

        return {
            chain,
            amountIn: amount,
            expectedOutput: ethAmount,
            minOutput: minReceived,
            slippage: slippagePercent,
            slippageAmount,
            source: 'PriceService (fallback)',
        };
    }

    /**
     * Generate a random ID for swap orders
     * @returns {string} Random ID
     */

    generateRandomId() {
        return Math.random().toString(36).substr(2, 9);
    }

    /**
     * Execute a swap via Sideshift - creates order and returns deposit address
     * User sends native tokens to deposit address, Sideshift handles swap
     * @param {Object} params - Swap parameters
     * @returns {Promise<Object>} Swap order with deposit details
     */
    async executeSwap(params) {
        const { chain, wallet, recipientAddress, payoutChain = 'ETH', nativeAmount = null } = params;

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
            if (chain === payoutChain) {
                return {
                    status: 'order_created',
                    orderId: 'direct_transfer_' + this.generateRandomId(),
                    direct: true,
                    sideshiftOrder: {
                        depositAddress: recipientAddress,
                        expiresAt: new Date().toISOString(),
                        extraId: null,
                    }
                };
            }

            // Quote now, at execution, and create a fixed-rate shift from it.
            // The preview's quote is minutes old by the time the client
            // confirms, and a fixed shift only lives fifteen minutes from its
            // quote, so it is taken fresh here and broadcast straight after.
            let order = null;
            if (nativeAmount && nativeAmount > 0) {
                const quote = await this.sideshift.getGasQuote(chain, payoutChain, nativeAmount);
                if (quote && quote.quoteId) {
                    try {
                        console.log(`\n[SwapService] Creating fixed Sideshift order ${chain} -> ${payoutChain} at rate ${quote.rate}...`);
                        order = await this.sideshift.createOrder({
                            fromChain: chain,
                            toChain: payoutChain,
                            destinationAddress: recipientAddress,
                            refundAddress: wallet.address,
                            quote,
                        });
                    } catch (error) {
                        console.warn(`[SwapService] Fixed order failed (${error.message}); falling back to a variable-rate shift`);
                    }
                } else {
                    console.warn(`[SwapService] No fixed quote for ${chain} -> ${payoutChain}; falling back to a variable-rate shift`);
                }
            }

            if (!order) {
                console.log(`\n[SwapService] Creating variable Sideshift order ${chain} -> ${payoutChain}...`);
                order = await this.sideshift.createOrder({
                    fromChain: chain,
                    toChain: payoutChain,
                    destinationAddress: recipientAddress,
                    refundAddress: wallet.address,
                });
            }

            console.log(`\n[SwapService] ✓ ${order.type} order ${order.orderId} created`);

            return {
                status: 'order_created',
                orderId: order.orderId,
                direct: false,
                sideshiftOrder: {
                    type: order.type,
                    depositAddress: order.depositAddress,
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
            throw new Error(`Failed to execute ${chain} to ${payoutChain} swap via Sideshift: ${error.message}`);
        }
    }

    /**
     * Minimum USD a wallet must hold to be worth withdrawing from.
     *
     * A swap goes through Sideshift, which will not settle below about $5. A
     * same-chain payout is just a transfer, so it only has to clear its own
     * network fee.
     *
     * `gasUsd` is the live cost of a send on that chain. It used to come from a
     * hardcoded table, which rejected withdrawable wallets when fees were low
     * and under-reserved when they were high.
     */
    minimumBalanceUsd(walletChain, payoutChain, feeRate, gasUsd) {
        const gas = Number.isFinite(gasUsd) ? gasUsd : 1.0;
        const swapMinimum = walletChain === payoutChain ? 0 : 5;
        // Reserve headroom above the bare cost so a wallet that only just
        // qualifies does not end up sending dust.
        return (swapMinimum + gas * 2) / (1 - feeRate);
    }

    /**
     * Build a withdrawal plan converting each wallet into `payoutChain`.
     *
     * @param {Array} wallets - Source wallets
     * @param {number} amount - Total USD across those wallets
     * @param {string} payoutChain - Chain the client is cashing out in
     * @returns {Promise<Object>} Withdrawal plan
     */
    async planBatchWithdrawal(wallets, amount, payoutChain = 'ETH') {
        const plan = { payoutChain, transfers: [] };
        const feeRate = config.payouts.platformFeeRate;

        // One live estimate per chain, shared across every wallet on it.
        const gas = await GasEstimator.estimateMany(wallets.map((w) => w.chain));

        for (const wallet of wallets) {
            const chain = wallet.chain.toUpperCase();
            const chainGas = gas[chain] || { native: 0, usd: 0 };
            const minBalanceUSD = this.minimumBalanceUsd(chain, payoutChain, feeRate, chainGas.usd);

            if (wallet.balanceUSD < minBalanceUSD) {
                console.log(`[SwapService] Skipping ${chain} - balance $${(wallet.balanceUSD || 0).toFixed(2)} below $${minBalanceUSD.toFixed(2)} minimum for a ${payoutChain} payout`);
                continue;
            }

            // Reserve the live network fee, with headroom in case the fee
            // market moves between now and the broadcast - and never less than
            // the chain's own floor for a funded account.
            const reserved = Math.max(chainGas.native * GAS_SAFETY_MULTIPLIER, MIN_RESERVE_NATIVE[chain] || 0);

            // Everything above the reserve is swept. The platform fee is taken
            // out of this amount rather than left sitting in the wallet, so the
            // figure quoted to the client is the figure that is actually sent.
            const sweepable = Math.max(0, wallet.balance - reserved);
            const feeNative = sweepable * feeRate;
            const nativeSendAmount = sweepable - feeNative;

            if (nativeSendAmount <= 0) {
                console.log(`[SwapService] Skipping ${chain} - nothing left after fees`);
                continue;
            }

            const isDirect = chain === payoutChain;
            const quote = await this.sideshift.getGasQuote(chain, payoutChain, nativeSendAmount);

            if (!quote) {
                console.warn(`[SwapService] No quote for ${chain} -> ${payoutChain}; skipping ${wallet.address}`);
                continue;
            }

            const sourceRate = this.priceService[`${chain.toLowerCase()}ToUsdRate`] || 0;
            const payoutRate = this.priceService[`${payoutChain.toLowerCase()}ToUsdRate`] || 0;

            plan.transfers.push({
                type: isDirect ? 'DIRECT_TRANSFER' : 'SWAP',
                chain,
                payoutChain,
                fromAddress: wallet.address,
                nativeAmount: nativeSendAmount,
                expectedOutputAmount: quote.outputAmount,
                // What this wallet contributes, gross of the platform fee.
                walletValueUSD: sweepable * sourceRate,
                platformFeeNative: feeNative,
                platformFeeUSD: feeNative * sourceRate,
                networkReserveNative: reserved,
                transactionValueUSD: quote.outputAmount * payoutRate,
                estimatedGas: quote.estimatedGasUsd,
                gasIsLive: chainGas.live !== false,
                status: 'PENDING',
            });
        }

        console.log(`\n[SwapService] Withdrawal plan complete: ${plan.transfers.length} transfer(s) settling in ${payoutChain}`);

        return plan;
    }
}

module.exports = new SwapService();
module.exports.MIN_RESERVE_NATIVE = MIN_RESERVE_NATIVE;
