const { ethers } = require('ethers');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const ProxyService = require('../ProxyService');

require('dotenv').config();

class EthereumWalletService {
  constructor() {
    // Ethereum networks with RPC endpoint fallbacks
    this.networks = {
      mainnet: {
        name: 'Ethereum Mainnet',
        chainId: 1,
        rpcUrls: [
          'https://ethereum-rpc.publicnode.com',
          'https://1rpc.io/eth',
          'https://eth-mainnet.public.blastapi.io',
        ],
      }
    };

    // Lazy load providers
    this._providers = {};

    // BIP44 derivation paths for Ethereum
    this.derivationPaths = {
      mainnet: "m/44'/60'/0'/0/0",
    };
  }

  /**
   * Get or create a provider for the network
   * @param {string} network - Network name
   * @returns {ethers.JsonRpcProvider} Provider instance
   */
  getProvider(network = 'mainnet') {
    if (!this._providers[network]) {
      const networkConfig = this.networks[network];
      if (!networkConfig) {
        throw new Error(`Invalid network: ${network}`);
      }

      // Use first RPC URL (public node)
      const rpcUrl = networkConfig.rpcUrls ? networkConfig.rpcUrls[0] : networkConfig.rpcUrl;
      this._providers[network] = new ethers.JsonRpcProvider(rpcUrl);
    }
    return this._providers[network];
  }

  /**
   * Generate Ethereum wallet from BIP39 mnemonic
   * Uses BIP44 derivation path: m/44'/60'/0'/0/0
   * @param {string} mnemonic - Optional BIP39 mnemonic, generates new if not provided
   * @param {string} network - Network: mainnet, sepolia, goerli
   * @returns {Object} Wallet object with address, privateKey, publicKey, mnemonic
   */
  generateWalletFromMnemonic(mnemonic = null, network = 'mainnet') {
    try {
      // Generate or use provided mnemonic
      if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
      } else if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid BIP39 mnemonic');
      }

      // Create wallet from mnemonic using BIP44 path for Ethereum (m/44'/60'/0'/0/0)
      const derivationPath = this.derivationPaths[network];
      const hdNode = ethers.HDNodeWallet.fromMnemonic(
        ethers.Mnemonic.fromPhrase(mnemonic),
        derivationPath
      );

      const wallet = new ethers.Wallet(hdNode.privateKey);

