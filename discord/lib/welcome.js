'use strict';

/**
 * A word in #welcome when someone joins: their name and avatar, which
 * member they are, and where to go next - #verify, since nothing else
 * opens until they press the button there.
 */

const { embed, COLORS } = require('./embeds');

function welcomeEmbed(member, ctx) {
  const guild = member.guild;
  const verify = ctx.found.channels.verify;
  const rules = ctx.found.channels.rules;
  const rolesChannel = ctx.found.channels.roles;
  const steps = [
    verify ? `Head to ${verify.toString()} and press **Verify** to unlock the server.` : null,
    rolesChannel ? `Then pick your roles in ${rolesChannel.toString()} - merchant or buyer, and whether you want updates and status pings.` : null,
    rules ? `Have a look at ${rules.toString()} while you are at it.` : null,
  ].filter(Boolean).join('\n');
  const user = member.user;
  return embed({
    title: `Welcome, ${member.displayName || user.username}!`,
    description: `${member.toString()} just joined **${guild.name}**.${steps ? `\n\n${steps}` : ''}`,
    color: COLORS.ok,
    thumbnail: user.displayAvatarURL({ size: 256 }),
    fields: [
      { name: 'Member', value: `#${guild.memberCount}` },
      { name: 'Account made', value: user.createdAt ? `<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>` : 'unknown' },
    ],
    footer: `${ctx.config.brand.name} · ${ctx.config.brand.site.replace(/^https?:\/\//, '')}`,
  });
}

async function onMemberAdd(member, ctx) {
  const channel = ctx.found.channels.welcome;
  if (!channel) return false;
  try {
    await channel.send({ content: member.toString(), embeds: [welcomeEmbed(member, ctx)], allowedMentions: { users: [member.id] } });
    ctx.log.info(`welcomed ${member.user.tag} (${member.id}) - member #${member.guild.memberCount}`);
    return true;
  } catch (err) {
    ctx.log.warn('welcome post failed:', err.message);
    return false;
  }
}

module.exports = { welcomeEmbed, onMemberAdd };
