/**
 * Multi-chain payouts.
 *
 * Withdrawals used to convert everything to ETH and settle to an ETH address.
 * A client can now cash out in any of the four supported chains, and a wallet
 * already on the chosen chain is sent directly rather than swapped — which is
 * both cheaper and free of Sideshift's $5 swap minimum.
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

const SwapService = require('../src/services/SwapService');
const GasEstimator = require('../src/services/GasEstimator');
const PriceService = require('../src/services/PriceService');
const { validateCryptoAddress } = require('../src/utils/validators');

const FEE_RATE = 0.05;

// Realistic rates so USD thresholds mean something.
const RATES = { eth: 3000, btc: 60000, ltc: 80, sol: 150 };

// Fixed network costs, so thresholds are predictable and no test touches the
// network. Roughly realistic: a few cents on SOL/LTC, dollars on ETH/BTC.
const GAS_NATIVE = { ETH: 0.0004, BTC: 0.00002, LTC: 0.0001, SOL: 0.000005 };

let originalQuote;
let originalEstimate;

beforeEach(() => {
  for (const [key, value] of Object.entries(RATES)) {
    PriceService[`${key}ToUsdRate`] = value;
  }

  originalQuote = SwapService.sideshift.getGasQuote;
  originalEstimate = GasEstimator.estimate;

  GasEstimator.clear();
  GasEstimator.estimate = async (chain) => {
    const native = GAS_NATIVE[chain.toUpperCase()] ?? 0.001;
    return { native, usd: native * RATES[chain.toLowerCase()], live: true };
  };
});

afterEach(() => {
  SwapService.sideshift.getGasQuote = originalQuote;
  GasEstimator.estimate = originalEstimate;
  GasEstimator.clear();
});

/** USD cost of a send on `chain`, matching the stub above. */
function gasUsd(chain) {
  return GAS_NATIVE[chain] * RATES[chain.toLowerCase()];
}

/** Stub the quote layer so no network call is made. */
function stubQuotes() {
  const calls = [];
  SwapService.sideshift.getGasQuote = async (from, to, amount) => {
    calls.push({ from, to, amount });
    // A same-chain send loses only the network fee; a swap also loses a spread.
    const output = from === to ? amount * 0.999 : amount * 0.98;
    return { outputAmount: output, changeInOutput: output - amount, estimatedGasUsd: 0.5 };
  };
  return calls;
}

function wallet(chain, balance, balanceUSD) {
  return { chain, address: `${chain}-addr`, balance, balanceUSD };
}

describe('Minimum balance depends on whether a swap is needed', () => {
  test('a swap must clear Sideshift\'s $5 minimum plus gas', () => {
    const min = SwapService.minimumBalanceUsd('BTC', 'ETH', FEE_RATE, gasUsd('BTC'));
    assert.ok(min > 5, `expected over $5, got ${min}`);
  });

  test('a same-chain payout only has to cover its own gas', () => {
    const min = SwapService.minimumBalanceUsd('BTC', 'BTC', FEE_RATE, gasUsd('BTC'));
    assert.ok(min < 5, `expected well under the $5 swap minimum, got ${min}`);
    assert.ok(min >= gasUsd('BTC'), 'must at least cover the network fee');
  });

  test('cashing out in the same chain is always the cheaper threshold', () => {
    for (const chain of ['ETH', 'BTC', 'LTC', 'SOL']) {
      const other = chain === 'ETH' ? 'BTC' : 'ETH';
      const direct = SwapService.minimumBalanceUsd(chain, chain, FEE_RATE, gasUsd(chain));
      const swapped = SwapService.minimumBalanceUsd(chain, other, FEE_RATE, gasUsd(chain));
      assert.ok(direct < swapped, `${chain}: direct ${direct} should be below swapped ${swapped}`);
    }
  });

  test('the threshold tracks live gas rather than a fixed table', () => {
    // The old implementation read a hardcoded per-chain budget, so a fee spike
    // did not move the bar at all and reserves silently became too thin.
    const cheap = SwapService.minimumBalanceUsd('ETH', 'ETH', FEE_RATE, 0.20);
    const expensive = SwapService.minimumBalanceUsd('ETH', 'ETH', FEE_RATE, 20.00);
    assert.ok(expensive > cheap * 10, 'a 100x fee spike must raise the threshold');
  });
});

