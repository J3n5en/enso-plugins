import { parentPort } from 'node:worker_threads';
import { openDatabase, pullIterator } from './lib/sqlite.mjs';
import { statementInfo } from './lib/scan.mjs';

let db = null;
let iterator = null;

function finishIterator() {
  try {
    iterator?.return?.();
  } catch {
    // 语句已经释放
  }
  iterator = null;
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
    try {
      db?.close();
    } catch {
      // 上一份已经关掉
    }
    db = await openDatabase({ real: message.path, size: message.size });
    return { kind: db.kind };
  }
  if (!db) throw new Error('数据库还没有打开');
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
    return { count: changes() };
  }
  if (message.op === 'query') {
    finishIterator();
    const info = statementInfo(message.sql);
    if (!info.rows) {
      db.exec(message.sql);
      return { rowSet: false, count: changes(), columns: [], rows: [], done: true };
    }
    const stmt = db.prepare(message.sql);
    const columns = stmt.columns();
    iterator = stmt.iterate();
    const pulled = take(message.count);
    return { rowSet: true, columns, rows: pulled.rows, done: pulled.done };
  }
  if (message.op === 'more') {
    if (!iterator) return { rowSet: true, columns: [], rows: [], done: true };
    const pulled = take(message.count);
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
