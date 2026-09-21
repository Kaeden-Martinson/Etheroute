'use strict';

/**
 * The document store: every table is a set of JSON records, one per row,
 * kept in a single SQLite file.
 *
 * Callers see the same interface the JSON file gave them - getAll, findBy,
 * create, update, transaction, delete - but a write is now one row through
 * the write-ahead log instead of the whole database serialised to disk, and
 * a lookup by clientId, address, hash or status reads an index over the
 * JSON field rather than every row. The first start with a database.json
 * beside the new file imports it once.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./env');

const DB_DIR = config.dataDir
  ? path.resolve(config.dataDir)
  : path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'database.sqlite');
// The store this replaced; read once, on the first start, never written.
const LEGACY_JSON_FILE = path.join(DB_DIR, 'database.json');
const LEGACY_BACKUP_FILE = path.join(DB_DIR, 'database.backup.json');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Every table the application expects. Any other name a caller uses is
// created on first touch, as it was with the JSON file.
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
  'chainHealth',
  'chainHealthEvents',
];

// The fields each table is looked up by. Each gets an index over its JSON
// path, and a findBy on it reads the index, not the table. A pair is one
// index over both, for a window of one client's rows ordered by time.
const INDEXED_FIELDS = {
  users: ['username', 'apiKeyHash'],
  wallets: ['clientId', 'address'],
  transactions: ['clientId', 'fromAddress', 'transactionHash', 'status', 'sessionId'],
  payouts: ['clientId', 'status'],
  checkoutSessions: ['clientId', 'status'],
  apiCalls: [['clientId', 'timestamp'], 'timestamp'],
  idempotencyKeys: ['createdAt'],
  webhookDeliveries: ['status'],
  chainHealthEvents: ['at'],
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoted(table) {
  if (!NAME.test(table)) throw new Error(`Not a table name: ${table}`);
  return `"${table}"`;
}

function open() {
  const fresh = !fs.existsSync(DB_FILE);
  const conn = new DatabaseSync(DB_FILE);
  // Readers never wait on the writer, and a commit is one append to the log.
  // synchronous=FULL flushes that append: a power cut costs nothing acknowledged.
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA synchronous = FULL');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  return { conn, fresh };
}

const { conn, fresh } = open();
const known = new Set();

/** The table's row set and its indexes, made once per process. */
function ensureTable(table) {
  if (known.has(table)) return;
  const name = quoted(table);
  conn.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  for (const spec of INDEXED_FIELDS[table] || []) {
    const fields = Array.isArray(spec) ? spec : [spec];
    conn.exec(`CREATE INDEX IF NOT EXISTS "idx_${table}_${fields.join('_')}" ON ${name} (${fields.map((f) => `json_extract(data, '$.${f}')`).join(', ')})`);
  }
  known.add(table);
}

for (const table of TABLES) ensureTable(table);

function parse(row) {
  return JSON.parse(row.data);
}

/**
 * A criteria object as a WHERE clause over the JSON, with the same strict
 * equality the in-memory filter had: a string matches a string, true matches
 * true and not 1, an undefined value matches a record without the field.
 * Anything the SQL cannot say exactly returns null and the caller filters
 * in JavaScript instead.
 */
