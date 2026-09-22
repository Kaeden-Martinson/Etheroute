'use strict';

/**
 * Announcements to the channel (or the group, when there is no channel),
 * from a private chat with the bot. An
 * admin writes "/announce" followed by the post - the first line is the
 * headline - and gets it back as a preview with two buttons: Post, or
 * Cancel. Nothing reaches the channel until Post is pressed, so a slip of
 * the thumb never goes out to every subscriber.
 */

const { esc, b, i, cut } = require('./format');

const PREFIX = 'announce:';
const drafts = new Map();

/** "/announce New chain: Core\nYou can now..." → the HTML the channel gets. */
function render(text, config) {
  const lines = String(text || '').trim().split('\n');
  const title = lines.shift().trim();
  const body = lines.join('\n').trim();
  return cut([b(title), body ? '' : null, body ? esc(body) : null, '', i(`${config.brand.name} · ${config.brand.site.replace(/^https?:\/\//, '')}`)].filter((l) => l !== null).join('\n'));
}

function keyboard(id) {
  return { inline_keyboard: [[{ text: '📣 Post it', callback_data: `${PREFIX}post:${id}` }, { text: '✖ Cancel', callback_data: `${PREFIX}cancel:${id}` }]] };
}

/** /announce in a private chat: show the preview and the two buttons. */
async function start(ctx, message, text) {
  if (!text) {
    await ctx.api.sendMessage(message.chat.id, [b('How to announce'), '', 'Write the post after the command; the first line is the headline:', '', '<code>/announce New network: Core (CORE)\nYou can now accept CORE on Core. Confirmation threshold: 12 blocks.</code>', '', 'You get a preview with a Post button. Nothing goes out until you press it.'].join('\n'));
    return null;
  }
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const html = render(text, ctx.config);
  drafts.set(id, { html, by: message.from.id, at: Date.now() });
  for (const [k, d] of drafts) if (Date.now() - d.at > 3600000) drafts.delete(k); // an hour-old draft is not going out
  await ctx.api.sendMessage(message.chat.id, `${i('Preview - this is how the channel will see it:')}\n\n${html}`, { reply_markup: keyboard(id) });
  return id;
}

/** Post or Cancel was pressed. */
async function onButton(ctx, query) {
  const [, action, id] = query.data.split(':');
  const draft = drafts.get(id);
  if (!draft) {
    await ctx.api.answerCallbackQuery(query.id, { text: 'That draft is gone - write it again.', show_alert: true });
    return 'gone';
  }
  if (query.from.id !== draft.by) {
    await ctx.api.answerCallbackQuery(query.id, { text: 'Not your draft.' });
    return 'not-yours';
  }
  drafts.delete(id);
  const chat = query.message.chat.id;
  const mid = query.message.message_id;
  if (action === 'cancel') {
    await ctx.api.answerCallbackQuery(query.id, { text: 'Cancelled.' });
    await ctx.api.editMessageText(chat, mid, `${i('Cancelled.')}\n\n${draft.html}`).catch(() => {});
    return 'cancelled';
  }
  try {
    const posted = await ctx.api.sendMessage(ctx.config.postChatId, draft.html);
    await ctx.api.answerCallbackQuery(query.id, { text: 'Posted.' });
    await ctx.api.editMessageText(chat, mid, `${i(`Posted (message ${posted.message_id}).`)}\n\n${draft.html}`).catch(() => {});
    ctx.log.info(`announcement posted to ${ctx.config.postChatId} by ${query.from.id}`);
    return 'posted';
  } catch (err) {
    await ctx.api.answerCallbackQuery(query.id, { text: `Could not post: ${err.description || err.message}`, show_alert: true });
    ctx.log.error('announcement failed:', err.description || err.message);
    return 'failed';
  }
}

module.exports = { PREFIX, render, start, onButton, drafts };
