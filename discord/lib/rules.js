'use strict';

/**
 * The server's rules, as two embeds for #rules: the rules themselves
 * (the list shared with the Telegram bot, in src/utils/communityRules),
 * numbered so a moderator can say "rule 3", and how they are enforced.
 * Posted on request with /panel rules, never on start: a server that
 * already has rules up should not wake to a second copy.
 */

const { embed, COLORS } = require('./embeds');

const { RULES, fill: fillShared } = require('../../src/utils/communityRules');

function fill(text, config, found) {
  const support = found.channels.support ? found.channels.support.toString() : '#support';
  return fillShared(text, { brand: config.brand.name, support });
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
