import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EXTENSIONS, MAX_DB_BYTES, TEXT_API_MAX, isSqliteBytes, sqliteFromUtf8Text } from './sql.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', 'vendor']);

export function extensionOf(name) {
  const lower = String(name).toLowerCase();
  return EXTENSIONS.find((ext) => lower.endsWith(ext) && lower.length > ext.length) ?? null;
}

export function normalizeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024 || rel.includes('\0')) {
    throw new Error('路径不合法');
  }
  const unified = rel.replaceAll('\\', '/').trim();
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) throw new Error('请使用项目内的相对路径');
  const parts = unified.split('/').filter((part) => part.length > 0 && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) throw new Error('路径不能跳出项目目录');
  if (!extensionOf(parts.at(-1))) throw new Error('只打开 .db、.sqlite、.sqlite3 文件');
  return parts.join('/');
}

function insideRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function nonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function sidecars(paths) {
  let wal = false;
  let journal = false;
  for (const path of paths) {
    wal = wal || (await nonEmptyFile(`${path}-wal`));
    journal = journal || (await nonEmptyFile(`${path}-journal`));
  }
  return { wal, journal };
}

export async function locateProjectFile(projectRoot, rel) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new Error('当前会话没有本机项目目录');
  const safe = normalizeRel(rel);
  let rootReal;
  try {
    rootReal = await realpath(projectRoot);
  } catch {
    throw new Error('当前会话没有本机项目目录');
  }
  const abs = resolve(rootReal, safe);
  if (!insideRoot(rootReal, abs)) throw new Error('路径不能跳出项目目录');
  let linkStat;
  try {
    linkStat = await lstat(abs);
  } catch {
    throw new Error('找不到文件');
  }
  if (!linkStat.isFile() && !linkStat.isSymbolicLink()) throw new Error('不是文件');
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error('找不到文件');
  }
  if (!insideRoot(rootReal, real)) throw new Error('路径不能跳出项目目录');
  const info = await stat(real);
  if (!info.isFile()) throw new Error('不是文件');
  if (info.size === 0) throw new Error('文件是空的');
  if (info.size > MAX_DB_BYTES) throw new Error(`文件超过 64MB（${info.size} 字节），无法整库载入内存。`);
  const side = await sidecars(abs === real ? [real] : [real, abs]);
  return {
    rel: safe,
    name: safe.split('/').at(-1),
    size: info.size,
    real,
    wal: side.wal,
    journal: side.journal,
  };
}

export async function loadDatabaseBytes(enso, projectRoot, rel) {
  const located = await locateProjectFile(projectRoot, rel);
  if (located.size <= TEXT_API_MAX && enso?.fs?.readText) {
    try {
      const text = await enso.fs.readText(located.rel);
      const recovered = sqliteFromUtf8Text(text);
      if (recovered && recovered.length === located.size) return { ...located, bytes: recovered };
    } catch {
      // 文本接口读不到无损字节时，继续读原始文件。
    }
  }
  const bytes = await readFile(located.real);
  if (!isSqliteBytes(bytes)) throw new Error('文件不是 SQLite 数据库（文件头不是 “SQLite format 3”）。');
  return { ...located, bytes };
}

export async function findDatabases(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new Error('当前会话没有本机项目目录');
  let rootReal;
  try {
    rootReal = await realpath(projectRoot);
  } catch {
    throw new Error('当前会话没有本机项目目录');
  }
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 8 || found.length >= 200) return;
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
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensionOf(entry.name)) continue;
      if (!insideRoot(rootReal, abs)) continue;
      found.push(relative(rootReal, abs).split(sep).join('/'));
    }
  };
  await walk(rootReal, 0);
  found.sort((a, b) => a.localeCompare(b, 'zh'));
  return found;
}
