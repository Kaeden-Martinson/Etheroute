'use strict';

/**
 * What the bot needs to know, read from the same .env the server reads.
 *
 * The secrets - the bot token - never pass through code or chat: they are
 * typed into .env by the person who holds them. Everything else has a
 * default that fits a server laid out the usual way: a #welcome, a
 * #verify, an #anti-bot, a #status, a #roles, a #support, a #mod-log, and
 * a Member role plus the four people claim for themselves. A channel or
 * role can be named
 * by its id or by its name; a name is matched loosely (emoji, dashes and
 * case do not matter, and "verify" finds "✅︱verification"), and a
 * comma-separated list tries each in turn.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
}

const ANTIBOT_ACTIONS = ['kick', 'ban'];

function read(env = process.env) {
  const str = (key, fallback = '') => (env[key] === undefined || String(env[key]).trim() === '' ? fallback : String(env[key]).trim());
  const flag = (key, fallback) => (str(key) === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(str(key).toLowerCase()));
  const list = (key, fallback) => str(key, fallback).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const dataDir = str('DATA_DIR', path.join(ROOT, 'data'));
  return {
    token: str('DISCORD_BOT_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
    channels: {
      welcome: str('DISCORD_WELCOME_CHANNEL', 'welcome,welcomes,hello'),
      verify: str('DISCORD_VERIFY_CHANNEL', 'verify,verification,verify-here'),
      antibot: str('DISCORD_ANTIBOT_CHANNEL', 'anti-bot,antibot,anti-spam,bot-trap'),
      log: str('DISCORD_LOG_CHANNEL', 'mod-log,mod-logs,modlog,logs,audit-log'),
      rules: str('DISCORD_RULES_CHANNEL', 'rules,info'),
      status: str('DISCORD_STATUS_CHANNEL', 'status,service-status,uptime'),
      roles: str('DISCORD_ROLES_CHANNEL', 'roles,get-roles,self-roles,role-select,pick-roles,claim-roles'),
      support: str('DISCORD_SUPPORT_CHANNEL', 'support,tickets,help,open-a-ticket,create-a-ticket'),
      transcripts: str('DISCORD_TRANSCRIPTS_CHANNEL', 'ticket-logs,transcripts,ticket-transcripts'),
    },
    roles: {
      member: str('DISCORD_MEMBER_ROLE', 'Member'),
      // the four anyone may claim from the panel in #roles
      merchant: str('DISCORD_MERCHANT_ROLE', 'Merchant'),
      buyer: str('DISCORD_BUYER_ROLE', 'Buyer'),
      announcements: str('DISCORD_ANNOUNCEMENTS_ROLE', 'Announcements'),
      status: str('DISCORD_STATUS_ROLE', 'Status Updates'),
      // the staff role that sees every ticket; not created if missing
      support: str('DISCORD_SUPPORT_ROLE', 'Support,Staff,Moderator,Mod,Team'),
    },
    status: {
      // the API the status embed reads; the bot runs on the same box as the API
      apiUrl: str('DISCORD_API_URL', `http://127.0.0.1:${str('PORT', '3000')}`).replace(/\/+$/, ''),
      intervalMs: Math.max(60000, Number(str('DISCORD_STATUS_INTERVAL_MS', '300000')) || 300000),
      // the networks whose going down pings the Status Updates role; the rest are only listed
      mainChains: list('DISCORD_MAIN_CHAINS', 'ETH,BTC,SOL,LTC,BCH,DOGE,XRP,POL,BASE,ARB,OP,BNB,AVAX'),
    },
    log: {
      // the Message Content intent (privileged, a switch in the portal) lets the
      // mod-log show what a deleted or edited message said
      messageContent: flag('DISCORD_MESSAGE_CONTENT', false),
    },
    tickets: {
      category: str('DISCORD_TICKET_CATEGORY', 'Tickets'),
      max: Math.min(50, Math.max(1, Number(str('DISCORD_TICKET_MAX', '45')) || 45)),
    },
    antibot: {
      action: str('DISCORD_ANTIBOT_ACTION', 'kick').toLowerCase(),
    },
    brand: {
      name: str('DISCORD_BRAND_NAME', 'Etheroute'),
      site: str('SITE_URL', 'https://etheroute.com'),
    },
    dataFile: str('DISCORD_DATA_FILE', path.join(dataDir, 'discord.json')),
    syncCommands: str('DISCORD_SYNC_COMMANDS', 'true') !== 'false',
  };
}

/** What stops the bot from starting, in words for the person at the terminal. */
function problems(config) {
  const list = [];
  if (!config.token) list.push('DISCORD_BOT_TOKEN is not set (Developer Portal → your app → Bot → Reset Token).');
  if (!config.guildId) list.push('DISCORD_GUILD_ID is not set (right-click the server → Copy Server ID).');
  else if (!/^\d{15,22}$/.test(config.guildId)) list.push(`DISCORD_GUILD_ID does not look like a server id: ${config.guildId}`);
  if (!ANTIBOT_ACTIONS.includes(config.antibot.action)) list.push(`DISCORD_ANTIBOT_ACTION must be one of ${ANTIBOT_ACTIONS.join(', ')}, not "${config.antibot.action}".`);
  return list;
}

module.exports = { read, problems, ANTIBOT_ACTIONS, ROOT };
