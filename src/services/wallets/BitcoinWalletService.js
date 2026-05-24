const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const ProxyService = require('../ProxyService');

const bip32 = BIP32Factory(ecc);

class BitcoinWalletService {
  constructor() {
    // Bitcoin networks
    this.networks = {
      mainnet: bitcoin.networks.bitcoin,
    };

    // RPC endpoints for Bitcoin
    this.rpcEndpoints = {
      mainnet: 'https://bitcoin-rpc.publicnode.com',
    };

    // Blockchain API endpoints for querying balance and transactions
    this.apiEndpoints = {
      mainnet: 'https://mempool.space/api',
    };

    // Cache for network names
    this.networkConfig = {
      mainnet: { name: 'Bitcoin Mainnet', derivation: "m/44'/0'/0'/0/0" },
    };
  }

  /**
   * Generate Bitcoin wallet from BIP39 mnemonic
   * Uses BIP44 derivation path: m/44'/0'/0'/0/0 for mainnet
   * @param {string} mnemonic - Optional BIP39 mnemonic, generates new if not provided
   * @param {string} network - Network: mainnet, testnet, regtest
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

      // Convert mnemonic to seed
      const seed = bip39.mnemonicToSeedSync(mnemonic);

      // Create root key
      const root = bip32.fromSeed(seed, this.networks[network]);

      // Bitcoin uses BIP44 path: m/44'/0'/0'/0/0 for mainnet, m/44'/1'/0'/0/0 for testnet
      const derivationPath = this.networkConfig[network].derivation;
      const derived = root.derivePath(derivationPath);

      // Generate P2WPKH address (SegWit/Bech32 format: bc1...)
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: derived.publicKey,
        network: this.networks[network],
      });

      return {
        address: address,
        publicKey: derived.publicKey.toString('hex'),
        privateKey: Buffer.from(derived.privateKey).toString('hex'),
        wif: derived.toWIF(), // Wallet Import Format
        mnemonic: mnemonic,
        derivationPath: derivationPath,
        network: network,
        networkName: this.networkConfig[network].name,
      };
    } catch (error) {
      throw new Error(`Failed to generate Bitcoin wallet: ${error.message}`);
    }
  }
  
  /**
   * Get wallet balance in BTC using blockchain.info API
   * @param {string} address - Bitcoin wallet address
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Balance information
   */
  async getBalance(address, network = 'mainnet') {
    try {
      const endpoint = this.apiEndpoints[network];
      if (!endpoint) {
        throw new Error('Invalid network for balance query');
      }

      const response = await ProxyService.fetch(`${endpoint}/address/${address}`);

      // Handle rate limiting (429 Too Many Requests)
      if (response.status === 429) {
        const retryAfterMs = ProxyService.parseRetryAfter(response);
        const retryAfterSec = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 'unknown';
        console.warn(`[BitcoinWalletService] Rate limited by blockchain.info API. Retry after ${retryAfterSec}s. Using proxy: ${ProxyService.getCurrentProxyInfo()}`);
        return {
          address,
          balanceSatoshis: 0,
          balanceBTC: 0,
          network,
          nTransactions: 0,
          timestamp: new Date().toISOString(),
          status: 'rate_limited',
          retryAfterSeconds: retryAfterMs ? Math.ceil(retryAfterMs / 1000) : null,
        };
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();

      const balanceSatoshis = data.chain_stats?.funded_txo_sum - data.chain_stats?.spent_txo_sum || 0;
      const balanceBTC = balanceSatoshis / 100000000;

      return {
        address,
        balanceSatoshis,
        balanceBTC,
        network,
        nTransactions: data.chain_stats?.tx_count || 0,
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      console.error(`[BitcoinWalletService] Error getting balance: ${error.message}`);
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
   * Watch wallet balance and update database
   * @param {Object} wallet - Wallet object from database
   * @param {string} network - Bitcoin network
   * @returns {Promise<Object>} Updated balance info
   */
  async updateBalance(wallet, bitcoinToUsdRate, network = 'mainnet') {
    try {
      const balanceInfo = await this.getBalance(wallet.address, network);

      if (balanceInfo.status === 'success') {
        // Update in database
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceBTC,
          balanceUSD: balanceInfo.balanceBTC * bitcoinToUsdRate,
          lastUpdated: new Date().toISOString(),
        });
      }

      return balanceInfo;
    } catch (error) {
      console.error(`Error watching BTC balance for ${wallet.address}:`, error.message);
      return {
        address: wallet.address,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Get wallet transaction history
   * @param {string} address - Bitcoin wallet address
   * @param {number} limit - Number of recent transactions (unused - API returns all)
   * @param {string} network - Network to query
   * @returns {Promise<Array>} Recent transactions
   */
  async getTransactionHistory(address, limit = 10, network = 'mainnet') {
    try {
      const endpoint = this.apiEndpoints[network];
      if (!endpoint) {
        throw new Error('Invalid network for transaction query');
      }

      const response = await ProxyService.fetch(`${endpoint}/address/${address}/txs`);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();

      const transactions = (Array.isArray(data) ? data : []).slice(0, limit).map(tx => {
        const inputSum = tx.vin?.reduce((sum, inp) => sum + (inp.prevout?.value || 0), 0) || 0;
        const outputSum = tx.vout?.reduce((sum, out) => sum + (out.value || 0), 0) || 0;
        return {
          hash: tx.txid,
          time: tx.status?.block_time || Math.floor(Date.now() / 1000),
          blockHeight: tx.status?.block_height || null,
          inputsCount: tx.vin?.length || 0,
          outputsCount: tx.vout?.length || 0,
          totalInput: inputSum / 100000000,
          totalOutput: outputSum / 100000000,
          fee: (inputSum - outputSum) / 100000000,
        };
      });

      return {
        address,
        network,
        transactions,
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
   * Create a wallet in database
   * @param {string} clientId - Client ID
   * @param {string} mnemonic - Optional mnemonic
   * @param {string} network - Bitcoin network (mainnet, testnet, regtest)
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
        chain: 'BTC',
        network,
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        wif: walletData.wif, // Wallet Import Format
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
      throw new Error(`Failed to create Bitcoin wallet: ${error.message}`);
    }
  }

  /**
   * Estimate transaction fee based on network conditions
   * Uses RPC estimatesmartfee to get current fee rate
   * @param {number} targetConfirmations - Target blocks for confirmation (default 6 = ~1 hour)
   * @returns {Promise<number>} Fee in satoshis for typical transaction
   */
  async estimateFee(targetConfirmations = 6) {
    try {
      const response = await fetch(this.rpcEndpoints.mainnet, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'estimatesmartfee',
          params: [targetConfirmations],
        }),
      });

      if (!response.ok) {
        console.warn('[BitcoinWalletService] Fee estimation failed, using fallback');
        return 2000; // Fallback: 2000 sats
      }

      const data = await response.json();

      if (data.error || !data.result?.feerate) {
        console.warn('[BitcoinWalletService] Could not estimate fee, using fallback');
        return 2000;
      }

      // feerate is in BTC/kB, convert to satoshis for typical tx size (~200 bytes)
      const feeRateBtcPerKb = data.result.feerate;
      const txSizeBytes = 200; // Typical SegWit transfer
      const feeSatoshis = Math.ceil((feeRateBtcPerKb * 100000000 * txSizeBytes) / 1000);

      console.log(`[BitcoinWalletService] Estimated fee: ${feeSatoshis} sats (rate: ${feeRateBtcPerKb} BTC/kB)`);
      return Math.max(feeSatoshis, 500); // Minimum 500 sats
    } catch (error) {
      console.error(`[BitcoinWalletService] Fee estimation error: ${error.message}`);
      return 2000; // Fallback
    }
  }

  /**
   * Parse and validate Bitcoin address
   * Supports: P2PKH (1), P2SH (3), Bech32 (bc1), and Taproot (bc1p)
   * @param {string} address - Address to parse
   * @returns {Object} { type, hash, data, version, isValid, description }
   */
  parseAddress(address) {
    if (!address || typeof address !== 'string') {
      throw new Error('Invalid address: must be a non-empty string');
    }

    address = address.trim();

    // Try Bech32 first (bc1 for SegWit or Taproot)
    if (address.toLowerCase().startsWith('bc1')) {
      try {
        const decoded = bitcoin.address.fromBech32(address);
        return {
          type: decoded.version === 0 ? 'p2wpkh' : (decoded.version === 1 ? 'p2tr' : 'p2wsh'),
          data: decoded.data,
          version: decoded.version,
          isValid: true,
          originalAddress: address,
          description: `Bech32 Bitcoin ${decoded.version === 0 ? 'P2WPKH' : (decoded.version === 1 ? 'P2TR (Taproot)' : 'P2WSH')} address`
        };
      } catch (e) {
        throw new Error(`Invalid Bech32 address format: ${address}`);
      }
    }

    // Try Base58Check (P2PKH: 1 or P2SH: 3)
    if (address.startsWith('1') || address.startsWith('3')) {
      try {
        const decoded = bitcoin.address.fromBase58Check(address);
        
        if (address.startsWith('1')) {
          // Bitcoin P2PKH (version 0x00)
          return {
            type: 'p2pkh',
            hash: decoded.hash,
            version: decoded.version,
            isValid: decoded.version === 0x00,
            originalAddress: address,
            description: 'Legacy Bitcoin P2PKH address'
          };
        } else if (address.startsWith('3')) {
          // P2SH (version 0x05)
          return {
            type: 'p2sh',
            hash: decoded.hash,
            version: decoded.version,
            isValid: decoded.version === 0x05,
            originalAddress: address,
            description: 'Pay-to-Script-Hash address'
          };
        }
      } catch (e) {
        throw new Error(`Invalid Base58Check address format: ${address}`);
      }
    }

    // If we get here, the address format is not recognized
    throw new Error(`Unknown address format: ${address} - Must be P2PKH (1), P2SH (3), P2WPKH/P2WSH/P2TR (bc1)`);
  }

  /**
   * Send Bitcoin to an address
   * @param {string} privateKey - Private key in hex format
   * @param {string} toAddress - Recipient Bitcoin address
   * @param {number} amount - Amount in BTC
   * @returns {Promise<string>} Transaction hash/ID
   */
  async sendTransaction(privateKey, toAddress, amount) {
    try {
      const privateKeyBuffer = Buffer.from(privateKey, 'hex');
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: ecc.pointFromScalar(privateKeyBuffer, true),
        network: bitcoin.networks.bitcoin,
      });

      // Get UTXOs for this address
      const response = await ProxyService.fetch(`${this.apiEndpoints.mainnet}/address/${address}/utxo`);
      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No unspent outputs (UTXOs) available');
      }

      const utxos = data;
      const amountSatoshis = Math.floor(amount * 100000000); // Convert BTC to satoshis
      const feeSatoshis = await this.estimateFee(6); // Fetch dynamic fee
      const totalNeeded = amountSatoshis + feeSatoshis;

      let selectedUtxos = [];
      let totalValue = 0;

      for (const utxo of utxos) {
        selectedUtxos.push({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
        });
        totalValue += utxo.value;
        if (totalValue >= totalNeeded) break;
      }

      if (totalValue < totalNeeded) {
        throw new Error(`Insufficient funds: need ${totalNeeded} satoshis, have ${totalValue}`);
      }

      // Build transaction
      const pubKey = ecc.pointFromScalar(privateKeyBuffer, true); // Compressed public key
      const { output: scriptOutput } = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: bitcoin.networks.bitcoin });

