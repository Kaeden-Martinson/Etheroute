/**
 * The store: the JSON-document interface over SQLite, the one-time import
 * of database.json, the batched usage log, retention, snapshots and restore.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-for-validation-32';
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY || 'test-key-encryption-secret-32-chars-min';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'etheroute-test-')
);

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { db, DB_FILE, DB_DIR, TABLES } = require('../src/config/database');
const UsageLog = require('../src/services/UsageLog');
const MaintenanceService = require('../src/services/MaintenanceService');
const BackupService = require('../src/services/BackupService');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/\r\n/g, '\n');

/** A separate process on its own data directory, so a first start can be watched. */
function inFreshProcess(dataDir, script) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, DATA_DIR: dataDir },
  });
}

describe('The document interface', () => {
  beforeEach(() => db.clear());

  test('create gives an id, keeps insertion order, and returns a copy', () => {
    const a = db.create('wallets', { clientId: 'c1', address: 'A', isActive: true });
    const b = db.create('wallets', { id: 'given', clientId: 'c1', address: 'B', isActive: false });
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(b.id, 'given');
    a.address = 'mutated';
    assert.strictEqual(db.getById('wallets', a.id).address, 'A', 'the caller holds a copy');
    assert.deepStrictEqual(db.getAll('wallets').map((w) => w.address), ['A', 'B']);
    assert.strictEqual(db.count('wallets'), 2);
  });

  test('findBy is strict equality: true is not 1, a missing field matches undefined, null is null', () => {
    db.create('wallets', { clientId: 'c1', isActive: true, tag: null });
    db.create('wallets', { clientId: 'c1', isActive: 1 });
    db.create('wallets', { clientId: 'c1', isActive: 'true' });
    db.create('wallets', { clientId: 'c2', isActive: true, tag: 'x' });
    assert.strictEqual(db.findBy('wallets', { isActive: true }).length, 2);
    assert.strictEqual(db.findBy('wallets', { isActive: 1 }).length, 1);
    assert.strictEqual(db.findBy('wallets', { isActive: 'true' }).length, 1);
    assert.strictEqual(db.findBy('wallets', { clientId: 'c1', isActive: true }).length, 1);
    assert.strictEqual(db.findBy('wallets', { tag: null }).length, 1);
    assert.strictEqual(db.findBy('wallets', { tag: undefined }).length, 2, 'the records without the field');
    assert.strictEqual(db.findBy('wallets', {}).length, 4);
    assert.strictEqual(db.findOneBy('wallets', { clientId: 'c2' }).tag, 'x');
    assert.strictEqual(db.findOneBy('wallets', { clientId: 'nobody' }), null);
  });

  test('criteria on id use the key; an id that is not a string finds nothing', () => {
    const u = db.create('users', { username: 'ann' });
    assert.strictEqual(db.findOneBy('users', { id: u.id }).username, 'ann');
    assert.strictEqual(db.getById('users', 42), null);
    assert.strictEqual(db.getById('users', undefined), null);
  });

  test('update merges and never rewrites the id; transaction reads and writes in one step', () => {
    const w = db.create('wallets', { clientId: 'c1', balance: 1 });
    const updated = db.update('wallets', w.id, { id: 'other', balance: 2, note: 'n' });
    assert.strictEqual(updated.id, w.id);
    assert.deepStrictEqual(db.getById('wallets', w.id), { id: w.id, clientId: 'c1', balance: 2, note: 'n' });
    assert.strictEqual(db.update('wallets', 'missing', { balance: 3 }), null);

    const seen = [];
    const result = db.transaction('wallets', w.id, (rec) => { seen.push(rec.balance); return { balance: rec.balance + 10 }; });
    assert.strictEqual(result.balance, 12);
    assert.deepStrictEqual(seen, [2]);
    assert.strictEqual(db.transaction('wallets', w.id, () => null).balance, 12, 'a falsy result changes nothing');
    assert.strictEqual(db.transaction('wallets', 'missing', () => ({})), null);
  });

  test('delete, createMany, deleteOlderThan and clear', () => {
    const rows = db.createMany('apiCalls', [
      { clientId: 'c', timestamp: '2026-01-01T00:00:00.000Z' },
      { clientId: 'c', timestamp: '2026-06-01T00:00:00.000Z' },
      { clientId: 'c', timestamp: '2026-09-01T00:00:00.000Z' },
    ]);
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every((r) => r.id));
    assert.strictEqual(db.deleteOlderThan('apiCalls', 'timestamp', '2026-07-01T00:00:00.000Z'), 2);
    assert.deepStrictEqual(db.getAll('apiCalls').map((r) => r.timestamp), ['2026-09-01T00:00:00.000Z']);
    assert.strictEqual(db.delete('apiCalls', rows[2].id), true);
    assert.strictEqual(db.delete('apiCalls', rows[2].id), false);
    assert.deepStrictEqual(db.createMany('apiCalls', []), []);

    db.create('somethingNew', { id: 'x', v: 1 });
    assert.strictEqual(db.count('somethingNew'), 1, 'an unknown table is created on first touch');
    db.clear();
    for (const table of [...TABLES, 'somethingNew']) assert.strictEqual(db.count(table), 0, table);
  });

  test('range reads a window of one client ordered by time, and countBy counts without reading', () => {
    const at = (h) => new Date(Date.UTC(2026, 8, 20, h)).toISOString();
    db.createMany('apiCalls', [
      { clientId: 'a', timestamp: at(1) }, { clientId: 'b', timestamp: at(2) }, { clientId: 'a', timestamp: at(3) },
      { clientId: 'a', timestamp: at(5) }, { clientId: 'a', timestamp: at(4) },
    ]);
    assert.deepStrictEqual(db.range('apiCalls', { clientId: 'a' }, 'timestamp').map((r) => r.timestamp), [at(1), at(3), at(4), at(5)]);
    assert.deepStrictEqual(db.range('apiCalls', { clientId: 'a' }, 'timestamp', { from: at(3), to: at(5) }).map((r) => r.timestamp), [at(3), at(4)]);
    assert.deepStrictEqual(db.range('apiCalls', { clientId: 'a' }, 'timestamp', { newestFirst: true, limit: 2 }).map((r) => r.timestamp), [at(5), at(4)]);
    assert.strictEqual(db.countBy('apiCalls', { clientId: 'a' }), 4);
    assert.strictEqual(db.countBy('apiCalls', { clientId: 'a' }, 'timestamp', { from: at(4) }), 2);
    assert.strictEqual(db.countBy('apiCalls', { clientId: 'nobody' }), 0);
    // criteria the SQL cannot say take the slow path with the same answer
    assert.deepStrictEqual(db.range('apiCalls', { clientId: 'a', 'odd key': undefined }, 'timestamp', { from: at(4), newestFirst: true }).map((r) => r.timestamp), [at(5), at(4)]);
    assert.strictEqual(db.countBy('apiCalls', { 'odd key': undefined }, 'timestamp', { to: at(3) }), 2);
  });

  test('a table or field name that is not a name is refused, not interpolated', () => {
    assert.throws(() => db.getAll('users; DROP TABLE users'), /Not a table name/);
    assert.throws(() => db.deleteOlderThan('apiCalls', "timestamp') OR 1=1 --", 'x'), /Not a field name/);
    db.create('users', { 'weird key': 1 });
    assert.strictEqual(db.findBy('users', { 'weird key': 1 }).length, 1, 'filtered in JavaScript instead');
  });

  test('a record round-trips as JSON: dates become strings, undefined fields are dropped', () => {
    const rec = db.create('payouts', { when: new Date('2026-09-20T00:00:00Z'), gone: undefined, nested: { a: [1, { b: true }] } });
    const back = db.getById('payouts', rec.id);
    assert.strictEqual(back.when, '2026-09-20T00:00:00.000Z');
    assert.ok(!('gone' in back));
    assert.deepStrictEqual(back.nested, { a: [1, { b: true }] });
  });
});

