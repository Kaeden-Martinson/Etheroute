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
      return chain.code === 'LTC' ? require('./LitecoinWalletService') : require('./BitcoinWalletService');
    case 'solana':
      return require('./SolanaWalletService');
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
    case 'utxo': return chain.code === 'LTC' ? 'balanceLTC' : 'balanceBTC';
    default: return 'balance';
  }
}

module.exports = { walletServiceFor, balanceKeyFor };
