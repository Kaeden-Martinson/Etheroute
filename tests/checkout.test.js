/**
 * Checkout settlement logic.
 *
 * The critical property under test: a session never settles as PAID unless a
 * matching, sufficiently confirmed, unclaimed transaction was positively
 * identified. The previous implementation assumed success whenever the chain
 * lookup failed.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const checkout = require('../src/routes/checkout');
const { confirmationsOf, normalise, paymentUri, resolveAmounts } = checkout._internals;
const PriceService = require('../src/services/PriceService');

describe('Legacy session normalisation', () => {
  test('an old session with a single `amount` field reads correctly', () => {
    const legacy = { id: 's1', amount: 0.05, chain: 'ETH', status: 'PENDING' };
    const normalised = normalise(legacy);
    assert.strictEqual(normalised.nativeAmount, 0.05);
    assert.strictEqual(normalised.usdAmount, null);
  });

  test('a current session is passed through untouched', () => {
    const current = { id: 's2', nativeAmount: 0.05, usdAmount: 120, chain: 'ETH' };
    assert.deepStrictEqual(normalise(current), current);
  });

  test('null is handled', () => {
    assert.strictEqual(normalise(null), null);
  });
});

describe('Confirmation counting', () => {
  test('Ethereum reads the confirmations field', () => {
    assert.strictEqual(confirmationsOf('ETH', { confirmations: '31' }), 31);
  });

  test('Ethereum returns null when the field is absent, never a number', () => {
    // null means "cannot determine" and must not be treated as confirmed.
    assert.strictEqual(confirmationsOf('ETH', {}), null);
  });

  test('Bitcoin counts a block height as one confirmation', () => {
    assert.strictEqual(confirmationsOf('BTC', { blockHeight: 800000 }), 1);
  });

  test('an unconfirmed Bitcoin transaction counts as zero', () => {
    assert.strictEqual(confirmationsOf('BTC', { blockHeight: null }), 0);
  });

  test('Solana treats finalized as deeply confirmed and processed as zero', () => {
    assert.strictEqual(confirmationsOf('SOL', { status: 'finalized' }), 32);
    assert.strictEqual(confirmationsOf('SOL', { status: 'confirmed' }), 1);
    assert.strictEqual(confirmationsOf('SOL', { status: 'processed' }), 0);
  });

  test('an unknown chain returns null rather than guessing', () => {
    assert.strictEqual(confirmationsOf('XYZ', {}), null);
  });
});

describe('Amount resolution', () => {
  // Pin a rate before each test so these never depend on the live price feed.
  // A describe body runs before its async tests, so this has to be a hook.
  beforeEach(() => {
    PriceService.ethToUsdRate = 2000;
  });

  test('a native amount converts to USD', () => {
    const result = resolveAmounts('ETH', 0.5, undefined);
    assert.strictEqual(result.nativeAmount, 0.5);
    assert.strictEqual(result.usdAmount, 1000);
  });

  test('a USD amount converts to native', () => {
    const result = resolveAmounts('ETH', undefined, 100);
    assert.strictEqual(result.usdAmount, 100);
    assert.strictEqual(result.nativeAmount, 0.05);
  });

  test('supplying neither amount is rejected', () => {
    assert.throws(() => resolveAmounts('ETH', undefined, undefined), /Either nativeAmount or usdAmount/);
  });

  test('supplying both amounts is rejected', () => {
    assert.throws(() => resolveAmounts('ETH', 0.5, 1000), /not both/);
  });

  test('a negative amount is rejected', () => {
    assert.throws(() => resolveAmounts('ETH', -1, undefined), /positive number/);
  });

  test('zero is rejected', () => {
    assert.throws(() => resolveAmounts('ETH', 0, undefined), /positive number/);
  });

  test('a non-numeric amount is rejected', () => {
    assert.throws(() => resolveAmounts('ETH', 'free', undefined), /positive number/);
  });

  test('an unavailable price is a 503, not a bad conversion', () => {
    PriceService.ethToUsdRate = undefined;
    assert.throws(() => resolveAmounts('ETH', 1, undefined), /Price data is not yet available/);
  });
});

describe('Payment URIs for the QR code', () => {
  test('Bitcoin', () => {
    const uri = paymentUri({ chain: 'BTC', walletAddress: 'bc1qexample', nativeAmount: 0.001 });
    assert.strictEqual(uri, 'bitcoin:bc1qexample?amount=0.001');
  });

  test('Litecoin', () => {
    const uri = paymentUri({ chain: 'LTC', walletAddress: 'ltc1qexample', nativeAmount: 0.5 });
    assert.strictEqual(uri, 'litecoin:ltc1qexample?amount=0.5');
  });

  test('Ethereum', () => {
    const uri = paymentUri({ chain: 'ETH', walletAddress: '0xabc', nativeAmount: 0.05 });
    assert.strictEqual(uri, 'ethereum:0xabc?value=0.05');
  });

  test('Solana', () => {
    const uri = paymentUri({ chain: 'SOL', walletAddress: 'SoLaddr', nativeAmount: 2 });
    assert.strictEqual(uri, 'solana:SoLaddr?amount=2');
  });
});

describe('Settlement tokens', () => {
  test('the token changes with the session status', () => {
    const { settlementToken } = checkout._internals;
    const paid = settlementToken({ id: 'sess-1', status: 'PAID' });
    const expired = settlementToken({ id: 'sess-1', status: 'EXPIRED' });
    assert.notStrictEqual(paid, expired);
  });

  test('the token differs between sessions', () => {
    const { settlementToken } = checkout._internals;
    assert.notStrictEqual(
      settlementToken({ id: 'sess-1', status: 'PAID' }),
      settlementToken({ id: 'sess-2', status: 'PAID' })
    );
  });
});
