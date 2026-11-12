import { cellsFromMatrix, detectDelimiter, matrixFromSheet, parseDelimited, stringifyDelimited } from './csv.mjs';
import { formatAddress, parseAddress } from './refs.mjs';

export function kindOf(rel) {
  const name = String(rel || '').split(/[/\\]/).pop().toLowerCase();
  if (name.endsWith('.tsv')) return 'tsv';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.ods')) return 'ods';
  return 'sheet';
}

export function allowsManySheets(kind) {
  return kind !== 'csv' && kind !== 'tsv';
}

export function blankBook() {
  return { sheets: [{ name: '工作表1', hidden: false, cells: {} }] };
}

function cleanName(name, index) {
  const text = String(name ?? '').replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31);
  return text || `工作表${index + 1}`;
}

function uniqueNames(sheets) {
  const used = new Set();
  return sheets.map((sheet, index) => {
    let name = cleanName(sheet.name, index);
    const base = name;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` ${n}`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });
}

function cellsFromA1(input) {
  const cells = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return cells;
  for (const [addr, value] of Object.entries(input)) {
    const ref = parseAddress(addr);
    if (!ref || ref.sheet) continue;
    const text = value == null ? '' : String(value).replace(/\u0000/g, '');
    if (text) cells[`${ref.row},${ref.col}`] = text;
  }
  return cells;
}

function bookFromJson(json) {
  const sheets = uniqueNames(
    json.sheets.map((sheet, index) => ({
      name: cleanName(sheet?.name, index),
      hidden: sheet?.hidden === true,
      cells: cellsFromA1(sheet?.cells),
    })),
  );
  if (!sheets.length) return blankBook();
  if (sheets.every((sheet) => sheet.hidden)) sheets[0].hidden = false;
  return { sheets };
}

function bookFromDelimited(text, delimiter) {
  const matrix = parseDelimited(text, delimiter);
  if (!matrix.length) return blankBook();
  return { sheets: [{ name: '工作表1', hidden: false, cells: cellsFromMatrix(matrix) }] };
}

export function parseDocument(text, rel) {
  const kind = kindOf(rel);
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (source.includes('\0')) {
    return {
      book: blankBook(),
      kind,
      error: 'Enso 的文件查看器只接收文本，打不开含空字节的二进制工作簿。请另存为 CSV 后再打开。',
    };
  }
  if (!source.trim()) return { book: blankBook(), kind, error: '' };
  if (kind === 'csv' || kind === 'tsv') {
    const delimiter = kind === 'tsv' ? '\t' : detectDelimiter(source);
    return { book: bookFromDelimited(source, delimiter), kind, error: '' };
  }
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(source);
      if (json && json['enso.spreadsheet'] === 1 && Array.isArray(json.sheets)) {
        return { book: bookFromJson(json), kind, error: '' };
      }
    } catch {
      /* 不是工作簿 JSON 时再尝试表格文本 */
    }
  }
  if (/[,;\t]/.test(source) || source.includes('\n')) {
    return { book: bookFromDelimited(source, detectDelimiter(source)), kind, error: '' };
  }
  return { book: bookFromDelimited(source, ','), kind, error: '' };
}

function a1Cells(cells) {
  const entries = Object.entries(cells).filter(([, value]) => value);
  entries.sort((a, b) => {
    const [ar, ac] = a[0].split(',').map(Number);
    const [br, bc] = b[0].split(',').map(Number);
    return ar - br || ac - bc;
  });
  const out = {};
  for (const [key, value] of entries) {
    const [r, c] = key.split(',').map(Number);
    out[formatAddress(c, r)] = value;
  }
  return out;
}

export function serializeDocument(book, rel) {
  const kind = kindOf(rel);
  if (kind === 'csv' || kind === 'tsv') {
    const sheet = book.sheets.find((item) => !item.hidden) ?? book.sheets[0];
    return stringifyDelimited(matrixFromSheet(sheet), kind === 'tsv' ? '\t' : ',');
  }
  const payload = {
    'enso.spreadsheet': 1,
    sheets: book.sheets.map((sheet) => {
      const item = { name: sheet.name, cells: a1Cells(sheet.cells) };
      if (sheet.hidden) item.hidden = true;
      return item;
    }),
  };
  return JSON.stringify(payload, null, 2);
}
