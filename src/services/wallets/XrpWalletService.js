/**
 * Wallet service for the XRP Ledger.
 *
 * Its own family: accounts rather than outputs, a sequence number per
 * account, a fee of a few drops, and a reserve the account must keep (one
 * XRP today, read live from the network) that a sweep leaves behind. A
 * payment settles in the next validated ledger, three to five seconds on,
 * and validation is final: one confirmation is all there is.
 *
 * Reads and the submit go over JSON-RPC to the public cluster (through the
 * proxy layer like every other explorer call); signing is xrpl.js, offline.
 * A memo - THORChain's order - rides in the Memos field; a destination tag
 * - what SideShift needs to tell deposits apart - in DestinationTag.
 *
 * The shape the rest of the app expects is the one the other families
 * keep: `getBalance` reports `balanceXRP`, `createWallet` seals keys through
 * the vault, `sendTransaction` takes a decimal amount and returns the hash.
 */
const xrpl = require('xrpl');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const KeyVault = require('../crypto/KeyVault');
const ProxyService = require('../ProxyService');

const DROPS = 1_000_000;
const RIPPLE_EPOCH = 946684800;
const DERIVATION_PATH = "m/44'/144'/0'/0/0";

// How many ledgers a submitted payment stays valid for: about a minute. A
// payment that has not made it in by then can never make it in, so a retry
// is safe.
const LEDGERS_TO_LIVE = 20;

// The base reserve if the network cannot be asked; the network is asked
// first and cached for an hour.
const FALLBACK_RESERVE_XRP = 1;
const RESERVE_TTL_MS = 60 * 60 * 1000;

class XrpWalletService {
  constructor() {
    this.code = 'XRP';
    this.tag = '[XrpWalletService]';
    // Public JSON-RPC, in order; the first that answers is used per call.
    this.endpoints = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234'];
    this.reserve = { at: 0, xrp: FALLBACK_RESERVE_XRP };
  }

  // ── keys ──────────────────────────────────────────────────────────────

  generateWalletFromMnemonic(mnemonic = null) {
    try {
      if (!mnemonic) mnemonic = bip39.generateMnemonic();
      else if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid BIP39 mnemonic');
      const wallet = xrpl.Wallet.fromMnemonic(mnemonic, { derivationPath: DERIVATION_PATH });
      return {
        address: wallet.classicAddress,
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        mnemonic,
        derivationPath: DERIVATION_PATH,
        network: 'mainnet',
        networkName: 'XRP Ledger',
      };
    } catch (error) {
      throw new Error(`Failed to generate XRP wallet: ${error.message}`);
    }
  }

  /**
   * The signing wallet from what the record holds. xrpl needs the public
   * key beside the private one; a record that carries the seed phrase can
   * always be rebuilt from that.
   */
  walletFrom(privateKey, publicKey = null, mnemonic = null) {
    if (publicKey) return new xrpl.Wallet(publicKey, privateKey);
    if (mnemonic) return xrpl.Wallet.fromMnemonic(mnemonic, { derivationPath: DERIVATION_PATH });
    throw new Error('An XRP wallet needs its public key or its seed phrase to sign');
  }

  createWallet(clientId, mnemonic = null) {
    try {
      const data = this.generateWalletFromMnemonic(mnemonic);
      const wallet = {
        id: uuidv4(),
        clientId,
        address: data.address,
        chain: 'XRP',
        network: 'mainnet',
        privateKey: data.privateKey,
        publicKey: data.publicKey,
        seedPhrase: data.mnemonic,
        derivationPath: data.derivationPath,
        balance: 0,
        balanceUSD: 0,
        serviceSubtractions: 0,
        lastUpdated: new Date().toISOString(),
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      return db.create('wallets', KeyVault.sealWallet(wallet));
    } catch (error) {
      throw new Error(`Failed to create XRP wallet: ${error.message}`);
    }
  }

  validateAddress(address) {
    return xrpl.isValidClassicAddress(String(address || ''));
  }

  // ── the network ───────────────────────────────────────────────────────

  /** One JSON-RPC call, on the first endpoint that answers. */
  async rpc(method, params = {}) {
    const failures = [];
    for (const url of this.endpoints) {
      try {
        const response = await ProxyService.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, params: [params] }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const result = data && data.result;
        if (!result) throw new Error('no result');
        // rippled reports errors inside a successful HTTP response
        if (result.status === 'error') {
          const error = new Error(result.error_message || result.error || 'rpc error');
          error.rippled = result.error;
          throw error;
        }
        return result;
      } catch (error) {
        // an answer from the network is final; a dead endpoint is tried past
        if (error.rippled) throw error;
        failures.push(`${url}: ${error.message}`);
      }
    }
    throw new Error(`XRP Ledger unreachable: ${failures.join(' | ')}`);
  }

