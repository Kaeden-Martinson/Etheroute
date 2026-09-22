/**
 * The Telegram bot, without Telegram: the config it reads, the Bot API
 * client against a stand-in fetch, the HTML it writes, who counts as an
 * admin, the status pin and when a post goes out, the announcement
 * preview, the gate on newcomers and the link filter, the moderation
 * commands, the support relay, the merchant commands against a stand-in
 * API, and the routing of updates between all of them.
 */
'use strict';

process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../telegram/config');
const { Api, Poller, TelegramError, NO_PERMISSIONS, FULL_PERMISSIONS } = require('../telegram/lib/api');
const fmt = require('../telegram/lib/format');
const moderation = require('../telegram/lib/moderation');
const status = require('../telegram/lib/status');
const announce = require('../telegram/lib/announce');
const verify = require('../telegram/lib/verify');
const support = require('../telegram/lib/support');
const merchant = require('../telegram/lib/merchant');
const { rulesText } = require('../telegram/lib/rules');
const { createBot } = require('../telegram/bot');
const { Store } = require('../src/utils/jsonStore');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const GROUP = -1004295594279;
const STAFF = -1009999999999;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-tg-'));

/** A Bot API that remembers every call and answers plausibly. */
function fakeApi({ admins = [], chats = {}, fail = {} } = {}) {
  const calls = [];
  let nextId = 100;
  const record = (m, args) => { calls.push({ m, ...args }); if (fail[m]) throw new TelegramError(m, fail[m]); };
  const api = {
    calls,
    of: (m) => calls.filter((c) => c.m === m),
    last: (m) => calls.filter((c) => c.m === m).at(-1),
    async sendMessage(chat_id, text, extra = {}) { record('sendMessage', { chat_id, text, extra }); return { message_id: nextId++, chat: { id: chat_id }, text }; },
    async editMessageText(chat_id, message_id, text) { record('editMessageText', { chat_id, message_id, text }); return {}; },
    async deleteMessage(chat_id, message_id) { record('deleteMessage', { chat_id, message_id }); return true; },
    async deleteMessages(chat_id, message_ids) { record('deleteMessages', { chat_id, message_ids }); return true; },
    async pinChatMessage(chat_id, message_id) { record('pinChatMessage', { chat_id, message_id }); return true; },
    async unpinChatMessage(chat_id, message_id) { record('unpinChatMessage', { chat_id, message_id }); return true; },
    async restrictChatMember(chat_id, user_id, permissions, until_date) { record('restrictChatMember', { chat_id, user_id, permissions, until_date }); return true; },
    async banChatMember(chat_id, user_id, extra) { record('banChatMember', { chat_id, user_id, extra }); return true; },
    async unbanChatMember(chat_id, user_id) { record('unbanChatMember', { chat_id, user_id }); return true; },
    async answerCallbackQuery(id, extra) { record('answerCallbackQuery', { id, extra }); return true; },
    async copyMessage(chat_id, from_chat_id, message_id, extra) { record('copyMessage', { chat_id, from_chat_id, message_id, extra }); return { message_id: nextId++ }; },
    async getChatMember(chat_id, user_id) { record('getChatMember', { chat_id, user_id }); return { status: admins.includes(user_id) ? 'administrator' : 'member', can_restrict_members: true, can_delete_messages: true, can_post_messages: true, can_edit_messages: true, can_pin_messages: true }; },
    async getMe() { return { id: 8741642707, username: 'etheroute_bot', is_bot: true }; },
    async getChat(id) { return chats[id] || { id, type: 'supergroup', title: `Chat ${id}`, permissions: FULL_PERMISSIONS }; },
    async setMyCommands() { return true; },
  };
  return api;
}

const user = (id, first = 'Kae', username = null) => ({ id, is_bot: false, first_name: first, username });
const msg = (over = {}) => ({ message_id: over.message_id || Math.floor(Math.random() * 1e6), chat: { id: GROUP, type: 'supergroup', title: 'Etheroute.io' }, from: user(1), date: 0, ...over });
const dm = (from, text, over = {}) => ({ message_id: 1, chat: { id: from.id, type: 'private' }, from, text, ...over });

function world({ env = {}, admins = [], chats, fail } = {}) {
  const cfg = config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GROUP_ID: String(GROUP), TELEGRAM_LOG_CHAT_ID: String(STAFF), TELEGRAM_ADMIN_IDS: '7959617162', ...env });
  const api = fakeApi({ admins, chats, fail });
  const store = new Store(path.join(tmp(), 'telegram.json'));
  const bot = createBot(cfg, { log: quiet, store, api });
  bot.ctx.me = { id: 8741642707, username: 'etheroute_bot' };
  moderation.adminCache.clear();
  return { cfg, api, store, bot, ctx: bot.ctx };
}

