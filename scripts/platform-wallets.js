#!/usr/bin/env node
/**
 * The platform's own wallets: one per family, where the fee is collected to.
 *
 *   node scripts/platform-wallets.js list
 *   node scripts/platform-wallets.js generate            # every family with no address yet
 *   node scripts/platform-wallets.js generate BTC LTC    # only these
 *   node scripts/platform-wallets.js generate --force    # replace addresses already set (see below)
 *
 * Every wallet is derived from one 24-word phrase, so one backup restores
 * them all. The script writes to .env:
 *
 *   PLATFORM_FEE_ADDRESS_<FAMILY>      the address - the server reads this
 *   PLATFORM_FEE_PRIVATE_KEY_<FAMILY>  the key     - the server never reads this
 *   PLATFORM_FEE_MNEMONIC              the phrase  - the server never reads this
 *
 * and prints the addresses only; a key never goes to a terminal or a log.
 * The keys are in .env because that is where you asked for them; the file
 * lives on the server, which makes these hot wallets until you move the
 * phrase somewhere offline and delete the key lines. Do that.
 *
 * An address already set is never replaced without --force: it may hold
 * funds, and a new address is a new wallet, not a new key for the old one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const bip39 = require('bip39');

const { validate } = require('../src/config/env');
validate();

const { walletServiceFor } = require('../src/services/wallets');
const { validateCryptoAddress } = require('../src/utils/validators');

const ENV_FILE = process.env.PLATFORM_WALLETS_ENV_FILE || path.join(__dirname, '..', '.env');
// Family -> the chain whose service derives its wallet; EVM is one address on every EVM chain.
const FAMILIES = { EVM: 'ETH', BTC: 'BTC', LTC: 'LTC', BCH: 'BCH', DOGE: 'DOGE', SOL: 'SOL', XRP: 'XRP' };

const say = (line = '') => process.stdout.write(`${line}\n`);

function readEnv() {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), nl };
}

function valueOf(lines, key) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}

/** Set `key=value` in place, or append it (after `afterKey` when given). */
function setEnv(lines, key, value, afterKey = null) {
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (index >= 0) { lines[index] = `${key}=${value}`; return; }
  const anchor = afterKey ? lines.findIndex((l) => l.startsWith(`${afterKey}=`)) : -1;
  if (anchor >= 0) lines.splice(anchor + 1, 0, `${key}=${value}`);
  else lines.push(`${key}=${value}`);
}

function list() {
  const { lines } = readEnv();
  say('Platform wallets (.env)');
  for (const family of Object.keys(FAMILIES)) {
    const address = valueOf(lines, `PLATFORM_FEE_ADDRESS_${family}`);
    const key = valueOf(lines, `PLATFORM_FEE_PRIVATE_KEY_${family}`);
    say(`  ${family.padEnd(5)} ${address ? address : '(no address)'}${address && !validateCryptoAddress(address, FAMILIES[family]) ? '  ! not a valid address for this family' : ''}${key ? '  · key stored in .env' : ''}`);
  }
  say(valueOf(lines, 'PLATFORM_FEE_MNEMONIC') ? '  phrase: stored in .env - move it offline and delete the line' : '  phrase: not stored');
}

function generate(wanted, force) {
  const { lines, nl } = readEnv();
  const families = wanted.length ? wanted.map((f) => f.toUpperCase()) : Object.keys(FAMILIES);
  for (const family of families) if (!FAMILIES[family]) { say(`Unknown family ${family}; the families are ${Object.keys(FAMILIES).join(', ')}`); process.exit(1); }

  const todo = families.filter((family) => {
    const existing = valueOf(lines, `PLATFORM_FEE_ADDRESS_${family}`);
    if (existing && !force) { say(`  ${family.padEnd(5)} keeps ${existing} (set already; --force replaces it)`); return false; }
    return true;
  });
  if (!todo.length) { say('Nothing to generate.'); return; }

  // One phrase for every wallet made in this run. A phrase already stored
  // is reused so the new wallets join the same backup.
  let mnemonic = valueOf(lines, 'PLATFORM_FEE_MNEMONIC');
  const newPhrase = !mnemonic || !bip39.validateMnemonic(mnemonic);
  if (newPhrase) mnemonic = bip39.generateMnemonic(256);

  const made = [];
  for (const family of todo) {
    const service = walletServiceFor(FAMILIES[family]);
    const wallet = service.generateWalletFromMnemonic(mnemonic);
    if (!wallet || !wallet.address || !wallet.privateKey) throw new Error(`${family}: the wallet service returned no key pair`);
    if (!validateCryptoAddress(wallet.address, FAMILIES[family])) throw new Error(`${family}: derived an address the validator refuses: ${wallet.address}`);
    setEnv(lines, `PLATFORM_FEE_ADDRESS_${family}`, wallet.address);
    setEnv(lines, `PLATFORM_FEE_PRIVATE_KEY_${family}`, wallet.privateKey, `PLATFORM_FEE_ADDRESS_${family}`);
    made.push({ family, address: wallet.address, path: wallet.derivationPath || null });
  }
  if (newPhrase) {
    const anchor = lines.findIndex((l) => l.startsWith('PLATFORM_FEE_ADDRESS_') || l.startsWith('PLATFORM_FEE_PRIVATE_KEY_'));
    const note = [
      '# The platform wallets below were made by scripts/platform-wallets.js from',
      '# the one phrase in PLATFORM_FEE_MNEMONIC. The server reads the addresses',
      '# only. Write the phrase down somewhere offline, then delete the phrase',
      '# and the PRIVATE_KEY lines from this file: a key on the server is a hot',
      '# wallet, and these are meant to be cold.',
      `PLATFORM_FEE_MNEMONIC=${mnemonic}`,
    ];
    if (anchor >= 0) lines.splice(anchor, 0, ...note); else lines.push(...note);
  }
  fs.writeFileSync(ENV_FILE, lines.join(nl), 'utf-8');

  say(`${made.length} wallet${made.length === 1 ? '' : 's'} written to .env${newPhrase ? ' with a new 24-word phrase' : ' from the phrase already stored'}:`);
  for (const w of made) say(`  ${w.family.padEnd(5)} ${w.address}${w.path ? `   (${w.path})` : ''}`);
  say();
  say('The server reads the addresses at start: restart it. The keys and the phrase are');
  say('in .env and nowhere else - back the phrase up offline, then remove those lines.');
  if (made.some((w) => w.family === 'XRP')) say('XRP: the ledger creates an account on its first deposit of 1 XRP or more; a fee sweep under that cannot land until then.');
}

const [command, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
const families = rest.filter((a) => !a.startsWith('--'));
if (command === 'generate') generate(families, force);
else list();
