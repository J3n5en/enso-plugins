import { colToIndex, formatCell, indexToCol, quoteSheet } from './refs.mjs';

export const DIV0 = '#DIV/0!';
export const VALUE = '#VALUE!';
export const REF = '#REF!';
export const NAME = '#NAME?';
export const NA = '#N/A';
export const NUM = '#NUM!';
export const CYCLE = '#CYCLE!';
export const PARSE = '#ERROR!';

const ERROR_LITERALS = [DIV0, VALUE, REF, NAME, NA, NUM, CYCLE, PARSE, '#NULL!'];

export function err(code) {
  return { error: code };
}

export function isErr(value) {
  return !!value && typeof value === 'object' && typeof value.error === 'string';
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return NUM;
  if (Object.is(n, -0)) n = 0;
  const tidy = Number(n.toPrecision(12));
  n = Object.is(tidy, -0) ? 0 : tidy;
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e12 || abs < 1e-9)) {
    return n.toExponential(6).replace(/\.?0+(?=e)/, '');
  }
  const negative = n < 0;
  const [i, d] = Math.abs(n).toString().split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${d ? `.${d}` : ''}`;
}

export function displayOf(value) {
  if (value == null || value === '') return { text: '', align: 'left' };
  if (isErr(value)) return { text: value.error, align: 'center', error: true };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', align: 'center' };
  if (typeof value === 'number') {
    const text = formatNumber(value);
    if (text === NUM) return { text, align: 'center', error: true };
    return { text, align: 'right' };
  }
  return { text: String(value), align: 'left' };
}

function isIdentChar(ch) {
  return !!ch && /[A-Za-z0-9_\u0080-\uFFFF]/.test(ch);
}

class Parser {
  constructor(source) {
    this.s = source;
    this.i = 0;
  }

  skip() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t' || this.s[this.i] === '\n' || this.s[this.i] === '\r') {
      this.i += 1;
    }
  }

  peek() {
    this.skip();
    return this.s[this.i];
  }

  parseExpr() {
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseConcat();
    if (isErr(left)) return left;
    for (;;) {
      const op = this.matchOp(['<=', '>=', '<>', '=', '<', '>']);
      if (!op) return left;
      const right = this.parseConcat();
      if (isErr(right)) return right;
      left = { t: 'op', op, args: [left, right] };
    }
  }

  parseConcat() {
    let left = this.parseAdd();
    if (isErr(left)) return left;
    while (this.matchOp(['&'])) {
      const right = this.parseAdd();
      if (isErr(right)) return right;
      left = { t: 'op', op: '&', args: [left, right] };
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    if (isErr(left)) return left;
    for (;;) {
      const op = this.matchOp(['+', '-']);
      if (!op) return left;
      const right = this.parseMul();
      if (isErr(right)) return right;
      left = { t: 'op', op, args: [left, right] };
    }
  }

  parseMul() {
    let left = this.parsePow();
    if (isErr(left)) return left;
    for (;;) {
      const op = this.matchOp(['*', '/']);
      if (!op) return left;
      const right = this.parsePow();
      if (isErr(right)) return right;
      left = { t: 'op', op, args: [left, right] };
    }
  }

  parsePow() {
    const left = this.parseUnary();
    if (isErr(left)) return left;
    if (!this.matchOp(['^'])) return left;
    const right = this.parsePow();
    if (isErr(right)) return right;
    return { t: 'op', op: '^', args: [left, right] };
  }

  parseUnary() {
    const op = this.matchOp(['+', '-']);
    if (!op) return this.parsePercent();
    const value = this.parseUnary();
    if (isErr(value)) return value;
    return { t: 'unary', op, a: value };
  }

  parsePercent() {
    let value = this.parsePrimary();
    if (isErr(value)) return value;
    while (this.matchOp(['%'])) value = { t: 'percent', a: value };
    return value;
  }

  parsePrimary() {
    this.skip();
    const ch = this.s[this.i];
    if (!ch) return err(PARSE);
    if (ch === '(') {
      this.i += 1;
      const inner = this.parseExpr();
      if (isErr(inner)) return inner;
      if (this.peek() !== ')') return err(PARSE);
      this.i += 1;
      return inner;
    }
    if (ch === '"') return this.parseString();
    if (ch === '#') return this.parseErrorLiteral();
    if (ch === "'") {
      const sheet = this.parseQuotedSheet();
      if (isErr(sheet)) return sheet;
      if (this.peek() !== '!') return err(PARSE);
      this.i += 1;
      return this.parseArea(sheet);
    }
    if (ch >= '0' && ch <= '9' || ch === '.') {
      const row = this.tryRowRange();
      if (row) return row;
      return this.parseNumber();
    }
    if (ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch.charCodeAt(0) > 127) {
      return this.parseIdentish();
    }
    return err(PARSE);
  }

  parseString() {
    let out = '';
    this.i += 1;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === '"') {
        if (this.s[this.i + 1] === '"') {
          out += '"';
          this.i += 2;
          continue;
        }
        this.i += 1;
        return { t: 'str', v: out };
      }
      out += ch;
      this.i += 1;
    }
    return err(PARSE);
  }

  parseErrorLiteral() {
    const rest = this.s.slice(this.i).toUpperCase();
    const found = ERROR_LITERALS.find((code) => rest.startsWith(code));
    if (!found) return err(PARSE);
    this.i += found.length;
    return { t: 'err', error: found };
  }

  parseQuotedSheet() {
    this.i += 1;
    let name = '';
    while (this.i < this.s.length) {
      if (this.s[this.i] === "'") {
        if (this.s[this.i + 1] === "'") {
          name += "'";
          this.i += 2;
          continue;
        }
        this.i += 1;
        return name;
      }
      name += this.s[this.i];
      this.i += 1;
    }
    return err(PARSE);
  }

  parseNumber() {
    const m = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) return err(PARSE);
    this.i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) return err(NUM);
    return { t: 'num', v };
  }

  tryRowRange() {
    const start = this.i;
    const left = this.readRowRef();
    if (!left) {
      this.i = start;
      return null;
    }
    if (this.s[this.i] !== ':') {
      this.i = start;
      return null;
    }
    this.i += 1;
    const right = this.readRowRef();
    if (!right) return err(PARSE);
    return normalizeArea({
      t: 'area',
      sheet: null,
      wholeRow: true,
      wholeCol: false,
      c1: 0,
      c2: 0,
      r1: left.row,
      r2: right.row,
      absC1: false,
      absC2: false,
      absR1: left.abs,
      absR2: right.abs,
    });
  }

  readRowRef() {
    const m = /^(\$?)(\d+)/.exec(this.s.slice(this.i));
    if (!m) return null;
    const row = Number(m[2]) - 1;
    if (row < 0 || row > 1048575) return null;
    this.i += m[0].length;
    return { row, abs: m[1] === '$' };
  }

  parseIdentish() {
    const start = this.i;
    const area = this.tryArea(null);
    if (area && !isErr(area) && area.t === 'area') {
      this.skip();
      if (this.s[this.i] === '(') this.i = start;
      else return area;
    } else {
      this.i = start;
    }
    const name = this.readName();
    if (!name) return err(PARSE);
    this.skip();
    if (this.s[this.i] === '(') return this.parseCall(name);
    if (this.s[this.i] === '!') {
      this.i += 1;
      return this.parseArea(name);
    }
    const upper = name.toUpperCase();
    if (upper === 'TRUE') return { t: 'bool', v: true };
    if (upper === 'FALSE') return { t: 'bool', v: false };
    return { t: 'name', name };
  }

  readName() {
    if (!this.s[this.i] || !/[A-Za-z_\u0080-\uFFFF]/.test(this.s[this.i])) return '';
    const start = this.i;
    this.i += 1;
    while (isIdentChar(this.s[this.i])) this.i += 1;
    return this.s.slice(start, this.i);
  }

  tryArea(sheet) {
    const start = this.i;
    const left = this.readEndpoint();
    if (!left) {
      this.i = start;
      return null;
    }
    this.skip();
    if (this.s[this.i] === ':') {
      this.i += 1;
      const right = this.readEndpoint(true);
      if (!right) return err(PARSE);
      return combineEndpoints(sheet, left, right);
    }
    if (left.kind !== 'cell') {
      this.i = start;
      return null;
    }
    return {
      t: 'area',
      sheet,
      wholeCol: false,
      wholeRow: false,
      c1: left.col,
      c2: left.col,
      r1: left.row,
      r2: left.row,
      absC1: left.absCol,
      absC2: left.absCol,
      absR1: left.absRow,
      absR2: left.absRow,
    };
  }

  parseArea(sheet) {
    const area = this.tryArea(sheet);
    if (!area) return err(PARSE);
    return area;
  }

  readEndpoint(inRange = false) {
    this.skip();
    const start = this.i;
    if (this.s[this.i] === '$' || /[A-Za-z]/.test(this.s[this.i] || '')) {
      const abs1 = this.s[this.i] === '$';
      if (abs1) this.i += 1;
      const letters = this.readLetters();
      if (!letters) {
        this.i = start;
        return null;
      }
      const col = colToIndex(letters);
      if (col == null) {
        this.i = start;
        return null;
      }
      const after = this.i;
      const absRow = this.s[this.i] === '$';
      if (absRow) this.i += 1;
      const digits = this.readDigits();
      if (digits) {
        const row = Number(digits) - 1;
        if (row < 0 || row > 1048575) return err(PARSE);
        return { kind: 'cell', col, row, absCol: abs1, absRow };
      }
      this.i = after;
      if (this.s[this.i] === ':' || inRange) return { kind: 'col', col, absCol: abs1 };
      this.i = start;
      return null;
    }
    const row = this.readRowRef();
    if (!row) return null;
    return { kind: 'row', row: row.row, absRow: row.abs };
  }

  readLetters() {
    const start = this.i;
    while (/[A-Za-z]/.test(this.s[this.i] || '')) this.i += 1;
    return this.s.slice(start, this.i);
  }

  readDigits() {
    const start = this.i;
    while (this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i += 1;
    return this.s.slice(start, this.i);
  }

  parseCall(name) {
    this.i += 1;
    const args = [];
    this.skip();
    if (this.s[this.i] === ')') {
      this.i += 1;
      return { t: 'call', name: name.toUpperCase(), args };
    }
    for (;;) {
      const arg = this.parseExpr();
      if (isErr(arg)) return arg;
      args.push(arg);
      this.skip();
      const sep = this.s[this.i];
      if (sep === ',' || sep === ';') {
        this.i += 1;
        continue;
      }
      if (sep === ')') {
        this.i += 1;
        return { t: 'call', name: name.toUpperCase(), args };
      }
      return err(PARSE);
    }
  }

  matchOp(ops) {
    this.skip();
    const rest = this.s.slice(this.i);
    const found = ops.find((op) => rest.startsWith(op));
    if (!found) return '';
    this.i += found.length;
    return found;
  }
}

function combineEndpoints(sheet, left, right) {
  if (isErr(left) || isErr(right)) return isErr(left) ? left : right;
  if (left.kind === 'col' && right.kind === 'col') {
    return normalizeArea({
      t: 'area',
      sheet,
      wholeCol: true,
      wholeRow: false,
      c1: left.col,
      c2: right.col,
      r1: 0,
      r2: 0,
      absC1: left.absCol,
      absC2: right.absCol,
      absR1: false,
      absR2: false,
    });
  }
  if (left.kind === 'row' && right.kind === 'row') {
    return normalizeArea({
      t: 'area',
      sheet,
      wholeCol: false,
      wholeRow: true,
      c1: 0,
      c2: 0,
      r1: left.row,
      r2: right.row,
      absC1: false,
      absC2: false,
      absR1: left.absRow,
      absR2: right.absRow,
    });
  }
  if (left.kind === 'cell' && right.kind === 'cell') {
    return normalizeArea({
      t: 'area',
      sheet,
      wholeCol: false,
      wholeRow: false,
      c1: left.col,
      c2: right.col,
      r1: left.row,
      r2: right.row,
      absC1: left.absCol,
      absC2: right.absCol,
      absR1: left.absRow,
      absR2: right.absRow,
    });
  }
  return err(PARSE);
}

function normalizeArea(area) {
  const next = { ...area };
  if (!next.wholeRow && next.c1 > next.c2) {
    [next.c1, next.c2] = [next.c2, next.c1];
    [next.absC1, next.absC2] = [next.absC2, next.absC1];
  }
  if (!next.wholeCol && next.r1 > next.r2) {
    [next.r1, next.r2] = [next.r2, next.r1];
    [next.absR1, next.absR2] = [next.absR2, next.absR1];
  }
  if (next.wholeCol && next.c1 > next.c2) {
    [next.c1, next.c2] = [next.c2, next.c1];
    [next.absC1, next.absC2] = [next.absC2, next.absC1];
  }
  if (next.wholeRow && next.r1 > next.r2) {
    [next.r1, next.r2] = [next.r2, next.r1];
    [next.absR1, next.absR2] = [next.absR2, next.absR1];
  }
  return next;
}

export function parseFormula(input) {
  const source = String(input ?? '');
  const body = source.startsWith('=') ? source.slice(1) : source;
  const parser = new Parser(body);
  const ast = parser.parseExpr();
  if (isErr(ast)) return ast;
  parser.skip();
  if (parser.i < parser.s.length) return err(PARSE);
  return ast;
}

function printAst(node) {
  if (!node) return PARSE;
  if (node.t === 'err') return node.error;
  if (node.t === 'num') return String(node.v);
  if (node.t === 'str') return `"${node.v.replace(/"/g, '""')}"`;
  if (node.t === 'bool') return node.v ? 'TRUE' : 'FALSE';
  if (node.t === 'name') return node.name;
  if (node.t === 'percent') return `${printAst(node.a)}%`;
  if (node.t === 'unary') return `${node.op}${printAst(node.a)}`;
  if (node.t === 'op') return `${printAst(node.args[0])}${node.op}${printAst(node.args[1])}`;
  if (node.t === 'call') return `${node.name}(${node.args.map(printAst).join(',')})`;
  if (node.t === 'area') return printArea(node);
  return PARSE;
}

