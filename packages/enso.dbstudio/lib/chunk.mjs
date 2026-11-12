import { HARD_ROW_CAP, MAX_PAYLOAD_CHARS } from './limits.mjs';

/** 从已经取到的原始行里切出一块不超过载荷上限的预览。剩下的行交还调用方。 */
export function packChunk(rawRows, { already = 0, hardCap = HARD_ROW_CAP, maxChars = MAX_PAYLOAD_CHARS, pack }) {
  const rows = [];
  let used = 0;
  let index = 0;
  for (; index < rawRows.length; index += 1) {
    if (already + rows.length >= hardCap) {
      return { rows, rest: rawRows.slice(index), hitCap: true };
    }
    const packed = pack(rawRows[index], already + rows.length);
    const size = Buffer.byteLength(JSON.stringify(packed), 'utf8') + 1;
    if (rows.length > 0 && used + size > maxChars) return { rows, rest: rawRows.slice(index), hitCap: false };
    rows.push(packed);
    used += size;
  }
  return { rows, rest: [], hitCap: already + rows.length >= hardCap };
}
