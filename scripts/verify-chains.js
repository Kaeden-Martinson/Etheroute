#!/usr/bin/env node
/**
 * Check the chain registry against the live chains.
 *
 * For every EVM chain: that at least one RPC endpoint answers, that it
 * reports the chain id the registry claims, that every token contract
 * answers `symbol()` and `decimals()` with what the registry says, and that
 * the block time is roughly right (the last 20 blocks). For every chain: that
 * its CoinGecko id resolves to a price.
 *
 * A registry entry is data, and data copied from a docs page is exactly what
 * goes wrong quietly - a contract from the wrong network, a token that is
 * 18-decimal where the others are 6. This makes each entry prove itself.
 *
 *   node scripts/verify-chains.js            # every chain
 *   node scripts/verify-chains.js BNB BASE   # some
 *
 * Exits non-zero when anything fails. Read-only; no keys involved.
 */
'use strict';

// The UTXO checks go through the wallet services, which open the database
// module; point it at scratch so a running server's data is never touched.
if (!process.env.DATA_DIR) {
  const os = require('os');
  const fs = require('fs');
  process.env.DATA_DIR = fs.mkdtempSync(require('path').join(os.tmpdir(), 'etheroute-verify-'));
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-chains-secret-that-is-long-enough-x';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'verify-chains-key-that-is-long-enough-xx';

const chains = require('../src/config/chains');

const SELECTOR = { symbol: '0x95d89b41', decimals: '0x313ce567' };
const TIMEOUT_MS = 8000;

async function rpc(url, method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message || ''}${body.error.data ? ` (${typeof body.error.data === 'string' ? body.error.data : JSON.stringify(body.error.data)})` : ''}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** ABI-decode a `string` return value (offset, length, bytes). */
function decodeString(hex) {
  const data = hex.slice(2);
  const length = parseInt(data.slice(64, 128), 16);
  return Buffer.from(data.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

async function firstAnswering(urls) {
  const failures = [];
  for (const url of urls) {
    try {
      const id = await rpc(url, 'eth_chainId', []);
      return { url, chainId: parseInt(id, 16) };
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`no endpoint answered\n      ${failures.join('\n      ')}`);
}

async function checkEvm(chain, report) {
  const { url, chainId } = await firstAnswering(chains.rpcUrls(chain.code));
  report.ok(`rpc ${url}`);
  if (chainId !== chain.chainId) report.fail(`chain id is ${chainId}, registry says ${chain.chainId}`);
  else report.ok(`chain id ${chainId}`);

  // Block time: the spread of the last 200 blocks' timestamps (20 was noisy
  // on chains that batch or whose public tip lags).
  const tipHex = await rpc(url, 'eth_blockNumber', []);
  const tip = parseInt(tipHex, 16);
  const [newest, older] = await Promise.all([
    rpc(url, 'eth_getBlockByNumber', [tipHex, false]),
    rpc(url, 'eth_getBlockByNumber', [`0x${Math.max(0, tip - 200).toString(16)}`, false]),
  ]);
  if (newest && older) {
    // A tip whose timestamp is old is a chain that has stopped, whatever the
    // spread of its last blocks says. Moonbeam and Moonriver stopped in
    // August 2026 and every endpoint kept serving the last block; this is
    // the check that catches it.
    const tipAgeSec = Math.floor(Date.now() / 1000) - parseInt(newest.timestamp, 16);
    const stallAfterSec = Math.max(20 * chain.blockTimeSec, 15 * 60);
    if (tipAgeSec > stallAfterSec) report.fail(`the chain has stopped: the tip block is ${Math.round(tipAgeSec / 3600)} hours old`);
    const seconds = (parseInt(newest.timestamp, 16) - parseInt(older.timestamp, 16)) / Math.min(200, tip);
    const stated = chain.blockTimeSec;
    // Loose: block times drift, and sub-second chains batch. Off by more
    // than 3x either way is a wrong entry, not drift.
    if (seconds > stated * 3 || seconds < stated / 3) report.fail(`block time measures ${seconds.toFixed(2)}s, registry says ${stated}s`);
    else report.ok(`block time ~${seconds.toFixed(2)}s (registry ${stated}s)`);
  }

  // Settling a token payment reads eth_getLogs; some public endpoints refuse
  // it outright. At least one of the chain's endpoints has to serve a
  // filtered thousand-block query.
  if (chains.tokensOf(chain.code).length > 0) {
    const token = chains.tokensOf(chain.code)[0];
    const filter = {
      address: token.contract,
      fromBlock: `0x${(tip - 1000).toString(16)}`,
      toBlock: tipHex,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x0000000000000000000000002222222222222222222222222222222222222222', null],
    };
    const refusals = [];
    let served = null;
    for (const candidate of chains.rpcUrls(chain.code)) {
      try {
        await rpc(candidate, 'eth_getLogs', [filter]);
        served = candidate;
        break;
      } catch (error) {
        // A cap on the range is fine - settlement narrows its window to it.
        const cap = /maximum allowed is (\d+)|exceeds (?:the )?limit of (\d+)|limited to (\d+) blocks/i.exec(error.message);
        const allowed = cap ? Number(cap[1] || cap[2] || cap[3]) : 0;
        if (allowed >= 10) {
          try {
            await rpc(candidate, 'eth_getLogs', [{ ...filter, fromBlock: `0x${(tip - allowed + 1).toString(16)}` }]);
            served = `${candidate} (range capped at ${allowed} blocks)`;
            break;
          } catch (again) {
            refusals.push(`${candidate}: ${again.message.slice(0, 60)}`);
            continue;
          }
        }
        refusals.push(`${candidate}: ${error.message.slice(0, 60)}`);
      }
    }
    if (served) report.ok(`eth_getLogs served by ${served}${refusals.length ? ` (${refusals.length} endpoint${refusals.length === 1 ? '' : 's'} refused)` : ''}`);
    else report.fail(`no endpoint serves eth_getLogs\n      ${refusals.join('\n      ')}`);
  }

  // A token call is tried on every endpoint in turn: a rate limit on the
  // first is not a verdict on the contract.
  const callEverywhere = async (data, contract) => {
    let last;
    for (const candidate of [url, ...chains.rpcUrls(chain.code).filter((u) => u !== url)]) {
      try { return await rpc(candidate, 'eth_call', [{ to: contract, data }, 'latest']); } catch (error) { last = error; }
    }
    throw last;
  };

  for (const token of chains.tokensOf(chain.code)) {
    try {
      const [symbolHex, decimalsHex] = await Promise.all([
        callEverywhere(SELECTOR.symbol, token.contract),
        callEverywhere(SELECTOR.decimals, token.contract),
      ]);
      const symbol = decodeString(symbolHex);
      const decimals = parseInt(decimalsHex, 16);
      const problems = [];
      // Bridged USDC is "USDC.e" or "USDbC" on some chains; the registry names
      // the native issue, so the symbol has to match exactly - or match the
      // branded ticker the entry declares (Tether's USD₮0, USDt).
      const expected = token.onChainSymbol || token.symbol;
      if (symbol !== expected) problems.push(`symbol() is "${symbol}", expected "${expected}"`);
      if (decimals !== token.decimals) problems.push(`decimals() is ${decimals}, registry says ${token.decimals}`);
      if (problems.length) report.fail(`${token.symbol} ${token.contract}: ${problems.join('; ')}`);
      else report.ok(`${token.symbol} ${token.contract} · ${decimals} decimals`);
    } catch (error) {
      report.fail(`${token.symbol} ${token.contract}: ${error.message}`);
    }
  }

  // The on-chain swap route the registry claims: each aggregator listed
  // must still quote a hundred dollars of the chain's dollar token into its
  // coin, at a rate within the impact cap. An aggregator that has dropped
  // the chain is a failure here, not a surprise at payout time.
  if (chains.swappableOnChain(chain.code)) {
    const token = chains.tokensOf(chain.code)[0];
    if (!token) report.fail('dex listed but no dollar token to route');
    else {
      const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      const amount = (10n ** BigInt(token.decimals) * 100n).toString();
      const dex = chains.dexOf(chain.code);
      if (dex.kyber) {
        try {
          // an aggregator that is momentarily overloaded is asked again, not failed
          const r = await retrying(() => getJson(`https://aggregator-api.kyberswap.com/${dex.kyber}/api/v1/routes?tokenIn=${token.contract}&tokenOut=${NATIVE}&amountIn=${amount}`, { headers: { 'x-client-id': 'etheroute' } }), (x) => x && x.code === 0);
          const out = r && r.code === 0 && r.data && r.data.routeSummary ? Number(r.data.routeSummary.amountOutUsd) : null;
          if (out === null) report.fail(`kyber (${dex.kyber}) gave no route: ${(r && r.message) || 'no data'}`);
          else if (out < 97) report.fail(`kyber (${dex.kyber}) returns $${out.toFixed(2)} for $100 of ${token.symbol}: too thin`);
          else report.ok(`kyber (${dex.kyber}) $100 ${token.symbol} -> $${out.toFixed(2)} ${chain.symbol}`);
        } catch (error) {
          report.fail(`kyber (${dex.kyber}): ${error.message}`);
        }
      }
      if (dex.paraswap) {
        try {
          const r = await retrying(() => getJson(`https://api.paraswap.io/prices?srcToken=${token.contract}&destToken=${NATIVE}&amount=${amount}&srcDecimals=${token.decimals}&destDecimals=18&side=SELL&network=${chain.chainId}&version=6.2`), (x) => x && x.priceRoute);
          const out = r && r.priceRoute ? Number(r.priceRoute.destUSD) : null;
          if (out === null) report.fail(`paraswap gave no route: ${(r && r.error) || 'no data'}`);
          else if (out < 97) report.fail(`paraswap returns $${out.toFixed(2)} for $100 of ${token.symbol}: too thin`);
          else report.ok(`paraswap $100 ${token.symbol} -> $${out.toFixed(2)} ${chain.symbol}`);
        } catch (error) {
          report.fail(`paraswap: ${error.message}`);
        }
      }
    }
  }
}

// THORChain's lists, fetched once for the run.
const THORNODE = process.env.THORNODE_URL || 'https://gateway.liquify.com/chain/thorchain_api/thorchain';
let thorLists = null;
async function loadThorchain() {
  if (thorLists) return thorLists;
  const [inbound, pools] = await Promise.all([getJson(`${THORNODE}/inbound_addresses`), getJson(`${THORNODE}/pools`)]);
  thorLists = {
    inbound: new Map((Array.isArray(inbound) ? inbound : []).map((e) => [String(e.chain).toUpperCase(), e])),
    pools: new Set((Array.isArray(pools) ? pools : []).filter((p) => p.status === 'Available').map((p) => String(p.asset).toUpperCase())),
  };
  return thorLists;
}

/**
 * The THORChain route the registry claims: the chain must be one the
 * network lists (halted is reported, not failed - it comes and goes), its
 * coin must have a pool, and each dollar token's pool is noted.
 */
/**
 * A UTXO chain: its explorer must give the tip, and its wallet service a
 * fee rate. The explorer is what the wallet service reads balances and
 * transactions from, so an explorer that has gone away is a chain that has.
 */
async function checkUtxo(chain, report) {
  const service = require('../src/services/wallets').walletServiceFor(chain.code);
  const where = chain.explorerApi || (service.endpoints ? service.endpoints[0] : 'the network');
  try {
    const tip = typeof service.getTipHeight === 'function' ? await service.getTipHeight() : null;
    if (!tip) report.fail(`${where} gave no tip height`);
    else report.ok(`${chain.family === 'xrp' ? 'validated ledger' : 'explorer tip'} ${tip}`);
  } catch (error) {
    report.fail(`${where}: ${error.message}`);
  }
  try {
    if (chain.family === 'xrp') {
      const drops = await service.estimateFee();
      if (!(drops > 0)) report.fail('no fee');
      else report.ok(`fee ${drops} drops · reserve ${await service.baseReserve()} XRP`);
    } else {
      const rate = await service.estimateFeeRate(6);
      if (!(rate > 0)) report.fail('no fee rate');
      else report.ok(`fee rate ${rate} sat/vB`);
    }
  } catch (error) {
    report.fail(`fee: ${error.message}`);
  }
}

async function checkThorchain(chain, report) {
  const thorChain = chains.thorchainChain(chain.code);
  let lists;
  try {
    lists = await loadThorchain();
  } catch (error) {
    report.fail(`THORChain lists unreachable: ${error.message}`);
    return;
  }
  const entry = lists.inbound.get(thorChain);
  if (!entry) { report.fail(`THORChain does not list chain ${thorChain}`); return; }
  const coin = `${thorChain}.${chain.symbol}`;
  if (!lists.pools.has(coin)) report.fail(`THORChain has no pool for ${coin}`);
  else report.ok(`THORChain ${thorChain}${entry.halted ? ' (halted right now)' : ''} · pool ${coin}${entry.router ? ` · router ${entry.router}` : ''}`);
  if (chain.family === 'evm' && !entry.router) report.fail(`THORChain lists ${thorChain} without a router`);
  for (const token of chains.tokensOf(chain.code)) {
    const asset = `${thorChain}.${token.symbol}-${token.contract.toUpperCase()}`;
    report.ok(`THORChain ${token.symbol}: ${lists.pools.has(asset) ? 'pool available' : 'no pool (the coin travels, the token does not)'}`);
  }
}

/**
 * Call `fn` up to three times, two seconds apart, until `good` accepts the
 * answer or it stops throwing: a public API that answers "overloaded" once
 * is not a verdict on the chain.
 */
async function retrying(fn, good) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      last = await fn();
      if (good(last)) return last;
      if (!/overload|rate limit|429|50\d|timeout/i.test(JSON.stringify(last))) return last;
    } catch (error) {
      last = error;
      if (!/overload|rate limit|429|HTTP 5|timeout|aborted/i.test(error.message)) throw error;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (last instanceof Error) throw last;
  return last;
}

async function getJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', ...(init && init.headers) } });
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}, not JSON`); }
  } finally {
    clearTimeout(timer);
  }
}

async function checkPrices(list, report) {
  const ids = [...new Set(list.map((chain) => chain.coingeckoId))];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 8);
  try {
    // CoinGecko's free tier rate-limits; a 429 is waited out, not reported.
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(url, { signal: controller.signal });
      if (response.status !== 429) break;
      await new Promise((r) => setTimeout(r, 12000 * (attempt + 1)));
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = await response.json();
    for (const chain of list) {
      const price = prices[chain.coingeckoId] && prices[chain.coingeckoId].usd;
      if (typeof price === 'number') report.ok(chain.code, `${chain.coingeckoId} = $${price}`);
      else report.fail(chain.code, `CoinGecko has no price for "${chain.coingeckoId}"`);
    }
  } catch (error) {
    report.fail('prices', `CoinGecko unreachable: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const skipPrices = process.argv.includes('--skip-prices');
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((code) => code.toUpperCase());
  const list = chains.list().filter((chain) => wanted.length === 0 || wanted.includes(chain.code));
  let failures = 0;
  const lines = [];
  const reportFor = (code) => ({
    ok: (what, detail) => lines.push(`  ok    ${code.padEnd(5)} ${what}${detail ? ` · ${detail}` : ''}`),
    fail: (what, detail) => { failures += 1; lines.push(`  FAIL  ${code.padEnd(5)} ${what}${detail ? ` · ${detail}` : ''}`); },
  });

  for (const chain of list) {
    const report = reportFor(chain.code);
    if (chain.family === 'evm') {
      try {
        await checkEvm(chain, report);
      } catch (error) {
        report.fail(error.message);
      }
    } else if (chain.family === 'utxo' || chain.family === 'xrp') {
      await checkUtxo(chain, report);
    } else {
      report.ok(`${chain.family} chain; no RPC checks here`);
    }
    if (chains.thorchainChain(chain.code)) await checkThorchain(chain, report);
  }
  const prices = { ok: (code, d) => reportFor(code).ok('price', d), fail: (code, d) => reportFor(code).fail('price', d) };
  if (!skipPrices) await checkPrices(list, prices);

  process.stdout.write(`${lines.join('\n')}\n\n${failures === 0 ? 'all good' : `${failures} problem${failures === 1 ? '' : 's'}`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(2);
});
