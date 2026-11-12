import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, clampInt } from './limits.mjs';

const VERBS = new Set([
  'select',
  'with',
  'table',
  'values',
  'show',
  'explain',
  'pragma',
  'describe',
  'desc',
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'call',
  'do',
  'use',
  'set',
  'begin',
  'commit',
  'rollback',
  'analyze',
  'vacuum',
]);

const ROW_VERBS = new Set(['select', 'table', 'values', 'show', 'explain', 'pragma', 'describe', 'desc']);
const LIMIT_VERBS = new Set(['select', 'table', 'values']);
const MYSQL_ENGINES = new Set(['mysql', 'mariadb']);
const READ_VERBS = new Set(['select', 'table', 'values', 'show', 'explain', 'describe', 'desc']);

function isIdent(char) {
  return /[A-Za-z0-9_]/.test(char);
}

function isMysql(engine) {
  return MYSQL_ENGINES.has(engine);
}

/** PostgreSQL `E'…'` / `e'…'`。`BE'…'` 这种标识符不算。 */
function isEString(text, quoteIndex) {
  if (quoteIndex < 1) return false;
  const mark = text[quoteIndex - 1];
  if (mark !== 'e' && mark !== 'E') return false;
  if (quoteIndex === 1) return true;
  return !isIdent(text[quoteIndex - 2]);
}

function skipLine(text, index) {
  let i = index;
  while (i < text.length && text[i] !== '\n') i += 1;
  return i;
}

function skipBlock(text, index) {
  const close = text.indexOf('*/', index + 2);
  return close === -1 ? text.length : close + 2;
}

function skipQuote(text, index, quote, engine) {
  const mysql = isMysql(engine);
  const backslash =
    quote === '`' || (quote === "'" && (mysql || (engine === 'postgres' && isEString(text, index)))) || (quote === '"' && mysql);
  let i = index + 1;
  while (i < text.length) {
    if (backslash && text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** `$tag$` 或 `$$`。`$1` 这种占位符不是美元引号。 */
export function dollarTagAt(text, index) {
  if (text[index] !== '$') return null;
  let end = index + 1;
  while (end < text.length && isIdent(text[end])) end += 1;
  if (text[end] !== '$') return null;
  return text.slice(index, end + 1);
}

function skipDollar(text, index) {
  const tag = dollarTagAt(text, index);
  if (!tag) return index + 1;
  const close = text.indexOf(tag, index + tag.length);
  return close === -1 ? text.length : close + tag.length;
}

function skipNonSql(text, index, engine) {
  const char = text[index];
  const next = text[index + 1];
  if (char === '-' && next === '-') return skipLine(text, index);
  if (char === '/' && next === '*') return skipBlock(text, index);
  if (isMysql(engine) && char === '#') return skipLine(text, index);
  if (char === "'" || char === '"' || char === '`') return skipQuote(text, index, char, engine);
  if (char === '$' && dollarTagAt(text, index)) return skipDollar(text, index);
  return index;
}

/**
 * 按分号切语句。字符串、注释、反引号、双引号和 PostgreSQL 美元引号里的分号不算。
 * 返回的 text 去掉首尾空白，但不含结尾分号。
 * engine 为 mysql/mariadb 时认 `#` 行注释，并在字符串里处理反斜杠转义；
 * postgres 只在 `E'…'` 里处理反斜杠。
 */
export function splitStatements(sql, engine) {
  const text = String(sql ?? '');
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonSql(text, i, engine);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === ';') {
      const raw = text.slice(start, i);
      if (raw.trim()) parts.push({ start, end: i, text: raw.trim() });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  const rest = text.slice(start);
  if (rest.trim()) parts.push({ start, end: text.length, text: rest.trim() });
  return parts;
}

/** 光标落在某条语句上；落在语句之间的空白时归到前一条。 */
export function statementAt(sql, index, engine) {
  const text = String(sql ?? '');
  const parts = splitStatements(text, engine);
  if (!parts.length) return null;
  const at = Math.max(0, Math.min(Number.isFinite(index) ? index : text.length, text.length));
  for (const part of parts) {
    if (at >= part.start && at <= part.end) return part;
  }
  let previous = parts[0];
  for (const part of parts) {
    if (part.start > at) return previous;
    previous = part;
  }
  return previous;
}

/** 有选区就只跑选区里的语句，否则跑光标所在的那一条。 */
export function statementsToRun(sql, selectionStart, selectionEnd, cursor, engine) {
  const text = String(sql ?? '');
  const start = Number(selectionStart);
  const end = Number(selectionEnd);
  if (Number.isInteger(start) && Number.isInteger(end) && end > start && start >= 0 && end <= text.length) {
    return splitStatements(text.slice(start, end), engine);
  }
  const one = statementAt(text, Number.isFinite(cursor) ? cursor : text.length, engine);
  return one ? [one] : [];
}

function inspect(sql, engine) {
  const text = String(sql ?? '');
  const words = [];
  let depth = 0;
  let limit = false;
  let fetch = false;
  let returning = false;
  let where = false;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonSql(text, i, engine);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const begin = i;
      i += 1;
      while (i < text.length && isIdent(text[i])) i += 1;
      if (depth === 0) {
        const word = text.slice(begin, i).toLowerCase();
        words.push(word);
        if (word === 'limit') limit = true;
        if (word === 'fetch') fetch = true;
        if (word === 'returning') returning = true;
        if (word === 'where') where = true;
      }
      continue;
    }
    i += 1;
  }
  let verb = null;
  for (const word of words) {
    if (!VERBS.has(word)) continue;
    if (verb == null || verb === 'with') verb = word;
    else break;
  }
  return { verb, limit, fetch, returning, where };
}

function eachIdent(sql, onWord, engine) {
  const text = String(sql ?? '');
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonSql(text, i, engine);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const begin = i;
      i += 1;
      while (i < text.length && isIdent(text[i])) i += 1;
      onWord(text.slice(begin, i).toLowerCase(), depth);
      continue;
    }
    i += 1;
  }
}

