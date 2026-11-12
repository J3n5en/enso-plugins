/** RFC 4180 风格的分隔文本。公式按用户输入原样保留。 */

export function parseDelimited(text, delimiter) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (!source) return [];
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cur);
      cur = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export function stringifyDelimited(matrix, delimiter) {
  return matrix
    .map((row) => row.map((field) => escapeField(String(field ?? ''), delimiter)).join(delimiter))
    .join('\n');
}

function escapeField(value, delimiter) {
  if (value.includes('"') || value.includes('\n') || value.includes('\r') || value.includes(delimiter)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function detectDelimiter(text) {
  const line = String(text ?? '').split(/\r?\n/, 1)[0] ?? '';
  const score = (ch) => {
    let n = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const cur = line[i];
      if (cur === '"') quoted = !quoted;
      else if (!quoted && cur === ch) n += 1;
    }
    return n;
  };
  const tabs = score('\t');
  const commas = score(',');
  const semis = score(';');
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

export function matrixFromSheet(sheet) {
  let maxR = -1;
  let maxC = -1;
  for (const key of Object.keys(sheet.cells)) {
    if (!sheet.cells[key]) continue;
    const [r, c] = key.split(',').map(Number);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR < 0) return [];
  const matrix = [];
  for (let r = 0; r <= maxR; r += 1) {
    const row = [];
    for (let c = 0; c <= maxC; c += 1) row.push(sheet.cells[`${r},${c}`] ?? '');
    matrix.push(row);
  }
  return matrix;
}

export function cellsFromMatrix(matrix) {
  const cells = {};
  matrix.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== '') cells[`${r},${c}`] = value;
    });
  });
  return cells;
}
