/**
 * Fail-closed settlement (finding H1).
 *
 * The original verifySender() returned `{ found: true, amount: <full amount> }`
 * whenever the explorer API errored, so an outage settled unpaid sessions as
 * PAID. These tests drive findPayment() against stubbed chain responses and
 * assert that nothing settles without a positively identified transaction.
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

const BalanceWatcher = require('../src/services/BalanceWatcher');
const { findPayment } = require('../src/routes/checkout')._internals;

const MERCHANT = 'bc1qmerchantaddressexample000000000000000';
const BUYER = 'bc1qbuyeraddressexample00000000000000000';

const session = {
  id: 'sess-under-test',
  chain: 'BTC',
  walletAddress: MERCHANT,
  clientWalletAddress: BUYER,
  nativeAmount: 0.01,
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

const wallet = { id: 'w1', chain: 'BTC', address: MERCHANT };

let original;

beforeEach(() => {
  original = BalanceWatcher.getTransactionHistory;
});

afterEach(() => {
  BalanceWatcher.getTransactionHistory = original;
});

function stubHistory(value) {
  BalanceWatcher.getTransactionHistory = async () => {
    if (value instanceof Error) throw value;
    return value;
  };
}

describe('H1 - settlement never assumes payment', () => {
  test('an explorer error reports unverifiable, not found', async () => {
    stubHistory({ status: 'error', error: 'upstream 502' });
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('a thrown exception reports unverifiable', async () => {
    stubHistory(new Error('socket hang up'));
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('a rate-limited response reports unverifiable', async () => {
    stubHistory({ status: 'rate_limited', retryAfter: 30 });
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('a null response reports unverifiable', async () => {
    stubHistory(null);
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('a malformed response reports unverifiable', async () => {
    stubHistory({ status: 'success', transactions: 'not-an-array' });
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('an unknown chain reports unverifiable rather than accepting', async () => {
    stubHistory({ status: 'success', transactions: [] });
    const result = await findPayment({ ...session, chain: 'XYZ' }, wallet);
    assert.strictEqual(result.outcome, 'unverifiable');
  });

  test('an empty history reports none', async () => {
    stubHistory({ status: 'success', transactions: [] });
    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'none');
  });
});

describe('Payment matching', () => {
  test('a payment from the buyer to the merchant is found', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        hash: 'tx-abc',
        time: Math.floor(new Date(session.createdAt).getTime() / 1000) + 60,
        blockHeight: 800000,
        inputs: [{ address: BUYER, value: 0.02 }],
        outputs: [{ address: MERCHANT, value: 0.01 }],
      }],
    });

    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.amount, 0.01);
    assert.strictEqual(result.txHash, 'tx-abc');
    assert.strictEqual(result.confirmations, 1);
  });

  test('a payment from a different sender is not matched', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        hash: 'tx-other',
        time: Math.floor(new Date(session.createdAt).getTime() / 1000) + 60,
        blockHeight: 800000,
        inputs: [{ address: 'bc1qsomeoneelse000000000000000000000000', value: 0.02 }],
        outputs: [{ address: MERCHANT, value: 0.01 }],
      }],
    });

    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'none');
  });

  test('a transaction predating the session is ignored', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        hash: 'tx-old',
        time: Math.floor(new Date(session.createdAt).getTime() / 1000) - 3600,
        blockHeight: 799000,
        inputs: [{ address: BUYER, value: 0.02 }],
        outputs: [{ address: MERCHANT, value: 0.01 }],
      }],
    });

    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'none');
  });

  test('only outputs to the merchant are counted', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        hash: 'tx-multi',
        time: Math.floor(new Date(session.createdAt).getTime() / 1000) + 60,
        blockHeight: 800000,
        inputs: [{ address: BUYER, value: 0.5 }],
        outputs: [
          { address: MERCHANT, value: 0.01 },
          { address: BUYER, value: 0.48 },   // change back to the buyer
          { address: 'bc1qthirdparty00000000000000000000000', value: 0.005 },
        ],
      }],
    });

    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.amount, 0.01);
  });

  test('an unconfirmed transaction is found but reports zero confirmations', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        hash: 'tx-mempool',
        time: Math.floor(new Date(session.createdAt).getTime() / 1000) + 10,
        blockHeight: null,
        inputs: [{ address: BUYER, value: 0.02 }],
        outputs: [{ address: MERCHANT, value: 0.01 }],
      }],
    });

    const result = await findPayment(session, wallet);
    assert.strictEqual(result.outcome, 'found');
    assert.strictEqual(result.confirmations, 0);
  });

  test('a Solana transfer with no credit to the merchant is not a payment', async () => {
    stubHistory({
      status: 'success',
      transactions: [{
        signature: 'sol-sig',
        timestamp: Math.floor(new Date(session.createdAt).getTime() / 1000) + 60,
        status: 'finalized',
        sender: BUYER,
        balanceChanges: [{ address: BUYER, delta: -0.5 }],
      }],
    });

    const solSession = { ...session, chain: 'SOL' };
    const result = await findPayment(solSession, { ...wallet, chain: 'SOL' });
    assert.strictEqual(result.outcome, 'none');
  });
});
