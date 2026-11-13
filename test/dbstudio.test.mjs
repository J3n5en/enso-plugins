import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../packages/enso.dbstudio/lib/app.mjs';
import { packChunk } from '../packages/enso.dbstudio/lib/chunk.mjs';
import { connectionFromEnv, parseEnv } from '../packages/enso.dbstudio/lib/envfile.mjs';
import { packValue, truncateUtf8 } from '../packages/enso.dbstudio/lib/format.mjs';
import { selectStar } from '../packages/enso.dbstudio/lib/ident.mjs';
import { PREVIEW_CHARS } from '../packages/enso.dbstudio/lib/limits.mjs';
import { applyLimit, destructiveReason, splitStatements, statementAt, statementInfo, sqliteBlockedReason, statementsToRun } from '../packages/enso.dbstudio/lib/scan.mjs';
import { createPostgres, isCancel } from '../packages/enso.dbstudio/lib/servers.mjs';
import { resolveSettings } from '../packages/enso.dbstudio/lib/settings.mjs';
import { publicConnection } from '../packages/enso.dbstudio/lib/store.mjs';
import { SqliteSession } from '../packages/enso.dbstudio/lib/sqlite-session.mjs';
import { pullIterator, resolveSqliteFile, wrapSqlJs } from '../packages/enso.dbstudio/lib/sqlite.mjs';
import { killQuerySql, mysqlOptions, mysqlSsl, parseSslMode, postgresOptions, postgresSsl, sslNote } from '../packages/enso.dbstudio/lib/target.mjs';
import { parseConnectionInput, parseServerUrl } from '../packages/enso.dbstudio/lib/url.mjs';
import { configFileFromDataDir, redact, vaultFileFromDataDir } from '../packages/enso.dbstudio/lib/vault.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../packages/enso.dbstudio/enso-plugin.json', import.meta.url), 'utf8'));

async function harness(options = {}) {
  const root = options.root || (await mkdtemp(join(tmpdir(), 'dbstudio-')));
  const dataDir = options.dataDir || join(root, 'data', 'enso.dbstudio');
  await mkdir(dataDir, { recursive: true });
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const texts = new Map();
  const config = { envVar: 'DATABASE_URL', rowLimit: 100, queryTimeout: 30, ...(options.config || {}) };
  const events = [];
  const enso = {
    pluginId: 'enso.dbstudio',
    dataDir,
    config: { get: async () => ({ ...config }) },
    fs: {
      readText: async (path) => {
        if (!texts.has(path)) {
          const error = new Error('missing');
          error.code = 'NOT_FOUND';
          throw error;
        }
        return texts.get(path);
      },
    },
    ui: { view: { emit: (name, data) => events.push({ name, data }) } },
    renderer: { handle() {} },
  };
  const app = createApp(enso, options.deps || {});
  await app.ready;
  return { root, project, dataDir, texts, config, enso, app, events };
}

test('清单只申请侧栏和项目读取，版本是 0.1.2，密码走 vault.json', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'enso.dbstudio');
  assert.equal(manifest.version, '0.1.2');
  assert.deepEqual(manifest.permissions, ['ui.view', 'fs.read']);
  assert.deepEqual(manifest.fs.read, ['.']);
  assert.equal(manifest.fs.write, undefined);
  assert.equal(manifest.net, undefined);
  assert.equal(manifest.contributes.fileViewers[0].extensions.join(), '.sql');
  assert.equal(manifest.contributes.fileViewers[0].default, undefined);
  const secrets = manifest.contributes.configuration.filter((item) => item.secret).map((item) => item.key);
  assert.deepEqual(secrets, ['passwords', 'passwords2', 'passwords3', 'passwords4']);
  for (const key of secrets) {
    const item = manifest.contributes.configuration.find((entry) => entry.key === key);
    assert.match(item.description, /旧版迁移用/);
  }
  const outside = manifest.contributes.configuration.find((item) => item.key === 'allowOutsideSqlite');
  assert.equal(outside.type, 'boolean');
  assert.equal(outside.default, false);
  const writable = manifest.contributes.configuration.find((item) => item.key === 'allowSqliteWrite');
  assert.equal(writable.type, 'boolean');
  assert.equal(writable.default, false);
  const rowLimit = manifest.contributes.configuration.find((item) => item.key === 'rowLimit');
  assert.equal(rowLimit.type, 'number');
  assert.equal(rowLimit.default, 100);
  assert.deepEqual(resolveSettings({ rowLimit: 5000, queryTimeout: 0, envVar: '1bad' }), {
    rowLimit: 1000,
    queryTimeout: 1,
    envVar: 'DATABASE_URL',
    allowOutsideSqlite: false,
    allowSqliteWrite: false,
  });
  assert.deepEqual(resolveSettings({ rowLimit: 'nope', queryTimeout: 9.5, envVar: 'DB_URL' }), {
    rowLimit: 100,
    queryTimeout: 30,
    envVar: 'DB_URL',
    allowOutsideSqlite: false,
    allowSqliteWrite: false,
  });
});

