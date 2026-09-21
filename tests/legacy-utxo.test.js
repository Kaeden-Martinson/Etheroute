/**
 * Bitcoin Cash and Dogecoin: the legacy-UTXO wallet service.
 *
 * Keys and addresses (CashAddr, Dogecoin's base58), the hand-built
 * transaction with its two signing digests, the OP_RETURN memo, and the
 * explorer shapes it reads - all without the network.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');

const chains = require('../src/config/chains');
const { walletServiceFor, balanceKeyFor } = require('../src/services/wallets');
const { LegacyUtxoWalletService, createLegacyUtxoWalletService, cashaddrEncode, cashaddrDecode, derSignature } = require('../src/services/wallets/LegacyUtxoWalletService');
const { validateCryptoAddress } = require('../src/utils/validators');
const ProxyService = require('../src/services/ProxyService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SPEC_LEGACY = '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu';
const SPEC_CASH = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

const bch = createLegacyUtxoWalletService('BCH');
const doge = createLegacyUtxoWalletService('DOGE');

describe('The registry and the family map', () => {
  test('Bitcoin Cash and Dogecoin are UTXO chains with their own explorers and both cross-chain routes', () => {
    for (const code of ['BCH', 'DOGE']) {
      const chain = chains.get(code);
      assert.strictEqual(chain.family, 'utxo');
      assert.ok(['haskoin', 'blockcypher'].includes(chain.explorerKind), code);
      assert.strictEqual(chains.thorchainChain(code), code);
      assert.ok(chains.swappable(code));
      assert.deepStrictEqual(chains.crossChainProviders(code), ['thorchain', 'sideshift']);
      assert.strictEqual(chain.walletPay, false);
      assert.strictEqual(chain.decimals, 8);
    }
    assert.deepStrictEqual(chains.CODES.slice(0, 12), ['ETH', 'POL', 'BASE', 'ARB', 'OP', 'BNB', 'AVAX', 'BTC', 'LTC', 'SOL', 'BCH', 'DOGE'], 'right after the founding ten');
  });

  test('the family map hands each to the legacy service, and names its balance key', () => {
    assert.strictEqual(walletServiceFor('BCH'), bch);
    assert.strictEqual(walletServiceFor('DOGE'), doge);
    assert.notStrictEqual(walletServiceFor('BTC'), bch, 'Bitcoin keeps its own service');
    assert.strictEqual(balanceKeyFor('BCH'), 'balanceBCH');
    assert.strictEqual(balanceKeyFor('DOGE'), 'balanceDOGE');
    assert.strictEqual(balanceKeyFor('BTC'), 'balanceBTC');
    assert.strictEqual(balanceKeyFor('LTC'), 'balanceLTC');
  });
});

describe('CashAddr', () => {
  test('encodes and decodes the specification vector', () => {
    const { hash } = bitcoin.address.fromBase58Check(SPEC_LEGACY);
    assert.strictEqual(cashaddrEncode('bitcoincash', 'p2pkh', Buffer.from(hash)), SPEC_CASH);
    const decoded = cashaddrDecode(SPEC_CASH, 'bitcoincash');
    assert.strictEqual(decoded.type, 'p2pkh');
    assert.ok(Buffer.from(hash).equals(decoded.hash));
    assert.deepStrictEqual(cashaddrDecode('qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'bitcoincash'), decoded, 'the prefix is optional');
    assert.deepStrictEqual(cashaddrDecode(SPEC_CASH.toUpperCase(), 'bitcoincash'), decoded, 'case does not matter');
  });

  test('a wrong checksum, a wrong prefix or a foreign alphabet is nothing', () => {
    assert.strictEqual(cashaddrDecode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b', 'bitcoincash'), null);
    assert.strictEqual(cashaddrDecode('bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'bitcoincash'), null);
    assert.strictEqual(cashaddrDecode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdxb1', 'bitcoincash'), null, 'b and 1 are not in the alphabet');
    assert.strictEqual(cashaddrDecode('', 'bitcoincash'), null);
  });

  test('a P2SH address carries the script-hash version', () => {
    const hash = Buffer.alloc(20, 7);
    const address = cashaddrEncode('bitcoincash', 'p2sh', hash);
    assert.match(address, /^bitcoincash:p/);
    assert.deepStrictEqual(cashaddrDecode(address, 'bitcoincash'), { type: 'p2sh', hash });
  });
});

describe('Keys and addresses', () => {
  test('the standard derivation paths, and the address the key spends from', () => {
    const b = bch.generateWalletFromMnemonic(MNEMONIC);
    assert.strictEqual(b.derivationPath, "m/44'/145'/0'/0/0");
    assert.match(b.address, /^bitcoincash:q[a-z0-9]{41}$/);
    assert.strictEqual(bch.addressFromPrivateKey(b.privateKey), b.address);
    const d = doge.generateWalletFromMnemonic(MNEMONIC);
    assert.strictEqual(d.derivationPath, "m/44'/3'/0'/0/0");
    // the published first address for this mnemonic on Dogecoin
    assert.strictEqual(d.address, 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
    assert.strictEqual(doge.addressFromPrivateKey(d.privateKey), d.address);
    assert.match(d.wif, /^Q/, "a Dogecoin WIF starts with Q");
    assert.notStrictEqual(b.privateKey, d.privateKey, 'different coin types, different keys');
  });

  test('Bitcoin Cash takes CashAddr and legacy addresses; Dogecoin its own base58; neither takes the other', () => {
    assert.strictEqual(bch.parseAddress(SPEC_LEGACY).normalized, SPEC_CASH);
    assert.strictEqual(bch.parseAddress(SPEC_CASH).type, 'p2pkh');
    assert.strictEqual(bch.parseAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'), null, 'a Dogecoin address is not a Bitcoin Cash one');
    assert.strictEqual(doge.parseAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC').type, 'p2pkh');
    assert.strictEqual(doge.parseAddress(SPEC_LEGACY), null, 'a Bitcoin address is not a Dogecoin one');
    assert.strictEqual(doge.parseAddress(SPEC_CASH), null);
    assert.strictEqual(doge.parseAddress('0x1111111111111111111111111111111111111111'), null);
    // the validators agree
    assert.ok(validateCryptoAddress(SPEC_CASH, 'BCH') && validateCryptoAddress(SPEC_LEGACY, 'BCH'));
    assert.ok(validateCryptoAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', 'DOGE'));
    assert.ok(!validateCryptoAddress(SPEC_CASH, 'DOGE'));
  });

  test('the output scripts are pay-to-pubkey-hash and pay-to-script-hash', () => {
    const { hash } = bitcoin.address.fromBase58Check(SPEC_LEGACY);
    assert.strictEqual(bch.parseAddress(SPEC_CASH).script.toString('hex'), `76a914${Buffer.from(hash).toString('hex')}88ac`);
    const p2sh = cashaddrEncode('bitcoincash', 'p2sh', Buffer.alloc(20, 7));
    assert.strictEqual(bch.parseAddress(p2sh).script.toString('hex'), `a914${'07'.repeat(20)}87`);
  });
});

describe('Signing', () => {
  const key = Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex');
  const pubkey = Buffer.from(ecc.pointFromScalar(key, true));

  test('DER encoding: minimal integers, a leading zero when the high bit is set, the hash type appended', () => {
    const r = Buffer.alloc(32, 0); r[31] = 1;
    const s = Buffer.alloc(32, 0); s[0] = 0x80;
    const der = derSignature(Buffer.concat([r, s]), 0x41);
    assert.strictEqual(der.toString('hex'), `3026020101022100${'80'.padEnd(64, '0')}41`);
    assert.strictEqual(der[der.length - 1], 0x41, 'SIGHASH_ALL | FORKID');
  });

  function utxoFor(service) {
    const address = service.addressFromPubkey(pubkey);
    return { address, utxo: { txid: 'ab'.repeat(32), vout: 1, value: 5_000_000, script: service.parseAddress(address).script } };
  }

  test('a Bitcoin Cash transaction signs the BIP143 digest with the FORKID bit, and verifies', () => {
    const { address, utxo } = utxoFor(bch);
    const built = bch.buildTransaction({
      privateKey: key.toString('hex'),
      utxos: [utxo],
      outputs: [{ script: bch.parseAddress(SPEC_CASH).script, value: 1_000_000 }],
      changeScript: bch.parseAddress(address).script,
      feeSats: 300,
      memo: '=:e:0x1111111111111111111111111111111111111111:189113/1/0',
    });
    const tx = bitcoin.Transaction.fromHex(built.hex);
    assert.strictEqual(tx.version, 2);
    assert.strictEqual(tx.ins.length, 1);
    assert.strictEqual(tx.outs.length, 3, 'recipient, change, memo');
    assert.strictEqual(Number(tx.outs[0].value), 1_000_000);
    assert.strictEqual(Number(tx.outs[1].value), 5_000_000 - 1_000_000 - 300);
    assert.strictEqual(built.change, 3_999_700);
    assert.strictEqual(Buffer.from(tx.outs[2].script)[0], 0x6a, 'the memo is last');
    assert.strictEqual(Number(tx.outs[2].value), 0);
    // the signature: <sig> <pubkey>, over the BIP143 digest with hash type 0x41
    const [sig, pub] = bitcoin.script.decompile(tx.ins[0].script);
    assert.ok(Buffer.from(pub).equals(pubkey));
    assert.strictEqual(sig[sig.length - 1], 0x41);
    const digest = Buffer.from(tx.hashForWitnessV0(0, utxo.script, BigInt(utxo.value), 0x41));
    const decoded = bitcoin.script.signature.decode(Buffer.concat([Buffer.from(sig.slice(0, -1)), Buffer.from([1])]));
    assert.ok(ecc.verify(digest, pubkey, decoded.signature), 'verifies against the forkid digest');
    const legacyDigest = Buffer.from(tx.hashForSignature(0, utxo.script, 1));
    assert.ok(!ecc.verify(legacyDigest, pubkey, decoded.signature), 'and not against the legacy one');
    assert.strictEqual(built.txid, tx.getId());
  });

  test('a Dogecoin transaction signs the legacy digest, version 1, and verifies', () => {
    const { address, utxo } = utxoFor(doge);
    const big = { ...utxo, value: 10_00000000 };
    const built = doge.buildTransaction({
      privateKey: key.toString('hex'),
      utxos: [big],
      outputs: [{ script: doge.parseAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC').script, value: 3_00000000 }],
      changeScript: doge.parseAddress(address).script,
      feeSats: 12_000_000,
    });
    const tx = bitcoin.Transaction.fromHex(built.hex);
    assert.strictEqual(tx.version, 1);
    assert.strictEqual(tx.outs.length, 2);
    const [sig, pub] = bitcoin.script.decompile(tx.ins[0].script);
    assert.ok(Buffer.from(pub).equals(pubkey));
    assert.strictEqual(sig[sig.length - 1], 0x01);
    const digest = Buffer.from(tx.hashForSignature(0, big.script, 1));
    const decoded = bitcoin.script.signature.decode(Buffer.from(sig));
    assert.ok(ecc.verify(digest, pubkey, decoded.signature));
  });

  test('change under the dust limit becomes fee; inputs short of the outputs refuse', () => {
    const { address, utxo } = utxoFor(bch);
    const built = bch.buildTransaction({ privateKey: key.toString('hex'), utxos: [utxo], outputs: [{ script: bch.parseAddress(SPEC_CASH).script, value: 4_999_500 }], changeScript: bch.parseAddress(address).script, feeSats: 300 });
    assert.strictEqual(built.change, 0);
    assert.strictEqual(bitcoin.Transaction.fromHex(built.hex).outs.length, 1);
    assert.throws(() => bch.buildTransaction({ privateKey: key.toString('hex'), utxos: [utxo], outputs: [{ script: bch.parseAddress(SPEC_CASH).script, value: 5_000_000 }], changeScript: bch.parseAddress(address).script, feeSats: 300 }), /Insufficient funds/);
  });

  test('fees: Dogecoin\'s floors are a hundred times Bitcoin\'s; the size counts a memo', () => {
    assert.strictEqual(LegacyUtxoWalletService.size(1, 2), 226);
    assert.strictEqual(LegacyUtxoWalletService.size(2, 3, 70), 478);
    assert.strictEqual(doge.spec.dustSats, 1_000_000);
    assert.strictEqual(doge.spec.minFeeSats, 1_000_000);
    assert.strictEqual(bch.spec.dustSats, 546);
    assert.ok(bch.spec.fallbackFeeRate >= 1, 'a satoshi a byte is the relay floor');
  });
});

describe('The explorers', () => {
  const stubFetch = async (fn) => {
    const original = ProxyService.fetch;
    ProxyService.fetch = async (url, init) => {
      const body = fn(String(url), init);
      if (body === 404) return { ok: false, status: 404, json: async () => null, text: async () => '' };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return () => { ProxyService.fetch = original; };
  };

  test('Haskoin: balance, unspent outputs with scripts, history with confirmations, status', async () => {
    const restore = await stubFetch((url) => {
      if (url.endsWith('/balance')) return { confirmed: 5593730321, unconfirmed: 100 };
      if (url.includes('/unspent')) return [{ txid: 'aa'.repeat(32), index: 0, value: 10699462, pkscript: '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac', block: { height: 961549 } }];
      if (url.includes('/block/best')) return { height: 969410 };
      if (url.includes('/transactions/full')) return [{ txid: 'aa'.repeat(32), time: 1785230352, fee: 528, block: { height: 961549 }, inputs: [{ address: 'bitcoincash:qzhfp027fncvmnguc5ue6h5rflmda5ptcu33duxphz', value: 326105 }], outputs: [{ address: SPEC_CASH, value: 10699462 }] }];
      if (url.includes('/transaction/')) return url.includes('cc'.repeat(32)) ? 404 : (url.includes('bb'.repeat(32)) ? { txid: 'bb'.repeat(32), block: { mempool: 1 } } : { txid: 'aa'.repeat(32), block: { height: 961549 } });
      return 404;
    });
    try {
      const balance = await bch.getBalance(SPEC_CASH);
      assert.strictEqual(balance.status, 'success');
      assert.strictEqual(balance.balanceBCH, 55.93730421);
      const utxos = await bch.getUtxos(SPEC_LEGACY);
      assert.strictEqual(utxos[0].value, 10699462);
      assert.strictEqual(utxos[0].script.toString('hex'), '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac');
      const history = await bch.getTransactionHistory(SPEC_CASH);
      assert.strictEqual(history.transactions[0].confirmations, 969410 - 961549 + 1);
      assert.strictEqual(history.transactions[0].outputs[0].value, 0.10699462);
      assert.strictEqual(history.transactions[0].time, 1785230352);
      assert.deepStrictEqual(await bch.getTransactionStatus('aa'.repeat(32)), { status: 'settled', confirmations: 7862, blockHeight: 961549 });
      assert.deepStrictEqual(await bch.getTransactionStatus('bb'.repeat(32)), { status: 'waiting', confirmations: 0, blockHeight: null });
      assert.deepStrictEqual(await bch.getTransactionStatus('cc'.repeat(32)), { status: 'not_found', confirmations: 0, blockHeight: null });
    } finally {
      restore();
    }
  });

  test('BlockCypher: balance, unspent outputs, the fee from the chain, history, status', async () => {
    const restore = await stubFetch((url) => {
      if (url.endsWith('/balance')) return { final_balance: 250000000 };
      if (url.includes('unspentOnly')) return { txrefs: [{ tx_hash: 'cd'.repeat(32), tx_output_n: 1, value: 250000000, script: '76a914' + '11'.repeat(20) + '88ac', confirmations: 12 }] };
      if (url.includes('/txs/push')) return { tx: { hash: 'ef'.repeat(32) } };
      if (url.includes('/txs/')) return { hash: 'cd'.repeat(32), block_height: 6382000, confirmations: 40 };
      if (url.includes('/full')) return { txs: [{ hash: 'cd'.repeat(32), confirmed: '2026-09-21T01:00:00Z', block_height: 6382000, confirmations: 40, fees: 12000000, inputs: [{ addresses: ['DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'], output_value: 300000000 }], outputs: [{ addresses: ['DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD'], value: 250000000 }] }] };
      if (url.endsWith('/main')) return { height: 6382885, medium_fee_per_kb: 52967000 };
      return 404;
    });
    try {
      const balance = await doge.getBalance('DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD');
      assert.strictEqual(balance.balanceDOGE, 2.5);
      const utxos = await doge.getUtxos('DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD');
      assert.strictEqual(utxos[0].vout, 1);
      assert.strictEqual(await doge.estimateFeeRate(), 52967);
      assert.strictEqual(await doge.estimateFee(), 52967 * 226);
      const history = await doge.getTransactionHistory('DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD');
      assert.strictEqual(history.transactions[0].inputs[0].address, 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
      assert.strictEqual(history.transactions[0].outputs[0].value, 2.5);
      assert.strictEqual(history.transactions[0].confirmations, 40);
      assert.deepStrictEqual(await doge.getTransactionStatus('cd'.repeat(32)), { status: 'settled', confirmations: 40, blockHeight: 6382000 });
      assert.strictEqual(await doge.broadcastRawTransaction('0100'), 'ef'.repeat(32));
    } finally {
      restore();
    }
  });

  test('a rate limit is reported as such, not as an empty wallet', async () => {
    const original = ProxyService.fetch;
    ProxyService.fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' });
    try {
      const balance = await bch.getBalance(SPEC_CASH);
      assert.strictEqual(balance.status, 'rate_limited');
      assert.strictEqual(balance.balanceBCH, 0);
    } finally {
      ProxyService.fetch = original;
    }
  });
});

describe('Wired into the rest', () => {
  test('checkout matches any UTXO chain the same way and builds the payment URI', () => {
    const source = read('src/routes/checkout.js');
    assert.ok(source.includes("(family(session.chain) === 'utxo' ? 'UTXO' : session.chain)"));
    assert.ok(source.includes("case 'UTXO': {"));
    assert.ok(source.includes("if (family(chain) === 'utxo') {"), 'confirmations count the same way');
    assert.ok(source.includes("case 'BCH':"));
    assert.ok(source.includes("`bitcoincash:${walletAddress}`"));
    assert.ok(source.includes("case 'DOGE':\n      return `dogecoin:${walletAddress}?amount=${nativeAmount}`;"));
  });

  test('a transfer\'s status and the health probe go through the service that knows the explorer', () => {
    const status = read('src/services/ChainTxStatus.js');
    assert.ok(status.includes("if (typeof service.getTransactionStatus !== 'function') throw new Error(`No status lookup for ${chain}`);"));
    const health = read('src/services/ChainHealthService.js');
    assert.ok(health.includes("if (chain.explorerKind && chain.explorerKind !== 'mempool') {"));
    assert.ok(health.includes('tip = await withTimeout(service.getTipHeight()'));
    const dash = read('public/js/dashboard.js');
    assert.ok(dash.includes("BCH: { placeholder: 'bitcoincash:q… or 1…'"));
    assert.ok(dash.includes("DOGE: { placeholder: 'D…'"));
  });

  test('the pages count and name them', () => {
    const help = read('public/js/help-content.js');
    assert.ok(help.includes('plus Bitcoin, Litecoin, Bitcoin Cash, Dogecoin, Solana and the XRP Ledger'));
    const faq = read('public/faq.html');
    assert.ok(faq.includes('<strong>Bitcoin Cash (BCH)</strong> and <strong>Dogecoin (DOGE)</strong>'));
    const docs = read('public/js/docs-content.js');
    assert.ok(docs.includes("['Bitcoin Cash', 'BCH', 'BCH', '\\u2014', '\\u2014', '~10 minutes (1 block)']"));
    assert.ok(docs.includes("['Dogecoin', 'DOGE', 'DOGE', '\\u2014', '\\u2014', '~2 minutes (2 blocks)']"));
    const spec = read('public/js/api-spec.js');
    assert.ok(spec.includes("['BCH', 'BCH', 'UTXO', '1', '\\u2014', 'no', 'THORChain + SideShift', '\\u2014']"));
    assert.ok(spec.includes("id: 'status-chains', method: 'GET', path: '/status/chains'"));
  });
});
