'use strict';

/**
 * Telegram's HTML, safely: everything a person typed is escaped, and the
 * few tags the Bot API allows (<b>, <i>, <code>, <pre>, <a>) are added by
 * these helpers and nowhere else. A message is at most 4096 characters.
 */

const { formatDuration } = require('../../src/utils/duration');

const MAX = 4096;

function esc(text) {
  return String(text === undefined || text === null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const b = (text) => `<b>${esc(text)}</b>`;
const i = (text) => `<i>${esc(text)}</i>`;
const code = (text) => `<code>${esc(text)}</code>`;
const pre = (text) => `<pre>${esc(text)}</pre>`;
const link = (text, url) => `<a href="${esc(url)}">${esc(text)}</a>`;

/** A person's name as a tap-to-open mention. */
function mention(user) {
  if (!user) return 'someone';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
  return `<a href="tg://user?id=${user.id}">${esc(name)}</a>`;
}

/** A person for the log: name, @username if any, id. */
function who(user) {
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || '(no name)';
  return `${esc(name)}${user.username ? ` (@${esc(user.username)})` : ''} ${code(user.id)}`;
}

/** A card: a bold title, then "Label: value" lines; empty values are dropped. */
function card(title, rows = [], { footer } = {}) {
  const lines = [b(title)];
  for (const row of rows) {
    if (!row) continue;
    const [label, value] = row;
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${b(`${label}:`)} ${value}`);
  }
  if (footer) lines.push('', i(footer));
  return cut(lines.join('\n'));
}

/** Trimmed to Telegram's limit, on a line if it can. */
function cut(text, max = MAX) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 2);
  const nl = head.lastIndexOf('\n');
  return `${nl > max * 0.7 ? head.slice(0, nl) : head}…`;
}

/** A time as a plain UTC stamp; Telegram has no relative-time markup. */
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/** "a minute ago", "3 hours ago" - for the status line, where a stamp reads cold. */
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  if (ms < 45000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

module.exports = { MAX, esc, b, i, code, pre, link, mention, who, card, cut, when, ago, formatDuration };
