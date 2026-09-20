/**
 * Wallet service for any EVM chain, parameterised by a registry entry.
 *
 * Ethereum, Polygon, Base, Arbitrum, Optimism, BNB Chain and Avalanche all
 * speak the same JSON-RPC and sign the same way; only the chain id, the
 * endpoints, the explorer and the gas model differ. One service handles all
 * of them - `EthereumWalletService` is now `createEvmWalletService(ETH)`.
 *
 * Every instance keeps the shape the rest of the code expects: `getBalance`
 * reports `balanceEth` (the native coin, whatever its ticker), `createWallet`
 * seals keys through the vault, `sendTransaction` takes a decimal string or
 * number and returns `{ hash }`.
 */
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const { config } = require('../../config/env');
const chains = require('../../config/chains');
const KeyVault = require('../crypto/KeyVault');
const ProxyService = require('../ProxyService');
const EthereumProvider = require('../EthereumProvider');

// Etherscan v2 serves every chain it supports from one host, keyed by chainid.
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

// The same path on every EVM chain: the wallet is one key, usable everywhere.
const DERIVATION_PATH = "m/44'/60'/0'/0/0";

class EvmWalletService {
  constructor(chain) {
    this.chain = chain;
    this.code = chain.code;
    this.tag = `[EvmWalletService:${chain.code}]`;
    this.pool = EthereumProvider.forChain(chain.code);
    this.apiKey = config.etherscanApiKey || 'BDHQ71HUZYHVNSQDYYKNZTUF6EBTB1E87J';
  }

  async getProvider() {
    return this.pool.getProvider();
  }

  generateWalletFromMnemonic(mnemonic = null) {
    try {
      if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
      } else if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid BIP39 mnemonic');
      }

