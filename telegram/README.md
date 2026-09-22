# The Etheroute Telegram bot

One process, next to the API and the Discord bot. On Telegram it:

- keeps a **pinned status message** current in the channel (or the group, if there is no channel) - the platform services, how many networks are up, which are degraded or down, the last few changes - and **posts** when a main network, a platform service or the API itself goes down or comes back; lesser changes only edit the pin, so subscribers are not pinged for noise;
- posts **announcements** admins send it privately with `/announce` - a preview with a Post button, so nothing goes out by accident;
- **gates the group**: whoever joins is muted until they press *I am a person*; ten minutes without a press and they are shown out (a kick, so they can try again); links in a newcomer's first day are deleted and earn an hour's mute;
- answers the **moderation commands** in the group - `/ban`, `/kick`, `/mute 1h`, `/unmute`, `/warn`, `/warnings`, `/clearwarnings`, `/del`, `/purge`, `/pin`, `/unpin` - as a reply to the person's message, for admins only;
- runs **support tickets** by private message: a person writes to the bot, the message is copied to the staff chat with who it is from, staff reply there and the reply is copied back; `/close` as a reply ends it;
- lets **merchants link their Etheroute account** from the dashboard and then messages them when a payment settles or a payout finishes, and answers `/stats`, `/recent`, `/notify`, `/unlink`;
- logs joins, leaves, bans, mutes and the gate's doings to the **staff chat**.

It talks to the Bot API directly over long polling - no framework, no public URL, no webhook to set up.

## Setup, once

