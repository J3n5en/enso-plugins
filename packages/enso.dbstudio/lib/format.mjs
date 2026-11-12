import { FULL_BLOB_BYTES, FULL_CELL_CHARS, PREVIEW_BLOB_BYTES, PREVIEW_CHARS } from './limits.mjs';

function hexOf(bytes, max) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const size = Math.min(view.byteLength, max);
  let hex = '';
  for (let i = 0; i < size; i += 1) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value)) return new Uint8Array(value);
  return null;
}

function integerString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) return value;
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    const name = value.constructor?.name;
    if (name === 'Long' || name === 'BigNumber') {
      const text = value.toString();
      if (/^-?(0|[1-9]\d*)$/.test(text)) return text;
    }
  }
  return null;
}

function decimalString(value) {
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)\.\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    const text = Object.is(value, -0) ? '-0' : String(value);
    return text;
  }
  return null;
}

/**
 * 大整数和小数保持十进制原文，不经过 Number。
 * 预览截断；完整内容由调用方另外保存，单元格接口再取回。
 */
export function packValue(value, mode = 'preview') {
  if (value == null) return { t: 'null' };
  const bytes = asBytes(value);
  if (bytes) {
    const limit = mode === 'full' ? FULL_BLOB_BYTES : PREVIEW_BLOB_BYTES;
    const packed = { t: 'blob', v: hexOf(bytes, limit), n: bytes.byteLength };
    if (bytes.byteLength > limit) packed.cut = true;
    return packed;
  }
  const integer = integerString(value);
  if (integer != null && (typeof value !== 'string' || integer === value)) {
    if (typeof value === 'string' && !/^-?(0|[1-9]\d*)$/.test(value)) {
      // 留给下面的文本分支，避免把带前导零的字符串当成整数。
    } else if (typeof value !== 'string' || /^-?(0|[1-9]\d*)$/.test(value)) {
      return { t: 'int', v: integer };
    }
  }
  const decimal = decimalString(value);
  if (decimal != null && typeof value !== 'string') return { t: 'float', v: decimal };
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)\.\d+$/.test(value)) return clip({ t: 'dec', v: value }, mode);
  if (typeof value === 'boolean') return { t: 'bool', v: value ? 'true' : 'false' };
  if (value instanceof Date) return { t: 'text', v: value.toISOString() };
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return clip({ t: 'text', v: text }, mode);
}

/** 按 UTF-8 字节截断，不拆开代理对。 */
export function truncateUtf8(text, maxBytes) {
  const input = String(text ?? '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let bytes = 0;
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    let next = i + 1;
    let size;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        next = i + 2;
        size = 4;
      } else size = 3;
    } else if (code <= 0x7f) size = 1;
    else if (code <= 0x7ff) size = 2;
    else size = 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i = next;
  }
  return input.slice(0, i);
}

function clip(cell, mode) {
  const limit = mode === 'full' ? FULL_CELL_CHARS : PREVIEW_CHARS;
  const truncated = truncateUtf8(cell.v, limit);
  if (truncated === cell.v) return cell;
  return { ...cell, v: truncated, n: cell.v.length, cut: true };
}

export function packRow(row, mode = 'preview') {
  return row.map((value) => packValue(value, mode));
}

export function fullText(value) {
  const cell = packValue(value, 'full');
  if (cell.t === 'null') return '';
  if (cell.t === 'blob') return cell.v;
  return cell.v ?? '';
}
