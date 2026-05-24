const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const ProxyService = require('../ProxyService');

const bip32 = BIP32Factory(ecc);

class LitecoinWalletService {
  constructor() {
    // Litecoin network parameters
    // These match the Litecoin mainnet parameters
    this.networks = {
      mainnet: {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bip32: {
          public: 0x019da462,
          private: 0x019d9cfe,
        },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0,
      },
    };

    this.apiEndpoints = {
      mainnet: 'https://litecoinspace.org/api',
    };

    // RPC endpoints for Litecoin
    this.rpcEndpoints = {
      mainnet: 'https://litecoin-mainnet.gateway.tatum.io',
    };

    this.networkConfig = {
      mainnet: { name: 'Litecoin Mainnet', derivation: "m/44'/2'/0'/0/0" },
    };
  }

  /**
   * Generate Litecoin wallet from BIP39 mnemonic
   * Uses BIP44 derivation path: m/44'/2'/0'/0/0
   * @param {string} mnemonic - Optional BIP39 mnemonic, generates new if not provided
   * @param {string} network - Network to use
   * @returns {Object} Wallet object with address, privateKey, publicKey, mnemonic, wif
   */
  generateWalletFromMnemonic(mnemonic = null, network = 'mainnet') {
    try {
      if (!this.networks[network]) {
        throw new Error(`Invalid network: ${network}`);
      }

      // Generate or use provided mnemonic
      if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
      } else if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid BIP39 mnemonic');
      }

      // Convert mnemonic to seed
      const seed = bip39.mnemonicToSeedSync(mnemonic);

      // Litecoin uses BIP44 path: m/44'/2'/0'/0/0
      // 2 is the Litecoin coin type
      const derivationPath = this.networkConfig[network].derivation;
      const root = bip32.fromSeed(seed, this.networks[network]);
      const derived = root.derivePath(derivationPath);

      // Get private key and public key
      const privateKey = derived.privateKey ? Buffer.from(derived.privateKey).toString('hex') : null;
      const publicKey = derived.publicKey.toString('hex');

      // Create legacy address (P2PKH) - Litecoin L or M format
      const { address } = bitcoin.payments.p2pkh({
        pubkey: derived.publicKey,
        network: this.networks[network],
      });

      // Convert private key to WIF format
      const wif = derived.toWIF();

