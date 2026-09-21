/**
 * GasFloatService - the coin a token needs to move.
 *
 * A wallet that has received USDC but no ETH cannot send or swap the USDC:
 * every EVM chain charges gas in its coin. The float is a platform wallet
 * (one key, the same address on every EVM chain) that advances exactly the
 * gas a wallet's token legs need, moments before they run. The advance is
 * charged to the merchant in the token, at par, on the same withdrawal, so
 * the float is made whole in dollars and the merchant never has to buy a
 * few cents of ETH by hand.
 *
 * Optional: with no GAS_FLOAT_PRIVATE_KEY the plan says what is missing and
 * leaves the token where it is, as before. The float only ever sends to a
 * wallet the platform holds the key for, and only what a plan asked for.
 */
const { ethers } = require('ethers');
const chains = require('../config/chains');
const PriceService = require('./PriceService');
const { walletServiceFor } = require('./wallets');

// The float's own balance is read at most this often per chain.
const BALANCE_TTL_MS = 60 * 1000;

// What the float keeps back on a chain for its own sends: two transfers'
// worth of gas, so a top-up never strands the float itself.
const OWN_GAS_TXS = 2;

class GasFloatService {
  constructor(privateKey = process.env.GAS_FLOAT_PRIVATE_KEY || null) {
    this.privateKey = privateKey && /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey) ? privateKey : null;
    this.address = this.privateKey ? new ethers.Wallet(this.privateKey).address : null;
    this.balances = new Map();
  }

  /** Whether a float is configured at all. */
  enabled() {
    return Boolean(this.privateKey);
  }

  /** The float's coin balance on an EVM chain, cached a minute. */
  async balanceOn(chain) {
    if (!this.enabled()) return 0;
    const code = String(chain).toUpperCase();
    if (!chains.has(code) || chains.get(code).family !== 'evm') return 0;
    const cached = this.balances.get(code);
    if (cached && Date.now() - cached.at < BALANCE_TTL_MS) return cached.native;
    try {
      const response = await walletServiceFor(code).getBalance(this.address);
      const native = response && response.status === 'success' ? parseFloat(response.balanceEth) || 0 : 0;
      this.balances.set(code, { at: Date.now(), native });
      return native;
    } catch (error) {
      console.warn(`[GasFloatService] Balance on ${code} failed: ${error.message}`);
      return cached ? cached.native : 0;
    }
  }

  /**
   * Whether the float can advance `amountNative` on a chain: configured,
   * an EVM chain, and holding the amount plus its own gas for the send.
   * `perTxNative` is the live cost of one send there.
   */
  async canCover(chain, amountNative, perTxNative = 0) {
    if (!this.enabled() || !(amountNative > 0)) return false;
    const code = String(chain).toUpperCase();
    if (!chains.has(code) || chains.get(code).family !== 'evm') return false;
    const balance = await this.balanceOn(code);
    return balance >= amountNative + perTxNative * OWN_GAS_TXS;
  }

  /**
   * Send `amountNative` of the chain's coin from the float to a wallet and
   * wait for it to land. Returns the transfer's hash. The caller has already
   * charged the merchant for it.
   */
  async topUp(chain, toAddress, amountNative) {
    if (!this.enabled()) throw new Error('No gas float is configured (GAS_FLOAT_PRIVATE_KEY)');
    const code = String(chain).toUpperCase();
    const service = walletServiceFor(code);
    const sent = await service.sendTransaction(this.privateKey, toAddress, Number(amountNative).toFixed(10));
    const hash = sent && typeof sent === 'object' ? sent.hash : sent;
    if (!hash) throw new Error(`Gas top-up on ${code} returned no hash`);
    const receipt = typeof service.waitForReceipt === 'function' ? await service.waitForReceipt(hash) : null;
    if (receipt && receipt.status !== 1) throw new Error(`Gas top-up ${hash} on ${code} reverted`);
    this.balances.delete(code);
    console.log(`[GasFloatService] ${amountNative} ${chains.get(code).symbol} advanced to ${toAddress} on ${code}: ${hash}`);
    return hash;
  }

  /** What an advance of `amountNative` on a chain is worth. */
  usdOf(chain, amountNative) {
    return Number(amountNative) * (PriceService.rateFor(chain) || 0);
  }
}

module.exports = new GasFloatService();
module.exports.GasFloatService = GasFloatService;
