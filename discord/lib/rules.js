'use strict';

/**
 * The server's rules, as two embeds for #rules: the rules themselves,
 * numbered so a moderator can say "rule 3", and how they are enforced.
 * Written for a payments community - merchants, the people who pay them,
 * and the scammers who follow money around - so the keys-and-seed-phrase
 * rule and the fake-support rule sit near the top. Posted on request with
 * /panel rules, never on start: a server that already has rules up should
 * not wake to a second copy.
 */

const { embed, COLORS } = require('./embeds');

const RULES = [
  { title: 'Be decent', text: 'Treat people the way you would at a shop counter. No harassment, hate, slurs, threats or personal attacks. Disagree with ideas, not with people.' },
  { title: 'Never share keys or seed phrases', text: 'Not in a channel, not in a DM, not with staff. Nobody from {brand} will ever ask for your private key, recovery phrase, password or 2FA code. Anyone who does is a scammer - report them.' },
  { title: 'No scams, phishing or "support" in DMs', text: 'Do not DM members offering help, wallets, giveaways, recovery services or "verification". Real support happens in a ticket in {support}. Fake links, fake giveaways and impersonating staff or {brand} are an instant ban.' },
  { title: 'No unsolicited promotion', text: 'No advertising other projects, referral links, token shilling, "DM me" posts or server invites unless staff have said yes. Merchants: showing what you built with {brand}, in the right channel, is welcome.' },
  { title: 'No financial advice or price talk', text: 'This is a payments community, not a trading floor. No "buy this", no pump talk, no signals, no promised returns.' },
  { title: 'Stay on topic, stay readable', text: 'Use channels for what they are named. No spam, floods, walls of emoji, mass mentions or the same message in several channels. English in public channels, so everyone - staff included - can follow.' },
  { title: 'Keep it safe for work', text: 'No NSFW, gore or shock content, including in avatars, names and statuses.' },
  { title: 'Respect privacy', text: 'Do not post other people\'s personal information - addresses, IDs, transactions that are not yours, screenshots of private conversations - without their consent.' },
  { title: 'One account, one person', text: 'No alts, no self-bots, no getting around a timeout or a ban. Bot accounts need staff approval before they join.' },
  { title: 'Support goes through tickets', text: 'Open one in {support} instead of pinging or DMing staff. Include payment ids, the network and screenshots - and never your keys.' },
  { title: 'Follow Discord\'s Terms and Community Guidelines', text: 'They apply here, on top of these rules.' },
  { title: 'Staff have the final say', text: 'If something is not listed but clearly hurts the community, staff can still act. Disagree with a decision? Open a ticket rather than arguing it out in public.' },
];

function fill(text, config, found) {
  const support = found.channels.support ? found.channels.support.toString() : '#support';
  return text.replace(/\{brand\}/g, config.brand.name).replace(/\{support\}/g, support);
}

function panel(config, found) {
  const antibot = found.channels.antibot ? found.channels.antibot.toString() : '#anti-bot';
  const support = found.channels.support ? found.channels.support.toString() : '#support';
  const verify = found.channels.verify ? found.channels.verify.toString() : '#verify';
  return {
    embeds: [
      embed({
        title: `${config.brand.name} server rules`,
        description: `Being here means agreeing to these. They are short; please read them once.`,
        color: COLORS.brand,
        fields: RULES.map((r, i) => ({ name: `${i + 1}. ${r.title}`, value: fill(r.text, config, found), inline: false })),
        timestamp: false,
      }),
      embed({
        title: 'How this is enforced',
        description: [
          `Most things start with a **warning**; after that a **timeout**, a **kick** or a **ban**, depending on what it was and how often. Scams, phishing, fishing for keys and raids skip straight to a ban.`,
          `${antibot} is a trap for spam bots: posting anything there removes you automatically, no matter who you are.`,
          `To report something, open a ticket in ${support} or mention a moderator. **Staff will never DM you first.**`,
          `New here? Press **Verify** in ${verify} to unlock the server.`,
        ].join('\n\n'),
        color: COLORS.muted,
        footer: `${config.brand.name} · ${config.brand.site.replace(/^https?:\/\//, '')}`,
        timestamp: false,
      }),
    ],
  };
}

/** Post the rules in #rules. `force` posts a fresh copy even if the last one is still there. */
async function ensurePanel(ctx, guild, { force = false } = {}) {
  const channel = ctx.found.channels.rules;
  if (!channel) {
    ctx.log.warn('no rules channel found - set DISCORD_RULES_CHANNEL to its name or id');
    return null;
  }
  const remembered = ctx.store.data.panels.rules;
  if (!force && remembered && remembered.channelId === channel.id) {
    const existing = await channel.messages.fetch(remembered.messageId).catch(() => null);
    if (existing) return existing;
  }
  const message = await channel.send(panel(ctx.config, ctx.found));
  ctx.store.update('panels', (p) => { p.rules = { channelId: channel.id, messageId: message.id, at: new Date().toISOString() }; });
  ctx.log.info(`rules posted in #${channel.name}`);
  return message;
}

module.exports = { RULES, panel, ensurePanel, fill };
