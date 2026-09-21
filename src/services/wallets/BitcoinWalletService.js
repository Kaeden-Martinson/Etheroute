const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const KeyVault = require('../crypto/KeyVault');
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

    // Where a signed transaction is pushed, in order. Each is a free public
    // service that could go away; the second only has to answer when the
    // first does not.
    this.broadcastEndpoints = [
      { kind: 'rpc', url: 'https://bitcoin-rpc.publicnode.com' },
      { kind: 'explorer', url: 'https://mempool.space/api/tx' },
    ];

    // Blockchain API endpoints for querying balance and transactions
    this.apiEndpoints = {
      mainnet: 'https://mempool.space/api',
    };
    // Explorers that speak the mempool.space API, tried in order. When none
    // answers, the reads go through BlockCypher via the legacy-UTXO service;
    // a send still signs here (the wallets are segwit) with the unspent
    // outputs BlockCypher lists.
    this.mirrors = ['https://mempool.space/api', 'https://blockstream.info/api'];

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
  generateWalletFromMnemonic(mnemonic = null) {
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
      const root = bip32.fromSeed(seed, this.networks.mainnet);

      // Bitcoin uses BIP44 path: m/44'/0'/0'/0/0 for mainnet
      const derivationPath = this.networkConfig.mainnet.derivation;
      const derived = root.derivePath(derivationPath);

      // Generate P2WPKH address (SegWit/Bech32 format: bc1...)
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: derived.publicKey,
        network: this.networks.mainnet,
      });

      return {
        address: address,
        publicKey: derived.publicKey.toString('hex'),
        privateKey: Buffer.from(derived.privateKey).toString('hex'),
        wif: derived.toWIF(), // Wallet Import Format
        mnemonic: mnemonic,
        derivationPath: derivationPath,
        network: 'mainnet',
        networkName: this.networkConfig.mainnet.name,
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
  /** The BlockCypher-backed twin, for when no mempool mirror answers. */
  get fallback() {
    return require('./LegacyUtxoWalletService').createLegacyUtxoWalletService('BTC');
  }

  /**
   * One explorer call on the first mirror that answers. An answer - even a
   * 404 or a 429 - is returned; a dead mirror is tried past. Throws when
   * every mirror is dead.
   */
  async mempool(path, init) {
    const failures = [];
    for (const base of this.mirrors) {
      try {
        const response = await ProxyService.fetch(`${base}${path}`, init);
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (error) {
        failures.push(`${base}: ${error.message}`);
      }
    }
    const error = new Error(`every Bitcoin explorer failed: ${failures.join(' | ')}`);
    error.explorersDown = true;
    throw error;
  }

  async getBalance(address) {
    const first = await this.getBalanceFromMempool(address);
    if (first.status !== 'error') return first;
    console.warn(`[BitcoinWalletService] mempool mirrors failed for ${address} (${first.error}); reading BlockCypher`);
    const second = await this.fallback.getBalance(address);
    return second.status === 'success' ? second : first;
  }

  async getBalanceFromMempool(address) {
    try {
      const response = await this.mempool(`/address/${address}`);

      // Handle rate limiting (429 Too Many Requests)
      if (response.status === 429) {
        const retryAfterMs = ProxyService.parseRetryAfter(response);
        const retryAfterSec = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 'unknown';
        console.warn(`[BitcoinWalletService] Rate limited by blockchain.info API. Retry after ${retryAfterSec}s. Using proxy: ${ProxyService.getCurrentProxyInfo()}`);
        return {
          address,
          balanceSatoshis: 0,
          balanceBTC: 0,
          network: 'mainnet',
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
        network: 'mainnet',
        nTransactions: data.chain_stats?.tx_count || 0,
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      console.error(`[BitcoinWalletService] Error getting balance: ${error.message}`);
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
   * Watch wallet balance and update database
   * @param {Object} wallet - Wallet object from database
   * @param {string} network - Bitcoin network
   * @returns {Promise<Object>} Updated balance info
   */
  async updateBalance(wallet, bitcoinToUsdRate) {
    try {
      const balanceInfo = await this.getBalance(wallet.address);

      if (balanceInfo.status === 'success') {
        // Update in database
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceBTC,
          balanceUSD: balanceInfo.balanceBTC * bitcoinToUsdRate,
          lastUpdated: new Date().toISOString(),
        });

        balanceInfo.balance = balanceInfo.balanceBTC * bitcoinToUsdRate; // For consistency in returned object
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
  async getTransactionHistory(address, limit = 10) {
    const first = await this.getTransactionHistoryFromMempool(address, limit);
    if (first.status !== 'error') return first;
    console.warn(`[BitcoinWalletService] mempool mirrors failed for ${address} history (${first.error}); reading BlockCypher`);
    const second = await this.fallback.getTransactionHistory(address, limit);
    return second.status === 'error' ? first : second;
  }

  async getTransactionHistoryFromMempool(address, limit = 10) {
    try {
      const response = await this.mempool(`/address/${address}/txs`);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();

      // Chain tip, so each transaction can report its depth. Checkout needs
      // the real count: a "mined" flag alone caps every payment at one
      // confirmation, which can never satisfy a two-confirmation rule.
      const tipHeight = await this.getTipHeight();

      const transactions = (Array.isArray(data) ? data : []).slice(0, limit).map(tx => {
        const inputSum  = tx.vin?.reduce((sum, inp) => sum + (inp.prevout?.value || 0), 0) || 0;
        const outputSum = tx.vout?.reduce((sum, out) => sum + (out.value       || 0), 0) || 0;
        const blockHeight = tx.status?.block_height || null;
        return {
          hash:        tx.txid,
          time:        tx.status?.block_time || Math.floor(Date.now() / 1000),
          blockHeight,
          confirmations: blockHeight && tipHeight ? Math.max(1, tipHeight - blockHeight + 1) : (blockHeight ? 1 : 0),
          inputs:  (tx.vin  || []).map(inp => ({
            address: inp.prevout?.scriptpubkey_address || null,
            value:   (inp.prevout?.value || 0) / 1e8,
          })),
          outputs: (tx.vout || []).map(out => ({
            address: out.scriptpubkey_address || null,
            value:   (out.value || 0) / 1e8,
          })),
          totalInput:  inputSum  / 1e8,
          totalOutput: outputSum / 1e8,
          fee:         (inputSum - outputSum) / 1e8,
        };
      });

      return {
        address,
        network: 'mainnet',
        transactions,
        status: 'success',
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
   * Current chain height, or null when the explorer is unavailable.
   */
  async getTipHeight() {
    try {
      const response = await this.mempool('/blocks/tip/height');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const height = Number(await response.text());
      if (Number.isFinite(height)) return height;
      throw new Error('no height');
    } catch (error) {
      console.warn(`[BitcoinWalletService] Tip height unavailable (${error.message}); asking BlockCypher`);
      return this.fallback.getTipHeight();
    }
  }

  /** Where a broadcast transaction stands, from whichever explorer answers. */
  async getTransactionStatus(txid) {
    try {
      const response = await this.mempool(`/tx/${txid}/status`);
      if (response.status === 404) return { status: 'not_found', confirmations: 0, blockHeight: null };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.confirmed) return { status: 'waiting', confirmations: 0, blockHeight: null };
      const tip = await this.getTipHeight();
      return { status: 'settled', confirmations: tip ? tip - data.block_height + 1 : 1, blockHeight: data.block_height };
    } catch (error) {
      console.warn(`[BitcoinWalletService] Status of ${txid} unavailable (${error.message}); asking BlockCypher`);
      return this.fallback.getTransactionStatus(txid);
    }
  }

  /**
   * Each explorer asked for the tip, for the health page: the mirrors, then
   * BlockCypher.
   */
  async probeExplorers() {
    const results = [];
    for (const base of this.mirrors) {
      const started = Date.now();
      try {
        const response = await ProxyService.fetch(`${base}/blocks/tip/height`);
        const tip = Number(await response.text());
        if (!response.ok || !Number.isFinite(tip)) throw new Error(`HTTP ${response.status}`);
        results.push({ url: base, ok: true, tip, latencyMs: Date.now() - started });
      } catch (error) {
        results.push({ url: base, ok: false, error: error.message, latencyMs: Date.now() - started });
      }
    }
    const started = Date.now();
    const tip = await this.fallback.getTipHeight();
    results.push({ url: this.fallback.spec.explorerBase, ok: Boolean(tip), tip, latencyMs: Date.now() - started, error: tip ? null : 'no tip' });
    return results;
  }

  /**
   * Create a wallet in database
   * @param {string} clientId - Client ID
   * @param {string} mnemonic - Optional mnemonic
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
        chain: 'BTC',
        network: 'mainnet',
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        wif: walletData.wif, // Wallet Import Format
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
      // Encrypt privateKey and seedPhrase before they touch the database.
      return db.create('wallets', KeyVault.sealWallet(wallet));
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
    const feeRateSatPerVb = await this.estimateFeeRate(targetConfirmations);
    const txSizeVBytes = BitcoinWalletService.virtualSize(1, 2);
    const feeSatoshis = Math.ceil(feeRateSatPerVb * txSizeVBytes);

    console.log(`[BitcoinWalletService] Fee rate: ${feeRateSatPerVb} sat/vB → ${feeSatoshis} sats (${txSizeVBytes} vB)`);
    return Math.max(feeSatoshis, BitcoinWalletService.MIN_FEE_SATS);
  }

  /**
   * Live fee rate in sat/vB for the target confirmation window.
   */
  async estimateFeeRate(targetConfirmations = 6) {
    try {
      // mempool.space returns real-time fee rates in sat/vB
      const res = await this.mempool('/v1/fees/recommended');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const fees = await res.json();
      // fastestFee ≈ next block, halfHourFee ≈ 3 blocks, hourFee ≈ 6 blocks
      let rate;
      if (targetConfirmations <= 1)      rate = fees.fastestFee;
      else if (targetConfirmations <= 3) rate = fees.halfHourFee;
      else                               rate = fees.hourFee;

      if (!Number.isFinite(rate) || rate <= 0) throw new Error('no usable fee rate in response');
      return rate;
    } catch (error) {
      console.error(`[BitcoinWalletService] Fee estimation error: ${error.message}`);
      return BitcoinWalletService.FALLBACK_FEE_RATE;
    }
  }

  /**
   * Virtual size of a P2WPKH transaction with the given shape:
   * overhead 11 + 68 per input + 31 per output.
   */
  static virtualSize(inputCount, outputCount) {
    return 11 + 68 * inputCount + 31 * outputCount;
  }

  /**
   * An OP_RETURN output carrying `data`: the way a swap network is told
   * what to do with a deposit. 80 bytes at most; a push over 75 bytes needs
   * OP_PUSHDATA1 before its length.
   */
  static opReturnScript(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (bytes.length > 80) throw new Error(`OP_RETURN data is ${bytes.length} bytes; 80 is the most a node relays`);
    const push = bytes.length <= 75 ? Buffer.from([bytes.length]) : Buffer.from([0x4c, bytes.length]);
    return Buffer.concat([Buffer.from([0x6a]), push, bytes]);
  }


  /** Below this a change output is not worth creating; it becomes fee. */
  static get DUST_SATS() { return 546; }
  static get MIN_FEE_SATS() { return 500; }
  static get FALLBACK_FEE_RATE() { return 15; } // sat/vB, deliberately generous

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
  /**
   * Send `amount` BTC to `toAddress`. `options.memo` adds an OP_RETURN
   * output carrying it (a swap network's instruction), after the recipient
   * and the change, as the networks ask.
   */
  async sendTransaction(privateKey, toAddress, amount, options = {}) {
    try {
      const memo = options && options.memo ? BitcoinWalletService.opReturnScript(options.memo) : null;
      // the OP_RETURN output: 8 bytes of value, a length byte, the script
      const memoBytes = memo ? 9 + memo.length : 0;
      const privateKeyBuffer = Buffer.from(privateKey, 'hex');
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: ecc.pointFromScalar(privateKeyBuffer, true),
        network: bitcoin.networks.bitcoin,
      });

      // Get UTXOs for this address: a mempool mirror, else BlockCypher's
      // list (the same fields, and the segwit signing below needs no more).
      let data;
      try {
        const response = await this.mempool(`/address/${address}/utxo`);
        data = await response.json();
      } catch (error) {
        if (!error.explorersDown) throw error;
        console.warn(`[BitcoinWalletService] ${error.message}; listing unspent outputs through BlockCypher`);
        data = await this.fallback.getUtxos(address);
      }
      
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No unspent outputs (UTXOs) available');
      }

      // Largest first, so the fewest inputs (and the least fee) cover the send.
      const utxos = [...data].sort((a, b) => b.value - a.value);
      // Round, not floor: 0.00000003 * 1e8 is 2.9999999999999996 in floating point, and
      // about one exact 8-decimal amount in sixteen is short like that. A
      // fixed-rate shift needs the exact figure it quoted.
      const amountSatoshis = Math.round(Number(amount) * 100000000); // Convert BTC to satoshis
      const feeRate = await this.estimateFeeRate(6);

      // The fee depends on how many inputs are needed, and how many inputs are
      // needed depends on the fee - so select until the total covers the amount
      // plus the fee for the transaction as it currently stands. A flat
      // one-input fee used to be charged whatever the shape, which underpaid
      // (and could fall below the relay minimum) as soon as a wallet had
      // collected a few deposits.
      let selectedUtxos = [];
      let totalValue = 0;
      let feeSatoshis = 0;
      let totalNeeded = amountSatoshis;

      for (const utxo of utxos) {
        selectedUtxos.push({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
        });
        totalValue += utxo.value;
        feeSatoshis = Math.max(
          Math.ceil(feeRate * (BitcoinWalletService.virtualSize(selectedUtxos.length, 2) + memoBytes)),
          BitcoinWalletService.MIN_FEE_SATS
        );
        totalNeeded = amountSatoshis + feeSatoshis;
        if (totalValue >= totalNeeded) break;
      }

      if (totalValue < totalNeeded) {
        throw new Error(`Insufficient funds: need ${totalNeeded} satoshis, have ${totalValue}`);
      }

      // A change output below the dust limit would be rejected by the network;
      // let it go to the miner instead.
      let changeSatoshis = totalValue - totalNeeded;
      if (changeSatoshis > 0 && changeSatoshis < BitcoinWalletService.DUST_SATS) {
        feeSatoshis += changeSatoshis;
        changeSatoshis = 0;
      }
      console.log(`[BitcoinWalletService] ${selectedUtxos.length} input(s), fee ${feeSatoshis} sats at ${feeRate} sat/vB, change ${changeSatoshis} sats`);

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
      if (changeSatoshis > 0) {
        psbt.addOutput({
          script: Uint8Array.from(scriptOutput),
          value: BigInt(changeSatoshis),
        });
      }

      // The memo, last: recipient, change, then OP_RETURN.
      if (memo) {
        psbt.addOutput({ script: Uint8Array.from(memo), value: 0n });
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
   * Broadcast a signed transaction, trying each endpoint in turn.
   *
   * A rejection by the node (bad fee, dust, double spend) is final and is not
   * retried elsewhere - the transaction is the problem, not the endpoint.
   * Only transport failures and gateway errors move on to the next one.
   * @param {string} txHex - Signed transaction in hex format
   * @returns {Promise<string>} Transaction ID
   */
  async broadcastRawTransaction(txHex) {
    const failures = [];

    for (const endpoint of this.broadcastEndpoints) {
      try {
        if (endpoint.kind === 'rpc') {
          return await this._broadcastViaRpc(endpoint.url, txHex);
        }
        return await this._broadcastViaExplorer(endpoint.url, txHex);
      } catch (error) {
        if (error.rejected) {
          throw new Error(`Transaction rejected by the network: ${error.message}`);
        }
        failures.push(`${endpoint.url}: ${error.message}`);
        console.warn(`[BitcoinWalletService] Broadcast via ${endpoint.url} failed, trying next: ${error.message}`);
      }
    }

    throw new Error(`Failed to broadcast transaction on every endpoint: ${failures.join(' | ')}`);
  }

  async _broadcastViaRpc(url, txHex) {
    const response = await ProxyService.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendrawtransaction', params: [txHex] }),
    });

    if (!response.ok) {
      throw new Error(`RPC error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      const error = new Error(data.error.message || JSON.stringify(data.error));
      // -25/-26/-27: rejected by mempool policy or already known. Not retryable.
      error.rejected = [-25, -26, -27].includes(data.error.code);
      throw error;
    }

    return data.result; // txid
  }

  async _broadcastViaExplorer(url, txHex) {
    const response = await ProxyService.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
    });

    const text = (await response.text()).trim();
    if (!response.ok) {
      const error = new Error(`explorer ${response.status}: ${text.slice(0, 200)}`);
      // mempool.space answers 400 with the node's rejection reason.
      error.rejected = response.status === 400;
      throw error;
    }

    if (!/^[0-9a-f]{64}$/i.test(text)) {
      throw new Error(`unexpected broadcast response: ${text.slice(0, 100)}`);
    }
    return text;
  }
}

module.exports = new BitcoinWalletService();
