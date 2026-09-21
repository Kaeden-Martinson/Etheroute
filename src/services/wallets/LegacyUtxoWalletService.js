/**
 * Wallet service for the UTXO chains without a mempool.space-style explorer
 * and without segwit: Bitcoin Cash and Dogecoin, parameterised by a spec.
 *
 * Both are Bitcoin's transaction format with pay-to-pubkey-hash outputs and
 * no witness. They differ in what an address looks like (CashAddr on
 * Bitcoin Cash, base58 with its own version bytes on Dogecoin), in how an
 * input is signed (Bitcoin Cash signs the BIP143 digest with a FORKID bit;
 * Dogecoin the original digest), in fees, and in which explorer answers
 * for them (Haskoin for Bitcoin Cash, BlockCypher for Dogecoin). Everything
 * else - keys, coin selection, change, the OP_RETURN memo a swap network
 * asks for - is one implementation.
 *
 * The transaction is built and signed by hand here rather than through the
 * PSBT machinery: a PSBT wants the whole previous transaction for a legacy
 * input, which these explorers do not hand out cheaply, and cannot sign
 * Bitcoin Cash's digest at all. The explorers give each unspent output's
 * script and value, which is all a signature needs.
 *
 * The shape the rest of the app expects is the one BitcoinWalletService and
 * LitecoinWalletService keep: `getBalance` reports `balance<CODE>`,
 * `createWallet` seals keys through the vault, `sendTransaction` takes a
 * decimal amount and returns the txid.
 */
const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../../config/database');
const chains = require('../../config/chains');
const KeyVault = require('../crypto/KeyVault');
const ProxyService = require('../ProxyService');

const bip32 = BIP32Factory(ecc);

const SATS = 100000000;

// Bitcoin Cash's SIGHASH_ALL carries the FORKID bit: the digest is BIP143's
// and the hash type byte is 0x41.
const SIGHASH_FORKID = 0x40;

// ── CashAddr ────────────────────────────────────────────────────────────────
// The address format Bitcoin Cash uses: a prefix, a colon, and base32 over
// a version byte, the hash and a 40-bit checksum. Written out here rather
// than pulled in, because it is forty lines and a dependency is a supply
// chain.
const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function cashaddrPolymod(values) {
  const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i += 1) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i];
  }
  return c ^ 1n;
}

function prefixToValues(prefix) {
  return [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f).concat([0]);
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('invalid padding');
  }
  return out;
}

/** hash160 + type ('p2pkh' | 'p2sh') -> "prefix:q..." */
function cashaddrEncode(prefix, type, hash) {
  const versionByte = (type === 'p2sh' ? 8 : 0) | 0; // 160-bit hashes: size bits 0
  const payload = convertBits([versionByte, ...hash], 8, 5, true);
  const checksumInput = [...prefixToValues(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = cashaddrPolymod(checksumInput);
  const checksum = [];
  for (let i = 0; i < 8; i += 1) checksum.push(Number((polymod >> BigInt(5 * (7 - i))) & 0x1fn));
  return `${prefix}:${[...payload, ...checksum].map((v) => CASHADDR_CHARSET[v]).join('')}`;
}

/** "prefix:q..." (prefix optional) -> { type, hash } or null */
function cashaddrDecode(address, expectedPrefix) {
  const lower = String(address || '').toLowerCase();
  const [prefix, body] = lower.includes(':') ? lower.split(':') : [expectedPrefix, lower];
  if (prefix !== expectedPrefix || !body || body.length < 42) return null;
  const values = [];
  for (const ch of body) {
    const v = CASHADDR_CHARSET.indexOf(ch);
    if (v === -1) return null;
    values.push(v);
  }
  if (cashaddrPolymod([...prefixToValues(prefix), ...values]) !== 0n) return null;
  let data;
  try {
    data = convertBits(values.slice(0, -8), 5, 8, false);
  } catch {
    return null;
  }
  const version = data[0];
  const hash = Buffer.from(data.slice(1));
  if ((version & 0x07) !== 0 || hash.length !== 20) return null;
  return { type: (version & 0x78) === 8 ? 'p2sh' : 'p2pkh', hash };
}

// ── DER ─────────────────────────────────────────────────────────────────────
/** A 64-byte (r, s) signature as DER, with the hash type byte appended. */
function derSignature(sig64, hashType) {
  const toDer = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
    let body = Buffer.from(bytes.slice(i));
    if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const r = toDer(sig64.slice(0, 32));
  const s = toDer(sig64.slice(32, 64));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s, Buffer.from([hashType])]);
}

