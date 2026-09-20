/**
 * Fixed-rate Sideshift shifts.
 *
 * The plan already requests a quote for every swap and shows the client its
 * settleAmount. Orders used to be created as variable-rate shifts, which
 * ignore the quote entirely and set the rate whenever the deposit lands - so
 * the figure on the review screen was never the figure paid. A fixed shift
 * makes the quote binding, at the price of two constraints: it must be
 * created on the account that made the quote, and exactly the quoted deposit
 * must arrive within fifteen minutes.
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

const PriceService = require('../src/services/PriceService');
const SideshiftService = require('../src/services/SideshiftService');
const accounts = require('../src/services/SideshiftAccountService');
const SwapService = require('../src/services/SwapService');

const RECIPIENT_ETH = '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e';

/**
 * Two fake accounts so round-robin would, left alone, hand the shift to a
 * different account than the quote.
 */
function installFakeAccounts() {
  const saved = { accounts: accounts.accounts, index: accounts.currentIndex, usage: accounts.usageTracker, save: accounts._save };
  accounts.accounts = [
    { id: 'acct-A', affiliateId: 'AFF_A', secret: 'sec-a', proxyUrl: 'http://127.0.0.1:1', active: true },
    { id: 'acct-B', affiliateId: 'AFF_B', secret: 'sec-b', proxyUrl: 'http://127.0.0.1:2', active: true },
  ];
  accounts.currentIndex = 0;
  accounts.usageTracker = {};
  accounts._save = () => {};
  return () => Object.assign(accounts, { accounts: saved.accounts, currentIndex: saved.index, usageTracker: saved.usage, _save: saved.save });
}

/** A SideshiftService whose HTTP layer records calls and answers from `responses`. */
function serviceWith(responses) {
  const service = new SideshiftService(PriceService);
  const calls = [];
  service.http = {
    async post(url, body, config) {
      calls.push({ url, body, secret: config.headers['x-sideshift-secret'] });
      const answer = responses[url];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return { data: answer(body) };
      return { data: answer };
    },
    async get(url, config) {
      calls.push({ url, params: config.params, secret: config.headers['x-sideshift-secret'] });
      return { data: responses[url] };
    },
  };
  return { service, calls };
}

const QUOTE = {
  id: 'quote-1',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  depositAmount: '0.00100000',
  settleAmount: '0.0309748',
  rate: '30.9748',
  affiliateId: 'AFF_A',
};

const FIXED_ORDER = (body) => ({
  id: 'shift-fixed-1',
  status: 'waiting',
  type: 'fixed',
  quoteId: body.quoteId,
  depositAddress: 'bc1qdeposit',
  depositCoin: 'BTC',
  settleCoin: 'ETH',
  settleAddress: body.settleAddress,
  refundAddress: body.refundAddress,
  depositAmount: '0.00100000',
  settleAmount: '0.0309748',
  rate: '30.9748',
  expiresAt: QUOTE.expiresAt,
});

const VARIABLE_ORDER = {
  id: 'shift-var-1',
  status: 'waiting',
  type: 'variable',
  depositAddress: 'bc1qdepositvar',
  depositMin: '0.00003952',
  depositMax: '0.79',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
};

let restoreAccounts;

beforeEach(() => {
  PriceService.btcToUsdRate = 60000;
  PriceService.ethToUsdRate = 3000;
  restoreAccounts = installFakeAccounts();
});

afterEach(() => restoreAccounts());

describe('A quote carries what a fixed shift needs', () => {
  test('id, expiry, exact deposit string and the account it was made on', async () => {
    const { service } = serviceWith({ '/quotes': QUOTE });
    const quote = await service.getGasQuote('BTC', 'ETH', 0.001);

    assert.strictEqual(quote.quoteId, 'quote-1');
    assert.strictEqual(quote.depositAmount, '0.00100000', 'kept as the string Sideshift returned');
    assert.strictEqual(quote.settleAmount, '0.0309748');
    assert.strictEqual(quote.accountId, 'acct-A');
    assert.strictEqual(quote.affiliateId, 'AFF_A');
    assert.strictEqual(quote.outputAmount, 0.0309748, 'the existing numeric fields still work');
  });
});

