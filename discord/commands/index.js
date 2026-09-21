'use strict';

/**
 * Every command in this folder, loaded by file name. A command module is
 * { data, requires, execute }: the builder Discord is told about, the
 * permission checked when it runs, and the handler. Two files naming the
 * same command is a mistake caught here, not by Discord at sync time.
 */

const fs = require('fs');
const path = require('path');

function load(dir = __dirname) {
  const list = [];
  const byName = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
    const mod = require(path.join(dir, file));
    if (!mod || !mod.data || typeof mod.execute !== 'function') throw new Error(`discord/commands/${file} does not export { data, execute }`);
    const name = mod.data.name;
    if (byName.has(name)) throw new Error(`two commands are called /${name} (${byName.get(name).file} and ${file})`);
    const entry = { ...mod, file, name };
    list.push(entry);
    byName.set(name, entry);
  }
  return { list, byName, definitions: () => list.map((c) => c.data.toJSON()) };
}

module.exports = { load };
