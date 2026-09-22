# The Etheroute Discord bot

One process, next to the API, on the one server named in `.env`. It:

- posts a **verification panel** in `#verify` - the button gives the **Member** role, and the rest of the server is gated on that role;
- **welcomes** each new member in `#welcome`, with where to go next;
- keeps a **status embed** in `#status` - the platform services, how many networks are up, which are degraded or down, the last few changes - edited every five minutes from the API on the same box. When the picture changes a note goes under it, and the **Status Updates** role is pinged when it matters: a platform service, the API itself, or one of the **main networks** (Bitcoin, Ethereum, Solana, Litecoin, Bitcoin Cash, Dogecoin, XRP, Polygon, Base, Arbitrum, Optimism, BNB, Avalanche - `DISCORD_MAIN_CHAINS`) going down or coming back. One of the sixty smaller networks going down is noted without a ping;
- runs **support tickets**: a panel in `#support` (and `/support`) opens a private channel under a *Tickets* category that only the person, the Support role and admins can see; `/ticket` closes it or lets people in and out; on close the transcript goes to `#ticket-logs` (or the mod-log) and to the person by DM;
- lets people **claim roles** in `#roles` with buttons: **Merchant**, **Buyer**, **Announcements** (what `/announce` can ping) and **Status Updates**;
- keeps an **anti-bot** channel: a notice says not to post there, and anyone who does is kicked on the spot (or banned, if you prefer) - the spam bots that post in every channel they can see are gone before a person notices them;
- answers the usual **slash commands**: `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/purge`, `/slowmode`, `/lock`, `/unlock`, `/role`, `/nick`, `/giveaway`, `/announce`, `/panel`, `/status`, `/support`, `/ticket`, `/userinfo`, `/serverinfo`, `/avatar`, `/ping`, `/help`;
- keeps a **mod-log** in `#mod-log`: a card for every command it runs, and for everything done by hand as well - messages deleted or edited, members joining and leaving, kicks, bans and timeouts from the Discord client, roles and nicknames changing, channels and roles made, renamed or removed - with who did it, read from the audit log.

## Setup, once