export function statementInfo(sql, engine) {
  const info = inspect(sql, engine);
  const rows = info.returning || ROW_VERBS.has(info.verb);
  return { ...info, rows };
}

const ALWAYS_DESTRUCTIVE = new Set(['drop', 'truncate', 'grant', 'revoke', 'alter']);

export function destructiveReason(sql) {
  const info = statementInfo(sql);
  if (ALWAYS_DESTRUCTIVE.has(info.verb)) {
    return `${info.verb.toUpperCase()} 会改结构或权限`;
  }
  if ((info.verb === 'delete' || info.verb === 'update') && !info.where) {
    return info.verb === 'delete' ? '没有 WHERE 的 DELETE 会删掉整张表的数据' : '没有 WHERE 的 UPDATE 会改掉整张表的数据';
  }
  return '';
}

export function confirmDestructive(statements) {
  for (const part of statements) {
    const reason = destructiveReason(part.text);
    if (reason) return { needsConfirm: true, reason };
  }
  return null;
}

export function sqliteBlockedReason(sql) {
  let blocked = '';
  eachIdent(sql, (word) => {
    if (blocked) return;
    if (word === 'attach' || word === 'detach') blocked = `不允许执行 ${word.toUpperCase()}`;
    else if (word === 'load_extension') blocked = '不允许执行 load_extension';
  });
  return blocked;
}

function lockClauseIndex(sql, engine) {
  const text = String(sql ?? '');
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonSql(text, i, engine);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const begin = i;
      i += 1;
      while (i < text.length && isIdent(text[i])) i += 1;
      const word = text.slice(begin, i).toLowerCase();
      if (word === 'for' || word === 'lock') {
        const rest = text.slice(begin).toLowerCase();
        if (word === 'for' && /^for\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(rest)) return begin;
        if (word === 'lock' && /^lock\s+in\s+share\s+mode\b/.test(rest)) return begin;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 只给顶层 SELECT / TABLE / VALUES（含 WITH 的最终查询）补 LIMIT。
 * LIMIT 插在 FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE 之前。
 * RETURNING、SHOW、PRAGMA、EXPLAIN、DESCRIBE 不改写；已有 LIMIT / FETCH 也不再追加。
 */
export function applyLimit(sql, limit = DEFAULT_ROW_LIMIT, engine) {
  const trimmed = String(sql ?? '').trim().replace(/;+\s*$/u, '').trim();
  const cap = clampInt(limit, 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT);
  const info = inspect(trimmed, engine);
  const rows = info.returning || ROW_VERBS.has(info.verb);
  if (!LIMIT_VERBS.has(info.verb)) return { sql: trimmed, bounded: false, rows };
  if (info.limit || info.fetch) return { sql: trimmed, bounded: false, rows: true };
  const lockAt = lockClauseIndex(trimmed, engine);
  if (lockAt === -1) return { sql: `${trimmed}\nLIMIT ${cap}`, bounded: true, rows: true };
  return {
    sql: `${trimmed.slice(0, lockAt).trimEnd()}\nLIMIT ${cap}\n${trimmed.slice(lockAt)}`,
    bounded: true,
    rows: true,
  };
}

/** sql.js 用来判断要不要把内存库写回文件。PRAGMA / INSERT / RETURNING 都算写。 */
export function statementWrites(sql, engine) {
  const info = inspect(sql, engine);
  if (info.returning) return true;
  if (!info.verb) return false;
  return !READ_VERBS.has(info.verb);
}
