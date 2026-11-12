export const EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
export const MAX_DB_BYTES = 64 * 1024 * 1024;
export const TEXT_API_MAX = 5 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 100;
export const PREVIEW_CHARS = 120;
export const PREVIEW_BLOB_BYTES = 48;
export const MAX_CELL_CHARS = 100_000;
export const MAX_CELL_BLOB_BYTES = 32 * 1024;
export const MAX_EXPORT_CHARS = 512_000;
export const MAX_SQL_CHARS = 100_000;
export const MAX_STATEMENTS = 100;
export const MAX_MEMORY_ROWS = 10_000;
export const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

export function isSqliteBytes(bytes) {
  if (!bytes || bytes.length < 100) return false;
  const head = Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length));
  return head.equals(SQLITE_MAGIC);
}

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  let state = 'normal';
  const push = (end) => {
    const statement = sql.slice(start, end).trim();
    if (statement) out.push(statement);
    start = end + 1;
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (state === 'normal') {
      if (c === '-' && n === '-') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'bt';
      else if (c === '[') state = 'br';
      else if (c === ';') push(i);
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'normal';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'normal';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'sq') {
      if (c === "'" && n === "'") i += 2;
      else {
        if (c === "'") state = 'normal';
        i += 1;
      }
      continue;
    }
    if (state === 'dq') {
      if (c === '"' && n === '"') i += 2;
      else {
        if (c === '"') state = 'normal';
        i += 1;
      }
      continue;
    }
    if (state === 'bt') {
      if (c === '`') state = 'normal';
      i += 1;
      continue;
    }
    if (c === ']') state = 'normal';
    i += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function skipNoise(sql) {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i += 1;
      continue;
    }
    if (c === '-' && n === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(sql.length, i + 2);
      continue;
    }
    break;
  }
  return i;
}

export function leadingKeyword(sql) {
  const i = skipNoise(sql);
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
  return match ? match[0].toLowerCase() : '';
}

export function stripCommentsAndStrings(sql) {
  let out = '';
  let i = 0;
  let state = 'normal';
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (state === 'normal') {
      if (c === '-' && n === '-') {
        state = 'line';
        out += ' ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        out += ' ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`' || c === '[') {
        state = c;
        out += ' ';
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'normal';
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'normal';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const end = state === '[' ? ']' : state;
    if (c === end && (state === '[' || sql[i + 1] !== end)) state = 'normal';
    else if (c === end && sql[i + 1] === end) i += 1;
    i += 1;
  }
  return out;
}

export function assertReadOnlyStatement(sql) {
  const keyword = leadingKeyword(sql);
  if (!keyword) throw new Error('SQL 语句是空的');
  if (keyword === 'attach' || keyword === 'detach') throw new Error('只读模式不能附加或分离数据库。');
  const plain = stripCommentsAndStrings(sql);
  if (/load_extension\s*\(/i.test(plain)) throw new Error('只读模式不能加载扩展。');
  if (keyword === 'pragma' && /query_only\s*=\s*(0|off|false|no)\b/i.test(plain)) {
    throw new Error('不能关闭只读模式。');
  }
}

export function parseFilter(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'null') return { op: 'isnull' };
  if (lower === '!null' || lower === 'notnull') return { op: 'notnull' };
  const match = /^(>=|<=|!=|>|<|=)\s*([\s\S]*)$/.exec(trimmed);
  if (match && match[2] !== '') return { op: match[1], value: match[2] };
  return { op: 'contains', value: trimmed };
}

export function likePattern(value) {
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `%${escaped}%`;
}

export function bindCompare(value) {
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    return value;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

export function normalizePage(input) {
  const requested = Number(input?.pageSize);
  const pageSize = Number.isInteger(requested) && requested >= 1 && requested <= 500 ? requested : DEFAULT_PAGE_SIZE;
  const pageNumber = Number(input?.page);
  const page = Number.isInteger(pageNumber) && pageNumber >= 0 && pageNumber < 1_000_000 ? pageNumber : 0;
  return { page, pageSize };
}

export function normalizeSort(sort, columnCount) {
  if (!sort || typeof sort !== 'object') return null;
  const index = Number(sort.index);
  const dir = sort.dir === 'desc' ? 'desc' : sort.dir === 'asc' ? 'asc' : null;
  if (!dir || !Number.isInteger(index) || index < 0 || index >= columnCount) return null;
  return { index, dir };
}

export function normalizeSearch(search) {
  if (typeof search !== 'string') return '';
  return search.trim().slice(0, 200);
}

export function collectFilters(filters, columnCount) {
  const out = new Map();
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return out;
  for (const [key, value] of Object.entries(filters)) {
    if (!/^\d+$/.test(key)) continue;
    const index = Number(key);
    if (index >= columnCount) continue;
    if (typeof value !== 'string' || value.length > 500) continue;
    const parsed = parseFilter(value);
    if (parsed) out.set(index, parsed);
  }
  return out;
}

function predicate(ref, filter, params) {
  if (filter.op === 'isnull') return `${ref} IS NULL`;
  if (filter.op === 'notnull') return `${ref} IS NOT NULL`;
  if (filter.op === 'contains') {
    params.push(likePattern(filter.value));
    return `CAST(${ref} AS TEXT) LIKE ? ESCAPE '\\'`;
  }
  const op = { '=': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=' }[filter.op];
  if (!op) return null;
  params.push(bindCompare(filter.value));
  return `${ref} ${op} ?`;
}

export function compileWhere(columns, filters, search) {
  const unique = new Set(columns).size === columns.length;
  const active = filters.size > 0 || search !== '';
  if (!unique && active) return null;
  const parts = [];
  const params = [];
  for (const [index, filter] of filters) {
    const piece = predicate(quoteIdent(columns[index]), filter, params);
    if (piece) parts.push(piece);
  }
  if (search && columns.length) {
    const pattern = likePattern(search);
    const ors = columns.map((name) => `CAST(${quoteIdent(name)} AS TEXT) LIKE ? ESCAPE '\\'`);
    parts.push(`(${ors.join(' OR ')})`);
    for (let i = 0; i < ors.length; i += 1) params.push(pattern);
  }
  return { clause: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

export function orderClause(sort) {
  if (!sort) return '';
  return ` ORDER BY ${sort.index + 1} COLLATE NOCASE ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
}

export function friendlySqlError(error) {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '');
  if (/attempt to write a readonly database/i.test(message)) return '只读打开，不能执行会修改数据库的语句。';
  if (/not a database/i.test(message)) return '无法打开这个文件。它可能已损坏，或是 SQLCipher 等加密数据库。';
  if (/no such (table|view|column)/i.test(message)) return message;
  if (/incomplete input|unrecognized token/i.test(message)) return `SQL 不完整或无法识别：${message}`;
  if (/syntax error/i.test(message)) return `SQL 语法错误：${message}`;
  if (/Nothing to prepare/i.test(message)) return '没有可执行的语句。';
  return message;
}

export function sqliteFromUtf8Text(text) {
  if (typeof text !== 'string' || text.includes('\uFFFD')) return null;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) return null;
  if (!isSqliteBytes(bytes)) return null;
  return bytes;
}
