'use strict';

/**
 * /rules: the community's rules (the list shared with the Discord bot, in
 * src/utils/communityRules) as one Telegram message, numbered, with how
 * they are enforced under them.
 */

const { RULES, fill, enforcement } = require('../../src/utils/communityRules');
const { esc, b, i, cut } = require('./format');

function rulesText(config, { botUsername } = {}) {
  const bot = botUsername ? `@${botUsername}` : 'the bot';
  // the rules say "in {support}"; the enforcement note says "To report something, {support}"
  const place = `a private message to ${bot} (/support)`;
  const report = `open a ticket by messaging ${bot} privately with /support, or mention an admin`;
  const lines = [b(`${config.brand.name} rules`), i('Being here means agreeing to these. They are short; please read them once.'), ''];
  RULES.forEach((r, n) => {
    lines.push(`${b(`${n + 1}. ${r.title}`)}\n${esc(fill(r.text, { brand: config.brand.name, support: place }))}`, '');
  });
  lines.push(b('How this is enforced'));
  for (const line of enforcement({ support: report, verify: 'Press the button when you join and you can talk.' })) lines.push(esc(line));
  return cut(lines.join('\n'));
}

module.exports = { rulesText };