1. **The application.** [Developer Portal](https://discord.com/developers/applications) → your application → **Bot**:
   - **Reset Token** and copy it. This is the one secret; it goes in `.env` and nowhere else. If it has ever been pasted into a chat, an issue or a screenshot, reset it again.
   - Under **Privileged Gateway Intents** turn on **Server Members Intent**. Without it the bot cannot see people joining, so no welcome and no member count. (Message Content is not needed: the anti-bot trap only needs to know *that* someone posted.)
2. **`.env`**, in the project root - the same file the API reads:
   ```
   DISCORD_BOT_TOKEN=...            # from step 1
   DISCORD_GUILD_ID=...             # right-click the server → Copy Server ID (Developer Mode on)
   DISCORD_CLIENT_ID=...            # General Information → Application ID (only for the invite link)
   ```
   The client secret is for OAuth sign-in and the bot does not use it; leave it out.
3. **Invite the bot.** Run `npm run discord:channels` - it prints the invite link with exactly the permissions the commands need (no Administrator). Open it, pick the server, approve.
4. **The role order.** Server Settings → Roles: drag the bot's role **above** `Member` (and above anyone it should be able to kick). Discord refuses to let a bot give a role, kick or time out anyone at or above its own highest role.
5. **The channels.** The bot finds them by name - emoji, dashes and case do not matter, so `👋-welcome`, `✅︱verify` and `anti・bot` all count:

   | purpose | looked for, in order | override |
   |---|---|---|
   | welcome | `welcome`, `welcomes`, `hello` | `DISCORD_WELCOME_CHANNEL` |
   | verify | `verify`, `verification`, `verify-here` | `DISCORD_VERIFY_CHANNEL` |
   | anti-bot | `anti-bot`, `antibot`, `anti-spam`, `bot-trap` | `DISCORD_ANTIBOT_CHANNEL` |
   | mod-log | `mod-log`, `mod-logs`, `modlog`, `logs`, `audit-log` | `DISCORD_LOG_CHANNEL` |
   | rules | `rules`, `info` | `DISCORD_RULES_CHANNEL` |
   | status | `status`, `service-status`, `uptime` | `DISCORD_STATUS_CHANNEL` |
   | roles | `roles`, `get-roles`, `self-roles`, `role-select`, `pick-roles`, `claim-roles` | `DISCORD_ROLES_CHANNEL` |
   | support | `support`, `tickets`, `help`, `open-a-ticket`, `create-a-ticket` | `DISCORD_SUPPORT_CHANNEL` |
   | transcripts | `ticket-logs`, `transcripts`, `ticket-transcripts` (falls back to the mod-log) | `DISCORD_TRANSCRIPTS_CHANNEL` |

   An override takes a channel id or a name (or a comma list). The roles are named the same way - `DISCORD_MEMBER_ROLE` (default `Member`), and the four people claim for themselves: `DISCORD_MERCHANT_ROLE`, `DISCORD_BUYER_ROLE`, `DISCORD_ANNOUNCEMENTS_ROLE`, `DISCORD_STATUS_ROLE` (defaults `Merchant`, `Buyer`, `Announcements`, `Status Updates`). Any of the five that does not exist is created. `DISCORD_SUPPORT_ROLE` (default `Support`, `Staff`, `Moderator`, `Mod`, `Team`) is the staff role that sees every ticket; it is yours and is not created - without it, tickets are visible to their opener and admins only.

   Permissions that make the gate work:
   - `@everyone` sees **only** `#welcome`, `#verify`, `#rules` and `#anti-bot`; every other channel is visible to **Member**.
   - In `#verify`, `#welcome`, `#roles` and `#status`, `@everyone` cannot send messages. In `#anti-bot`, `@everyone` **can** - that is the trap - and the bot has *Manage Messages* there.
   - `#status`, `#roles` and `#support` are best made visible to **Member** only, so the buttons and the pings reach verified people.
   - `#mod-log` and `#ticket-logs` are for staff: nobody else should see them.
   - The bot needs **View Audit Log** (in the invite) for the mod-log to say who deleted, kicked or banned. To see *what* a deleted or edited message said, turn on the **Message Content** intent in the portal and set `DISCORD_MESSAGE_CONTENT=true`; without it the card names the author and channel and says the text is not available.
6. **Run it.**
   ```
   npm run discord:channels    # read-only: lists channels and roles, and which the bot would use
   npm run discord             # starts the bot
   ```
   On start it logs what it found, registers the slash commands on the server (they appear within a few seconds; there is no hour-long wait because they are per-server, not global), posts the verification panel, the anti-bot notice, the role-picker, the ticket panel and the status embed if they are not already there, and picks up any giveaway still running.

   The status embed reads `GET /api/status` and `/api/status/chains` from `DISCORD_API_URL` - by default `http://127.0.0.1:<PORT>`, the API on the same machine. If the API answers on another host or the bot runs elsewhere, set it (`https://etheroute.com` works too; both endpoints are public).

   In production, run it under the same process manager as the API (`pm2 start discord/index.js --name etheroute-bot`, or a second systemd unit). It reads `.env` from the project root.

## Everything it knows from `.env`

| key | default | what |
|---|---|---|
| `DISCORD_BOT_TOKEN` | - | the bot's token; required |
| `DISCORD_GUILD_ID` | - | the server; required |
| `DISCORD_CLIENT_ID` | - | for the invite link |
| `DISCORD_*_CHANNEL`, `DISCORD_MEMBER_ROLE` | see above | where things are |
| `DISCORD_ANTIBOT_ACTION` | `kick` | `kick` or `ban` for whoever posts in the anti-bot channel |
| `DISCORD_API_URL` | `http://127.0.0.1:<PORT>` | where the status embed reads `/api/status` from |
| `DISCORD_STATUS_INTERVAL_MS` | `300000` | how often the status embed is refreshed (never under a minute) |
| `DISCORD_MAIN_CHAINS` | `ETH,BTC,SOL,LTC,BCH,DOGE,XRP,POL,BASE,ARB,OP,BNB,AVAX` | the networks whose going down pings Status Updates |
| `DISCORD_MESSAGE_CONTENT` | `false` | ask for the Message Content intent so the mod-log can show deleted and edited text |
| `DISCORD_SUPPORT_ROLE` | `Support,Staff,Moderator,Mod,Team` | the staff role that sees tickets |
| `DISCORD_TICKET_CATEGORY` | `Tickets` | the category tickets open under (made if missing) |
| `DISCORD_TICKET_MAX` | `45` | how many tickets may be open at once (a category holds 50 channels) |
| `DISCORD_BRAND_NAME` | `Etheroute` | the name on panels and footers |
| `SITE_URL` | `https://etheroute.com` | the site in footers (the API's own key) |
| `DISCORD_DATA_FILE` | `data/discord.json` | where panel ids, giveaways and warnings are kept |
| `DISCORD_SYNC_COMMANDS` | `true` | `false` to skip re-registering the commands on start |

## The commands

Discord hides each command from people without its permission; the bot checks the permission again when the command runs. Nobody can act on themselves, the owner, the bot, or anyone whose highest role is at or above their own.

| command | needs | does |
|---|---|---|
| `/kick user [reason]` | Kick Members | DMs them the reason, kicks |
| `/ban user [reason] [delete_days]` | Ban Members | bans (in the server or not), deletes up to 7 days of their messages |
| `/unban user_id [reason]` | Ban Members | lifts a ban |
| `/timeout user duration [reason]` | Moderate Members | mutes for `10m`, `2h`, `1d`, `1h30m` - up to 28 days |
| `/untimeout user [reason]` | Moderate Members | lifts it early |
| `/warn user reason` | Moderate Members | a warning on their record, and a DM |
| `/warnings list\|remove\|clear user` | Moderate Members | the record |
| `/purge amount [user] [bots]` | Manage Messages | deletes up to 100 recent messages, optionally one person's or only bots' |
| `/slowmode wait [channel]` | Manage Channels | `5s` … `6h`, or `off` |
| `/lock` / `/unlock [channel] [reason]` | Manage Channels | stops `@everyone` posting, and lets them again |
| `/role add\|remove user role` | Manage Roles | a role on or off |
| `/nick user [name]` | Manage Nicknames | sets or clears a nickname |
| `/giveaway start duration prize [winners] [channel]` | Manage Server | a giveaway with an Enter button; `end`, `reroll` and `list` too |
| `/announce title message [channel] [color] [ping]` | Manage Messages | an embed in the bot's voice; `ping` is nobody, the Announcements role, or @everyone |
| `/panel verify\|antibot\|roles\|status\|support\|rules\|check` | Manage Server | re-posts a panel (or posts the rules - those only on request), or shows what the bot found |
| `/status` | anyone | the status embed, to you only, read fresh |
| `/support [subject]` | anyone | opens a ticket; without a subject, asks in a form |
| `/ticket close [reason]` | the opener or staff | closes the ticket; transcript to `#ticket-logs` and to the opener |
| `/ticket add\|remove user` | staff | lets someone into the ticket, or out |
| `/ticket list` | staff | the tickets open right now |
| `/userinfo`, `/serverinfo`, `/avatar`, `/ping`, `/help` | anyone | the usual |

## Where things live

```
discord/
  index.js            starts it: reads .env, refuses with a clear line if something is missing
  bot.js              the client, the events, the command dispatch
  config.js           .env → settings, and what is wrong with them
  commands/           one file per slash command: { data, requires, execute }
  lib/
    guild.js          finding channels and roles by loose name or id
    verify.js         the panel and its button
    antibot.js        the notice and the trap
    welcome.js        the welcome card
    roles.js          the role-picker and its buttons
    status.js         the status embed, its refresh and the change note
    modlog.js         the mod-log cards for what happens by hand, with the audit log
    tickets.js        the ticket panel, form, channel, transcript and close
    rules.js          the server rules and how they are enforced, for /panel rules
    giveaways.js      start, enter, end, reroll, resume
    moderation.js     who may act on whom; the mod-log card; the DM
    embeds.js         the palette and the embed helper
    duration.js       "1h30m" and back
    store.js          data/discord.json
    invite.js         the invite link and the permissions it asks for
    log.js            the API's logger, tagged [discord]
  scripts/channels.js a read-only look at the server
```

Tests: `node --test tests/discord.test.js` - everything above without a Discord connection.
