import { DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_SECONDS, MAX_ROW_LIMIT, MAX_TIMEOUT_SECONDS, clampInt } from './limits.mjs';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function resolveSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  const envVar = typeof source.envVar === 'string' && ENV_NAME.test(source.envVar) ? source.envVar : 'DATABASE_URL';
  return {
    envVar,
    rowLimit: clampInt(source.rowLimit, 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT),
    queryTimeout: clampInt(source.queryTimeout, 1, MAX_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    allowOutsideSqlite: source.allowOutsideSqlite === true,
    allowSqliteWrite: source.allowSqliteWrite === true,
  };
}