function whereFor(criteria) {
  const clauses = [];
  const params = [];
  for (const [key, value] of Object.entries(criteria || {})) {
    if (!NAME.test(key)) return null;
    if (key === 'id') {
      if (typeof value !== 'string') return null;
      clauses.push('id = ?');
      params.push(value);
      continue;
    }
    const field = `json_extract(data, '$.${key}')`;
    const type = `json_type(data, '$.${key}')`;
    if (value === undefined) {
      clauses.push(`${type} IS NULL`);
    } else if (value === null) {
      clauses.push(`${type} = 'null'`);
    } else if (typeof value === 'boolean') {
      clauses.push(`${type} = '${value ? 'true' : 'false'}'`);
    } else if (typeof value === 'string') {
      clauses.push(`${field} = ? AND ${type} = 'text'`);
      params.push(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clauses.push(`${field} = ? AND ${type} IN ('integer', 'real')`);
      params.push(value);
    } else {
      return null;
    }
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', params };
}

/** The in-memory filter, for criteria the SQL cannot express. */
function matches(record, criteria) {
  for (const [key, value] of Object.entries(criteria)) {
    if (record[key] !== value) return false;
  }
  return true;
}

function select(table, criteria, limit) {
  ensureTable(table);
  const where = whereFor(criteria);
  if (!where) {
    const all = conn.prepare(`SELECT data FROM ${quoted(table)} ORDER BY rowid`).all().map(parse).filter((r) => matches(r, criteria));
    return limit ? all.slice(0, limit) : all;
  }
  const sql = `SELECT data FROM ${quoted(table)} WHERE ${where.sql} ORDER BY rowid${limit ? ` LIMIT ${limit}` : ''}`;
  return conn.prepare(sql).all(...where.params).map(parse);
}

/**
 * The WHERE for a window: `criteria`, and `field` within [from, to) when
 * either bound is given. Bounds compare as strings, which is what ISO
 * timestamps want. Null when the criteria cannot be said in SQL.
 */
function windowFor(criteria, field, { from, to } = {}) {
  const where = whereFor(criteria);
  if (!where || !NAME.test(field)) return null;
  const clauses = [where.sql];
  const params = [...where.params];
  const column = `json_extract(data, '$.${field}')`;
  if (from !== undefined && from !== null) { clauses.push(`${column} >= ?`); params.push(String(from)); }
  if (to !== undefined && to !== null) { clauses.push(`${column} < ?`); params.push(String(to)); }
  return { sql: clauses.join(' AND '), params, column };
}

function readRow(table, id) {
  ensureTable(table);
  const row = conn.prepare(`SELECT data FROM ${quoted(table)} WHERE id = ?`).get(id);
  return row ? parse(row) : null;
}

function writeRow(table, record) {
  conn.prepare(`UPDATE ${quoted(table)} SET data = ? WHERE id = ?`).run(JSON.stringify(record), record.id);
}

/** Run `fn` inside one transaction; nested calls join the outer one. */
let depth = 0;
function transactional(fn) {
  if (depth > 0) return fn();
  depth += 1;
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  } finally {
    depth -= 1;
  }
}

/** A record as the caller may keep it: its own copy, as it will read back. */
function copy(record) {
  return JSON.parse(JSON.stringify(record));
}

const db = {
  getAll(table) {
    ensureTable(table);
    return conn.prepare(`SELECT data FROM ${quoted(table)} ORDER BY rowid`).all().map(parse);
  },

  getById(table, id) {
    if (typeof id !== 'string') return null;
    return readRow(table, id);
  },

  findBy(table, criteria) {
    return select(table, criteria);
  },

  findOneBy(table, criteria) {
    return select(table, criteria, 1)[0] || null;
  },

  /**
   * The records matching `criteria` whose `field` lies within [from, to),
   * ordered by that field (newest first if asked), at most `limit`. For the
   * log-shaped tables, where a reader wants a window and not the history.
   */
  range(table, criteria, field, { from, to, newestFirst = false, limit } = {}) {
    ensureTable(table);
    const window = windowFor(criteria, field, { from, to });
    if (!window) {
      const inWindow = (r) => (from == null || String(r[field]) >= String(from)) && (to == null || String(r[field]) < String(to));
      const rows = select(table, criteria).filter(inWindow)
        .sort((a, b) => (String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : 0));
      if (newestFirst) rows.reverse();
      return limit ? rows.slice(0, limit) : rows;
    }
    const order = newestFirst ? 'DESC' : 'ASC';
    const sql = `SELECT data FROM ${quoted(table)} WHERE ${window.sql} ORDER BY ${window.column} ${order}, rowid ${order}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
    return conn.prepare(sql).all(...window.params).map(parse);
  },

  /** How many records match `criteria` - within [from, to) of `field`, when one is given. */
  countBy(table, criteria, field, { from, to } = {}) {
    ensureTable(table);
    if (field === undefined) {
      const where = whereFor(criteria);
      if (!where) return select(table, criteria).length;
      return conn.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${where.sql}`).get(...where.params).n;
    }
    const window = windowFor(criteria, field, { from, to });
    if (!window) return db.range(table, criteria, field, { from, to }).length;
    return conn.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${window.sql}`).get(...window.params).n;
  },

  create(table, data) {
    ensureTable(table);
    // Guarantee an id even when the caller forgot one.
    const record = { id: data.id || crypto.randomUUID(), ...data };
    conn.prepare(`INSERT INTO ${quoted(table)} (id, data) VALUES (?, ?)`).run(String(record.id), JSON.stringify(record));
    return copy(record);
  },

  /** Many records in one commit: a flush of buffered rows costs one fsync, not one each. */
  createMany(table, rows) {
    if (!rows || rows.length === 0) return [];
    ensureTable(table);
    const insert = conn.prepare(`INSERT INTO ${quoted(table)} (id, data) VALUES (?, ?)`);
    return transactional(() => rows.map((data) => {
      const record = { id: data.id || crypto.randomUUID(), ...data };
      insert.run(String(record.id), JSON.stringify(record));
      return copy(record);
    }));
  },

  update(table, id, updates) {
    return transactional(() => {
      const current = readRow(table, id);
      if (!current) return null;
      // Never let an update rewrite the primary key.
      const { id: _ignored, ...safeUpdates } = updates || {};
      const next = { ...current, ...safeUpdates };
      writeRow(table, next);
      return copy(next);
    });
  },

  /**
   * Read-modify-write in a single step. Node runs this synchronously, so no other
   * request can interleave between the read and the write - which a caller doing
   * getById() then update() cannot guarantee.
   */
  transaction(table, id, mutator) {
    return transactional(() => {
      const current = readRow(table, id);
      if (!current) return null;
      const updates = mutator(copy(current));
      if (!updates) return current;
      const { id: _ignored, ...safeUpdates } = updates;
      const next = { ...current, ...safeUpdates };
      writeRow(table, next);
      return copy(next);
    });
  },

  delete(table, id) {
    ensureTable(table);
    const { changes } = conn.prepare(`DELETE FROM ${quoted(table)} WHERE id = ?`).run(String(id));
    return changes > 0;
  },

  /**
   * Remove every record whose `field` sorts before `cutoff` (ISO timestamps
   * sort as strings): the retention sweep in one statement. Returns the count.
   */
  deleteOlderThan(table, field, cutoff) {
    ensureTable(table);
    if (!NAME.test(field)) throw new Error(`Not a field name: ${field}`);
    const { changes } = conn.prepare(`DELETE FROM ${quoted(table)} WHERE json_extract(data, '$.${field}') < ?`).run(String(cutoff));
    return changes;
  },

  count(table) {
    ensureTable(table);
    return conn.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get().n;
  },

  /** Every table emptied, in one commit. */
  clear() {
    transactional(() => {
      for (const table of allTables()) conn.exec(`DELETE FROM ${quoted(table)}`);
    });
  },

  /**
   * Replace the whole store with `{ table: [records] }` - a JSON export, a
   * legacy database.json, a snapshot from before this format - in one commit,
   * so a failure part-way leaves what was there.
   */
  replaceAll(data) {
    let imported = 0;
    transactional(() => {
      for (const table of allTables()) conn.exec(`DELETE FROM ${quoted(table)}`);
      for (const [table, rows] of Object.entries(data || {})) {
        if (!Array.isArray(rows) || !NAME.test(table)) continue;
        ensureTable(table);
        const insert = conn.prepare(`INSERT OR REPLACE INTO ${quoted(table)} (id, data) VALUES (?, ?)`);
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object') continue;
          const record = { id: raw.id || crypto.randomUUID(), ...raw };
          insert.run(String(record.id), JSON.stringify(record));
          imported += 1;
        }
      }
    });
    return imported;
  },

  /** The whole store as `{ table: [records] }`. */
  exportAll() {
    const out = {};
    for (const table of allTables()) out[table] = db.getAll(table);
    return out;
  },

  /**
   * A consistent copy of the database at `dest`, compacted, taken while the
   * server keeps running. The file must not exist yet.
   */
  snapshotTo(dest) {
    conn.exec('PRAGMA wal_checkpoint(PASSIVE)');
    conn.prepare('VACUUM INTO ?').run(dest);
    return dest;
  },

  /** Release the file. Only for scripts that replace it afterwards. */
  close() {
    try { conn.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* read-only or already closed */ }
    conn.close();
  },
};

function allTables() {
  return conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'`).all().map((r) => r.name);
}

function parseJsonOrNull(filePath) {
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
 * The one-time move from the JSON file: on the first start with no SQLite
 * database, whatever database.json (or its rolling backup) holds is
 * imported. The JSON file is left where it was and is not read again.
 */
function importLegacyJson() {
  if (!fresh) return;
  const data = parseJsonOrNull(LEGACY_JSON_FILE) || parseJsonOrNull(LEGACY_BACKUP_FILE);
  if (!data || typeof data !== 'object') return;
  const imported = db.replaceAll(data);
  conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('importedJsonAt', new Date().toISOString());
  console.info(`[database] Imported ${imported} records from ${path.basename(LEGACY_JSON_FILE)} into ${path.basename(DB_FILE)}. The JSON file is no longer read; keep it until you have a snapshot you trust, then delete it.`);
}

importLegacyJson();

module.exports = { db, DB_FILE, DB_DIR, TABLES, LEGACY_JSON_FILE };