  /** The base reserve an account must hold, from the network, cached an hour. */
  async baseReserve() {
    if (Date.now() - this.reserve.at < RESERVE_TTL_MS) return this.reserve.xrp;
    try {
      const info = await this.rpc('server_info');
      const xrp = Number(info.info && info.info.validated_ledger && info.info.validated_ledger.reserve_base_xrp);
      if (xrp > 0) this.reserve = { at: Date.now(), xrp };
    } catch (error) {
      console.warn(`${this.tag} server_info failed: ${error.message}`);
    }
    return this.reserve.xrp;
  }

  async getBalance(address) {
    try {
      if (!this.validateAddress(address)) throw new Error('Invalid address format');
      let drops = 0;
      try {
        const info = await this.rpc('account_info', { account: address, ledger_index: 'validated' });
        drops = Number(info.account_data.Balance) || 0;
      } catch (error) {
        // an account nobody has paid yet does not exist on the ledger
        if (error.rippled !== 'actNotFound') throw error;
      }
      return { address, balanceDrops: drops, balanceXRP: drops / DROPS, network: 'mainnet', timestamp: new Date().toISOString(), status: 'success' };
    } catch (error) {
      return { address, balanceXRP: 0, network: 'mainnet', status: 'error', error: error.message, timestamp: new Date().toISOString() };
    }
  }

  async updateBalance(wallet, usdRate) {
    try {
      const info = await this.getBalance(wallet.address);
      if (info.status === 'success') {
        db.update('wallets', wallet.id, {
          balance: info.balanceXRP,
          balanceUSD: info.balanceXRP * usdRate,
          lastUpdated: new Date().toISOString(),
        });
        info.balance = info.balanceXRP * usdRate;
      }
      return info;
    } catch (error) {
      console.error(`${this.tag} Error updating balance for ${wallet.address}:`, error.message);
      return { address: wallet.address, status: 'error', error: error.message };
    }
  }

  /**
   * Recent payments touching an address: sender, recipient, what was
   * delivered, when, and whether the ledger validated it.
   */
  async getTransactionHistory(address, limit = 20) {
    try {
      if (!this.validateAddress(address)) return { address, network: 'mainnet', status: 'error', error: 'Invalid address format' };
      let result;
      try {
        result = await this.rpc('account_tx', { account: address, limit, ledger_index_min: -1, ledger_index_max: -1 });
      } catch (error) {
        if (error.rippled === 'actNotFound') return { address, transactionCount: 0, network: 'mainnet', transactions: [], timestamp: new Date().toISOString() };
        throw error;
      }
      const transactions = (result.transactions || [])
        .map((entry) => ({ tx: entry.tx || entry.tx_json || {}, meta: entry.meta || {}, validated: entry.validated }))
        .filter(({ tx }) => tx.TransactionType === 'Payment')
        .map(({ tx, meta, validated }) => {
          const delivered = typeof meta.delivered_amount === 'string' ? Number(meta.delivered_amount) / DROPS : 0;
          return {
            hash: tx.hash,
            sender: tx.Account,
            recipient: tx.Destination,
            amount: delivered,
            destinationTag: tx.DestinationTag ?? null,
            timestamp: tx.date ? tx.date + RIPPLE_EPOCH : 0,
            validated: Boolean(validated) && meta.TransactionResult === 'tesSUCCESS',
            ledgerIndex: tx.ledger_index || tx.inLedger || null,
            result: meta.TransactionResult || null,
          };
        });
      return { address, transactionCount: transactions.length, network: 'mainnet', transactions, timestamp: new Date().toISOString() };
    } catch (error) {
      return { address, network: 'mainnet', status: 'error', error: error.message, transactions: [] };
    }
  }

