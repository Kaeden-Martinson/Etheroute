const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./env');

const DB_DIR = config.dataDir
  ? path.resolve(config.dataDir)
  : path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'database.json');
const BACKUP_FILE = path.join(DB_DIR, 'database.backup.json');
const TEMP_FILE = path.join(DB_DIR, 'database.tmp.json');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Every table the application expects. Missing tables are added on load so a
// database written by an older build keeps working.
const TABLES = [
  'users',
  'wallets',
  'invoices',
  'transactions',
  'payouts',
  'statusIncidents',
  'checkoutSessions',
  'apiCalls',
  'idempotencyKeys',
  'webhookDeliveries',
];

function emptyDatabase() {
  return TABLES.reduce((acc, table) => {
    acc[table] = [];
    return acc;
  }, {});
}

/**
 * Deep copy used on every read so callers cannot mutate stored state by
 * accident. structuredClone is native from Node 17 and handles nested plain
 * objects, arrays and dates correctly.
 */
function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function parseOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[database] Could not parse ${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

/**
 * Load the database, falling back to the last good backup when the primary file
 * is missing or corrupt. A truncated write used to prevent the process from
 * starting at all.
 */
function loadDatabase() {
  let data = parseOrNull(DB_FILE);
  let recoveredFromBackup = false;

  if (!data) {
    data = parseOrNull(BACKUP_FILE);
    if (data) {
      recoveredFromBackup = true;
      console.warn('[database] Primary database was unreadable - recovered from backup.');
    }
  }

  if (!data) {
    if (fs.existsSync(DB_FILE)) {
      // Never silently discard a file we could not parse.
      const quarantine = path.join(DB_DIR, `database.corrupt.${Date.now()}.json`);
      fs.renameSync(DB_FILE, quarantine);
      console.error(`[database] Unreadable database quarantined at ${quarantine}. Starting empty.`);
    }
    data = emptyDatabase();
  }

  // Backfill any table this build expects but the file does not have.
  for (const table of TABLES) {
    if (!Array.isArray(data[table])) {
      data[table] = [];
    }
  }

  if (recoveredFromBackup) {
    saveDatabase(data);
  }

  return data;
}

/**
 * Durable write: serialise to a temp file, flush it to disk, keep the previous
 * version as a backup, then rename into place. Rename is atomic, so a crash
 * mid-write leaves either the old file or the new one - never a truncated one.
 */
function saveDatabase(data) {
  const serialised = JSON.stringify(data, null, 2);

  const handle = fs.openSync(TEMP_FILE, 'w');
  try {
    fs.writeFileSync(handle, serialised, 'utf-8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  if (fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, BACKUP_FILE);
  }

  fs.renameSync(TEMP_FILE, DB_FILE);
}

let database = loadDatabase();

/**
 * Match a record against a criteria object. Kept identical to the previous
 * strict-equality behaviour so existing callers are unaffected.
 */
function matches(record, criteria) {
  for (const [key, value] of Object.entries(criteria)) {
    if (record[key] !== value) return false;
  }
  return true;
}

const db = {
  getAll(table) {
    return clone(database[table] || []);
  },

  getById(table, id) {
    const records = database[table] || [];
    const found = records.find((record) => record.id === id);
    return found ? clone(found) : null;
  },

  findBy(table, criteria) {
    const records = database[table] || [];
    return clone(records.filter((record) => matches(record, criteria)));
  },

  findOneBy(table, criteria) {
    const records = database[table] || [];
    const found = records.find((record) => matches(record, criteria));
    return found ? clone(found) : null;
  },

  create(table, data) {
    if (!database[table]) {
      database[table] = [];
    }
    // Guarantee an id even when the caller forgot one.
    const record = { id: data.id || crypto.randomUUID(), ...data };
    database[table].push(record);
    saveDatabase(database);
    return clone(record);
  },

  update(table, id, updates) {
    const records = database[table] || [];
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;

    // Never let an update rewrite the primary key.
    const { id: _ignored, ...safeUpdates } = updates || {};
    database[table][index] = { ...database[table][index], ...safeUpdates };
    saveDatabase(database);
    return clone(database[table][index]);
  },

  /**
   * Read-modify-write in a single step. Node runs this synchronously, so no other
   * request can interleave between the read and the write - which a caller doing
   * getById() then update() cannot guarantee.
   */
  transaction(table, id, mutator) {
    const records = database[table] || [];
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;

    const updates = mutator(clone(database[table][index]));
    if (!updates) return clone(database[table][index]);

    const { id: _ignored, ...safeUpdates } = updates;
    database[table][index] = { ...database[table][index], ...safeUpdates };
    saveDatabase(database);
    return clone(database[table][index]);
  },

  delete(table, id) {
    const records = database[table] || [];
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return false;

    database[table].splice(index, 1);
    saveDatabase(database);
    return true;
  },

  count(table) {
    return (database[table] || []).length;
  },

  clear() {
    // Build a fresh object each time; a shallow spread of a shared template
    // leaves every reset sharing the same arrays.
    database = emptyDatabase();
    saveDatabase(database);
  },
};

module.exports = { db, loadDatabase, saveDatabase, DB_FILE, DB_DIR, TABLES };