// ── the specs ───────────────────────────────────────────────────────────────
const SPECS = {
  BCH: {
    name: 'Bitcoin Cash',
    network: { ...bitcoin.networks.bitcoin, messagePrefix: '\x18Bitcoin Cash Signed Message:\n' },
    derivation: "m/44'/145'/0'/0/0",
    address: 'cashaddr',
    cashaddrPrefix: 'bitcoincash',
    sighash: 'forkid',
    txVersion: 2,
    dustSats: 546,
    minFeeSats: 300,
    // 1 sat/byte is the relay floor; a shade over clears it with rounding.
    fallbackFeeRate: 1.1,
    explorer: 'haskoin',
    explorerBase: 'https://api.haskoin.com/bch',
    rpc: 'https://bch-mainnet.gateway.tatum.io',
  },
  DOGE: {
    name: 'Dogecoin',
    network: {
      messagePrefix: '\x19Dogecoin Signed Message:\n',
      bech32: undefined,
      bip32: { public: 0x02facafd, private: 0x02fac398 },
      pubKeyHash: 0x1e,
      scriptHash: 0x16,
      wif: 0x9e,
    },
    derivation: "m/44'/3'/0'/0/0",
    address: 'base58',
    sighash: 'legacy',
    txVersion: 1,
    // Dogecoin's dust and fee floors are a hundred times Bitcoin's: 0.01 DOGE
    // per kilobyte is the recommended fee and the dust limit alike.
    dustSats: 1_000_000,
    minFeeSats: 1_000_000,
    fallbackFeeRate: 1000,
    explorer: 'blockcypher',
    explorerBase: 'https://api.blockcypher.com/v1/doge/main',
    rpc: 'https://dogecoin-mainnet.gateway.tatum.io',
  },
};

class LegacyUtxoWalletService {
  constructor(code) {
    const spec = SPECS[code];
    if (!spec) throw new Error(`No legacy UTXO spec for ${code}`);
    this.code = code;
    this.chain = chains.get(code);
    this.spec = spec;
    this.tag = `[${spec.name.replace(/\s/g, '')}WalletService]`;
    this.balanceKey = `balance${code}`;
    // BlockCypher's free tier is three requests a second and a few hundred an
    // hour by address; a token (free to register) lifts that.
    this.blockcypherToken = process.env.BLOCKCYPHER_TOKEN || '';
  }

  // ── keys and addresses ────────────────────────────────────────────────

  generateWalletFromMnemonic(mnemonic = null) {
    try {
      if (!mnemonic) mnemonic = bip39.generateMnemonic();
      else if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid BIP39 mnemonic');
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const root = bip32.fromSeed(seed, this.spec.network);
      const derived = root.derivePath(this.spec.derivation);
      const pubkey = Buffer.from(derived.publicKey);
      return {
        address: this.addressFromPubkey(pubkey),
        publicKey: pubkey.toString('hex'),
        privateKey: Buffer.from(derived.privateKey).toString('hex'),
        wif: derived.toWIF(),
        mnemonic,
        derivationPath: this.spec.derivation,
        network: 'mainnet',
        networkName: `${this.spec.name} Mainnet`,
      };
    } catch (error) {
      throw new Error(`Failed to generate ${this.spec.name} wallet: ${error.message}`);
    }
  }

  addressFromPubkey(pubkey) {
    const hash = Buffer.from(bitcoin.crypto.hash160(pubkey));
    if (this.spec.address === 'cashaddr') return cashaddrEncode(this.spec.cashaddrPrefix, 'p2pkh', hash);
    return bitcoin.address.toBase58Check(hash, this.spec.network.pubKeyHash);
  }

  /** The address the private key spends from. */
  addressFromPrivateKey(privateKeyHex) {
    return this.addressFromPubkey(Buffer.from(ecc.pointFromScalar(Buffer.from(privateKeyHex, 'hex'), true)));
  }