describe('Creating a fixed shift', () => {
  test('uses /shifts/fixed with the quote id', async () => {
    const { service, calls } = serviceWith({ '/quotes': QUOTE, '/shifts/fixed': FIXED_ORDER });
    const quote = await service.getGasQuote('BTC', 'ETH', 0.001);
    const order = await service.createOrder({ fromChain: 'BTC', toChain: 'ETH', destinationAddress: RECIPIENT_ETH, refundAddress: 'bc1qrefund', quote });

    const shift = calls.find((c) => c.url === '/shifts/fixed');
    assert.ok(shift, 'should call the fixed endpoint');
    assert.strictEqual(shift.body.quoteId, 'quote-1');
    assert.strictEqual(shift.body.refundAddress, 'bc1qrefund', 'refund address is what makes a bad deposit auto-refundable');
    assert.strictEqual(order.type, 'fixed');
    assert.strictEqual(order.depositAmount, '0.00100000');
    assert.strictEqual(order.settleAmount, '0.0309748');
  });

  test('is created on the same account as its quote, not the next in rotation', async () => {
    const { service, calls } = serviceWith({ '/quotes': QUOTE, '/shifts/fixed': FIXED_ORDER });
    const quote = await service.getGasQuote('BTC', 'ETH', 0.001);

    // Round-robin has moved on to acct-B by now.
    assert.strictEqual(accounts.currentIndex, 1);

    await service.createOrder({ fromChain: 'BTC', toChain: 'ETH', destinationAddress: RECIPIENT_ETH, refundAddress: 'r', quote });

    const shift = calls.find((c) => c.url === '/shifts/fixed');
    assert.strictEqual(shift.secret, 'sec-a', 'must sign with the quoting account');
    assert.strictEqual(shift.body.affiliateId, 'AFF_A', 'Sideshift rejects a mismatched affiliateId');
  });

  test('without a quote it is still a variable shift', async () => {
    const { service, calls } = serviceWith({ '/shifts/variable': VARIABLE_ORDER });
    const order = await service.createOrder({ fromChain: 'BTC', toChain: 'ETH', destinationAddress: RECIPIENT_ETH, refundAddress: 'r' });

    assert.strictEqual(calls[0].url, '/shifts/variable');
    assert.strictEqual(order.type, 'variable');
    assert.strictEqual(order.depositAmount, null);
    assert.strictEqual(order.depositMin, 0.00003952);
  });

  test('a pinned account that has spent its shift budget is refused rather than swapped for another', () => {
    accounts.usageTracker['acct-A'] = { shifts: [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()], quotes: [] };
    assert.throws(() => accounts.getAccount('shift', 'acct-A'), /used its shift limit/);
  });
});

describe('executeSwap prefers a fixed shift and falls back cleanly', () => {
  let originalSideshift;
  beforeEach(() => { originalSideshift = SwapService.sideshift; });
  afterEach(() => { SwapService.sideshift = originalSideshift; });

  test('quotes at execution time and creates a fixed shift from it', async () => {
    const { service, calls } = serviceWith({ '/quotes': QUOTE, '/shifts/fixed': FIXED_ORDER });
    SwapService.sideshift = service;

    const result = await SwapService.executeSwap({
      chain: 'BTC', wallet: { address: 'bc1qsource' }, recipientAddress: RECIPIENT_ETH, payoutChain: 'ETH', nativeAmount: 0.001,
    });

    assert.deepStrictEqual(calls.map((c) => c.url), ['/quotes', '/shifts/fixed']);
    assert.strictEqual(result.sideshiftOrder.type, 'fixed');
    assert.strictEqual(result.sideshiftOrder.depositAmount, '0.00100000');
    assert.strictEqual(result.sideshiftOrder.quoteId, 'quote-1');
  });

  test('falls back to a variable shift when the fixed one is refused', async () => {
    const { service, calls } = serviceWith({
      '/quotes': QUOTE,
      '/shifts/fixed': Object.assign(new Error('quote expired'), { response: { status: 400, data: { error: { message: 'Quote expired' } } } }),
      '/shifts/variable': VARIABLE_ORDER,
    });
    SwapService.sideshift = service;

    const result = await SwapService.executeSwap({
      chain: 'BTC', wallet: { address: 'bc1qsource' }, recipientAddress: RECIPIENT_ETH, payoutChain: 'ETH', nativeAmount: 0.001,
    });

    assert.deepStrictEqual(calls.map((c) => c.url), ['/quotes', '/shifts/fixed', '/shifts/variable']);
    assert.strictEqual(result.sideshiftOrder.type, 'variable');
    assert.strictEqual(result.orderId, 'shift-var-1');
  });

  test('falls back to a variable shift when no quote can be had', async () => {
    const { service, calls } = serviceWith({
      '/quotes': Object.assign(new Error('rate limited'), { response: { status: 429, data: 'slow down' } }),
      '/shifts/variable': VARIABLE_ORDER,
    });
    SwapService.sideshift = service;

    const result = await SwapService.executeSwap({
      chain: 'BTC', wallet: { address: 'bc1qsource' }, recipientAddress: RECIPIENT_ETH, payoutChain: 'ETH', nativeAmount: 0.001,
    });

    assert.deepStrictEqual(calls.map((c) => c.url), ['/quotes', '/shifts/variable']);
    assert.strictEqual(result.sideshiftOrder.type, 'variable');
  });

  test('a same-chain payout never touches Sideshift', async () => {
    const { service, calls } = serviceWith({});
    SwapService.sideshift = service;
    const result = await SwapService.executeSwap({
      chain: 'ETH', wallet: { address: '0xsrc' }, recipientAddress: RECIPIENT_ETH, payoutChain: 'ETH', nativeAmount: 0.5,
    });
    assert.strictEqual(result.direct, true);
    assert.strictEqual(calls.length, 0);
  });
});