describe('The config', () => {
  test('a token and a channel or a group; the group alone is enough; the shape of each id is checked', () => {
    const c = config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GROUP_ID: String(GROUP), TELEGRAM_ADMIN_IDS: '7959617162, x, 42' });
    assert.deepStrictEqual(config.problems(c), []);
    assert.strictEqual(c.postChatId, String(GROUP), 'no channel: the group is where posts go');
    assert.deepStrictEqual(c.adminIds, [7959617162, 42]);
    assert.strictEqual(c.supportChatId, '', 'no staff chat: no support relay');
    assert.strictEqual(config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL_ID: '@etheroute', TELEGRAM_GROUP_ID: String(GROUP) }).postChatId, '@etheroute');
    assert.strictEqual(config.read({ TELEGRAM_LOG_CHAT_ID: '-100' }).supportChatId, '-100', 'the staff chat doubles as the support chat');
    assert.strictEqual(config.read({ PORT: '80' }).status.apiUrl, 'http://127.0.0.1:80');
    assert.strictEqual(config.read({ DISCORD_API_URL: 'https://etheroute.io' }).status.apiUrl, 'https://etheroute.io', 'the Discord bot\'s setting carries over');
    assert.deepStrictEqual(config.read({ DISCORD_MAIN_CHAINS: 'btc' }).status.mainChains, ['BTC']);
    assert.strictEqual(config.read({ TELEGRAM_VERIFY_TIMEOUT_MS: '5' }).verify.timeoutMs, 60000, 'never under a minute');
    const none = config.problems(config.read({}));
    assert.strictEqual(none.length, 2);
    assert.ok(none[0].includes('@BotFather') && none[1].includes('TELEGRAM_CHANNEL_ID nor TELEGRAM_GROUP_ID'));
    const bad = config.problems(config.read({ TELEGRAM_BOT_TOKEN: 'nope', TELEGRAM_CHANNEL_ID: 'etheroute', TELEGRAM_GROUP_ID: 'abc', TELEGRAM_LOG_CHAT_ID: '12x' }));
    assert.strictEqual(bad.length, 5, 'the staff chat is also the support chat, so its bad id is named twice');
    assert.ok(bad[0].includes('does not look like a bot token'));
    assert.ok(bad[1].includes('does not look like a channel'));
    assert.ok(bad[2].includes('TELEGRAM_GROUP_ID') && bad[3].includes('TELEGRAM_LOG_CHAT_ID') && bad[4].includes('TELEGRAM_SUPPORT_CHAT_ID'));
  });
});

describe('The Bot API client', () => {
  test('one POST per method, the result unwrapped, Telegram\'s own error when it says no', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 1, username: 'x' } }) };
      if (String(url).endsWith('/sendMessage')) return { ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }) };
      return { ok: false, status: 500, json: async () => { throw new Error('not json'); } };
    };
    const api = new Api(TOKEN, { fetchImpl });
    assert.deepStrictEqual(await api.getMe(), { id: 1, username: 'x' });
    assert.ok(seen[0].url.endsWith(`/bot${TOKEN}/getMe`));
    await assert.rejects(() => api.sendMessage(5, 'hi'), (err) => err instanceof TelegramError && err.code === 429 && err.parameters.retry_after === 7 && /retry after 7/.test(err.message));
    assert.strictEqual(seen[1].body.parse_mode, 'HTML');
    assert.deepStrictEqual(seen[1].body.link_preview_options, { is_disabled: true });
    assert.strictEqual(seen[1].body.chat_id, 5);
    await assert.rejects(() => api.call('whatever'), (err) => err.code === 500 && /HTTP 500/.test(err.description));
    assert.strictEqual(Object.values(NO_PERMISSIONS).some(Boolean), false);
    assert.strictEqual(FULL_PERMISSIONS.can_send_messages, true);
    assert.strictEqual(FULL_PERMISSIONS.can_change_info, false, 'a lifted mute does not make anyone an admin');
  });

  test('the poller hands each update on, confirms it, and stops when told', async () => {
    const handled = [];
    let round = 0;
    const api = { getUpdates: async (params) => { round += 1; if (round === 1) return [{ update_id: 10, message: 'a' }, { update_id: 11, message: 'b' }]; assert.strictEqual(params.offset, 12, 'asks from the next id'); poller.stop(); return []; } };
    const poller = new Poller(api, async (u) => { handled.push(u.update_id); if (u.update_id === 11) throw new Error('one bad update does not stop the loop'); }, { log: quiet, timeout: 0 });
    await poller.start();
    assert.deepStrictEqual(handled, [10, 11]);
    assert.strictEqual(round, 2);
  });
});

describe('The HTML', () => {
  test('everything typed is escaped; the helpers add the tags; a card drops empty rows; a long message is cut', () => {
    assert.strictEqual(fmt.esc('<b>&'), '&lt;b&gt;&amp;');
    assert.strictEqual(fmt.b('x<y'), '<b>x&lt;y</b>');
    assert.strictEqual(fmt.mention({ id: 7, first_name: 'Kae', last_name: '<3' }), '<a href="tg://user?id=7">Kae &lt;3</a>');
    assert.strictEqual(fmt.who({ id: 7, first_name: 'Kae', username: 'kae' }), 'Kae (@kae) <code>7</code>');
    assert.strictEqual(fmt.card('T', [['A', '1'], ['B', ''], null, ['C', 0]]), '<b>T</b>\n<b>A:</b> 1\n<b>C:</b> 0');
    const long = fmt.cut(`${'x'.repeat(4000)}\n${'y'.repeat(200)}`);
    assert.ok(long.length <= fmt.MAX && long.endsWith('…'));
    assert.strictEqual(fmt.ago(new Date(Date.now() - 3600000 * 2).toISOString()), '2h ago');
    assert.strictEqual(fmt.ago(new Date().toISOString()), 'just now');
  });
});

