/**
 * The wallet service for a chain code, by family.
 *
 * Every place that used to switch on 'ETH' / 'BTC' / 'SOL' / 'LTC' asks here
 * instead, so a chain added to the registry is picked up without touching
 * the callers.
 */
const chains = require('../../config/chains');

function walletServiceFor(code) {
  const chain = chains.get(code);
  switch (chain.family) {
    case 'evm':
      return require('./EvmWalletService').createEvmWalletService(chain);
    case 'utxo':
      if (chain.code === 'BTC') return require('./BitcoinWalletService');
      if (chain.code === 'LTC') return require('./LitecoinWalletService');
      // Bitcoin Cash, Dogecoin: legacy transactions, their own explorers.
      return require('./LegacyUtxoWalletService').createLegacyUtxoWalletService(chain.code);
    case 'solana':
      return require('./SolanaWalletService');
    case 'xrp':
      return require('./XrpWalletService');
    default:
      throw new Error(`No wallet service for chain family ${chain.family}`);
  }
}

/** The key each family's getBalance() reports the native amount under. */
function balanceKeyFor(code) {
  const chain = chains.get(code);
  switch (chain.family) {
    case 'evm': return 'balanceEth';
    case 'solana': return 'balanceSOL';
    case 'xrp': return 'balanceXRP';
    case 'utxo': return `balance${chain.code}`;
    default: return 'balance';
  }
}

module.exports = { walletServiceFor, balanceKeyFor };