      const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

      for (const utxo of selectedUtxos) {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Uint8Array.from(scriptOutput),
            value: BigInt(utxo.value),
          },
        });
      }

      // Add outputs
      // Parse and convert recipient address to script
      const recipientInfo = this.parseAddress(toAddress);
      console.log(`[BitcoinWalletService] Recipient address type: ${recipientInfo.type} - ${recipientInfo.description}`);
      
      let recipientScript;

      if (recipientInfo.type === 'p2pkh') {
        // P2PKH script: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
        recipientScript = Buffer.concat([
          Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 <20>
          recipientInfo.hash,
          Buffer.from([0x88, 0xac]), // OP_EQUALVERIFY OP_CHECKSIG
        ]);
      } else if (recipientInfo.type === 'p2wpkh') {
        // Bech32 P2WPKH script: OP_0 <20-byte-hash>
        recipientScript = Buffer.concat([
          Buffer.from([0, recipientInfo.data.length]),
          recipientInfo.data,
        ]);
      } else if (recipientInfo.type === 'p2wsh') {
        // Bech32 P2WSH script: OP_0 <32-byte-hash>
        recipientScript = Buffer.concat([
          Buffer.from([0, recipientInfo.data.length]),
          recipientInfo.data,
        ]);
      } else if (recipientInfo.type === 'p2tr') {
        // Taproot script: OP_1 <32-byte-key>
        recipientScript = Buffer.concat([
          Buffer.from([0x51]), // OP_1
          Buffer.from([recipientInfo.data.length]),
          recipientInfo.data,
        ]);
      } else if (recipientInfo.type === 'p2sh') {
        // P2SH script: OP_HASH160 <20-byte-hash> OP_EQUAL
        recipientScript = Buffer.concat([
          Buffer.from([0xa9, 0x14]), // OP_HASH160 <20>
          recipientInfo.hash,
          Buffer.from([0x87]), // OP_EQUAL
        ]);
      } else {
        throw new Error(`Unsupported address type: ${recipientInfo.type}`);
      }

      psbt.addOutput({
        script: Uint8Array.from(recipientScript),
        value: BigInt(amountSatoshis),
      });

      // Add change output if needed
      if (totalValue > totalNeeded) {
        psbt.addOutput({
          script: Uint8Array.from(scriptOutput),
          value: BigInt(totalValue - totalNeeded),
        });
      }

      // Create a Signer object for signing
      const signer = {
        sign: (hash) => ecc.sign(hash, privateKeyBuffer),
        publicKey: pubKey,
      };

      // Sign inputs
      for (let i = 0; i < selectedUtxos.length; i++) {
        psbt.signInput(i, signer);
      }

      psbt.finalizeAllInputs();
      const txHex = psbt.extractTransaction().toHex();

      // Broadcast via Bitcoin RPC
      const txid = await this.broadcastRawTransaction(txHex);
      console.log(`[BitcoinWalletService] Transaction sent: ${txid}`);
      return txid;
    } catch (error) {
      throw new Error(`Failed to send Bitcoin transaction: ${error.message}`);
    }
  }

  /**
   * Broadcast a raw transaction via Bitcoin RPC
   * @param {string} txHex - Signed transaction in hex format
   * @returns {Promise<string>} Transaction ID
   */
  async broadcastRawTransaction(txHex) {
    try {
      const response = await ProxyService.fetch(this.rpcEndpoints.mainnet, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendrawtransaction',
          params: [txHex],
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      return data.result; // txid
    } catch (error) {
      throw new Error(`Failed to broadcast transaction via RPC: ${error.message}`);
    }
  }
}

module.exports = new BitcoinWalletService();
