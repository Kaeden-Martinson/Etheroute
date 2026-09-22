'use strict';

/**
 * The server's logger, with the bot's name on every line: the same files
 * under logs/ as the API and the Discord bot write, the same redaction,
 * nothing written under test.
 */

const logger = require('../../src/services/logger');

const tag = '[telegram]';
module.exports = {
  debug: (...args) => logger.debug(tag, ...args),
  info: (...args) => logger.info(tag, ...args),
  warn: (...args) => logger.warn(tag, ...args),
  error: (...args) => logger.error(tag, ...args),
};
