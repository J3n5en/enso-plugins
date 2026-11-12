/** 列号与 A1 地址。列、行都是 0 起算。 */

export const MAX_COL = 256;
export const MAX_ROW = 100000;

export function indexToCol(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return null;
    n = n * 26 + (ch.charCodeAt(0) - 64);
    if (n > 16384) return null;
  }
  return n - 1;
}

export function formatCell(col, row, absCol = false, absRow = false) {
  return `${absCol ? '$' : ''}${indexToCol(col)}${absRow ? '$' : ''}${row + 1}`;
}

export function formatAddress(col, row) {
  return formatCell(col, row);
}

/** 解析单个单元格，可带表名。失败返回 null。 */
export function parseAddress(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let sheet = null;
  let body = raw;
  const bang = splitSheet(raw);
  if (bang) {
    sheet = bang.sheet;
    body = bang.body;
  }
  const cell = parseCellToken(body, 0);
  if (!cell || cell.index !== body.length) return null;
  if (cell.col >= MAX_COL || cell.row >= MAX_ROW) return null;
  return { sheet, col: cell.col, row: cell.row };
}

export function splitSheet(text) {
  if (text.startsWith("'")) {
    let i = 1;
    let name = '';
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += text[i];
      i += 1;
    }
    if (text[i] !== "'" || text[i + 1] !== '!') return null;
    return { sheet: name, body: text.slice(i + 2), end: i + 2 };
  }
  const m = /^([^'!]+)!(.*)$/s.exec(text);
  if (!m) return null;
  return { sheet: m[1], body: m[2], end: m[1].length + 1 };
}

export function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function parseCellToken(text, index) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/.exec(text.slice(index));
  if (!m) return null;
  const col = colToIndex(m[2]);
  const row = Number(m[4]) - 1;
  if (col == null || col < 0 || row < 0 || row > 1048575) return null;
  return {
    index: index + m[0].length,
    col,
    row,
    absCol: m[1] === '$',
    absRow: m[3] === '$',
  };
}
