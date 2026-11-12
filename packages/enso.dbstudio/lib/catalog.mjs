import { quoteIdent } from './ident.mjs';

const HIDDEN_PG = new Set(['pg_catalog', 'information_schema']);
const HIDDEN_MYSQL = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

export function postgresDatabasesSql() {
  return {
    text: `SELECT datname AS name
FROM pg_database
WHERE datallowconn AND NOT datistemplate
ORDER BY datname`,
    params: [],
  };
}

export function postgresSchemasSql() {
  return {
    text: `SELECT nspname AS name
FROM pg_namespace
WHERE nspname <> 'information_schema'
  AND nspname <> 'pg_catalog'
  AND nspname NOT LIKE 'pg_toast%'
  AND nspname NOT LIKE 'pg_temp_%'
ORDER BY nspname`,
    params: [],
  };
}

export function postgresRelationsSql() {
  return {
    text: `SELECT c.relname AS name,
       CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY kind, c.relname`,
    params: true,
  };
}

export function postgresColumnsSql() {
  return {
    text: `SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = $1
ORDER BY table_name, ordinal_position`,
    params: true,
  };
}

export function mysqlDatabases(rows, current) {
  return rows
    .map((row) => row.name || row.Database || row.database)
    .filter((name) => typeof name === 'string' && name && (!HIDDEN_MYSQL.has(name) || name === current));
}

export function mysqlRelationsSql() {
  return {
    text: `SELECT table_name AS name,
       CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS kind
FROM information_schema.tables
WHERE table_schema = ?
ORDER BY kind, table_name`,
    params: true,
  };
}

export function mysqlColumnsSql() {
  return {
    text: `SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = ?
ORDER BY table_name, ordinal_position`,
    params: true,
  };
}

export function sqliteObjectsSql() {
  return `SELECT name, type AS kind
FROM sqlite_master
WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`;
}

export function sqliteColumnsSql(table) {
  return `PRAGMA table_info(${quoteIdent('sqlite', table)})`;
}

export function visibleSchemas(names) {
  return names.filter((name) => typeof name === 'string' && name && !HIDDEN_PG.has(name) && !name.startsWith('pg_toast') && !name.startsWith('pg_temp_'));
}
