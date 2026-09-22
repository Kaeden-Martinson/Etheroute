'use strict';

/**
 * The Telegram Bot API, called directly: one POST per method over fetch,
 * the result unwrapped, an error with Telegram's own code and words when
 * it says no. Small enough to read in one sitting, which is why there is
 * no framework in between. The poller at the bottom runs the long-polling
 * loop that brings updates in.
 */

class TelegramError extends Error {
  constructor(method, body) {
    super(`${method}: ${body && body.description ? body.description : 'unknown error'}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = body ? body.error_code : 0;
    this.description = body ? body.description : '';
    this.parameters = (body && body.parameters) || {};
  }
}

class Api {
  constructor(token, { fetchImpl = globalThis.fetch, base = 'https://api.telegram.org' } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.base = base.replace(/\/+$/, '');
  }

  async call(method, params = {}, { timeoutMs = 40000 } = {}) {
    const body = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body[k] = v;
    const res = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) throw new TelegramError(method, json || { error_code: res.status, description: `HTTP ${res.status}` });
    return json.result;
  }

  // ── who and where ──────────────────────────────────────────────────────
  getMe() { return this.call('getMe'); }
  getChat(chat_id) { return this.call('getChat', { chat_id }); }
  getChatMember(chat_id, user_id) { return this.call('getChatMember', { chat_id, user_id }); }
  getChatAdministrators(chat_id) { return this.call('getChatAdministrators', { chat_id }); }
  getChatMemberCount(chat_id) { return this.call('getChatMemberCount', { chat_id }); }
  setMyCommands(commands, scope) { return this.call('setMyCommands', { commands, scope }); }

  // ── messages ───────────────────────────────────────────────────────────
  /** HTML by default, no link previews; `extra` overrides anything. */
  sendMessage(chat_id, text, extra = {}) {
    return this.call('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }
  editMessageText(chat_id, message_id, text, extra = {}) {
    return this.call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }
  editMessageReplyMarkup(chat_id, message_id, reply_markup) { return this.call('editMessageReplyMarkup', { chat_id, message_id, reply_markup }); }
  deleteMessage(chat_id, message_id) { return this.call('deleteMessage', { chat_id, message_id }); }
  deleteMessages(chat_id, message_ids) { return this.call('deleteMessages', { chat_id, message_ids }); }
  pinChatMessage(chat_id, message_id, disable_notification = true) { return this.call('pinChatMessage', { chat_id, message_id, disable_notification }); }
  unpinChatMessage(chat_id, message_id) { return this.call('unpinChatMessage', { chat_id, message_id }); }
  copyMessage(chat_id, from_chat_id, message_id, extra = {}) { return this.call('copyMessage', { chat_id, from_chat_id, message_id, ...extra }); }
  forwardMessage(chat_id, from_chat_id, message_id) { return this.call('forwardMessage', { chat_id, from_chat_id, message_id }); }
  answerCallbackQuery(callback_query_id, extra = {}) { return this.call('answerCallbackQuery', { callback_query_id, ...extra }); }
  sendDocument(chat_id, document, extra = {}) { return this.call('sendDocument', { chat_id, document, ...extra }); }

  // ── members ────────────────────────────────────────────────────────────
  restrictChatMember(chat_id, user_id, permissions, until_date) {
    return this.call('restrictChatMember', { chat_id, user_id, permissions, until_date, use_independent_chat_permissions: false });
  }
  banChatMember(chat_id, user_id, extra = {}) { return this.call('banChatMember', { chat_id, user_id, ...extra }); }
  unbanChatMember(chat_id, user_id) { return this.call('unbanChatMember', { chat_id, user_id, only_if_banned: true }); }

  // ── updates ────────────────────────────────────────────────────────────
  getUpdates(params = {}) { return this.call('getUpdates', params, { timeoutMs: ((params.timeout || 0) + 10) * 1000 }); }
}

/** Every permission a normal member of a group has, for lifting a restriction. */
const FULL_PERMISSIONS = Object.freeze({
  can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true,
  can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_change_info: false, can_invite_users: true, can_pin_messages: false, can_manage_topics: false,
});
/** Nothing at all: the state a newcomer sits in until they press the button. */
const NO_PERMISSIONS = Object.freeze(Object.fromEntries(Object.keys(FULL_PERMISSIONS).map((k) => [k, false])));

/**
 * Long polling: ask for updates, wait up to `timeout` seconds for some,
 * hand each to `handle`, confirm them by asking from the next id. A
 * network hiccup backs off and tries again; a 409 means another copy of
 * the bot is polling with the same token, which is said plainly.
 */
class Poller {
  constructor(api, handle, { log, timeout = 30, allowedUpdates = ['message', 'edited_message', 'callback_query', 'chat_member', 'my_chat_member'] } = {}) {
    this.api = api;
    this.handle = handle;
    this.log = log;
    this.timeout = timeout;
    this.allowedUpdates = allowedUpdates;
    this.offset = 0;
    this.running = false;
  }

  async start() {
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates({ offset: this.offset, timeout: this.timeout, allowed_updates: this.allowedUpdates });
        backoff = 1000;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await this.handle(update);
          } catch (err) {
            if (this.log) this.log.error('update failed:', err);
          }
        }
      } catch (err) {
        if (!this.running) break;
        if (err.code === 409) this.log && this.log.error('another copy of this bot is polling with the same token; stop one of them');
        else if (err.code === 429) { const wait = ((err.parameters && err.parameters.retry_after) || 5) * 1000; this.log && this.log.warn(`rate limited; waiting ${wait}ms`); await sleep(wait); continue; }
        else this.log && this.log.warn('polling failed:', err.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  stop() { this.running = false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { Api, Poller, TelegramError, FULL_PERMISSIONS, NO_PERMISSIONS, sleep };
