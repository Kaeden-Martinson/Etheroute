const { ValidationError } = require('./errors');

const validateChain = (chain) => {
  return ['ETH', 'BTC', 'LTC', 'SOL'].includes(chain);
};

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validateUUID = (id) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
};

const validateAmount = (amount) => {
  return amount > 0 && isFinite(amount);
};

const validateCryptoAddress = (address, chain) => {
  switch (chain) {
    case 'ETH':
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    case 'BTC':
      return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address);
    case 'LTC':
      return /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(address);
    case 'SOL':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
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
  validateChain,
  validateEmail,
  validateUUID,
  validateAmount,
  validateCryptoAddress,
  validateClientInput,
  validateInvoiceInput,
  validatePayoutInput,
};