describe('Commands and admins', () => {
  test('a command is parsed with or without @bot; another bot\'s is not ours', () => {
    assert.deepStrictEqual(moderation.parseCommand('/mute@etheroute_bot 1h too loud', 'etheroute_bot'), { name: 'mute', args: '1h too loud', argv: ['1h', 'too', 'loud'] });
    assert.deepStrictEqual(moderation.parseCommand('/Ban', 'etheroute_bot'), { name: 'ban', args: '', argv: [] });
    assert.strictEqual(moderation.parseCommand('/mute@otherbot 1h', 'etheroute_bot'), null);
    assert.strictEqual(moderation.parseCommand('hello /ban', 'etheroute_bot'), null);
    assert.strictEqual(moderation.parseCommand('', 'etheroute_bot'), null);
  });

  test('an admin is someone listed, or someone Telegram calls creator or administrator - remembered for a minute', async () => {
    const { ctx, api } = world({ admins: [55] });
    assert.strictEqual(await moderation.isAdmin(ctx, GROUP, 7959617162), true, 'listed');
    assert.strictEqual(api.of('getChatMember').length, 0, 'without asking');
    assert.strictEqual(await moderation.isAdmin(ctx, GROUP, 55), true);
    assert.strictEqual(await moderation.isAdmin(ctx, GROUP, 55), true);
    assert.strictEqual(api.of('getChatMember').length, 1, 'asked once');
    assert.strictEqual(await moderation.isAdmin(ctx, GROUP, 56), false);
    assert.strictEqual(await moderation.isAdmin(ctx, GROUP, null), false);
  });
});

describe('The status pin', () => {
  const platform = (over = {}) => ({ generatedAt: new Date().toISOString(), overallStatus: 'operational', overallStatusLabel: 'Fully operational', uptimePercentage: 100, services: [{ key: 'API', label: 'API', status: 'operational', statusLabel: 'Operational' }, { key: 'PAYOUTS', label: 'Payout Engine', status: 'operational', statusLabel: 'Operational' }], ...over });
  const chains = (list) => ({ checkedAt: new Date().toISOString(), counts: { up: 60, degraded: 1, down: list.filter((c) => c.status === 'down').length, unknown: 0 }, chains: list, events: [{ at: new Date().toISOString(), chain: 'BASE', name: 'Base', component: 'endpoints', from: '3/3', to: '2/3' }] });
  const fetchFor = (bodies) => async (url) => ({ ok: true, json: async () => (String(url).endsWith('/chains') ? bodies.chains : bodies.platform) });

  test('the text: a glyph, the services, the network counts, main networks in bold, the recent changes, the link', () => {
    const picture = require('../src/utils/statusPicture');
    const cfg = config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GROUP_ID: String(GROUP) });
    const summary = picture.summarise({ platform: platform(), chains: chains([{ code: 'SOL', name: 'Solana', status: 'degraded' }, { code: 'CORE', name: 'Core', status: 'down' }]) });
    const text = status.statusText(summary, cfg);
    assert.ok(text.startsWith('🟠 <b>Etheroute status</b> - Partial outage'));
    assert.ok(text.includes('✅ API: Operational') && text.includes('<b>Networks (2)</b>: 🟢 60 up · 🟠 1 degraded · 🔴 1 down'));
    assert.ok(text.includes('<b>Down</b>: Core (CORE)'));
    assert.ok(text.includes('<b>Degraded</b> <i>(some endpoints not answering)</i>: <b>Solana (SOL)</b>'), 'a main network in bold');
    assert.ok(text.includes('• Base: endpoints 3/3 → 2/3, just now'));
    assert.ok(text.includes('<a href="https://etheroute.io/status">Status page</a>'));
    const gone = status.statusText(picture.summarise({ platform: null, error: 'fetch failed (ECONNREFUSED)' }), cfg);
    assert.ok(gone.startsWith('🔴') && gone.includes('<code>fetch failed (ECONNREFUSED)</code>'));
    const change = status.changeText(picture.summarise({ platform: platform(), chains: chains([]) }), picture.summarise({ platform: platform(), chains: chains([{ code: 'BTC', name: 'Bitcoin', status: 'down' }]) }), cfg);
    assert.ok(change.startsWith('🟠 <b>Fully operational → Partial outage</b>\n🔴 <b>Bitcoin (BTC) is down.</b>'));
  });

  test('one pinned message, edited; a new post only when a main network or a service changes', async () => {
    const { ctx, api, store } = world();
    let bodies = { platform: platform(), chains: chains([]) };
    const opts = { fetchImpl: (u, o) => fetchFor(bodies)(u, o) };
    let r = await status.refresh(ctx, opts);
    assert.strictEqual(api.of('sendMessage').length, 1, 'posted once');
    assert.strictEqual(api.last('sendMessage').chat_id, String(GROUP), 'no channel: into the group');
    assert.strictEqual(api.last('sendMessage').extra.disable_notification, true, 'quietly');
    assert.strictEqual(api.of('pinChatMessage').length, 1);
    assert.strictEqual(store.data.panels.status.messageId, 100);
    assert.strictEqual(r.changed, false);

    r = await status.refresh(ctx, opts);
    assert.strictEqual(api.of('sendMessage').length, 1, 'still one');
    assert.strictEqual(api.of('editMessageText').length, 1, 'edited');

    bodies = { platform: platform(), chains: chains([{ code: 'CORE', name: 'Core', status: 'down' }]) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.posted, false, 'a minor network: the pin is edited, nobody is told');
    assert.strictEqual(api.of('sendMessage').length, 1);

    bodies = { platform: platform(), chains: chains([{ code: 'CORE', name: 'Core', status: 'down' }, { code: 'ETH', name: 'Ethereum', status: 'down' }]) };
    r = await status.refresh(ctx, opts);
    assert.strictEqual(r.posted, true, 'Ethereum: everyone is told');
    assert.ok(api.last('sendMessage').text.includes('<b>Ethereum (ETH) is down.</b>'));
    assert.strictEqual(api.last('sendMessage').extra.disable_notification, undefined, 'with a notification');

    // the pin was deleted by hand: a new one is posted and pinned
    const failing = world({ fail: { editMessageText: { error_code: 400, description: 'Bad Request: message to edit not found' } } });
    failing.store.update('panels', (p) => { p.status = { chatId: String(GROUP), messageId: 5 }; });
    await status.refresh(failing.ctx, opts);
    assert.strictEqual(failing.api.of('sendMessage').length, 1);
    assert.strictEqual(failing.store.data.panels.status.messageId, 100);
    // the same text again is fine
    const same = world({ fail: { editMessageText: { error_code: 400, description: 'Bad Request: message is not modified' } } });
    same.store.update('panels', (p) => { p.status = { chatId: String(GROUP), messageId: 5 }; });
    await status.refresh(same.ctx, opts);
    assert.strictEqual(same.api.of('sendMessage').length, 0);
  });
});

