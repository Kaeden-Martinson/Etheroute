/**
 * Ethereum mainnet wallet service.
 *
 * Kept as a module so the many `require('./wallets/EthereumWalletService')`
 * call sites still work; the implementation is the generic EVM service
 * instantiated for ETH. See EvmWalletService.js.
 */
const { createEvmWalletService } = require('./EvmWalletService');

module.exports = createEvmWalletService('ETH');
