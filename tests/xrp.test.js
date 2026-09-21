/**
 * The XRP Ledger: its own family. Keys, the reserve a sweep leaves, the
 * payment with its memo and destination tag, the ledger's answers, and the
 * seams the rest of the app reads it through.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const xrpl = require('xrpl');

const chains = require('../src/config/chains');
const Xrp = require('../src/services/wallets/XrpWalletService');
const { walletServiceFor, balanceKeyFor } = require('../src/services/wallets');
const { validateCryptoAddress } = require('../src/utils/validators');
const ProxyService = require('../src/services/ProxyService');
const SwapService = require('../src/services/SwapService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3';
const OTHER = 'rHcWmKpDf4GJiJjuCyXfTwCMqhWsjzecN9';

let originalFetch;
afterEach(() => { if (originalFetch) { ProxyService.fetch = originalFetch; originalFetch = null; } });

/** rippled as it answers, by method. */
function rippled(answers) {
  originalFetch = ProxyService.fetch;
  const calls = [];
  ProxyService.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answer = answers[body.method];
    const result = typeof answer === 'function' ? answer(body.params[0]) : answer;
    return { ok: true, status: 200, json: async () => ({ result: result || { status: 'error', error: 'unknownCmd' } }) };
  };
  return calls;
}

describe('The registry and the family', () => {
  test('XRP is its own family with a reserve, a ledger of four seconds, and both cross-chain routes', () => {
    const chain = chains.get('XRP');
    assert.strictEqual(chain.family, 'xrp');
    assert.strictEqual(chain.decimals, 6);
    assert.strictEqual(chain.minReserveNative, 1, 'the account reserve');
    assert.strictEqual(chain.confirmations, 1, 'validation is final');
    assert.strictEqual(chains.thorchainChain('XRP'), 'XRP');
    assert.deepStrictEqual(chain.sideshift, { coin: 'xrp', network: 'ripple' });
    assert.strictEqual(walletServiceFor('XRP'), Xrp);
    assert.strictEqual(balanceKeyFor('XRP'), 'balanceXRP');
    assert.strictEqual(SwapService.MIN_RESERVE_NATIVE.XRP, 1, 'the plan keeps the reserve back');
  });

  test('keys: the standard path gives the published address; the signing wallet is rebuilt from the record', () => {
    const w = Xrp.generateWalletFromMnemonic(MNEMONIC);
    assert.strictEqual(w.address, VECTOR);
    assert.strictEqual(w.derivationPath, "m/44'/144'/0'/0/0");
    assert.strictEqual(Xrp.walletFrom(w.privateKey, w.publicKey).classicAddress, VECTOR);
    assert.strictEqual(Xrp.walletFrom(w.privateKey, null, MNEMONIC).classicAddress, VECTOR);
    assert.throws(() => Xrp.walletFrom(w.privateKey), /needs its public key or its seed phrase/);
    assert.ok(Xrp.validateAddress(VECTOR) && validateCryptoAddress(VECTOR, 'XRP'));
    assert.ok(!validateCryptoAddress('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v4', 'XRP'), 'a checksum, not just a shape');
    assert.ok(!validateCryptoAddress('0x1111111111111111111111111111111111111111', 'XRP'));
  });
});

