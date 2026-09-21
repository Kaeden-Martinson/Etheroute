'use strict';

/**
 * One look for everything the bot says: the alert palette the server
 * already uses on its webhook embeds, the brand in the footer, a time
 * on each. Commands reply through these so a kick, a giveaway and a
 * welcome read as the same voice.
 */

const { EmbedBuilder } = require('discord.js');

const COLORS = {
  brand: 0x1d4e89,
  ok: 0x1f7a43,
  warn: 0xe8a23a,
  danger: 0xd9534f,
  critical: 0xb3261e,
  muted: 0x6b7280,
};

/**
 * embed({ title, description, color, fields, footer, thumbnail, author, timestamp })
 * fields: [{ name, value, inline }] - empty values are dropped, long ones cut.
 */
function embed({ title, description, color = COLORS.brand, fields = [], footer, thumbnail, image, author, timestamp = true, url } = {}) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(cut(title, 256));
  if (description) e.setDescription(cut(description, 4096));
  if (url) e.setURL(url);
  const clean = fields
    .filter((f) => f && f.name && f.value !== undefined && f.value !== null && String(f.value) !== '')
    .slice(0, 25)
    .map((f) => ({ name: cut(f.name, 256), value: cut(String(f.value), 1024), inline: f.inline !== false }));
  if (clean.length) e.addFields(clean);
  if (footer) e.setFooter(typeof footer === 'string' ? { text: cut(footer, 2048) } : footer);
  if (isUrl(thumbnail)) e.setThumbnail(thumbnail);
  if (isUrl(image)) e.setImage(image);
  if (author) e.setAuthor(author);
  if (timestamp) e.setTimestamp(timestamp === true ? new Date() : timestamp);
  return e;
}

const ok = (description, extra = {}) => embed({ color: COLORS.ok, description: `✅ ${description}`, timestamp: false, ...extra });
const fail = (description, extra = {}) => embed({ color: COLORS.danger, description: `⛔ ${description}`, timestamp: false, ...extra });
const note = (description, extra = {}) => embed({ color: COLORS.muted, description, timestamp: false, ...extra });

const isUrl = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

function cut(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A user as Discord shows them, with the id for the log. */
function who(user) {
  if (!user) return 'unknown';
  const tag = user.tag || user.username || user.id;
  return `${tag} (${user.id})`;
}

module.exports = { COLORS, embed, ok, fail, note, cut, who };