      return {
        address: wallet.address,
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        mnemonic: mnemonic,
        derivationPath: derivationPath,
        network: network,
        networkName: this.networks[network].name,
      };
    } catch (error) {
      throw new Error(`Failed to generate Ethereum wallet: ${error.message}`);
    }
  }

  /**
   * Get wallet balance in ETH
   * @param {string} address - Ethereum wallet address
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Balance information
   */
  async getBalance(address, network = 'mainnet') {
    try {
      const provider = this.getProvider(network);
      
      // Validate address format
      if (!ethers.isAddress(address)) {
        throw new Error('Invalid Ethereum address format');
      }

      const balanceWei = await provider.getBalance(address);
      const balanceEth = ethers.formatEther(balanceWei);

      return {
        address,
        balanceWei: balanceWei.toString(),
        balanceEth: parseFloat(balanceEth),
        network,
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      return {
        address,
        network,
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Update wallet balance in database
   * @param {Object} wallet - Wallet object from database
   * @param {number} ethToUsdRate - Current ETH to USD rate
   * @param {string} network - Ethereum network
   * @returns {Promise<Object>} Updated balance info
   */
  async updateBalance(wallet, ethToUsdRate, network = 'mainnet') {
    try {
      const balanceInfo = await this.getBalance(wallet.address, network);

      if (balanceInfo.status === 'success') {
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceEth,
          balanceUSD: balanceInfo.balanceEth * ethToUsdRate,
          lastUpdated: new Date().toISOString(),
        });
      }

      return balanceInfo;
    } catch (error) {
      console.error(`Error updating balance for ${wallet.address}:`, error.message);
      return {
        address: wallet.address,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Estimate gas fee for a transaction (EIP-1559 + Legacy)
   * @param {string} toAddress - Recipient address
   * @param {string} network - Network to query
   * @param {string} priority - Priority level: 'slow' | 'standard' | 'fast' (default: 'standard')
   * @param {string} operationType - Operation type: 'transfer', 'token_transfer', 'swap', 'contract', 'bridge', etc.
   * @returns {Promise<Object>} {maxFeePerGas, maxPriorityFeePerGas, gasLimit, totalFeeEth, etc.}
   */
  async estimateFee(toAddress, network = 'mainnet', priority = 'standard', operationType = 'transfer') {
    try {
      const provider = this.getProvider(network);

      // Validate address
      if (!ethers.isAddress(toAddress)) {
        throw new Error('Invalid recipient address');
      }

      // Get current fee data (includes gasPrice, maxFeePerGas, maxPriorityFeePerGas)
      const feeData = await provider.getFeeData();
      
      // Get gas limit based on operation type
      const gasLimit = BigInt(this.getGasLimitForOperation(operationType));

      // EIP-1559 fee structure
      const baseMaxFeePerGas = feeData.maxFeePerGas || BigInt(0);
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || BigInt(0);
      
      // Adjust priority fee based on priority level
      const priorityMultiplier = {
        slow: 0.8,
        standard: 1.0,
        fast: 1.5,
      };
      const multiplier = priorityMultiplier[priority] || 1.0;
      maxPriorityFeePerGas = BigInt(Math.round(Number(maxPriorityFeePerGas) * multiplier));

      // Calculate max fee (base + priority)
      const maxFeePerGas = baseMaxFeePerGas;

      // Calculate total fee
      const totalMaxFeeWei = maxFeePerGas * gasLimit;
      const totalMaxFeeEth = parseFloat(ethers.formatEther(totalMaxFeeWei));

      const maxFeeGwei = parseFloat(ethers.formatUnits(maxFeePerGas, 'gwei'));
      const priorityFeeGwei = parseFloat(ethers.formatUnits(maxPriorityFeePerGas, 'gwei'));

      console.log(`[EthereumWalletService] EIP-1559 fee estimate (${priority}, ${operationType}): Max Fee ${maxFeeGwei} gwei + Priority ${priorityFeeGwei} gwei, gas: ${gasLimit}, total: ${totalMaxFeeEth} ETH`);

      return {
        // EIP-1559 fields
        maxFeePerGas: maxFeePerGas.toString(),
        maxFeePerGasGwei: maxFeeGwei,
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        maxPriorityFeePerGasGwei: priorityFeeGwei,
        
        // Standard fields
        gasLimit: gasLimit.toString(),
        totalMaxFeeWei: totalMaxFeeWei.toString(),
        totalMaxFeeEth: totalMaxFeeEth,
        
        // Priority info
        priority: priority,
        operationType: operationType,
        network,
        status: 'success',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`[EthereumWalletService] Fee estimation error: ${error.message}`);
      return {
        network,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Get wallet transaction history
   * Note: Standard JSON-RPC doesn't provide full transaction history.
   * Returns transaction count (nonce) as a proxy.
   * For full history, use a block explorer API.
   * @param {string} address - Ethereum address
   * @param {number} limit - Number of recent transactions (unused - RPC limitation)
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Transaction history
   */
  async getTransactionHistory(address, limit = 10, network = 'mainnet') {
    try {
      const provider = this.getProvider(network);
      
      if (!ethers.isAddress(address)) {
        throw new Error('Invalid Ethereum address format');
      }

      // Get transaction count (nonce)
      const transactionCount = await provider.getTransactionCount(address);

      // Note: Full transaction history requires indexing service (The Graph, Alchemy, etc.)
      // This implementation returns transaction count only
      return {
        address,
        transactionCount,
        limit,
        network,
        note: 'Standard RPC endpoint does not provide transaction history. Use block explorer API for full history.',
        status: 'success',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        address,
        network,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * @param {string} operationType - Type: 'transfer', 'token_transfer', 'swap', 'contract', 'bridge'
   * @returns {number} Estimated gas limit in wei
   */
  getGasLimitForOperation(operationType = 'transfer') {
    const gasLimits = {
      transfer: 25000,              // Simple ETH transfer
      token_transfer: 65000,        // ERC20 token transfer
      token_approve: 45000,         // ERC20 approval
      swap: 150000,                 // Uniswap/DEX swap
      contract: 189000,             // Generic contract interaction
      bridge: 250000,               // Cross-chain bridge
      nft_transfer: 85000,          // NFT (ERC721) transfer
      nft_mint: 120000,             // NFT minting
    };

    return gasLimits[operationType] || gasLimits.transfer;
  }

  /**
   * Create a wallet in database
   * @param {string} clientId - Client ID
   * @param {string} mnemonic - Optional mnemonic
   * @param {string} network - Ethereum network (mainnet, sepolia, goerli)
   * @returns {Object} Wallet document
   */
  createWallet(clientId, mnemonic = null, network = 'mainnet') {
    try {
      // Validate network
      if (!this.networks[network]) {
        throw new Error(`Invalid network: ${network}`);
      }

      // Generate wallet
      const walletData = this.generateWalletFromMnemonic(mnemonic, network);

      // Create wallet document
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: 'ETH',
        network,
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        seedPhrase: walletData.mnemonic,
        derivationPath: walletData.derivationPath,
        balance: 0,
        balanceUSD: 0,
        lastUpdated: new Date().toISOString(),
        isActive: true,
        createdAt: new Date().toISOString(),
      };

      // Save to database
      return db.create('wallets', wallet);
    } catch (error) {
      throw new Error(`Failed to create Ethereum wallet: ${error.message}`);
    }
  }

  /**
   * Send a transaction from a wallet to an address with EIP-1559 fees
   * @param {string} privateKey - Wallet private key
   * @param {string} toAddress - Recipient address
   * @param {number} amount - Amount in ETH
   * @param {string} operationType - Operation type: 'transfer', 'token_transfer', 'swap', 'contract', etc.
   * @returns {Promise<Object>} {hash, status, fee}
   */
  async sendTransaction(privateKey, toAddress, amount, operationType = 'transfer') {
    try {
      const provider = this.getProvider('mainnet');
      const signer = new ethers.Wallet(privateKey, provider);

      // Validate recipient address
      if (!ethers.isAddress(toAddress)) {
        throw new Error(`Invalid recipient address: ${toAddress}`);
      }

      // Validate amount
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error(`Invalid amount: ${amount}. Must be a positive number`);
      }

      // Round amount to 10 decimals to avoid precision issues with ethers.js
      const roundedAmount = Math.floor(numAmount * 1e10) / 1e10;

      // Check sender balance
      const senderBalance = await provider.getBalance(signer.address);
      const senderBalanceEth = parseFloat(ethers.formatEther(senderBalance));
      
      // Get current fee data for EIP-1559
      const feeData = await provider.getFeeData();
      
      if (!feeData.maxFeePerGas || feeData.maxFeePerGas === BigInt(0)) {
        throw new Error('Unable to estimate gas fees. Please try again.');
      }

      // Priority multiplier
      const priorityMultiplier = {
        slow: 0.8,
        standard: 1.0,
        fast: 1.5,
      };
      const multiplier = priorityMultiplier['standard'] || 1.0;

      // Calculate fees
      const maxFeePerGas = feeData.maxFeePerGas;
      const basePriorityFee = feeData.maxPriorityFeePerGas || BigInt(0);
      const maxPriorityFeePerGas = BigInt(Math.round(Number(basePriorityFee) * multiplier));

      // Get appropriate gas limit for operation type
      const gasLimit = BigInt(this.getGasLimitForOperation(operationType));

      // Estimate total cost (amount + gas fees)
      const txValue = ethers.parseEther(roundedAmount.toString());
      const estimatedGasCostWei = maxFeePerGas * gasLimit;
      const estimatedGasCostEth = parseFloat(ethers.formatEther(estimatedGasCostWei));
      const totalCostEth = roundedAmount + estimatedGasCostEth;

      // Check if sender has enough balance
      if (senderBalanceEth < totalCostEth) {
        throw new Error(
          `Insufficient balance. Have ${senderBalanceEth.toFixed(8)} ETH, ` +
          `need ${totalCostEth.toFixed(8)} ETH (${roundedAmount.toFixed(8)} + ${estimatedGasCostEth.toFixed(8)} gas)`
        );
      }

      // Build EIP-1559 transaction
      const tx = await signer.sendTransaction({
        to: toAddress,
        value: txValue,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        gasLimit: gasLimit,
      });

      const maxFeeGwei = parseFloat(ethers.formatUnits(maxFeePerGas, 'gwei'));
      const priorityGwei = parseFloat(ethers.formatUnits(maxPriorityFeePerGas, 'gwei'));

      console.log(`[EthereumWalletService] Transaction sent (${operationType}): ${tx.hash}`);
      console.log(`  From: ${signer.address} | To: ${toAddress}`);
      console.log(`  Amount: ${roundedAmount} ETH | Estimated Gas Cost: ${estimatedGasCostEth.toFixed(8)} ETH`);
      console.log(`  Max Fee: ${maxFeeGwei.toFixed(2)} gwei | Priority: ${priorityGwei.toFixed(2)} gwei | Gas: ${gasLimit}`);

      return {
        hash: tx.hash,
        from: signer.address,
        to: toAddress,
        amount: roundedAmount,
        priority: 'standard',
        operationType: operationType,
        maxFeePerGasGwei: maxFeeGwei,
        maxPriorityFeePerGasGwei: priorityGwei,
        gasLimit: gasLimit.toString(),
        estimatedGasCostEth: estimatedGasCostEth,
        status: 'pending',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to send Ethereum transaction: ${error.message}`);
    }
  }
}

// Export as singleton
module.exports = new EthereumWalletService();
