import { allowsManySheets, blankBook, parseDocument, serializeDocument } from './document.mjs';
import { parseDelimited, stringifyDelimited } from './csv.mjs';
import {
  CYCLE,
  REF,
  adjustFormula,
  deleteColsInArea,
  deleteRowsInArea,
  displayOf,
  err,
  evaluateFormula,
  insertColsInArea,
  insertRowsInArea,
  isErr,
  renameInFormula,
} from './formula.mjs';
import { MAX_COL, MAX_ROW, formatAddress, parseAddress } from './refs.mjs';

const HISTORY = 80;

function isNumericLiteral(raw) {
  return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(raw) || /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw);
}

function remap(cells, map) {
  const next = {};
  for (const [key, value] of Object.entries(cells)) {
    const [r, c] = key.split(',').map(Number);
    const pos = map(r, c);
    if (!pos || !value) continue;
    next[`${pos.r},${pos.c}`] = value;
  }
  return next;
}

function usedOf(sheet) {
  let maxR = -1;
  let maxC = -1;
  for (const key of Object.keys(sheet.cells)) {
    if (!sheet.cells[key]) continue;
    const [r, c] = key.split(',').map(Number);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { maxR, maxC, rows: maxR + 1, cols: maxC + 1 };
}

export function createSession({ text = '', rel = '工作簿.xlsx', onChange = null } = {}) {
  const session = {
    rel,
    book: blankBook(),
    kind: 'xlsx',
    warning: '',
    sheetIndex: 0,
    active: { r: 0, c: 0 },
    anchor: { r: 0, c: 0 },
    editing: false,
    draft: '',
    past: [],
    future: [],
    cache: new Map(),
    viewRows: 0,
    viewCols: 0,
    onChange,
    load(nextText, nextRel = this.rel) {
      const parsed = parseDocument(nextText, nextRel);
      this.rel = nextRel;
      this.book = parsed.book;
      this.kind = parsed.kind;
      this.warning = parsed.error || '';
      const visible = this.book.sheets.findIndex((sheet) => !sheet.hidden);
      this.sheetIndex = visible < 0 ? 0 : visible;
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.editing = false;
      this.draft = '';
      this.past = [];
      this.future = [];
      this.cache = new Map();
      this.viewRows = 0;
      this.viewCols = 0;
    },
    serialize() {
      return serializeDocument(this.book, this.rel);
    },
    current() {
      return this.book.sheets[this.sheetIndex];
    },
    grid() {
      const used = usedOf(this.current());
      return {
        rows: Math.min(MAX_ROW, Math.max(80, used.rows + 40, this.viewRows)),
        cols: Math.min(MAX_COL, Math.max(26, used.cols + 6, this.viewCols)),
        usedRows: used.rows,
        usedCols: used.cols,
      };
    },
    ensure(r, c) {
      if (r + 8 > this.viewRows) this.viewRows = Math.min(MAX_ROW, Math.max(this.viewRows, r + 24));
      if (c + 3 > this.viewCols) this.viewCols = Math.min(MAX_COL, Math.max(this.viewCols, c + 8));
    },
    raw(r, c, sheet = this.current()) {
      return sheet.cells[`${r},${c}`] ?? '';
    },
    resolveSheet(name, home) {
      if (name == null) return home;
      return this.book.sheets.find((sheet) => sheet.name.toLowerCase() === String(name).toLowerCase()) ?? null;
    },
    valueOn(sheet, r, c) {
      if (!sheet || r < 0 || c < 0 || r >= MAX_ROW || c >= MAX_COL) return null;
      const raw = this.raw(r, c, sheet);
      if (!raw) return null;
      if (raw.startsWith("'")) return raw.slice(1);
      if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
      if (raw.startsWith('=')) return this.evalFormula(sheet, r, c, raw);
      if (isNumericLiteral(raw)) return Number(raw.replace(/,/g, ''));
      return raw;
    },
    value(r, c) {
      return this.valueOn(this.current(), r, c);
    },
    evalFormula(sheet, r, c, raw) {
      const key = `${sheet.name}:${r},${c}`;
      if (this.cache.has(key)) {
        const hit = this.cache.get(key);
        if (hit === PENDING) return err(CYCLE);
        return hit;
      }
      this.cache.set(key, PENDING);
      const result = evaluateFormula(raw, this.makeCtx(sheet));
      this.cache.set(key, result);
      return result;
    },
    makeCtx(home) {
      const bounds = (area) => {
        const sheet = this.resolveSheet(area.sheet, home);
        if (!sheet) return err(REF);
        const used = usedOf(sheet);
        let r1 = area.r1;
        let r2 = area.r2;
        let c1 = area.c1;
        let c2 = area.c2;
        if (area.wholeCol) {
          r1 = 0;
          r2 = used.maxR;
        }
        if (area.wholeRow) {
          c1 = 0;
          c2 = used.maxC;
        }
        return { sheet: sheet.name, r1, r2, c1, c2 };
      };
      return {
        bounds,
        at: (sheetName, r, c) => {
          const sheet = sheetName == null ? home : this.resolveSheet(sheetName, home);
          if (!sheet) return err(REF);
          return this.valueOn(sheet, r, c);
        },
        area: (area) => {
          const box = bounds(area);
          if (isErr(box)) return box;
          if (box.r2 < box.r1 || box.c2 < box.c1) return [];
          const height = box.r2 - box.r1 + 1;
          const width = box.c2 - box.c1 + 1;
          if (height * width > 200000) return err(REF);
          const sheet = this.resolveSheet(box.sheet, home);
          const values = [];
          for (let r = box.r1; r <= box.r2; r += 1) {
            for (let c = box.c1; c <= box.c2; c += 1) values.push(this.valueOn(sheet, r, c));
          }
          return values;
        },
      };
    },
    cellView(r, c) {
      const raw = this.raw(r, c);
      if (!raw) return { text: '', align: 'left', raw: '' };
      if (raw.startsWith("'")) return { text: raw.slice(1), align: 'left', raw };
      if (raw.startsWith('=')) return { ...displayOf(this.value(r, c)), raw };
      if (/^(true|false)$/i.test(raw)) return { text: raw.toUpperCase(), align: 'center', raw };
      if (isNumericLiteral(raw)) return { text: raw, align: 'right', raw };
      return { text: raw, align: 'left', raw };
    },
    editText() {
      return this.editing ? this.draft : this.raw(this.active.r, this.active.c);
    },
    selection() {
      return {
        r1: Math.min(this.anchor.r, this.active.r),
        c1: Math.min(this.anchor.c, this.active.c),
        r2: Math.max(this.anchor.r, this.active.r),
        c2: Math.max(this.anchor.c, this.active.c),
      };
    },
    stats() {
      const { r1, c1, r2, c2 } = this.selection();
      if (r1 === r2 && c1 === c2) return null;
      const sheet = this.current();
      let count = 0;
      let numeric = 0;
      let sum = 0;
      for (const [key, raw] of Object.entries(sheet.cells)) {
        if (!raw) continue;
        const [r, c] = key.split(',').map(Number);
        if (r < r1 || r > r2 || c < c1 || c > c2) continue;
        const value = this.valueOn(sheet, r, c);
        if (value == null || value === '') continue;
        count += 1;
        if (typeof value === 'number' && Number.isFinite(value)) {
          numeric += 1;
          sum += value;
        }
      }
      return {
        address: `${formatAddress(c1, r1)}:${formatAddress(c2, r2)}`,
        count,
        sum: numeric ? sum : null,
        average: numeric ? sum / numeric : null,
      };
    },
    select(r, c, extend = false) {
      const row = Math.max(0, Math.min(MAX_ROW - 1, r));
      const col = Math.max(0, Math.min(MAX_COL - 1, c));
      this.ensure(row, col);
      this.active = { r: row, c: col };
      if (!extend) this.anchor = { r: row, c: col };
      this.editing = false;
    },
    move(dr, dc, extend = false) {
      this.select(this.active.r + dr, this.active.c + dc, extend);
    },
    jump(dr, dc, extend = false) {
      const grid = this.grid();
      let r = this.active.r;
      let c = this.active.c;
      const filled = (rr, cc) => rr >= 0 && cc >= 0 && this.raw(rr, cc) !== '';
      const nextFilled = () => filled(r + dr, c + dc);
      if (!filled(r, c) || !nextFilled()) {
        do {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) break;
          r = nr;
          c = nc;
        } while (!filled(r, c));
      } else {
        while (filled(r + dr, c + dc)) {
          r += dr;
          c += dc;
        }
      }
      this.select(r, c, extend);
    },
    selectAll() {
      const used = usedOf(this.current());
      this.anchor = { r: 0, c: 0 };
      this.active = {
        r: Math.max(0, used.maxR),
        c: Math.max(0, used.maxC),
      };
      this.editing = false;
    },
    selectRow() {
      const grid = this.grid();
      this.anchor = { r: this.active.r, c: 0 };
      this.active = { r: this.active.r, c: grid.cols - 1 };
      this.editing = false;
    },
    selectCol() {
      const grid = this.grid();
      this.anchor = { r: 0, c: this.active.c };
      this.active = { r: grid.rows - 1, c: this.active.c };
      this.editing = false;
    },
    startEdit(seed = null) {
      const raw = this.raw(this.active.r, this.active.c);
      this.editing = true;
      this.draft = seed == null ? raw : seed;
    },
    setDraft(text) {
      this.editing = true;
      this.draft = String(text ?? '');
    },
    commit(dr = 0, dc = 0) {
      if (!this.editing) {
        if (dr || dc) this.move(dr, dc);
        return;
      }
      const { r, c } = this.active;
      const text = this.draft;
      this.editing = false;
      this.draft = '';
      if (this.raw(r, c) !== text.replace(/\u0000/g, '')) this.setCell(r, c, text);
      if (dr || dc) this.move(dr, dc);
    },
    cancel() {
      this.editing = false;
      this.draft = '';
    },
    setCell(r, c, raw) {
      const sheet = this.current();
      const key = `${r},${c}`;
      const text = String(raw ?? '').replace(/\u0000/g, '');
      if ((sheet.cells[key] ?? '') === text) return;
      this.snapshot();
      if (!text) delete sheet.cells[key];
      else sheet.cells[key] = text;
      this.cache = new Map();
      this.emit();
    },
    clearSelection() {
      const { r1, c1, r2, c2 } = this.selection();
      const sheet = this.current();
      const keys = [];
      for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
          if (sheet.cells[`${r},${c}`]) keys.push(`${r},${c}`);
        }
      }
      if (!keys.length) return;
      this.snapshot();
      for (const key of keys) delete sheet.cells[key];
      this.editing = false;
      this.cache = new Map();
      this.emit();
    },
    snapshot() {
      this.past.push(JSON.stringify(this.capture()));
      if (this.past.length > HISTORY) this.past.shift();
      this.future = [];
    },
    capture() {
      return {
        sheets: this.book.sheets,
        sheetIndex: this.sheetIndex,
        active: this.active,
        anchor: this.anchor,
      };
    },
    restore(raw) {
      const data = JSON.parse(raw);
      this.book = { sheets: data.sheets };
      this.sheetIndex = data.sheetIndex;
      this.active = data.active;
      this.anchor = data.anchor;
      this.editing = false;
      this.draft = '';
      this.cache = new Map();
      this.emit();
    },
    undo() {
      if (!this.past.length) return;
      this.future.push(JSON.stringify(this.capture()));
      this.restore(this.past.pop());
    },
    redo() {
      if (!this.future.length) return;
      this.past.push(JSON.stringify(this.capture()));
      this.restore(this.future.pop());
    },
    emit() {
      this.warning = '';
      if (this.onChange) this.onChange(this.serialize());
    },
    rewrite(editedName, mutate) {
      for (const sheet of this.book.sheets) {
        for (const [key, raw] of Object.entries(sheet.cells)) {
          if (typeof raw === 'string' && raw.startsWith('=')) {
            sheet.cells[key] = adjustFormula(raw, sheet.name, editedName, mutate);
          }
        }
      }
    },
    insertRows(where) {
      const { r1, r2 } = this.selection();
      const count = r2 - r1 + 1;
      const at = where === 'below' ? r2 + 1 : r1;
      const used = usedOf(this.current());
      if (used.maxR + count >= MAX_ROW) {
        this.warning = '超出行数上限';
        return;
      }
      this.snapshot();
      const name = this.current().name;
      this.rewrite(name, (area) => insertRowsInArea(area, at, count));
      this.current().cells = remap(this.current().cells, (r, c) => ({ r: r >= at ? r + count : r, c }));
      if (this.active.r >= at) this.active = { ...this.active, r: this.active.r + count };
      if (this.anchor.r >= at) this.anchor = { ...this.anchor, r: this.anchor.r + count };
      this.cache = new Map();
      this.emit();
    },
    deleteRows() {
      const { r1, r2 } = this.selection();
      const count = r2 - r1 + 1;
      this.snapshot();
      const name = this.current().name;
      this.rewrite(name, (area) => deleteRowsInArea(area, r1, count));
      this.current().cells = remap(this.current().cells, (r, c) => {
        if (r >= r1 && r <= r2) return null;
        return { r: r > r2 ? r - count : r, c };
      });
      const row = Math.min(r1, Math.max(0, usedOf(this.current()).maxR));
      this.active = { r: row, c: this.active.c };
      this.anchor = { r: row, c: this.anchor.c };
      this.editing = false;
      this.cache = new Map();
      this.emit();
    },
    insertCols(where) {
      const { c1, c2 } = this.selection();
      const count = c2 - c1 + 1;
      const at = where === 'right' ? c2 + 1 : c1;
      const used = usedOf(this.current());
      if (used.maxC + count >= MAX_COL) {
        this.warning = '超出列数上限';
        return;
      }
      this.snapshot();
      const name = this.current().name;
      this.rewrite(name, (area) => insertColsInArea(area, at, count));
      this.current().cells = remap(this.current().cells, (r, c) => ({ r, c: c >= at ? c + count : c }));
      if (this.active.c >= at) this.active = { ...this.active, c: this.active.c + count };
      if (this.anchor.c >= at) this.anchor = { ...this.anchor, c: this.anchor.c + count };
      this.cache = new Map();
      this.emit();
    },
    deleteCols() {
      const { c1, c2 } = this.selection();
      const count = c2 - c1 + 1;
      this.snapshot();
      const name = this.current().name;
      this.rewrite(name, (area) => deleteColsInArea(area, c1, count));
      this.current().cells = remap(this.current().cells, (r, c) => {
        if (c >= c1 && c <= c2) return null;
        return { r, c: c > c2 ? c - count : c };
      });
      const col = Math.min(c1, Math.max(0, usedOf(this.current()).maxC));
      this.active = { r: this.active.r, c: col };
      this.anchor = { r: this.anchor.r, c: col };
      this.editing = false;
      this.cache = new Map();
      this.emit();
    },
    copyText() {
      const { r1, c1, r2, c2 } = this.selection();
      const matrix = [];
      for (let r = r1; r <= r2; r += 1) {
        const row = [];
        for (let c = c1; c <= c2; c += 1) row.push(this.raw(r, c));
        matrix.push(row);
      }
      return stringifyDelimited(matrix, '\t');
    },
    paste(text) {
      const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!source) return;
      const matrix = source.includes('\t')
        ? parseDelimited(source, '\t')
        : source.includes('\n') && source.includes(',')
          ? parseDelimited(source, ',')
          : [[source]];
      if (!matrix.length) return;
      const { r1, c1, r2, c2 } = this.selection();
      const single = matrix.length === 1 && matrix[0].length === 1;
      this.snapshot();
      const sheet = this.current();
      if (single && (r1 !== r2 || c1 !== c2)) {
        for (let r = r1; r <= r2; r += 1) {
          for (let c = c1; c <= c2; c += 1) {
            const value = matrix[0][0].replace(/\u0000/g, '');
            if (value) sheet.cells[`${r},${c}`] = value;
            else delete sheet.cells[`${r},${c}`];
          }
        }
      } else {
        const origin = this.active;
        matrix.forEach((row, dr) => {
          row.forEach((value, dc) => {
            const r = origin.r + dr;
            const c = origin.c + dc;
            if (r >= MAX_ROW || c >= MAX_COL) return;
            const text = value.replace(/\u0000/g, '');
            if (text) sheet.cells[`${r},${c}`] = text;
            else delete sheet.cells[`${r},${c}`];
          });
        });
        this.ensure(origin.r + matrix.length - 1, origin.c + Math.max(...matrix.map((row) => row.length)) - 1);
      }
      this.cache = new Map();
      this.editing = false;
      this.emit();
    },
    setActiveSheet(index) {
      const sheet = this.book.sheets[index];
      if (!sheet || sheet.hidden) return;
      this.sheetIndex = index;
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.editing = false;
      this.cache = new Map();
    },
    addSheet() {
      if (!allowsManySheets(this.kind)) {
        this.warning = 'CSV / TSV 只有一张工作表';
        return;
      }
      this.snapshot();
      const names = new Set(this.book.sheets.map((sheet) => sheet.name.toLowerCase()));
      let n = this.book.sheets.length + 1;
      let name = `工作表${n}`;
      while (names.has(name.toLowerCase())) {
        n += 1;
        name = `工作表${n}`;
      }
      this.book.sheets.push({ name, hidden: false, cells: {} });
      this.sheetIndex = this.book.sheets.length - 1;
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.cache = new Map();
      this.emit();
    },
    deleteSheet(index = this.sheetIndex) {
      if (this.book.sheets.length <= 1) {
        this.warning = '至少保留一张工作表';
        return;
      }
      this.snapshot();
      const removed = this.book.sheets[index].name;
      this.book.sheets.splice(index, 1);
      this.markDeletedSheet(removed);
      if (this.book.sheets.every((sheet) => sheet.hidden)) this.book.sheets[0].hidden = false;
      const visible = this.book.sheets.findIndex((sheet) => !sheet.hidden);
      this.sheetIndex = Math.min(visible < 0 ? 0 : visible, this.book.sheets.length - 1);
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.cache = new Map();
      this.emit();
    },
    markDeletedSheet(name) {
      for (const sheet of this.book.sheets) {
        for (const [key, raw] of Object.entries(sheet.cells)) {
          if (typeof raw !== 'string' || !raw.startsWith('=')) continue;
          sheet.cells[key] = adjustFormula(raw, sheet.name, name, () => null);
        }
      }
    },
    renameSheet(index, nextName) {
      const sheet = this.book.sheets[index];
      if (!sheet) return;
      let name = String(nextName ?? '').replace(/[\\/?*[\]:]/g, '').trim();
      name = [...name].slice(0, 31).join('');
      if (!name || name.toLowerCase() === sheet.name.toLowerCase()) {
        if (name && name !== sheet.name) {
          this.snapshot();
          const previous = sheet.name;
          sheet.name = name;
          this.renameRefs(previous, name);
          this.cache = new Map();
          this.emit();
        }
        return;
      }
      if (this.book.sheets.some((item, i) => i !== index && item.name.toLowerCase() === name.toLowerCase())) {
        this.warning = '已有同名工作表';
        return;
      }
      this.snapshot();
      const previous = sheet.name;
      sheet.name = name;
      this.renameRefs(previous, name);
      this.cache = new Map();
      this.emit();
    },
    renameRefs(from, to) {
      for (const sheet of this.book.sheets) {
        for (const [key, raw] of Object.entries(sheet.cells)) {
          if (typeof raw === 'string' && raw.startsWith('=')) sheet.cells[key] = renameInFormula(raw, from, to);
        }
      }
    },
    hideSheet(index = this.sheetIndex) {
      const visible = this.book.sheets.filter((sheet) => !sheet.hidden);
      if (visible.length <= 1) {
        this.warning = '不能隐藏最后一张工作表';
        return;
      }
      this.snapshot();
      this.book.sheets[index].hidden = true;
      if (this.sheetIndex === index) {
        this.sheetIndex = this.book.sheets.findIndex((sheet) => !sheet.hidden);
        this.active = { r: 0, c: 0 };
        this.anchor = { r: 0, c: 0 };
      }
      this.cache = new Map();
      this.emit();
    },
    unhideSheet(index) {
      const sheet = this.book.sheets[index];
      if (!sheet?.hidden) return;
      this.snapshot();
      sheet.hidden = false;
      this.sheetIndex = index;
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.cache = new Map();
      this.emit();
    },
    hiddenSheets() {
      return this.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => item.sheet.hidden);
    },
    goTo(text) {
      const ref = parseAddress(text);
      if (!ref) {
        this.warning = '无法识别单元格地址';
        return;
      }
      if (ref.sheet) {
        const index = this.book.sheets.findIndex((sheet) => sheet.name.toLowerCase() === ref.sheet.toLowerCase() && !sheet.hidden);
        if (index < 0) {
          this.warning = '找不到这个工作表';
          return;
        }
        this.sheetIndex = index;
      }
      this.select(ref.row, ref.col);
      this.warning = '';
    },
  };
  session.load(text, rel);
  session.onChange = onChange;
  return session;
}

const PENDING = Symbol('pending');
