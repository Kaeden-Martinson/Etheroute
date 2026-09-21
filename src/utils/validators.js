const { ValidationError } = require('./errors');
const { bech32, bech32m } = require('bech32');
const chains = require('../config/chains');

// From the registry, so a chain added there is accepted everywhere at once.
const SUPPORTED_CHAINS = chains.CODES;

const validateChain = (chain) => chains.has(chain);

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validateUUID = (id) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
};

const validateAmount = (amount) => amount > 0 && isFinite(amount);

/**
 * Validate a segwit address against its human-readable prefix.
 *
 * Witness version 0 (P2WPKH / P2WSH) uses bech32; version 1 and above
 * (P2TR / taproot) uses bech32m. Checking the checksum with the wrong variant
 * is exactly how a valid taproot address gets wrongly rejected.
 */
function isValidBech32(address, expectedPrefixes) {
  const lower = address.toLowerCase();

  // Mixed case is invalid per BIP-173, and the checksum is case-insensitive.
  if (address !== lower && address !== address.toUpperCase()) return false;

  let decoded = null;
  let usedBech32m = false;

  try {
    decoded = bech32.decode(lower);
  } catch {
    try {
      decoded = bech32m.decode(lower);
      usedBech32m = true;
    } catch {
      return false;
    }
  }

  if (!expectedPrefixes.includes(decoded.prefix)) return false;

  const witnessVersion = decoded.words[0];
  if (witnessVersion === undefined || witnessVersion > 16) return false;

  // Version 0 must be bech32; everything above must be bech32m.
  if (witnessVersion === 0 && usedBech32m) return false;
  if (witnessVersion > 0 && !usedBech32m) return false;

  const program = bech32.fromWords(decoded.words.slice(1));
  if (program.length < 2 || program.length > 40) return false;
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return false;

  return true;
}

/**
 * Base58Check addresses have no checksum validation here - the length and
 * alphabet check matches what the chain accepts structurally, and a wrong-but-
 * well-formed address is caught by the node at broadcast time.
 */
const BASE58_BTC = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BASE58_LTC = /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/;
const BASE58_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Dogecoin: P2PKH starts with D, P2SH with 9 or A.
const BASE58_DOGE = /^[DA9][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
// Bitcoin Cash: CashAddr (with or without its prefix), or a legacy 1…/3… address.
const CASHADDR_BCH = /^(bitcoincash:)?[qp][a-z0-9]{41}$/i;

const validateCryptoAddress = (address, chain) => {
  if (typeof address !== 'string' || address.length === 0) return false;
  if (!chains.has(chain)) return false;

  // Every EVM chain shares Ethereum's address format.
  if (chains.get(chain).family === 'evm') {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  switch (chain) {

    case 'BTC':
      // Legacy (1...), P2SH (3...), or segwit/taproot (bc1...).
      return BASE58_BTC.test(address) || isValidBech32(address, ['bc']);

    case 'LTC':
      // Legacy (L.../M...), P2SH (3...), or segwit (ltc1...).
      return BASE58_LTC.test(address) || isValidBech32(address, ['ltc']);

    case 'SOL':
      return BASE58_SOL.test(address);

    case 'BCH':
      // CashAddr's checksum is verified properly by the wallet service; this
      // is the shape check every chain gets here.
      return CASHADDR_BCH.test(address) || BASE58_BTC.test(address);

    case 'DOGE':
      return BASE58_DOGE.test(address);

    case 'XRP':
      // a classic r-address, checksum and all
      return require('xrpl').isValidClassicAddress(address);

    default:
      return false;
  }
};

const validateClientInput = (name, email) => {
  if (!name || name.trim().length === 0) {
    throw new ValidationError('Client name is required');
  }
  if (!validateEmail(email)) {
    throw new ValidationError('Invalid email format');
  }
};

const validateInvoiceInput = (amount, walletId, chain) => {
  if (!validateAmount(amount)) {
    throw new ValidationError('Amount must be a positive number');
  }
  if (!validateUUID(walletId)) {
    throw new ValidationError('Invalid wallet ID format');
  }
  if (!validateChain(chain)) {
    throw new ValidationError('Unsupported blockchain');
  }
};

const validatePayoutInput = (amount, recipientAddress, chain) => {
  if (!validateAmount(amount)) {
    throw new ValidationError('Amount must be a positive number');
  }
  if (!validateChain(chain)) {
    throw new ValidationError('Unsupported blockchain');
  }
  if (!validateCryptoAddress(recipientAddress, chain)) {
    throw new ValidationError(`Invalid ${chain} wallet address`);
  }
};

module.exports = {
  SUPPORTED_CHAINS,
  validateChain,
  validateEmail,
  validateUUID,
  validateAmount,
  validateCryptoAddress,
  validateClientInput,
  validateInvoiceInput,
  validatePayoutInput,
};