function printArea(area) {
  const sheet = area.sheet ? `${quoteSheet(area.sheet)}!` : '';
  if (area.wholeCol) {
    return `${sheet}${printCol(area.c1, area.absC1)}:${printCol(area.c2, area.absC2)}`;
  }
  if (area.wholeRow) {
    return `${sheet}${printRow(area.r1, area.absR1)}:${printRow(area.r2, area.absR2)}`;
  }
  const left = formatCell(area.c1, area.r1, area.absC1, area.absR1);
  if (area.c1 === area.c2 && area.r1 === area.r2) return sheet + left;
  return `${sheet}${left}:${formatCell(area.c2, area.r2, area.absC2, area.absR2)}`;
}

function printCol(col, abs) {
  return `${abs ? '$' : ''}${indexToCol(col)}`;
}

function printRow(row, abs) {
  return `${abs ? '$' : ''}${row + 1}`;
}

function sameArea(a, b) {
  return a.sheet === b.sheet && a.wholeCol === b.wholeCol && a.wholeRow === b.wholeRow && a.c1 === b.c1 && a.c2 === b.c2 && a.r1 === b.r1 && a.r2 === b.r2 && a.absC1 === b.absC1 && a.absC2 === b.absC2 && a.absR1 === b.absR1 && a.absR2 === b.absR2;
}

