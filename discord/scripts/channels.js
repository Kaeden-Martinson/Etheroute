#!/usr/bin/env node
/**
 * A look at the server before the bot runs on it: every channel and role,
 * and which of them the bot would take for #welcome, #verify, #anti-bot,
 * the mod-log and the Member role with the current .env. Read-only; it
 * signs in, reads, prints and signs out.
 *
 *   npm run discord:channels
 */
'use strict';

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const config = require('../config');
const guildLib = require('../lib/guild');
const { inviteUrl } = require('../lib/invite');

const say = (line = '') => process.stdout.write(`${line}\n`);
const settings = config.read();
const wrong = config.problems(settings);
if (wrong.length) {
  wrong.forEach((w) => say(`✗ ${w}`));
  process.exit(1);
}

const TYPE = { [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage' };

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (c) => {
  try {
    const guild = await c.guilds.fetch(settings.guildId);
    await guild.channels.fetch();
    await guild.roles.fetch();
    say(`${guild.name} (${guild.id}) · ${guild.memberCount} members · signed in as ${c.user.tag}`);
    say();

    say('Channels');
    const byParent = new Map();
    for (const ch of guild.channels.cache.values()) {
      const key = ch.type === ChannelType.GuildCategory ? ch.id : (ch.parentId || '');
      if (!byParent.has(key)) byParent.set(key, []);
      if (ch.type !== ChannelType.GuildCategory) byParent.get(key).push(ch);
    }
    const categories = Array.from(guild.channels.cache.values()).filter((ch) => ch.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
    const printList = (list) => list.sort((a, b) => a.position - b.position).forEach((ch) => say(`    ${(TYPE[ch.type] || ch.type).padEnd(12)} ${ch.id}  ${ch.name}`));
    if (byParent.get('')) { say('  (no category)'); printList(byParent.get('')); }
    for (const cat of categories) { say(`  ${cat.name}`); printList(byParent.get(cat.id) || []); }
    say();

    say('Roles (highest first)');
    Array.from(guild.roles.cache.values()).filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position)
      .forEach((r) => say(`    ${String(r.position).padStart(3)}  ${r.id}  ${r.name}${r.managed ? '  (integration)' : ''}`));
    say();

    say('What the bot would use');
    const found = guildLib.resolveAll(guild, settings);
    for (const [purpose, ch] of Object.entries(found.channels)) {
      say(`    ${purpose.padEnd(8)} ${ch ? `#${ch.name} (${ch.id})` : `not found - set DISCORD_${purpose.toUpperCase()}_CHANNEL`}   [${settings.channels[purpose]}]`);
    }
    say(`    member   ${found.roles.member ? `@${found.roles.member.name} (${found.roles.member.id})` : `not found - the bot will create "${settings.roles.member}"`}`);
    const me = guild.members.me;
    if (me) {
      say();
      say(`My highest role: @${me.roles.highest.name} (position ${me.roles.highest.position})`);
      if (found.roles.member && found.roles.member.position >= me.roles.highest.position) say('  ✗ it must sit above the Member role for verification to work');
    }
    say();
    say(`Invite link: ${inviteUrl(settings.clientId || c.user.id)}`);
  } catch (err) {
    say(`✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(settings.token).catch((err) => {
  say(`✗ could not sign in: ${err.message}`);
  process.exit(1);
});