describe('The broadcast honours the fixed deposit exactly', () => {
  const payoutSource = fs.readFileSync(path.join(__dirname, '../src/services/PayoutService.js'), 'utf-8');
  const broadcast = payoutSource.slice(payoutSource.indexOf('async executeAndMonitorTransfers'), payoutSource.indexOf('async monitorTransactionConfirmation'));

  test('the amount sent is the shift\'s own deposit string, not the plan\'s float', () => {
    assert.ok(broadcast.includes("isFixed ? order.depositAmount : transfer.nativeAmount"));
    assert.ok(broadcast.includes('this.sendTransfer(transfer.chain, sourceWallet, depositAddress, sendAmount)'), 'the family-agnostic sender must receive sendAmount');
  });

  test('an expired fixed shift is skipped, never broadcast into', () => {
    assert.ok(broadcast.includes("'QUOTE_EXPIRED'"));
    assert.ok(broadcast.indexOf("'QUOTE_EXPIRED'") < broadcast.indexOf('this.sendTransfer(transfer.chain'), 'the check precedes the send');
  });

  test('the plan is updated to the shift\'s exact figures once a fixed order exists', () => {
    const plan = payoutSource.slice(payoutSource.indexOf('const swapDetails = await self.swapService.executeSwap'), payoutSource.indexOf("const createdPayout = db.create('payouts'"));
    assert.ok(plan.includes('nativeAmount: Number(order.depositAmount)'));
    assert.ok(plan.includes('expectedOutputAmount: Number(order.settleAmount)'));
    assert.ok(plan.includes('rateLocked: true'));
  });

  test('UTXO and lamport conversion rounds instead of flooring', () => {
    // floor(x * 1e8) is one unit short for about 6% of exact 8-decimal
    // amounts, which would make every such fixed deposit "incorrect".
    for (const file of ['BitcoinWalletService', 'LitecoinWalletService', 'SolanaWalletService']) {
      const source = fs.readFileSync(path.join(__dirname, `../src/services/wallets/${file}.js`), 'utf-8');
      const send = source.slice(source.indexOf('async sendTransaction'));
      assert.ok(/Math\.round\(Number\(amount\)/.test(send), `${file} should round the quoted amount`);
      assert.ok(!/Math\.floor\(amount \*/.test(send), `${file} must not floor the quoted amount`);
    }
    // And the arithmetic really is exact for every 8-decimal figure.
    for (let i = 1; i < 50000; i++) {
      assert.strictEqual(Math.round(Number((i / 1e8).toFixed(8)) * 1e8), i);
    }
  });

  test('Ethereum parses a decimal string verbatim', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/wallets/EvmWalletService.js'), 'utf-8');
    assert.ok(source.includes('ethers.parseEther(valueString)'));
    assert.ok(source.includes("typeof amount === 'string' ? amount.trim()"));
  });
});