test('解析 postgres / mysql URL，忽略查询参数里的主机，sqlite 只接受本机路径', () => {
  const pg = parseServerUrl('postgres://shop%40app:p%40ss@[::1]:5433/sales?sslmode=require&host=evil.example');
  assert.equal(pg.engine, 'postgres');
  assert.equal(pg.host, '::1');
  assert.equal(pg.port, 5433);
  assert.equal(pg.user, 'shop@app');
  assert.equal(pg.password, 'p@ss');
  assert.equal(pg.database, 'sales');
  assert.equal(pg.sslmode, 'require');
  const mysql = parseConnectionInput('mysql://root:secret@127.0.0.1/app');
  assert.equal(mysql.engine, 'mysql');
  assert.equal(mysql.port, 3306);
  assert.equal(parseConnectionInput('mariadb://u@db.internal:3307/app').engine, 'mariadb');
  assert.equal(parseConnectionInput('postgresql://u@localhost/postgres').engine, 'postgres');
  assert.equal(parseConnectionInput('sqlite:///tmp/shop.db').path, '/tmp/shop.db');
  assert.equal(parseConnectionInput('file:///tmp/shop.sqlite').path, '/tmp/shop.sqlite');
  assert.throws(() => parseServerUrl('http://example.com'), /postgres/);
  assert.throws(() => parseServerUrl('postgres://user:pass@one,two/db'), /主机/);
  assert.throws(() => parseConnectionInput('sqlite://db.example/tmp/a.db'), /本机/);
  const options = postgresOptions(pg, pg.password);
  assert.deepEqual(options.host, ['::1']);
  assert.deepEqual(options.port, [5433]);
  assert.equal(options.path, undefined);
  assert.equal(options.database, 'sales');
  assert.equal(mysqlOptions(mysql, 'secret').host, '127.0.0.1');
  assert.equal(mysqlOptions(mysql, 'secret').uri, undefined);
  assert.equal(killQuerySql('42'), 'KILL QUERY 42');
  assert.throws(() => killQuerySql('1; DROP'), /不合法/);
  assert.equal(parseSslMode(''), 'disable');
  assert.equal(parseSslMode('allow'), 'disable');
  assert.equal(parseSslMode('prefer'), 'prefer');
  assert.equal(parseSslMode('require'), 'require');
  assert.equal(parseSslMode('verify-ca'), 'verify-ca');
  assert.equal(parseSslMode('verify-full'), 'verify-full');
  assert.throws(() => parseSslMode('nope'), /sslmode/);
  assert.equal(parseServerUrl('postgres://u@h/db?sslmode=prefer').sslmode, 'prefer');
  assert.equal(parseServerUrl('postgres://u@h/db?sslmode=verify-ca').sslmode, 'verify-ca');
  assert.equal(parseServerUrl('postgres://u@h/db?sslmode=disable').sslmode, 'disable');
  assert.equal(postgresSsl('prefer'), 'prefer');
  assert.equal(postgresSsl('require'), 'require');
  assert.equal(postgresSsl('verify-full'), 'verify-full');
  assert.equal(postgresSsl('verify-ca').rejectUnauthorized, true);
  assert.equal(typeof postgresSsl('verify-ca').checkServerIdentity, 'function');
  assert.deepEqual(mysqlSsl('require'), { rejectUnauthorized: false });
  assert.deepEqual(mysqlSsl('prefer'), { rejectUnauthorized: false });
  assert.deepEqual(mysqlSsl('verify-ca'), { rejectUnauthorized: true, verifyIdentity: false });
  assert.deepEqual(mysqlSsl('verify-full'), { rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(mysqlSsl('disable'), undefined);
  assert.equal(sslNote('require'), '加密但不校验证书');
  assert.equal(mysqlOptions({ host: '127.0.0.1', port: 3306, sslmode: 'require' }, '').ssl.rejectUnauthorized, false);
  assert.equal(mysqlOptions({ host: '127.0.0.1', port: 3306, sslmode: 'verify-ca' }, '').ssl.rejectUnauthorized, true);
});

test('语句切分、光标和 LIMIT 上限', () => {
  const parts = splitStatements(`SELECT ';'; -- tail\nSELECT "a;b"; SELECT $$ ; $$; SELECT 1`).map((part) => part.text);
  assert.equal(parts[0], `SELECT ';'`);
  assert.match(parts[1], /SELECT "a;b"/);
  assert.equal(parts[2], 'SELECT $$ ; $$');
  assert.equal(parts[3], 'SELECT 1');
  const script = 'SELECT 1;\nSELECT 2 FROM t';
  const at = statementAt(script, script.indexOf('2'));
  assert.match(at.text, /SELECT 2/);
  const selected = statementsToRun(script, 0, 'SELECT 1'.length, script.length);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].text, 'SELECT 1');
  const bounded = applyLimit('SELECT * FROM customers ORDER BY id', 100);
  assert.equal(bounded.bounded, true);
  assert.match(bounded.sql, /LIMIT 100$/);
  assert.equal(applyLimit('SELECT * FROM customers LIMIT 5', 100).bounded, false);
  assert.equal(applyLimit("INSERT INTO customers (name) VALUES ('a')", 100).rows, false);
  const locked = applyLimit('SELECT * FROM t FOR UPDATE', 100);
  assert.equal(locked.bounded, true);
  assert.ok(locked.sql.indexOf('LIMIT 100') < locked.sql.indexOf('FOR UPDATE'));
  assert.equal(applyLimit('INSERT INTO t VALUES (1) RETURNING id', 100).bounded, false);
  assert.equal(applyLimit('INSERT INTO t VALUES (1) RETURNING id', 100).sql.includes('LIMIT'), false);
  assert.equal(applyLimit('SHOW TABLES', 100).bounded, false);
  assert.equal(applyLimit('PRAGMA table_info(t)', 100).bounded, false);
  assert.equal(applyLimit('EXPLAIN SELECT 1', 100).bounded, false);
  assert.equal(applyLimit('DESCRIBE t', 100).bounded, false);
  assert.equal(applyLimit('SELECT * FROM t LIMIT 0', 100).bounded, false);
  assert.equal(applyLimit('SELECT * FROM t LIMIT 0', 100).sql, 'SELECT * FROM t LIMIT 0');
  const withSelect = applyLimit('WITH src AS (SELECT 1) SELECT * FROM src', 100);
  assert.equal(withSelect.bounded, true);
  assert.match(withSelect.sql, /LIMIT 100$/);
  assert.equal(applyLimit('WITH src AS (SELECT 1) INSERT INTO t SELECT * FROM src', 100).bounded, false);
  const hashParts = splitStatements('SELECT 1; # comment ; DROP TABLE x\nSELECT 2', 'mysql').map((part) => part.text);
  assert.equal(hashParts.length, 2);
  assert.equal(hashParts[0], 'SELECT 1');
  assert.match(hashParts[1], /SELECT 2/);
  assert.equal(splitStatements('SELECT 1; # comment ; DROP TABLE x\nSELECT 2', 'mysql').length, 2);
  const escaped = splitStatements("SELECT 'a\\'; DELETE FROM t'; SELECT 2", 'mysql').map((part) => part.text);
  assert.equal(escaped.length, 2);
  assert.match(escaped[0], /SELECT 'a/);
  assert.equal(escaped[1], 'SELECT 2');
  const eString = splitStatements("SELECT E'a\\'; still'; SELECT 2", 'postgres').map((part) => part.text);
  assert.equal(eString.length, 2);
  assert.equal(eString[1], 'SELECT 2');
  assert.equal(statementInfo('WITH src AS (SELECT 1) SELECT * FROM src').verb, 'select');
  assert.equal(statementInfo('WITH src AS (SELECT 1) INSERT INTO t SELECT 1').rows, false);
  assert.equal(statementInfo('INSERT INTO t SELECT 1 RETURNING id').rows, true);
  assert.equal(selectStar('postgres', 'public', 'odd"name', 100), 'SELECT * FROM "public"."odd""name" LIMIT 100');
  assert.equal(selectStar('mysql', 'shop', 'order_items', 50), 'SELECT * FROM `shop`.`order_items` LIMIT 50');
  assert.match(destructiveReason('DELETE FROM customers'), /WHERE/);
  assert.match(destructiveReason('UPDATE customers SET x = 1 RETURNING *'), /WHERE/);
  assert.equal(destructiveReason('DELETE FROM customers WHERE id = 1'), '');
  assert.match(destructiveReason('DROP TABLE customers'), /DROP/);
  assert.match(destructiveReason('TRUNCATE TABLE customers'), /TRUNCATE/);
  assert.match(destructiveReason('GRANT SELECT ON t TO u'), /GRANT/);
  assert.match(destructiveReason('REVOKE SELECT ON t FROM u'), /REVOKE/);
  assert.match(destructiveReason('ALTER TABLE t ADD COLUMN x int'), /ALTER/);
  assert.equal(destructiveReason('SELECT * FROM t'), '');
  assert.match(sqliteBlockedReason('ATTACH DATABASE \'/tmp/x.db\' AS extra'), /ATTACH/);
  assert.match(sqliteBlockedReason('/* comment */ DeTaCh extra'), /DETACH/);
  assert.match(sqliteBlockedReason("SELECT load_extension('mod')"), /load_extension/);
  assert.equal(sqliteBlockedReason('SELECT 1 -- ATTACH DATABASE x'), '');
  assert.equal(sqliteBlockedReason("SELECT 'ATTACH'"), '');
});

test('结果按块截断，取消会停住迭代', async () => {
  const packed = packChunk(
    Array.from({ length: 5 }, (_item, index) => [index]),
    { already: 3, hardCap: 6, maxChars: 1_000_000, pack: (row) => row },
  );
  assert.equal(packed.rows.length, 3);
  assert.equal(packed.hitCap, true);
  assert.equal(packed.rest.length, 2);

  const big = packChunk([['x'.repeat(20)], ['y']], {
    already: 0,
    hardCap: 100,
    maxChars: 25,
    pack: (row) => row,
  });
  assert.equal(big.rows.length, 1);
  assert.deepEqual(big.rest, [['y']]);

  const signal = AbortSignal.abort();
  async function* rows() {
    yield 1;
    yield 2;
  }
  const iterator = rows();
  const taken = [];
  await assert.rejects(async () => {
    while (taken.length < 10) {
      if (signal.aborted) {
        const error = new Error('已取消');
        error.code = 'ABORTED';
        throw error;
      }
      const step = await iterator.next();
      if (step.done) break;
      taken.push(step.value);
    }
  }, /已取消/);
  assert.equal(taken.length, 0);
  assert.equal(isCancel(Object.assign(new Error('canceling statement due to user request'), { code: '57014' })), true);

  const sync = pullIterator([1, 2, 3, 4].values(), 2);
  assert.deepEqual(sync.rows, [1, 2]);
  assert.equal(sync.done, false);
});

test('大整数和小数按原文显示', () => {
  assert.deepEqual(packValue(9007199254740993n), { t: 'int', v: '9007199254740993' });
  assert.deepEqual(packValue('9007199254740993'), { t: 'int', v: '9007199254740993' });
  assert.deepEqual(packValue('00123').t, 'text');
  assert.deepEqual(packValue('10.50'), { t: 'dec', v: '10.50' });
  assert.deepEqual(packValue(null), { t: 'null' });
  const blob = packValue(new Uint8Array([0, 255]), 'preview');
  assert.equal(blob.t, 'blob');
  assert.equal(blob.v, '00ff');
});

test('密码只进入插件数据目录 vault.json，连接清单和环境变量连接都不留密码', async () => {
  const { root, dataDir, texts, app, events } = await harness();
  try {
    const saved = await app.handlers.save({
      name: 'QA PostgreSQL',
      engine: 'postgres',
      env: 'local',
      host: '127.0.0.1',
      port: 5432,
      user: 'shop',
      database: 'shop',
      sslmode: 'disable',
      password: 's3cret-value',
    });
    assert.equal(saved.connection.hasPassword, true);
    assert.equal('password' in saved.connection, false);
    const stored = JSON.parse(await readFile(join(dataDir, 'connections.json'), 'utf8'));
    assert.equal(JSON.stringify(stored).includes('s3cret-value'), false);
    assert.equal(stored[0].host, '127.0.0.1');
    assert.equal(Object.hasOwn(stored[0], 'password'), false);
    const file = vaultFileFromDataDir(dataDir);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw[saved.connection.id], 's3cret-value');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(readFile(configFileFromDataDir(dataDir, 'enso.dbstudio')));
    assert.match(redact('failed for s3cret-value at postgres://shop:s3cret-value@127.0.0.1/shop', ['s3cret-value']), /\[redacted\]/);
    assert.equal(redact('postgres://shop:s3cret-value@127.0.0.1/shop', []).includes('s3cret-value'), false);
    assert.equal(redact('login ab failed', ['ab']).includes('ab'), false);
    assert.equal(redact('keep empty', ['']), 'keep empty');
    assert.equal(redact('postgres://u:p@ss/word@h/db', []).includes('p@ss/word'), false);
    assert.match(redact('postgres://h/db?password=secret&x=1', []), /password=\[redacted\]/);
    assert.match(redact('mysql://h/db?pwd=secret', []), /pwd=\[redacted\]/);

    texts.set('.env', 'DATABASE_URL=postgres://envuser:env-pass@127.0.0.1:5432/envdb\n');
    texts.set('.env.local', 'DATABASE_URL="mysql://local:local-pass@10.0.0.8/app"\n');
    const state = await app.handlers.state();
    assert.equal(state.env.engine, 'mysql');
    assert.equal(state.env.host, '10.0.0.8');
    assert.equal(JSON.stringify(state).includes('local-pass'), false);
    assert.equal(JSON.stringify(state).includes('env-pass'), false);
    const again = connectionFromEnv(texts.get('.env'), 'DATABASE_URL=postgres://changed:new-pass@127.0.0.1/other\n', 'DATABASE_URL');
    assert.equal(again.secret.database, 'other');
    assert.equal(publicConnection(again.public).password, undefined);

    const parsed = parseEnv('export #nope\nexport DATABASE_URL=postgres://a:b@h/db\n# comment\nOTHER=1');
    assert.equal(parsed.DATABASE_URL, 'postgres://a:b@h/db');
    assert.equal(events.length, 0);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite 连接能查出真实行，大整数不丢精度', async () => {
  const { root, project, app } = await harness();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = join(project, 'shop.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, balance TEXT)');
    db.prepare('INSERT INTO customers (id, name, balance) VALUES (?, ?, ?)').run(9007199254740993n, 'Ada', '10.50');
    db.prepare('INSERT INTO customers (id, name, balance) VALUES (?, ?, ?)').run(2n, 'Grace', null);
    db.exec("CREATE VIEW names AS SELECT name FROM customers");
    db.close();

    const saved = await app.handlers.save({
      name: 'QA SQLite',
      engine: 'sqlite',
      env: 'dev',
      path: 'shop.db',
      password: '',
    });
    const tree = await app.handlers.tree({ connectionId: saved.connection.id, database: 'main', schema: 'main' }, { projectRoot: project });
    assert.deepEqual(
      tree.nodes.map((node) => `${node.kind}:${node.name}`),
      ['table:customers', 'view:names'],
    );
    const opened = await app.handlers.query(
      { connectionId: saved.connection.id, mode: 'table', table: 'customers', schema: 'main' },
      { projectRoot: project },
    );
    assert.equal(opened.cancelled, false);
    assert.equal(opened.rows.length, 2);
    const ada = opened.rows.find((row) => row[1].v === 'Ada');
    assert.equal(ada[0].v, '9007199254740993');
    assert.equal(ada[0].t, 'int');
    assert.equal(ada[2].v, '10.50');
    const grace = opened.rows.find((row) => row[1].v === 'Grace');
    assert.equal(grace[2].t, 'null');
    assert.match(opened.columns.map((column) => column.name).join(), /id/);

    const selected = await app.handlers.query(
      {
        connectionId: saved.connection.id,
        sql: "SELECT name FROM customers WHERE name = 'Ada'; SELECT id FROM customers",
        selectionStart: 0,
        selectionEnd: "SELECT name FROM customers WHERE name = 'Ada'".length,
        cursor: 0,
      },
      { projectRoot: project },
    );
    assert.equal(selected.rows.length, 1);
    assert.equal(selected.rows[0][0].v, 'Ada');
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('假的 Postgres 驱动只连到保存的主机，取消会调用 CancelRequest', async () => {
  const seen = [];
  let pending = null;
  const postgres = (options) => {
    seen.push(options);
    const api = {
      async reserve() {
        return api;
      },
      unsafe(text) {
        const query = {
          text,
          raw() {
            return query;
          },
          cursor() {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next() {
                    postgres.ready = true;
                    return new Promise((resolve, reject) => {
                      pending = { resolve, reject };
                    });
                  },
                  async return() {
                    pending?.resolve({ done: true });
                    return { done: true };
                  },
                };
              },
            };
          },
          cancel() {
            seen.push('cancel');
            pending?.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
            return Promise.resolve();
          },
          then(resolve) {
            resolve({ count: 0, columns: [] });
          },
        };
        return query;
      },
      end() {
        seen.push('end');
        return Promise.resolve();
      },
    };
    return api;
  };
  postgres.ready = false;
  const { root, app, events } = await harness({ deps: { drivers: { postgres, createConnection() {} } } });
  try {
    const saved = await app.handlers.save({
      name: 'QA',
      engine: 'postgres',
      host: 'db.internal',
      port: 5432,
      user: 'shop',
      database: 'shop',
      password: 'pw-secret',
    });
    const running = app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT pg_sleep(30)', cursor: 10, selectionStart: 0, selectionEnd: 0 },
      { projectRoot: null },
    );
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (postgres.ready && events.length) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('查询没有开始'));
      }, 2000);
    });
    const result = await Promise.all([running, app.handlers.cancel({ queryId: events.at(-1).data.queryId })]).then(([value]) => value);
    assert.equal(result.cancelled, true);
    assert.equal(seen.some((item) => item === 'cancel'), true);
    const options = seen.find((item) => item && item.host);
    assert.deepEqual(options.host, ['db.internal']);
    assert.deepEqual(options.port, [5432]);
    assert.equal(options.database, 'shop');
    assert.equal(JSON.stringify(options).includes('evil'), false);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('打包后的驱动是纯 JavaScript', () => {
  const source = readFileSync(new URL('../packages/enso.dbstudio/vendor/drivers.cjs', import.meta.url), 'utf8');
  assert.equal(/\.node['"]/.test(source), false);
  const require = createRequire(import.meta.url);
  const loaded = require('../packages/enso.dbstudio/vendor/drivers.cjs');
  assert.equal(typeof loaded.postgres, 'function');
  assert.equal(typeof loaded.createConnection, 'function');
});

async function sqliteFile(dir, name = 'shop.db') {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(1n, 'Ada');
  db.close();
  return file;
}

test('旧密钥槽迁进 vault.json，之后不再读宿主配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbstudio-'));
  const dataDir = join(root, 'data', 'enso.dbstudio');
  await mkdir(dataDir, { recursive: true });
  const id = `c_${'ab'.repeat(12)}`;
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'enso.dbstudio.json'), `${JSON.stringify({ passwords: JSON.stringify({ [id]: 'legacy-secret' }) })}\n`);
  const { app } = await harness({ root, dataDir });
  try {
    assert.equal(app.vault.get(id), 'legacy-secret');
    const vault = JSON.parse(await readFile(join(dataDir, 'vault.json'), 'utf8'));
    assert.equal(vault[id], 'legacy-secret');
    app.vault.delete(id);
    await app.handlers.save({
      name: 'Empty',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: 'x',
      database: 'x',
      password: 'fresh',
    });
    assert.equal(JSON.parse(await readFile(join(dataDir, 'vault.json'), 'utf8'))[id], undefined);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite 绝对路径默认拒绝，query_only 阻止写入，ATTACH 被拒', async () => {
  const { root, project, app } = await harness();
  try {
    const inside = await sqliteFile(project, 'shop.db');
    const outsideDir = join(root, 'outside');
    await mkdir(outsideDir, { recursive: true });
    const outside = await sqliteFile(outsideDir, 'other.db');
    await assert.rejects(resolveSqliteFile(project, outside), /项目外/);
    await assert.rejects(resolveSqliteFile(project, outside, { allowOutside: false }), /项目外/);
    const allowed = await resolveSqliteFile(project, outside, { allowOutside: true });
    assert.equal(allowed.real, await realpath(outside));
    const relative = await resolveSqliteFile(project, 'shop.db');
    assert.equal(relative.real, await realpath(inside));

    const saved = await app.handlers.save({ name: 'QA SQLite', engine: 'sqlite', env: 'dev', path: 'shop.db' });
    await assert.rejects(
      app.handlers.query(
        { connectionId: saved.connection.id, sql: "INSERT INTO customers (id, name) VALUES (2, 'x')", cursor: 0 },
        { projectRoot: project },
      ),
      /readonly|只读|query_only|readonly database/i,
    );
    await assert.rejects(
      app.handlers.query(
        { connectionId: saved.connection.id, sql: "ATTACH DATABASE 'other.db' AS extra", cursor: 0 },
        { projectRoot: project },
      ),
      /ATTACH/,
    );
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('破坏性语句先返回 needsConfirm，确认后才执行；prod 带连接名', async () => {
  const { root, project, app } = await harness({ config: { allowSqliteWrite: true } });
  try {
    await sqliteFile(project, 'shop.db');
    const saved = await app.handlers.save({ name: 'Prod Shop', engine: 'sqlite', env: 'prod', path: 'shop.db' });
    const pending = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'DELETE FROM customers', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(pending.needsConfirm, true);
    assert.match(pending.reason, /WHERE/);
    assert.equal(pending.prod, true);
    assert.equal(pending.connectionName, 'Prod Shop');
    const still = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT name FROM customers', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(still.rows.length, 1);
    const done = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'DELETE FROM customers', cursor: 0, confirm: true },
      { projectRoot: project },
    );
    assert.equal(done.needsConfirm, undefined);
    assert.equal(done.affected >= 1 || done.done, true);
    const empty = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT name FROM customers', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(empty.rows.length, 0);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('中文单元格按 UTF-8 字节截断，载荷按字节封顶', () => {
  const preview = packValue('汉'.repeat(100), 'preview');
  assert.equal(preview.cut, true);
  assert.ok(Buffer.byteLength(preview.v, 'utf8') <= PREVIEW_CHARS);
  assert.equal(preview.v.includes('\uFFFD'), false);
  assert.equal(truncateUtf8('😀', 3), '');
  assert.equal(truncateUtf8('😀x', 4), '😀');
  const packed = packChunk([['中'], ['中']], {
    already: 0,
    hardCap: 10,
    maxChars: 12,
    pack: (row) => row,
  });
  assert.equal(packed.rows.length, 1);
  assert.deepEqual(packed.rest, [['中']]);
});

test('timestamp 不经 Date 转 UTC，timestamptz 仍走 ISO', () => {
  const options = postgresOptions({ host: '127.0.0.1', port: 5432, user: 'u', database: 'd', sslmode: 'disable' }, '');
  assert.deepEqual(options.types.timestamp.from, [1114]);
  assert.equal(options.types.timestamp.parse('2024-01-15 08:00:00'), '2024-01-15 08:00:00');
  assert.equal(packValue('2024-01-15 08:00:00').v, '2024-01-15 08:00:00');
  const instant = new Date('2024-01-15T08:00:00.000Z');
  assert.equal(packValue(instant).v, instant.toISOString());
});

test('取消 SQLite 查询会停住 worker 并返回 cancelled', async () => {
  const { root, project, app } = await harness({ config: { rowLimit: 1000 } });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = join(project, 'shop.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 250; i += 1) insert.run(BigInt(i), `n${i}`);
    db.close();

    const saved = await app.handlers.save({ name: 'QA SQLite', engine: 'sqlite', env: 'dev', path: 'shop.db' });
    const first = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT id FROM customers', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(first.done, false);
    assert.ok(first.queryId);
    const cancelled = await app.handlers.cancel({ queryId: first.queryId });
    assert.equal(cancelled.cancelled, true);
    const again = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT COUNT(*) FROM customers', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(again.cancelled, false);
    assert.equal(again.rows.length, 1);

    const resolved = await resolveSqliteFile(project, 'shop.db');
    const session = new SqliteSession(resolved);
    await session.open();
    const hanging = session.query('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT n FROM t');
    hanging.catch(() => {});
    for (let i = 0; i < 40 && session.pending.size === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(session.pending.size > 0);
    const worker = session.worker;
    assert.ok(worker);
    const exited = new Promise((resolve) => worker.once('exit', () => resolve(true)));
    await session.cancel();
    await assert.rejects(hanging);
    assert.equal(session.worker, null);
    assert.equal(session.closed, true);
    assert.equal(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 2000))]), true);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('多语句取消在前置语句执行前就能停下', async () => {
  const { root, project, app } = await harness({ config: { allowSqliteWrite: true } });
  try {
    await sqliteFile(project, 'shop.db');
    const saved = await app.handlers.save({ name: 'QA SQLite', engine: 'sqlite', env: 'dev', path: 'shop.db' });
    const controller = new AbortController();
    controller.abort();
    const result = await app.handlers.query(
      {
        connectionId: saved.connection.id,
        sql: "INSERT INTO customers (id, name) VALUES (99, 'x'); SELECT 1",
        cursor: 0,
        confirm: true,
      },
      { projectRoot: project, signal: controller.signal },
    );
    assert.equal(result.cancelled, true);
    const check = await app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT id FROM customers WHERE id = 99', cursor: 0 },
      { projectRoot: project },
    );
    assert.equal(check.cancelled, false);
    assert.equal(check.rows.length, 0);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('sql.js 写语句会原子写回文件', async () => {
  const require = createRequire(import.meta.url);
  const init = require('../packages/enso.dbstudio/vendor/sql-wasm.cjs');
  const wasm = fileURLToPath(new URL('../packages/enso.dbstudio/vendor/sql-wasm.wasm', import.meta.url));
  const SQL = await init({ locateFile: () => wasm });
  const dir = await mkdtemp(join(tmpdir(), 'sqljs-'));
  try {
    const path = join(dir, 't.db');
    const db = wrapSqlJs(new SQL.Database(), path);
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'Ada')");
    await db.persist();
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    await db.close();
    const { DatabaseSync } = await import('node:sqlite');
    const again = new DatabaseSync(path);
    const rows = again.prepare('SELECT name FROM t').all();
    assert.equal(rows[0].name, 'Ada');
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('目录查询走已配置连接并响应取消', async () => {
  let reservedUnsafe = 0;
  let poolUnsafe = 0;
  let pending = null;
  const postgres = () => {
    const api = {
      closed: false,
      async reserve() {
        return {
          unsafe(text) {
            reservedUnsafe += 1;
            const query = {
              text,
              cancel() {
                pending?.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
                return Promise.resolve();
              },
              then(resolve, reject) {
                if (String(text).includes('pg_database')) {
                  pending = { resolve, reject };
                  return;
                }
                resolve([{ name: 'shop' }]);
              },
            };
            return query;
          },
        };
      },
      unsafe() {
        poolUnsafe += 1;
        return Promise.resolve([]);
      },
      async end() {
        api.closed = true;
      },
      async cancel() {
        api.closed = true;
      },
    };
    return api;
  };
  const { root, app } = await harness({ deps: { drivers: { postgres, createConnection() {} } } });
  try {
    const saved = await app.handlers.save({
      name: 'QA',
      engine: 'postgres',
      host: 'db.internal',
      port: 5432,
      user: 'shop',
      database: 'shop',
      password: 'pw',
    });
    const controller = new AbortController();
    const hanging = app.handlers.tree({ connectionId: saved.connection.id }, { signal: controller.signal });
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (pending) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('目录查询没有开始'));
      }, 2000);
    });
    controller.abort();
    const error = await hanging.catch((err) => err);
    assert.ok(reservedUnsafe > 0);
    assert.equal(poolUnsafe, 0);
    assert.equal(error.code, 'ABORTED');
    assert.match(error.message, /已取消/);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('PostgreSQL 开启 fetch_types，避免 reserve 请求被驱动丢弃', () => {
  const options = postgresOptions({ host: '127.0.0.1', port: 5432, user: 'u', database: 'd', sslmode: 'disable' }, '');
  assert.equal(options.fetch_types, true);
});

test('PostgreSQL reserve 超时后报错并允许重试', async () => {
  let calls = 0;
  const conn = { release() {} };
  const postgres = () => ({
    reserve() {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : Promise.resolve(conn);
    },
    async end() {},
  });
  const session = createPostgres(postgres, { host: '127.0.0.1', port: 5432, user: 'u', database: 'd' }, '');
  session.options.connect_timeout = 0.05;
  await assert.rejects(session.reserve(), /建立连接超时/);
  assert.equal(session.reserved, null);
  assert.equal(await session.reserve(), conn);
  assert.equal(calls, 2);
  await session.end();
});
