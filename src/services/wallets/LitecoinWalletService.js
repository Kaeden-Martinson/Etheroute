const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const KeyVault = require('../crypto/KeyVault');
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
    // Explorers that speak the mempool.space API, tried in order. When none
    // answers, the reads - and a send - go through BlockCypher via the
    // legacy-UTXO service (Litecoin's wallets are pay-to-pubkey-hash, which
    // that signer handles).
    this.mirrors = ['https://litecoinspace.org/api'];

    // RPC endpoints for Litecoin
    this.rpcEndpoints = {
      mainnet: 'https://litecoin-mainnet.gateway.tatum.io',
    };

    // Where a signed transaction is pushed, in order. The Tatum gateway
    // accepts sendrawtransaction without a key today; litecoinspace is the
    // fallback for the day it stops.
    this.broadcastEndpoints = [
      { kind: 'rpc', url: 'https://litecoin-mainnet.gateway.tatum.io' },
      { kind: 'explorer', url: 'https://litecoinspace.org/api/tx' },
    ];

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

      // Litecoin uses BIP44 path: m/44'/2'/0'/0/0
      // 2 is the Litecoin coin type
      const derivationPath = this.networkConfig.mainnet.derivation;
      const root = bip32.fromSeed(seed, this.networks.mainnet);
      const derived = root.derivePath(derivationPath);

      // Get private key and public key
      const privateKey = derived.privateKey ? Buffer.from(derived.privateKey).toString('hex') : null;
      const publicKey = derived.publicKey.toString('hex');

      // Create legacy address (P2PKH) - Litecoin L or M format
      const { address } = bitcoin.payments.p2pkh({
        pubkey: derived.publicKey,
        network: this.networks.mainnet,
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
        network: 'mainnet',
        networkName: this.networkConfig.mainnet.name,
      };
    } catch (error) {
      throw new Error(`Failed to generate Litecoin wallet: ${error.message}`);
    }
  }

  /** The BlockCypher-backed twin, for when litecoinspace is not answering. */
  get fallback() {
    return require('./LegacyUtxoWalletService').createLegacyUtxoWalletService('LTC');
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
    const error = new Error(`every Litecoin explorer failed: ${failures.join(' | ')}`);
    error.explorersDown = true;
    throw error;
  }

  /**
   * Get wallet balance in LTC: litecoinspace, else BlockCypher.
   * @param {string} address - Litecoin wallet address
   * @returns {Promise<Object>} Balance information
   */
  async getBalance(address) {
    const first = await this.getBalanceFromMempool(address);
    if (first.status !== 'error') return first;
    console.warn(`[LitecoinWalletService] litecoinspace failed for ${address} (${first.error}); reading BlockCypher`);
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
        console.warn(`[LitecoinWalletService] Rate limited by API. Retry after ${retryAfterSec}s. Using proxy: ${ProxyService.getCurrentProxyInfo()}`);
        return {
          address,
          balanceSatoshis: 0,
          balanceLTC: 0,
          network: 'mainnet',
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
  async updateBalance(wallet, ltcToUsdRate) {
    try {
      const balanceInfo = await this.getBalance(wallet.address);

      if (balanceInfo.status === 'success') {
        // Update in database
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceLTC,
          balanceUSD: balanceInfo.balanceLTC * ltcToUsdRate,
          lastUpdated: new Date().toISOString(),
        });

        balanceInfo.balance = balanceInfo.balanceLTC * ltcToUsdRate; // For consistency in returned object
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
  createWallet(clientId, mnemonic = null) {
    try {
      // Generate wallet
      const walletData = this.generateWalletFromMnemonic(mnemonic);

      // Create wallet document
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: 'LTC',
        network: 'mainnet',
        privateKey: walletData.privateKey,
        publicKey: walletData.publicKey,
        wif: walletData.wif,
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
  async getTransactionHistory(address, limit = 10) {
    const first = await this.getTransactionHistoryFromMempool(address, limit);
    if (first.status !== 'error') return first;
    console.warn(`[LitecoinWalletService] litecoinspace history failed for ${address} (${first.error}); reading BlockCypher`);
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

      // Chain tip, so each transaction can report its depth. LTC checkout
      // requires two confirmations; without the tip the most this could ever
      // report was one, so no LTC session ever settled.
      const tipHeight = await this.getTipHeight();

      const transactions = (Array.isArray(data) ? data : []).slice(0, limit).map(tx => {
        const inputSum  = tx.vin?.reduce((s, inp) => s + (inp.prevout?.value || 0), 0) || 0;
        const outputSum = tx.vout?.reduce((s, out) => s + (out.value       || 0), 0) || 0;
        const blockHeight = tx.status?.block_height || null;
        return {
          txid:        tx.txid,
          hash:        tx.txid,
          time:        tx.status?.block_time || null,   // unix seconds (null if unconfirmed)
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
      console.warn(`[LitecoinWalletService] Tip height unavailable (${error.message}); asking BlockCypher`);
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
      console.warn(`[LitecoinWalletService] Status of ${txid} unavailable (${error.message}); asking BlockCypher`);
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
    const feeRateSatPerVb = await this.estimateFeeRate(targetConfirmations);
    const txSizeVBytes = LitecoinWalletService.virtualSize(1, 2);
    const feeSatoshis = Math.ceil(feeRateSatPerVb * txSizeVBytes);

    console.log(`[LitecoinWalletService] Fee rate: ${feeRateSatPerVb} sat/vB → ${feeSatoshis} sats (${txSizeVBytes} vB)`);
    return Math.max(feeSatoshis, LitecoinWalletService.MIN_FEE_SATS);
  }

  /**
   * Live fee rate in sat/vB for the target confirmation window.
   */
  async estimateFeeRate(targetConfirmations = 6) {
    try {
      // litecoinspace.org uses the same API format as mempool.space (sat/vB)
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
      console.error(`[LitecoinWalletService] Fee estimation error: ${error.message}`);
      return LitecoinWalletService.FALLBACK_FEE_RATE;
    }
  }

  /**
   * Size of a legacy P2PKH transaction with the given shape - the wallets
   * here are P2PKH ("L..." addresses), which are larger than SegWit:
   * overhead 10 + 148 per input + 34 per output.
   */
  static virtualSize(inputCount, outputCount) {
    return 10 + 148 * inputCount + 34 * outputCount;
  }

  /** Below this a change output is not worth creating; it becomes fee. */
  static get DUST_SATS() { return 1000; }
  static get MIN_FEE_SATS() { return 1000; }

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
  static get FALLBACK_FEE_RATE() { return 10; } // sat/vB, deliberately generous

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
  /**
   * Send `amount` LTC to `toAddress`. `options.memo` adds an OP_RETURN
   * output carrying it (a swap network's instruction), after the recipient
   * and the change.
   */
  /** The output script paying `address`, for any of the forms parseAddress knows. */
  scriptForAddress(address) {
    const info = this.parseAddress(address);
    if (info.type === 'p2pkh') {
      // OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
      return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), info.hash, Buffer.from([0x88, 0xac])]);
    }
    if (info.type === 'p2wpkh') {
      // OP_0 <20-byte-hash>
      return Buffer.concat([Buffer.from([0, info.data.length]), info.data]);
    }
    if (info.type === 'p2sh') {
      // OP_HASH160 <20-byte-hash> OP_EQUAL
      return Buffer.concat([Buffer.from([0xa9, 0x14]), info.hash, Buffer.from([0x87])]);
    }
    throw new Error(`Unsupported address type: ${info.type}`);
  }

  /**
   * The outputs a send carries beside the recipient: `options.extraOutputs`
   * as `[{ address, amount }]` (the platform's fee rides in the same
   * transaction this way), each above the dust limit.
   */
  extraOutputsOf(options) {
    return (options && Array.isArray(options.extraOutputs) ? options.extraOutputs : []).map((o) => {
      const value = Math.round(Number(o.amount) * 100000000);
      if (!(value >= LitecoinWalletService.DUST_SATS)) throw new Error(`Extra output of ${o.amount} LTC to ${o.address} is below the dust limit`);
      return { script: this.scriptForAddress(o.address), value, address: o.address };
    });
  }

  async sendTransaction(privateKey, toAddress, amount, options = {}) {
    try {
      const memo = options && options.memo ? LitecoinWalletService.opReturnScript(options.memo) : null;
      const memoBytes = memo ? 9 + memo.length : 0;
      const extras = this.extraOutputsOf(options);
      const extraSatoshis = extras.reduce((sum, o) => sum + o.value, 0);
      const privateKeyBuffer = Buffer.from(privateKey, 'hex');
      const pubKey = ecc.pointFromScalar(privateKeyBuffer, true);

      // Generate sender address using Litecoin network params (P2PKH for 'L' addresses)
      const { address: senderAddress } = bitcoin.payments.p2pkh({
        pubkey: pubKey,
        network: this.networks.mainnet, // Use Litecoin network params
      });

      console.log(`[LitecoinWalletService] Sender address: ${senderAddress}`);
      console.log(`[LitecoinWalletService] Recipient address: ${toAddress}`);

      // Get UTXOs from litecoinspace; if no explorer answers, the whole
      // send goes through BlockCypher and the legacy signer instead.
      let response;
      try {
        response = await this.mempool(`/address/${senderAddress}/utxo`);
      } catch (error) {
        if (!error.explorersDown) throw error;
        console.warn(`[LitecoinWalletService] ${error.message}; sending through BlockCypher`);
        return this.fallback.sendTransaction(privateKey, toAddress, amount, options);
      }

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

      // Largest first, so the fewest inputs (and the least fee) cover the send.
      const utxos = [...data].sort((a, b) => b.value - a.value);
      // Round, not floor - see the Bitcoin service.
      const amountSatoshis = Math.round(Number(amount) * 100000000); // Convert LTC to satoshis
      const feeRate = await this.estimateFeeRate(6);

      // Fee sized to the transaction actually being built - see the Bitcoin
      // service for why. Each P2PKH input adds ~148 bytes.
      let selectedUtxos = [];
      let totalValue = 0;
      let feeSatoshis = 0;
      let totalNeeded = amountSatoshis + extraSatoshis;

      for (const utxo of utxos) {
        selectedUtxos.push({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
        });
        totalValue += utxo.value;
        feeSatoshis = Math.max(
          Math.ceil(feeRate * (LitecoinWalletService.virtualSize(selectedUtxos.length, 2 + extras.length) + memoBytes)),
          LitecoinWalletService.MIN_FEE_SATS
        );
        totalNeeded = amountSatoshis + extraSatoshis + feeSatoshis;
        if (totalValue >= totalNeeded) break;
      }

      if (totalValue < totalNeeded) {
        throw new Error(`Insufficient funds: need ${totalNeeded} satoshis, have ${totalValue}`);
      }

      let changeSatoshis = totalValue - totalNeeded;
      if (changeSatoshis > 0 && changeSatoshis < LitecoinWalletService.DUST_SATS) {
        feeSatoshis += changeSatoshis;
        changeSatoshis = 0;
      }
      console.log(`[LitecoinWalletService] ${selectedUtxos.length} input(s), fee ${feeSatoshis} sats at ${feeRate} sat/vB, change ${changeSatoshis} sats${extras.length ? `, ${extras.length} extra output(s) ${extraSatoshis} sats` : ''}`);

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
          const txResponse = await this.mempool(`/tx/${utxo.txid}/hex`);
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
          const txResponse = await this.mempool(`/tx/${utxo.txid}`);
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

      // Outputs: the recipient, any extra outputs, the change, then the memo.
      const recipientInfo = this.parseAddress(toAddress);
      console.log(`[LitecoinWalletService] Recipient address type: ${recipientInfo.type} - ${recipientInfo.description}`);
      const recipientScript = this.scriptForAddress(toAddress);

      psbt.addOutput({
        script: Uint8Array.from(recipientScript),
        value: BigInt(amountSatoshis),
      });

      for (const extra of extras) {
        psbt.addOutput({ script: Uint8Array.from(extra.script), value: BigInt(extra.value) });
      }

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
   * Broadcast a signed transaction, trying each endpoint in turn. A node
   * rejection is final; only transport and gateway failures move on.
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
        console.warn(`[LitecoinWalletService] Broadcast via ${endpoint.url} failed, trying next: ${error.message}`);
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
      error.rejected = response.status === 400;
      throw error;
    }

    if (!/^[0-9a-f]{64}$/i.test(text)) {
      throw new Error(`unexpected broadcast response: ${text.slice(0, 100)}`);
    }
    return text;
  }
}

module.exports = new LitecoinWalletService();