describe('Announcements', () => {
  test('a preview with two buttons; Post sends it where posts go; Cancel does not; nobody else\'s thumb counts', async () => {
    const { ctx, api, bot } = world();
    const admin = user(7959617162, 'Logixx', 'logixxtech');
    await bot.handle({ message: dm(admin, '/announce') });
    assert.ok(api.last('sendMessage').text.includes('<b>How to announce</b>'));
    await bot.handle({ message: dm(user(2, 'Rando'), '/announce Hi\nthere') });
    assert.ok(api.last('sendMessage').text.includes('Only an admin'));

    await bot.handle({ message: dm(admin, '/announce New network: Core (CORE)\nYou can now accept CORE.\n<script>') });
    const preview = api.last('sendMessage');
    assert.strictEqual(preview.chat_id, admin.id);
    assert.ok(preview.text.includes('<b>New network: Core (CORE)</b>\n\nYou can now accept CORE.\n&lt;script&gt;'));
    const [post, cancel] = preview.extra.reply_markup.inline_keyboard[0];
    assert.ok(post.callback_data.startsWith('announce:post:') && cancel.callback_data.startsWith('announce:cancel:'));

    const query = (from, data) => ({ callback_query: { id: 'q1', from, data, message: { message_id: preview.extra ? 100 : 0, chat: { id: admin.id, type: 'private' } } } });
    assert.strictEqual(await bot.handle(query(user(2), post.callback_data)), 'not-yours');
    assert.strictEqual(await bot.handle(query(admin, post.callback_data)), 'posted');
    const out = api.last('sendMessage');
    assert.strictEqual(out.chat_id, String(GROUP));
    assert.ok(out.text.startsWith('<b>New network: Core (CORE)</b>'));
    assert.strictEqual(await bot.handle(query(admin, post.callback_data)), 'gone', 'a draft posts once');
    assert.strictEqual(announce.render('Only a headline', ctx.config), '<b>Only a headline</b>\n\n<i>Etheroute · etheroute.io</i>');
  });
});