      const hdNode = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(mnemonic), DERIVATION_PATH);
      const wallet = new ethers.Wallet(hdNode.privateKey);

      return {
        address: wallet.address,
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        mnemonic,
        derivationPath: DERIVATION_PATH,
        network: 'mainnet',
        networkName: this.chain.name,
      };
    } catch (error) {
      throw new Error(`Failed to generate ${this.chain.name} wallet: ${error.message}`);
    }
  }

  async getBalance(address) {
    try {
      // A malformed address is the caller's error and must not trigger
      // endpoint failover.
      if (!ethers.isAddress(address)) {
        throw new Error('Invalid address format');
      }

      return await this.pool.withProvider(async (provider) => {
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
      });
    } catch (error) {
      return { address, network: 'mainnet', status: 'error', error: error.message, timestamp: new Date().toISOString() };
    }
  }

  async updateBalance(wallet, usdRate) {
    try {
      const balanceInfo = await this.getBalance(wallet.address);

      if (balanceInfo.status === 'success') {
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceEth,
          balanceUSD: balanceInfo.balanceEth * usdRate,
          lastUpdated: new Date().toISOString(),
        });
        balanceInfo.balance = balanceInfo.balanceEth * usdRate;
      }

      return balanceInfo;
    } catch (error) {
      console.error(`${this.tag} Error updating balance for ${wallet.address}:`, error.message);
      return { address: wallet.address, status: 'error', error: error.message };
    }
  }

  /**
   * Cost of a plain transfer, from the live fee market.
   *
   * EIP-1559 where the chain offers it. BNB Chain and some others answer
   * getFeeData with no maxFeePerGas; there the legacy gasPrice is the fee.
   */
  async estimateFee(toAddress) {
    try {
      if (!ethers.isAddress(toAddress)) {
        throw new Error('Invalid recipient address');
      }

      return await this.pool.withProvider(async (provider) => {
        const [feeData, block] = await Promise.all([provider.getFeeData(), provider.getBlock('latest')]);
        const gasLimit = BigInt(this.getGasLimitForOperation());

        const eip1559 = feeData.maxFeePerGas != null && feeData.maxFeePerGas > 0n;
        const baseFeePerGas = block?.baseFeePerGas ?? feeData.gasPrice ?? 0n;
        const priorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;
        const maxFeePerGas = eip1559
          ? feeData.maxFeePerGas
          : (feeData.gasPrice ?? baseFeePerGas);
        const expectedGasPrice = eip1559 ? baseFeePerGas + priorityFeePerGas : maxFeePerGas;

        const expectedFeeWei = expectedGasPrice * gasLimit;
        const maxFeeWei = maxFeePerGas * gasLimit;
        const expectedFeeEth = parseFloat(ethers.formatEther(expectedFeeWei));
        const maxFeeEth = parseFloat(ethers.formatEther(maxFeeWei));

        return {
          maxFeePerGas: maxFeePerGas.toString(),
          maxFeePerGasGwei: parseFloat(ethers.formatUnits(maxFeePerGas, 'gwei')),
          maxPriorityFeePerGas: priorityFeePerGas.toString(),
          maxPriorityFeePerGasGwei: parseFloat(ethers.formatUnits(priorityFeePerGas, 'gwei')),
          baseFeePerGas: baseFeePerGas.toString(),
          baseFeePerGasGwei: parseFloat(ethers.formatUnits(baseFeePerGas, 'gwei')),
          gasLimit: gasLimit.toString(),
          expectedFeeWei: expectedFeeWei.toString(),
          expectedFeeEth,
          maxFeeWei: maxFeeWei.toString(),
          maxFeeEth,
          totalMaxFeeWei: maxFeeWei.toString(),
          totalMaxFeeEth: maxFeeEth,
          feeModel: eip1559 ? 'eip1559' : 'legacy',
          priority: 'standard',
          operationType: 'transfer',
          network: 'mainnet',
          status: 'success',
          timestamp: new Date().toISOString(),
        };
      });
    } catch (error) {
      console.error(`${this.tag} Fee estimation error: ${error.message}`);
      return { network: 'mainnet', status: 'error', error: error.message };
    }
  }

  /**
   * Recent transactions for an address, from the chain's history sources in
   * order. Etherscan v2 (one key, chain selected by id), Blockscout and
   * Routescan all answer the same `txlist` shape. A chain with no source
   * reports `unavailable` rather than an empty list, so checkout knows the
   * difference between "nothing arrived" and "cannot tell".
   */
  async getTransactionHistory(address) {
    if (!ethers.isAddress(address)) {
      return { address, network: 'mainnet', status: 'error', error: 'Invalid address format' };
    }

    const sources = this.chain.history || [];
    if (sources.length === 0) {
      return { address, network: 'mainnet', status: 'unavailable', transactions: [], error: `No transaction index for ${this.chain.name}` };
    }

    const failures = [];
    for (const source of sources) {
      try {
        const url = source.kind === 'etherscan'
          ? `${ETHERSCAN_V2}?chainid=${source.chainId}&module=account&action=txlist&address=${address}&sort=desc&page=1&offset=50&apikey=${this.apiKey}`
          : `${source.url}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=50`;

        const response = await ProxyService.fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // Etherscan-style: status "0" with a string result is an error or
        // "no transactions found". Only the latter is an answer.
        if (!Array.isArray(data.result)) {
          const text = String(data.result || data.message || '');
          if (/no transactions found/i.test(text)) {
            return { address, transactionCount: 0, network: 'mainnet', transactions: [], timestamp: new Date().toISOString() };
          }
          throw new Error(text.slice(0, 120) || 'unexpected response');
        }

        return {
          address,
          transactionCount: data.result.length,
          network: 'mainnet',
          transactions: data.result,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        failures.push(`${source.kind}: ${error.message}`);
      }
    }

    return { address, network: 'mainnet', status: 'error', error: failures.join(' | ') };
  }

  getGasLimitForOperation() {
    return 35000; // plain native transfer, with headroom over the 21k minimum
  }

  createWallet(clientId, mnemonic = null) {
    try {
      const walletData = this.generateWalletFromMnemonic(mnemonic);
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: this.code,
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
      // Encrypt privateKey and seedPhrase before they touch the database.
      return db.create('wallets', KeyVault.sealWallet(wallet));
    } catch (error) {
      throw new Error(`Failed to create ${this.chain.name} wallet: ${error.message}`);
    }
  }

  /**
   * Send the native coin. `amount` may be a decimal string - a fixed-rate
   * shift's exact deposit - which is parsed verbatim; a number is rounded to
   * ten decimals to avoid float artefacts in parseEther.
   */
  async sendTransaction(privateKey, toAddress, amount) {
    try {
      const provider = await this.getProvider();
      const signer = new ethers.Wallet(privateKey, provider);

      if (!ethers.isAddress(toAddress)) {
        throw new Error(`Invalid recipient address: ${toAddress}`);
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error(`Invalid amount: ${amount}. Must be a positive number`);
      }

      const roundedAmount = typeof amount === 'string' ? Number(amount) : Math.floor(numAmount * 1e10) / 1e10;
      const valueString = typeof amount === 'string' ? amount.trim() : roundedAmount.toString();

      const senderBalance = await provider.getBalance(signer.address);
      const senderBalanceEth = parseFloat(ethers.formatEther(senderBalance));

      const feeData = await provider.getFeeData();
      const gasLimit = BigInt(this.getGasLimitForOperation());
      const eip1559 = feeData.maxFeePerGas != null && feeData.maxFeePerGas > 0n;

      let fees;
      if (eip1559) {
        fees = { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n };
      } else if (feeData.gasPrice != null && feeData.gasPrice > 0n) {
        fees = { gasPrice: feeData.gasPrice };
      } else {
        throw new Error('Unable to estimate gas fees. Please try again.');
      }

      const gasPriceCap = eip1559 ? fees.maxFeePerGas : fees.gasPrice;
      const estimatedGasCostEth = parseFloat(ethers.formatEther(gasPriceCap * gasLimit));
      const totalCostEth = roundedAmount + estimatedGasCostEth;

      if (senderBalanceEth < totalCostEth) {
        throw new Error(
          `Insufficient balance. Have ${senderBalanceEth.toFixed(8)} ${this.chain.symbol}, ` +
          `need ${totalCostEth.toFixed(8)} ${this.chain.symbol} (${roundedAmount.toFixed(8)} + ${estimatedGasCostEth.toFixed(8)} gas)`
        );
      }

      const tx = await signer.sendTransaction({
        to: toAddress,
        value: ethers.parseEther(valueString),
        gasLimit,
        ...fees,
      });

      console.log(`${this.tag} Transaction sent: ${tx.hash} | ${roundedAmount} ${this.chain.symbol} -> ${toAddress} | gas cap ${estimatedGasCostEth.toFixed(8)}`);

      return {
        hash: tx.hash,
        from: signer.address,
        to: toAddress,
        amount: roundedAmount,
        chain: this.code,
        feeModel: eip1559 ? 'eip1559' : 'legacy',
        gasLimit: gasLimit.toString(),
        estimatedGasCostEth,
        status: 'pending',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to send ${this.chain.name} transaction: ${error.message}`);
    }
  }
}

const instances = new Map();

/** One service per EVM chain, created on first use. */
function createEvmWalletService(chainOrCode) {
  const chain = typeof chainOrCode === 'string' ? chains.get(chainOrCode) : chainOrCode;
  if (chain.family !== 'evm') throw new Error(`${chain.code} is not an EVM chain`);
  if (!instances.has(chain.code)) {
    instances.set(chain.code, new EvmWalletService(chain));
  }
  return instances.get(chain.code);
}

module.exports = { EvmWalletService, createEvmWalletService };
