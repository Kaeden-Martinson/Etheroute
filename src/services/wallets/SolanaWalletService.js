const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const nacl = require('tweetnacl');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const ProxyService = require('../ProxyService');

class SolanaWalletService {
  constructor() {
    // Solana mainnet endpoints
    // Tatum gateway for transaction sending, but free tier has method restrictions
    // Use public endpoints for read-only operations like getBalance
    this.endpoints = {
      mainnet: 'https://solana-mainnet.gateway.tatum.io/',
      publicEndpoint: 'https://api.mainnet-beta.solana.com', // For read operations without restrictions
    };
    
    // Lazy load connections
    this._connections = {};
  }

  /**
   * Generate Solana wallet from BIP39 mnemonic
   * Uses BIP44 derivation path: m/44'/501'/0'/0'
   * @param {string} mnemonic - Optional BIP39 mnemonic, generates new if not provided
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

      // Solana uses BIP44 path: m/44'/501'/0'/0'
      // 501 is the Solana coin type
      const path = `m/44'/501'/0'/0'`;
      const derivedSeed = derivePath(path, seed.toString('hex')).key;

      // Create keypair from derived seed
      const keypair = nacl.sign.keyPair.fromSeed(derivedSeed);

      // Convert to Solana Keypair format
      const solanaKeypair = Keypair.fromSecretKey(Buffer.from(keypair.secretKey));

      return {
        address: solanaKeypair.publicKey.toBase58(),
        publicKey: solanaKeypair.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKeypair.secretKey).toString('hex'),
        secretKey: Array.from(solanaKeypair.secretKey), // Array format for storage
        mnemonic: mnemonic,
        keypair: solanaKeypair, // For API use
        derivationPath: path,
      };
    } catch (error) {
      throw new Error(`Failed to generate Solana wallet: ${error.message}`);
    }
  }

  /**
   * Get wallet balance in SOL
   * Uses public endpoint via ProxyService to avoid paid-tier restrictions
   * @param {string} address - Solana wallet address
   * @param {string} network - Network to query
   * @returns {Promise<Object>} Balance information
   */
  async getBalance(address, network = 'mainnet') {
    try {
      // Use public endpoint (not Tatum) to avoid paid-tier restrictions
      const publicRpcUrl = this.endpoints.publicEndpoint;
      
      // Use ProxyService to handle rate limiting and proxy rotation
      const response = await ProxyService.fetch(publicRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [address],
        }),
      });

      // Check for rate limiting
      if (response.status === 429) {
        const retryAfterMs = ProxyService.parseRetryAfter(response);
        const retryAfterSec = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 'unknown';
        console.warn(`[SolanaWalletService] Balance fetch rate limited (429). Retry after ${retryAfterSec}s. Using proxy: ${ProxyService.getCurrentProxyInfo()}`);
        return {
          address,
          network,
          status: 'rate_limited',
          retryAfter: retryAfterSec,
          timestamp: new Date().toISOString(),
        };
      }

      if (!response.ok) {
        const text = await response.text();
        console.warn(`[SolanaWalletService] Balance fetch failed (${response.status}): ${text.substring(0, 100)}`);
        return {
          address,
          network,
          status: 'error',
          error: `HTTP ${response.status}`,
          timestamp: new Date().toISOString(),
        };
      }

      const data = await response.json();
      
      if (data.error) {
        console.warn(`[SolanaWalletService] RPC error: ${data.error.message}`);
        return {
          address,
          network,
          status: 'error',
          error: data.error.message,
          timestamp: new Date().toISOString(),
        };
      }

      // Handle both response formats: direct number or object with value
      let balanceLamports = data.result;
      if (typeof balanceLamports === 'object' && balanceLamports !== null) {
        balanceLamports = balanceLamports.value || 0;
      }
      
      const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;

      return {
        address,
        balanceLamports,
        balanceSOL,
        network,
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      console.error(`[SolanaWalletService] Error fetching balance: ${error.message}`);
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
   * @param {string} network - Solana network
   * @returns {Promise<Object>} Updated balance info
   */
  async updateBalance(wallet, solanaToUsdRate, network = 'mainnet') {
    try {
      const balanceInfo = await this.getBalance(wallet.address, network);

      if (balanceInfo.status === 'success') {
        // Update in database
        db.update('wallets', wallet.id, {
          balance: balanceInfo.balanceSOL,
          balanceUSD: balanceInfo.balanceSOL * solanaToUsdRate,
          lastUpdated: new Date().toISOString(),
        });
      } else if (balanceInfo.status === 'rate_limited') {
        console.warn(`[SolanaWalletService] Balance update rate limited for ${wallet.address}. Retry after ${balanceInfo.retryAfter}s`);
      }

      return balanceInfo;
    } catch (error) {
      console.error(`Error updating SOL balance for ${wallet.address}:`, error.message);
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
   * @param {string} network - Solana network
   * @returns {Object} Wallet document
   */
  createWallet(clientId, mnemonic = null, network = 'mainnet') {
    try {
      // Generate wallet
      const walletData = this.generateWalletFromMnemonic(mnemonic);

      // Create wallet document
      const wallet = {
        id: uuidv4(),
        clientId,
        address: walletData.address,
        chain: 'SOL',
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
      throw new Error(`Failed to create Solana wallet: ${error.message}`);
    }
  }

  /**
   * Get wallet transaction history
   * Uses public endpoint to avoid paid-tier restrictions
   * @param {string} address - Solana wallet address
   * @param {number} limit - Number of recent transactions
   * @param {string} network - Network to query
   * @returns {Promise<Array>} Recent transactions
   */
  async getTransactionHistory(address, limit = 10, network = 'mainnet') {
    try {
      // Use public endpoint to avoid restrictions
      const publicRpcUrl = this.endpoints.publicEndpoint;
      
      // Get signatures first via ProxyService
      const sigResponse = await ProxyService.fetch(publicRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit }],
        }),
      });

      // Check for rate limiting
      if (sigResponse.status === 429) {
        const retryAfterMs = ProxyService.parseRetryAfter(sigResponse);
        const retryAfterSec = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 'unknown';
        console.warn(`[SolanaWalletService] getTransactionHistory rate limited. Retry after ${retryAfterSec}s`);
        return {
          address,
          network,
          status: 'rate_limited',
          retryAfter: retryAfterSec,
        };
      }

      if (!sigResponse.ok) {
        return {
          address,
          network,
          status: 'error',
          error: `HTTP ${sigResponse.status}`,
        };
      }

      const sigData = await sigResponse.json();
      if (sigData.error) {
        return {
          address,
          network,
          status: 'error',
          error: sigData.error.message,
        };
      }

      const signatures = sigData.result || [];
      
      // Get transaction details for each signature
      const transactions = [];
      for (const sig of signatures) {
        try {
          const txResponse = await ProxyService.fetch(publicRpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: [sig.signature, { encoding: 'json' }],
            }),
          });

          if (txResponse.ok) {
            const txData = await txResponse.json();
            if (txData.result) {
              transactions.push({
                signature: sig.signature,
                timestamp: sig.blockTime,
                slot: sig.slot,
                status: sig.confirmationStatus,
                fee: txData.result?.meta?.fee || 0,
              });
            }
          }
        } catch (txError) {
          console.warn(`[SolanaWalletService] Error fetching transaction ${sig.signature}: ${txError.message}`);
        }
      }

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
   * Estimate Solana transaction fee
   * Solana has a fixed fee structure: 5000 lamports per signature
   * This is different from Bitcoin/Litecoin where fees vary by network congestion
   * @param {number} numSignatures - Number of signatures in transaction (default 1)
   * @returns {Promise<number>} Fee in lamports
   */
  async estimateFee(numSignatures = 1, network = 'mainnet') {
    try {
      // Solana's fee is fixed at 5000 lamports per signature
      // This never changes and doesn't require an RPC call
      const baseFeePerSignature = 5000;
      const estimatedFee = baseFeePerSignature * numSignatures;

      console.log(`[SolanaWalletService] Estimated fee: ${estimatedFee} lamports (${numSignatures} signatures @ 5000/sig)`);
      return estimatedFee;
    } catch (error) {
      console.error(`[SolanaWalletService] Fee estimation error: ${error.message}`);
      return 5000 * numSignatures; // Fallback
    }
  }

  /**
   * Send SOL to an address
   * @param {string} privateKey - Private key (hex or JSON array)
   * @param {string} toAddress - Recipient Solana address
   * @param {number} amount - Amount in SOL
   * @returns {Promise<string>} Transaction hash
   */
  async sendTransaction(privateKey, toAddress, amount, network = 'mainnet') {
    try {
      const { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
      const rpcUrl = this.endpoints[network];
      const connection = new Connection(rpcUrl, 'confirmed');
      
      // Convert hex private key to Buffer if needed
      let secretBuffer;
      if (typeof privateKey === 'string') {
        // Try parsing as hex first
        try {
          secretBuffer = Buffer.from(privateKey, 'hex');
        } catch {
          // If that fails, try JSON array
          const secretArray = JSON.parse(privateKey);
          secretBuffer = Buffer.from(secretArray);
        }
      } else {
        secretBuffer = Buffer.from(privateKey);
      }
      
      const keypair = Keypair.fromSecretKey(secretBuffer);
      
      // Build transaction
      // Convert SOL to lamports (1 SOL = 1,000,000 lamports), rounding to integer
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(toAddress),
          lamports: lamports,
        })
      );

      // Get recent blockhash via ProxyService
      const response = await ProxyService.fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }],
        }),
      });

      let blockhash;
      try {
        const data = await response.json();
        if (data.result?.value?.blockhash) {
          blockhash = data.result.value.blockhash;
        } else {
          throw new Error('No blockhash in response');
        }
      } catch (e) {
        console.warn('[SolanaWalletService] Failed to get blockhash via RPC, using fallback');
        // Fallback: use connection method
        const { blockhash: fallbackBlockhash } = await connection.getLatestBlockhash();
        blockhash = fallbackBlockhash;
      }

      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;

      // Sign and send
      transaction.sign(keypair);
      const txHash = await connection.sendRawTransaction(transaction.serialize());
      
      console.log(`[SolanaWalletService] Transaction sent: ${txHash}`);
      return txHash;
    } catch (error) {
      throw new Error(`Failed to send Solana transaction: ${error.message}`);
    }
  }
}

module.exports = new SolanaWalletService();