describe('Snapshots, export and replace', () => {
  beforeEach(() => db.clear());

  test('exportAll and replaceAll are inverses, and replaceAll is all-or-nothing', () => {
    db.create('users', { id: 'u1', username: 'ann' });
    db.create('wallets', { id: 'w1', clientId: 'u1' });
    const dump = db.exportAll();
    assert.deepStrictEqual(dump.users, [{ id: 'u1', username: 'ann' }]);
    assert.strictEqual(db.replaceAll({ users: [{ id: 'u2', username: 'bob' }], junk: 'not an array', 'bad name!': [{ id: 'z' }] }), 1);
    assert.deepStrictEqual(db.getAll('users').map((u) => u.username), ['bob']);
    assert.strictEqual(db.count('wallets'), 0, 'tables absent from the import are emptied');
    assert.strictEqual(db.replaceAll(dump), 2);
    assert.deepStrictEqual(db.getAll('wallets'), [{ id: 'w1', clientId: 'u1' }]);
  });

  test('snapshotTo writes a consistent copy that opens on its own', () => {
    db.create('users', { id: 'u1', username: 'ann' });
    const dest = path.join(DB_DIR, `snap-${Date.now()}.sqlite`);
    db.snapshotTo(dest);
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(dest, { readOnly: true });
    assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    copy.close();
    assert.throws(() => db.snapshotTo(dest), /exist|output file/i, 'never over an existing file');
  });

  test('BackupService snapshots are SQLite files, listed with the JSON ones from before, and pruned oldest first', () => {
    fs.mkdirSync(BackupService.BACKUP_DIR, { recursive: true });
    for (const f of fs.readdirSync(BackupService.BACKUP_DIR)) fs.unlinkSync(path.join(BackupService.BACKUP_DIR, f));
    fs.writeFileSync(path.join(BackupService.BACKUP_DIR, 'database-2020-01-01T00-00-00-000Z.json'), '{"users":[]}');
    const dest = BackupService.snapshot();
    assert.ok(dest && dest.endsWith('.sqlite'));
    const listed = BackupService.listSnapshots();
    assert.strictEqual(listed.length, 2);
    assert.ok(listed[0].endsWith('.json') && listed[1].endsWith('.sqlite'), 'chronological');
  });
});

