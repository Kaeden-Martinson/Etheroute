/**
 * The Discord bot, without Discord: the config it reads, how it finds the
 * server's channels and roles by loose name, the rule that keeps a
 * moderator from acting above their station, the anti-bot trap's
 * decision, the giveaway draw, the store, and every slash command's
 * definition as Discord would receive it.
 */
'use strict';

process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits, PermissionsBitField, ChannelType, AuditLogEvent } = require('discord.js');

const config = require('../discord/config');
const guildLib = require('../discord/lib/guild');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../discord/lib/duration');
const { canActOn, isStaff, caseEmbed, noticeEmbed } = require('../discord/lib/moderation');
const antibot = require('../discord/lib/antibot');
const verify = require('../discord/lib/verify');
const welcome = require('../discord/lib/welcome');
const giveaways = require('../discord/lib/giveaways');
const roles = require('../discord/lib/roles');
const status = require('../discord/lib/status');
const modlog = require('../discord/lib/modlog');
const tickets = require('../discord/lib/tickets');
const rules = require('../discord/lib/rules');
const { Store } = require('../discord/lib/store');
const { embed, COLORS } = require('../discord/lib/embeds');
const { inviteUrl, permissions, NEEDED } = require('../discord/lib/invite');
const commands = require('../discord/commands');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-discord-'));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// ── stand-ins for the bits of discord.js the logic touches ───────────────
const channel = (id, name, type = ChannelType.GuildText) => ({ id, name, type, toString: () => `<#${id}>` });
const role = (id, name, position) => ({ id, name, position, toString: () => `<@&${id}>` });
function member(id, { highest = 0, perms = [], guild } = {}) {
  return { id, guild, roles: { highest: { position: highest } }, permissions: new PermissionsBitField(perms) };
}
function fakeGuild({ channels = [], roles = [], ownerId = 'owner', botId = 'bot', botHighest = 50 } = {}) {
  const g = { id: 'guild', ownerId, channels: { cache: new Map(channels.map((c) => [c.id, c])) }, roles: { cache: new Map(roles.map((r) => [r.id, r])) }, members: {} };
  g.members.me = member(botId, { highest: botHighest, guild: g });
  return g;
}

describe('The config', () => {
  test('defaults fit the usual server; ids and names are both accepted; the token comes only from the environment', () => {
    const c = config.read({});
    assert.strictEqual(c.token, '');
    assert.strictEqual(c.channels.verify, 'verify,verification,verify-here');
    assert.strictEqual(c.channels.antibot, 'anti-bot,antibot,anti-spam,bot-trap');
    assert.strictEqual(c.roles.member, 'Member');
    assert.deepStrictEqual([c.roles.merchant, c.roles.buyer, c.roles.announcements, c.roles.status], ['Merchant', 'Buyer', 'Announcements', 'Status Updates']);
    assert.strictEqual(c.channels.status, 'status,service-status,uptime');
    assert.ok(c.channels.roles.startsWith('roles,get-roles'));
    assert.strictEqual(c.status.apiUrl, 'http://127.0.0.1:3000', 'the API on the same box');
    assert.strictEqual(c.status.intervalMs, 300000);
    assert.strictEqual(config.read({ PORT: '80' }).status.apiUrl, 'http://127.0.0.1:80');
    assert.strictEqual(config.read({ DISCORD_API_URL: 'https://etheroute.com/' }).status.apiUrl, 'https://etheroute.com');
    assert.strictEqual(config.read({ DISCORD_STATUS_INTERVAL_MS: '5' }).status.intervalMs, 60000, 'never faster than a minute');
    assert.deepStrictEqual(c.status.mainChains.slice(0, 4), ['ETH', 'BTC', 'SOL', 'LTC']);
    assert.deepStrictEqual(config.read({ DISCORD_MAIN_CHAINS: 'btc, eth' }).status.mainChains, ['BTC', 'ETH']);
    assert.strictEqual(c.log.messageContent, false);
    assert.strictEqual(config.read({ DISCORD_MESSAGE_CONTENT: 'yes' }).log.messageContent, true);
    assert.strictEqual(c.roles.support, 'Support,Staff,Moderator,Mod,Team');
    assert.deepStrictEqual(c.tickets, { category: 'Tickets', max: 45 });
    assert.strictEqual(config.read({ DISCORD_TICKET_MAX: '900' }).tickets.max, 50, 'a category holds fifty channels');
    assert.strictEqual(c.antibot.action, 'kick');
    assert.ok(c.dataFile.endsWith(path.join('data', 'discord.json')));
    const custom = config.read({ DISCORD_BOT_TOKEN: ' t ', DISCORD_GUILD_ID: '1551674888060936323', DISCORD_ANTIBOT_ACTION: 'BAN', DISCORD_VERIFY_CHANNEL: '123456789012345678', DATA_DIR: '/x' });
    assert.strictEqual(custom.token, 't');
    assert.strictEqual(custom.antibot.action, 'ban');
    assert.strictEqual(custom.channels.verify, '123456789012345678');
    assert.strictEqual(custom.dataFile, path.join('/x', 'discord.json'));
  });

  test('what stops a start is said in words', () => {
    const none = config.problems(config.read({}));
    assert.strictEqual(none.length, 2);
    assert.ok(none[0].includes('DISCORD_BOT_TOKEN'));
    assert.ok(none[1].includes('DISCORD_GUILD_ID'));
    const bad = config.problems(config.read({ DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: 'abc', DISCORD_ANTIBOT_ACTION: 'nuke' }));
    assert.strictEqual(bad.length, 2);
    assert.ok(bad[0].includes('does not look like a server id'));
    assert.ok(bad[1].includes('kick, ban'));
    assert.deepStrictEqual(config.problems(config.read({ DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: '1551674888060936323' })), []);
  });
});

describe('Finding the furniture', () => {
  const channels = [
    channel('1', '👋-welcome'), channel('2', '✅︱verify'), channel('3', 'anti・bot'), channel('4', 'general'),
    channel('5', 'mod-logs'), channel('6', 'rules-and-info'), channel('7', 'Voice', ChannelType.GuildVoice), channel('8', 'verify-help'),
  ];
  const g = fakeGuild({ channels, roles: [role('123456789012345678', 'Admin', 10), role('r2', 'Member', 2), role('guild', '@everyone', 0)] });

  test('decorated names match plain ones: emoji, dashes and case do not count', () => {
    assert.strictEqual(guildLib.normalise('✅︱Verify-Here'), 'verifyhere');
    assert.strictEqual(guildLib.resolveChannel(g, 'welcome').id, '1');
    assert.strictEqual(guildLib.resolveChannel(g, 'verify').id, '2', 'exact beats the prefix match verify-help');
    assert.strictEqual(guildLib.resolveChannel(g, 'anti-bot').id, '3');
    assert.strictEqual(guildLib.resolveChannel(g, 'mod-log,logs').id, '5', 'a prefix match on the first candidate');
    assert.strictEqual(guildLib.resolveChannel(g, 'rules').id, '6');
    assert.strictEqual(guildLib.resolveChannel(g, 'nothing,verify').id, '2', 'the list is tried in order');
    assert.strictEqual(guildLib.resolveChannel(g, '4'), null, 'a short number is neither an id nor a name here');
    assert.strictEqual(guildLib.resolveChannel(g, 'nope'), null);
    assert.strictEqual(guildLib.resolveChannel(g, 'voice'), null, 'a voice channel is not a text channel');
  });

  test('an id is taken as it is; a role is found the same way and @everyone never is', () => {
    const byId = fakeGuild({ channels: [channel('123456789012345678', 'whatever')] });
    assert.strictEqual(guildLib.resolveChannel(byId, '123456789012345678').name, 'whatever');
    assert.strictEqual(guildLib.resolveRole(g, 'member').id, 'r2');
    assert.strictEqual(guildLib.resolveRole(g, '123456789012345678').name, 'Admin');
    assert.strictEqual(guildLib.resolveRole(g, 'everyone'), null);
  });

  test('resolveAll names every purpose, found or not', () => {
    const found = guildLib.resolveAll(g, config.read({}));
    assert.deepStrictEqual(Object.keys(found.channels), ['welcome', 'verify', 'antibot', 'log', 'rules', 'status', 'roles', 'support', 'transcripts']);
    assert.strictEqual(found.channels.welcome.id, '1');
    assert.strictEqual(found.channels.antibot.id, '3');
    assert.strictEqual(found.channels.status, null);
    assert.deepStrictEqual(Object.keys(found.roles), ['member', 'merchant', 'buyer', 'announcements', 'status', 'support']);
    assert.strictEqual(found.roles.member.id, 'r2');
    assert.strictEqual(found.roles.merchant, null);
  });

  test('ensureRole makes the role when none matches, named as the first plain name in the spec', async () => {
    const made = [];
    const g2 = fakeGuild({ roles: [role('x', 'Staff', 5)] });
    g2.roles.create = async (opts) => { made.push(opts); return role('new', opts.name, 1); };
    const r = await guildLib.ensureRole(g2, '999999999999999999,Verified');
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.role.name, 'Verified');
    assert.strictEqual(made[0].mentionable, false);
    const again = await guildLib.ensureRole(g2, 'staff');
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.role.id, 'x');
  });
});

