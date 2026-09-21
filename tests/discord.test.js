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
const { PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');

const config = require('../discord/config');
const guildLib = require('../discord/lib/guild');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../discord/lib/duration');
const { canActOn, isStaff, caseEmbed, noticeEmbed } = require('../discord/lib/moderation');
const antibot = require('../discord/lib/antibot');
const verify = require('../discord/lib/verify');
const welcome = require('../discord/lib/welcome');
const giveaways = require('../discord/lib/giveaways');
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
    assert.deepStrictEqual(Object.keys(found.channels), ['welcome', 'verify', 'antibot', 'log', 'rules']);
    assert.strictEqual(found.channels.welcome.id, '1');
    assert.strictEqual(found.channels.antibot.id, '3');
    assert.strictEqual(found.roles.member.id, 'r2');
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
    const ctx = { found: { roles: { member: roleM } }, log: quiet };
    const mk = (has) => ({
      user: { tag: 'new#1', id: 'n' }, guild: { name: 'Etheroute' },
      member: { roles: { cache: new Set(has ? ['m'] : []), add: async (r, why) => added.push([r.id, why]) } },
      reply: async (payload) => replies.push(payload),
    });
    await verify.handleButton(mk(false), ctx);
    assert.deepStrictEqual(added, [['m', 'Verified through the panel']]);
    assert.ok(replies[0].embeds[0].toJSON().description.includes('You are verified'));
    assert.strictEqual(replies[0].flags, 64, 'ephemeral');
    await verify.handleButton(mk(true), ctx);
    assert.strictEqual(added.length, 1);
    assert.ok(replies[1].embeds[0].toJSON().description.includes('already verified'));
    await verify.handleButton(mk(false), { found: { roles: {} }, log: quiet });
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
    const ctx = { config: cfg, log: quiet, found: { channels: { welcome: welcomeCh, verify: channel('v', 'verify'), rules: null } } };
    const m = { id: 'n', displayName: 'Newcomer', toString: () => '<@n>', guild: { name: 'Etheroute', memberCount: 42 }, user: { username: 'newcomer', tag: 'newcomer#0', createdAt: new Date('2024-01-01'), displayAvatarURL: () => 'https://cdn/a.png' } };
    assert.strictEqual(await welcome.onMemberAdd(m, ctx), true);
    const e = sent[0].embeds[0].toJSON();
    assert.strictEqual(e.title, 'Welcome, Newcomer!');
    assert.ok(e.description.includes('<@n>') && e.description.includes('<#v>'));
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
    for (const want of ['kick', 'ban', 'unban', 'timeout', 'untimeout', 'purge', 'warn', 'warnings', 'slowmode', 'lock', 'unlock', 'role', 'nick', 'giveaway', 'panel', 'announce', 'userinfo', 'serverinfo', 'avatar', 'ping', 'help']) {
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
    for (const name of ['ping', 'help', 'userinfo', 'serverinfo', 'avatar']) {
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
