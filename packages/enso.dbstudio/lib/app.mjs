import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mysqlColumnsSql,
  mysqlDatabases,
  mysqlRelationsSql,
  postgresColumnsSql,
  postgresDatabasesSql,
  postgresRelationsSql,
  postgresSchemasSql,
  sqliteColumnsSql,
  sqliteObjectsSql,
} from './catalog.mjs';
import { packChunk } from './chunk.mjs';
import { connectionFromEnv } from './envfile.mjs';
import { packValue } from './format.mjs';
import { selectStar } from './ident.mjs';
import { CHUNK_ROWS, HARD_ROW_CAP } from './limits.mjs';
import { applyLimit, confirmDestructive, sqliteBlockedReason, statementsToRun } from './scan.mjs';
import { createMysql, createPostgres, isCancel } from './servers.mjs';
import { resolveSettings } from './settings.mjs';
import { newConnectionId, normalizeRecord, publicConnection } from './store.mjs';
import { SqliteSession } from './sqlite-session.mjs';
import { findSqliteFiles, resolveSqliteFile } from './sqlite.mjs';
import { assertHost, assertPort } from './target.mjs';
import { configFileFromDataDir, readLegacyConfigFile, readVaultFile, redact, unpackVault, vaultFileFromDataDir, writeVaultFile } from './vault.mjs';

const require = createRequire(import.meta.url);

function loadBundledDrivers() {
  const loaded = require(fileURLToPath(new URL('../vendor/drivers.cjs', import.meta.url)));
  if (typeof loaded.postgres !== 'function' || typeof loaded.createConnection !== 'function') {
    throw new Error('数据库驱动没有正确打包');
  }
  return loaded;
}

function cancelled() {
  const error = new Error('已取消');
  error.code = 'ABORTED';
  return error;
}

