import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exportCsv, listObjects, openDatabase, queryScript, queryTable, readCell, readSchema } from './lib/engine.mjs';

const require = createRequire(import.meta.url);
const initSqlJs = require(fileURLToPath(new URL('./vendor/sql-wasm.cjs', import.meta.url)));
const wasmPath = fileURLToPath(new URL('./vendor/sql-wasm.wasm', import.meta.url));

let SQL = null;
let db = null;

async function sql() {
  if (!SQL) SQL = await initSqlJs({ locateFile: () => wasmPath });
  return SQL;
}

async function dispatch(message) {
  if (message.op === 'open') {
    const engine = await sql();
    if (db) {
      db.close();
      db = null;
    }
    db = openDatabase(engine, message.bytes);
    return { objects: listObjects(db) };
  }
  if (!db) throw new Error('数据库还没有打开');
  if (message.op === 'schema') return readSchema(db);
  if (message.op === 'rows') return queryTable(db, message.table, message);
  if (message.op === 'query') return queryScript(db, message.sql, message);
  if (message.op === 'cell') return readCell(db, message);
  if (message.op === 'export') return exportCsv(db, message);
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
      })
    );
});
