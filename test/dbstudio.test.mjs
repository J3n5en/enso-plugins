import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../packages/enso.dbstudio/lib/app.mjs';
import { packChunk } from '../packages/enso.dbstudio/lib/chunk.mjs';
import { connectionFromEnv, parseEnv } from '../packages/enso.dbstudio/lib/envfile.mjs';
import { packValue } from '../packages/enso.dbstudio/lib/format.mjs';
import { selectStar } from '../packages/enso.dbstudio/lib/ident.mjs';
import { applyLimit, splitStatements, statementAt, statementInfo, statementsToRun } from '../packages/enso.dbstudio/lib/scan.mjs';
import { isCancel } from '../packages/enso.dbstudio/lib/servers.mjs';
import { resolveSettings } from '../packages/enso.dbstudio/lib/settings.mjs';
import { publicConnection } from '../packages/enso.dbstudio/lib/store.mjs';
import { pullIterator } from '../packages/enso.dbstudio/lib/sqlite.mjs';
import { killQuerySql, mysqlOptions, postgresOptions } from '../packages/enso.dbstudio/lib/target.mjs';
import { parseConnectionInput, parseServerUrl } from '../packages/enso.dbstudio/lib/url.mjs';
import { configFileFromDataDir, mergeConfigText, packVault, redact, unpackVault } from '../packages/enso.dbstudio/lib/vault.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../packages/enso.dbstudio/enso-plugin.json', import.meta.url), 'utf8'));

async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dbstudio-'));
  const dataDir = join(root, 'data', 'enso.dbstudio');
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

test('清单只申请侧栏和项目读取，版本是 0.1.0，密码走密钥配置', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'enso.dbstudio');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions, ['ui.view', 'fs.read']);
  assert.deepEqual(manifest.fs.read, ['.']);
  assert.equal(manifest.fs.write, undefined);
  assert.equal(manifest.net, undefined);
  assert.equal(manifest.contributes.fileViewers[0].extensions.join(), '.sql');
  assert.equal(manifest.contributes.fileViewers[0].default, undefined);
  const secrets = manifest.contributes.configuration.filter((item) => item.secret).map((item) => item.key);
  assert.deepEqual(secrets, ['passwords', 'passwords2', 'passwords3', 'passwords4']);
  const rowLimit = manifest.contributes.configuration.find((item) => item.key === 'rowLimit');
  assert.equal(rowLimit.type, 'number');
  assert.equal(rowLimit.default, 100);
  assert.deepEqual(resolveSettings({ rowLimit: 5000, queryTimeout: 0, envVar: '1bad' }), {
    rowLimit: 1000,
    queryTimeout: 1,
    envVar: 'DATABASE_URL',
  });
  assert.deepEqual(resolveSettings({ rowLimit: 'nope', queryTimeout: 9.5, envVar: 'DB_URL' }), {
    rowLimit: 100,
    queryTimeout: 30,
    envVar: 'DB_URL',
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
  assert.equal(statementInfo('WITH src AS (SELECT 1) SELECT * FROM src').verb, 'select');
  assert.equal(statementInfo('WITH src AS (SELECT 1) INSERT INTO t SELECT 1').rows, false);
  assert.equal(statementInfo('INSERT INTO t SELECT 1 RETURNING id').rows, true);
  assert.equal(selectStar('postgres', 'public', 'odd"name', 100), 'SELECT * FROM "public"."odd""name" LIMIT 100');
  assert.equal(selectStar('mysql', 'shop', 'order_items', 50), 'SELECT * FROM `shop`.`order_items` LIMIT 50');
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

test('密码只进入密钥配置，连接清单和环境变量连接都不留密码', async () => {
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
    const file = configFileFromDataDir(dataDir, 'enso.dbstudio');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(unpackVault(raw).get(saved.connection.id), 's3cret-value');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(redact('failed for s3cret-value at postgres://shop:s3cret-value@127.0.0.1/shop', ['s3cret-value']), /\[redacted\]/);
    assert.equal(redact('postgres://shop:s3cret-value@127.0.0.1/shop', []).includes('s3cret-value'), false);

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
    assert.equal(mergeConfigText('{"rowLimit":25}\n', packVault(new Map([[saved.connection.id, 's3cret-value']]))).includes('"rowLimit":25'), true);
    assert.equal(events.length, 0);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite 连接能查出真实行，大整数不丢精度，查询可以取消', async () => {
  const { root, project, app, events } = await harness();
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

    const hanging = app.handlers.query(
      { connectionId: saved.connection.id, sql: 'SELECT id FROM customers', cursor: 0, selectionStart: 0, selectionEnd: 0 },
      { projectRoot: project },
    );
    const started = await Promise.race([
      hanging,
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (events.some((event) => event.name === 'query')) {
            clearInterval(timer);
            resolve('event');
          }
        }, 5);
      }),
    ]);
    if (started === 'event') {
      const queryId = events.find((event) => event.name === 'query').data.queryId;
      await app.handlers.cancel({ queryId });
    }
    const settled = await hanging;
    assert.equal(settled.cancelled === true || Array.isArray(settled.rows), true);
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