  /**
   * An address as its output script and type: CashAddr or legacy base58 on
   * Bitcoin Cash; base58 with Dogecoin's version bytes on Dogecoin. Null
   * when it is not one of ours.
   */
  parseAddress(address) {
    const text = String(address || '').trim();
    if (this.spec.address === 'cashaddr') {
      const decoded = cashaddrDecode(text, this.spec.cashaddrPrefix);
      if (decoded) return { ...decoded, script: this.scriptFor(decoded.type, decoded.hash), normalized: cashaddrEncode(this.spec.cashaddrPrefix, decoded.type, decoded.hash) };
    }
    try {
      const { version, hash } = bitcoin.address.fromBase58Check(text);
      const h = Buffer.from(hash);
      if (version === this.spec.network.pubKeyHash) return { type: 'p2pkh', hash: h, script: this.scriptFor('p2pkh', h), normalized: this.spec.address === 'cashaddr' ? cashaddrEncode(this.spec.cashaddrPrefix, 'p2pkh', h) : text };
      if (version === this.spec.network.scriptHash) return { type: 'p2sh', hash: h, script: this.scriptFor('p2sh', h), normalized: this.spec.address === 'cashaddr' ? cashaddrEncode(this.spec.cashaddrPrefix, 'p2sh', h) : text };
    } catch { /* not base58 of ours */ }
    return null;
  }

  scriptFor(type, hash) {
    return Buffer.from(type === 'p2sh' ? bitcoin.payments.p2sh({ hash }).output : bitcoin.payments.p2pkh({ hash }).output);
  }

  validateAddress(address) {
    return this.parseAddress(address) !== null;
  }

