#!/usr/bin/env node
/**
 * Who owns the platform: the accounts that may open the owner panel.
 *
 *   node scripts/owner.js list
 *   node scripts/owner.js grant <username>
 *   node scripts/owner.js revoke <username>
 *
 * The flag lives on the user record and is set only here, with access to
 * the server - never from a request. An owner signs in as usual; the
 * panel at /owner and the API under /api/owner open to their session (and
 * to no API key). Stop-and-start is not needed: the flag is read on each
 * request.
 */
'use strict';

const { validate } = require('../src/config/env');
validate();

const { db } = require('../src/config/database');

const say = (line = '') => process.stdout.write(`${line}\n`);
const [command, username] = process.argv.slice(2);

function list() {
  const owners = db.getAll('users').filter((u) => u.owner);
  if (!owners.length) {
    say('No owners. Grant one with: node scripts/owner.js grant <username>');
    return;
  }
  say('Owners:');
  for (const u of owners) say(`  ${u.username}  (${u.id}, since ${u.ownerSince || 'unknown'})`);
}

function find(name) {
  if (!name) {
    say('A username is needed.');
    process.exit(1);
  }
  const user = db.findOneBy('users', { username: name });
  if (!user) {
    say(`No account named ${name}.`);
    process.exit(1);
  }
  return user;
}

function main() {
  if (command === 'list' || !command) return list();
  if (command === 'grant') {
    const user = find(username);
    if (user.owner) return say(`${user.username} is already an owner.`);
    db.update('users', user.id, { owner: true, ownerSince: new Date().toISOString() });
    say(`${user.username} is now an owner. The panel is at /owner once they sign in.`);
    return undefined;
  }
  if (command === 'revoke') {
    const user = find(username);
    if (!user.owner) return say(`${user.username} is not an owner.`);
    db.update('users', user.id, { owner: false, ownerSince: null });
    say(`${user.username} is no longer an owner.`);
    return undefined;
  }
  say('Usage: node scripts/owner.js list | grant <username> | revoke <username>');
  process.exit(1);
  return undefined;
}

main();
db.close();