describe('Durations', () => {
  test('as people type them', () => {
    assert.strictEqual(parseDuration('10m'), 600000);
    assert.strictEqual(parseDuration('1h30m'), 5400000);
    assert.strictEqual(parseDuration('1H 30M'), 5400000);
    assert.strictEqual(parseDuration('7d'), 7 * 86400000);
    assert.strictEqual(parseDuration('2w'), 14 * 86400000);
    assert.strictEqual(parseDuration('45'), 45 * 60000, 'a bare number is minutes');
    assert.strictEqual(parseDuration('1.5h'), 5400000);
    assert.strictEqual(parseDuration(''), null);
    assert.strictEqual(parseDuration('soon'), null);
    assert.strictEqual(parseDuration('10x'), null);
    assert.strictEqual(parseDuration('0m'), null);
    assert.strictEqual(MAX_TIMEOUT_MS, 28 * 86400000);
  });
  test('and back', () => {
    assert.strictEqual(formatDuration(5400000), '1h 30m');
    assert.strictEqual(formatDuration(86400000 * 3 + 3600000 * 2 + 60000), '3d 2h', 'two parts at most');
    assert.strictEqual(formatDuration(500), '0s');
    assert.strictEqual(formatDuration(65000), '1m 5s');
  });
});

describe('Who may act on whom', () => {
  const g = fakeGuild({ botHighest: 50 });
  const mod = member('mod', { highest: 20, guild: g });

  test('not on themselves, the owner, the bot, or anyone at or above them - and the bot must be above the target too', () => {
    assert.strictEqual(canActOn(mod, member('mod', { highest: 20 }), g).ok, false);
    assert.strictEqual(canActOn(mod, member('owner', { highest: 1 }), g).reason, 'That is the server owner.');
    assert.strictEqual(canActOn(mod, member('bot', { highest: 50 }), g).reason, 'Not on myself.');
    assert.ok(canActOn(mod, member('peer', { highest: 20 }), g).reason.includes('at or above yours'));
    assert.ok(canActOn(mod, member('above', { highest: 30 }), g).reason.includes('at or above yours'));
    assert.ok(canActOn(mod, member('low', { highest: 5 }), g).ok);
    const tall = fakeGuild({ botHighest: 3 });
    assert.ok(canActOn(member('mod', { highest: 20 }), member('low', { highest: 5 }), tall).reason.includes('at or above mine'));
  });

  test('the owner may act on anyone below the bot; a target who left is fine', () => {
    const owner = member('owner', { highest: 1, guild: g });
    assert.ok(canActOn(owner, member('admin', { highest: 40 }), g).ok);
    assert.ok(canActOn(mod, null, g).ok);
  });

  test('staff is anyone who can kick, ban, manage messages or the server, or the owner', () => {
    assert.strictEqual(isStaff(member('a', { perms: [PermissionFlagsBits.KickMembers] })), true);
    assert.strictEqual(isStaff(member('b', { perms: [PermissionFlagsBits.ManageMessages] })), true);
    assert.strictEqual(isStaff(member('c', { perms: [PermissionFlagsBits.SendMessages] })), false);
    assert.strictEqual(isStaff(member('owner', { guild: g })), true);
    assert.strictEqual(isStaff(null), false);
  });

  test('the case card carries member, moderator and reason, in the action\'s colour', () => {
    const target = { id: 't', user: { tag: 'them#1', id: 't' }, toString: () => '<@t>', displayAvatarURL: () => 'https://cdn/x.png' };
    const card = caseEmbed({ action: 'kick', target, moderator: { user: { tag: 'mod#1', id: 'm' } }, reason: 'spam' }).toJSON();
    assert.strictEqual(card.title, '👢 Kicked');
    assert.strictEqual(card.color, COLORS.warn);
    assert.deepStrictEqual(card.fields.map((f) => f.name), ['Member', 'By', 'Reason']);
    assert.strictEqual(card.fields[0].value, '<@t> them#1 (t)');
    assert.strictEqual(card.fields[2].value, 'spam');
    assert.strictEqual(card.thumbnail.url, 'https://cdn/x.png');
    const none = caseEmbed({ action: 'ban', target, moderator: { user: { tag: 'mod#1', id: 'm' } } }).toJSON();
    assert.strictEqual(none.fields[2].value, 'No reason given');
    assert.strictEqual(none.color, COLORS.danger);
    const dm = noticeEmbed('Etheroute', 'anti-bot', 'posted in #anti-bot').toJSON();
    assert.ok(dm.description.includes('anti-bot channel of **Etheroute**'));
  });
});

describe('The anti-bot trap', () => {
  const trap = channel('trap', 'anti-bot');
  const ctx = { config: config.read({}), found: { channels: { antibot: trap } }, log: quiet };
  const msg = (over = {}) => ({ channelId: 'trap', author: { id: 'u', bot: false }, member: member('u', { perms: [PermissionFlagsBits.SendMessages] }), ...over });

  test('a person posting in the channel trips it; bots, webhooks, staff and other channels do not', () => {
    assert.strictEqual(antibot.shouldEnforce(msg(), ctx), true);
    assert.strictEqual(antibot.shouldEnforce(msg({ channelId: 'general' }), ctx), false);
    assert.strictEqual(antibot.shouldEnforce(msg({ author: { id: 'b', bot: true } }), ctx), false);
    assert.strictEqual(antibot.shouldEnforce(msg({ webhookId: 'w' }), ctx), false);
    assert.strictEqual(antibot.shouldEnforce(msg({ system: true }), ctx), false);
    assert.strictEqual(antibot.shouldEnforce(msg({ member: member('m', { perms: [PermissionFlagsBits.KickMembers] }) }), ctx), false);
    assert.strictEqual(antibot.shouldEnforce(msg(), { ...ctx, found: { channels: {} } }), false, 'no channel, no trap');
  });

  test('the notice says what happens, in the configured verb', () => {
    const kick = antibot.notice(config.read({})).embeds[0].toJSON();
    assert.strictEqual(kick.title, '🪤 Do not post in this channel');
    assert.ok(kick.description.includes('kicked automatically'));
    assert.strictEqual(kick.color, COLORS.critical);
    const ban = antibot.notice(config.read({ DISCORD_ANTIBOT_ACTION: 'ban' })).embeds[0].toJSON();
    assert.ok(ban.description.includes('banned automatically'));
  });

  test('enforce deletes, tells, kicks (or bans) and logs', async () => {
    const calls = [];
    const guild = { name: 'Etheroute', members: { ban: async (id, opts) => calls.push(['ban', id, opts.deleteMessageSeconds]) } };
    const message = {
      ...msg(), guild, channel: trap,
      author: { id: 'u', bot: false, tag: 'spam#1', send: async () => calls.push(['dm']) },
      member: { id: 'u', permissions: new PermissionsBitField([]), kick: async (reason) => calls.push(['kick', reason]), roles: { highest: { position: 0 } }, user: { tag: 'spam#1', id: 'u' }, toString: () => '<@u>', displayAvatarURL: () => 'https://cdn/u.png' },
      delete: async () => calls.push(['delete']),
    };
    const log = channel('log', 'mod-log');
    log.send = async (payload) => calls.push(['log', payload.embeds[0].toJSON().fields.find((f) => f.name === 'Action').value]);
    const kickCtx = { ...ctx, found: { channels: { antibot: trap, log } } };
    assert.strictEqual(await antibot.enforce(message, kickCtx), true);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['delete', 'dm', 'kick', 'log']);
    assert.ok(calls[2][1].includes('anti-bot channel'));
    assert.strictEqual(calls[3][1], 'Kicked');

    calls.length = 0;
    const banCtx = { ...kickCtx, config: config.read({ DISCORD_ANTIBOT_ACTION: 'ban' }) };
    await antibot.enforce(message, banCtx);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['delete', 'dm', 'ban', 'log']);
    assert.strictEqual(calls[2][2], 86400, 'a ban takes their last day of messages with it');
    assert.strictEqual(calls[3][1], 'Banned');
  });
});