describe('The gate on the group', () => {
  test('a newcomer is muted and greeted with a button; their messages are deleted until they press it; then they may talk', async () => {
    const { ctx, api, bot, store } = world();
    const newcomer = user(501, 'New', 'newbie');
    assert.strictEqual(await bot.handle({ message: msg({ from: user(1), new_chat_members: [newcomer] }) }), 'joined');
    const muted = api.last('restrictChatMember');
    assert.strictEqual(muted.user_id, 501);
    assert.strictEqual(muted.permissions.can_send_messages, false);
    const welcome = api.last('sendMessage');
    assert.ok(welcome.text.includes('Welcome to <b>Etheroute</b>'));
    assert.strictEqual(welcome.extra.reply_markup.inline_keyboard[0][0].callback_data, 'verify:501');
    assert.ok(verify.isPending(ctx, GROUP, 501));
    verify.clear(`${GROUP}:501`);

    assert.strictEqual(await bot.handle({ message: msg({ message_id: 77, from: newcomer, text: 'let me in' }) }), 'deleted:unverified');
    assert.strictEqual(api.last('deleteMessage').message_id, 77);

    await bot.handle({ callback_query: { id: 'c1', from: user(502), data: 'verify:501', message: { message_id: 100, chat: { id: GROUP, type: 'supergroup' } } } });
    assert.ok(api.last('answerCallbackQuery').extra.text.includes('someone else'));
    assert.ok(verify.isPending(ctx, GROUP, 501));

    await bot.handle({ callback_query: { id: 'c2', from: newcomer, data: 'verify:501', message: { message_id: 100, chat: { id: GROUP, type: 'supergroup' } } } });
    assert.strictEqual(api.last('restrictChatMember').permissions.can_send_messages, true);
    assert.ok(api.last('answerCallbackQuery').extra.text.includes('Welcome in'));
    assert.ok(api.last('editMessageText').text.includes('✅ Welcome'));
    assert.ok(!verify.isPending(ctx, GROUP, 501));
    assert.ok(verify.joinedAt(ctx, GROUP, 501), 'the join is remembered for the link filter');

    // bots and admins are not gated
    assert.strictEqual(await verify.onJoin(ctx, GROUP, { id: 9, is_bot: true, first_name: 'B' }), false);
    assert.strictEqual(await verify.onJoin(ctx, GROUP, user(7959617162)), false);
    assert.strictEqual(Object.keys(store.data.pending).length, 0);
  });

  test('the clock runs out: shown out, welcome deleted, staff told; a restart resumes the clocks', async () => {
    const { ctx, api, store } = world();
    await verify.onJoin(ctx, GROUP, user(601, 'Slow'));
    const record = store.data.pending[`${GROUP}:601`];
    assert.ok(record && record.messageId);
    verify.clear(`${GROUP}:601`);
    assert.strictEqual(await verify.expire(ctx, record), true);
    assert.strictEqual(api.last('banChatMember').user_id, 601);
    assert.strictEqual(api.last('unbanChatMember').user_id, 601, 'a kick, not a ban: they may try again');
    assert.strictEqual(api.last('deleteMessage').message_id, record.messageId);
    assert.ok(api.last('sendMessage').chat_id === String(STAFF) && api.last('sendMessage').text.includes('Did not verify'));
    assert.strictEqual(await verify.expire(ctx, record), false, 'once');

    await verify.onJoin(ctx, GROUP, user(602, 'Later'));
    verify.clear(`${GROUP}:602`);
    const again = new Store(store.file);
    assert.strictEqual(verify.resume({ ...ctx, store: again }), 1);
    verify.clear(`${GROUP}:602`);
  });

  test('a link in a newcomer\'s first day is deleted and earns an hour\'s mute; older members, admins and channel posts are left alone', async () => {
    const { ctx, api, store } = world();
    store.update('joined', (j) => { j[`${GROUP}:701`] = Date.now() - 3600000; j[`${GROUP}:702`] = Date.now() - 3 * 86400000; });
    assert.strictEqual(await verify.onMessage(ctx, msg({ message_id: 5, from: user(701), text: 'free airdrop t.me/scam' })), 'deleted:link');
    assert.strictEqual(api.last('deleteMessage').message_id, 5);
    assert.strictEqual(api.last('restrictChatMember').user_id, 701);
    assert.ok(api.last('restrictChatMember').until_date > Date.now() / 1000 + 3000);
    assert.ok(api.last('sendMessage').text.includes('Link from a newcomer'));
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(701), text: 'hello everyone' })), null, 'plain talk is fine');
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(701), text: 'see this', entities: [{ type: 'text_link', url: 'https://x' }] })), 'deleted:link');
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(701), forward_origin: { type: 'channel' } })), 'deleted:link', 'a forwarded channel post too');
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(702), text: 'https://etheroute.io' })), null, 'three days in: past the grace period');
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(703), text: 'https://etheroute.io' })), null, 'never seen joining: not a newcomer');
    store.update('joined', (j) => { j[`${GROUP}:7959617162`] = Date.now(); });
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(7959617162), text: 'https://etheroute.io' })), null, 'an admin');
    assert.strictEqual(await verify.onMessage(ctx, msg({ from: user(777000), sender_chat: { id: 1 }, text: 'https://x' })), null, 'the channel\'s own posts');
  });
});

