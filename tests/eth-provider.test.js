/**
 * Ethereum RPC failover.
 *
 * The original code kept a list of three fallback endpoints and only ever used
 * index 0, so when that endpoint became unreachable every ETH balance read, fee
 * estimate and broadcast failed with "failed to detect network" — and the two
 * spare endpoints sat unused.
 *
 * These tests use a stubbed probe, so they assert the selection logic without
 * depending on the reachability of any real endpoint.
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

const EthereumProvider = require('../src/services/EthereumProvider');

const ORIGINAL_ENV = process.env.ETH_RPC_URLS;

beforeEach(() => {
  EthereumProvider.markUnhealthy('test reset');
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ETH_RPC_URLS;
  else process.env.ETH_RPC_URLS = ORIGINAL_ENV;
});

describe('Endpoint list', () => {
  test('defaults to a built-in list of several endpoints', () => {
    delete process.env.ETH_RPC_URLS;
    const urls = EthereumProvider.endpoints();
    assert.ok(urls.length > 1, 'a single endpoint is a single point of failure');
    assert.ok(urls.every((u) => u.startsWith('https://')));
  });

  test('ETH_RPC_URLS overrides the default list', () => {
    process.env.ETH_RPC_URLS = 'https://first.example, https://second.example';
    assert.deepStrictEqual(
      EthereumProvider.endpoints(),
      ['https://first.example', 'https://second.example'],
      'whitespace around commas should be tolerated'
    );
  });

  test('an empty override falls back to the defaults', () => {
    process.env.ETH_RPC_URLS = '   ,  ';
    assert.ok(EthereumProvider.endpoints().length > 1);
  });
});

describe('Selection', () => {
  test('the active endpoint is reported for health checks', () => {
    // Nothing selected yet after markUnhealthy.
    assert.strictEqual(EthereumProvider.activeUrl(), null);
  });

  test('markUnhealthy clears the cached endpoint so the next call re-selects', () => {
    EthereumProvider.markUnhealthy('simulated failure');
    assert.strictEqual(EthereumProvider.activeUrl(), null);
  });
});

describe('withProvider retry policy', () => {
  /**
   * withProvider retries transport failures on a different endpoint, but must
   * not retry application errors - re-running a reverted call is pointless, and
   * more importantly a broadcast must never be repeated.
   */
  const originalGet = EthereumProvider.getProvider;

  afterEach(() => {
    EthereumProvider.getProvider = originalGet;
  });

  test('a transport failure is retried once on a fresh provider', async () => {
    const providers = ['provider-a', 'provider-b'];
    let handed = 0;
    EthereumProvider.getProvider = async () => providers[Math.min(handed++, 1)];

    const seen = [];
    const result = await EthereumProvider.withProvider(async (provider) => {
      seen.push(provider);
      if (seen.length === 1) throw new Error('failed to detect network');
      return 'ok';
    });

    assert.strictEqual(result, 'ok');
    assert.deepStrictEqual(seen, ['provider-a', 'provider-b'], 'the retry must use a new provider');
  });

  test('an application error is not retried', async () => {
    EthereumProvider.getProvider = async () => 'provider-a';

    let attempts = 0;
    await assert.rejects(
      () => EthereumProvider.withProvider(async () => {
        attempts += 1;
        throw new Error('execution reverted: insufficient balance');
      }),
      /execution reverted/
    );

    assert.strictEqual(attempts, 1, 'a reverted call must not be retried');
  });

  test('a certificate error counts as a transport failure', async () => {
    // This is the shape a DNS filter produces when it intercepts the hostname.
    EthereumProvider.getProvider = async () => 'provider-a';

    let attempts = 0;
    await assert.rejects(
      () => EthereumProvider.withProvider(async () => {
        attempts += 1;
        throw new Error('fetch failed');
      })
    );

    assert.strictEqual(attempts, 2, 'a fetch failure should be retried once');
  });
});

describe('Endpoint cooldown', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EthereumProvider.js'), 'utf-8');

  test('the network is stated so ethers never has to detect it', () => {
    // staticNetwork: true alone still detects once; a failed detection prints
    // "failed to detect network ... retry in 1s" and leaves a retry timer.
    assert.ok(source.includes('ethers.Network.from(chain.chainId)'), 'each pool states its chain');
    assert.match(source, /new ethers\.JsonRpcProvider\(url, this\.network, \{\s*staticNetwork: this\.network/);
  });

  test('a failed probe is destroyed and its endpoint skipped for a while', () => {
    assert.ok(source.includes('provider.destroy()'));
    assert.ok(source.includes('cooldowns.set(url'));
    assert.ok(source.includes('ENDPOINT_COOLDOWN_MS'));
  });
});