describe('Verification and welcome', () => {
  const cfg = config.read({});

  test('the panel is one embed and one green Verify button with a fixed id', () => {
    const p = verify.panel(cfg, { roleName: 'Member', rulesChannel: channel('r', 'rules') });
    const e = p.embeds[0].toJSON();
    assert.strictEqual(e.title, 'Welcome to Etheroute');
    assert.ok(e.description.includes('**Member**') && e.description.includes('<#r>'));
    const button = p.components[0].toJSON().components[0];
    assert.strictEqual(button.custom_id, verify.BUTTON_ID);
    assert.strictEqual(button.label, 'Verify');
    assert.strictEqual(button.style, 3, 'success / green');
  });

  test('pressing it gives the role once, and says so quietly', async () => {
    const added = [];
    const replies = [];
    const roleM = role('m', 'Member', 2);
    const ctx = { found: { roles: { member: roleM }, channels: { roles: channel('p', 'roles') } }, log: quiet };
    const mk = (has) => ({
      user: { tag: 'new#1', id: 'n' }, guild: { name: 'Etheroute' },
      member: { roles: { cache: new Set(has ? ['m'] : []), add: async (r, why) => added.push([r.id, why]) } },
      reply: async (payload) => replies.push(payload),
    });
    await verify.handleButton(mk(false), ctx);
    assert.deepStrictEqual(added, [['m', 'Verified through the panel']]);
    assert.ok(replies[0].embeds[0].toJSON().description.includes('You are verified'));
    assert.ok(replies[0].embeds[0].toJSON().description.includes('Pick your roles in <#p>'));
    assert.strictEqual(replies[0].flags, 64, 'ephemeral');
    await verify.handleButton(mk(true), ctx);
    assert.strictEqual(added.length, 1);
    assert.ok(replies[1].embeds[0].toJSON().description.includes('already verified'));
    await verify.handleButton(mk(false), { found: { roles: {}, channels: {} }, log: quiet });
    assert.ok(replies[2].embeds[0].toJSON().description.includes('no Member role'));
  });

  test('the panel is posted once and remembered; a fresh one on demand', async () => {
    const sent = [];
    const verifyCh = channel('v', 'verify');
    let existing = null;
    verifyCh.send = async (payload) => { sent.push(payload); return { id: `msg${sent.length}` }; };
    verifyCh.messages = { fetch: async (id) => { if (existing === id) return { id }; throw new Error('gone'); } };
    const store = new Store(path.join(tmp(), 'discord.json'));
    const ctx = { config: cfg, store, log: quiet, found: { channels: { verify: verifyCh, rules: null }, roles: { member: role('m', 'Member', 2) } } };
    await verify.ensurePanel(ctx, {});
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.data.panels.verify.messageId, 'msg1');
    existing = 'msg1';
    await verify.ensurePanel(ctx, {});
    assert.strictEqual(sent.length, 1, 'still there: not posted again');
    existing = null;
    await verify.ensurePanel(ctx, {});
    assert.strictEqual(sent.length, 2, 'deleted by hand: posted again');
    await verify.ensurePanel(ctx, {}, { force: true });
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(await verify.ensurePanel({ ...ctx, found: { channels: {}, roles: {} } }, {}), null);
  });

  test('the welcome names them, counts them and points at #verify', async () => {
    const sent = [];
    const welcomeCh = channel('w', 'welcome');
    welcomeCh.send = async (payload) => sent.push(payload);
    const ctx = { config: cfg, log: quiet, found: { channels: { welcome: welcomeCh, verify: channel('v', 'verify'), rules: null, roles: channel('p', 'roles') } } };
    const m = { id: 'n', displayName: 'Newcomer', toString: () => '<@n>', guild: { name: 'Etheroute', memberCount: 42 }, user: { username: 'newcomer', tag: 'newcomer#0', createdAt: new Date('2024-01-01'), displayAvatarURL: () => 'https://cdn/a.png' } };
    assert.strictEqual(await welcome.onMemberAdd(m, ctx), true);
    const e = sent[0].embeds[0].toJSON();
    assert.strictEqual(e.title, 'Welcome, Newcomer!');
    assert.ok(e.description.includes('<@n>') && e.description.includes('<#v>'));
    assert.ok(e.description.includes('pick your roles in <#p>'));
    assert.strictEqual(e.fields[0].value, '#42');
    assert.strictEqual(e.thumbnail.url, 'https://cdn/a.png');
    assert.deepStrictEqual(sent[0].allowedMentions, { users: ['n'] });
    assert.strictEqual(await welcome.onMemberAdd(m, { ...ctx, found: { channels: {} } }), false);
  });
});

describe('Giveaways', () => {
  test('the draw picks distinct winners, never more than entered, and follows the rng', () => {
    const seq = [0.9, 0.1, 0.5];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    assert.deepStrictEqual(giveaways.pickWinners(['a', 'b', 'c', 'd'], 2, rng), ['d', 'a']);
    assert.deepStrictEqual(giveaways.pickWinners(['a', 'a', 'b'], 5, () => 0), ['a', 'b'], 'a double entry counts once');
    assert.deepStrictEqual(giveaways.pickWinners([], 3), []);
    const many = giveaways.pickWinners(Array.from({ length: 50 }, (_, n) => `u${n}`), 10);
    assert.strictEqual(new Set(many).size, 10);
  });

  test('the card says what, how many, who hosts, when it ends - then who won', () => {
    const g = { prize: 'A year of Pro', winners: 2, entrants: ['a', 'b', 'c'], hostId: 'h', endsAt: Date.now() + 3600000, ended: false };
    const open = giveaways.giveawayEmbed(g).toJSON();
    assert.strictEqual(open.title, '🎉 A year of Pro');
    assert.deepStrictEqual(open.fields.map((f) => f.name), ['Winners', 'Entries', 'Hosted by', 'Ends']);
    assert.strictEqual(open.fields[1].value, '3');
    assert.ok(open.footer.text.includes('left'));
    assert.strictEqual(giveaways.components(g)[0].toJSON().components[0].disabled, false);
    const done = giveaways.giveawayEmbed({ ...g, ended: true, winnerIds: ['b'] }).toJSON();
    assert.strictEqual(done.fields[3].name, 'Won by');
    assert.strictEqual(done.fields[3].value, '<@b>');
    assert.strictEqual(giveaways.components({ ...g, ended: true })[0].toJSON().components[0].disabled, true);
    assert.strictEqual(giveaways.giveawayEmbed({ ...g, ended: true, winnerIds: [] }).toJSON().fields[3].value, 'Nobody entered');
  });

  test('start, enter, leave, end and reroll through the store; a restart resumes what is open', async () => {
    const store = new Store(path.join(tmp(), 'discord.json'));
    const posted = [];
    const edits = [];
    const ch = channel('c', 'giveaways');
    ch.guild = { id: 'guild' };
    ch.send = async (payload) => { posted.push(payload); return { id: 'gm1' }; };
    ch.messages = { fetch: async () => ({ id: 'gm1', edit: async (p) => edits.push(p) }) };
    const client = { channels: { fetch: async () => ch } };
    const ctx = { store, log: quiet, client };

    const g = await giveaways.start(ctx, { channel: ch, prize: 'Stickers', winners: 1, durationMs: 60000, host: { id: 'h' } });
    assert.strictEqual(g.messageId, 'gm1');
    assert.ok(store.data.giveaways.gm1);
    giveaways.clearTimer('gm1');

    const replies = [];
    const press = (uid) => giveaways.enter({ message: { id: 'gm1', edit: async (p) => edits.push(p) }, user: { id: uid }, reply: async (p) => replies.push(p.embeds[0].toJSON().description) }, ctx);
    await press('a'); await press('b'); await press('a');
    assert.deepStrictEqual(store.data.giveaways.gm1.entrants, ['b']);
    assert.ok(replies[0].includes('in the draw') && replies[2].includes('left'));

    const result = await giveaways.end(ctx, 'gm1', { rng: () => 0 });
    assert.deepStrictEqual(result.winnerIds, ['b']);
    assert.strictEqual(store.data.giveaways.gm1.ended, true);
    assert.ok(posted[1].content.includes('<@b>') && posted[1].content.includes('**Stickers**'));
    assert.deepStrictEqual(posted[1].allowedMentions, { users: ['b'] });
    assert.strictEqual((await giveaways.end(ctx, 'gm1')).ok, false, 'ended is ended');
    assert.ok((await giveaways.end(ctx, 'gm1', { reroll: true })).ok, 'unless it is a reroll');
    assert.strictEqual((await giveaways.end(ctx, 'nope')).ok, false);
    assert.strictEqual(await press('c').then(() => replies.at(-1)), '⛔ That giveaway is over.');

    store.update('giveaways', (all) => { all.gm2 = { messageId: 'gm2', channelId: 'c', prize: 'Later', winners: 1, entrants: [], hostId: 'h', endsAt: Date.now() + 86400000, ended: false }; });
    const again = new Store(store.file);
    assert.strictEqual(giveaways.resume({ store: again, log: quiet, client }), 1);
    giveaways.clearTimer('gm2');
    assert.strictEqual(giveaways.active({ store: again }).length, 1);
  });
});

describe('The store', () => {
  test('starts empty, survives a round trip, writes atomically', () => {
    const file = path.join(tmp(), 'nested', 'discord.json');
    const s = new Store(file);
    assert.deepStrictEqual(s.data, { panels: {}, giveaways: {}, warnings: {} });
    s.update('warnings', (w) => { w.u1 = [{ id: 'a', reason: 'x' }]; });
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), 'the temp file is renamed over');
    const s2 = new Store(file);
    assert.deepStrictEqual(s2.data.warnings.u1, [{ id: 'a', reason: 'x' }]);
    assert.deepStrictEqual(s2.data.panels, {}, 'sections missing from the file are made');
  });
});

