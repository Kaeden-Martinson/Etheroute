'use strict';

/**
 * The server's logger, with the bot's name on every line. The same files
 * under logs/ as the API writes, so one tail shows both; the same key
 * redaction; nothing written under test.
 */

const logger = require('../../src/services/logger');

const tag = '[discord]';
module.exports = {
  debug: (...args) => logger.debug(tag, ...args),
  info: (...args) => logger.info(tag, ...args),
  warn: (...args) => logger.warn(tag, ...args),
  error: (...args) => logger.error(tag, ...args),
};