  createWallet(clientId, mnemonic = null) {
    try {
      const data = this.generateWalletFromMnemonic(mnemonic);
      const wallet = {
        id: uuidv4(),
        clientId,
        address: data.address,
        chain: this.code,
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
      throw new Error(`Failed to create ${this.spec.name} wallet: ${error.message}`);
    }
  }

  // ── the explorer ──────────────────────────────────────────────────────

  explorerUrl(path) {
    const base = `${this.spec.explorerBase}${path}`;
    if (this.spec.explorer === 'blockcypher' && this.blockcypherToken) {
      return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.blockcypherToken)}`;
    }
    return base;
  }

  async getJson(path, init) {
    const response = await ProxyService.fetch(this.explorerUrl(path), init);
    if (response.status === 429) {
      const error = new Error('explorer rate limit');
      error.rateLimited = true;
      throw error;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`explorer HTTP ${response.status}`);
    return response.json();
  }

  /** The address in the form the explorer indexes it. */
  explorerAddress(address) {
    const parsed = this.parseAddress(address);
    return parsed ? parsed.normalized : address;
  }

  async getBalance(address) {
    try {
      const parsed = this.parseAddress(address);
      if (!parsed) throw new Error('Invalid address format');
      let sats;
      if (this.spec.explorer === 'haskoin') {
        const data = await this.getJson(`/address/${parsed.normalized}/balance`);
        sats = data ? Number(data.confirmed || 0) + Number(data.unconfirmed || 0) : 0;
      } else {
        const data = await this.getJson(`/addrs/${parsed.normalized}/balance`);
        sats = data ? Number(data.final_balance || 0) : 0;
      }
      return {
        address,
        balanceSatoshis: sats,
        [this.balanceKey]: sats / SATS,
        network: 'mainnet',
        timestamp: new Date().toISOString(),
        status: 'success',
      };
    } catch (error) {
      return { address, [this.balanceKey]: 0, network: 'mainnet', status: error.rateLimited ? 'rate_limited' : 'error', error: error.message, timestamp: new Date().toISOString() };
    }
  }

  async updateBalance(wallet, usdRate) {
    try {
      const info = await this.getBalance(wallet.address);
      if (info.status === 'success') {
        db.update('wallets', wallet.id, {
          balance: info[this.balanceKey],
          balanceUSD: info[this.balanceKey] * usdRate,
          lastUpdated: new Date().toISOString(),
        });
        info.balance = info[this.balanceKey] * usdRate;
      }
      return info;
    } catch (error) {
      console.error(`${this.tag} Error updating balance for ${wallet.address}:`, error.message);
      return { address: wallet.address, status: 'error', error: error.message };
    }
  }

  /** Unspent outputs: txid, vout, value in sats, and the script that locks them. */
  async getUtxos(address) {
    const parsed = this.parseAddress(address);
    if (!parsed) throw new Error('Invalid address format');
    if (this.spec.explorer === 'haskoin') {
      const list = await this.getJson(`/address/${parsed.normalized}/unspent?limit=500`);
      return (list || []).map((u) => ({ txid: u.txid, vout: u.index, value: Number(u.value), script: Buffer.from(u.pkscript, 'hex'), confirmed: Boolean(u.block && u.block.height) }));
    }
    const data = await this.getJson(`/addrs/${parsed.normalized}?unspentOnly=true&includeScript=true&limit=500`);
    const refs = [...((data && data.txrefs) || []), ...((data && data.unconfirmed_txrefs) || [])];
    return refs.map((u) => ({ txid: u.tx_hash, vout: u.tx_output_n, value: Number(u.value), script: u.script ? Buffer.from(u.script, 'hex') : parsed.script, confirmed: (u.confirmations || 0) > 0 }));
  }

  /**
   * Recent transactions touching an address, in the shape checkout matches
   * against: inputs and outputs with addresses and decimal values, a time,
   * and confirmations.
   */
  async getTransactionHistory(address, limit = 10) {
    try {
      const parsed = this.parseAddress(address);
      if (!parsed) return { address, network: 'mainnet', status: 'error', error: 'Invalid address format' };
      const tip = await this.getTipHeight();
      let transactions;
      if (this.spec.explorer === 'haskoin') {
        const list = await this.getJson(`/address/${parsed.normalized}/transactions/full?limit=${limit}`);
        transactions = (list || []).map((tx) => {
          const height = tx.block && tx.block.height;
          return {
            hash: tx.txid,
            time: tx.time || 0,
            blockHeight: height || null,
            confirmations: height && tip ? tip - height + 1 : 0,
            fee: (tx.fee || 0) / SATS,
            inputs: (tx.inputs || []).map((i) => ({ address: this.canonical(i.address), value: (i.value || 0) / SATS })),
            outputs: (tx.outputs || []).map((o) => ({ address: this.canonical(o.address), value: (o.value || 0) / SATS })),
          };
        });
      } else {
        const data = await this.getJson(`/addrs/${parsed.normalized}/full?limit=${limit}`);
        transactions = ((data && data.txs) || []).map((tx) => ({
          hash: tx.hash,
          time: tx.confirmed ? Math.floor(new Date(tx.confirmed).getTime() / 1000) : (tx.received ? Math.floor(new Date(tx.received).getTime() / 1000) : 0),
          blockHeight: tx.block_height > 0 ? tx.block_height : null,
          confirmations: tx.confirmations || 0,
          fee: (tx.fees || 0) / SATS,
          inputs: (tx.inputs || []).flatMap((i) => (i.addresses || []).map((a) => ({ address: a, value: (i.output_value || 0) / SATS }))),
          outputs: (tx.outputs || []).flatMap((o) => (o.addresses || []).map((a) => ({ address: a, value: (o.value || 0) / SATS }))),
        }));
      }
      return { address, transactionCount: transactions.length, network: 'mainnet', transactions, timestamp: new Date().toISOString() };
    } catch (error) {
      return { address, network: 'mainnet', status: error.rateLimited ? 'rate_limited' : 'error', error: error.message, transactions: [] };
    }
  }

  /** An address the way we write it, so a buyer's and the explorer's compare. */
  canonical(address) {
    if (!address) return null;
    const parsed = this.parseAddress(address);
    return parsed ? parsed.normalized : address;
  }

  /** Where a broadcast transaction stands: not_found, waiting, settled. */
  async getTransactionStatus(txid) {
    if (this.spec.explorer === 'haskoin') {
      const tx = await this.getJson(`/transaction/${txid}`);
      if (!tx) return { status: 'not_found', confirmations: 0, blockHeight: null };
      const height = tx.block && tx.block.height;
      if (!height) return { status: 'waiting', confirmations: 0, blockHeight: null };
      const tip = await this.getTipHeight();
      return { status: 'settled', confirmations: tip ? tip - height + 1 : 1, blockHeight: height };
    }
    const tx = await this.getJson(`/txs/${txid}`);
    if (!tx) return { status: 'not_found', confirmations: 0, blockHeight: null };
    if (!(tx.block_height > 0)) return { status: 'waiting', confirmations: 0, blockHeight: null };
    return { status: 'settled', confirmations: tx.confirmations || 1, blockHeight: tx.block_height };
  }

  async getTipHeight() {
    try {
      if (this.spec.explorer === 'haskoin') {
        const best = await this.getJson('/block/best?notx=true');
        return best ? Number(best.height) : null;
      }
      const info = await this.getJson('');
      return info ? Number(info.height) : null;
    } catch (error) {
      return null;
    }
  }

  // ── fees ──────────────────────────────────────────────────────────────

  /** Satoshis per byte: the explorer's medium rate on Dogecoin, the flat floor on Bitcoin Cash. */
  async estimateFeeRate() {
    if (this.spec.explorer === 'blockcypher') {
      try {
        const info = await this.getJson('');
        const perKb = info && Number(info.medium_fee_per_kb);
        if (perKb > 0) return Math.max(this.spec.fallbackFeeRate, Math.ceil(perKb / 1000));
      } catch { /* the floor */ }
    }
    return this.spec.fallbackFeeRate;
  }

  /** Bytes a transaction with these inputs and outputs takes, legacy P2PKH. */
  static size(inputCount, outputCount, memoBytes = 0) {
    return 10 + 148 * inputCount + 34 * outputCount + memoBytes;
  }

  /** The fee for a typical one-in two-out send, in satoshis. */
  async estimateFee() {
    const rate = await this.estimateFeeRate();
    return Math.max(Math.ceil(rate * LegacyUtxoWalletService.size(1, 2)), this.spec.minFeeSats);
  }

  static opReturnScript(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (bytes.length > 80) throw new Error(`OP_RETURN data is ${bytes.length} bytes; 80 is the most a node relays`);
    const push = bytes.length <= 75 ? Buffer.from([bytes.length]) : Buffer.from([0x4c, bytes.length]);
    return Buffer.concat([Buffer.from([0x6a]), push, bytes]);
  }

  // ── sending ───────────────────────────────────────────────────────────

  /** The digest an input signs, per chain, and the hash type byte that goes with it. */
  sighash(tx, index, script, valueSats) {
    if (this.spec.sighash === 'forkid') {
      const hashType = bitcoin.Transaction.SIGHASH_ALL | SIGHASH_FORKID;
      return { hash: Buffer.from(tx.hashForWitnessV0(index, script, BigInt(valueSats), hashType)), hashType };
    }
    const hashType = bitcoin.Transaction.SIGHASH_ALL;
    return { hash: Buffer.from(tx.hashForSignature(index, script, hashType)), hashType };
  }

  /**
   * Build and sign a transaction spending `utxos` to `outputs`, with change
   * to `changeScript`. Pure: no network. Returns the hex and the id.
   */
  buildTransaction({ privateKey, utxos, outputs, changeScript, feeSats, memo = null }) {
    const key = Buffer.from(privateKey, 'hex');
    const pubkey = Buffer.from(ecc.pointFromScalar(key, true));
    const tx = new bitcoin.Transaction();
    tx.version = this.spec.txVersion;
    for (const utxo of utxos) tx.addInput(Buffer.from(utxo.txid, 'hex').reverse(), utxo.vout, 0xffffffff);
    const inputSum = utxos.reduce((sum, u) => sum + u.value, 0);
    const outputSum = outputs.reduce((sum, o) => sum + o.value, 0);
    let change = inputSum - outputSum - feeSats;
    if (change < 0) throw new Error(`Insufficient funds: inputs ${inputSum} < outputs ${outputSum} + fee ${feeSats}`);
    for (const output of outputs) tx.addOutput(output.script, BigInt(output.value));
    if (change >= this.spec.dustSats) tx.addOutput(changeScript, BigInt(change));
    else change = 0;
    if (memo) tx.addOutput(LegacyUtxoWalletService.opReturnScript(memo), 0n);
    utxos.forEach((utxo, i) => {
      const { hash, hashType } = this.sighash(tx, i, utxo.script, utxo.value);
      const signature = derSignature(Buffer.from(ecc.sign(hash, key)), hashType);
      tx.setInputScript(i, bitcoin.script.compile([signature, pubkey]));
    });
    return { hex: tx.toHex(), txid: tx.getId(), change, size: tx.byteLength() };
  }

  /**
   * Send `amount` (decimal) to `toAddress`. `options.memo` adds an OP_RETURN
   * output after the recipient and the change, as a swap network asks.
   */
  async sendTransaction(privateKey, toAddress, amount, options = {}) {
    try {
      const recipient = this.parseAddress(toAddress);
      if (!recipient) throw new Error(`Invalid ${this.spec.name} address: ${toAddress}`);
      const amountSats = Math.round(Number(amount) * SATS);
      if (!(amountSats > 0)) throw new Error(`Invalid amount: ${amount}`);
      if (amountSats < this.spec.dustSats) throw new Error(`${amount} ${this.code} is below the dust limit of ${this.spec.dustSats / SATS}`);
      const memo = options && options.memo ? String(options.memo) : null;
      const memoBytes = memo ? 9 + LegacyUtxoWalletService.opReturnScript(memo).length : 0;

      const from = this.addressFromPrivateKey(privateKey);
      const utxos = (await this.getUtxos(from)).sort((a, b) => b.value - a.value);
      if (utxos.length === 0) throw new Error('No unspent outputs (UTXOs) available');
      const feeRate = await this.estimateFeeRate();

      // Select largest-first until the inputs cover the amount and the fee
      // for the transaction as it then stands.
      const selected = [];
      let total = 0;
      let feeSats = 0;
      for (const utxo of utxos) {
        selected.push(utxo);
        total += utxo.value;
        feeSats = Math.max(Math.ceil(feeRate * LegacyUtxoWalletService.size(selected.length, 2, memoBytes)), this.spec.minFeeSats);
        if (total >= amountSats + feeSats) break;
      }
      if (total < amountSats + feeSats) throw new Error(`Insufficient funds: need ${amountSats + feeSats} satoshis, have ${total}`);

      const built = this.buildTransaction({
        privateKey,
        utxos: selected,
        outputs: [{ script: recipient.script, value: amountSats }],
        changeScript: this.parseAddress(from).script,
        feeSats,
        memo,
      });
      console.log(`${this.tag} ${selected.length} input(s), fee ${feeSats} sats at ${feeRate} sat/B, change ${built.change} sats, ${built.size} bytes`);
      const txid = await this.broadcastRawTransaction(built.hex);
      console.log(`${this.tag} Transaction sent: ${txid}`);
      return txid;
    } catch (error) {
      throw new Error(`Failed to send ${this.spec.name} transaction: ${error.message}`);
    }
  }

  /** The explorer first, the node gateway second; a rejection is final. */
  async broadcastRawTransaction(hex) {
    const failures = [];
    const attempts = [
      async () => {
        if (this.spec.explorer === 'haskoin') {
          const response = await ProxyService.fetch(this.explorerUrl('/transactions'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: hex });
          const text = await response.text();
          if (!response.ok) throw Object.assign(new Error(`explorer HTTP ${response.status}: ${text.slice(0, 160)}`), { rejected: /reject|invalid|dust|fee|missing|spent/i.test(text) });
          const data = JSON.parse(text);
          return data.txid;
        }
        const response = await ProxyService.fetch(this.explorerUrl('/txs/push'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx: hex }) });
        const data = await response.json();
        if (!response.ok || !data.tx) throw Object.assign(new Error(`explorer: ${(data && data.error) || `HTTP ${response.status}`}`), { rejected: /reject|invalid|dust|fee|missing|spent/i.test(JSON.stringify(data)) });
        return data.tx.hash;
      },
      async () => {
        const response = await ProxyService.fetch(this.spec.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendrawtransaction', params: [hex] }) });
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw Object.assign(new Error(data.error.message || JSON.stringify(data.error)), { rejected: [-25, -26, -27].includes(data.error.code) });
        return data.result;
      },
    ];
    for (const attempt of attempts) {
      try {
        const txid = await attempt();
        if (txid) return txid;
        failures.push('no txid returned');
      } catch (error) {
        if (error.rejected) throw new Error(`Transaction rejected by the network: ${error.message}`);
        failures.push(error.message);
        console.warn(`${this.tag} Broadcast failed, trying next: ${error.message}`);
      }
    }
    throw new Error(`Failed to broadcast transaction on every endpoint: ${failures.join(' | ')}`);
  }
}

const instances = new Map();

function createLegacyUtxoWalletService(code) {
  if (!instances.has(code)) instances.set(code, new LegacyUtxoWalletService(code));
  return instances.get(code);
}

module.exports = { LegacyUtxoWalletService, createLegacyUtxoWalletService, SPECS, cashaddrEncode, cashaddrDecode, derSignature };
