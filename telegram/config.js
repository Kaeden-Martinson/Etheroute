'use strict';

/**
 * What the Telegram bot needs to know, read from the same .env the server
 * and the Discord bot read. The token is the one secret and is typed into
 * .env by the person who holds it. A channel or a group - at least one:
 * the status pin and the announcements go to the channel if there is one,
 * else to the group; the gate and the moderation work in the group. The
 * staff chat and the admin list are optional, and each part that needs
 * one says so when it is missing rather than failing.
 *
 * Ids: a channel is "@name" or its numeric id (-100...); a group is its
 * numeric id; a person is their numeric id. `npm run telegram:whoami`
 * prints every id the bot can see.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
}

function read(env = process.env) {
  const str = (key, fallback = '') => (env[key] === undefined || String(env[key]).trim() === '' ? fallback : String(env[key]).trim());
  const first = (keys, fallback) => { for (const k of keys) if (str(k)) return str(k); return fallback; };
  const ids = (key) => str(key).split(',').map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x)).map(Number);
  const ms = (key, fallback, min) => Math.max(min, Number(str(key, String(fallback))) || fallback);
  const dataDir = str('DATA_DIR', path.join(ROOT, 'data'));
  return {
    token: str('TELEGRAM_BOT_TOKEN'),
    channelId: str('TELEGRAM_CHANNEL_ID'),
    groupId: str('TELEGRAM_GROUP_ID'),
    logChatId: str('TELEGRAM_LOG_CHAT_ID'),
    supportChatId: first(['TELEGRAM_SUPPORT_CHAT_ID', 'TELEGRAM_LOG_CHAT_ID'], ''),
    adminIds: ids('TELEGRAM_ADMIN_IDS'),
    // where the status pin and announcements go: the channel, or failing that the group
    get postChatId() { return this.channelId || this.groupId; },
    status: {
      apiUrl: first(['TELEGRAM_API_URL', 'DISCORD_API_URL'], `http://127.0.0.1:${str('PORT', '3000')}`).replace(/\/+$/, ''),
      intervalMs: ms('TELEGRAM_STATUS_INTERVAL_MS', 300000, 60000),
      mainChains: first(['TELEGRAM_MAIN_CHAINS', 'DISCORD_MAIN_CHAINS'], 'ETH,BTC,SOL,LTC,BCH,DOGE,XRP,POL,BASE,ARB,OP,BNB,AVAX').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    },
    verify: {
      // how long a newcomer has to press the button before they are shown out
      timeoutMs: ms('TELEGRAM_VERIFY_TIMEOUT_MS', 10 * 60000, 60000),
      // how long after joining a link in a message is treated as spam
      linkGraceMs: ms('TELEGRAM_LINK_GRACE_MS', 24 * 3600000, 0),
    },
    brand: {
      name: str('TELEGRAM_BRAND_NAME', str('DISCORD_BRAND_NAME', 'Etheroute')),
      site: str('SITE_URL', 'https://etheroute.io'),
    },
    dataFile: str('TELEGRAM_DATA_FILE', path.join(dataDir, 'telegram.json')),
  };
}

const looksLikeChat = (id) => /^@[A-Za-z0-9_]{4,}$/.test(id) || /^-?\d+$/.test(id);

/** What stops the bot from starting, in words for the person at the terminal. */
function problems(config) {
  const list = [];
  if (!config.token) list.push('TELEGRAM_BOT_TOKEN is not set (talk to @BotFather: /newbot, or /token for an existing bot).');
  else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(config.token)) list.push('TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then the secret).');
  if (!config.channelId && !config.groupId) list.push('Neither TELEGRAM_CHANNEL_ID nor TELEGRAM_GROUP_ID is set: a channel (@name or -100... id) and/or the group to moderate (its -100... id, from npm run telegram:whoami).');
  else if (config.channelId && !looksLikeChat(config.channelId)) list.push(`TELEGRAM_CHANNEL_ID does not look like a channel: ${config.channelId}`);
  for (const key of ['groupId', 'logChatId', 'supportChatId']) {
    if (config[key] && !looksLikeChat(config[key])) list.push(`TELEGRAM_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} does not look like a chat id: ${config[key]}`);
  }
  return list;
}

module.exports = { read, problems, looksLikeChat, ROOT };