describe('The commands', () => {
  const loaded = commands.load();

  test('all of the usual ones are there, each once, each with a handler', () => {
    const names = loaded.list.map((c) => c.name);
    for (const want of ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'purge', 'warn', 'warnings', 'slowmode', 'lock', 'unlock', 'role', 'nick', 'giveaway', 'panel', 'announce', 'status', 'support', 'ticket', 'userinfo', 'serverinfo', 'avatar', 'ping', 'help']) {
      assert.ok(names.includes(want), `/${want}`);
    }
    assert.strictEqual(new Set(names).size, names.length);
    for (const c of loaded.list) assert.strictEqual(typeof c.execute, 'function', c.name);
  });

  test('each definition is what Discord accepts: server-only, named in lower case, with a description', () => {
    for (const def of loaded.definitions()) {
      assert.match(def.name, /^[a-z][a-z0-9_-]{0,31}$/);
      assert.ok(def.description && def.description.length <= 100, `${def.name}: description ≤ 100 chars`);
      assert.deepStrictEqual(def.contexts, [0], `${def.name} is guild-only`);
      for (const opt of def.options || []) {
        assert.match(opt.name, /^[a-z][a-z0-9_]{0,31}$/, `${def.name}.${opt.name}`);
        assert.ok(opt.description.length <= 100, `${def.name}.${opt.name}: description ≤ 100 chars`);
      }
    }
  });

  test('moderation commands carry the permission both as Discord\'s default and as the runtime check', () => {
    const expect = {
      kick: PermissionFlagsBits.KickMembers, ban: PermissionFlagsBits.BanMembers, unban: PermissionFlagsBits.BanMembers,
      timeout: PermissionFlagsBits.ModerateMembers, untimeout: PermissionFlagsBits.ModerateMembers, warn: PermissionFlagsBits.ModerateMembers,
      purge: PermissionFlagsBits.ManageMessages, slowmode: PermissionFlagsBits.ManageChannels, lock: PermissionFlagsBits.ManageChannels,
      role: PermissionFlagsBits.ManageRoles, nick: PermissionFlagsBits.ManageNicknames, giveaway: PermissionFlagsBits.ManageGuild, panel: PermissionFlagsBits.ManageGuild,
    };
    for (const [name, perm] of Object.entries(expect)) {
      const c = loaded.byName.get(name);
      assert.strictEqual(c.requires, perm, `/${name} requires`);
      assert.strictEqual(c.data.toJSON().default_member_permissions, perm.toString(), `/${name} default`);
    }
    for (const name of ['ping', 'help', 'userinfo', 'serverinfo', 'avatar', 'status', 'support', 'ticket']) {
      assert.strictEqual(loaded.byName.get(name).requires, undefined, `/${name} is for everyone`);
    }
  });

  test('a command that refuses does so before touching Discord: a duration it cannot read, a target above the moderator', async () => {
    const replies = [];
    const g = fakeGuild({ botHighest: 50 });
    g.members.fetch = async (id) => member(id, { highest: id === 'boss' ? 40 : 1, guild: g });
    const interaction = (opts) => ({
      guild: g, user: { id: 'mod', tag: 'mod#1' }, member: member('mod', { highest: 20, guild: g }),
      options: { getUser: () => ({ id: opts.target, tag: `${opts.target}#1` }), getString: (k) => opts[k] },
      reply: async (p) => replies.push(p.embeds[0].toJSON().description),
    });
    await loaded.byName.get('timeout').execute(interaction({ target: 'low', duration: 'forever' }), { log: quiet });
    assert.ok(replies[0].includes('did not understand that duration'));
    await loaded.byName.get('timeout').execute(interaction({ target: 'low', duration: '40d' }), { log: quiet });
    assert.ok(replies[1].includes('28 days'));
    await loaded.byName.get('timeout').execute(interaction({ target: 'boss', duration: '1h' }), { log: quiet });
    assert.ok(replies[2].includes('at or above yours'));
    await loaded.byName.get('kick').execute(interaction({ target: 'boss' }), { log: quiet });
    assert.ok(replies[3].includes('at or above yours'));
  });
});

describe('The invite and the look', () => {
  test('the invite asks for what the commands need and not Administrator', () => {
    assert.ok(!NEEDED.includes(PermissionFlagsBits.Administrator));
    for (const p of [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels]) {
      assert.ok(NEEDED.includes(p));
    }
    const url = inviteUrl('1551702205365624842');
    assert.ok(url.startsWith('https://discord.com/oauth2/authorize?client_id=1551702205365624842&scope=bot%20applications.commands&permissions='));
    assert.ok(url.endsWith(permissions()));
    assert.strictEqual(inviteUrl(''), null);
  });

  test('embeds drop empty fields, cut long ones and keep the palette', () => {
    const e = embed({ title: 'T', fields: [{ name: 'A', value: '' }, { name: 'B', value: 'x'.repeat(2000), inline: false }, { name: 'C', value: 1 }] }).toJSON();
    assert.deepStrictEqual(e.fields.map((f) => f.name), ['B', 'C']);
    assert.strictEqual(e.fields[0].value.length, 1024);
    assert.strictEqual(e.fields[0].inline, false);
    assert.strictEqual(e.fields[1].inline, true);
    assert.strictEqual(e.color, COLORS.brand);
    assert.ok(e.timestamp);
    assert.strictEqual(embed({ timestamp: false }).toJSON().timestamp, undefined);
  });
});

describe('Roles people claim', () => {
  const cfg = config.read({});
  const four = { merchant: role('m1', 'Merchant', 3), buyer: role('b1', 'Buyer', 3), announcements: role('u1', 'Announcements', 2), status: role('s1', 'Status Updates', 2) };

  test('the panel names each role with its blurb and has one button per role the server has', () => {
    const p = roles.panel(cfg, { roles: { member: role('x', 'Member', 4), ...four } });
    const e = p.embeds[0].toJSON();
    assert.strictEqual(e.title, 'Pick your roles');
    for (const id of ['m1', 'b1', 'u1', 's1']) assert.ok(e.description.includes(`<@&${id}>`));
    const buttons = p.components[0].toJSON().components;
    assert.deepStrictEqual(buttons.map((b) => b.custom_id), ['role:merchant', 'role:buyer', 'role:announcements', 'role:status']);
    assert.deepStrictEqual(buttons.map((b) => b.label), ['Merchant', 'Buyer', 'Announcements', 'Status Updates']);
    const partial = roles.panel(cfg, { roles: { merchant: four.merchant } });
    assert.strictEqual(partial.components[0].toJSON().components.length, 1, 'a missing role has no button');
    assert.ok(partial.embeds[0].toJSON().description.includes('**Buyer**'), 'but is still named, in bold');
    assert.strictEqual(roles.panel(cfg, { roles: {} }).components.length, 0);
    assert.ok(roles.isRoleButton('role:status') && !roles.isRoleButton('verify:member'));
  });

  test('a button toggles the role; an unknown one is refused; a role the bot cannot give says why', async () => {
    const calls = [];
    const replies = [];
    const ctx = { found: { roles: four }, log: quiet };
    const press = (key, has, fail) => roles.handleButton({
      customId: `role:${key}`, user: { tag: 'a#1', id: 'a' },
      member: { roles: { cache: new Set(has ? [four[key] && four[key].id] : []), add: async (r) => { if (fail) throw new Error('Missing Permissions'); calls.push(['add', r.id]); }, remove: async (r) => calls.push(['remove', r.id]) } },
      reply: async (p) => replies.push(p.embeds[0].toJSON().description),
    }, ctx);
    await press('merchant', false);
    await press('merchant', true);
    await press('status', false);
    assert.deepStrictEqual(calls, [['add', 'm1'], ['remove', 'm1'], ['add', 's1']]);
    assert.ok(replies[0].includes('You now have **Merchant**'));
    assert.ok(replies[1].includes('**Merchant** removed'));
    assert.ok(replies[2].includes('pinged when something goes down'));
    await press('admin', false);
    assert.ok(replies[3].includes('not on this server'));
    await press('buyer', false, true);
    assert.ok(replies[4].includes('move my role above **Buyer**'));
  });

  test('missing claimable roles are made, in the configured names; the panel is posted once', async () => {
    const made = [];
    const g = fakeGuild({ roles: [role('m1', 'Merchant', 3)] });
    g.roles.create = async (opts) => { made.push(opts.name); return role(`new-${opts.name}`, opts.name, 1); };
    const rolesCh = channel('p', 'roles');
    const sent = [];
    rolesCh.send = async (payload) => { sent.push(payload); return { id: `rm${sent.length}` }; };
    rolesCh.messages = { fetch: async () => { throw new Error('gone'); } };
    const store = new Store(path.join(tmp(), 'discord.json'));
    const ctx = { config: config.read({ DISCORD_ANNOUNCEMENTS_ROLE: 'News' }), store, log: quiet, found: { channels: { roles: rolesCh }, roles: { merchant: role('m1', 'Merchant', 3), buyer: null, announcements: null, status: null } } };
    assert.deepStrictEqual(await roles.ensureClaimable(ctx, g), ['Buyer', 'News', 'Status Updates']);
    assert.strictEqual(ctx.found.roles.announcements.name, 'News');
    assert.deepStrictEqual(await roles.ensureClaimable(ctx, g), [], 'nothing to make the second time');
    await roles.ensurePanel(ctx, g);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.data.panels.roles.messageId, 'rm1');
    assert.strictEqual(sent[0].components[0].toJSON().components.length, 4);
    assert.strictEqual(await roles.ensurePanel({ ...ctx, found: { channels: {}, roles: {} } }, g), null);
  });
});

