'use strict';

/**
 * The community's rules, one list for every place they are shown: the
 * Discord #rules embeds and the Telegram /rules message. Numbered where
 * shown so a moderator can say "rule 3". Written for a payments
 * community - merchants, the people who pay them, and the scammers who
 * follow money around - so the keys-and-seed-phrase rule and the
 * fake-support rule sit near the top. {brand} and {support} are filled in
 * by whoever shows them.
 */

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

/** Fill the placeholders: the brand, and how support is reached in that place. */
function fill(text, { brand, support }) {
  return text.replace(/\{brand\}/g, brand).replace(/\{support\}/g, support);
}

/** The enforcement note, in plain sentences the caller can format. */
function enforcement({ antibot = null, support, verify = null }) {
  return [
    'Most things start with a warning; after that a timeout, a kick or a ban, depending on what it was and how often. Scams, phishing, fishing for keys and raids skip straight to a ban.',
    antibot ? `${antibot} is a trap for spam bots: posting anything there removes you automatically, no matter who you are.` : null,
    `To report something, ${support}. Staff will never DM you first.`,
    verify ? `New here? ${verify}` : null,
  ].filter(Boolean);
}

module.exports = { RULES, fill, enforcement };
