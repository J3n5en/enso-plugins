import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, clampInt } from './limits.mjs';

export function quoteIdent(engine, name) {
  const text = String(name ?? '');
  if (!text || text.includes('\0') || text.length > 256) throw new Error('标识符不合法');
  if (engine === 'mysql' || engine === 'mariadb') return `\`${text.replaceAll('`', '``').replaceAll('\\', '\\\\')}\``;
  return `"${text.replaceAll('"', '""')}"`;
}

export function quoteQualified(engine, schema, table) {
  const quoted = quoteIdent(engine, table);
  if (schema == null || schema === '') return quoted;
  return `${quoteIdent(engine, schema)}.${quoted}`;
}

/** 打开表或视图时的固定查询。limit 来自配置，默认 100。 */
export function selectStar(engine, schema, table, limit = DEFAULT_ROW_LIMIT) {
  const cap = clampInt(limit, 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT);
  return `SELECT * FROM ${quoteQualified(engine, schema, table)} LIMIT ${cap}`;
}
