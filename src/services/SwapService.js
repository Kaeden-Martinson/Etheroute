const { ethers } = require('ethers');
const PriceService = require('./PriceService');
const SideshiftService = require('./SideshiftService')
const BitcoinWalletService = require('./wallets/BitcoinWalletService');
const SolanaWalletService = require('./wallets/SolanaWalletService');
const LitecoinWalletService = require('./wallets/LitecoinWalletService');

/**
 * SwapService - Handles token swaps using Sideshift
 * Simple order-based flow:
 * 1. Create order (BTC → ETH, SOL → ETH, LTC → ETH)
 * 2. Get deposit address
 * 3. User sends tokens to deposit address
 * 4. Sideshift automatically swaps and sends to destination
 * 5. No wrapping, native token swaps on all chains
 */

class SwapService {
    constructor() {
        this.providers = {
            mainnet: new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com'),
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
        const { chain, wallet, recipientAddress } = params;

        try {
            if (!chain || !wallet || !recipientAddress) {
                throw new Error('Missing required swap parameters');
            }

            const ethAddressValid = /^0x[a-fA-F0-9]{40}$/.test(recipientAddress);
            if (!ethAddressValid) {
                throw new Error('Invalid Ethereum address');
            }

            if (chain === 'ETH') {
                return {
                    status: 'order_created',
                    orderId: "direct_transfer_" + this.generateRandomId(),
                    sideshiftOrder: {
                        depositAddress: recipientAddress,  // For direct ETH transfer, send to recipient
                        expiresAt: new Date().toISOString(),
                        extraId: null,
                    }
                };
            }

            console.log(`\n[SwapService] Creating Sideshift order...`);

            const order = await this.sideshift.createOrder({
                fromChain: chain,
                toChain: 'ETH',
                destinationAddress: recipientAddress,
                refundAddress: wallet.address,
            });

            console.log(`\n[SwapService] ✓ Order created successfully!`);

            return {
                status: 'order_created',
                orderId: order.orderId,
                sideshiftOrder: {
                    depositAddress: order.depositAddress,
                    expiresAt: order.expiresAt,
                    extraId: order.extraId,
                }
            };
        } catch (error) {
            throw new Error(`Failed to execute ${chain} to ETH swap via Sideshift: ${error.message}`);
        }
    }

    /**
     * Simulate a batch withdrawal where all wallets are swapped to ETH
     * @param {Array} wallets - Array of wallet objects
     * @param {number} amount - Amount in USD to withdraw
     * @returns {Promise<Object>} Withdrawal plan
     */
    async planBatchWithdrawal(wallets, amount) {
        const plan = {
            transfers: []
        };

        // Get USD rates from PriceService, with fallback to wallet's balanceUSD
        const priceRates = this.priceService.getAllRates();

        // Per-chain gas buffer (USD) — mirrors PayoutService eligibility criteria
        const GAS_BUFFER_USD = { ETH: .50, BTC: 1.00, SOL: 0.20, LTC: 0.50 };

        for (const wallet of wallets) {
            const gasBudget = GAS_BUFFER_USD[wallet.chain.toUpperCase()] ?? 2;
            const minBalanceUSD = (5 + gasBudget) / 0.95;
            if (wallet.balanceUSD < minBalanceUSD) {
                console.log(`[SwapService] Skipping ${wallet.chain} - balance $${(wallet.balanceUSD||0).toFixed(2)} below $${minBalanceUSD.toFixed(2)} minimum`);
                continue;
            }

            const shareOfTotal = .90;

            // Account for network fees
            let transferBalance = wallet.balance;
            if (wallet.chain === 'SOL') {
                // Reserve 5000 lamports for fee (0.000005 SOL)
                const feeInSol = 0.000005;
                transferBalance = Math.max(0, wallet.balance - feeInSol);
            } else if (wallet.chain === 'BTC') {
                // Reserve small amount for BTC fees (typically 0.00001 BTC)
                const feeInBtc = 0.00001;
                transferBalance = Math.max(0, wallet.balance - feeInBtc);
            } else if (wallet.chain === 'LTC') {
                // Reserve small amount for LTC fees (typically 0.00001 LTC)
                const feeInLtc = 0.00001;
                transferBalance = Math.max(0, wallet.balance - feeInLtc);
            }

            const nativeSwapAmount = transferBalance * shareOfTotal;

            if (wallet.chain === 'ETH') {
                const quote = await this.sideshift.getGasQuote('ETH', 'ETH', nativeSwapAmount);

                const transfer = {
                    type: 'DIRECT_TRANSFER',
                    chain: 'ETH',
                    fromAddress: wallet.address,
                    nativeAmount: nativeSwapAmount,
                    expectedEthAmount: quote.outputEth,
                    walletValueUSD: wallet.balanceUSD * shareOfTotal,
                    transactionValueUSD: quote.outputEth * this.priceService.ethToUsdRate,
                    estimatedGas: quote.estimatedGasUsd,
                    status: "PENDING"
                };

                plan.transfers.push(transfer);
            } else {
                // Swap to ETH for other chains
                const quote = await this.sideshift.getGasQuote(wallet.chain, 'ETH', nativeSwapAmount);

                const swap = {
                    type: 'SWAP',
                    chain: wallet.chain,
                    fromAddress: wallet.address,
                    nativeAmount: nativeSwapAmount,
                    expectedEthAmount: quote.outputEth,
                    walletValueUSD: wallet.balanceUSD * shareOfTotal,
                    transactionValueUSD: quote.outputEth * this.priceService.ethToUsdRate,
                    estimatedGas: quote.estimatedGasUsd,
                    status: "PENDING"
                };

                plan.transfers.push(swap);
            }
        }

        console.log(`\n[SwapService] Withdrawal plan complete:`);

        return plan;
    }
}

module.exports = new SwapService();
