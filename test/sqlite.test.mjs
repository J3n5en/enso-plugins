import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportCsv, listObjects, openDatabase, queryScript, queryTable, readCell, readSchema } from '../packages/enso.sqlite/lib/engine.mjs';
import { findDatabases, loadDatabaseBytes, normalizeRel } from '../packages/enso.sqlite/lib/files.mjs';
import { cellPlain, csvField } from '../packages/enso.sqlite/lib/format.mjs';
import { DatabaseSession } from '../packages/enso.sqlite/lib/session.mjs';
import {
  assertReadOnlyStatement,
  bindCompare,
  likePattern,
  parseFilter,
  quoteIdent,
  splitStatements,
  sqliteFromUtf8Text,
} from '../packages/enso.sqlite/lib/sql.mjs';

const require = createRequire(import.meta.url);
const initSqlJs = require('../packages/enso.sqlite/vendor/sql-wasm.cjs');
const wasmPath = fileURLToPath(new URL('../packages/enso.sqlite/vendor/sql-wasm.wasm', import.meta.url));
const SQL = await initSqlJs({ locateFile: () => wasmPath });

function fixtureBytes() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    title TEXT,
    ms INTEGER,
    lyrics TEXT,
    cover BLOB
  )`);
  db.run(`CREATE TABLE "odd""name" (id INTEGER, note TEXT)`);
  db.run(`INSERT INTO "odd""name" VALUES (1, 'keep')`);
  const insert = db.prepare('INSERT INTO tracks (title, ms, lyrics, cover) VALUES (?, ?, ?, ?)');
  insert.run(['Night Drive', 200, 'city night lights', new Uint8Array([0, 255, 16])]);
  insert.run(['Morning', 90, 'sun', null]);
  insert.run(['Quiet', null, null, null]);
  insert.free();
  db.run('CREATE VIEW night_titles AS SELECT title FROM tracks WHERE lyrics LIKE \'%night%\'');
  db.run('CREATE INDEX idx_title ON tracks(title)');
  db.run('CREATE TRIGGER tracks_touch AFTER UPDATE ON tracks BEGIN SELECT 1; END');
  const bytes = db.export();
  db.close();
  return bytes;
}

test('标识符、语句切分和筛选语法', () => {
  assert.equal(quoteIdent('a"b'), '"a""b"');
  assert.deepEqual(splitStatements(`SELECT ';'; -- tail\nSELECT "a;b"; SELECT 1`), [
    `SELECT ';'`,
    `-- tail\nSELECT "a;b"`,
    'SELECT 1',
  ]);
  assert.deepEqual(splitStatements('SELECT 1 /* ; */ ; SELECT 2'), ['SELECT 1 /* ; */', 'SELECT 2']);
  assert.deepEqual(parseFilter('  '), null);
  assert.deepEqual(parseFilter('null'), { op: 'isnull' });
  assert.deepEqual(parseFilter('>= 3'), { op: '>=', value: '3' });
  assert.deepEqual(parseFilter('night'), { op: 'contains', value: 'night' });
  assert.equal(likePattern('100%_\\'), '%100\\%\\_\\\\%');
  assert.equal(bindCompare('42'), 42);
  assert.equal(bindCompare('3.5'), 3.5);
  assert.equal(bindCompare('007'), '007');
  assert.throws(() => assertReadOnlyStatement('ATTACH DATABASE x AS y'), /附加/);
  assert.throws(() => assertReadOnlyStatement('PRAGMA query_only = OFF'), /只读/);
});

test('打开数据库后能列出结构、排序筛选并拒绝写入', () => {
  const db = openDatabase(SQL, fixtureBytes());
  const objects = listObjects(db);
  assert.deepEqual(
    objects.map((item) => item.name),
    ['odd"name', 'tracks', 'night_titles']
  );
  const schema = readSchema(db);
  const table = schema.groups.find((group) => group.id === 'table').items.find((item) => item.name === 'tracks');
  const view = schema.groups.find((group) => group.id === 'view').items[0];
  const index = schema.groups.find((group) => group.id === 'index').items.find((item) => item.name === 'idx_title');
  const trigger = schema.groups.find((group) => group.id === 'trigger').items[0];
  assert.match(table.sql, /CREATE TABLE tracks/);
  assert.match(view.sql, /CREATE VIEW night_titles/);
  assert.match(index.sql, /CREATE INDEX idx_title/);
  assert.match(trigger.sql, /CREATE TRIGGER tracks_touch/);

  const sorted = queryTable(db, 'tracks', { sort: { index: 2, dir: 'desc' }, page: 0, pageSize: 50 });
  assert.deepEqual(sorted.columns, ['id', 'title', 'ms', 'lyrics', 'cover']);
  assert.equal(sorted.total, 3);
  assert.equal(sorted.rows[0][1].v, 'Night Drive');
  assert.equal(sorted.rows[0][2].v, '200');
  assert.equal(sorted.rows.at(-1)[2].t, 'null');

  const filtered = queryTable(db, 'tracks', {
    filters: { 3: 'night' },
    search: 'drive',
    pageSize: 50,
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0][1].v, 'Night Drive');
  assert.equal(filtered.rows[0][4].t, 'blob');
  assert.equal(filtered.rows[0][4].v, '00ff10');

  const page = queryTable(db, 'tracks', { sort: { index: 0, dir: 'asc' }, page: 1, pageSize: 2 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0][0].v, '3');

  const quoted = queryTable(db, 'odd"name', { pageSize: 50 });
  assert.equal(quoted.rows[0][1].v, 'keep');

  const script = queryScript(db, 'SELECT 1 AS n; SELECT title FROM tracks WHERE ms > 100', { pageSize: 50 });
  assert.equal(script.statements, 2);
  assert.equal(script.rows.length, 1);
  assert.equal(script.rows[0][0].v, 'Night Drive');
  assert.match(script.message, /最后一条/);

  assert.throws(() => queryScript(db, "INSERT INTO tracks (title) VALUES ('x')"), /只读/);
  assert.throws(() => queryScript(db, 'PRAGMA query_only = OFF; INSERT INTO tracks (title) VALUES (1)'), /不能关闭只读/);

  const cell = readCell(db, { kind: 'table', table: 'tracks', row: 0, column: 1, sort: { index: 0, dir: 'asc' } });
  assert.equal(cell.cell.v, 'Night Drive');
  const big = new SQL.Database();
  big.run('CREATE TABLE t (n INTEGER)');
  big.run('INSERT INTO t VALUES (9007199254740993)');
  const reopened = openDatabase(SQL, big.export());
  big.close();
  const wide = queryTable(reopened, 't', { pageSize: 50 });
  assert.equal(wide.rows[0][0].v, '9007199254740993');
  reopened.close();

  const csv = exportCsv(db, { kind: 'table', table: 'tracks', filters: { 1: '=Night Drive' } });
  assert.match(csv.csv, /title/);
  assert.match(csv.csv, /Night Drive/);
  assert.equal(csv.rows, 1);
  assert.equal(csvField({ t: 'text', v: 'a"b' }), '"a""b"');
  assert.equal(cellPlain({ t: 'null' }), '');
  db.close();
});

test('损坏的字节和文本往返', () => {
  assert.throws(() => openDatabase(SQL, Buffer.from('hello')), /不是 SQLite/);
  const bytes = Buffer.from(fixtureBytes());
  const text = bytes.toString('utf8');
  assert.equal(sqliteFromUtf8Text(text), null);
  assert.equal(sqliteFromUtf8Text('SQLite format 3\0'), null);
});

test('只读取项目内的数据库文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-sqlite-'));
  const outside = await mkdtemp(join(tmpdir(), 'enso-sqlite-out-'));
  const bytes = Buffer.from(fixtureBytes());
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'app.db'), bytes);
  await writeFile(join(root, 'data', 'app.db-wal'), Buffer.from('wal'));
  await writeFile(join(outside, 'secret.db'), bytes);
  await symlink(join(outside, 'secret.db'), join(root, 'escape.db'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'skip.db'), bytes);
  await writeFile(join(root, 'notes.sqlite3'), bytes);

  assert.equal(normalizeRel('data/./app.db'), 'data/app.db');
  assert.throws(() => normalizeRel('../app.db'), /跳出/);
  assert.throws(() => normalizeRel('/tmp/app.db'), /相对路径/);
  assert.throws(() => normalizeRel('notes.txt'), /只打开/);

  const loaded = await loadDatabaseBytes({ fs: { async readText() { return 'nope'; } } }, root, 'data/app.db');
  assert.equal(loaded.rel, 'data/app.db');
  assert.equal(loaded.wal, true);
  assert.equal(loaded.bytes.length, bytes.length);
  await assert.rejects(loadDatabaseBytes(null, root, 'escape.db'), /跳出/);
  const found = await findDatabases(root);
  assert.deepEqual(found, ['data/app.db', 'notes.sqlite3']);

  const textDb = new SQL.Database();
  textDb.run("CREATE TABLE t (name TEXT)");
  textDb.run("INSERT INTO t VALUES ('plain')");
  const plain = Buffer.from(textDb.export());
  textDb.close();
  await writeFile(join(root, 'plain.sqlite'), plain);
  let sawText = false;
  const viaText = await loadDatabaseBytes(
    {
      fs: {
        async readText(rel) {
          sawText = rel === 'plain.sqlite';
          const file = plain.toString('utf8');
          if (file.includes('\uFFFD')) throw new Error('lossy');
          return file;
        },
      },
    },
    root,
    'plain.sqlite'
  );
  assert.equal(sawText, true);
  if (plain.toString('utf8').includes('\uFFFD')) assert.ok(viaText.bytes.equals(plain));
  else assert.ok(viaText.bytes.equals(plain));
});

test('工作线程可以打开、查询并取消', async () => {
  const session = new DatabaseSession();
  const opened = await session.open(fixtureBytes(), { rel: 'app.db' });
  assert.ok(opened.objects.some((item) => item.name === 'tracks'));
  const rows = await session.request('rows', { table: 'tracks', pageSize: 50, filters: { 2: '>100' } });
  assert.equal(rows.total, 1);
  const schema = await session.request('schema', {});
  assert.ok(schema.groups.some((group) => group.id === 'trigger' && group.items.length === 1));
  const pending = session.request('query', { sql: 'SELECT title FROM tracks', pageSize: 50 });
  session.cancel();
  await assert.rejects(pending, /已取消/);
  const again = await session.request('query', { sql: 'SELECT COUNT(*) AS n FROM tracks', pageSize: 50 });
  assert.equal(again.rows[0][0].v, '3');
  session.dispose();
});