describe('The status embed', () => {
  const cfg = config.read({});
  const platform = (over = {}) => ({
    generatedAt: '2026-09-21T21:30:00.000Z', overallStatus: 'operational', overallStatusLabel: 'Fully operational', uptimePercentage: 99.98,
    services: [
      { key: 'API', label: 'API', status: 'operational', statusLabel: 'Operational' },
      { key: 'WALLET_SYNC', label: 'Wallet Sync', status: 'operational', statusLabel: 'Operational' },
      { key: 'CHECKOUTS', label: 'Checkouts', status: 'operational', statusLabel: 'Operational' },
      { key: 'PAYOUTS', label: 'Payout Engine', status: 'operational', statusLabel: 'Operational' },
    ],
    ...over,
  });
  const chains = (over = {}) => ({
    checkedAt: '2026-09-21T21:24:59.876Z', counts: { up: 63, degraded: 2, down: 0, unknown: 0 },
    chains: [
      { code: 'ETH', name: 'Ethereum', status: 'up' }, { code: 'BTC', name: 'Bitcoin', status: 'up' },
      { code: 'SOL', name: 'Solana', status: 'degraded' }, { code: 'CORE', name: 'Core', status: 'degraded' },
    ],
    events: [{ at: '2026-09-21T21:24:59.876Z', chain: 'BASE', name: 'Base', component: 'endpoints', from: '3/3', to: '2/3', detail: 'not answering: x' }],
    ...over,
  });
  const fakeFetch = (bodies) => async (url) => {
    const key = url.endsWith('/api/status/chains') ? 'chains' : 'platform';
    const body = bodies[key];
    if (body instanceof Error) throw body;
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, json: async () => body };
  };

  test('the picture, flattened: operational unless a service is off or a network is down; degraded networks are listed, not alarming', async () => {
    const fine = status.summarise(await status.gather(cfg, { fetchImpl: fakeFetch({ platform: platform(), chains: chains() }) }));
    assert.strictEqual(fine.overall, 'operational');
    assert.strictEqual(fine.label, 'Fully operational');
    assert.deepStrictEqual(fine.degraded.map((c) => c.code), ['SOL', 'CORE']);
    assert.deepStrictEqual(fine.down, []);
    assert.strictEqual(fine.uptime, 99.98);
    assert.strictEqual(fine.events.length, 1);
    assert.strictEqual(status.signature(fine), 'operational||');

    const oneDown = status.summarise({ platform: platform(), chains: chains({ chains: [{ code: 'SOL', name: 'Solana', status: 'down' }], counts: { up: 64, degraded: 0, down: 1, unknown: 0 } }) });
    assert.strictEqual(oneDown.overall, 'degraded');
    assert.strictEqual(status.signature(oneDown), 'degraded||SOL');

    const incident = status.summarise({ platform: platform({ overallStatus: 'degraded', overallStatusLabel: 'Partial outage', services: [{ key: 'API', label: 'API', status: 'operational', statusLabel: 'Operational' }, { key: 'PAYOUTS', label: 'Payout Engine', status: 'degraded', statusLabel: 'Degraded' }] }), chains: chains() });
    assert.strictEqual(incident.overall, 'degraded');
    assert.strictEqual(incident.label, 'Partial outage');
    assert.strictEqual(status.signature(incident), 'degraded|PAYOUTS|');

    const noChains = status.summarise(await status.gather(cfg, { fetchImpl: fakeFetch({ platform: platform(), chains: 503 }) }));
    assert.strictEqual(noChains.overall, 'operational');
    assert.strictEqual(noChains.counts, null);
    assert.ok(noChains.chainsError.includes('503'));

    const gone = status.summarise(await status.gather(cfg, { fetchImpl: fakeFetch({ platform: new Error('ECONNREFUSED'), chains: new Error('ECONNREFUSED') }) }));
    assert.strictEqual(gone.ok, false);
    assert.strictEqual(gone.overall, 'unreachable');
    assert.strictEqual(gone.error, 'ECONNREFUSED');
    assert.strictEqual(status.signature(gone), 'unreachable||');
  });

  test('the embed: a glyph and colour for the state, a field per service, the network counts, what is degraded, the recent changes, the status page', () => {
    const fine = status.summarise({ platform: platform(), chains: chains() });
    const e = status.statusEmbed(fine, cfg).toJSON();
    assert.strictEqual(e.title, '🟢 Etheroute status - Fully operational');
    assert.strictEqual(e.color, COLORS.ok);
    assert.ok(e.description.includes('[Status page](https://etheroute.com/status)') && e.description.includes('**99.98%**'));
    assert.deepStrictEqual(e.fields.map((f) => f.name), ['API', 'Wallet Sync', 'Checkouts', 'Payout Engine', 'Networks (4)', 'Degraded (some endpoints not answering)', 'Recent changes']);
    assert.strictEqual(e.fields[0].value, '✅ Operational');
    assert.strictEqual(e.fields[4].value, '🟢 63 up · 🟠 2 degraded · 🔴 0 down');
    assert.strictEqual(e.fields[5].value, '**Solana (SOL)**, Core (CORE)', 'a main network in bold, first');
    assert.ok(e.fields[6].value.startsWith('Base: endpoints 3/3 → 2/3 <t:'));
    assert.strictEqual(e.footer.text, 'Updates every 5 min');

    const down = status.statusEmbed(status.summarise({ platform: platform(), chains: chains({ chains: [{ code: 'SOL', name: 'Solana', status: 'down' }], counts: { up: 64, degraded: 0, down: 1, unknown: 0 }, events: [] }) }), cfg).toJSON();
    assert.strictEqual(down.title, '🟠 Etheroute status - Partial outage');
    assert.strictEqual(down.color, COLORS.warn);
    assert.ok(down.fields.some((f) => f.name === 'Down' && f.value === '**Solana (SOL)**'));

    const gone = status.statusEmbed(status.summarise({ platform: null, chains: null, error: 'ECONNREFUSED' }), cfg).toJSON();
    assert.strictEqual(gone.title, '🔴 Etheroute status - API unreachable');
    assert.strictEqual(gone.color, COLORS.danger);
    assert.strictEqual(gone.fields[0].value, 'ECONNREFUSED');
  });

  test('the note on a change says what went down, what came back, which service degraded or recovered', () => {
    const before = status.summarise({ platform: platform(), chains: chains() });
    const after = status.summarise({ platform: platform({ overallStatus: 'degraded', overallStatusLabel: 'Partial outage', services: [{ key: 'API', label: 'API', status: 'operational', statusLabel: 'Operational' }, { key: 'PAYOUTS', label: 'Payout Engine', status: 'degraded', statusLabel: 'Degraded' }] }), chains: chains({ chains: [{ code: 'SOL', name: 'Solana', status: 'down' }] }) });
    const e = status.changeEmbed(before, after, cfg).toJSON();
    assert.strictEqual(e.title, '🟠 Fully operational → Partial outage');
    assert.strictEqual(e.description, '🔴 **Solana (SOL) is down.**', 'a main network gets the headline');
    assert.deepStrictEqual(e.fields.map((f) => [f.name, f.value]), [['Went down', '**Solana (SOL)**'], ['Degraded', 'Payout Engine']]);
    const back = status.changeEmbed(after, before, cfg).toJSON();
    assert.strictEqual(back.title, '🟢 Partial outage → Fully operational');
    assert.strictEqual(back.description, '🟢 **Solana (SOL) is back up.**');
    assert.deepStrictEqual(back.fields.map((f) => [f.name, f.value]), [['Back up', '**Solana (SOL)**'], ['Recovered', 'Payout Engine']]);
    const minor = status.changeEmbed(before, status.summarise({ platform: platform(), chains: chains({ chains: [{ code: 'CORE', name: 'Core', status: 'down' }] }) }), cfg).toJSON();
    assert.strictEqual(minor.description, undefined, 'a minor network gets no headline');
    assert.deepStrictEqual(minor.fields.map((f) => [f.name, f.value]), [['Went down', 'Core (CORE)']]);
    const gone = status.changeEmbed(before, status.summarise({ platform: null, error: 'timeout' }), cfg).toJSON();
    assert.strictEqual(gone.fields[0].name, 'Problem');
    const answering = status.changeEmbed(status.summarise({ platform: null, error: 'timeout' }), before, cfg).toJSON();
    assert.deepStrictEqual(answering.fields.map((f) => f.name), ['API']);
    assert.strictEqual(status.changeEmbed(null, before, cfg).toJSON().title, '🟢 Fully operational');
  });

  test('refresh edits one remembered message, and pings the Status role only when the picture changes', async () => {
    const sent = [];
    const edits = [];
    const statusCh = channel('st', 'status');
    let exists = false;
    statusCh.send = async (payload) => { sent.push(payload); exists = true; return { id: 'sm1', channel: statusCh, edit: async (p) => edits.push(p) }; };
    statusCh.messages = { fetch: async () => { if (!exists) throw new Error('gone'); return { id: 'sm1', channel: statusCh, edit: async (p) => edits.push(p) }; } };
    const store = new Store(path.join(tmp(), 'discord.json'));
    const ctx = { config: cfg, store, log: quiet, guild: {}, found: { channels: { status: statusCh }, roles: { status: role('s1', 'Status Updates', 2) } } };
    let bodies = { platform: platform(), chains: chains() };
    const opts = { fetchImpl: (url, o) => fakeFetch(bodies)(url, o) };

    let r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, false, 'the first picture is not a change');
    assert.strictEqual(sent.length, 1, 'posted once');
    assert.strictEqual(edits.length, 1, 'and edited with the same picture');
    assert.strictEqual(store.data.panels.status.messageId, 'sm1');
    assert.strictEqual(store.data.status.signature, 'operational||');

    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(sent.length, 1, 'still the one message');
    assert.strictEqual(edits.length, 2);

    bodies = { platform: platform(), chains: chains({ chains: [{ code: 'SOL', name: 'Solana', status: 'down' }], counts: { up: 64, degraded: 0, down: 1, unknown: 0 } }) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.pinged, true, 'Solana is a main network');
    assert.strictEqual(sent.length, 2, 'a note under the embed');
    assert.strictEqual(sent[1].content, '<@&s1>');
    assert.deepStrictEqual(sent[1].allowedMentions, { roles: ['s1'] });
    assert.strictEqual(sent[1].embeds[0].toJSON().title, '🟠 Fully operational → Partial outage');
    assert.strictEqual(store.data.status.signature, 'degraded||SOL');

    bodies = { platform: platform(), chains: chains({ chains: [{ code: 'SOL', name: 'Solana', status: 'degraded' }] }) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, true, 'down → degraded is a recovery');
    assert.strictEqual(r.pinged, true);
    assert.strictEqual(sent[2].embeds[0].toJSON().fields[0].name, 'Back up');
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, false, 'degraded staying degraded is not news');
    assert.strictEqual(sent.length, 3);

    bodies = { platform: platform(), chains: chains({ chains: [{ code: 'CORE', name: 'Core', status: 'down' }] }) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, true, 'a minor network down is noted');
    assert.strictEqual(r.pinged, false, 'but nobody is pinged for it');
    assert.strictEqual(sent[3].content, undefined);
    assert.deepStrictEqual(sent[3].allowedMentions, { roles: [] });

    bodies = { platform: platform({ overallStatus: 'degraded', overallStatusLabel: 'Partial outage', services: [{ key: 'API', label: 'API', status: 'degraded', statusLabel: 'Degraded' }] }), chains: chains({ chains: [{ code: 'CORE', name: 'Core', status: 'down' }] }) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.pinged, true, 'a platform service always is');

    bodies = { platform: new Error('ECONNREFUSED'), chains: new Error('ECONNREFUSED') };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.pinged, true, 'as is the API going away');
    assert.strictEqual(sent.at(-1).embeds[0].toJSON().title, '🔴 Partial outage → API unreachable');

    assert.deepStrictEqual(await status.refresh({ ...ctx, found: { channels: {}, roles: {} } }, opts).then((x) => x.changed), false, 'no channel: nothing to edit');
  });
});