function mapAst(node, fn) {
  if (node.t === 'area') return fn(node);
  if (node.t === 'percent') {
    const a = mapAst(node.a, fn);
    return a === node.a ? node : { ...node, a };
  }
  if (node.t === 'unary') {
    const a = mapAst(node.a, fn);
    return a === node.a ? node : { ...node, a };
  }
  if (node.t === 'op' || node.t === 'call') {
    let changed = false;
    const args = node.args.map((arg) => {
      const next = mapAst(arg, fn);
      if (next !== arg) changed = true;
      return next;
    });
    return changed ? { ...node, args } : node;
  }
  return node;
}

/** mutate(area) 返回新区域、原对象（没变）或 null（#REF!）。只改指向 editedSheet 的引用。 */
export function adjustFormula(formula, homeSheet, editedSheet, mutate) {
  if (!formula.startsWith('=')) return formula;
  const ast = parseFormula(formula);
  if (isErr(ast)) return formula;
  let changed = false;
  const next = mapAst(ast, (area) => {
    const resolved = area.sheet ?? homeSheet;
    if (resolved.toLowerCase() !== editedSheet.toLowerCase()) return area;
    const mapped = mutate(area);
    if (mapped === area) return area;
    changed = true;
    if (!mapped) return { t: 'err', error: REF };
    return mapped;
  });
  if (!changed) return formula;
  return `=${printAst(next)}`;
}

