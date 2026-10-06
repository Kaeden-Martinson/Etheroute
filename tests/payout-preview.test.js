/**
 * End-to-end withdrawal preview across payout chains.
 *
 * Drives the real PayoutService.getWithdrawalPreview() against a client with
 * funded wallets on all four chains, with only the two external edges stubbed:
 * on-chain balance reads and Sideshift quotes. Everything between — eligibility,
 * plan construction, fee and gas maths, direct-vs-swap routing — is the real code.
 *
 * This is the layer the unit tests could not reach: it needs a client, wallets
 * and balances, and it is where a mistake would actually cost someone money.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { db } = require('../src/config/database');
const PayoutService = require('../src/services/PayoutService');
const SwapService = require('../src/services/SwapService');
const PriceService = require('../src/services/PriceService');
const GasEstimator = require('../src/services/GasEstimator');

const RATES = { eth: 3000, btc: 60000, ltc: 80, sol: 150 };

// Balances chosen so every wallet is comfortably above every threshold.
const BALANCES = { ETH: 0.5, BTC: 0.02, LTC: 12, SOL: 8 };

const RECIPIENTS = {
  ETH: '0xDd1973e6A8d74C34d86319345fe19B4F279A5f8e',
  BTC: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  LTC: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
  SOL: '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK',
};

/** getBalance returns a differently named field per chain. */
const BALANCE_FIELD = { ETH: 'balanceEth', BTC: 'balanceBTC', LTC: 'balanceLTC', SOL: 'balanceSOL' };

let clientId;
const originals = new Map();

before(() => {
  clientId = crypto.randomUUID();
  db.create('users', {
    id: clientId,
    username: `payout_preview_${Date.now()}`,
    passwordHash: 'unused',
    createdAt: new Date().toISOString(),
  });

  for (const [chain, balance] of Object.entries(BALANCES)) {
    db.create('wallets', {
      id: crypto.randomUUID(),
      clientId,
      chain,
      address: `${chain}-wallet-address`,
      privateKey: 'unused-in-preview',
      seedPhrase: 'unused-in-preview',
      balance,
      balanceUSD: balance * RATES[chain.toLowerCase()],
      isActive: true,
      serviceSubtractions: 0,
      createdAt: new Date().toISOString(),
    });
  }
});

beforeEach(() => {
  for (const [key, value] of Object.entries(RATES)) {
    PriceService[`${key}ToUsdRate`] = value;
  }

  // Stub the two external edges: chain reads and Sideshift quotes.
  for (const chain of Object.keys(BALANCES)) {
    const service = PayoutService.getWalletService(chain);
    if (!originals.has(chain)) originals.set(chain, service.getBalance);
    service.getBalance = async () => ({
      status: 'success',
      [BALANCE_FIELD[chain]]: BALANCES[chain],
    });
  }

  if (!originals.has('gas')) originals.set('gas', GasEstimator.estimate);
  GasEstimator.clear();
  GasEstimator.estimate = async (chain) => {
    const native = { ETH: 0.0004, BTC: 0.00002, LTC: 0.0001, SOL: 0.000005 }[chain.toUpperCase()] ?? 0.001;
    return { native, usd: native * RATES[chain.toLowerCase()], live: true };
  };

  // These tests are about the SideShift floor; THORChain is out of the picture.
  if (!originals.has('thorchain')) originals.set('thorchain', SwapService.thorchain);
  SwapService.thorchain = { ready: async () => {}, serves: () => false, quote: async () => { throw new Error('off'); } };
  if (!originals.has('quote')) originals.set('quote', SwapService.sideshift.getGasQuote);
  SwapService.sideshift.getGasQuote = async (from, to, amount) => ({
    outputAmount: from === to ? amount * 0.999 : amount * 0.98,
    changeInOutput: 0,
    estimatedGasUsd: from === to ? 0.05 : 0.60,
  });
});

afterEach(() => {
  for (const chain of Object.keys(BALANCES)) {
    PayoutService.getWalletService(chain).getBalance = originals.get(chain);
  }
  SwapService.sideshift.getGasQuote = originals.get('quote');
  SwapService.thorchain = originals.get('thorchain');
  GasEstimator.estimate = originals.get('gas');
  GasEstimator.clear();
});