describe('The first start', () => {
  test('imports database.json once, leaves it in place, and does not read it again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-import-'));
    const legacy = {
      users: [{ id: 'u1', username: 'ann', apiKeyHash: 'h' }],
      wallets: [{ id: 'w1', clientId: 'u1', address: '0xabc', isActive: true }, { clientId: 'u1', address: 'noid', isActive: false }],
      apiCalls: [],
      chainHealth: [{ id: 'BTC', status: 'up' }],
    };
    fs.writeFileSync(path.join(dir, 'database.json'), JSON.stringify(legacy));

    const script = `
      const { db } = require('./src/config/database');
      console.log(JSON.stringify({ users: db.count('users'), wallets: db.count('wallets'), health: db.getById('chainHealth', 'BTC'), active: db.findBy('wallets', { clientId: 'u1', isActive: true }).map((w) => w.address), noid: db.getAll('wallets')[1].id.length }));
    `;
    const first = inFreshProcess(dir, script);
    assert.match(first, /Imported 4 records from database\.json/);
    const seen = JSON.parse(first.trim().split('\n').pop());
    assert.deepStrictEqual(seen, { users: 1, wallets: 2, health: { id: 'BTC', status: 'up' }, active: ['0xabc'], noid: 36 });
    assert.ok(fs.existsSync(path.join(dir, 'database.json')), 'left where it was');
    assert.ok(fs.existsSync(path.join(dir, 'database.sqlite')));

    // The JSON changes; the store does not follow it.
    fs.writeFileSync(path.join(dir, 'database.json'), JSON.stringify({ users: [] }));
    const second = inFreshProcess(dir, `const { db } = require('./src/config/database'); console.log(db.count('users'));`);
    assert.doesNotMatch(second, /Imported/);
    assert.strictEqual(second.trim(), '1');
  });

  test('with no JSON beside it, a fresh store starts empty and quiet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-empty-'));
    const out = inFreshProcess(dir, `const { db, TABLES } = require('./src/config/database'); console.log(TABLES.map((t) => db.count(t)).join(','));`);
    assert.doesNotMatch(out, /Imported/);
    assert.strictEqual(out.trim(), TABLES.map(() => 0).join(','));
  });
});

describe('The usage log', () => {
  beforeEach(() => { db.clear(); UsageLog.flush(); });

  test('rows wait in the buffer and go in one flush', () => {
    UsageLog.record({ clientId: 'c', endpoint: '/api/wallets', method: 'GET', statusCode: 200, timestamp: new Date().toISOString() });
    UsageLog.record({ clientId: 'c', endpoint: '/api/wallets', method: 'GET', statusCode: 200, timestamp: new Date().toISOString() });
    assert.strictEqual(UsageLog.pendingCount(), 2);
    assert.strictEqual(db.count('apiCalls'), 0, 'not on disk yet');
    assert.strictEqual(UsageLog.flush(), 2);
    assert.strictEqual(UsageLog.pendingCount(), 0);
    assert.strictEqual(db.count('apiCalls'), 2);
    assert.strictEqual(UsageLog.flush(), 0);
  });

  test('the routes that read the log flush it first, so the newest call is already there', () => {
    const route = read('src/routes/api-calls.js');
    assert.ok(route.includes("require('../services/UsageLog')"));
    assert.strictEqual((route.match(/UsageLog\.flush\(\)/g) || []).length, 2, 'stats and recent');
    const app = read('src/app.js');
    assert.ok(app.includes('UsageLog.record({'), 'trackApiCall buffers rather than writing');
    assert.ok(!app.includes("db.create('apiCalls'"));
    assert.ok(app.includes('UsageLog.flush();'), 'shutdown writes what is waiting');
  });

  test('the maintenance sweep keeps a month and removes the rest', () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.createMany('apiCalls', [{ clientId: 'c', timestamp: old }, { clientId: 'c', timestamp: old }, { clientId: 'c', timestamp: recent }]);
    assert.strictEqual(MaintenanceService.pruneUsageLog(), 2);
    assert.strictEqual(db.count('apiCalls'), 1);
    assert.strictEqual(MaintenanceService.pruneUsageLog(), 0);
  });
});

