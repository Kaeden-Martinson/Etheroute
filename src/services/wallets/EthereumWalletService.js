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

    this.apiUrl = "https://api.etherscan.io/v2/api";
    this.apiKey = "BDHQ71HUZYHVNSQDYYKNZTUF6EBTB1E87J";

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
  getProvider() {
    if (!this._providers.mainnet) {
      const networkConfig = this.networks.mainnet;

      // Use first RPC URL (public node)
      const rpcUrl = networkConfig.rpcUrls[0];
      this._providers.mainnet = new ethers.JsonRpcProvider(rpcUrl);
    }
    return this._providers.mainnet;
  }

  /**
   * Generate Ethereum wallet from BIP39 mnemonic
   * Uses BIP44 derivation path: m/44'/60'/0'/0/0
   * @param {string} mnemonic - Optional BIP39 mnemonic, generates new if not provided
   * @param {string} network - Network: mainnet, sepolia, goerli
   * @returns {Object} Wallet object with address, privateKey, publicKey, mnemonic
   */
  generateWalletFromMnemonic(mnemonic = null) {
    try {
      // Generate or use provided mnemonic
      if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
      } else if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid BIP39 mnemonic');
      }

      // Create wallet from mnemonic using BIP44 path for Ethereum (m/44'/60'/0'/0/0)
      const derivationPath = this.derivationPaths.mainnet;
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
        network: 'mainnet',
        networkName: this.networks.mainnet.name,
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
  async getBalance(address) {
    try {
      const provider = this.getProvider();
      
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
        network: 'mainnet',
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      return {
        address,
        network: 'mainnet',
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
  async updateBalance(wallet, ethToUsdRate) {
    try {
      const balanceInfo = await this.getBalance(wallet.address);

      if (balanceInfo.status === 'success') {
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceEth,
          balanceUSD: balanceInfo.balanceEth * ethToUsdRate,
          lastUpdated: new Date().toISOString(),
        });

        balanceInfo.balance = balanceInfo.balanceEth * ethToUsdRate; // For consistency in returned object
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
  async estimateFee(toAddress) {
    try {
      const provider = this.getProvider();

      if (!ethers.isAddress(toAddress)) {
        throw new Error('Invalid recipient address');
      }

      // Fetch fee data and the latest block in parallel so we get the real baseFeePerGas
      const [feeData, block] = await Promise.all([
        provider.getFeeData(),
        provider.getBlock('latest'),
      ]);

      // baseFeePerGas comes from the latest mined block (the ground truth for the next block)
      const baseFeePerGas = block?.baseFeePerGas ?? feeData.maxFeePerGas ?? BigInt(0);

      // Standard priority fee (1× network suggestion, 1 gwei floor)
      const priorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigInt(1_000_000_000);

      // maxFeePerGas is the EIP-1559 cap submitted to the network
      const maxFeePerGas = feeData.maxFeePerGas ?? (baseFeePerGas * BigInt(2) + priorityFeePerGas);

      // Expected effective gas price = baseFee + priorityFee (what you actually pay)
      const expectedGasPrice = baseFeePerGas + priorityFeePerGas;

      const gasLimit = BigInt(this.getGasLimitForOperation());

      const expectedFeeWei = expectedGasPrice * gasLimit;
      const expectedFeeEth = parseFloat(ethers.formatEther(expectedFeeWei));
      const maxFeeWei = maxFeePerGas * gasLimit;
      const maxFeeEth = parseFloat(ethers.formatEther(maxFeeWei));

      const baseFeeGwei     = parseFloat(ethers.formatUnits(baseFeePerGas,    'gwei'));
      const priorityFeeGwei = parseFloat(ethers.formatUnits(priorityFeePerGas, 'gwei'));
      const maxFeeGwei      = parseFloat(ethers.formatUnits(maxFeePerGas,      'gwei'));

      console.log(
        `[EthereumWalletService] Fee estimate (standard, transfer): ` +
        `base=${baseFeeGwei.toFixed(4)} gwei + priority=${priorityFeeGwei.toFixed(4)} gwei, ` +
        `gas=${gasLimit}, expected=${expectedFeeEth.toFixed(8)} ETH, max=${maxFeeEth.toFixed(8)} ETH`
      );

      return {
        // EIP-1559 fields
        maxFeePerGas: maxFeePerGas.toString(),
        maxFeePerGasGwei: maxFeeGwei,
        maxPriorityFeePerGas: priorityFeePerGas.toString(),
        maxPriorityFeePerGasGwei: priorityFeeGwei,
        baseFeePerGas: baseFeePerGas.toString(),
        baseFeePerGasGwei: baseFeeGwei,

        // Expected vs max cost
        gasLimit: gasLimit.toString(),
        expectedFeeWei: expectedFeeWei.toString(),
        expectedFeeEth,
        maxFeeWei: maxFeeWei.toString(),
        maxFeeEth,

        // Backwards-compat aliases
        totalMaxFeeWei: maxFeeWei.toString(),
        totalMaxFeeEth: maxFeeEth,

        priority: 'standard',
        operationType: 'transfer',
        network: 'mainnet',
        status: 'success',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`[EthereumWalletService] Fee estimation error: ${error.message}`);
      return { network: 'mainnet', status: 'error', error: error.message };
    }
  }

  /**
   * Get wallet transaction history
   * Note: Standard JSON-RPC doesn't provide full transaction history.
   * Returns transaction count (nonce) as a proxy.
   * For full history, use a block explorer API.
   * @param {string} address - Ethereum address
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Transaction history
   */
  async getTransactionHistory(address) {
    try {
      if (!ethers.isAddress(address)) {
        throw new Error('Invalid Ethereum address format');
      }

      const res = await ProxyService.fetch(`${this.apiUrl}?apikey=${this.apiKey}&chainid=1&module=account&action=txlist&address=${address}`).then(res => res.json());
      const transactionCount = res.result ? res.result.length : 0;

      // Note: Full transaction history requires indexing service (The Graph, Alchemy, etc.)
      // This implementation returns transaction count only
      return {
        address,
        transactionCount,
        network: 'mainnet',
        transactions: res.result || [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        address,
        network: 'mainnet',
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * @param {string} operationType - Type: 'transfer', 'token_transfer', 'swap', 'contract', 'bridge'
   * @returns {number} Estimated gas limit in wei
   */
  getGasLimitForOperation() {
    return 35000; // Plain ETH transfer (EVM minimum)
  }

  /**
   * Create a wallet in database
   * @param {string} clientId - Client ID
   * @param {string} mnemonic - Optional mnemonic
   * @param {string} network - Ethereum network (mainnet, sepolia, goerli)
   * @returns {Object} Wallet document
   */
  createWallet(clientId, mnemonic = null) {
    try {
      // Generate wallet
      const walletData = this.generateWalletFromMnemonic(mnemonic);

      // Create wallet document
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: 'ETH',
        network: 'mainnet',
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        seedPhrase: walletData.mnemonic,
        derivationPath: walletData.derivationPath,
        balance: 0,
        balanceUSD: 0,
        serviceSubtractions: 0,
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
   * @returns {Promise<Object>} {hash, status, fee}
   */
  async sendTransaction(privateKey, toAddress, amount) {
    try {
      const provider = this.getProvider();
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

      // Calculate fees
      const maxFeePerGas = feeData.maxFeePerGas;
      const basePriorityFee = feeData.maxPriorityFeePerGas || BigInt(0);
      const maxPriorityFeePerGas = BigInt(Math.round(Number(basePriorityFee) * 1.0));

      // Gas limit for a standard ETH transfer
      const gasLimit = BigInt(this.getGasLimitForOperation());

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

      console.log(`[EthereumWalletService] Transaction sent (transfer): ${tx.hash}`);
      console.log(`  From: ${signer.address} | To: ${toAddress}`);
      console.log(`  Amount: ${roundedAmount} ETH | Estimated Gas Cost: ${estimatedGasCostEth.toFixed(8)} ETH`);
      console.log(`  Max Fee: ${maxFeeGwei.toFixed(2)} gwei | Priority: ${priorityGwei.toFixed(2)} gwei | Gas: ${gasLimit}`);

      return {
        hash: tx.hash,
        from: signer.address,
        to: toAddress,
        amount: roundedAmount,
        priority: 'standard',
        operationType: 'transfer',
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