describe('Moderation in the group', () => {
  const admin = user(7959617162, 'Logixx', 'logixxtech');
  const target = user(900, 'Loud', 'loud');
  const replyTo = (text, over = {}) => msg({ message_id: 50, from: admin, text, reply_to_message: { message_id: 40, from: target, text: 'spam spam', chat: { id: GROUP } }, ...over });

  test('a member\'s command is ignored; an admin\'s acts on the person replied to, and the staff chat hears', async () => {
    const { api, bot } = world();
    assert.strictEqual(await bot.handle({ message: msg({ from: user(2), text: '/ban', reply_to_message: { message_id: 40, from: target } }) }), null);
    assert.strictEqual(api.of('banChatMember').length, 0);

    assert.strictEqual(await bot.handle({ message: replyTo('/ban selling things') }), 'ban');
    assert.strictEqual(api.last('banChatMember').user_id, 900);
    assert.strictEqual(api.last('deleteMessage').message_id, 40, 'the offending message goes too');
    const staff = api.of('sendMessage').find((c) => c.chat_id === String(STAFF));
    assert.ok(staff && staff.text.includes('<b>🔨 Banned</b>') && staff.text.includes('selling things'));
    assert.ok(api.last('sendMessage').text.includes('was banned'));

    assert.strictEqual(await bot.handle({ message: replyTo('/kick') }), 'kick');
    assert.strictEqual(api.last('unbanChatMember').user_id, 900);

    assert.strictEqual(await bot.handle({ message: replyTo('/mute 2h too loud') }), 'mute');
    const mute = api.last('restrictChatMember');
    assert.strictEqual(mute.permissions.can_send_messages, false);
    assert.ok(mute.until_date > Date.now() / 1000 + 7100 && mute.until_date < Date.now() / 1000 + 7300);
    assert.ok(api.last('sendMessage').text.includes('is muted for 2h'));
    await bot.handle({ message: replyTo('/mute') });
    assert.ok(api.last('sendMessage').text.includes('for 1h'), 'a bare /mute is an hour');
    await bot.handle({ message: replyTo('/unmute') });
    assert.strictEqual(api.last('restrictChatMember').permissions.can_send_messages, true);

    assert.strictEqual(await bot.handle({ message: replyTo('/ban') , }), 'ban');
    assert.strictEqual(await bot.handle({ message: msg({ from: admin, text: '/ban' }) }), 'ban');
    assert.ok(api.last('sendMessage').text.includes('Reply to a message'), 'without a reply there is nobody to act on');
    assert.strictEqual(await bot.handle({ message: msg({ from: admin, text: '/ban', reply_to_message: { message_id: 41, from: user(7959617162) } }) }), 'ban');
    assert.ok(api.last('sendMessage').text.includes('Not on an admin'));
  });

  test('warnings accumulate and clear; /del and /purge delete; /id says the ids', async () => {
    const { api, bot, store } = world();
    await bot.handle({ message: replyTo('/warn no links') });
    await bot.handle({ message: replyTo('/warn again') });
    assert.ok(api.last('sendMessage').text.includes('(2 on record)'));
    assert.strictEqual(moderation.warningsFor({ store }, GROUP, 900).length, 2);
    await bot.handle({ message: replyTo('/warnings') });
    assert.ok(api.last('sendMessage').text.includes('1. no links') && api.last('sendMessage').text.includes('2. again'));
    await bot.handle({ message: replyTo('/clearwarnings') });
    assert.strictEqual(moderation.warningsFor({ store }, GROUP, 900).length, 0);

    await bot.handle({ message: replyTo('/del') });
    assert.deepStrictEqual(api.of('deleteMessage').slice(-2).map((c) => c.message_id), [40, 50], 'theirs, then the command');

    await bot.handle({ message: replyTo('/purge') });
    assert.deepStrictEqual(api.last('deleteMessages').message_ids.length, 11, 'from the replied-to message to the command');
    await bot.handle({ message: msg({ message_id: 500, from: admin, text: '/purge', reply_to_message: { message_id: 1, from: target } }) });
    assert.ok(api.last('sendMessage').text.includes('more than 100'));

    await bot.handle({ message: replyTo('/id') });
    const ids = api.last('sendMessage').text;
    assert.ok(ids.includes(`<code>${GROUP}</code>`) && ids.includes('<code>7959617162</code>') && ids.includes('<code>900</code>'));
  });

  test('anyone may ask for the rules; a member\'s /support is pointed to a private chat', async () => {
    const { api, bot } = world();
    await bot.handle({ message: msg({ from: user(2), text: '/rules' }) });
    assert.ok(api.last('sendMessage').text.includes('<b>1. Be decent</b>'));
    await bot.handle({ message: msg({ from: user(2), text: '/support' }) });
    assert.ok(api.last('sendMessage').text.includes('Message me privately'));
  });
});

