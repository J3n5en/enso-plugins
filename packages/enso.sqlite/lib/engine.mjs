import { csvLine, packRow, packValue } from './format.mjs';
import {
  MAX_EXPORT_CHARS,
  MAX_MEMORY_ROWS,
  MAX_SQL_CHARS,
  MAX_STATEMENTS,
  assertReadOnlyStatement,
  collectFilters,
  compileWhere,
  friendlySqlError,
  isSqliteBytes,
  normalizePage,
  normalizeSearch,
  normalizeSort,
  orderClause,
  quoteIdent,
  splitStatements,
} from './sql.mjs';

export function openDatabase(SQL, bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isSqliteBytes(buffer)) throw new Error('文件不是 SQLite 数据库（文件头不是 “SQLite format 3”）。');
  let db;
  try {
    db = new SQL.Database(buffer);
  } catch (error) {
    throw new Error(friendlySqlError(error));
  }
  try {
    db.run('PRAGMA query_only = ON');
  } catch (error) {
    db.close();
    throw new Error(friendlySqlError(error));
  }
  return db;
}

function readAll(db, sql, params = []) {
  db.run('PRAGMA query_only = ON');
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (error) {
    throw new Error(friendlySqlError(error));
  }
  try {
    if (params.length) stmt.bind(params);
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) rows.push(stmt.get(null, { useBigInt: true }));
    return { columns, rows };
  } catch (error) {
    throw new Error(friendlySqlError(error));
  } finally {
    stmt.free();
  }
}

function asCount(value) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(value);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function listObjects(db) {
  const { rows } = readAll(
    db,
    `SELECT type, name FROM sqlite_master
     WHERE type IN ('table', 'view')
     ORDER BY CASE WHEN name LIKE 'sqlite_%' THEN 1 ELSE 0 END,
              CASE type WHEN 'table' THEN 0 ELSE 1 END,
              name COLLATE NOCASE`
  );
  return rows.map(([type, name]) => ({ type, name }));
}