      return {
        address,
        publicKey,
        privateKey,
        wif,
        mnemonic,
        derivationPath: derivationPath,
        network: network,
        networkName: this.networkConfig[network].name,
      };
    } catch (error) {
      throw new Error(`Failed to generate Litecoin wallet: ${error.message}`);
    }
  }

  /**
   * Get wallet balance in LTC
   * @param {string} address - Litecoin wallet address
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
        console.warn(`[LitecoinWalletService] Rate limited by API. Retry after ${retryAfterSec}s. Using proxy: ${ProxyService.getCurrentProxyInfo()}`);
        return {
          address,
          balanceSatoshis: 0,
          balanceLTC: 0,
          network,
          timestamp: new Date().toISOString(),
          status: 'rate_limited',
          retryAfterSeconds: retryAfterMs ? Math.ceil(retryAfterMs / 1000) : null,
        };
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();

      // Convert satoshis to LTC (1 LTC = 100,000,000 satoshis)
      const balanceLTC = ((data.chain_stats.funded_txo_sum || 0) - (data.chain_stats.spent_txo_sum || 0)) / 100000000;

      return {
        address,
        balanceSatoshis: (data.chain_stats.funded_txo_sum || 0) - (data.chain_stats.spent_txo_sum || 0),
        balanceLTC,
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
      };
    }
  }

  /**
   * Update wallet balance in database
   * @param {Object} wallet - Wallet object
   * @param {number} ltcToUsdRate - LTC to USD exchange rate
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Updated balance info
   */
  async updateBalance(wallet, ltcToUsdRate, network = 'mainnet') {
    try {
      const balanceInfo = await this.getBalance(wallet.address, network);

      if (balanceInfo.status === 'success') {
        // Update in database
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceLTC,
          balanceUSD: balanceInfo.balanceLTC * ltcToUsdRate,
          lastUpdated: new Date().toISOString(),
        });
      }

      return balanceInfo;
    } catch (error) {
      console.error(`Error watching LTC balance for ${wallet.address}:`, error.message);
      return {
        address: wallet.address,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Create a wallet in database
   * @param {string} clientId - Client ID
   * @param {string} mnemonic - Optional mnemonic
   * @param {string} network - Litecoin network
   * @returns {Object} Wallet document
   */
  createWallet(clientId, mnemonic = null, network = 'mainnet') {
    try {
      // Generate wallet
      const walletData = this.generateWalletFromMnemonic(mnemonic, network);

      // Create wallet document
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: 'LTC',
        network,
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        wif: walletData.wif,
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
      throw new Error(`Failed to create Litecoin wallet: ${error.message}`);
    }
  }

  /**
   * Get wallet transaction history
   * @param {string} address - Litecoin wallet address
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

      const response = await fetch(`${endpoint}/address/${address}/txs`);

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();

      const transactions = (data || []).slice(0, limit).map(tx => ({
        txid: tx.txid,
        time: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
        blockHeight: tx.status.block_height || null,
        inputCount: tx.vin?.length || 0,
        outputCount: tx.vout?.length || 0,
      }));

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
   * Get the network's minimum relay fee from RPC
   * @returns {Promise<number>} Minimum relay fee in satoshis
   */
  async getMinimumRelayFee() {
    try {
      const response = await fetch(this.rpcEndpoints.mainnet, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getnetworkinfo',
          params: [],
        }),
      });

      if (!response.ok) {
        console.warn('[LitecoinWalletService] Could not fetch network info, using fallback minimum relay fee');
        return 500;
      }

      const data = await response.json();

      if (data.error || !data.result?.relayfee) {
        console.warn('[LitecoinWalletService] No relay fee in network info, using fallback');
        return 500;
      }

      // relayfee is in LTC, convert to satoshis
      const relayFeeLtc = data.result.relayfee;
      const relayFeeSatoshis = Math.ceil(relayFeeLtc * 100000000);

      console.log(`[LitecoinWalletService] Network minimum relay fee: ${relayFeeSatoshis} sats (${relayFeeLtc} LTC)`);
      return relayFeeSatoshis;
    } catch (error) {
      console.error(`[LitecoinWalletService] Error fetching minimum relay fee: ${error.message}`);
      return 500; // Fallback
    }
  }

  /**
   * Estimate transaction fee based on network conditions
   * Uses RPC estimatesmartfee to get current fee rate, ensures minimum relay fee is met
   * @param {number} targetConfirmations - Target blocks for confirmation (default 6)
   * @returns {Promise<number>} Fee in satoshis for typical transaction
   */
  async estimateFee(targetConfirmations = 6) {
    try {
      // Get the network's minimum relay fee
      const minimumRelayFee = await this.getMinimumRelayFee();

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
        console.warn('[LitecoinWalletService] Fee estimation failed, using minimum relay fee');
        return minimumRelayFee;
      }

      const data = await response.json();

      if (data.error || !data.result?.feerate) {
        console.warn('[LitecoinWalletService] Could not estimate fee, using minimum relay fee');
        return minimumRelayFee;
      }

      // feerate is in LTC/kB, convert to satoshis for typical tx size (~200 bytes)
      const feeRateLtcPerKb = data.result.feerate;
      const txSizeBytes = 200; // Typical SegWit transfer
      const feeSatoshis = Math.ceil((feeRateLtcPerKb * 100000000 * txSizeBytes) / 1000);

      const finalFee = Math.max(feeSatoshis, minimumRelayFee);
      console.log(`[LitecoinWalletService] Estimated fee: ${feeSatoshis} sats (rate: ${feeRateLtcPerKb} LTC/kB), final fee with min relay: ${finalFee} sats`);
      return finalFee;
    } catch (error) {
      console.error(`[LitecoinWalletService] Fee estimation error: ${error.message}`);
      return 1000; // Fallback
    }
  }

  /**
   * Parse address and identify its type and format
   * Supports: P2PKH (legacy L/M), P2SH (3), Bech32 (ltc1), and cross-chain formats
   * @param {string} address - Address to parse
   * @returns {Object} { type, hash, data, script, isLitecoin, isValid }
   */
  parseAddress(address) {
    if (!address || typeof address !== 'string') {
      throw new Error('Invalid address: must be a non-empty string');
    }

    address = address.trim();

    // Try Bech32 first (ltc1 or bc1)
    if (address.toLowerCase().startsWith('ltc1') || address.toLowerCase().startsWith('bc1')) {
      try {
        const decoded = bitcoin.address.fromBech32(address);
        return {
          type: 'p2wpkh',
          data: decoded.data,
          version: decoded.version,
          isLitecoin: address.toLowerCase().startsWith('ltc1'),
          isValid: true,
          originalAddress: address,
          description: `Bech32 ${address.toLowerCase().startsWith('ltc1') ? 'Litecoin' : 'Bitcoin'} address`
        };
      } catch (e) {
        throw new Error(`Invalid Bech32 address format: ${address}`);
      }
    }

    // Try Base58Check (P2PKH: L/M for Litecoin, 1 for Bitcoin; or P2SH: 3)
    if (address.startsWith('L') || address.startsWith('M') || address.startsWith('1') || address.startsWith('3')) {
      try {
        const decoded = bitcoin.address.fromBase58Check(address);
        
        // Determine address type from version byte
        if (address.startsWith('L') || address.startsWith('M')) {
          // Litecoin P2PKH (version 0x30 for L, 0x32 for M)
          return {
            type: decoded.version === 0x30 ? 'p2pkh' : 'p2sh',
            hash: decoded.hash,
            version: decoded.version,
            isLitecoin: true,
            isValid: decoded.version === 0x30 || decoded.version === 0x32,
            originalAddress: address,
            description: `Legacy Litecoin ${decoded.version === 0x30 ? 'P2PKH' : 'P2SH'} address`
          };
        } else if (address.startsWith('1')) {
          // Bitcoin P2PKH (version 0x00)
          return {
            type: 'p2pkh',
            hash: decoded.hash,
            version: decoded.version,
            isLitecoin: false,
            isValid: decoded.version === 0x00,
            originalAddress: address,
            description: 'Legacy Bitcoin P2PKH address'
          };
        } else if (address.startsWith('3')) {
          // P2SH (could be Bitcoin or Litecoin)
          return {
            type: 'p2sh',
            hash: decoded.hash,
            version: decoded.version,
            isLitecoin: false, // Default to Bitcoin for "3" addresses
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
    throw new Error(`Unknown address format: ${address} - Must be P2PKH (L/M/1), P2SH (3), or Bech32 (ltc1/bc1)`);
  }

  /**
   * Send Litecoin to an address
   * @param {string} privateKey - Private key in hex format
   * @param {string} toAddress - Recipient Litecoin address (supports P2PKH, P2SH, Bech32)
   * @param {number} amount - Amount in LTC
   * @returns {Promise<string>} Transaction hash
   */
  async sendTransaction(privateKey, toAddress, amount) {
    try {
      const privateKeyBuffer = Buffer.from(privateKey, 'hex');
      const pubKey = ecc.pointFromScalar(privateKeyBuffer, true);

      // Generate sender address using Litecoin network params (P2PKH for 'L' addresses)
      const { address: senderAddress } = bitcoin.payments.p2pkh({
        pubkey: pubKey,
        network: this.networks.mainnet, // Use Litecoin network params
      });

      console.log(`[LitecoinWalletService] Sender address: ${senderAddress}`);
      console.log(`[LitecoinWalletService] Recipient address: ${toAddress}`);

      // Get UTXOs using ProxyService with Litecoin API
      const response = await ProxyService.fetch(`${this.apiEndpoints.mainnet}/address/${senderAddress}/utxo`);
      
      // Check if response is valid before parsing
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error (${response.status}): ${errorText.substring(0, 100)}`);
      }

      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        const text = await response.text();
        console.error(`[LitecoinWalletService] Failed to parse JSON. Response: ${text.substring(0, 200)}`);
        throw new Error(`Failed to parse API response: ${text.substring(0, 100)}`);
      }
      
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No unspent outputs (UTXOs) available');
      }

      const utxos = data;
      const amountSatoshis = Math.floor(amount * 100000000); // Convert LTC to satoshis
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

      // Build transaction using P2PKH (compatible with Litecoin)
      const { output: scriptOutput } = bitcoin.payments.p2pkh({ 
        pubkey: pubKey, 
        network: this.networks.mainnet 
      });

      const psbt = new bitcoin.Psbt({ network: this.networks.mainnet });

      // For P2PKH inputs, we need the full previous transaction (nonWitnessUtxo)
      // Fetch the raw transaction for each UTXO
      for (const utxo of selectedUtxos) {
        try {
          // Try to fetch the raw transaction hex from the API
          const txResponse = await ProxyService.fetch(`${this.apiEndpoints.mainnet}/tx/${utxo.txid}/hex`);
          if (txResponse.ok) {
            const txHex = (await txResponse.text()).trim();
            const nonWitnessUtxo = Buffer.from(txHex, 'hex');

            psbt.addInput({
              hash: utxo.txid,
              index: utxo.vout,
              nonWitnessUtxo: nonWitnessUtxo,
            });
            continue;
          }
        } catch (e) {
          console.warn(`[LitecoinWalletService] Could not fetch raw transaction ${utxo.txid}: ${e.message}`);
        }

        // If raw transaction fetch failed, try to construct it from API data
        // This is a fallback but may not work for all cases
        try {
          const txResponse = await ProxyService.fetch(`${this.apiEndpoints.mainnet}/tx/${utxo.txid}`);
          const txData = await txResponse.json();
          
          // Build a minimal transaction from the data we have
          // This is a workaround - ideally we'd get the full raw transaction
          const tx = new bitcoin.Transaction();
          
          // Add inputs from previous transaction
          if (txData.vin && Array.isArray(txData.vin)) {
            for (const vin of txData.vin) {
              try {
                tx.addInput(Buffer.from(vin.txid, 'hex').reverse(), vin.vout);
              } catch (e) {
                // Skip problematic inputs
              }
            }
          }
          
          // Add outputs
          if (txData.vout && Array.isArray(txData.vout)) {
            for (const vout of txData.vout) {
              try {
                const scriptBuffer = Buffer.from(vout.scriptpubkey, 'hex');
                tx.addOutput(scriptBuffer, BigInt(vout.value || 0));
              } catch (e) {
                // Skip problematic outputs
              }
            }
          }

          const nonWitnessUtxo = tx.toBuffer();
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: nonWitnessUtxo,
          });
        } catch (e) {
          console.error(`[LitecoinWalletService] Failed to get transaction data for ${utxo.txid}: ${e.message}`);
          throw new Error(`Cannot sign P2PKH input without full transaction data for ${utxo.txid}`);
        }
      }

      // Parse and convert recipient address to script
      const recipientInfo = this.parseAddress(toAddress);
      console.log(`[LitecoinWalletService] Recipient address type: ${recipientInfo.type} - ${recipientInfo.description}`);
      
      let recipientScript;

      if (recipientInfo.type === 'p2pkh') {
        // P2PKH script: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
        recipientScript = Buffer.concat([
          Buffer.from([0x76, 0xa9, 0x14]),
          recipientInfo.hash,
          Buffer.from([0x88, 0xac]),
        ]);
      } else if (recipientInfo.type === 'p2wpkh') {
        // Bech32 P2WPKH script: OP_0 <20-byte-hash>
        recipientScript = Buffer.concat([
          Buffer.from([0, recipientInfo.data.length]),
          recipientInfo.data,
        ]);
      } else if (recipientInfo.type === 'p2sh') {
        // P2SH script: OP_HASH160 <20-byte-hash> OP_EQUAL
        recipientScript = Buffer.concat([
          Buffer.from([0xa9, 0x14]),
          recipientInfo.hash,
          Buffer.from([0x87]),
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

      // Create Signer object for signing
      const signer = {
        sign: (hash) => ecc.sign(hash, privateKeyBuffer),
        publicKey: pubKey,
      };

      // Sign all inputs
      for (let i = 0; i < selectedUtxos.length; i++) {
        psbt.signInput(i, signer);
      }

      psbt.finalizeAllInputs();
      const txHex = psbt.extractTransaction().toHex();

      console.log(`[LitecoinWalletService] Broadcasting transaction: ${txHex.substring(0, 50)}...`);

      // Broadcast via Litecoin RPC
      const txid = await this.broadcastRawTransaction(txHex);
      console.log(`[LitecoinWalletService] Transaction sent: ${txid}`);
      return txid;
    } catch (error) {
      throw new Error(`Failed to send Litecoin transaction: ${error.message}`);
    }
  }

  /**
   * Broadcast a raw transaction via Litecoin RPC
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

module.exports = new LitecoinWalletService();
