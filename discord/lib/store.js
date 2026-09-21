'use strict';

/**
 * What the bot must remember across restarts, in one JSON file: which
 * message is the verification panel and which the anti-bot notice (so
 * they are not posted twice), the giveaways still running, and the
 * warnings given. Small and rarely written, so a file is enough; every
 * write goes to a sibling file first and is renamed over, so a crash
 * mid-write leaves the last good copy.
 */

const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ panels: {}, giveaways: {}, warnings: {} });

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...EMPTY(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Change one section and save: store.update('panels', (p) => { p.verify = ...; }). */
  update(section, fn) {
    if (!this.data[section]) this.data[section] = {};
    fn(this.data[section]);
    this.save();
    return this.data[section];
  }
}

module.exports = { Store };