export function renameInFormula(formula, from, to) {
  if (!formula.startsWith('=')) return formula;
  const ast = parseFormula(formula);
  if (isErr(ast)) return formula;
  let changed = false;
  const next = mapAst(ast, (area) => {
    if (area.sheet == null || area.sheet.toLowerCase() !== from.toLowerCase()) return area;
    changed = true;
    return { ...area, sheet: to };
  });
  if (!changed) return formula;
  return `=${printAst(next)}`;
}

function shiftIndex(index, at, count) {
  return index >= at ? index + count : index;
}

export function insertRowsInArea(area, at, count) {
  if (area.wholeCol) return area;
  const r1 = shiftIndex(area.r1, at, count);
  const r2 = shiftIndex(area.r2, at, count);
  if (r1 === area.r1 && r2 === area.r2) return area;
  return { ...area, r1, r2 };
}

export function insertColsInArea(area, at, count) {
  if (area.wholeRow) return area;
  const c1 = shiftIndex(area.c1, at, count);
  const c2 = shiftIndex(area.c2, at, count);
  if (c1 === area.c1 && c2 === area.c2) return area;
  return { ...area, c1, c2 };
}

function deleteSpan(i1, i2, at, count) {
  const end = at + count;
  if (i2 < at) return [i1, i2];
  if (i1 >= end) return [i1 - count, i2 - count];
  if (i1 >= at && i2 < end) return null;
  let n1 = i1;
  let n2 = i2;
  if (n1 >= at && n1 < end) n1 = at;
  if (n2 >= end) n2 -= count;
  else if (n2 >= at) n2 = at - 1;
  if (n1 > n2) return null;
  return [n1, n2];
}