describe('Previewing a payout in each supported chain', () => {
  for (const payoutChain of ['ETH', 'BTC', 'LTC', 'SOL']) {
    test(`${payoutChain} produces a complete plan`, async () => {
      const preview = await PayoutService.getWithdrawalPreview(
        clientId,
        RECIPIENTS[payoutChain],
        undefined,
        payoutChain
      );

      assert.strictEqual(preview.payoutChain, payoutChain);
      assert.strictEqual(preview.eligibleCount, 4, 'all four funded wallets should qualify');
      assert.ok(preview.totalAmountUsd > 0);

      // The platform's fee was taken from each payment as it arrived, so a
      // withdrawal quotes none: what is swept is the merchant's, less only
      // the reserve for the network's own fee.
      assert.ok(preview.grossSweptUsd > 0);
      assert.ok(preview.grossSweptUsd <= preview.totalAmountUsd, 'cannot sweep more than is held');
      assert.strictEqual(preview.platformFee, 0, 'nothing is charged at withdrawal');

      assert.ok(
        Math.abs(preview.netAmountUsd - (preview.grossSweptUsd - preview.totalGasUsd)) < 0.01,
        'net must be swept minus gas'
      );
      assert.ok(preview.netAmountUsd > 0);

      // The per-transfer breakdown the dashboard renders must sum to the
      // totals on the same screen. The page used to recompute the lines
      // itself, with a made-up $0.15 gas fallback, so they never did.
      assert.strictEqual(preview.transfers.length, 4, 'one line per transfer');
      const sum = (key) => preview.transfers.reduce((acc, t) => acc + t[key], 0);
      assert.ok(Math.abs(sum('grossUsd') - preview.grossSweptUsd) < 1e-6, 'amounts add up');
      assert.ok(Math.abs(sum('platformFeeUsd') - preview.platformFee) < 1e-6, 'fees add up');
      assert.ok(Math.abs(sum('gasUsd') - preview.totalGasUsd) < 1e-6, 'network fees add up');
      assert.ok(Math.abs(sum('netUsd') - preview.netAmountUsd) < 1e-6, 'nets add up');
      for (const t of preview.transfers) {
        assert.ok(Math.abs(t.netUsd - (t.grossUsd - t.platformFeeUsd - t.gasUsd)) < 1e-9, `${t.chain} line is internally consistent`);
        assert.strictEqual(t.payoutChain, payoutChain);
        assert.strictEqual(t.type, t.chain === payoutChain ? 'DIRECT_TRANSFER' : 'SWAP');
      }
      assert.strictEqual(preview.platformFeeRate, 0.05);
    });

    test(`${payoutChain} sends the matching wallet directly and swaps the rest`, async () => {
      const preview = await PayoutService.getWithdrawalPreview(
        clientId,
        RECIPIENTS[payoutChain],
        undefined,
        payoutChain
      );

      // getWithdrawalPreview exposes the plan through gasPerChain; re-plan to
      // inspect transfer types with the same inputs.
      const wallets = db.findBy('wallets', { clientId, isActive: true }).map((w) => ({
        ...w,
        balanceUSD: w.balance * RATES[w.chain.toLowerCase()],
      }));
      const plan = await SwapService.planBatchWithdrawal(wallets, preview.totalAmountUsd, payoutChain);

      const direct = plan.transfers.filter((t) => t.type === 'DIRECT_TRANSFER');
      const swaps = plan.transfers.filter((t) => t.type === 'SWAP');

      assert.strictEqual(direct.length, 1, 'exactly one wallet already sits on the payout chain');
      assert.strictEqual(direct[0].chain, payoutChain);
      assert.strictEqual(swaps.length, 3);
      assert.ok(swaps.every((t) => t.chain !== payoutChain));
      assert.ok(plan.transfers.every((t) => t.payoutChain === payoutChain));
    });
  }

  test('a direct transfer is cheaper than swapping the same wallet', async () => {
    const wallets = db.findBy('wallets', { clientId, isActive: true })
      .filter((w) => w.chain === 'BTC')
      .map((w) => ({ ...w, balanceUSD: w.balance * RATES.btc }));

    const asDirect = await SwapService.planBatchWithdrawal(wallets, 1200, 'BTC');
    const asSwap = await SwapService.planBatchWithdrawal(wallets, 1200, 'ETH');

    assert.ok(
      asDirect.transfers[0].estimatedGas < asSwap.transfers[0].estimatedGas,
      'the whole point of the direct path is that it costs less'
    );
  });

  test('the recipient address must match the payout chain', async () => {
    await assert.rejects(
      () => PayoutService.getWithdrawalPreview(clientId, RECIPIENTS.ETH, undefined, 'BTC'),
      /Invalid BTC address/
    );
  });

  test('an unsupported payout chain is rejected', async () => {
    await assert.rejects(
      () => PayoutService.getWithdrawalPreview(clientId, RECIPIENTS.ETH, undefined, 'XYZ'),
      /Unsupported payout chain/
    );
  });

  test('omitting the chain still behaves as an ETH payout', async () => {
    const preview = await PayoutService.getWithdrawalPreview(clientId, RECIPIENTS.ETH, undefined);
    assert.strictEqual(preview.payoutChain, 'ETH');
  });

  test('selecting a single wallet limits the plan to it', async () => {
    const preview = await PayoutService.getWithdrawalPreview(
      clientId,
      RECIPIENTS.SOL,
      ['SOL-wallet-address'],
      'SOL'
    );

    assert.strictEqual(preview.selectedWallets.length, 1);
    assert.strictEqual(preview.selectedWallets[0].chain, 'SOL');
  });
});

describe('Small balances', () => {
  test('a dust wallet is ineligible for a swap but eligible on its own chain', async () => {
    const dustClient = crypto.randomUUID();
    db.create('users', {
      id: dustClient,
      username: `dust_${Date.now()}`,
      passwordHash: 'unused',
      createdAt: new Date().toISOString(),
    });

    // ~$2.40 of LTC: under the swap threshold, over the direct one.
    db.create('wallets', {
      id: crypto.randomUUID(),
      clientId: dustClient,
      chain: 'LTC',
      address: 'LTC-dust-address',
      privateKey: 'unused',
      seedPhrase: 'unused',
      balance: 0.03,
      balanceUSD: 2.4,
      isActive: true,
      serviceSubtractions: 0,
      createdAt: new Date().toISOString(),
    });

    const service = PayoutService.getWalletService('LTC');
    const previous = service.getBalance;
    service.getBalance = async () => ({ status: 'success', balanceLTC: 0.03 });

    try {
      await assert.rejects(
        () => PayoutService.getWithdrawalPreview(dustClient, RECIPIENTS.ETH, undefined, 'ETH'),
        /No wallet has enough balance/,
        'too small to swap into ETH'
      );

      const preview = await PayoutService.getWithdrawalPreview(dustClient, RECIPIENTS.LTC, undefined, 'LTC');
      assert.strictEqual(preview.eligibleCount, 1, 'but large enough to send as LTC');
    } finally {
      service.getBalance = previous;
    }
  });
});