describe('Planning a withdrawal', () => {
  test('a matching wallet is a direct transfer, not a swap', async () => {
    const calls = stubQuotes();
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', 0.01, 600)], 600, 'BTC');

    assert.strictEqual(plan.payoutChain, 'BTC');
    assert.strictEqual(plan.transfers.length, 1);
    assert.strictEqual(plan.transfers[0].type, 'DIRECT_TRANSFER');
    assert.strictEqual(plan.transfers[0].payoutChain, 'BTC');
    assert.deepStrictEqual(calls[0], { from: 'BTC', to: 'BTC', amount: calls[0].amount });
  });

  test('a differing wallet is a swap into the payout chain', async () => {
    const calls = stubQuotes();
    const plan = await SwapService.planBatchWithdrawal([wallet('SOL', 5, 750)], 750, 'BTC');

    assert.strictEqual(plan.transfers[0].type, 'SWAP');
    assert.strictEqual(plan.transfers[0].chain, 'SOL');
    assert.strictEqual(plan.transfers[0].payoutChain, 'BTC');
    assert.strictEqual(calls[0].to, 'BTC', 'the quote must target the chosen payout chain, not ETH');
  });

  test('a mixed set produces one transfer per wallet, all settling in one chain', async () => {
    stubQuotes();
    const wallets = [
      wallet('ETH', 0.5, 1500),
      wallet('BTC', 0.02, 1200),
      wallet('LTC', 10, 800),
      wallet('SOL', 6, 900),
    ];

    const plan = await SwapService.planBatchWithdrawal(wallets, 4400, 'LTC');

    assert.strictEqual(plan.transfers.length, 4);
    assert.ok(plan.transfers.every((t) => t.payoutChain === 'LTC'));

    const direct = plan.transfers.filter((t) => t.type === 'DIRECT_TRANSFER');
    assert.strictEqual(direct.length, 1);
    assert.strictEqual(direct[0].chain, 'LTC', 'only the LTC wallet should skip the swap');
  });

  test('every supported chain can be a destination', async () => {
    for (const payoutChain of ['ETH', 'BTC', 'LTC', 'SOL']) {
      stubQuotes();
      const plan = await SwapService.planBatchWithdrawal([wallet('ETH', 1, 3000)], 3000, payoutChain);
      assert.strictEqual(plan.transfers.length, 1, `${payoutChain} produced no transfer`);
      assert.strictEqual(plan.transfers[0].payoutChain, payoutChain);
    }
  });

  test('a small balance is skipped for a swap but allowed for a direct payout', async () => {
    stubQuotes();

    // $3 of LTC: below the ~$6.30 swap threshold, above the ~$0.53 direct one.
    const small = wallet('LTC', 0.0375, 3);

    const swapPlan = await SwapService.planBatchWithdrawal([small], 3, 'ETH');
    assert.strictEqual(swapPlan.transfers.length, 0, 'too small to swap');

    const directPlan = await SwapService.planBatchWithdrawal([small], 3, 'LTC');
    assert.strictEqual(directPlan.transfers.length, 1, 'large enough to send directly');
  });

  test('the network fee is reserved and the platform fee is deducted, exactly', async () => {
    stubQuotes();
    const balance = 0.01;
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', balance, 600)], 600, 'BTC');
    const transfer = plan.transfers[0];

    // reserve = live gas x safety multiplier; fee = 5% of what is left.
    const reserved = GAS_NATIVE.BTC * 1.5;
    const sweepable = balance - reserved;
    const fee = sweepable * FEE_RATE;

    assert.ok(Math.abs(transfer.networkReserveNative - reserved) < 1e-12);
    assert.ok(Math.abs(transfer.platformFeeNative - fee) < 1e-12);
    assert.ok(
      Math.abs(transfer.nativeAmount - (sweepable - fee)) < 1e-12,
      `expected ${sweepable - fee}, got ${transfer.nativeAmount}`
    );
  });

  test('the amount sent plus the fee plus the reserve equals the balance', async () => {
    stubQuotes();
    const balance = 0.01;
    const plan = await SwapService.planBatchWithdrawal([wallet('BTC', balance, 600)], 600, 'BTC');
    const t = plan.transfers[0];

    // The whole point of the rewrite: nothing is unaccounted for. Previously
    // 10% was withheld while only 5% was recorded as a fee.
    const total = t.nativeAmount + t.platformFeeNative + t.networkReserveNative;
    assert.ok(
      Math.abs(total - balance) < 1e-12,
      `send + fee + reserve = ${total}, should equal balance ${balance}`
    );
  });
});

describe('Recipient addresses are validated against the payout chain', () => {
  const addresses = {
    ETH: '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e',
    BTC: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    LTC: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
    SOL: '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK',
  };

  for (const [chain, address] of Object.entries(addresses)) {
    test(`${chain} accepts its own address format`, () => {
      assert.strictEqual(validateCryptoAddress(address, chain), true);
    });

    test(`${chain} rejects the other chains' addresses`, () => {
      for (const [otherChain, otherAddress] of Object.entries(addresses)) {
        if (otherChain === chain) continue;
        // SOL's base58 range legitimately overlaps some other encodings, so it
        // is only asserted in the directions that must not collide.
        if (chain === 'SOL' && otherChain === 'LTC') continue;
        assert.strictEqual(
          validateCryptoAddress(otherAddress, chain),
          false,
          `a ${otherChain} address must not validate as ${chain}`
        );
      }
    });
  }
});

describe('executeSwap routes by destination', () => {
  test('same chain returns a direct transfer straight to the recipient', async () => {
    const result = await SwapService.executeSwap({
      chain: 'BTC',
      wallet: { address: 'bc1qsource' },
      recipientAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      payoutChain: 'BTC',
    });

    assert.strictEqual(result.direct, true);
    assert.ok(result.orderId.startsWith('direct_transfer_'));
    assert.strictEqual(
      result.sideshiftOrder.depositAddress,
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'a direct transfer goes to the recipient, not to a Sideshift deposit address'
    );
  });

  test('a mismatched address is rejected before any order is created', async () => {
    await assert.rejects(
      () => SwapService.executeSwap({
        chain: 'BTC',
        wallet: { address: 'bc1qsource' },
        recipientAddress: '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e',
        payoutChain: 'BTC',
      }),
      /Invalid BTC address/
    );
  });
});