export function deleteRowsInArea(area, at, count) {
  if (area.wholeCol) return area;
  const span = deleteSpan(area.r1, area.r2, at, count);
  if (!span) return null;
  if (span[0] === area.r1 && span[1] === area.r2) return area;
  return { ...area, r1: span[0], r2: span[1] };
}

export function deleteColsInArea(area, at, count) {
  if (area.wholeRow) return area;
  const span = deleteSpan(area.c1, area.c2, at, count);
  if (!span) return null;
  if (span[0] === area.c1 && span[1] === area.c2) return area;
  return { ...area, c1: span[0], c2: span[1] };
}

function toNum(value) {
  if (isErr(value)) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : err(NUM);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return 0;
  if (typeof value === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return err(VALUE);
}

function toStr(value) {
  if (isErr(value)) return value;
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return err(NUM);
    if (Object.is(value, -0)) return '0';
    return String(value);
  }
  return String(value);
}

function cmpNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return 0;
  if (typeof value === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function compare(a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const na = cmpNum(a);
  const nb = cmpNum(b);
  if (na != null && nb != null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na != null && typeof b === 'string') return -1;
  if (nb != null && typeof a === 'string') return 1;
  const as = String(a ?? '').toLowerCase();
  const bs = String(b ?? '').toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function evalAst(node, ctx) {
  if (isErr(node)) return node;
  if (node.t === 'num') return node.v;
  if (node.t === 'str') return node.v;
  if (node.t === 'bool') return node.v;
  if (node.t === 'err') return err(node.error);
  if (node.t === 'name') {
    const upper = node.name.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    return err(NAME);
  }
  if (node.t === 'percent') {
    const n = toNum(evalAst(node.a, ctx));
    if (isErr(n)) return n;
    return n / 100;
  }
  if (node.t === 'unary') {
    const n = toNum(evalAst(node.a, ctx));
    if (isErr(n)) return n;
    return node.op === '-' ? -n : n;
  }
  if (node.t === 'area') {
    if (!node.wholeCol && !node.wholeRow && node.c1 === node.c2 && node.r1 === node.r2) {
      return ctx.at(node.sheet, node.r1, node.c1);
    }
    return err(VALUE);
  }
  if (node.t === 'op') return evalOp(node, ctx);
  if (node.t === 'call') return evalCall(node, ctx);
  return err(PARSE);
}

function evalOp(node, ctx) {
  if (node.op === '&') {
    const a = toStr(evalAst(node.args[0], ctx));
    if (isErr(a)) return a;
    const b = toStr(evalAst(node.args[1], ctx));
    if (isErr(b)) return b;
    return a + b;
  }
  const a = evalAst(node.args[0], ctx);
  const b = evalAst(node.args[1], ctx);
  if ('=<>'.includes(node.op[0]) || node.op === '<=') {
    const order = compare(a, b);
    if (isErr(order)) return order;
    if (node.op === '=') return order === 0;
    if (node.op === '<>') return order !== 0;
    if (node.op === '<') return order < 0;
    if (node.op === '>') return order > 0;
    if (node.op === '<=') return order <= 0;
    if (node.op === '>=') return order >= 0;
  }
  const na = toNum(a);
  if (isErr(na)) return na;
  const nb = toNum(b);
  if (isErr(nb)) return nb;
  if (node.op === '+') return na + nb;
  if (node.op === '-') return na - nb;
  if (node.op === '*') return na * nb;
  if (node.op === '/') {
    if (nb === 0) return err(DIV0);
    return na / nb;
  }
  if (node.op === '^') {
    if (na === 0 && nb === 0) return err(NUM);
    if (na < 0 && !Number.isInteger(nb)) return err(NUM);
    const out = na ** nb;
    if (!Number.isFinite(out)) return err(NUM);
    return out;
  }
  return err(PARSE);
}

function valuesOfArea(area, ctx) {
  return ctx.area(area);
}

function eachScalar(node, ctx, visit) {
  if (node.t === 'area') {
    const values = valuesOfArea(node, ctx);
    if (isErr(values)) return values;
    for (const value of values) {
      const stop = visit(value, true);
      if (stop) return stop;
    }
    return null;
  }
  const value = evalAst(node, ctx);
  return visit(value, false) || null;
}

function collectNumbers(args, ctx) {
  let sum = 0;
  let count = 0;
  for (const arg of args) {
    const stop = eachScalar(arg, ctx, (value, fromRange) => {
      if (isErr(value)) return value;
      if (typeof value === 'number') {
        sum += value;
        count += 1;
        return null;
      }
      if (!fromRange && typeof value === 'boolean') {
        sum += value ? 1 : 0;
        count += 1;
        return null;
      }
      if (!fromRange && value != null && value !== '') return err(VALUE);
      return null;
    });
    if (isErr(stop)) return stop;
  }
  return { sum, count };
}

function roundHalfAway(n, digits) {
  const p = 10 ** digits;
  const x = n * p;
  const sign = x < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(x))) / p;
}

