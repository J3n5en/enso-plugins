/** 结果与单元格上限。界面调用的返回值不能超过宿主的 1MB。 */
export const DEFAULT_ROW_LIMIT = 100;
export const MAX_ROW_LIMIT = 1000;
export const HARD_ROW_CAP = 5000;
export const CHUNK_ROWS = 100;
export const MAX_PAYLOAD_CHARS = 700_000;
export const PREVIEW_CHARS = 180;
export const FULL_CELL_CHARS = 512 * 1024;
export const PREVIEW_BLOB_BYTES = 32;
export const FULL_BLOB_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 110;
export const SQL_JS_MAX_BYTES = 64 * 1024 * 1024;
export const SQLITE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const SLOT_BUDGET = 4000;
export const MAX_PASSWORD_CHARS = 1024;
export const PASSWORD_SLOTS = ['passwords', 'passwords2', 'passwords3', 'passwords4'];

export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