describe('What decides a ping', () => {
  const cfg = config.read({});
  const pic = (down = [], services = []) => ({ ok: true, down: down.map((code) => ({ code, name: code })), platform: services.map((key) => ({ key, label: key, status: 'degraded' })) });
  test('a main network, a platform service or the API; not one of the sixty others', () => {
    assert.strictEqual(status.diff(pic(), pic(['BTC']), cfg).ping, true);
    assert.strictEqual(status.diff(pic(['BTC']), pic(), cfg).ping, true);
    assert.strictEqual(status.diff(pic(), pic(['CORE']), cfg).ping, false);
    assert.strictEqual(status.diff(pic(['CORE']), pic(['CORE', 'HEMI']), cfg).ping, false);
    assert.strictEqual(status.diff(pic(), pic([], ['PAYOUTS']), cfg).ping, true);
    assert.strictEqual(status.diff(pic([], ['PAYOUTS']), pic(), cfg).ping, true);
    assert.strictEqual(status.diff(pic(), { ok: false, down: [], platform: [] }, cfg).ping, true);
    assert.strictEqual(status.diff(null, pic(['CORE']), cfg).ping, false, 'the first picture pings for nothing');
    assert.deepStrictEqual(status.diff(pic(), pic(['BTC', 'CORE']), cfg).mainDown.map((c) => c.code), ['BTC']);
    assert.strictEqual(status.isMain(config.read({ DISCORD_MAIN_CHAINS: 'CORE' }), 'core'), true, 'the list is the operator\'s');
  });
});