function field(row, name) {
  if (row == null || Array.isArray(row)) return undefined;
  if (row[name] != null) return row[name];
  const key = Object.keys(row).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export function createApp(enso, deps = {}) {
  const dataDir = enso.dataDir;
  const configFile = configFileFromDataDir(dataDir, enso.pluginId || 'enso.dbstudio');
  const vaultFile = vaultFileFromDataDir(dataDir);
  const connectionsFile = dataDir ? join(dataDir, 'connections.json') : '';
  const vault = new Map();
  let connections = [];
  const pg = new Map();
  const mysqlSessions = new Map();
  const sqliteSessions = new Map();
  const runs = new Map();
  const busy = new Set();
  let drivers = deps.drivers || null;

  const secretList = () => [...vault.values()];
  const fail = (error) => {
    if (isCancel(error)) throw cancelled();
    throw new Error(redact(error instanceof Error ? error.message : String(error), secretList()) || '查询失败');
  };

  const settings = async () => resolveSettings(typeof enso.config?.get === 'function' ? await enso.config.get() : {});

  function bundled() {
    if (!drivers) drivers = deps.loadDrivers ? deps.loadDrivers() : loadBundledDrivers();
    return drivers;
  }

  async function loadVault() {
    vault.clear();
    const disk = readVaultFile(vaultFile);
    if (!disk.missing) {
      for (const [id, password] of disk.map) vault.set(id, password);
      return;
    }
    try {
      for (const [id, password] of unpackVault(await enso.config.get())) vault.set(id, password);
    } catch (error) {
      fail(error);
    }
    for (const [id, password] of readLegacyConfigFile(configFile)) vault.set(id, password);
    if (vault.size) writeVaultFile(vaultFile, vault);
  }

  async function persistVault() {
    if (vaultFile) writeVaultFile(vaultFile, vault);
  }

  async function loadConnections() {
    if (!connectionsFile) return;
    try {
      const parsed = JSON.parse(await readFile(connectionsFile, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const next = [];
      for (const item of parsed) {
        try {
          const record = publicConnection(normalizeRecord(item, String(item.id || '')));
          if (!/^c_[0-9a-f]{24}$/.test(record.id)) continue;
          if (record.engine !== 'sqlite') {
            record.host = assertHost(record.host);
            record.port = assertPort(record.port);
          }
          next.push(record);
        } catch {
          // 坏掉的条目不影响其它连接。
        }
      }
      connections = next;
    } catch {
      connections = [];
    }
  }

  async function persistConnections() {
    if (!connectionsFile) return;
    const clean = connections.map((item) => publicConnection(item));
    for (const item of clean) {
      if ('password' in item || 'url' in item) throw new Error('拒绝把凭据写进连接清单');
    }
    await mkdir(dataDir, { recursive: true });
    const tmp = `${connectionsFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, connectionsFile);
    await chmod(connectionsFile, 0o600);
  }

  async function readOptional(path) {
    try {
      return await enso.fs.readText(path);
    } catch {
      return '';
    }
  }

  async function envOffer() {
    if (!enso.fs?.readText) return null;
    const current = await settings();
    return connectionFromEnv(await readOptional('.env'), await readOptional('.env.local'), current.envVar);
  }

  async function materialize(id) {
    if (id === 'env') {
      const offer = await envOffer();
      if (!offer) throw new Error('项目的环境文件里没有连接串');
      if (offer.error) throw new Error(offer.error);
      const { password, ...record } = offer.secret;
      return { record: { ...offer.public, ...record, id: 'env' }, password: password || '' };
    }
    const record = connections.find((item) => item.id === id);
    if (!record) throw new Error('找不到这个连接');
    return { record, password: vault.get(id) || '' };
  }

  function trim(map) {
    while (map.size > 6) {
      const oldest = map.keys().next().value;
      const session = map.get(oldest);
      map.delete(oldest);
      void session?.end?.().catch(() => {});
      void session?.close?.();
    }
  }

  async function serverSession(record, password, database) {
    const dbName = database || record.database || (record.engine === 'postgres' ? 'postgres' : '');
    const key = `${record.id}\0${dbName}`;
    const map = record.engine === 'postgres' ? pg : mysqlSessions;
    const cached = map.get(key);
    if (cached && !cached.closed) return cached;
    const conn = { ...record, database: dbName };
    const session =
      record.engine === 'postgres'
        ? createPostgres(bundled().postgres, conn, password)
        : await createMysql(bundled().createConnection, conn, password);
    map.set(key, session);
    trim(map);
    return session;
  }

  async function sqliteSession(record, projectRoot) {
    const current = await settings();
    const file = await resolveSqliteFile(projectRoot, record.path, { allowOutside: current.allowOutsideSqlite });
    const key = `${record.id}\0${file.real}\0${current.allowSqliteWrite ? 'w' : 'r'}`;
    let session = sqliteSessions.get(key);
    if (!session || session.closed) {
      session = new SqliteSession(file, { allowWrite: current.allowSqliteWrite });
      sqliteSessions.set(key, session);
      trim(sqliteSessions);
    }
    return session;
  }

  function present(item) {
    return { ...publicConnection(item), source: 'saved', hasPassword: vault.has(item.id) };
  }

  async function state() {
    const current = await settings();
    const offer = await envOffer();
    return {
      connections: connections.map(present),
      env: offer?.public ? { ...offer.public } : null,
      envError: offer?.error || '',
      rowLimit: current.rowLimit,
      queryTimeout: current.queryTimeout,
      hardCap: HARD_ROW_CAP,
    };
  }

  async function save(args) {
    const existing = connections.find((item) => item.id === args?.id);
    const id = existing ? existing.id : newConnectionId();
    const record = publicConnection(normalizeRecord(args, id));
    if (record.engine !== 'sqlite') {
      record.host = assertHost(record.host);
      record.port = assertPort(record.port);
    }
    const index = connections.findIndex((item) => item.id === id);
    if (index === -1) connections.push(record);
    else connections[index] = record;
    if (typeof args?.password === 'string' && args.password) vault.set(id, args.password);
    await persistConnections();
    await persistVault();
    return { connection: present(record) };
  }

  async function remove(args) {
    const id = String(args?.id || '');
    connections = connections.filter((item) => item.id !== id);
    vault.delete(id);
    await persistConnections();
    await persistVault();
    for (const map of [pg, mysqlSessions]) {
      for (const [key, session] of map) {
        if (!key.startsWith(`${id}\0`)) continue;
        map.delete(key);
        void session.end?.().catch(() => {});
      }
    }
    for (const [key, session] of sqliteSessions) {
      if (!key.startsWith(`${id}\0`)) continue;
      sqliteSessions.delete(key);
      void session.close();
    }
    return { ok: true };
  }

  async function guard(connectionId) {
    if (busy.has(connectionId)) throw new Error('这个连接上还有查询在跑。先取消它。');
  }

  async function tree(args, ctx) {
    const { record, password } = await materialize(args?.connectionId);
    await guard(record.id);
    const database = typeof args?.database === 'string' ? args.database : '';
    const schema = typeof args?.schema === 'string' ? args.schema : '';
    try {
      if (record.engine === 'sqlite') return sqliteTree(record, ctx?.projectRoot, database, schema);
      const session = await serverSession(record, password, database || record.database);
      const current = await settings();
      await session.configure(current.queryTimeout, record.engine === 'postgres' ? schema || 'public' : database || record.database);
      if (!database) {
        if (record.engine === 'postgres') {
          const result = await session.simple(postgresDatabasesSql().text, [], ctx?.signal);
          return { nodes: rowsOf(result).map((row) => ({ kind: 'database', name: field(row, 'name'), database: field(row, 'name') })) };
        }
        const result = await session.simple('SHOW DATABASES', [], ctx?.signal);
        const names = mysqlDatabases(
          rowsOf(result).map((row) => ({ name: field(row, 'Database') || field(row, 'name') || Object.values(row)[0] })),
          record.database,
        );
        return { nodes: names.map((name) => ({ kind: 'database', name, database: name })) };
      }
      if (!schema) {
        if (record.engine === 'postgres') {
          const result = await session.simple(postgresSchemasSql().text, [], ctx?.signal);
          return {
            nodes: rowsOf(result).map((row) => ({ kind: 'schema', name: field(row, 'name'), database, schema: field(row, 'name') })),
          };
        }
        return { nodes: [{ kind: 'schema', name: database, database, schema: database }] };
      }
      const sql = record.engine === 'postgres' ? postgresRelationsSql() : mysqlRelationsSql();
      const result = await session.simple(sql.text, [schema], ctx?.signal);
      return {
        nodes: rowsOf(result).map((row) => ({
          kind: String(field(row, 'kind') || '').toLowerCase() === 'view' ? 'view' : 'table',
          name: field(row, 'name'),
          database,
          schema,
        })),
      };
    } catch (error) {
      fail(error);
    }
  }

  async function sqliteTree(record, projectRoot, database, schema) {
    if (!database) return { nodes: [{ kind: 'database', name: 'main', database: 'main' }] };
    if (!schema) return { nodes: [{ kind: 'schema', name: 'main', database: 'main', schema: 'main' }] };
    const session = await sqliteSession(record, projectRoot);
    const result = await session.all(sqliteObjectsSql());
    return {
      nodes: result.rows.map((row) => ({
        kind: field(row, 'kind') === 'view' ? 'view' : 'table',
        name: field(row, 'name'),
        database: 'main',
        schema: 'main',
      })),
    };
  }

  async function columns(args, ctx) {
    const { record, password } = await materialize(args?.connectionId);
    await guard(record.id);
    const database = String(args?.database || record.database || 'main');
    const schema = String(args?.schema || (record.engine === 'sqlite' ? 'main' : record.engine === 'postgres' ? 'public' : database));
    try {
      if (record.engine === 'sqlite') {
        const session = await sqliteSession(record, ctx?.projectRoot);
        const objects = await session.all(sqliteObjectsSql());
        const tables = [];
        for (const row of objects.rows) {
          const name = field(row, 'name');
          const info = await session.all(sqliteColumnsSql(name));
          tables.push({
            name,
            kind: field(row, 'kind') === 'view' ? 'view' : 'table',
            columns: info.rows.map((column) => field(column, 'name')).filter(Boolean),
          });
        }
        return { tables };
      }
      const session = await serverSession(record, password, database);
      const current = await settings();
      await session.configure(current.queryTimeout, record.engine === 'postgres' ? schema : database);
      const sql = record.engine === 'postgres' ? postgresColumnsSql() : mysqlColumnsSql();
      const result = await session.simple(sql.text, [schema], ctx?.signal);
      const map = new Map();
      for (const row of rowsOf(result)) {
        const table = field(row, 'table_name');
        const column = field(row, 'column_name');
        if (!table || !column) continue;
        if (!map.has(table)) map.set(table, []);
        map.get(table).push(column);
      }
      return { tables: [...map.entries()].map(([name, cols]) => ({ name, kind: 'table', columns: cols })) };
    } catch (error) {
      fail(error);
    }
  }

  async function ping(args, ctx) {
    const { record, password } = await materialize(args?.connectionId);
    try {
      if (record.engine === 'sqlite') {
        const session = await sqliteSession(record, ctx?.projectRoot);
        await session.all('SELECT 1 AS ok');
        return { ok: true, kind: session.kind || 'sqlite' };
      }
      const session = await serverSession(record, password, record.database);
      const current = await settings();
      await session.configure(current.queryTimeout, record.engine === 'postgres' ? 'public' : record.database);
      await session.simple('SELECT 1 AS ok', [], ctx?.signal);
      return { ok: true };
    } catch (error) {
      fail(error);
    }
  }

  function startRun(connectionId, onStop, session = null) {
    const run = {
      id: `q_${crypto.randomUUID().replaceAll('-', '')}`,
      connectionId,
      controller: new AbortController(),
      columns: [],
      buffer: [],
      rowsSent: 0,
      done: false,
      hitCap: false,
      bounded: false,
      cells: new Map(),
      started: Date.now(),
      statements: 1,
      affected: 0,
      pull: null,
      stopped: false,
      reset: false,
      session,
      stopping: null,
      async stop() {
        if (run.stopping) return run.stopping;
        run.stopped = true;
        clearTimeout(run.timer);
        run.stopping = (async () => {
          try {
            await onStop(run);
          } catch {
            // 连接正在关掉
          }
          if (run.controller.signal.aborted && run.session && run.session.closed !== true) {
            try {
              if (typeof run.session.cancel === 'function') await run.session.cancel();
              else if (typeof run.session.end === 'function') await run.session.end();
              else await run.session.close?.();
            } catch {
              // 已经关掉
            }
          }
          busy.delete(connectionId);
        })();
        return run.stopping;
      },
    };
    run.controller.signal.addEventListener('abort', () => {
      void run.stop();
    }, { once: true });
    busy.add(connectionId);
    runs.set(run.id, run);
    try {
      void enso.ui?.view?.emit?.('query', { queryId: run.id, connectionId });
    } catch {
      // 侧栏没打开时宿主会丢掉这条事件。
    }
    return run;
  }

  async function pump(run) {
    while (run.buffer.length < CHUNK_ROWS && !run.done && run.rowsSent + run.buffer.length < HARD_ROW_CAP) {
      if (run.controller.signal.aborted) throw cancelled();
      const pulled = await run.pull(CHUNK_ROWS - run.buffer.length);
      if (pulled.columns?.length) run.columns = pulled.columns.map((column, index) => column?.name ? column : run.columns[index] || column);
      run.buffer.push(...(pulled.rows || []));
      if (pulled.done || !pulled.rows?.length) run.done = true;
      if (!pulled.rows?.length) break;
    }
    if (run.rowsSent + run.buffer.length >= HARD_ROW_CAP) run.hitCap = true;
  }

  async function emit(run) {
    const packed = packChunk(run.buffer, {
      already: run.rowsSent,
      pack(raw, absolute) {
        return raw.map((value, column) => {
          const full = packValue(value, 'full');
          const preview = packValue(value, 'preview');
          if (preview.cut || full.cut) run.cells.set(`${absolute}:${column}`, full);
          return preview;
        });
      },
    });
    run.buffer = packed.rest;
    run.rowsSent += packed.rows.length;
    if (packed.hitCap || run.hitCap) {
      run.hitCap = true;
      run.done = true;
      run.buffer = [];
      run.reset = true;
    }
    const finished = (run.done && run.buffer.length === 0) || run.hitCap;
    if (finished) await run.stop();
    return {
      queryId: run.id,
      columns: run.columns,
      rows: packed.rows,
      done: finished,
      hitCap: run.hitCap,
      bounded: run.bounded,
      shown: run.rowsSent,
      tookMs: Date.now() - run.started,
      affected: run.affected,
      statements: run.statements,
      cancelled: false,
    };
  }

  function arm(run, timeoutMs, outer) {
    run.timer = setTimeout(() => run.controller.abort(), timeoutMs);
    if (!outer) return;
    const stop = () => run.controller.abort();
    if (outer.aborted) stop();
    else outer.addEventListener('abort', stop, { once: true });
  }

  async function query(args, ctx) {
    const { record, password } = await materialize(args?.connectionId);
    await guard(record.id);
    const current = await settings();
    const database = String(args?.database || (record.engine === 'sqlite' ? 'main' : record.database || ''));
    const schema = String(args?.schema || (record.engine === 'sqlite' ? 'main' : record.engine === 'postgres' ? 'public' : database));
    let statements = [];
    const tableMode = args?.mode === 'table';
    if (tableMode) statements = [{ text: selectStar(record.engine, schema, args.table, current.rowLimit) }];
    else statements = statementsToRun(args?.sql, args?.selectionStart, args?.selectionEnd, args?.cursor, record.engine);
    if (!statements.length) throw new Error('没有可执行的语句');
    if (record.engine === 'sqlite') {
      for (const part of statements) {
        const blocked = sqliteBlockedReason(part.text);
        if (blocked) throw new Error(blocked);
      }
    }
    if (!tableMode && args?.confirm !== true) {
      const blocked = confirmDestructive(statements);
      if (blocked) {
        return {
          needsConfirm: true,
          reason: blocked.reason,
          prod: record.env === 'prod',
          connectionName: record.name,
          database: record.engine === 'sqlite' ? record.path || 'main' : database || record.database || '',
        };
      }
    }
    try {
      if (record.engine === 'sqlite') {
        return await runSqlite(record, ctx?.projectRoot, statements, current, tableMode, ctx?.signal);
      }
      const session = await serverSession(record, password, database);
      await session.configure(current.queryTimeout, record.engine === 'postgres' ? schema : database);
      return await runServer(session, record.id, statements, current, tableMode, ctx?.signal, record.engine);
    } catch (error) {
      busy.delete(record.id);
      if (isCancel(error) || ctx?.signal?.aborted) return { cancelled: true, rows: [], columns: [], done: true, shown: 0 };
      fail(error);
    }
  }

  async function runSqlite(record, projectRoot, statements, current, tableMode, outer) {
    const session = await sqliteSession(record, projectRoot);
    const run = startRun(record.id, async (currentRun) => {
      if (currentRun.controller.signal.aborted || currentRun.reset) await session.cancel();
    }, session);
    try {
      run.statements = statements.length;
      run.bounded = tableMode;
      run.pull = async () => {
        const page = await session.more();
        return { columns: page.columns, rows: page.rows || [], done: Boolean(page.done) };
      };
      arm(run, current.queryTimeout * 1000, outer);
      let final = null;
      for (let index = 0; index < statements.length; index += 1) {
        if (run.controller.signal.aborted) throw cancelled();
        const limited = tableMode
          ? { sql: statements[index].text, bounded: true, rows: true }
          : applyLimit(statements[index].text, current.rowLimit, record.engine);
        const isLast = index === statements.length - 1;
        if (!limited.rows) {
          run.affected += Number((await session.exec(limited.sql)).count) || 0;
          continue;
        }
        if (!isLast) {
          let page = await session.query(limited.sql);
          while (!page.done) {
            if (run.controller.signal.aborted) throw cancelled();
            page = await session.more();
          }
          continue;
        }
        final = limited;
        run.bounded = limited.bounded;
      }
      if (!final) {
        run.done = true;
        return await emit(run);
      }
      const first = await session.query(final.sql);
      run.columns = first.columns || [];
      if (first.rowSet === false) {
        run.done = true;
        run.affected += Number(first.count) || 0;
        return await emit(run);
      }
      run.buffer = first.rows || [];
      run.done = Boolean(first.done);
      await pump(run);
      return await emit(run);
    } catch (error) {
      run.reset = true;
      await run.stop();
      throw error;
    }
  }

  async function runServer(session, connectionId, statements, current, tableMode, outer, engine) {
    const run = startRun(connectionId, async (currentRun) => {
      if (currentRun.controller.signal.aborted || currentRun.reset) await session.cancel();
      else await session.finishCursor?.();
    }, session);
    run.statements = statements.length;
    arm(run, current.queryTimeout * 1000, outer);
    let final = null;
    try {
      for (let index = 0; index < statements.length; index += 1) {
        if (run.controller.signal.aborted) throw cancelled();
        const limited = tableMode
          ? { sql: statements[index].text, bounded: true, rows: true }
          : applyLimit(statements[index].text, current.rowLimit, engine);
        const isLast = index === statements.length - 1;
        if (!limited.rows) {
          run.affected += await session.exec(limited.sql, run.controller.signal);
          continue;
        }
        await session.start(limited.sql, run.controller.signal);
        if (!isLast) {
          while (true) {
            const pulled = await session.pull(CHUNK_ROWS);
            if (pulled.done) break;
          }
          await session.finishCursor?.();
          continue;
        }
        final = limited;
        run.bounded = limited.bounded;
        run.pull = (count) => session.pull(count);
      }
      if (!final) {
        run.done = true;
        return await emit(run);
      }
      await pump(run);
      return await emit(run);
    } catch (error) {
      run.reset = true;
      await run.stop();
      throw error;
    }
  }

  async function more(args) {
    const run = runs.get(args?.queryId);
    if (!run) throw new Error('这次查询已经结束');
    if (run.controller.signal.aborted) return { cancelled: true, queryId: run.id, rows: [], columns: run.columns, done: true, shown: run.rowsSent };
    try {
      if (!run.done && run.pull) await pump(run);
      return await emit(run);
    } catch (error) {
      run.reset = true;
      await run.stop();
      if (isCancel(error)) return { cancelled: true, queryId: run.id, rows: [], columns: run.columns, done: true, shown: run.rowsSent };
      fail(error);
    }
  }

  async function cancel(args) {
    const run = runs.get(args?.queryId);
    if (!run) return { cancelled: false };
    run.controller.abort();
    await run.stop();
    runs.delete(run.id);
    return { cancelled: true };
  }

  function cell(args) {
    const run = runs.get(args?.queryId);
    if (!run) throw new Error('结果已经不在了，请重新运行');
    const saved = run.cells.get(`${Number(args?.row)}:${Number(args?.column)}`);
    return saved || { missing: true };
  }

  const handlers = {
    state: () => state(),
    save: (args) => save(args),
    remove: (args) => remove(args),
    tree: (args, ctx) => tree(args, ctx),
    columns: (args, ctx) => columns(args, ctx),
    ping: (args, ctx) => ping(args, ctx),
    files: (_args, ctx) => findSqliteFiles(ctx?.projectRoot).then((files) => ({ files })),
    query: (args, ctx) => query(args, ctx),
    more: (args) => more(args),
    cancel: (args) => cancel(args),
    cell: (args) => cell(args),
  };

  return {
    handlers,
    ready: Promise.all([loadVault(), loadConnections()]),
    vault,
    connections: () => connections,
    dispose() {
      for (const run of runs.values()) run.controller.abort();
      for (const session of pg.values()) void session.end().catch(() => {});
      for (const session of mysqlSessions.values()) void session.end().catch(() => {});
      for (const session of sqliteSessions.values()) void session.close();
      pg.clear();
      mysqlSessions.clear();
      sqliteSessions.clear();
    },
  };
}
