import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL_JS_MAX_BYTES, SQLITE_MAX_BYTES } from './limits.mjs';

const EXTENSIONS = ['.sqlite3', '.sqlite', '.db3', '.db'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', 'vendor']);

export function extensionOf(name) {
  const lower = String(name).toLowerCase();
  return EXTENSIONS.find((ext) => lower.endsWith(ext) && lower.length > ext.length) ?? null;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function isProjectRelative(input) {
  const text = String(input ?? '').trim().replaceAll('\\', '/');
  if (!text || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return false;
  return true;
}

async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return bytesRead >= 16 && buffer.toString('utf8') === 'SQLite format 3\u0000';
  } finally {
    await handle.close();
  }
}

async function describe(real, label, size) {
  if (!(await readHeader(real))) throw new Error('文件不是 SQLite 数据库（文件头不是 “SQLite format 3”）。');
  return { real, label, size };
}

/** 相对路径必须留在项目里。用户粘贴的绝对路径按原样打开。 */
export async function resolveSqliteFile(projectRoot, input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('\0') || raw.length > 4096) throw new Error('路径不合法');
  if (isProjectRelative(raw)) {
    const parts = raw.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
    if (!parts.length || parts.some((part) => part === '..')) throw new Error('路径不能跳出项目目录');
    if (!projectRoot) throw new Error('当前会话没有本机项目目录');
    let rootReal;
    try {
      rootReal = await realpath(projectRoot);
    } catch {
      throw new Error('当前会话没有本机项目目录');
    }
    const abs = resolve(rootReal, parts.join('/'));
    if (!inside(rootReal, abs)) throw new Error('路径不能跳出项目目录');
    let real;
    try {
      real = await realpath(abs);
    } catch {
      throw new Error('找不到文件');
    }
    if (!inside(rootReal, real)) throw new Error('路径不能跳出项目目录');
    const info = await stat(real);
    if (!info.isFile()) throw new Error('不是文件');
    if (info.size <= 0) throw new Error('文件是空的');
    if (info.size > SQLITE_MAX_BYTES) throw new Error('SQLite 文件超过 8GB');
    return describe(real, parts.join('/'), info.size);
  }
  const abs = resolve(raw);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error('找不到文件');
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error('不是文件');
  if (info.size <= 0) throw new Error('文件是空的');
  if (info.size > SQLITE_MAX_BYTES) throw new Error('SQLite 文件超过 8GB');
  return describe(real, raw, info.size);
}

export async function findSqliteFiles(projectRoot) {
  if (!projectRoot) return [];
  let rootReal;
  try {
    rootReal = await realpath(projectRoot);
  } catch {
    return [];
  }
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 6 || found.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 200) return;
      if (entry.isSymbolicLink()) continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensionOf(entry.name) || !inside(rootReal, abs)) continue;
      found.push(relative(rootReal, abs).split(sep).join('/'));
    }
  };
  await walk(rootReal, 0);
  found.sort((a, b) => a.localeCompare(b, 'zh'));
  return found;
}

export async function loadSqliteModule() {
  try {
    const mod = await import('node:sqlite');
    if (typeof mod.DatabaseSync !== 'function') return { kind: 'sql.js' };
    return { kind: 'node:sqlite', DatabaseSync: mod.DatabaseSync };
  } catch {
    return { kind: 'sql.js' };
  }
}

export function wrapNode(db) {
  return {
    kind: 'node:sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts?.(true);
      stmt.setReturnArrays?.(true);
      return {
        columns() {
          return stmt.columns().map((column) => ({ name: column.name, type: column.type || '' }));
        },
        iterate() {
          return stmt.iterate();
        },
        all() {
          return stmt.all();
        },
      };
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

let sqlJsModule = null;

async function loadSqlJs() {
  if (sqlJsModule) return sqlJsModule;
  const require = createRequire(import.meta.url);
  const init = require(fileURLToPath(new URL('../vendor/sql-wasm.cjs', import.meta.url)));
  const wasm = fileURLToPath(new URL('../vendor/sql-wasm.wasm', import.meta.url));
  sqlJsModule = await init({ locateFile: () => wasm });
  return sqlJsModule;
}

export function wrapSqlJs(db) {
  return {
    kind: 'sql.js',
    prepare(sql) {
      const stmt = db.prepare(sql);
      const names = stmt.getColumnNames();
      let used = false;
      const take = () => {
        if (used) throw new Error('这条语句已经读完');
        used = true;
      };
      return {
        columns() {
          return names.map((name) => ({ name, type: '' }));
        },
        iterate() {
          take();
          return {
            next() {
              if (!stmt.step()) {
                stmt.free();
                return { done: true, value: undefined };
              }
              return { done: false, value: stmt.get() };
            },
            return() {
              stmt.free();
              return { done: true };
            },
          };
        },
        all() {
          take();
          const rows = [];
          while (stmt.step()) rows.push(stmt.get());
          stmt.free();
          return rows;
        },
      };
    },
    exec(sql) {
      db.run(sql);
    },
    close() {
      db.close();
    },
  };
}

export async function openDatabase(file) {
  const module = await loadSqliteModule();
  if (module.kind === 'node:sqlite') {
    const db = new module.DatabaseSync(file.real, { readBigInts: true });
    return wrapNode(db);
  }
  if (file.size > SQL_JS_MAX_BYTES) {
    throw new Error('这个 Node 没有 node:sqlite。备用的 sql.js 只能把不超过 64MB 的库整个载入内存。');
  }
  const bytes = await readFile(file.real);
  const SQL = await loadSqlJs();
  return wrapSqlJs(new SQL.Database(bytes));
}

export function pullIterator(iterator, count) {
  const rows = [];
  while (rows.length < count) {
    const step = iterator.next();
    if (step.done) return { rows, done: true };
    rows.push(step.value);
  }
  return { rows, done: false };
}