describe('Support by private message', () => {
  test('a person\'s message opens a ticket and is copied to the staff chat; a staff reply comes back; /close ends it', async () => {
    const { api, bot, store } = world();
    const person = user(3000, 'Pat', 'pat');
    await bot.handle({ message: dm(person, '/support') });
    assert.ok(api.last('sendMessage').text.includes('<b>Tell us what you need</b>'));

    await bot.handle({ message: dm(person, 'My payout is stuck', { message_id: 12 }) });
    const head = api.of('sendMessage').find((c) => c.chat_id === String(STAFF));
    assert.ok(head.text.includes('<b>Ticket #1</b> from <a href="tg://user?id=3000">Pat</a>'));
    const copy = api.last('copyMessage');
    assert.strictEqual(copy.chat_id, String(STAFF));
    assert.strictEqual(copy.message_id, 12);
    assert.strictEqual(copy.extra.reply_parameters.message_id, head && 100 + api.of('sendMessage').indexOf(head));
    assert.ok(api.last('sendMessage').text.includes('ticket <b>#1</b> is open'));
    assert.strictEqual(support.openTicket({ store }, 3000).number, 1);

    await bot.handle({ message: dm(person, 'still stuck', { message_id: 13 }) });
    assert.strictEqual(api.of('sendMessage').filter((c) => c.chat_id === 3000 && c.text.includes('is open')).length, 1, 'told once');

    const staffReply = { message_id: 900, chat: { id: STAFF, type: 'supergroup', title: 'Staff' }, from: user(7959617162, 'Logixx'), text: 'Looking now', reply_to_message: { message_id: copy.chat_id === String(STAFF) ? 101 : 0 } };
    assert.strictEqual(await bot.handle({ message: staffReply }), 'relayed');
    const back = api.last('copyMessage');
    assert.strictEqual(back.chat_id, 3000);
    assert.strictEqual(back.message_id, 900);

    assert.strictEqual(await bot.handle({ message: { ...staffReply, message_id: 901, text: '/close paid out' } }), 'closed');
    assert.strictEqual(support.openTicket({ store }, 3000), null);
    assert.ok(api.of('sendMessage').some((c) => c.chat_id === 3000 && c.text.includes('#1</b> was closed: paid out')));
    assert.strictEqual(await bot.handle({ message: { ...staffReply, message_id: 902, text: 'one more' } }), 'closed-ticket');
    assert.strictEqual(await bot.handle({ message: { ...staffReply, message_id: 903, text: 'hello', reply_to_message: { message_id: 5 } } }), null, 'a reply to anything else is staff talking');

    await bot.handle({ message: dm(person, 'new problem', { message_id: 14 }) });
    assert.strictEqual(support.openTicket({ store }, 3000).number, 2, 'writing again opens the next');
  });

  test('without a staff chat, /support says where else to turn and messages are not relayed', async () => {
    const { api, bot } = world({ env: { TELEGRAM_LOG_CHAT_ID: '' } });
    const person = user(3001, 'Sam');
    await bot.handle({ message: dm(person, '/support') });
    assert.ok(api.last('sendMessage').text.includes('not set up here yet'));
    assert.strictEqual(await bot.handle({ message: dm(person, 'help me') }), null);
  });
});

