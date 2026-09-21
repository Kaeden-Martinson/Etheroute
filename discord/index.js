#!/usr/bin/env node
/**
 * The Etheroute Discord bot.
 *
 *   npm run discord            start it (reads .env)
 *   npm run discord:channels   list the server's channels and roles, and
 *                              which the bot would use, without starting
 *
 * What it does on the server named by DISCORD_GUILD_ID:
 *   - posts a verification panel in #verify; the button gives the Member role
 *   - welcomes each new member in #welcome
 *   - removes anyone who posts in #anti-bot (kick, or ban if configured)
 *   - answers the slash commands under discord/commands: kick, ban, timeout,
 *     purge, warn, giveaway, lock, slowmode, role, announce and the rest
 *
 * Setup is in discord/README.md. The token is read from .env and only
 * from there.
 */
'use strict';

const config = require('./config');
const log = require('./lib/log');
const { createBot } = require('./bot');
const { inviteUrl, INTENTS } = require('./lib/invite');

const settings = config.read();
const wrong = config.problems(settings);
if (wrong.length) {
  for (const line of wrong) log.error(line);
  log.error('See discord/README.md for setup.');
  process.exit(1);
}

const bot = createBot(settings, { log });

log.info(`starting; intents ${INTENTS.join(', ')} (Server Members must be enabled in the portal)`);
if (settings.clientId) log.info(`invite link: ${inviteUrl(settings.clientId)}`);

bot.start().catch((err) => {
  const text = String(err && err.message || err);
  if (/disallowed intents/i.test(text)) log.error('Discord refused the Server Members intent. Developer Portal → your app → Bot → Privileged Gateway Intents → turn on "Server Members Intent".');
  else if (/token/i.test(text)) log.error('Discord rejected the token. Reset it in the portal (Bot → Reset Token) and put the new one in .env as DISCORD_BOT_TOKEN.');
  else log.error('could not sign in:', err);
  process.exit(1);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`${signal}: signing out`);
  try { await bot.stop(); } catch { /* already gone */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));
process.on('uncaughtException', (err) => { log.error('uncaught exception:', err); shutdown('crash'); });
