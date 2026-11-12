import { parentPort } from 'node:worker_threads';
import { openDatabase, pullIterator } from './lib/sqlite.mjs';
import { sqliteBlockedReason, statementInfo, statementWrites } from './lib/scan.mjs';

let db = null;
let iterator = null;
let persistWhenIdle = false;

function finishIterator() {
  try {
    iterator?.return?.();
  } catch {
    // 语句已经释放
  }
  iterator = null;
}

async function persistIfDirty() {
  if (typeof db?.persist === 'function') await db.persist();
}

async function closeDb() {
  finishIterator();
  persistWhenIdle = false;
  if (!db) return;
  const current = db;
  db = null;
  try {
    await current.close();
  } catch {
    // 已经关掉
  }
}

function changes() {
  const rows = db.prepare('SELECT changes()').all();
  const value = rows[0];
  const raw = Array.isArray(value) ? value[0] : value;
  return Number(raw) || 0;
}

function take(count) {
  const pulled = pullIterator(iterator, count);
  if (pulled.done) finishIterator();
  return pulled;
}

async function dispatch(message) {
  if (message.op === 'open') {
    finishIterator();
    await closeDb();
    db = await openDatabase({ real: message.path, size: message.size }, { allowWrite: Boolean(message.allowWrite) });
    return { kind: db.kind };
  }
  if (message.op === 'close') {
    await closeDb();
    return {};
  }
  if (!db) throw new Error('数据库还没有打开');
  if (message.sql) {
    const blocked = sqliteBlockedReason(message.sql);
    if (blocked) throw new Error(blocked);
  }
  if (message.op === 'all') {
    const stmt = db.prepare(message.sql);
    const columns = stmt.columns();
    const rows = stmt.all().map((row) => {
      if (!Array.isArray(row)) return row;
      const object = {};
      columns.forEach((column, index) => {
        object[column.name] = row[index];
      });
      return object;
    });
    return { columns, rows };
  }
  if (message.op === 'exec') {
    finishIterator();
    db.exec(message.sql);
    await persistIfDirty();
    return { count: changes() };
  }
  if (message.op === 'query') {
    finishIterator();
    const info = statementInfo(message.sql);
    if (!info.rows) {
      db.exec(message.sql);
      await persistIfDirty();
      return { rowSet: false, count: changes(), columns: [], rows: [], done: true };
    }
    persistWhenIdle = statementWrites(message.sql);
    if (persistWhenIdle) db.touch?.();
    const stmt = db.prepare(message.sql);
    const columns = stmt.columns();
    iterator = stmt.iterate();
    const pulled = take(message.count);
    if (pulled.done && persistWhenIdle) {
      persistWhenIdle = false;
      await persistIfDirty();
    }
    return { rowSet: true, columns, rows: pulled.rows, done: pulled.done };
  }
  if (message.op === 'more') {
    if (!iterator) return { rowSet: true, columns: [], rows: [], done: true };
    const pulled = take(message.count);
    if (pulled.done && persistWhenIdle) {
      persistWhenIdle = false;
      await persistIfDirty();
    }
    return { rowSet: true, columns: [], rows: pulled.rows, done: pulled.done };
  }
  throw new Error('未知操作');
}

parentPort.on('message', (message) => {
  dispatch(message)
    .then((result) => parentPort.postMessage({ id: message.id, ok: true, result }))
    .catch((error) =>
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || '',
      }),
    );
});