describe('The mod-log', () => {
  modlog.AUDIT.delayMs = 0;
  const log = () => { const ch = channel('log', 'mod-log'); ch.sent = []; ch.send = async (p) => { ch.sent.push(p); return { id: 'x' }; }; return ch; };
  const audit = (entries) => async ({ type }) => ({ entries: new Map(entries.filter((e) => e.type === type).map((e, i) => [String(i), { ...e, createdTimestamp: e.createdTimestamp || Date.now() }])) });
  const user = (id, tag, bot = false) => ({ id, tag, username: tag.split('#')[0], bot, toString: () => `<@${id}>`, displayAvatarURL: () => `https://cdn/${id}.png`, createdTimestamp: Date.now() - 400 * 86400000 });
  const guildWith = (entries = []) => ({ id: 'guild', memberCount: 41, members: { me: { permissions: new PermissionsBitField([PermissionFlagsBits.ViewAuditLog]) } }, fetchAuditLogs: audit(entries) });
  const ctxWith = (g, over = {}) => ({ config: config.read({ DISCORD_GUILD_ID: 'guild', ...over }), client: { user: { id: 'bot' } }, log: quiet, found: { channels: { log: log() }, roles: {} } });

  test('who did it, from the audit log: the newest matching entry within a few seconds, none when the bot may not look', async () => {
    const g = guildWith([
      { type: AuditLogEvent.MessageDelete, targetId: 'u', executor: user('mod', 'mod#1'), createdTimestamp: Date.now() - 2000, extra: { channel: { id: 'c1' } } },
      { type: AuditLogEvent.MemberKick, targetId: 'u', executor: user('mod', 'mod#1'), reason: 'spam', createdTimestamp: Date.now() - 60000 },
    ]);
    const found = await modlog.executorFor(g, AuditLogEvent.MessageDelete, { targetId: 'u' });
    assert.strictEqual(found.executor.id, 'mod');
    assert.strictEqual(await modlog.executorFor(g, AuditLogEvent.MessageDelete, { targetId: 'someone-else' }), null);
    assert.strictEqual(await modlog.executorFor(g, AuditLogEvent.MemberKick, { targetId: 'u' }), null, 'a minute old is not this kick');
    assert.strictEqual(await modlog.executorFor(g, AuditLogEvent.MessageDelete, { targetId: 'u', match: (e) => e.extra.channel.id === 'c2' }), null);
    const blind = guildWith([]);
    blind.members.me.permissions = new PermissionsBitField([]);
    assert.strictEqual(await modlog.executorFor(blind, AuditLogEvent.MessageDelete, {}), null);

    // Discord folds a moderator's repeated deletions into one ageing entry whose count grows
    const folded = { id: 'e1', type: AuditLogEvent.MessageDelete, targetId: 'u', executor: user('mod', 'mod#1'), createdTimestamp: Date.now() - 2000, extra: { channel: { id: 'c1' }, count: 1 } };
    const g2 = guildWith([folded]);
    assert.ok(await modlog.executorFor(g2, AuditLogEvent.MessageDelete, { targetId: 'u' }), 'fresh: matched');
    folded.createdTimestamp = Date.now() - 120000;
    assert.strictEqual(await modlog.executorFor(g2, AuditLogEvent.MessageDelete, { targetId: 'u' }), null, 'two minutes old with the same count: not this one');
    folded.extra.count = 2;
    assert.ok(await modlog.executorFor(g2, AuditLogEvent.MessageDelete, { targetId: 'u' }), 'the count grew: it is');
    assert.strictEqual(await modlog.executorFor(g2, AuditLogEvent.MessageDelete, { targetId: 'u' }), null, 'and once it has been read, not again');
  });

  test('a deleted message: author, channel, who deleted it, and the content when the intent allows', async () => {
    const g = guildWith([{ type: AuditLogEvent.MessageDelete, targetId: 'u', executor: user('mod', 'mod#1'), extra: { channel: { id: 'c1' } } }]);
    const ctx = ctxWith(g);
    const msg = { guild: g, channelId: 'c1', author: user('u', 'them#1'), content: 'hello there', partial: false, attachments: new Map() };
    assert.strictEqual(await modlog.onMessageDelete(msg, ctx), true);
    const card = ctx.found.channels.log.sent[0].embeds[0].toJSON();
    assert.strictEqual(card.title, '🗑️ Message deleted');
    assert.deepStrictEqual(card.fields.map((f) => f.name), ['Author', 'Channel', 'Deleted by', 'Content']);
    assert.strictEqual(card.fields[2].value, 'mod#1 (mod)');
    assert.strictEqual(card.fields[3].value, 'hello there');

    const g2 = guildWith([]);
    const quietCtx = ctxWith(g2);
    await modlog.onMessageDelete({ ...msg, guild: g2, content: '' }, quietCtx);
    const noContent = quietCtx.found.channels.log.sent[0].embeds[0].toJSON();
    assert.strictEqual(noContent.fields[2].value, 'the author, or unknown');
    assert.ok(noContent.fields[3].value.includes('Message Content intent'));

    const g3 = guildWith([]);
    const partialCtx = ctxWith(g3);
    await modlog.onMessageDelete({ ...msg, guild: g3, partial: true, content: null }, partialCtx);
    assert.ok(partialCtx.found.channels.log.sent[0].embeds[0].toJSON().fields[3].value.includes('not cached'));
  });

  test('what the bot did itself, bots\' messages, the log channel and other servers are let go', async () => {
    const byBot = guildWith([{ type: AuditLogEvent.MessageDelete, targetId: 'u', executor: user('bot', 'bot#0', true), extra: { channel: { id: 'c1' } } }]);
    const ctx = ctxWith(byBot);
    const msg = { guild: byBot, channelId: 'c1', author: user('u', 'them#1'), content: 'x', attachments: new Map() };
    assert.strictEqual(await modlog.onMessageDelete(msg, ctx), false, 'the anti-bot trap or /purge already said so');
    assert.strictEqual(await modlog.onMessageDelete({ ...msg, author: user('b', 'other#0', true) }, ctx), false);
    assert.strictEqual(await modlog.onMessageDelete({ ...msg, channelId: 'log' }, ctx), false);
    assert.strictEqual(await modlog.onMessageDelete({ ...msg, guild: { id: 'elsewhere' } }, ctx), false);
    assert.strictEqual(ctx.found.channels.log.sent.length, 0);
    assert.strictEqual(await modlog.onMessageUpdate({ content: 'same', partial: false }, { guild: byBot, author: user('u', 'a#1'), content: 'same', partial: false }, ctx), false, 'an unfurl is not an edit');
  });

  test('joins flag a young account; a leave and a kick are told apart; a hand ban names the moderator', async () => {
    const g = guildWith([
      { type: AuditLogEvent.MemberKick, targetId: 'k', executor: user('mod', 'mod#1'), reason: 'rude' },
      { type: AuditLogEvent.MemberBanAdd, targetId: 'b', executor: user('mod', 'mod#1'), reason: 'raid' },
    ]);
    const ctx = ctxWith(g);
    const sent = ctx.found.channels.log.sent;
    const fresh = user('n', 'new#1'); fresh.createdTimestamp = Date.now() - 86400000;
    await modlog.onMemberAdd({ guild: g, user: fresh, toString: () => '<@n>' }, ctx);
    assert.strictEqual(sent[0].embeds[0].toJSON().title, '📥 Member joined');
    assert.ok(sent[0].embeds[0].toJSON().fields[1].value.includes('under a week old'));
    assert.strictEqual(sent[0].embeds[0].toJSON().color, COLORS.warn);

    await modlog.onMemberRemove({ guild: g, user: user('l', 'left#1'), roles: { cache: new Map() }, joinedTimestamp: Date.now() - 86400000 }, ctx);
    assert.strictEqual(sent[1].embeds[0].toJSON().title, '📤 Member left');
    await modlog.onMemberRemove({ guild: g, user: user('k', 'kicked#1'), roles: { cache: new Map() } }, ctx);
    const kick = sent[2].embeds[0].toJSON();
    assert.strictEqual(kick.title, '👢 Member kicked');
    assert.strictEqual(kick.fields[1].value, 'mod#1 (mod)');
    assert.strictEqual(kick.fields[2].value, 'rude');
    await modlog.onBanAdd({ guild: g, user: user('b', 'banned#1') }, ctx);
    const ban = sent[3].embeds[0].toJSON();
    assert.strictEqual(ban.title, '🔨 Member banned');
    assert.strictEqual(ban.fields[2].value, 'raid');
    assert.strictEqual(await modlog.onMemberRemove({ guild: g, user: user('b', 'banned#1'), roles: { cache: new Map() } }, ctx), false, 'a ban is not also a leave');
  });

  test('roles, nickname and timeout changes by hand are cards; the roles panel\'s own changes are not', async () => {
    const r1 = role('r1', 'Helper', 2);
    const g = guildWith([
      { type: AuditLogEvent.MemberRoleUpdate, targetId: 'u', executor: user('mod', 'mod#1') },
      { type: AuditLogEvent.MemberUpdate, targetId: 'u', executor: user('mod', 'mod#1'), reason: 'cool off', changes: [{ key: 'communication_disabled_until' }] },
    ]);
    const ctx = ctxWith(g);
    const sent = ctx.found.channels.log.sent;
    const m = (over) => ({ id: 'u', guild: g, user: user('u', 'them#1'), toString: () => '<@u>', roles: { cache: new Map() }, nickname: null, communicationDisabledUntilTimestamp: null, ...over });
    await modlog.onMemberUpdate(m({}), m({ roles: { cache: new Map([['r1', r1]]) }, nickname: 'Neo', communicationDisabledUntilTimestamp: Date.now() + 600000 }), ctx);
    assert.deepStrictEqual(sent.map((p) => p.embeds[0].toJSON().title), ['🏷️ Roles changed', '✏️ Nickname changed', '⏳ Member timed out']);
    assert.strictEqual(sent[0].embeds[0].toJSON().fields[2].value, '<@&r1>');
    assert.strictEqual(sent[1].embeds[0].toJSON().fields[2].value, 'them → Neo');
    assert.strictEqual(sent[2].embeds[0].toJSON().fields[3].value, 'cool off');

    const panel = guildWith([{ type: AuditLogEvent.MemberRoleUpdate, targetId: 'u', executor: user('bot', 'bot#0', true) }]);
    const quietCtx = ctxWith(panel);
    await modlog.onMemberUpdate(m({ guild: panel }), m({ guild: panel, roles: { cache: new Map([['r1', r1]]) } }), quietCtx);
    assert.strictEqual(quietCtx.found.channels.log.sent.length, 0);
  });

  test('channels and roles made, removed or renamed', async () => {
    const g = guildWith([{ type: AuditLogEvent.ChannelDelete, targetId: 'c9', executor: user('mod', 'mod#1') }]);
    const ctx = ctxWith(g);
    const sent = ctx.found.channels.log.sent;
    await modlog.onChannelDelete({ guild: g, id: 'c9', name: 'general', type: ChannelType.GuildText }, ctx);
    assert.strictEqual(sent[0].embeds[0].toJSON().title, '➖ text channel deleted');
    assert.strictEqual(sent[0].embeds[0].toJSON().fields[1].value, 'mod#1 (mod)');
    await modlog.onChannelUpdate({ name: 'a' }, { guild: g, id: 'c1', name: 'a', toString: () => '<#c1>' }, ctx);
    assert.strictEqual(sent.length, 1, 'a permission change is not a rename');
    await modlog.onRoleCreate({ guild: g, id: 'r9', name: 'VIP', toString: () => '<@&r9>' }, ctx);
    assert.strictEqual(sent[1].embeds[0].toJSON().title, '➕ Role created');
  });
});

