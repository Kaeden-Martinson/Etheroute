/**
 * Sideshift Service - Cross-chain swaps with simple order-based flow
 * Create order → Send tokens to deposit address → Sideshift handles swap
 */

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { ethers } = require('ethers');
const sideshiftAccountService = require('./SideshiftAccountService');

class SideshiftService {
  constructor(priceService) {
    this.priceService = priceService;
    this.apiUrl = 'https://sideshift.ai/api/v2';

    // Chain to Sideshift asset mappings
    this.assetMap = {
      'BTC': 'btc',
      'ETH': 'eth',
      'SOL': 'sol',
      'LTC': 'ltc'
    };
  }

  /**
   * Get gas quote for a swap
   * @param {string} fromChain - Source chain (BTC, ETH, SOL, LTC)
   * @param {string} toChain - Destination chain
   * @param {number} amount - Amount in source chain units
   * @returns {Promise<Object>} Gas quote
   */

  async getGasQuote(fromChain, toChain, amount) {
    // Deal with same chain to chain gas estimation by doing a small swap quote
    if (fromChain === toChain) { // only will be ETH for now since we only support ETH direct transfers, but can expand if needed
      return {
        outputEth: amount - .15 / this.priceService.ethToUsdRate, // Approximate amount after gas cost
        changeInEth: .15 / this.priceService.ethToUsdRate, // Approximate cost of a direct transfer on mainnet
        estimatedGasUsd: .15, // Approximate cost of a direct transfer on mainnet
      }
    };

    const { account, agent, affiliateId, secret } = sideshiftAccountService.getAccount('quote');

    const requestData = {
      depositCoin: this.assetMap[fromChain] || fromChain.toLowerCase(),
      depositNetwork: 'mainnet',
      settleCoin: this.assetMap[toChain] || toChain.toLowerCase(),
      settleNetwork: 'mainnet',
      depositAmount: amount.toFixed(8).toString(), // Sideshift expects string amounts with up to 8 decimals
      settleAmount: null,
      affiliateId,
    }

    try {
      const response = await fetch(`${this.apiUrl}/quotes`, {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'x-sideshift-secret': secret
        },
        body: JSON.stringify(requestData)
      });

      sideshiftAccountService.recordUsage(account.id, 'quote');

      if (!response.ok) {
        console.log(response)
        throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`, response);
      }

      const data = await response.json();

      console.log('[SideshiftService] Received gas quote response:', data);

      const outputEth = data.settleAmount;
      const changeInEth = outputEth - amount * (this.priceService.getEthRate(fromChain.toLowerCase()) || 0);
      const estimatedGasUsd = changeInEth * this.priceService.ethToUsdRate;
      
      return {
        outputEth,
        changeInEth,
        estimatedGasUsd: estimatedGasUsd * -1,
      };
    } catch (error) {
      console.error('Error:', error);
    }
  };

  /**
   * Create a swap order
   * @param {Object} params - Order parameters
   * @param {string} params.fromChain - Source chain (BTC, ETH, SOL, LTC)
   * @param {string} params.toChain - Destination chain
   * @param {string} params.destinationAddress - Wallet to receive output
   * @returns {Promise<Object>} Order details with deposit address
   */
  async createOrder(params) {
    try {
      const {
        fromChain,
        toChain,
        destinationAddress,
        refundAddress,
      } = params;

      const { account, agent, affiliateId, secret } = sideshiftAccountService.getAccount('shift');

      const from = this.assetMap[fromChain] || fromChain.toLowerCase();
      const to = this.assetMap[toChain] || toChain.toLowerCase();

      const requestBody = {
        settleNetwork: null,
        depositNetwork: "mainnet",
        depositCoin: from,
        settleCoin: to,
        settleAddress: destinationAddress,
        refundAddress: refundAddress,
        affiliateId,
      };

      const response = await fetch(`${this.apiUrl}/shifts/variable`, {
        method: 'POST',
        agent,
        headers: {
          'x-sideshift-secret': secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      sideshiftAccountService.recordUsage(account.id, 'shift');

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to create order: ${response.statusText} - ${error}`);
      }

      const order = await response.json();

      return {
        orderId: order.id,
        status: order.status,
        depositAddress: order.depositAddress,
        depositCoin: order.depositCoin,
        settleCoin: order.settleCoin,
        settleAddress: order.settleAddress,
        refundAddress: order.refundAddress,
        expiresAt: order.expiresAt,
        extraId: order.extraId || null,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[SideshiftService] Error creating order:', error.message);
      throw error;
    }
  }

  /**
   * Get order status - handles both Sideshift orders and direct ETH transfers
   * @param {string} orderId - Order ID (can be "direct_transfer_xxx" or Sideshift order ID)
   * @param {string} txHash - Optional transaction hash (required for direct transfers)
   * @returns {Promise<Object>} Order status
   */
  async getOrderStatus(orderId, txHash) {
    try {
      // Check if this is a direct ETH transfer
      if (orderId.startsWith('direct_transfer_')) {
        if (!txHash) {
          throw new Error('Direct transfer requires transaction hash');
        }
        
        console.log(`[SideshiftService] Checking direct ETH transfer status via RPC: ${txHash}`);
        
        // Use Ethereum RPC to check transaction receipt
        const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
        const receipt = await provider.getTransactionReceipt(txHash);
        
        if (!receipt) {
          // Transaction still pending or not found
          console.log(`[SideshiftService] Direct transfer ${txHash} still pending (no receipt yet)`);
          return [{
            id: orderId,
            status: 'waiting',
            transactionHash: txHash,
            type: 'direct_transfer'
          }];
        }
        
        // Check if transaction succeeded or failed
        if (receipt.status === 1) {
          console.log(`[SideshiftService] Direct transfer ${txHash} settled (status: 1)`);
          return [{
            id: orderId,
            status: 'settled',
            transactionHash: txHash,
            blockNumber: receipt.blockNumber,
            type: 'direct_transfer'
          }];
        } else {
          console.log(`[SideshiftService] Direct transfer ${txHash} failed (status: ${receipt.status})`);
          return [{
            id: orderId,
            status: 'failed',
            transactionHash: txHash,
            blockNumber: receipt.blockNumber,
            type: 'direct_transfer'
          }];
        }
      }
      
      // Handle Sideshift order
      const { agent, secret } = sideshiftAccountService.getAccount('quote');
      const response = await fetch(`${this.apiUrl}/shifts?ids=${orderId}`, {
        agent,
        headers: {
          'x-sideshift-secret': secret,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch order: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[SideshiftService] Error fetching order status:', error.message);
      throw error;
    }
  }
}

module.exports = SideshiftService;