describe('The ledger', () => {
  test('a balance, an account nobody has funded yet, and the endpoint failover', async () => {
    const calls = rippled({ account_info: ({ account }) => (account === VECTOR ? { status: 'success', account_data: { Balance: '2268996827' } } : { status: 'error', error: 'actNotFound', error_message: 'Account not found.' }) });
    const funded = await Xrp.getBalance(VECTOR);
    assert.strictEqual(funded.balanceXRP, 2268.996827);
    assert.strictEqual(funded.status, 'success');
    const empty = await Xrp.getBalance(OTHER);
    assert.strictEqual(empty.balanceXRP, 0);
    assert.strictEqual(empty.status, 'success', 'unfunded is zero, not an error');
    assert.strictEqual(calls.length, 2, 'a ledger answer is final: no second endpoint tried');
  });

  test('history: payments only, delivered amounts, ripple-epoch dates, validation', async () => {
    rippled({
      account_tx: {
        status: 'success',
        transactions: [
          { validated: true, meta: { delivered_amount: '10', TransactionResult: 'tesSUCCESS' }, tx: { TransactionType: 'Payment', Account: OTHER, Destination: VECTOR, Amount: '10', date: 842283740, hash: 'FB1B', ledger_index: 106870623 } },
          { validated: true, meta: { TransactionResult: 'tesSUCCESS' }, tx: { TransactionType: 'TrustSet', Account: VECTOR, hash: 'TRUST' } },
          { validated: true, meta: { delivered_amount: '5000000', TransactionResult: 'tecPATH_DRY' }, tx: { TransactionType: 'Payment', Account: OTHER, Destination: VECTOR, DestinationTag: 77, date: 842283000, hash: 'FAIL', ledger_index: 1 } },
        ],
      },
    });
    const history = await Xrp.getTransactionHistory(VECTOR);
    assert.strictEqual(history.transactions.length, 2, 'the trust line is not a payment');
    const [good, bad] = history.transactions;
    assert.deepStrictEqual(good, { hash: 'FB1B', sender: OTHER, recipient: VECTOR, amount: 0.00001, destinationTag: null, timestamp: 842283740 + 946684800, validated: true, ledgerIndex: 106870623, result: 'tesSUCCESS' });
    assert.strictEqual(bad.validated, false, 'a tec result is not a delivered payment');
    assert.strictEqual(bad.destinationTag, 77);
  });

  test('status: validated is settled and final; a failed result is failed; unknown is not found', async () => {
    rippled({ tx: ({ transaction }) => (transaction === 'GOOD' ? { status: 'success', validated: true, ledger_index: 5, meta: { TransactionResult: 'tesSUCCESS' } } : transaction === 'BAD' ? { status: 'success', validated: true, ledger_index: 6, meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' } } : transaction === 'SOON' ? { status: 'success', validated: false } : { status: 'error', error: 'txnNotFound' }) });
    assert.deepStrictEqual(await Xrp.getTransactionStatus('GOOD'), { status: 'settled', confirmations: 1, blockHeight: 5 });
    assert.deepStrictEqual(await Xrp.getTransactionStatus('BAD'), { status: 'failed', confirmations: 0, blockHeight: 6 });
    assert.deepStrictEqual(await Xrp.getTransactionStatus('SOON'), { status: 'waiting', confirmations: 0, blockHeight: null });
    assert.deepStrictEqual(await Xrp.getTransactionStatus('NOPE'), { status: 'not_found', confirmations: 0, blockHeight: null });
  });

  test('the fee is the open-ledger fee with a fifth on top, never under the base fee', async () => {
    rippled({ fee: { status: 'success', drops: { base_fee: '10', open_ledger_fee: '10' } } });
    assert.strictEqual(await Xrp.estimateFee(), 12);
    rippled({ fee: { status: 'success', drops: { base_fee: '10', open_ledger_fee: '5000' } } });
    assert.strictEqual(await Xrp.estimateFee(), 6000);
  });
});

describe('A payment', () => {
  const w = Xrp.generateWalletFromMnemonic(MNEMONIC);

  test('is signed offline with the sequence, a ledger to live, the memo and the tag, and submitted', async () => {
    const calls = rippled({
      account_info: { status: 'success', account_data: { Balance: '50000000', Sequence: 98, OwnerCount: 0 } },
      fee: { status: 'success', drops: { open_ledger_fee: '10' } },
      ledger: { status: 'success', ledger_index: 107000000 },
      server_info: { status: 'success', info: { validated_ledger: { reserve_base_xrp: 1 } } },
      submit: { status: 'success', engine_result: 'tesSUCCESS' },
    });
    const hash = await Xrp.sendTransaction(w.privateKey, OTHER, 20, { publicKey: w.publicKey, memo: '=:b:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq:37640/1/0', destinationTag: '4242' });
    assert.match(hash, /^[0-9A-F]{64}$/);
    const submit = calls.find((c) => c.method === 'submit');
    const tx = xrpl.decode(submit.params[0].tx_blob);
    assert.strictEqual(tx.TransactionType, 'Payment');
    assert.strictEqual(tx.Account, VECTOR);
    assert.strictEqual(tx.Destination, OTHER);
    assert.strictEqual(tx.Amount, '20000000');
    assert.strictEqual(tx.Fee, '12');
    assert.strictEqual(tx.Sequence, 98);
    assert.strictEqual(tx.LastLedgerSequence, 107000020);
    assert.strictEqual(tx.DestinationTag, 4242);
    assert.strictEqual(Buffer.from(tx.Memos[0].Memo.MemoData, 'hex').toString('utf8'), '=:b:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq:37640/1/0');
    assert.ok(tx.TxnSignature && tx.SigningPubKey === w.publicKey);
  });

  test('the reserve stays: a payment that would dip into it is refused before it is signed', async () => {
    const calls = rippled({
      account_info: { status: 'success', account_data: { Balance: '21000000', Sequence: 1, OwnerCount: 1 } },
      fee: { status: 'success', drops: { open_ledger_fee: '10' } },
      ledger: { status: 'success', ledger_index: 1 },
      server_info: { status: 'success', info: { validated_ledger: { reserve_base_xrp: 1 } } },
    });
    // 21 XRP held, 1.2 reserved (one object), 12 drops fee: 20 is too much
    await assert.rejects(() => Xrp.sendTransaction(w.privateKey, OTHER, 20, { publicKey: w.publicKey }), /1\.2 is the account reserve/);
    assert.ok(!calls.some((c) => c.method === 'submit'));
  });

  test('a rejection by the network is final, with its code', async () => {
    rippled({
      account_info: { status: 'success', account_data: { Balance: '50000000', Sequence: 1, OwnerCount: 0 } },
      fee: { status: 'success', drops: { open_ledger_fee: '10' } },
      ledger: { status: 'success', ledger_index: 1 },
      server_info: { status: 'success', info: { validated_ledger: { reserve_base_xrp: 1 } } },
      submit: { status: 'success', engine_result: 'tecNO_DST_INSUF_XRP', engine_result_message: 'Destination does not exist. Too little XRP sent to create it.' },
    });
    await assert.rejects(() => Xrp.sendTransaction(w.privateKey, OTHER, 0.5, { publicKey: w.publicKey }), /rejected by the network: tecNO_DST_INSUF_XRP/);
  });
});

describe('Wired into the rest', () => {
  test('payouts pass the signing keys and a shift\'s destination tag; checkout matches validated payments', () => {
    const payout = read('src/services/PayoutService.js');
    assert.ok(payout.includes('static signingKeys(wallet) {'));
    assert.ok(payout.includes("await service.sendTransaction(wallet.privateKey, toAddress, amount, { ...PayoutService.signingKeys(wallet), ...options })"));
    assert.ok(payout.includes("const tag = transfer.route === 'sideshift' ? order.extraId : null;"));
    assert.ok(payout.includes("{ ...PayoutService.signingKeys(wallet), memo: quote.memo }"), 'a THORChain deposit signs the same way');
    const checkout = read('src/routes/checkout.js');
    assert.ok(checkout.includes("case 'XRP': {"));
    assert.ok(checkout.includes("t.sender === buyer && t.recipient === merchant && t.validated"));
    assert.ok(checkout.includes("return `ripple:${walletAddress}?amount=${nativeAmount}`;"));
    const status = read('src/services/ChainTxStatus.js');
    assert.ok(status.includes("case 'xrp': return require('./wallets').walletServiceFor(code).getTransactionStatus(txHash);"));
    const gas = read('src/services/GasEstimator.js');
    assert.ok(gas.includes("case 'xrp': {"));
    const health = read('src/services/ChainHealthService.js');
    assert.ok(health.includes("if (chain.family === 'xrp') return this.probeXrp(chain);"));
    const dash = read('public/js/dashboard.js');
    assert.ok(dash.includes("xrp: { placeholder: 'r…'"));
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies.xrpl, 'xrpl is a dependency');
  });

  test('the pages count four families and name the ledger', () => {
    const help = read('public/js/help-content.js');
    assert.ok(help.includes('networks across four families'));
    assert.ok(help.includes('Solana and the XRP Ledger'));
    const faq = read('public/faq.html');
    assert.ok(faq.includes('<strong>Solana (SOL)</strong> and the <strong>XRP Ledger (XRP)</strong>'));
    const docs = read('public/js/docs-content.js');
    assert.ok(docs.includes('chains across four families'));
    assert.ok(docs.includes("['XRP Ledger', 'XRP', 'XRP', '\\u2014', '\\u2014', 'a few seconds (1 block)']"));
  });
});