1. **The bot.** Talk to [@BotFather](https://t.me/BotFather): `/newbot` (or `/token` for one you have). Put the token in `.env` as `TELEGRAM_BOT_TOKEN`. If it has ever been pasted into a chat, a screenshot or an issue, `/revoke` and take the new one. While there: `/setprivacy` → **Disable**, so the bot sees every message in the group (it needs to, for the gate and the link filter).
2. **The chats.** Add the bot to the group **as an administrator** with *Delete messages*, *Ban users* (which covers muting) and *Pin messages*. If you have a broadcast channel too, add it there as an admin with *Post messages*, *Edit messages of others* and *Pin messages*. Make a small private group for staff and add the bot to it (an admin is not needed there).
3. **The ids.** Post anything in each chat, then:
   ```
   npm run telegram:whoami
   ```
   It prints every chat that has written to the bot, with its id, and whether the bot has what it needs in each. Your own id shows when you message the bot privately first.
4. **`.env`**, in the project root:
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_GROUP_ID=-100...           # the community group: the gate, the moderation, and posts when there is no channel
   TELEGRAM_CHANNEL_ID=@yourchannel     # optional: a broadcast channel for the status pin and announcements
   TELEGRAM_LOG_CHAT_ID=-100...         # optional: the staff group - mod-log and support tickets
   TELEGRAM_ADMIN_IDS=7959617162        # optional: people who may /announce and moderate even without admin rights in the chat
   ```
   Admins of the chat itself count as admins without being listed.
5. **Run it.**
   ```
   npm run telegram
   ```
   On start it logs what it can see and what it lacks, sets the command menus, pins the status message if none is there, and starts listening. In production, run it under the same process manager as the API (`pm2 start telegram/index.js --name etheroute-telegram`).

## Merchants: payments on Telegram

A merchant opens the dashboard → **Account → Notifications → Connect** and gets a link (`t.me/<bot>?start=link_<code>`) good for ten minutes. Pressing it opens the bot; the bot hands the code to the API, which binds the merchant's account to that chat. From then on the **API itself** messages them - a payment settled (amount, network, reference, transaction), a payout finished (completed, partial or failed) - and the two switches on the dashboard, or `/notify` in the chat, say which. `/stats` gives today / 7 days / 30 days / all time, the balance across wallets, open checkouts and payouts; `/recent` the last payments; `/unlink` ends it. Blocking the bot unlinks the account the first time Telegram says so.

The API's endpoints for this live under `/api/telegram` (the dashboard, behind the usual credential) and `/api/telegram/internal` (the bot, behind a secret both derive from the bot token - nothing else to configure). The bot finds the API at `TELEGRAM_API_URL`, else `DISCORD_API_URL`, else `http://127.0.0.1:<PORT>`.

## Everything it knows from `.env`

| key | default | what |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | - | the bot's token; required |
| `TELEGRAM_GROUP_ID` | - | the community group; required unless a channel is set |
| `TELEGRAM_CHANNEL_ID` | - | a broadcast channel for the status pin and announcements (else the group) |
| `TELEGRAM_LOG_CHAT_ID` | - | the staff group: mod-log and support tickets |
| `TELEGRAM_SUPPORT_CHAT_ID` | the staff group | a different group for tickets, if wanted |
| `TELEGRAM_ADMIN_IDS` | - | comma-separated user ids who count as admins everywhere |
| `TELEGRAM_API_URL` | `DISCORD_API_URL`, else `http://127.0.0.1:<PORT>` | where the status and the merchant numbers are read from |
| `TELEGRAM_STATUS_INTERVAL_MS` | `300000` | how often the pin is refreshed (never under a minute) |
| `TELEGRAM_MAIN_CHAINS` | `DISCORD_MAIN_CHAINS`, else the thirteen main networks | the networks whose going down is posted |
| `TELEGRAM_VERIFY_TIMEOUT_MS` | `600000` | how long a newcomer has to press the button |
| `TELEGRAM_LINK_GRACE_MS` | `86400000` | how long after joining a link counts as spam |
| `TELEGRAM_BRAND_NAME` | `DISCORD_BRAND_NAME`, else `Etheroute` | the name in messages |
| `TELEGRAM_DATA_FILE` | `data/telegram.json` | the pin, the newcomers waiting, warnings, tickets |
| `TELEGRAM_BOT_USERNAME` | asked of Telegram | the API's shortcut for the deep link |

## The commands

| where | command | who | does |
|---|---|---|---|
| anywhere | `/status` | anyone | the status picture, fresh |
| anywhere | `/rules` | anyone | the community rules |
| anywhere | `/id` | anyone | ids for the chat, you and, in a reply, them |
| anywhere | `/help` | anyone | this list, trimmed to what you may use |
| private | `/support` | anyone | opens a ticket; every message after is relayed to staff |
| private | `/announce Headline⏎body` | admins | a preview; Post sends it to the channel or group |
| private | `/stats`, `/recent [n]`, `/notify [paid\|payouts on\|off]`, `/unlink` | linked merchants | their numbers and their settings |
| group, as a reply | `/ban [reason]`, `/kick [reason]` | admins | out; a kick may come back |
| group, as a reply | `/mute [1h] [reason]`, `/unmute` | admins | muted for the time given (an hour if none), or up to a year, or until unmuted |
| group, as a reply | `/warn reason`, `/warnings`, `/clearwarnings` | admins | the record |
| group, as a reply | `/del`, `/purge`, `/pin`, `/unpin` | admins | that message; everything from it to here; the pin |
| staff chat, as a reply | anything, `/close [reason]` | staff | copied to the person; the ticket ended |

Never on an admin, and never on a channel's own posts.

## Where things live

```
telegram/
  index.js            starts it: reads .env, refuses with a clear line if something is missing
  bot.js              the update router: private chats, the group, the staff chat, buttons
  config.js           .env → settings, and what is wrong with them
  lib/
    api.js            the Bot API over fetch, and the long-polling loop
    format.js         Telegram's HTML, safely
    status.js         the pinned status message and the post when it matters
    announce.js       /announce with a preview and a Post button
    verify.js         the gate on newcomers and the link filter
    moderation.js     admins, the group commands, the staff-chat card
    support.js        tickets by private message, relayed to staff
    merchant.js       the linked-account commands, against the API's internal endpoints
    rules.js          /rules from the shared list
    log.js            the API's logger, tagged [telegram]
  scripts/whoami.js   who the bot is, what it sees, every id it knows
src/services/TelegramNotifyService.js   the API's side: link codes, the secret, the messages, the numbers
src/routes/telegram.js                  /api/telegram (dashboard) and /api/telegram/internal (bot)
```

Tests: `node --test tests/telegram.test.js tests/telegram-merchant.test.js` - the bot against a stand-in Bot API, and the merchant link against the real app.