export function readSchema(db) {
  const { rows } = readAll(
    db,
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     ORDER BY CASE type
                WHEN 'table' THEN 0
                WHEN 'view' THEN 1
                WHEN 'index' THEN 2
                WHEN 'trigger' THEN 3
                ELSE 4
              END,
              name COLLATE NOCASE`
  );
  const titles = [
    ['table', '表'],
    ['view', '视图'],
    ['index', '索引'],
    ['trigger', '触发器'],
  ];
  const groups = titles.map(([id, title]) => ({ id, title, items: [] }));
  const byType = new Map(groups.map((group) => [group.id, group]));
  for (const [type, name, table, sql] of rows) {
    const group = byType.get(type);
    if (!group) continue;
    group.items.push({
      name,
      table: table ?? null,
      sql: typeof sql === 'string' ? sql : null,
    });
  }
  return { groups };
}

function tableColumns(db, table) {
  const { rows } = readAll(db, `SELECT name FROM pragma_table_info(${quoteLiteral(table)}) ORDER BY cid`);
  return rows.map(([name]) => name);
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertObject(db, table) {
  if (typeof table !== 'string' || table.length === 0 || table.length > 512) throw new Error('请选择一张表或视图');
  const { rows } = readAll(db, `SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`, [table]);
  if (!rows.length) throw new Error(`找不到表或视图：${table}`);
}

function valueText(value) {
  if (value == null) return '';
  if (value instanceof Uint8Array) {
    let hex = '';
    for (const byte of value) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }
  return String(value);
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return valueText(a).localeCompare(valueText(b), 'zh', { numeric: true, sensitivity: 'accent' });
}

function compareOp(left, right, op) {
  if (op === '=') return left === right;
  if (op === '!=') return left !== right;
  if (op === '>') return left > right;
  if (op === '>=') return left >= right;
  if (op === '<') return left < right;
  if (op === '<=') return left <= right;
  return true;
}

function matches(value, filter) {
  if (!filter) return true;
  if (filter.op === 'isnull') return value == null;
  if (filter.op === 'notnull') return value != null;
  if (value == null) return false;
  const text = valueText(value);
  if (filter.op === 'contains') return text.toLowerCase().includes(String(filter.value).toLowerCase());
  const right = String(filter.value);
  if (typeof value === 'bigint' && /^-?\d+$/.test(right)) return compareOp(value, BigInt(right), filter.op);
  if (typeof value === 'number' && Number.isFinite(Number(right))) return compareOp(value, Number(right), filter.op);
  return compareOp(text, right, filter.op);
}

function rowMatches(row, filters, search) {
  for (const [index, filter] of filters) {
    if (!matches(row[index], filter)) return false;
  }
  if (!search) return true;
  const needle = search.toLowerCase();
  return row.some((value) => valueText(value).toLowerCase().includes(needle));
}

function pageMemory(columns, rows, spec, started) {
  const { page, pageSize } = normalizePage(spec);
  const filters = collectFilters(spec.filters, columns.length);
  const search = normalizeSearch(spec.search);
  const sort = normalizeSort(spec.sort, columns.length);
  let filtered = rows.filter((row) => rowMatches(row, filters, search));
  if (sort) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    filtered = filtered.slice().sort((a, b) => dir * compareValues(a[sort.index], b[sort.index]));
  }
  const total = filtered.length;
  const start = page * pageSize;
  return finish(columns, filtered.slice(start, start + pageSize), { total, page, pageSize, capped: spec.capped === true }, started);
}

function finish(columns, rows, meta, started) {
  return {
    columns,
    rows: rows.map((row) => packRow(row, 'preview')),
    total: meta.total,
    page: meta.page,
    pageSize: meta.pageSize,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    capped: meta.capped === true,
  };
}

function canWrap(db, statement) {
  let stmt;
  try {
    stmt = db.prepare(`SELECT * FROM (\n${statement}\n) AS _enso_src LIMIT 0`);
    stmt.free();
    return true;
  } catch {
    if (stmt) {
      try {
        stmt.free();
      } catch {
        /* 准备失败时没有语句可释放 */
      }
    }
    return false;
  }
}

function queryWrapped(db, fromSql, columns, spec, started) {
  const { page, pageSize } = normalizePage(spec);
  const filters = collectFilters(spec.filters, columns.length);
  const search = normalizeSearch(spec.search);
  const sort = normalizeSort(spec.sort, columns.length);
  const where = compileWhere(columns, filters, search);
  if (!where) {
    const collected = readAll(db, `SELECT * FROM (${fromSql}) AS _enso_src`);
    const limited = collected.rows.slice(0, MAX_MEMORY_ROWS);
    return pageMemory(collected.columns, limited, { ...spec, capped: collected.rows.length > MAX_MEMORY_ROWS }, started);
  }
  const order = orderClause(sort);
  const count = readAll(db, `SELECT COUNT(*) AS n FROM (${fromSql}) AS _enso_src${where.clause}`, where.params);
  const total = asCount(count.rows[0]?.[0]);
  const rows = readAll(
    db,
    `SELECT * FROM (${fromSql}) AS _enso_src${where.clause}${order} LIMIT ? OFFSET ?`,
    [...where.params, pageSize, page * pageSize]
  );
  return finish(rows.columns.length ? rows.columns : columns, rows.rows, { total, page, pageSize }, started);
}

export function queryTable(db, table, spec = {}) {
  const started = performance.now();
  assertObject(db, table);
  const columns = tableColumns(db, table);
  const { page, pageSize } = normalizePage(spec);
  const filters = collectFilters(spec.filters, columns.length);
  const search = normalizeSearch(spec.search);
  const sort = normalizeSort(spec.sort, columns.length);
  const where = compileWhere(columns, filters, search);
  if (!where) {
    const collected = readAll(db, `SELECT * FROM ${quoteIdent(table)}`);
    const limited = collected.rows.slice(0, MAX_MEMORY_ROWS);
    const result = pageMemory(columns, limited, { ...spec, capped: collected.rows.length > MAX_MEMORY_ROWS }, started);
    result.columns = columns;
    return result;
  }
  const order = orderClause(sort);
  const count = readAll(db, `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${where.clause}`, where.params);
  const total = asCount(count.rows[0]?.[0]);
  const rows = readAll(
    db,
    `SELECT * FROM ${quoteIdent(table)}${where.clause}${order} LIMIT ? OFFSET ?`,
    [...where.params, pageSize, page * pageSize]
  );
  const result = finish(columns, rows.rows, { total, page, pageSize }, started);
  result.columns = columns;
  return result;
}

function executePassive(db, statement) {
  db.run('PRAGMA query_only = ON');
  let stmt;
  try {
    stmt = db.prepare(statement);
  } catch (error) {
    throw new Error(friendlySqlError(error));
  }
  try {
    const columns = stmt.getColumnNames();
    if (columns.length === 0) stmt.step();
    return columns;
  } catch (error) {
    throw new Error(friendlySqlError(error));
  } finally {
    stmt.free();
  }
}

export function queryScript(db, sql, spec = {}) {
  const started = performance.now();
  if (typeof sql !== 'string' || sql.trim() === '') throw new Error('请输入 SQL');
  if (sql.length > MAX_SQL_CHARS) throw new Error('SQL 超过 10 万字符');
  const statements = splitStatements(sql);
  if (!statements.length) throw new Error('请输入 SQL');
  if (statements.length > MAX_STATEMENTS) throw new Error(`一次最多 ${MAX_STATEMENTS} 条语句`);
  let chosen = null;
  for (const statement of statements) {
    assertReadOnlyStatement(statement);
    const columns = executePassive(db, statement);
    if (columns.length) chosen = { statement, columns };
  }
  if (!chosen) {
    return {
      columns: [],
      rows: [],
      total: 0,
      page: 0,
      pageSize: normalizePage(spec).pageSize,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      capped: false,
      statements: statements.length,
      message: `已执行 ${statements.length} 条语句，没有返回行。`,
    };
  }
  let result;
  if (canWrap(db, chosen.statement)) {
    result = queryWrapped(db, chosen.statement, chosen.columns, spec, started);
  } else {
    const collected = readAll(db, chosen.statement);
    const limited = collected.rows.slice(0, MAX_MEMORY_ROWS);
    result = pageMemory(collected.columns, limited, { ...spec, capped: collected.rows.length > MAX_MEMORY_ROWS }, started);
  }
  result.statements = statements.length;
  if (statements.length > 1) result.message = `已执行 ${statements.length} 条语句，显示最后一条有结果的查询。`;
  return result;
}

function oneRow(db, fromSql, columns, spec, rowIndex) {
  const filters = collectFilters(spec.filters, columns.length);
  const search = normalizeSearch(spec.search);
  const sort = normalizeSort(spec.sort, columns.length);
  const where = compileWhere(columns, filters, search);
  if (where && canWrap(db, fromSql)) {
    const rows = readAll(
      db,
      `SELECT * FROM (${fromSql}) AS _enso_src${where.clause}${orderClause(sort)} LIMIT 1 OFFSET ?`,
      [...where.params, rowIndex]
    );
    return rows.rows[0] ?? null;
  }
  const collected = readAll(db, `SELECT * FROM (${fromSql}) AS _enso_src`);
  let filtered = collected.rows.filter((row) => rowMatches(row, filters, search));
  if (sort) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    filtered = filtered.slice().sort((a, b) => dir * compareValues(a[sort.index], b[sort.index]));
  }
  return filtered[rowIndex] ?? null;
}

export function readCell(db, spec = {}) {
  const rowIndex = Number(spec.row);
  const column = Number(spec.column);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > 1_000_000_000) throw new Error('行号不合法');
  if (!Number.isInteger(column) || column < 0) throw new Error('列号不合法');
  let row = null;
  let columns = [];
  if (spec.kind === 'table') {
    assertObject(db, spec.table);
    columns = tableColumns(db, spec.table);
    row = oneRow(db, `SELECT * FROM ${quoteIdent(spec.table)}`, columns, spec, rowIndex);
  } else if (spec.kind === 'sql') {
    const picked = pickChosen(db, spec.sql);
    if (!picked) throw new Error('这条查询没有单元格');
    columns = picked.columns;
    row = oneRow(db, picked.statement, columns, spec, rowIndex);
  } else {
    throw new Error('未知的单元格来源');
  }
  if (!row || column >= row.length) throw new Error('单元格不存在');
  return { column: columns[column] ?? String(column), cell: packValue(row[column], 'full') };
}

function pickChosen(db, sql) {
  if (typeof sql !== 'string') throw new Error('请输入 SQL');
  const statements = splitStatements(sql);
  let chosen = null;
  for (const statement of statements) {
    assertReadOnlyStatement(statement);
    const columns = executePassive(db, statement);
    if (columns.length) chosen = { statement, columns };
  }
  return chosen;
}

export function exportCsv(db, spec = {}) {
  const kind = spec.kind === 'table' ? 'table' : 'sql';
  let columns = [];
  let fromSql = '';
  if (kind === 'table') {
    assertObject(db, spec.table);
    columns = tableColumns(db, spec.table);
    fromSql = `SELECT * FROM ${quoteIdent(spec.table)}`;
  } else {
    const picked = pickChosen(db, spec.sql);
    if (!picked) return { csv: '', rows: 0, truncated: false, columns: [] };
    columns = picked.columns;
    fromSql = picked.statement;
  }
  const filters = collectFilters(spec.filters, columns.length);
  const search = normalizeSearch(spec.search);
  const sort = normalizeSort(spec.sort, columns.length);
  const where = compileWhere(columns, filters, search);
  const header = csvLine(columns.map((name) => ({ t: 'text', v: name })));
  let csv = header;
  let exported = 0;
  let truncated = false;
  const order = orderClause(sort);
  if (where && canWrap(db, fromSql)) {
    const count = asCount(
      readAll(db, `SELECT COUNT(*) AS n FROM (${fromSql}) AS _enso_src${where.clause}`, where.params).rows[0]?.[0]
    );
    const chunk = 200;
    for (let offset = 0; offset < count; offset += chunk) {
      const page = readAll(
        db,
        `SELECT * FROM (${fromSql}) AS _enso_src${where.clause}${order} LIMIT ? OFFSET ?`,
        [...where.params, chunk, offset]
      );
      for (const row of page.rows) {
        const line = csvLine(packRow(row, 'full'));
        if (csv.length + line.length + 1 > MAX_EXPORT_CHARS) {
          truncated = true;
          break;
        }
        csv += `\n${line}`;
        exported += 1;
      }
      if (truncated) break;
    }
    if (!truncated && exported < count) truncated = true;
  } else {
    const collected = readAll(db, `SELECT * FROM (${fromSql}) AS _enso_src`);
    let filtered = collected.rows.filter((row) => rowMatches(row, filters, search));
    if (sort) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      filtered = filtered.slice().sort((a, b) => dir * compareValues(a[sort.index], b[sort.index]));
    }
    for (const row of filtered) {
      const line = csvLine(packRow(row, 'full'));
      if (csv.length + line.length + 1 > MAX_EXPORT_CHARS) {
        truncated = true;
        break;
      }
      csv += `\n${line}`;
      exported += 1;
    }
  }
  return { csv, rows: exported, truncated, columns };
}
