#!/usr/bin/env node
/**
 * The Etheroute Telegram bot.
 *
 *   npm run telegram           start it (reads .env)
 *   npm run telegram:whoami    who the bot is, what it can see, and every
 *                              chat id it knows - without starting it
 *
 * On the channel named by TELEGRAM_CHANNEL_ID it keeps a pinned status
 * message current and posts when a main network or a service goes down or
 * comes back, and posts the announcements admins send it privately with
 * /announce. In the community group it mutes newcomers until they press a
 * button, deletes links from their first day, and answers the moderation
 * commands. In a private chat it opens support tickets and relays them to
 * the staff chat. Setup is in telegram/README.md; the token is read from
 * .env and only from there.
 */
'use strict';

const config = require('./config');
const log = require('./lib/log');
const { createBot } = require('./bot');

// Run on its own (npm run telegram) this process is the bot and exits when
// it cannot be one; required from a runner alongside the API, it only says
// so and leaves the rest standing.
const standalone = require.main === module;

function main() {
  const settings = config.read();
  const wrong = config.problems(settings);
  if (wrong.length) {
    for (const line of wrong) log.error(line);
    log.error(`See telegram/README.md for setup.${standalone ? '' : ' The Telegram bot is not running.'}`);
    if (standalone) process.exit(1);
    return null;
  }

  const bot = createBot(settings, { log });

  bot.start().catch((err) => {
    if (err.code === 401) log.error('Telegram rejected the token. Ask @BotFather for /token and put it in .env as TELEGRAM_BOT_TOKEN.');
    else log.error('could not start:', err.description || err);
    if (standalone) process.exit(1);
  });

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    log.info(`${signal}: stopping`);
    bot.stop();
    if (standalone) setTimeout(() => process.exit(0), 500);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (standalone) {
    process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));
    process.on('uncaughtException', (err) => { log.error('uncaught exception:', err); shutdown('crash'); });
  }
  return bot;
}

module.exports = main();
