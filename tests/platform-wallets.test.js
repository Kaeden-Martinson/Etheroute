/**
 * The platform's own wallets: one per family from one phrase, addresses the
 * server reads and keys it never does, nothing already set replaced, and
 * not a key on the terminal.
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
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const bip39 = require('bip39');

const { validateCryptoAddress } = require('../src/utils/validators');
const { walletServiceFor } = require('../src/services/wallets');

const ROOT = path.join(__dirname, '..');

function run(envFile, ...args) {
  return execFileSync(process.execPath, ['scripts/platform-wallets.js', ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 60000,
    env: { ...process.env, PLATFORM_WALLETS_ENV_FILE: envFile },
  });
}

function parse(envFile) {
  return Object.fromEntries(fs.readFileSync(envFile, 'utf-8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe('scripts/platform-wallets.js', () => {
  test('generates every family without an address from one phrase, keeps the one set, prints addresses only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-pw-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'PLATFORM_FEE_ADDRESS_EVM=0x1111111111111111111111111111111111111111\r\nPLATFORM_FEE_ADDRESS_BTC=\r\nSOMETHING_ELSE=keep\r\n');

    const out = run(envFile, 'generate');
    assert.match(out, /EVM\s+keeps 0x1111/);
    assert.match(out, /6 wallets written to \.env with a new 24-word phrase/);
    const env = parse(envFile);
    assert.strictEqual(env.PLATFORM_FEE_ADDRESS_EVM, '0x1111111111111111111111111111111111111111', 'never replaced');
    assert.strictEqual(env.SOMETHING_ELSE, 'keep');
    assert.ok(bip39.validateMnemonic(env.PLATFORM_FEE_MNEMONIC));
    assert.strictEqual(env.PLATFORM_FEE_MNEMONIC.split(' ').length, 24);
    for (const [family, chain] of [['BTC', 'BTC'], ['LTC', 'LTC'], ['BCH', 'BCH'], ['DOGE', 'DOGE'], ['SOL', 'SOL'], ['XRP', 'XRP']]) {
      const address = env[`PLATFORM_FEE_ADDRESS_${family}`];
      assert.ok(validateCryptoAddress(address, chain), `${family}: ${address}`);
      assert.ok(env[`PLATFORM_FEE_PRIVATE_KEY_${family}`], `${family} key stored`);
      assert.ok(out.includes(address), `${family} address printed`);
      assert.ok(!out.includes(env[`PLATFORM_FEE_PRIVATE_KEY_${family}`]), `${family} key not printed`);
      // the same phrase, through the app's own services, gives the same wallet
      const again = walletServiceFor(chain).generateWalletFromMnemonic(env.PLATFORM_FEE_MNEMONIC);
      assert.strictEqual(again.address, address, `${family} derives from the phrase`);
    }
    assert.ok(!out.includes(env.PLATFORM_FEE_MNEMONIC), 'the phrase is not printed');
    assert.ok(fs.readFileSync(envFile, 'utf-8').includes('\r\n'), 'the file keeps its line endings');

    // a second run replaces nothing
    const again = run(envFile, 'generate');
    assert.match(again, /Nothing to generate/);
    assert.deepStrictEqual(parse(envFile).PLATFORM_FEE_ADDRESS_BTC, env.PLATFORM_FEE_ADDRESS_BTC);

    const listed = run(envFile, 'list');
    assert.match(listed, /BTC\s+bc1q.*key stored in \.env/);
    assert.match(listed, /phrase: stored in \.env/);
    try {
      run(envFile, 'generate', 'NOPE');
      assert.fail('an unknown family is an error');
    } catch (error) {
      assert.match(String(error.stdout || ''), /Unknown family NOPE/);
    }
  });

  test('a family can be made on its own, and the phrase already stored is reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-pw-'));
    const envFile = path.join(dir, '.env');
    const phrase = bip39.generateMnemonic(256);
    fs.writeFileSync(envFile, `PLATFORM_FEE_MNEMONIC=${phrase}\n`);
    const out = run(envFile, 'generate', 'ltc');
    assert.match(out, /1 wallet written to \.env from the phrase already stored/);
    const env = parse(envFile);
    assert.strictEqual(env.PLATFORM_FEE_MNEMONIC, phrase);
    assert.strictEqual(env.PLATFORM_FEE_ADDRESS_LTC, walletServiceFor('LTC').generateWalletFromMnemonic(phrase).address);
    assert.ok(!env.PLATFORM_FEE_ADDRESS_BTC, 'only what was asked for');
  });
});