describe('Merchants', () => {
  const stand = (routes) => async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace('/api/telegram/internal', '')}`;
    assert.strictEqual(init.headers['x-internal-secret'], merchant.internalSecret(TOKEN), 'the derived secret travels, not the token');
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ success: false, message: 'No account is linked to that chat' }) };
    const out = typeof r === 'function' ? r(u, init.body ? JSON.parse(init.body) : null) : r;
    const st = out.status || 200;
    return { ok: st < 400, status: st, json: async () => out.body };
  };

  test('the deep link\'s code is carried to the API; /stats and /recent read back; /notify sets; /unlink undoes', async () => {
    const me = user(4000, 'Merch', 'merch');
    const seen = [];
    const account = { clientId: 'c1', username: 'shop', linked: true, prefs: { paid: true, payouts: false } };
    const fetchImpl = stand({
      'POST /link': (u, body) => { seen.push(body); return body.code === 'ABCD2345' ? { body: { success: true, account } } : { status: 404, body: { success: false, message: 'That code is not one I gave out.' } }; },
      'GET /stats': { body: { success: true, account, stats: { today: { count: 2, usd: 50 }, week: { count: 9, usd: 410.5 }, month: { count: 20, usd: 1200 }, allTime: { count: 20, usd: 1200 }, openCheckouts: 1, wallets: 3, balanceUsd: 812.4, payouts: { count: 2, completed: 2 }, lastPayment: { at: new Date().toISOString(), chain: 'ETH', asset: 'ETH', nativeAmount: 0.02, usdAmount: 50 } } } },
      'GET /recent': { body: { success: true, account, payments: [{ at: '2026-09-21T10:00:00.000Z', chain: 'BASE', asset: 'USDC', nativeAmount: 25, usdAmount: 25, txHash: '0x' + 'ab'.repeat(32) }] } },
      'PUT /preferences': (u, body) => ({ body: { success: true, account: { ...account, prefs: { ...account.prefs, ...body.prefs } } } }),
      'POST /unlink': { body: { success: true, unlinked: 1 } },
      'GET /account': { body: { success: true, account } },
    });
    // the merchant module reaches the API through fetch; stand in for it
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      assert.strictEqual(merchant.linkCodeFrom('link_abcd2345'), 'ABCD2345');
      assert.strictEqual(merchant.linkCodeFrom('link-ABCD2345'), 'ABCD2345');
      assert.strictEqual(merchant.linkCodeFrom(''), null);
      assert.strictEqual(merchant.linkCodeFrom('link_x'), null);

      const { bot: b, api: a } = world();
      await b.handle({ message: dm(me, '/start link_abcd2345') });
      assert.strictEqual(seen[0].chatId, 4000);
      assert.strictEqual(seen[0].username, 'merch');
      assert.ok(a.last('sendMessage').text.includes('<b>Linked</b> to your Etheroute account <b>shop</b>'), a.last('sendMessage').text);
      await b.handle({ message: dm(me, '/start link_WRONG999') });
      assert.ok(a.last('sendMessage').text.includes('not one I gave out'));
      await b.handle({ message: dm(me, '/start') });
      assert.ok(a.last('sendMessage').text.includes('Hello, Merch'), 'a plain /start is the greeting');

      await b.handle({ message: dm(me, '/stats') });
      const statsText = a.last('sendMessage').text;
      assert.ok(statsText.includes('📊 <b>shop</b>') && statsText.includes('<b>7 days</b>: 9 payments · $410.50') && statsText.includes('$812.40 in 3 wallets'), statsText);
      await b.handle({ message: dm(me, '/recent') });
      assert.ok(a.last('sendMessage').text.includes('25 USDC ($25.00) on BASE') && a.last('sendMessage').text.includes('<code>0xabababab…abababab</code>'), a.last('sendMessage').text);
      await b.handle({ message: dm(me, '/notify') });
      assert.ok(a.last('sendMessage').text.includes('🔔 on - when a payment settles') && a.last('sendMessage').text.includes('🔕 off - when a payout finishes'));
      await b.handle({ message: dm(me, '/notify payouts on') });
      assert.ok(a.last('sendMessage').text.includes('🔔 on - when a payout finishes'));
      await b.handle({ message: dm(me, '/notify nonsense') });
      assert.ok(a.last('sendMessage').text.includes('Say <code>/notify paid on</code>'));
      await b.handle({ message: dm(me, '/unlink') });
      assert.ok(a.last('sendMessage').text.includes('Unlinked.'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a chat nobody linked is told how to link; an API that is down is said plainly', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stand({});
    try {
      const { bot, api } = world();
      await bot.handle({ message: dm(user(4001, 'Nobody'), '/stats') });
      assert.ok(api.last('sendMessage').text.includes('not linked to an Etheroute account'));
      globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
      await bot.handle({ message: dm(user(4001, 'Nobody'), '/stats') });
      assert.ok(api.last('sendMessage').text.includes('The API did not answer'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('The rules and the routing', () => {
  test('the rules as one message: twelve, numbered, the bot named as the way to support, within the limit', () => {
    const cfg = config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GROUP_ID: String(GROUP) });
    const text = rulesText(cfg, { botUsername: 'etheroute_bot' });
    assert.ok(text.startsWith('<b>Etheroute rules</b>'));
    assert.strictEqual((text.match(/<b>\d+\. /g) || []).length, 12);
    assert.ok(text.includes('a private message to @etheroute_bot (/support)'));
    assert.ok(text.includes('To report something, open a ticket by messaging @etheroute_bot privately with /support, or mention an admin. Staff will never DM you first.'));
    assert.ok(!text.includes('{'), 'no unfilled placeholder');
    assert.ok(text.length <= fmt.MAX);
  });

  test('updates go where they belong: a stranger\'s group is ignored, the staff chat is not gated, joins seen only as chat_member updates are gated, and being added is logged', async () => {
    const lines = [];
    const log = { ...quiet, info: (...a) => lines.push(a.join(' ')) };
    const cfg = config.read({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GROUP_ID: String(GROUP), TELEGRAM_LOG_CHAT_ID: String(STAFF) });
    const api = fakeApi();
    const bot = createBot(cfg, { log, store: new Store(path.join(tmp(), 'telegram.json')), api });
    bot.ctx.me = { id: 8741642707, username: 'etheroute_bot' };
    moderation.adminCache.clear();
    assert.strictEqual(await bot.handle({ message: msg({ chat: { id: -100555, type: 'supergroup' }, new_chat_members: [user(9)] }) }), null, 'another group');
    assert.strictEqual(await bot.handle({ message: msg({ chat: { id: STAFF, type: 'supergroup' }, new_chat_members: [user(9)] }) }), null, 'the staff chat is not gated');
    assert.strictEqual(api.of('restrictChatMember').length, 0);
    assert.strictEqual(await bot.handle({ chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Etheroute.io' }, from: user(1), old_chat_member: { status: 'left', user: user(10) }, new_chat_member: { status: 'member', user: user(10, 'Quiet') } } }), true);
    assert.strictEqual(api.last('restrictChatMember').user_id, 10);
    verify.clear(`${GROUP}:10`);
    assert.strictEqual(await bot.handle({ chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Etheroute.io' }, from: user(1), old_chat_member: { status: 'member', user: user(11) }, new_chat_member: { status: 'left', user: user(11, 'Gone') } } }), 'left');
    assert.ok(api.last('sendMessage').chat_id === String(STAFF) && api.last('sendMessage').text.includes('📤 Left'));
    assert.strictEqual(await bot.handle({ my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Etheroute.io' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } }), 'me');
    assert.ok(lines.at(-1).includes('make me an admin'));
    assert.strictEqual(await bot.handle({ callback_query: { id: 'x', from: user(1), data: 'something:else', message: { chat: { id: GROUP } } } }), true, 'an unknown button is answered so it stops spinning');
    assert.strictEqual(await bot.handle({ edited_message: {} }), null);
  });
});
