import { MAX_CELL_BLOB_BYTES, MAX_CELL_CHARS, PREVIEW_BLOB_BYTES, PREVIEW_CHARS } from './sql.mjs';

function hexOf(bytes, maxBytes) {
  const slice = bytes.subarray(0, maxBytes);
  let hex = '';
  for (const byte of slice) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function packValue(value, mode) {
  if (value == null) return { t: 'null' };
  if (typeof value === 'bigint') return { t: 'int', v: value.toString() };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { t: 'int', v: String(value) };
    return { t: 'float', v: String(value) };
  }
  if (typeof value === 'string') {
    const limit = mode === 'preview' ? PREVIEW_CHARS : MAX_CELL_CHARS;
    if (value.length <= limit) return { t: 'text', v: value };
    return { t: 'text', v: value.slice(0, limit), n: value.length, cut: true };
  }
  if (value instanceof Uint8Array) {
    const limit = mode === 'preview' ? PREVIEW_BLOB_BYTES : MAX_CELL_BLOB_BYTES;
    const hex = hexOf(value, limit);
    const packed = { t: 'blob', v: hex, n: value.byteLength };
    if (value.byteLength > limit) packed.cut = true;
    return packed;
  }
  return { t: 'text', v: String(value) };
}

export function packRow(row, mode) {
  return row.map((value) => packValue(value, mode));
}

export function cellPlain(cell) {
  if (!cell || cell.t === 'null') return '';
  if (cell.t === 'blob') return cell.v ? `x'${cell.v}'` : '';
  return cell.v ?? '';
}

export function csvField(cell) {
  let text = cellPlain(cell);
  if (cell?.cut) text += '…';
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function csvLine(cells) {
  return cells.map(csvField).join(',');
}

export function displayBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
