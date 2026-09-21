/**
 * On-chain status of a broadcast transaction, for every supported chain.
 *
 * The payout monitor used to check "direct transfer" status by asking the
 * Ethereum RPC for a receipt - whatever chain the transfer was on. That was
 * fine when every payout settled in ETH. Now that a BTC, LTC or SOL wallet can
 * be paid out on its own chain, the Ethereum lookup could never find those
 * hashes, so every direct non-ETH payout sat in "waiting" until the monitor
 * gave up and marked it FAILED - after the funds had already moved.
 *
 * Every function here returns the same shape and never throws for "not yet":
 *
 *   { status: 'waiting' | 'settled' | 'failed' | 'not_found', confirmations, blockHeight }
 *
 * `not_found` means the network does not know the hash at all. Immediately
 * after broadcast that is normal (propagation); much later it means the
 * transaction was dropped. Callers decide how long to tolerate it.
 */
const ProxyService = require('./ProxyService');
const EthereumProvider = require('./EthereumProvider');
const chains = require('../config/chains');
const logger = require('./logger');

const EXPLORERS = {
  BTC: chains.get('BTC').explorerApi,
  LTC: chains.get('LTC').explorerApi,
};

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Bitcoin and Litecoin share the mempool.space API shape.
 * GET /tx/:txid/status -> { confirmed, block_height, block_hash, block_time }
 */
async function utxoChainStatus(chain, txid) {
  const base = EXPLORERS[chain];

  // The wallet service knows its explorer, its mirrors and its fallback;
  // it answers when it can. The direct read below is what remains for a
  // service without one.
  const service = require('./wallets').walletServiceFor(chain);
  if (typeof service.getTransactionStatus === 'function') return service.getTransactionStatus(txid);
  if (!base) throw new Error(`No status lookup for ${chain}`);

  const response = await ProxyService.fetch(`${base}/tx/${txid}/status`);
  if (response.status === 404) {
    return { status: 'not_found', confirmations: 0, blockHeight: null };
  }
  if (!response.ok) {
    throw new Error(`${chain} explorer returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.confirmed) {
    return { status: 'waiting', confirmations: 0, blockHeight: null };
  }

  // Depth needs the chain tip. One extra call; failure degrades to "1".
  let confirmations = 1;
  try {
    const tipResponse = await ProxyService.fetch(`${base}/blocks/tip/height`);
    if (tipResponse.ok) {
      const tip = Number(await tipResponse.text());
      if (Number.isFinite(tip) && data.block_height) {
        confirmations = Math.max(1, tip - data.block_height + 1);
      }
    }
  } catch (error) {
    logger.warn(`[ChainTxStatus] ${chain} tip height unavailable: ${error.message}`);
  }

  return { status: 'settled', confirmations, blockHeight: data.block_height };
}

/**
 * Solana: getSignatureStatuses with history search, so a signature older than
 * the recent cache is still found.
 */
async function solanaStatus(signature) {
  const response = await ProxyService.fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignatureStatuses',
      params: [[signature], { searchTransactionHistory: true }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Solana RPC returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Solana RPC error: ${data.error.message}`);
  }

  const entry = data.result && data.result.value && data.result.value[0];
  if (!entry) {
    return { status: 'not_found', confirmations: 0, blockHeight: null };
  }

  if (entry.err) {
    return { status: 'failed', confirmations: 0, blockHeight: entry.slot ?? null };
  }

  const level = entry.confirmationStatus;
  if (level === 'finalized') {
    return { status: 'settled', confirmations: 32, blockHeight: entry.slot ?? null };
  }

  // 'confirmed' is a supermajority vote and is treated as good enough for a
  // payout to be called done: rollback past that point is not something the
  // network has ever done. 'processed' is a single validator and still waits.
  if (level === 'confirmed') {
    return { status: 'settled', confirmations: 1, blockHeight: entry.slot ?? null };
  }

  return { status: 'waiting', confirmations: 0, blockHeight: entry.slot ?? null };
}

/**
 * Ethereum: a receipt with status 1 is settled, 0 is reverted, none yet is
 * waiting. Distinguishing "waiting" from "not_found" needs the pending pool.
 */
async function evmStatus(code, txHash) {
  return EthereumProvider.forChain(code).withProvider(async (provider) => {
    const receipt = await provider.getTransactionReceipt(txHash);

    if (receipt) {
      const tip = await provider.getBlockNumber();
      const confirmations = Math.max(1, tip - receipt.blockNumber + 1);
      return {
        status: receipt.status === 1 ? 'settled' : 'failed',
        confirmations,
        blockHeight: receipt.blockNumber,
      };
    }

    const pending = await provider.getTransaction(txHash);
    return pending
      ? { status: 'waiting', confirmations: 0, blockHeight: null }
      : { status: 'not_found', confirmations: 0, blockHeight: null };
  });
}

/**
 * @param {string} chain - ETH, BTC, LTC or SOL
 * @param {string} txHash
 */
async function getTransferStatus(chain, txHash) {
  if (!txHash) {
    throw new Error('A transaction hash is required to check status');
  }

  const code = String(chain).toUpperCase();
  if (!chains.has(code)) {
    throw new Error(`Unsupported chain for status lookup: ${chain}`);
  }

  switch (chains.get(code).family) {
    case 'evm': return evmStatus(code, txHash);
    case 'utxo': return utxoChainStatus(code, txHash);
    case 'solana': return solanaStatus(txHash);
    case 'xrp': return require('./wallets').walletServiceFor(code).getTransactionStatus(txHash);
    default:
      throw new Error(`Unsupported chain for status lookup: ${chain}`);
  }
}

module.exports = { getTransferStatus };
