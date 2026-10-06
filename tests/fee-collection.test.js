/**
 * Fee collection: the platform's fee riding in a Bitcoin-style withdrawal
 * as a second output, the sweep that collects held fees elsewhere when
 * they are worth a transaction, the book, and the CLI.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { execFileSync } = require('node:child_process');

const { db } = require('../src/config/database');
const chains = require('../src/config/chains');
const PriceService = require('../src/services/PriceService');
const GasEstimator = require('../src/services/GasEstimator');
const KeyVault = require('../src/services/crypto/KeyVault');
const { FeeCollectionService } = require('../src/services/FeeCollectionService');
const FeeCollection = require('../src/services/FeeCollectionService');
const SwapService = require('../src/services/SwapService');
const PayoutService = require('../src/services/PayoutService');
const BalanceWatcher = require('../src/services/BalanceWatcher');
const { walletServiceFor } = require('../src/services/wallets');
const { createLegacyUtxoWalletService } = require('../src/services/wallets/LegacyUtxoWalletService');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n');

const EVM_FEE = '0x1111111111111111111111111111111111111111';
const BTC_FEE = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const LTC_FEE = 'LSxKwSdQeH9VX5tk3KBybMEEbqnFnjMy8D';
const DOGE_FEE = createLegacyUtxoWalletService('DOGE').addressFromPubkey(Buffer.from(ecc.pointFromScalar(Buffer.from('33'.repeat(32), 'hex'), true)));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ~ ${b}`);
const KEY = '1111111111111111111111111111111111111111111111111111111111111111';

const RATES = { eth: 3000, btc: 60000, ltc: 80, sol: 150 };
const GAS_NATIVE = { ETH: 0.0001, BTC: 0.00002, LTC: 0.0001, SOL: 0.000005, DOGE: 0.01 };

let originalEstimate;
beforeEach(() => {
  for (const [key, value] of Object.entries(RATES)) PriceService[`${key}ToUsdRate`] = value;
  originalEstimate = GasEstimator.estimate;
  GasEstimator.clear();
  GasEstimator.estimate = async (chain) => {
    const native = GAS_NATIVE[chain.toUpperCase()] ?? 0.001;
    return { native, usd: native * (PriceService.rateFor(chain) || 0), live: true };
  };
});
afterEach(() => {
  GasEstimator.estimate = originalEstimate;
  GasEstimator.clear();
});

describe('The platform address per family', () => {
  test('one env key per family, validated for the chain, unset means held', () => {
    const svc = new FeeCollectionService({ PLATFORM_FEE_ADDRESS_EVM: EVM_FEE, PLATFORM_FEE_ADDRESS_BTC: BTC_FEE, PLATFORM_FEE_ADDRESS_LTC: 'not-an-address' });
    assert.strictEqual(FeeCollectionService.envKeyFor('BASE'), 'PLATFORM_FEE_ADDRESS_EVM');
    assert.strictEqual(FeeCollectionService.envKeyFor('DOGE'), 'PLATFORM_FEE_ADDRESS_DOGE');
    assert.strictEqual(svc.addressFor('ETH'), EVM_FEE);
    assert.strictEqual(svc.addressFor('ARB'), EVM_FEE, 'the EVM address serves every EVM chain');
    assert.strictEqual(svc.addressFor('BTC'), BTC_FEE);
    assert.strictEqual(svc.addressFor('LTC'), null, 'an address that is not one is as good as unset');
    assert.strictEqual(svc.addressFor('SOL'), null);
    assert.strictEqual(svc.configured(), true);
    assert.strictEqual(new FeeCollectionService({}).configured(), false);
  });

  test('a Bitcoin-style leg gets a fee output; dust, other families and unset addresses do not', () => {
    const svc = new FeeCollectionService({ PLATFORM_FEE_ADDRESS_BTC: BTC_FEE, PLATFORM_FEE_ADDRESS_EVM: EVM_FEE });
    assert.deepStrictEqual(svc.feeOutputFor('BTC', 0.0005), { address: BTC_FEE, amount: 0.0005 });
    assert.strictEqual(svc.feeOutputFor('BTC', 0.000001), null, 'under 546 sats is dust');
    assert.strictEqual(svc.feeOutputFor('ETH', 1), null, 'an EVM send has one recipient');
    assert.strictEqual(svc.feeOutputFor('LTC', 0.5), null, 'no LTC address');
    assert.strictEqual(svc.feeOutputFor('BTC', 0), null);
    assert.strictEqual(svc.dustOf('DOGE'), 0.01, "Dogecoin's dust is a hundred times Bitcoin's");
  });
});

describe('A second output in the same transaction', () => {
  const key = Buffer.from(KEY, 'hex');
  const pubkey = Buffer.from(ecc.pointFromScalar(key, true));

  test('Dogecoin: recipient, then the fee output, then the change; the fee sized for three outputs', async () => {
    const doge = createLegacyUtxoWalletService('DOGE');
    const from = doge.addressFromPubkey(pubkey);
    const feeAddress = doge.addressFromPubkey(Buffer.from(ecc.pointFromScalar(Buffer.from('22'.repeat(32), 'hex'), true)));
    doge.getUtxos = async () => [{ txid: 'ab'.repeat(32), vout: 0, value: 500_000_000, script: doge.parseAddress(from).script }];
    doge.estimateFeeRate = async () => 1000;
    let hex = null;
    doge.broadcastRawTransaction = async (h) => { hex = h; return 'txid'; };
    await doge.sendTransaction(KEY, DOGE_FEE, 2, { extraOutputs: [{ address: feeAddress, amount: 0.5 }] });
    const tx = bitcoin.Transaction.fromHex(hex);
    assert.strictEqual(tx.outs.length, 3);
    assert.strictEqual(Number(tx.outs[0].value), 200_000_000);
    assert.strictEqual(Number(tx.outs[1].value), 50_000_000);
    assert.strictEqual(Buffer.from(tx.outs[1].script).toString('hex'), doge.parseAddress(feeAddress).script.toString('hex'));
    const fee = 500_000_000 - 200_000_000 - 50_000_000 - Number(tx.outs[2].value);
    assert.strictEqual(fee, Math.max(1000 * (10 + 148 + 34 * 3), 1_000_000), 'three outputs in the size');
    await assert.rejects(() => doge.sendTransaction(KEY, DOGE_FEE, 2, { extraOutputs: [{ address: DOGE_FEE, amount: 0.001 }] }), /below the dust limit/);
  });

  test('Bitcoin and Litecoin: the senders take extraOutputs, size them into the fee and pay them after the recipient', () => {
    for (const file of ['BitcoinWalletService', 'LitecoinWalletService']) {
      const source = read(`src/services/wallets/${file}.js`);
      assert.ok(source.includes('const extras = this.extraOutputsOf(options);'), file);
      assert.ok(source.includes('virtualSize(selectedUtxos.length, 2 + extras.length) + memoBytes)'), `${file} sizes them`);
      assert.ok(source.includes('totalNeeded = amountSatoshis + extraSatoshis + feeSatoshis;'), `${file} funds them`);
      const send = source.slice(source.indexOf('async sendTransaction('));
      const recipient = send.indexOf('value: BigInt(amountSatoshis)');
      const extra = send.indexOf('for (const extra of extras)');
      const change = send.indexOf('// Add change output if needed');
      assert.ok(recipient < extra && extra < change, `${file}: recipient, extras, change`);
    }
    const btc = walletServiceFor('BTC');
    assert.strictEqual(btc.scriptForAddress(BTC_FEE).toString('hex'), `0014${Buffer.from(bitcoin.address.fromBech32(BTC_FEE).data).toString('hex')}`);
    assert.deepStrictEqual(btc.extraOutputsOf({ extraOutputs: [{ address: BTC_FEE, amount: 0.001 }] })[0].value, 100000);
    assert.throws(() => btc.extraOutputsOf({ extraOutputs: [{ address: BTC_FEE, amount: 0.000001 }] }), /dust/);
    const ltc = walletServiceFor('LTC');
    assert.strictEqual(ltc.extraOutputsOf({ extraOutputs: [{ address: LTC_FEE, amount: 0.01 }] })[0].value, 1000000);
  });
});

describe('The plan and the payout carry the fee output', () => {
  let originalEnv;
  let originalThor;
  beforeEach(() => {
    originalEnv = SwapService.feeCollection.env;
    SwapService.feeCollection.env = { PLATFORM_FEE_ADDRESS_BTC: BTC_FEE, PLATFORM_FEE_ADDRESS_EVM: EVM_FEE };
    originalThor = SwapService.thorchain;
    SwapService.thorchain = { ready: async () => {}, serves: () => false, quote: async () => { throw new Error('off'); } };
    SwapService.sideshift.getGasQuote = async (from, to, amount) => ({ outputAmount: amount * 0.98, changeInOutput: -amount * 0.02, estimatedGasUsd: 0.5 });
  });
  afterEach(() => {
    SwapService.feeCollection.env = originalEnv;
    SwapService.thorchain = originalThor;
  });

  test('a direct Bitcoin leg names the output; an Ethereum leg holds the fee as before', async () => {
    const plan = await SwapService.planBatchWithdrawal([{ chain: 'BTC', address: 'BTC-addr', balance: 0.01, balanceUSD: 600 }], 600, 'BTC');
    const [leg] = plan.transfers;
    assert.strictEqual(leg.route, 'direct');
    assert.ok(leg.feeOutput, 'the fee rides along');
    assert.strictEqual(leg.feeOutput.address, BTC_FEE);
    assert.strictEqual(leg.feeOutput.amount, Number(leg.platformFeeNative.toFixed(8)));
    assert.ok(Math.abs(leg.nativeAmount + leg.platformFeeNative - (0.01 - leg.networkReserveNative)) < 1e-12, 'sent plus fee is the sweep');

    const eth = await SwapService.planBatchWithdrawal([{ chain: 'ETH', address: '0x' + '2'.repeat(40), balance: 0.5, balanceUSD: 1500 }], 1500, 'ETH');
    assert.strictEqual(eth.transfers[0].feeOutput, undefined, 'one recipient per EVM send');
  });

  test('the broadcast passes the output to the sender, and books the fee as collected rather than held', async () => {
    const source = read('src/services/PayoutService.js');
    assert.ok(source.includes('...(feeOutput && { extraOutputs: [feeOutput] }),'));
    assert.ok(source.includes('this._recordServiceFee(storedWallet, transfer, txHash, payoutId);'));

    db.clear();
    const wallet = db.create('wallets', { clientId: 'c1', chain: 'BTC', address: 'bc1qtest', balance: 0.01, serviceSubtractions: 0.001, isActive: true });
    PayoutService._recordServiceFee(wallet, { chain: 'BTC', platformFeeNative: 0.0005, feeOutput: { address: BTC_FEE, amount: 0.0005 } }, 'txhash1', 'payout1');
    assert.strictEqual(db.getById('wallets', wallet.id).serviceSubtractions, 0.001, 'nothing more held');
    const [row] = db.getAll('feeCollections');
    assert.deepStrictEqual({ chain: row.chain, asset: row.asset, amount: row.amount, address: row.address, txHash: row.txHash, via: row.via, status: row.status, payoutId: row.payoutId, usd: row.usd }, { chain: 'BTC', asset: 'BTC', amount: 0.0005, address: BTC_FEE, txHash: 'txhash1', via: 'payout', status: 'PROCESSING', payoutId: 'payout1', usd: 30 });

    // the same call without an output holds, as it always did
    PayoutService._recordServiceFee(wallet, { chain: 'BTC', platformFeeNative: 0.0002 }, 'txhash2', 'payout2');
    near(db.getById('wallets', wallet.id).serviceSubtractions, 0.0012);

    // the payout's transfer settling settles the fee that rode in it
    FeeCollection.onPayoutTransferResolved('txhash1', 'confirmed');
    assert.strictEqual(db.getById('feeCollections', row.id).status, 'CONFIRMED');
    assert.ok(db.getById('feeCollections', row.id).confirmedAt);
  });
});

describe('The sweep', () => {
  let svc;
  let sent;
  let originalSend;
  let originalRefresh;
  beforeEach(() => {
    db.clear();
    svc = new FeeCollectionService({ PLATFORM_FEE_ADDRESS_EVM: EVM_FEE, PLATFORM_FEE_ADDRESS_LTC: LTC_FEE });
    sent = [];
    originalSend = PayoutService.sendTransfer;
    PayoutService.sendTransfer = async (chain, wallet, to, amount, asset) => { sent.push({ chain, from: wallet.address, to, amount, asset, key: wallet.privateKey }); return `0xhash${sent.length}`; };
    originalRefresh = BalanceWatcher.updateWalletBalance;
    // the chain read: the record already says what is there, but the return
    // value is the dollar-shaped legacy object, never to be trusted for amounts
    BalanceWatcher.updateWalletBalance = async (wallet) => ({ status: 'success', balance: 999999 });
  });
  afterEach(() => {
    PayoutService.sendTransfer = originalSend;
    BalanceWatcher.updateWalletBalance = originalRefresh;
  });

  const sealed = (fields) => db.create('wallets', KeyVault.sealWallet({ clientId: 'c1', isActive: true, privateKey: KEY, seedPhrase: null, ...fields }));

  test('held is the book: per wallet and asset, at today\'s rates, tokens at par', () => {
    sealed({ chain: 'ETH', address: '0x' + 'a'.repeat(40), balance: 0.5, serviceSubtractions: 0.01, serviceSubtractionsTokens: { USDC: 12.5 }, tokenBalances: { USDC: 20 } });
    sealed({ chain: 'LTC', address: 'LTC-1', balance: 1, serviceSubtractions: 0.2 });
    sealed({ chain: 'SOL', address: 'SOL-1', balance: 1, serviceSubtractions: 0 });
    const held = svc.held();
    assert.deepStrictEqual(held.map((r) => [r.chain, r.asset, r.held, r.usd]), [['ETH', 'ETH', 0.01, 30], ['ETH', 'USDC', 12.5, 12.5], ['LTC', 'LTC', 0.2, 16]]);
    const summary = svc.summary();
    assert.strictEqual(summary.held.usd, 58.5);
    assert.strictEqual(summary.held.wallets, 2);
    assert.strictEqual(summary.addresses.EVM, EVM_FEE);
    assert.strictEqual(summary.addresses.BTC, null);
  });

  test('collects what clears the thresholds, capped at what the wallet can spare, and says why the rest waits', async () => {
    const rich = sealed({ chain: 'ETH', address: '0x' + 'a'.repeat(40), balance: 0.02, serviceSubtractions: 0.05 }); // $60 held, wallet holds $60 less gas
    sealed({ chain: 'ETH', address: '0x' + 'b'.repeat(40), balance: 0.5, serviceSubtractions: 0.001 }); // $3: under the minimum
    const tokens = sealed({ chain: 'ETH', address: '0x' + 'c'.repeat(40), balance: 0.01, serviceSubtractionsTokens: { USDC: 25 }, tokenBalances: { USDC: 25 } });
    sealed({ chain: 'ETH', address: '0x' + 'd'.repeat(40), balance: 0.00001, serviceSubtractionsTokens: { USDC: 40 }, tokenBalances: { USDC: 40 } }); // no gas for the token
    sealed({ chain: 'LTC', address: 'LTC-1', balance: 1, serviceSubtractions: 0.5 }); // $40, LTC address set
    sealed({ chain: 'SOL', address: 'SOL-1', balance: 5, serviceSubtractions: 1 }); // $150 but no SOL address
    db.create('transactions', { clientId: 'c1', fromAddress: 'LTC-1', status: 'PROCESSING', chain: 'LTC' });

    const dry = await svc.collect({ dryRun: true });
    assert.deepStrictEqual(dry.planned.map((c) => [c.chain, c.asset, c.amount]), [['ETH', 'ETH', 0.02 - 0.00015], ['ETH', 'USDC', 25]]);
    assert.strictEqual(sent.length, 0, 'a dry run sends nothing');
    const reasons = Object.fromEntries(dry.skipped.map((s) => [`${s.address}:${s.asset}`, s.reason]));
    assert.match(reasons['0x' + 'b'.repeat(40) + ':ETH'], /under the \$10 minimum/);
    assert.match(reasons['0x' + 'd'.repeat(40) + ':USDC'], /needs about .* ETH for gas/);
    assert.match(reasons['LTC-1:LTC'], /in flight/);
    assert.match(reasons['SOL-1:SOL'], /no PLATFORM_FEE_ADDRESS_SOL set/);

    const result = await svc.collect();
    assert.strictEqual(result.collected.length, 2);
    assert.deepStrictEqual(sent.map((s) => [s.chain, s.to, s.amount, s.asset, s.key]), [['ETH', EVM_FEE, 0.02 - 0.00015, 'ETH', KEY], ['ETH', EVM_FEE, 25, 'USDC', KEY]]);
    near(db.getById('wallets', rich.id).serviceSubtractions, 0.05 - (0.02 - 0.00015), 'held comes down by what left');
    assert.deepStrictEqual(db.getById('wallets', tokens.id).serviceSubtractionsTokens, {}, 'the token fee is collected in full');
    const txs = db.findBy('transactions', { fromAddress: '0x' + 'a'.repeat(40) });
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].type, 'FEE_COLLECTION');
    assert.strictEqual(txs[0].status, 'PROCESSING');
    assert.match(txs[0].orderId, /^direct_transfer_fee_/, 'checked on its chain like a direct payout');
    assert.strictEqual(txs[0].toAddress, EVM_FEE);
    const rows = db.getAll('feeCollections');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].via, 'sweep');
    assert.strictEqual(rows[0].transactionId, txs[0].id);

    // the second sweep finds the wallets busy, then nothing left
    const again = await svc.collect();
    assert.strictEqual(again.collected.length, 0);
  });

  test('a sweep that fails on its chain is held again; one that settles is booked', async () => {
    const wallet = sealed({ chain: 'ETH', address: '0x' + 'a'.repeat(40), balance: 0.02, serviceSubtractions: 0.05 });
    const { collected } = await svc.collect();
    assert.strictEqual(collected.length, 1);
    const tx = db.getById('transactions', collected[0].transactionId);
    const heldAfterSend = db.getById('wallets', wallet.id).serviceSubtractions;
    svc.onTransactionResolved(tx, 'failed');
    assert.strictEqual(db.getById('feeCollections', collected[0].id).status, 'FAILED');
    assert.ok(Math.abs(db.getById('wallets', wallet.id).serviceSubtractions - (heldAfterSend + collected[0].amount)) < 1e-9);
    svc.onTransactionResolved(tx, 'confirmed');
    assert.strictEqual(db.getById('feeCollections', collected[0].id).status, 'FAILED', 'a resolved row does not flip');

    const source = read('src/services/PayoutService.js');
    assert.ok(source.includes("FeeCollectionService.onTransactionResolved(transaction, 'confirmed');"));
    assert.ok(source.includes("FeeCollectionService.onTransactionResolved(transaction, 'failed');"));
  });

  test('a send that throws is reported, not booked', async () => {
    sealed({ chain: 'ETH', address: '0x' + 'a'.repeat(40), balance: 0.02, serviceSubtractions: 0.05 });
    PayoutService.sendTransfer = async () => { throw new Error('nonce too low'); };
    const result = await svc.collect();
    assert.strictEqual(result.collected.length, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.match(result.failed[0].error, /nonce too low/);
    assert.strictEqual(db.count('feeCollections'), 0);
    assert.strictEqual(db.count('transactions'), 0);
  });

  test('reconcile caps the held figures from before at what the wallet holds', () => {
    const w = sealed({ chain: 'BTC', address: 'bc1q', balance: 0.00001285, serviceSubtractions: 0.97460825 });
    const t = sealed({ chain: 'ETH', address: '0x' + 'e'.repeat(40), balance: 1, serviceSubtractions: 0.1, serviceSubtractionsTokens: { USDC: 5, USDT: 3 }, tokenBalances: { USDC: 2 } });
    assert.strictEqual(svc.reconcileHeld(), 3);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractions, 0.00001285);
    assert.strictEqual(db.getById('wallets', t.id).serviceSubtractions, 0.1, 'within what is there: untouched');
    assert.deepStrictEqual(db.getById('wallets', t.id).serviceSubtractionsTokens, { USDC: 2 }, 'USDT: none held, none there');
  });
});

describe('Correcting a held figure by hand', () => {
  const wallet = (over = {}) => db.create('wallets', {
    clientId: 'client-held', chain: 'ETH', address: `0x${'c'.repeat(40)}`, isActive: true,
    balance: 0.005, balanceUSD: 15, serviceSubtractions: 0.004,
    tokenBalances: { USDC: 20 }, serviceSubtractionsTokens: { USDC: 3 },
    privateKey: 'x', createdAt: new Date().toISOString(), ...over,
  });

  test('sets the coin figure, remembers what it was, and says so', () => {
    const w = wallet();
    const result = FeeCollection.setHeld(w.id, 'ETH', 0.00025113, { reason: 'booked twice' });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.from, 0.004);
    assert.strictEqual(result.to, 0.00025113);
    assert.strictEqual(result.onChain, 0.005);
    const after = db.getById('wallets', w.id);
    assert.strictEqual(after.serviceSubtractions, 0.00025113);
    assert.strictEqual(after.heldCorrections.length, 1);
    assert.strictEqual(after.heldCorrections[0].reason, 'booked twice');
    assert.strictEqual(after.heldCorrections[0].from, 0.004);
    assert.strictEqual(after.heldCorrections[0].to, 0.00025113);
    assert.ok(after.heldCorrections[0].at, 'and when');
    assert.strictEqual(after.serviceSubtractionsTokens.USDC, 3, 'the token figure is untouched');
  });

  test('sets a token figure, and zero removes it rather than leaving a nought behind', () => {
    const w = wallet();
    assert.strictEqual(FeeCollection.setHeld(w.id, 'USDC', 1.5).to, 1.5);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractionsTokens.USDC, 1.5);
    FeeCollection.setHeld(w.id, 'USDC', 0);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractionsTokens.USDC, undefined);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractions, 0.004, 'the coin figure is untouched');
    assert.strictEqual(db.getById('wallets', w.id).heldCorrections.length, 2, 'both corrections are on the record');
  });

  test('refuses what it cannot mean: no wallet, a negative or unreadable amount, an asset the chain does not carry', () => {
    const w = wallet();
    assert.match(FeeCollection.setHeld('nope', 'ETH', 1).error, /No wallet/);
    assert.match(FeeCollection.setHeld(w.id, 'ETH', -1).error, /not an amount/);
    assert.match(FeeCollection.setHeld(w.id, 'ETH', 'abc').error, /not an amount/);
    assert.match(FeeCollection.setHeld(w.id, 'DOGE', 1).error, /has no DOGE/);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractions, 0.004, 'and writes nothing');
  });

  test('a figure above the balance is allowed - the chain may be read later - and only the display caps it', () => {
    const w = wallet();
    assert.strictEqual(FeeCollection.setHeld(w.id, 'ETH', 9).to, 9);
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractions, 9);
    assert.strictEqual(FeeCollection.reconcileHeld() >= 1, true, 'and --reconcile is what brings it back to the balance');
    assert.strictEqual(db.getById('wallets', w.id).serviceSubtractions, 0.005);
  });

  test('the CLI shows the change and writes nothing without --yes', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'etheroute-fees-'));
    const run = (args) => execFileSync(process.execPath, ['scripts/collect-fees.js', ...args], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      env: { ...process.env, DATA_DIR: dir, PLATFORM_FEE_ADDRESS_EVM: EVM_FEE },
      timeout: 60000,
    });
    // a store of its own, seeded through the same CLI's process
    const seed = execFileSync(process.execPath, ['-e', `
      process.env.DATA_DIR = ${JSON.stringify(dir)};
      const { db } = require('./src/config/database');
      db.create('wallets', { id: 'w-cli', clientId: 'c', chain: 'ETH', address: '0x${'d'.repeat(40)}', isActive: true, balance: 0.005, serviceSubtractions: 0.004, privateKey: 'x', createdAt: new Date().toISOString() });
      console.log('seeded');
    `], { cwd: path.join(__dirname, '..'), encoding: 'utf-8', env: { ...process.env, DATA_DIR: dir }, timeout: 60000 });
    assert.match(seed, /seeded/);

    const preview = run(['--set-held', 'w-cli', '0.00025']);
    assert.match(preview, /held for fees\s+0\.004 ETH\s+->\s+0\.00025 ETH/);
    assert.match(preview, /Nothing written\. Add --yes/);

    const done = run(['--set-held', 'w-cli', '0.00025', '--reason', 'corrected', '--yes']);
    assert.match(done, /Set\. ETH held on 0x[0-9a-f]+: 0\.004 -> 0\.00025 \(corrected\)/);
    assert.match(run(['--set-held', 'w-cli', '0.00025']), /0\.00025 ETH\s+->\s+0\.00025 ETH/, 'and it stuck');
    // a refusal exits non-zero, which is the point of it
    const refusal = (args) => { try { run(args); return 'did not refuse'; } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; } };
    assert.match(refusal(['--set-held', 'nope', '1']), /No wallet matches/);
    assert.match(refusal(['--set-held', 'w-cli', 'abc']), /not an amount/);
  });
});

describe('Wired in', () => {
  test('the server starts and stops the sweep; the CLI, env and dashboard know it', () => {
    const app = read('src/app.js');
    assert.ok(app.includes('FeeCollectionService.start();'));
    assert.ok(app.includes('FeeCollectionService.stop();'));
    const env = read('.env.example');
    for (const key of ['PLATFORM_FEE_ADDRESS_EVM', 'PLATFORM_FEE_ADDRESS_BTC', 'PLATFORM_FEE_ADDRESS_XRP', 'FEE_COLLECT_MIN_USD', 'FEE_COLLECT_GAS_MULTIPLE', 'FEE_COLLECT_INTERVAL_MS']) assert.ok(env.includes(key), key);
    const dash = read('public/js/dashboard.js');
    assert.ok(dash.includes("isFeeCollection(tx) ? 'Platform fee' : 'Payout'"));
    assert.ok(dash.includes("'Platform fee collected'"));
    const swap = read('src/services/SwapService.js');
    assert.ok(swap.includes("leg.native && (kind === 'direct' || kind === 'sideshift')"), 'a THORChain deposit never carries one');
  });

  test('the CLI prints the book and a dry run without sending', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'etheroute-fees-'));
    const out = execFileSync(process.execPath, ['scripts/collect-fees.js', '--dry-run'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      // the families' addresses are pinned so the box's own .env cannot leak into the assertions
      env: { ...process.env, DATA_DIR: dir, PLATFORM_FEE_ADDRESS_EVM: EVM_FEE, PLATFORM_FEE_ADDRESS_BTC: '', PLATFORM_FEE_ADDRESS_LTC: '', PLATFORM_FEE_ADDRESS_BCH: '', PLATFORM_FEE_ADDRESS_DOGE: '', PLATFORM_FEE_ADDRESS_SOL: '', PLATFORM_FEE_ADDRESS_XRP: '' },
      timeout: 60000,
    });
    assert.match(out, /Would collect: 0/);
    assert.match(out, /Platform fee addresses/);
    assert.match(out, new RegExp(`EVM\\s+${EVM_FEE}`));
    assert.match(out, /BTC\s+\(not set/);
    assert.match(out, /Held in merchants' wallets: \$0\.00/);
  });
});