describe('The usage routes over HTTP', () => {
  const app = require('../src/app');
  let server;
  let base;
  const { before, after } = require('node:test');

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  async function call(method, route, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }

  test('a call is on the chart and in the recent list on the very next read, and the counts are the client\'s own', async () => {
    db.clear();
    const reg = await call('POST', '/api/auth/register', { body: { username: `usage_${Date.now()}`, password: 'a-very-long-test-password' } });
    const token = reg.body.token;
    const other = await call('POST', '/api/auth/register', { body: { username: `other_${Date.now()}`, password: 'a-very-long-test-password' } });
    await call('GET', '/api/wallets/list', { token });
    await call('GET', '/api/wallets/list', { token });
    await call('GET', '/api/wallets/nope', { token });
    await call('GET', '/api/wallets/list', { token: other.body.token });

    const stats = await call('GET', '/api/api-calls/stats?period=hour', { token });
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.totalCalls, 3);
    assert.strictEqual(stats.body.periodTotal, 3);
    assert.strictEqual(stats.body.labels.length, 60);

    const recent = await call('GET', '/api/api-calls/recent?limit=2', { token });
    assert.strictEqual(recent.body.totalCalls, 3);
    assert.strictEqual(recent.body.last24h, 3);
    assert.strictEqual(recent.body.errors24h, 1);
    assert.strictEqual(recent.body.calls.length, 2);
    assert.strictEqual(recent.body.calls[0].endpoint, '/api/wallets/nope', 'newest first');
    assert.strictEqual(recent.body.calls[0].statusCode, 404);
    // the reads of the log itself are not usage
    const again = await call('GET', '/api/api-calls/recent?limit=5', { token });
    assert.strictEqual(again.body.totalCalls, 3);
  });
});

describe('Restore', () => {
  test('a JSON snapshot from before the SQLite store is imported in place; a SQLite one replaces the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etheroute-restore-'));
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    inFreshProcess(dir, `const { db } = require('./src/config/database'); db.create('users', { id: 'live', username: 'live' }); db.close();`);

    fs.writeFileSync(path.join(backups, 'database-2026-01-01T00-00-00-000Z.json'), JSON.stringify({ users: [{ id: 'old', username: 'from-json' }] }));
    const out = execFileSync(process.execPath, ['scripts/restore.js', '--latest'], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, DATA_DIR: dir } });
    assert.match(out, /1 records imported/);
    assert.ok(fs.readdirSync(dir).some((f) => /^database\.pre-restore\..*\.sqlite$/.test(f)), 'the live state is kept first');
    const after = inFreshProcess(dir, `const { db } = require('./src/config/database'); console.log(db.getAll('users').map((u) => u.username).join(','));`);
    assert.strictEqual(after.trim(), 'from-json');

    // A SQLite snapshot: taken now (holding from-json), then the live store changes, then it is restored.
    inFreshProcess(dir, `const { db } = require('./src/config/database'); db.snapshotTo(require('path').join(${JSON.stringify(backups)}, 'database-2026-02-01T00-00-00-000Z.sqlite')); db.create('users', { id: 'n', username: 'newer' }); db.close();`);
    const out2 = execFileSync(process.execPath, ['scripts/restore.js', '--latest'], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, DATA_DIR: dir } });
    assert.match(out2, /Restored database-2026-02-01T00-00-00-000Z\.sqlite/);
    const after2 = inFreshProcess(dir, `const { db } = require('./src/config/database'); console.log(db.getAll('users').map((u) => u.username).join(','));`);
    assert.strictEqual(after2.trim(), 'from-json');
  });
});

describe('What the build declares', () => {
  test('the engine is one with node:sqlite, and the docs say where the data lives', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.engines.node, /22\.13/);
    assert.match(read('.github/workflows/ci.yml'), /node-version: 22/);
    assert.match(read('DEPLOYMENT.md'), /database\.sqlite/);
    assert.match(read('.env.example'), /USAGE_RETENTION_DAYS/);
    assert.ok(DB_FILE.endsWith('database.sqlite'));
  });
});