function asText(value) {
  const text = toStr(value);
  return text;
}

function wildcard(text, pattern) {
  let src = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '~' && '*?~'.includes(pattern[i + 1] || '')) {
      src += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    } else if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${src}$`, 'i').test(text);
}

function parseCriteria(value) {
  if (isErr(value)) return value;
  if (typeof value === 'string') {
    const m = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(value);
    if (m) {
      return { op: m[1], rhs: coerceCriteria(m[2]) };
    }
    if (value.includes('*') || value.includes('?')) return { op: 'wild', rhs: value };
  }
  return { op: '=', rhs: value };
}

function coerceCriteria(text) {
  const trimmed = text.trim();
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  return text;
}

function matchesCriteria(value, criteria) {
  const spec = parseCriteria(criteria);
  if (isErr(spec)) return spec;
  if (isErr(value)) return false;
  if (spec.op === 'wild') return wildcard(value == null ? '' : String(value), spec.rhs);
  const empty = value == null || value === '';
  if ((spec.op === '=' || spec.op === 'wild') && (spec.rhs === '' || spec.rhs == null)) return empty;
  if (spec.op === '=' && spec.rhs === '') return empty;
  if (empty) return spec.op === '<>';
  if (typeof spec.rhs === 'number' || typeof spec.rhs === 'boolean') {
    const rhs = typeof spec.rhs === 'boolean' ? (spec.rhs ? 1 : 0) : spec.rhs;
    let n = null;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'boolean') n = value ? 1 : 0;
    else if (typeof value === 'string' && cmpNum(value) != null && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) n = cmpNum(value);
    if (n == null) return spec.op === '<>';
    if (spec.op === '=') return n === rhs;
    if (spec.op === '<>') return n !== rhs;
    if (spec.op === '<') return n < rhs;
    if (spec.op === '>') return n > rhs;
    if (spec.op === '<=') return n <= rhs;
    if (spec.op === '>=') return n >= rhs;
  }
  const order = compare(value, spec.rhs);
  if (isErr(order)) return order;
  if (spec.op === '=') return order === 0;
  if (spec.op === '<>') return order !== 0;
  if (spec.op === '<') return order < 0;
  if (spec.op === '>') return order > 0;
  if (spec.op === '<=') return order <= 0;
  if (spec.op === '>=') return order >= 0;
  return false;
}

function truthy(value) {
  if (isErr(value)) return value;
  if (value == null || value === '' || value === false || value === 0) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  return err(VALUE);
}

const FUNCS = {
  SUM(args, ctx) {
    if (!args.length) return err(VALUE);
    const got = collectNumbers(args, ctx);
    if (isErr(got)) return got;
    return got.sum;
  },
  AVERAGE(args, ctx) {
    if (!args.length) return err(VALUE);
    const got = collectNumbers(args, ctx);
    if (isErr(got)) return got;
    if (!got.count) return err(DIV0);
    return got.sum / got.count;
  },
  MIN(args, ctx) {
    return extreme(args, ctx, Math.min);
  },
  MAX(args, ctx) {
    return extreme(args, ctx, Math.max);
  },
  COUNT(args, ctx) {
    let count = 0;
    for (const arg of args) {
      const stop = eachScalar(arg, ctx, (value) => {
        if (!isErr(value) && typeof value === 'number') count += 1;
        return null;
      });
      if (isErr(stop)) return stop;
    }
    return count;
  },
  COUNTA(args, ctx) {
    let count = 0;
    for (const arg of args) {
      const stop = eachScalar(arg, ctx, (value) => {
        if (isErr(value) || (value != null && value !== '')) count += 1;
        return null;
      });
      if (isErr(stop)) return stop;
    }
    return count;
  },
  COUNTIF(args, ctx) {
    if (args.length !== 2 || args[0].t !== 'area') return err(VALUE);
    const criteria = evalAst(args[1], ctx);
    if (isErr(criteria)) return criteria;
    const values = ctx.area(args[0]);
    if (isErr(values)) return values;
    let count = 0;
    for (const value of values) {
      if (isErr(value)) continue;
      const ok = matchesCriteria(value, criteria);
      if (isErr(ok)) return ok;
      if (ok) count += 1;
    }
    return count;
  },
  SUMIF(args, ctx) {
    if ((args.length !== 2 && args.length !== 3) || args[0].t !== 'area') return err(VALUE);
    if (args.length === 3 && args[2].t !== 'area') return err(VALUE);
    const criteria = evalAst(args[1], ctx);
    if (isErr(criteria)) return criteria;
    const box = ctx.bounds(args[0]);
    if (isErr(box)) return box;
    const sumBox = args.length === 3 ? ctx.bounds(args[2]) : box;
    if (isErr(sumBox)) return sumBox;
    if (box.r2 < box.r1 || box.c2 < box.c1) return 0;
    let total = 0;
    for (let r = box.r1; r <= box.r2; r += 1) {
      for (let c = box.c1; c <= box.c2; c += 1) {
        const value = ctx.at(box.sheet, r, c);
        if (isErr(value)) continue;
        const ok = matchesCriteria(value, criteria);
        if (isErr(ok)) return ok;
        if (!ok) continue;
        const sr = sumBox.r1 + (r - box.r1);
        const sc = sumBox.c1 + (c - box.c1);
        const add = args.length === 3 ? ctx.at(sumBox.sheet, sr, sc) : value;
        if (typeof add === 'number') total += add;
      }
    }
    return total;
  },
  IF(args, ctx) {
    if (args.length < 2 || args.length > 3) return err(VALUE);
    const cond = truthy(evalAst(args[0], ctx));
    if (isErr(cond)) return cond;
    if (cond) return evalAst(args[1], ctx);
    if (args.length === 2) return false;
    return evalAst(args[2], ctx);
  },
  IFERROR(args, ctx) {
    if (args.length !== 2) return err(VALUE);
    const value = evalAst(args[0], ctx);
    if (isErr(value)) return evalAst(args[1], ctx);
    return value;
  },
  AND(args, ctx) {
    return logic(args, ctx, true);
  },
  OR(args, ctx) {
    return logic(args, ctx, false);
  },
  NOT(args, ctx) {
    if (args.length !== 1) return err(VALUE);
    const value = truthy(evalAst(args[0], ctx));
    if (isErr(value)) return value;
    return !value;
  },
  ROUND(args, ctx) {
    if (args.length < 1 || args.length > 2) return err(VALUE);
    const n = toNum(evalAst(args[0], ctx));
    if (isErr(n)) return n;
    const d = args.length === 2 ? toNum(evalAst(args[1], ctx)) : 0;
    if (isErr(d)) return d;
    const digits = Math.trunc(d);
    if (Math.abs(digits) > 10) return err(NUM);
    return roundHalfAway(n, digits);
  },
  ABS(args, ctx) {
    const n = oneNum(args, ctx);
    return isErr(n) ? n : Math.abs(n);
  },
  INT(args, ctx) {
    const n = oneNum(args, ctx);
    return isErr(n) ? n : Math.floor(n);
  },
  SQRT(args, ctx) {
    const n = oneNum(args, ctx);
    if (isErr(n)) return n;
    if (n < 0) return err(NUM);
    return Math.sqrt(n);
  },
  POWER(args, ctx) {
    if (args.length !== 2) return err(VALUE);
    return evalOp({ t: 'op', op: '^', args }, ctx);
  },
  MOD(args, ctx) {
    if (args.length !== 2) return err(VALUE);
    const n = toNum(evalAst(args[0], ctx));
    if (isErr(n)) return n;
    const d = toNum(evalAst(args[1], ctx));
    if (isErr(d)) return d;
    if (d === 0) return err(DIV0);
    return n - d * Math.floor(n / d);
  },
  CONCAT(args, ctx) {
    return concat(args, ctx);
  },
  CONCATENATE(args, ctx) {
    return concat(args, ctx);
  },
  LEFT(args, ctx) {
    return side(args, ctx, 'left');
  },
  RIGHT(args, ctx) {
    return side(args, ctx, 'right');
  },
  MID(args, ctx) {
    if (args.length !== 3) return err(VALUE);
    const text = asText(evalAst(args[0], ctx));
    if (isErr(text)) return text;
    const start = toNum(evalAst(args[1], ctx));
    if (isErr(start)) return start;
    const len = toNum(evalAst(args[2], ctx));
    if (isErr(len)) return len;
    if (start < 1 || len < 0) return err(VALUE);
    return [...text].slice(start - 1, start - 1 + Math.trunc(len)).join('');
  },
  LEN(args, ctx) {
    if (args.length !== 1) return err(VALUE);
    const text = asText(evalAst(args[0], ctx));
    if (isErr(text)) return text;
    return [...text].length;
  },
  UPPER(args, ctx) {
    return mapText(args, ctx, (text) => text.toUpperCase());
  },
  LOWER(args, ctx) {
    return mapText(args, ctx, (text) => text.toLowerCase());
  },
  TRIM(args, ctx) {
    return mapText(args, ctx, (text) => text.trim().replace(/ {2,}/g, ' '));
  },
};

function extreme(args, ctx, pick) {
  if (!args.length) return err(VALUE);
  let best = null;
  for (const arg of args) {
    const stop = eachScalar(arg, ctx, (value, fromRange) => {
      if (isErr(value)) return value;
      let n = null;
      if (typeof value === 'number') n = value;
      else if (!fromRange) {
        const coerced = toNum(value);
        if (isErr(coerced)) return coerced;
        if (value != null && value !== '') n = coerced;
      }
      if (n != null) best = best == null ? n : pick(best, n);
      return null;
    });
    if (isErr(stop)) return stop;
  }
  return best == null ? 0 : best;
}

function logic(args, ctx, and) {
  if (!args.length) return err(VALUE);
  let seen = false;
  let result = and;
  for (const arg of args) {
    const stop = eachScalar(arg, ctx, (value, fromRange) => {
      if (isErr(value)) return value;
      if (fromRange && (value == null || value === '')) return null;
      const flag = truthy(value);
      if (isErr(flag)) return flag;
      seen = true;
      result = and ? result && flag : result || flag;
      return null;
    });
    if (isErr(stop)) return stop;
  }
  if (!seen) return err(VALUE);
  return result;
}

function concat(args, ctx) {
  let out = '';
  for (const arg of args) {
    const stop = eachScalar(arg, ctx, (value) => {
      if (isErr(value)) return value;
      if (value == null) return null;
      const text = toStr(value);
      if (isErr(text)) return text;
      out += text;
      return null;
    });
    if (isErr(stop)) return stop;
  }
  return out;
}

function side(args, ctx, dir) {
  if (args.length < 1 || args.length > 2) return err(VALUE);
  const text = asText(evalAst(args[0], ctx));
  if (isErr(text)) return text;
  const n = args.length === 2 ? toNum(evalAst(args[1], ctx)) : 1;
  if (isErr(n)) return n;
  if (n < 0) return err(VALUE);
  const chars = [...text];
  const count = Math.trunc(n);
  return dir === 'left' ? chars.slice(0, count).join('') : chars.slice(chars.length - count).join('');
}

function mapText(args, ctx, fn) {
  if (args.length !== 1) return err(VALUE);
  const text = asText(evalAst(args[0], ctx));
  if (isErr(text)) return text;
  return fn(text);
}

function oneNum(args, ctx) {
  if (args.length !== 1) return err(VALUE);
  return toNum(evalAst(args[0], ctx));
}

function evalCall(node, ctx) {
  const fn = FUNCS[node.name];
  if (!fn) return err(NAME);
  if (node.name === 'IF' || node.name === 'IFERROR') return fn(node.args, ctx);
  return fn(node.args, ctx);
}

export function evaluateFormula(formula, ctx) {
  const ast = parseFormula(formula);
  if (isErr(ast)) return ast;
  return evalAst(ast, ctx);
}

export { sameArea };