  /** Where a payment stands: validated is final. */
  async getTransactionStatus(hash) {
    try {
      const tx = await this.rpc('tx', { transaction: hash });
      const meta = tx.meta || {};
      if (!tx.validated) return { status: 'waiting', confirmations: 0, blockHeight: null };
      if (meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') return { status: 'failed', confirmations: 0, blockHeight: tx.ledger_index || null };
      return { status: 'settled', confirmations: 1, blockHeight: tx.ledger_index || null };
    } catch (error) {
      if (error.rippled === 'txnNotFound') return { status: 'not_found', confirmations: 0, blockHeight: null };
      throw error;
    }
  }

  /** The validated ledger's index, or null. */
  async getTipHeight() {
    try {
      const ledger = await this.rpc('ledger', { ledger_index: 'validated' });
      return Number(ledger.ledger_index) || null;
    } catch {
      return null;
    }
  }

  /** The fee to get into the open ledger, in drops. */
  async estimateFee() {
    try {
      const fee = await this.rpc('fee');
      const drops = Number(fee.drops && fee.drops.open_ledger_fee) || 10;
      // never under the base fee, and a little over the open-ledger fee so a
      // busy ledger does not queue it
      return Math.max(10, Math.ceil(drops * 1.2));
    } catch {
      return 12;
    }
  }

  // ── sending ───────────────────────────────────────────────────────────

  /**
   * Pay `amount` XRP to `toAddress`. The reserve stays behind whatever the
   * amount asks. `options.memo` rides in Memos (THORChain's order);
   * `options.destinationTag` in DestinationTag (a SideShift deposit).
   * `options.publicKey` / `options.mnemonic` rebuild the signing wallet
   * beside the private key.
   */
  async sendTransaction(privateKey, toAddress, amount, options = {}) {
    try {
      if (!this.validateAddress(toAddress)) throw new Error(`Invalid XRP address: ${toAddress}`);
      const drops = Math.round(Number(amount) * DROPS);
      if (!(drops > 0)) throw new Error(`Invalid amount: ${amount}`);
      const wallet = this.walletFrom(privateKey, options.publicKey, options.mnemonic);

      const [info, feeDrops, ledger, reserveXrp] = await Promise.all([
        this.rpc('account_info', { account: wallet.classicAddress, ledger_index: 'validated' }),
        this.estimateFee(),
        this.rpc('ledger', { ledger_index: 'validated' }),
        this.baseReserve(),
      ]);
      const balance = Number(info.account_data.Balance);
      const reserveDrops = Math.round(reserveXrp * DROPS) + Number(info.account_data.OwnerCount || 0) * 200_000;
      const spendable = balance - reserveDrops - feeDrops;
      if (drops > spendable) {
        throw new Error(`Insufficient balance. Have ${balance / DROPS} XRP, of which ${reserveDrops / DROPS} is the account reserve; ${amount} + ${feeDrops / DROPS} fee is more than the ${Math.max(0, spendable) / DROPS} spendable`);
      }

      const tx = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: toAddress,
        Amount: String(drops),
        Fee: String(feeDrops),
        Sequence: Number(info.account_data.Sequence),
        LastLedgerSequence: Number(ledger.ledger_index) + LEDGERS_TO_LIVE,
      };
      if (options.destinationTag !== undefined && options.destinationTag !== null && options.destinationTag !== '') {
        tx.DestinationTag = Number(options.destinationTag);
      }
      if (options.memo) {
        tx.Memos = [{ Memo: { MemoData: Buffer.from(String(options.memo), 'utf8').toString('hex').toUpperCase() } }];
      }

      const signed = wallet.sign(tx);
      const submitted = await this.rpc('submit', { tx_blob: signed.tx_blob });
      const result = submitted.engine_result;
      // tesSUCCESS: in the open ledger; terQUEUED: queued for the next. A
      // tec/tef/tem result is a rejection.
      if (result !== 'tesSUCCESS' && result !== 'terQUEUED') {
        throw new Error(`Transaction rejected by the network: ${result} ${submitted.engine_result_message || ''}`.trim());
      }
      console.log(`${this.tag} Payment sent: ${signed.hash} | ${drops / DROPS} XRP -> ${toAddress} | fee ${feeDrops} drops${options.memo ? ' | memo' : ''}${tx.DestinationTag !== undefined ? ` | tag ${tx.DestinationTag}` : ''}`);
      return signed.hash;
    } catch (error) {
      throw new Error(`Failed to send XRP transaction: ${error.message}`);
    }
  }
}

module.exports = new XrpWalletService();
module.exports.XrpWalletService = XrpWalletService;
module.exports.DROPS = DROPS;
module.exports.RIPPLE_EPOCH = RIPPLE_EPOCH;
module.exports.DERIVATION_PATH = DERIVATION_PATH;
