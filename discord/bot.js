'use strict';

/**
 * The bot, assembled: a client with the intents it needs, the store, the
 * commands, and what it does on its own - finds the server's channels and
 * roles when it connects, welcomes whoever joins, removes whoever posts in
 * the anti-bot channel, keeps the status embed current, and answers the
 * buttons and slash commands. index.js starts it; the tests build it
 * without logging in.
 */

const { Client, GatewayIntentBits, Partials, Events, MessageFlags } = require('discord.js');
const { Store } = require('./lib/store');
const commands = require('./commands');
const guildLib = require('./lib/guild');
const verify = require('./lib/verify');
const antibot = require('./lib/antibot');
const welcome = require('./lib/welcome');
const roles = require('./lib/roles');
const status = require('./lib/status');
const modlog = require('./lib/modlog');
const tickets = require('./lib/tickets');
const giveaways = require('./lib/giveaways');
const { fail } = require('./lib/embeds');
const { inviteUrl } = require('./lib/invite');

function createBot(config, { log = require('./lib/log'), store = new Store(config.dataFile) } = {}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration,
      // privileged: only asked for when switched on, or Discord refuses the login
      ...(config.log.messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    // so a message deleted before it was cached still raises an event with what is known
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
  });
  const ctx = {
    client,
    config,
    store,
    log,
    commands: commands.load(),
    // the channels and role, resolved against the live server on ready
    found: { channels: {}, roles: {} },
    guild: null,
  };

  /** Look the server over: which channel is which, whether the Member role exists. */
  async function settle(guild) {
    ctx.guild = guild;
    await guild.channels.fetch().catch(() => {});
    await guild.roles.fetch().catch(() => {});
    ctx.found = guildLib.resolveAll(guild, config);
    for (const [purpose, channel] of Object.entries(ctx.found.channels)) {
      log.info(`${purpose.padEnd(8)} → ${channel ? `#${channel.name} (${channel.id})` : 'not found'}`);
    }
    if (!ctx.found.roles.member) {
      const { role, created } = await guildLib.ensureRole(guild, config.roles.member, { reason: 'Etheroute bot: the role verified members receive' });
      ctx.found.roles.member = role;
      if (created) log.warn(`no "${config.roles.member}" role existed; made one. Give it the channels members should see, and put my role above it.`);
    }
    const made = await roles.ensureClaimable(ctx, guild);
    if (made.length) log.warn(`made the claimable role(s) ${made.map((n) => `@${n}`).join(', ')}; put my role above them`);
    const me = guild.members.me;
    for (const [purpose, role] of Object.entries(ctx.found.roles)) {
      if (!role) {
        log.warn(`${purpose.padEnd(8)} → no role found (looked for ${config.roles[purpose]})${purpose === 'support' ? '; tickets will be visible to their opener and admins only' : ''}`);
        continue;
      }
      log.info(`${purpose.padEnd(8)} → @${role.name} (${role.id})`);
      if (purpose !== 'support' && me && role.position >= me.roles.highest.position) {
        log.warn(`my highest role is not above @${role.name}; I will not be able to give it. Move my role up in Server Settings → Roles.`);
      }
    }
    if (me && me.permissions && !me.permissions.has('ViewAuditLog')) log.warn('I cannot read the audit log, so the mod-log will not say who deleted, kicked or banned; give me View Audit Log');
    return ctx.found;
  }

  async function sync(guild) {
    if (!config.syncCommands) return 0;
    const defs = ctx.commands.definitions();
    await guild.commands.set(defs);
    log.info(`${defs.length} slash commands registered on ${guild.name}`);
    return defs.length;
  }

  client.once(Events.ClientReady, async (c) => {
    log.info(`signed in as ${c.user.tag}`);
    const guild = c.guilds.cache.get(config.guildId) || await c.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) {
      log.error(`I am not in the server ${config.guildId}. Add me with: ${inviteUrl(config.clientId || c.user.id)}`);
      return;
    }
    try {
      await settle(guild);
      await sync(guild);
      await verify.ensurePanel(ctx, guild);
      await antibot.ensureNotice(ctx, guild);
      await roles.ensurePanel(ctx, guild);
      await tickets.ensurePanel(ctx, guild);
      giveaways.resume(ctx);
      await status.start(ctx);
      log.info(`ready on ${guild.name} (${guild.memberCount} members)`);
    } catch (err) {
      log.error('setup on ready failed:', err);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== config.guildId) return;
    await welcome.onMemberAdd(member, ctx);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.guild.id !== config.guildId) return;
    if (!antibot.shouldEnforce(message, ctx)) return;
    await antibot.enforce(message, ctx).catch((err) => log.error('anti-bot failed:', err));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        if (interaction.customId === verify.BUTTON_ID) return await verify.handleButton(interaction, ctx);
        if (interaction.customId === giveaways.BUTTON_ID) return await giveaways.enter(interaction, ctx);
        if (roles.isRoleButton(interaction.customId)) return await roles.handleButton(interaction, ctx);
        if (interaction.customId === tickets.OPEN_BUTTON) return await tickets.handleOpenButton(interaction, ctx);
        if (interaction.customId === tickets.CLOSE_BUTTON) return await tickets.handleCloseButton(interaction, ctx);
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === tickets.MODAL) return await tickets.handleModal(interaction, ctx);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const cmd = ctx.commands.byName.get(interaction.commandName);
      if (!cmd) return await interaction.reply({ embeds: [fail('I do not know that command any more.')], flags: MessageFlags.Ephemeral });
      if (!interaction.inGuild()) return await interaction.reply({ embeds: [fail('Commands work in the server, not in DMs.')] });
      if (cmd.requires && !(interaction.memberPermissions && interaction.memberPermissions.has(cmd.requires))) {
        return await interaction.reply({ embeds: [fail('You do not have the permission for that.')], flags: MessageFlags.Ephemeral });
      }
      await cmd.execute(interaction, ctx);
    } catch (err) {
      log.error(`/${interaction.commandName || interaction.customId} failed:`, err);
      const text = fail(`Something went wrong: ${err.message || err}`);
      if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [text] }).catch(() => {});
      else await interaction.reply({ embeds: [text], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  modlog.attach(client, ctx);

  client.on(Events.Error, (err) => log.error('client error:', err));
  client.on(Events.Warn, (msg) => log.warn(msg));

  return {
    client,
    ctx,
    settle,
    sync,
    start: () => client.login(config.token),
    stop: () => { status.stop(); return client.destroy(); },
  };
}

module.exports = { createBot };