describe('Tickets', () => {
  const cfg = config.read({ DISCORD_GUILD_ID: 'guild' });
  const support = role('sup', 'Support', 5);
  const user = (id, tag) => ({ id, tag, username: tag.split('#')[0], toString: () => `<@${id}>`, send: async () => ({}) });

  function world({ withSupport = true, category = true } = {}) {
    const created = [];
    const cats = category ? [{ id: 'cat', name: 'Tickets', type: ChannelType.GuildCategory }] : [];
    const g = {
      id: 'guild', ownerId: 'owner',
      members: { me: { id: 'bot' } },
      channels: {
        cache: new Map(cats.map((c) => [c.id, c])),
        create: async (opts) => {
          const ch = { id: `ch${created.length + 1}`, name: opts.name, type: opts.type, parentId: opts.parent, topic: opts.topic, overwrites: opts.permissionOverwrites, sent: [], toString() { return `<#${this.id}>`; } };
          ch.send = async (p) => { ch.sent.push(p); return { id: 'm' }; };
          ch.messages = { fetch: async () => new Map() };
          ch.delete = async () => { ch.deleted = true; };
          ch.permissionOverwrites = { edit: async (u, perms) => { ch.overwrites.push({ id: u.id, allow: Object.keys(perms) }); }, delete: async (u) => { ch.overwrites = ch.overwrites.filter((o) => o.id !== u.id); } };
          created.push(ch);
          g.channels.cache.set(ch.id, ch);
          return ch;
        },
      },
    };
    const logCh = channel('log', 'mod-log'); logCh.sent = []; logCh.send = async (p) => { logCh.sent.push(p); return {}; };
    const store = new Store(path.join(tmp(), 'discord.json'));
    const users = { opener: user('u1', 'alice#1') };
    const ctx = { config: cfg, store, log: quiet, client: { user: { id: 'bot' }, users: { fetch: async (id) => users.opener.id === id ? users.opener : null } }, found: { channels: { log: logCh, support: null, transcripts: null }, roles: { support: withSupport ? support : null } } };
    return { g, ctx, created, logCh, users };
  }

  test('the panel and the form', () => {
    const p = tickets.panel(cfg, { roles: { support } });
    assert.strictEqual(p.embeds[0].toJSON().title, '🎫 Need a hand?');
    assert.ok(p.embeds[0].toJSON().description.includes('<@&sup>'));
    assert.strictEqual(p.components[0].toJSON().components[0].custom_id, 'ticket:open');
    const m = tickets.modal().toJSON();
    assert.strictEqual(m.custom_id, 'ticket:new');
    assert.strictEqual(m.components[0].components[0].custom_id, 'subject');
    assert.strictEqual(m.components[0].components[0].min_length, 10);
  });

  test('opening: a numbered private channel under Tickets that only the opener, the bot and Support can see; one per person; a cap', async () => {
    const { g, ctx, created, logCh, users } = world();
    const r = await tickets.openTicket(ctx, g, users.opener, 'My payout has been pending for two hours');
    assert.ok(r.channel);
    assert.strictEqual(r.ticket.number, 1);
    assert.strictEqual(created[0].name, 'ticket-0001-alice');
    assert.strictEqual(created[0].parentId, 'cat', 'the existing category is used');
    const ids = created[0].overwrites.map((o) => o.id);
    assert.deepStrictEqual(ids, ['guild', 'u1', 'bot', 'sup']);
    assert.ok(created[0].overwrites[0].deny.includes(PermissionFlagsBits.ViewChannel));
    const intro = created[0].sent[0];
    assert.strictEqual(intro.content, '<@u1> <@&sup>');
    assert.strictEqual(intro.components[0].toJSON().components[0].custom_id, 'ticket:close');
    assert.ok(intro.embeds[0].toJSON().description.includes('My payout has been pending'));
    assert.strictEqual(logCh.sent[0].embeds[0].toJSON().title, '🎫 Ticket #1 opened');
    assert.strictEqual(ctx.store.data.ticketCounter, 1);
    assert.strictEqual(tickets.ticketOf(ctx, 'ch1').status, 'open');

    const again = await tickets.openTicket(ctx, g, users.opener, 'Another thing entirely here');
    assert.ok(again.error.includes('already have a ticket open: <#ch1>'));

    ctx.config = config.read({ DISCORD_GUILD_ID: 'guild', DISCORD_TICKET_MAX: '1' });
    const full = await tickets.openTicket(ctx, g, user('u2', 'bob#2'), 'Something else that needs help');
    assert.ok(full.error.includes('Every ticket slot is taken'));
  });

  test('without a Support role the channel is the opener\'s and the bot\'s; the category is made when missing', async () => {
    const { g, ctx, created, users } = world({ withSupport: false, category: false });
    const r = await tickets.openTicket(ctx, g, users.opener, 'Where is my refund, please?');
    assert.ok(r.channel);
    assert.strictEqual(created[0].type, ChannelType.GuildCategory, 'the category first');
    assert.strictEqual(created[0].name, 'Tickets');
    assert.deepStrictEqual(created[1].overwrites.map((o) => o.id), ['guild', 'u1', 'bot']);
    assert.strictEqual(created[1].sent[0].content, '<@u1>');
  });

  test('closing: a transcript to the log and to the opener, then the channel goes; only once', async () => {
    const { g, ctx, created, logCh, users } = world();
    const dms = [];
    users.opener.send = async (p) => { dms.push(p); return {}; };
    await tickets.openTicket(ctx, g, users.opener, 'My payout has been pending for two hours');
    const ch = created[0];
    const now = Date.now();
    ch.messages.fetch = async () => new Map([
      ['2', { id: '2', createdTimestamp: now + 1000, author: { tag: 'staff#1' }, content: 'Looking now.', attachments: new Map(), embeds: [] }],
      ['1', { id: '1', createdTimestamp: now, author: { tag: 'alice#1' }, content: 'It is 0.5 ETH', attachments: new Map([['a', { url: 'https://cdn/x.png' }]]), embeds: [] }],
    ]);
    const r = await tickets.closeTicket(ctx, ch, { by: user('s1', 'staff#1'), reason: 'Paid out' });
    assert.strictEqual(r.told, true);
    assert.strictEqual(tickets.ticketOf(ctx, 'ch1').status, 'closed');
    const logged = logCh.sent[1];
    assert.strictEqual(logged.embeds[0].toJSON().title, '🔒 Ticket #1 closed');
    assert.strictEqual(logged.files[0].name, 'ticket-0001.txt');
    const text = logged.files[0].attachment.toString('utf8');
    assert.ok(text.startsWith('Ticket #1 · alice#1 (u1)'));
    assert.ok(text.indexOf('alice#1: It is 0.5 ETH [https://cdn/x.png]') < text.indexOf('staff#1: Looking now.'), 'oldest first');
    assert.strictEqual(dms[0].files[0].name, 'ticket-0001.txt');
    assert.ok(dms[0].embeds[0].toJSON().title.includes('#1 was closed'));
    assert.ok(ch.sent.at(-1).embeds[0].toJSON().description.includes('Closing this ticket: Paid out'));
    assert.ok((await tickets.closeTicket(ctx, ch, { by: user('s1', 'staff#1') })).error.includes('already closing'));
    assert.ok((await tickets.closeTicket(ctx, channel('nope', 'general'), {})).error.includes('not a ticket'));
    assert.strictEqual(tickets.open(ctx).length, 0, 'so the person may open another');
    await new Promise((resolve) => setTimeout(resolve, 5100));
    assert.strictEqual(ch.deleted, true);
  });

  test('letting people in and out; who counts as staff', async () => {
    const { g, ctx, created, users } = world();
    await tickets.openTicket(ctx, g, users.opener, 'My payout has been pending for two hours');
    const ch = created[0];
    const friend = user('u3', 'carol#3');
    assert.ok((await tickets.setAccess(ctx, ch, friend, true)).ticket);
    assert.ok(ch.overwrites.some((o) => o.id === 'u3' && o.allow.includes('ViewChannel')));
    assert.deepStrictEqual(tickets.ticketOf(ctx, 'ch1').added, ['u3']);
    assert.ok((await tickets.setAccess(ctx, ch, friend, false)).ticket);
    assert.ok(!ch.overwrites.some((o) => o.id === 'u3'));
    assert.ok((await tickets.setAccess(ctx, ch, users.opener, false)).error.includes('stays in it'));

    assert.strictEqual(tickets.isStaff({ permissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages]), roles: { cache: new Set() } }, ctx), true);
    assert.strictEqual(tickets.isStaff({ permissions: new PermissionsBitField([]), roles: { cache: new Set(['sup']) } }, ctx), true, 'the Support role counts');
    assert.strictEqual(tickets.isStaff({ permissions: new PermissionsBitField([]), roles: { cache: new Set() } }, ctx), false);
    assert.strictEqual(tickets.slug('Alice O\'Brien!!'), 'alice-o-brien');
  });
});

describe('The rules', () => {
  const cfg = config.read({});
  test('twelve, numbered, within Discord\'s limits, naming the channels they point at; keys and fake support near the top', () => {
    const found = { channels: { support: channel('s', 'support'), antibot: channel('a', 'anti-bot'), verify: channel('v', 'verify') } };
    const p = rules.panel(cfg, found);
    assert.strictEqual(p.embeds.length, 2);
    const main = p.embeds[0].toJSON();
    assert.strictEqual(main.title, 'Etheroute server rules');
    assert.strictEqual(main.fields.length, rules.RULES.length);
    assert.strictEqual(rules.RULES.length, 12);
    assert.strictEqual(main.fields[0].name, '1. Be decent');
    assert.strictEqual(main.fields[1].name, '2. Never share keys or seed phrases');
    assert.ok(main.fields[1].value.includes('Nobody from Etheroute will ever ask'));
    assert.ok(main.fields[2].value.includes('<#s>'), 'support points at the channel');
    for (const f of main.fields) {
      assert.ok(f.name.length <= 256 && f.value.length <= 1024, f.name);
      assert.ok(!f.value.includes('{'), `${f.name} has no unfilled placeholder`);
    }
    const total = JSON.stringify(main).length;
    assert.ok(total < 6000, `one embed stays under Discord's 6000 characters (${total})`);
    const how = p.embeds[1].toJSON();
    assert.strictEqual(how.title, 'How this is enforced');
    assert.ok(how.description.includes('<#a>') && how.description.includes('<#v>') && how.description.includes('Staff will never DM you first'));
    const bare = rules.panel(cfg, { channels: {} }).embeds[1].toJSON();
    assert.ok(bare.description.includes('#anti-bot') && bare.description.includes('#support'), 'plain names when the channels are not found');
  });

  test('posted only on request, into #rules, and remembered', async () => {
    const sent = [];
    const rulesCh = channel('r', 'rules');
    rulesCh.send = async (p) => { sent.push(p); return { id: `rm${sent.length}` }; };
    rulesCh.messages = { fetch: async (id) => (id === 'rm1' ? { id } : Promise.reject(new Error('gone'))) };
    const store = new Store(path.join(tmp(), 'discord.json'));
    const ctx = { config: cfg, store, log: quiet, found: { channels: { rules: rulesCh } } };
    await rules.ensurePanel(ctx, {});
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.data.panels.rules.messageId, 'rm1');
    await rules.ensurePanel(ctx, {});
    assert.strictEqual(sent.length, 1, 'still there');
    await rules.ensurePanel(ctx, {}, { force: true });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(await rules.ensurePanel({ ...ctx, found: { channels: {} } }, {}), null);
    const src = fs.readFileSync(path.join(__dirname, '../discord/bot.js'), 'utf-8');
    assert.ok(!src.includes('rules.ensurePanel'), 'the bot never posts the rules on its own');
  });
});
