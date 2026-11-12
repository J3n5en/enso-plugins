var EnsoSpreadsheet = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/enso.spreadsheet/src/view.mjs
  var view_exports = {};
  __export(view_exports, {
    mount: () => mount
  });

  // packages/enso.spreadsheet/src/csv.mjs
  function parseDelimited(text, delimiter) {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (!source) return [];
    const rows = [];
    let row = [];
    let cur = "";
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
        cur = "";
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[i + 1] === "\n") i += 1;
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
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
  function stringifyDelimited(matrix, delimiter) {
    return matrix.map((row) => row.map((field) => escapeField(String(field ?? ""), delimiter)).join(delimiter)).join("\n");
  }
  function escapeField(value, delimiter) {
    if (value.includes('"') || value.includes("\n") || value.includes("\r") || value.includes(delimiter)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
  function detectDelimiter(text) {
    const line = String(text ?? "").split(/\r?\n/, 1)[0] ?? "";
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
    const tabs = score("	");
    const commas = score(",");
    const semis = score(";");
    if (tabs > commas && tabs >= semis) return "	";
    if (semis > commas) return ";";
    return ",";
  }
  function matrixFromSheet(sheet) {
    let maxR = -1;
    let maxC = -1;
    for (const key of Object.keys(sheet.cells)) {
      if (!sheet.cells[key]) continue;
      const [r, c] = key.split(",").map(Number);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR < 0) return [];
    const matrix = [];
    for (let r = 0; r <= maxR; r += 1) {
      const row = [];
      for (let c = 0; c <= maxC; c += 1) row.push(sheet.cells[`${r},${c}`] ?? "");
      matrix.push(row);
    }
    return matrix;
  }
  function cellsFromMatrix(matrix) {
    const cells = {};
    matrix.forEach((row, r) => {
      row.forEach((value, c) => {
        if (value !== "") cells[`${r},${c}`] = value;
      });
    });
    return cells;
  }

  // packages/enso.spreadsheet/src/refs.mjs
  var MAX_COL = 256;
  var MAX_ROW = 1e5;
  function indexToCol(index) {
    let n = index + 1;
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function colToIndex(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
      if (ch < "A" || ch > "Z") return null;
      n = n * 26 + (ch.charCodeAt(0) - 64);
      if (n > 16384) return null;
    }
    return n - 1;
  }
  function formatCell(col, row, absCol = false, absRow = false) {
    return `${absCol ? "$" : ""}${indexToCol(col)}${absRow ? "$" : ""}${row + 1}`;
  }
  function formatAddress(col, row) {
    return formatCell(col, row);
  }
  function parseAddress(text) {
    const raw = String(text ?? "").trim();
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
  function splitSheet(text) {
    if (text.startsWith("'")) {
      let i = 1;
      let name = "";
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
      if (text[i] !== "'" || text[i + 1] !== "!") return null;
      return { sheet: name, body: text.slice(i + 2), end: i + 2 };
    }
    const m = /^([^'!]+)!(.*)$/s.exec(text);
    if (!m) return null;
    return { sheet: m[1], body: m[2], end: m[1].length + 1 };
  }
  function quoteSheet(name) {
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
      absCol: m[1] === "$",
      absRow: m[3] === "$"
    };
  }

  // packages/enso.spreadsheet/src/document.mjs
  function kindOf(rel) {
    const name = String(rel || "").split(/[/\\]/).pop().toLowerCase();
    if (name.endsWith(".tsv")) return "tsv";
    if (name.endsWith(".csv")) return "csv";
    if (name.endsWith(".xlsx")) return "xlsx";
    if (name.endsWith(".ods")) return "ods";
    return "sheet";
  }
  function allowsManySheets(kind) {
    return kind !== "csv" && kind !== "tsv";
  }
  function blankBook() {
    return { sheets: [{ name: "\u5DE5\u4F5C\u88681", hidden: false, cells: {} }] };
  }
  function cleanName(name, index) {
    const text = String(name ?? "").replace(/[\\/?*[\]:]/g, "").trim().slice(0, 31);
    return text || `\u5DE5\u4F5C\u8868${index + 1}`;
  }
  function uniqueNames(sheets) {
    const used = /* @__PURE__ */ new Set();
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
    if (!input || typeof input !== "object" || Array.isArray(input)) return cells;
    for (const [addr, value] of Object.entries(input)) {
      const ref = parseAddress(addr);
      if (!ref || ref.sheet) continue;
      const text = value == null ? "" : String(value).replace(/\u0000/g, "");
      if (text) cells[`${ref.row},${ref.col}`] = text;
    }
    return cells;
  }
  function bookFromJson(json) {
    const sheets = uniqueNames(
      json.sheets.map((sheet, index) => ({
        name: cleanName(sheet?.name, index),
        hidden: sheet?.hidden === true,
        cells: cellsFromA1(sheet?.cells)
      }))
    );
    if (!sheets.length) return blankBook();
    if (sheets.every((sheet) => sheet.hidden)) sheets[0].hidden = false;
    return { sheets };
  }
  function bookFromDelimited(text, delimiter) {
    const matrix = parseDelimited(text, delimiter);
    if (!matrix.length) return blankBook();
    return { sheets: [{ name: "\u5DE5\u4F5C\u88681", hidden: false, cells: cellsFromMatrix(matrix) }] };
  }
  function parseDocument(text, rel) {
    const kind = kindOf(rel);
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (source.includes("\0")) {
      return {
        book: blankBook(),
        kind,
        error: "Enso \u7684\u6587\u4EF6\u67E5\u770B\u5668\u53EA\u63A5\u6536\u6587\u672C\uFF0C\u6253\u4E0D\u5F00\u542B\u7A7A\u5B57\u8282\u7684\u4E8C\u8FDB\u5236\u5DE5\u4F5C\u7C3F\u3002\u8BF7\u53E6\u5B58\u4E3A CSV \u540E\u518D\u6253\u5F00\u3002"
      };
    }
    if (!source.trim()) return { book: blankBook(), kind, error: "" };
    if (kind === "csv" || kind === "tsv") {
      const delimiter = kind === "tsv" ? "	" : detectDelimiter(source);
      return { book: bookFromDelimited(source, delimiter), kind, error: "" };
    }
    const trimmed = source.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const json = JSON.parse(source);
        if (json && json["enso.spreadsheet"] === 1 && Array.isArray(json.sheets)) {
          return { book: bookFromJson(json), kind, error: "" };
        }
      } catch {
      }
    }
    if (/[,;\t]/.test(source) || source.includes("\n")) {
      return { book: bookFromDelimited(source, detectDelimiter(source)), kind, error: "" };
    }
    return { book: bookFromDelimited(source, ","), kind, error: "" };
  }
  function a1Cells(cells) {
    const entries = Object.entries(cells).filter(([, value]) => value);
    entries.sort((a, b) => {
      const [ar, ac] = a[0].split(",").map(Number);
      const [br, bc] = b[0].split(",").map(Number);
      return ar - br || ac - bc;
    });
    const out = {};
    for (const [key, value] of entries) {
      const [r, c] = key.split(",").map(Number);
      out[formatAddress(c, r)] = value;
    }
    return out;
  }
  function serializeDocument(book, rel) {
    const kind = kindOf(rel);
    if (kind === "csv" || kind === "tsv") {
      const sheet = book.sheets.find((item) => !item.hidden) ?? book.sheets[0];
      return stringifyDelimited(matrixFromSheet(sheet), kind === "tsv" ? "	" : ",");
    }
    const payload = {
      "enso.spreadsheet": 1,
      sheets: book.sheets.map((sheet) => {
        const item = { name: sheet.name, cells: a1Cells(sheet.cells) };
        if (sheet.hidden) item.hidden = true;
        return item;
      })
    };
    return JSON.stringify(payload, null, 2);
  }

  // packages/enso.spreadsheet/src/formula.mjs
  var DIV0 = "#DIV/0!";
  var VALUE = "#VALUE!";
  var REF = "#REF!";
  var NAME = "#NAME?";
  var NA = "#N/A";
  var NUM = "#NUM!";
  var CYCLE = "#CYCLE!";
  var PARSE = "#ERROR!";
  var ERROR_LITERALS = [DIV0, VALUE, REF, NAME, NA, NUM, CYCLE, PARSE, "#NULL!"];
  function err(code) {
    return { error: code };
  }
  function isErr(value) {
    return !!value && typeof value === "object" && typeof value.error === "string";
  }
  function formatNumber(n) {
    if (!Number.isFinite(n)) return NUM;
    if (Object.is(n, -0)) n = 0;
    const tidy = Number(n.toPrecision(12));
    n = Object.is(tidy, -0) ? 0 : tidy;
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e12 || abs < 1e-9)) {
      return n.toExponential(6).replace(/\.?0+(?=e)/, "");
    }
    const negative = n < 0;
    const [i, d] = Math.abs(n).toString().split(".");
    const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}${grouped}${d ? `.${d}` : ""}`;
  }
  function displayOf(value) {
    if (value == null || value === "") return { text: "", align: "left" };
    if (isErr(value)) return { text: value.error, align: "center", error: true };
    if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", align: "center" };
    if (typeof value === "number") {
      const text = formatNumber(value);
      if (text === NUM) return { text, align: "center", error: true };
      return { text, align: "right" };
    }
    return { text: String(value), align: "left" };
  }
  function isIdentChar(ch) {
    return !!ch && /[A-Za-z0-9_\u0080-\uFFFF]/.test(ch);
  }
  var Parser = class {
    constructor(source) {
      this.s = source;
      this.i = 0;
    }
    skip() {
      while (this.s[this.i] === " " || this.s[this.i] === "	" || this.s[this.i] === "\n" || this.s[this.i] === "\r") {
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
      for (; ; ) {
        const op = this.matchOp(["<=", ">=", "<>", "=", "<", ">"]);
        if (!op) return left;
        const right = this.parseConcat();
        if (isErr(right)) return right;
        left = { t: "op", op, args: [left, right] };
      }
    }
    parseConcat() {
      let left = this.parseAdd();
      if (isErr(left)) return left;
      while (this.matchOp(["&"])) {
        const right = this.parseAdd();
        if (isErr(right)) return right;
        left = { t: "op", op: "&", args: [left, right] };
      }
      return left;
    }
    parseAdd() {
      let left = this.parseMul();
      if (isErr(left)) return left;
      for (; ; ) {
        const op = this.matchOp(["+", "-"]);
        if (!op) return left;
        const right = this.parseMul();
        if (isErr(right)) return right;
        left = { t: "op", op, args: [left, right] };
      }
    }
    parseMul() {
      let left = this.parsePow();
      if (isErr(left)) return left;
      for (; ; ) {
        const op = this.matchOp(["*", "/"]);
        if (!op) return left;
        const right = this.parsePow();
        if (isErr(right)) return right;
        left = { t: "op", op, args: [left, right] };
      }
    }
    parsePow() {
      const left = this.parseUnary();
      if (isErr(left)) return left;
      if (!this.matchOp(["^"])) return left;
      const right = this.parsePow();
      if (isErr(right)) return right;
      return { t: "op", op: "^", args: [left, right] };
    }
    parseUnary() {
      const op = this.matchOp(["+", "-"]);
      if (!op) return this.parsePercent();
      const value = this.parseUnary();
      if (isErr(value)) return value;
      return { t: "unary", op, a: value };
    }
    parsePercent() {
      let value = this.parsePrimary();
      if (isErr(value)) return value;
      while (this.matchOp(["%"])) value = { t: "percent", a: value };
      return value;
    }
    parsePrimary() {
      this.skip();
      const ch = this.s[this.i];
      if (!ch) return err(PARSE);
      if (ch === "(") {
        this.i += 1;
        const inner = this.parseExpr();
        if (isErr(inner)) return inner;
        if (this.peek() !== ")") return err(PARSE);
        this.i += 1;
        return inner;
      }
      if (ch === '"') return this.parseString();
      if (ch === "#") return this.parseErrorLiteral();
      if (ch === "'") {
        const sheet = this.parseQuotedSheet();
        if (isErr(sheet)) return sheet;
        if (this.peek() !== "!") return err(PARSE);
        this.i += 1;
        return this.parseArea(sheet);
      }
      if (ch >= "0" && ch <= "9" || ch === ".") {
        const row = this.tryRowRange();
        if (row) return row;
        return this.parseNumber();
      }
      if (ch === "$" || ch >= "A" && ch <= "Z" || ch >= "a" && ch <= "z" || ch.charCodeAt(0) > 127) {
        return this.parseIdentish();
      }
      return err(PARSE);
    }
    parseString() {
      let out = "";
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
          return { t: "str", v: out };
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
      return { t: "err", error: found };
    }
    parseQuotedSheet() {
      this.i += 1;
      let name = "";
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
      return { t: "num", v };
    }
    tryRowRange() {
      const start = this.i;
      const left = this.readRowRef();
      if (!left) {
        this.i = start;
        return null;
      }
      if (this.s[this.i] !== ":") {
        this.i = start;
        return null;
      }
      this.i += 1;
      const right = this.readRowRef();
      if (!right) return err(PARSE);
      return normalizeArea({
        t: "area",
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
        absR2: right.abs
      });
    }
    readRowRef() {
      const m = /^(\$?)(\d+)/.exec(this.s.slice(this.i));
      if (!m) return null;
      const row = Number(m[2]) - 1;
      if (row < 0 || row > 1048575) return null;
      this.i += m[0].length;
      return { row, abs: m[1] === "$" };
    }
    parseIdentish() {
      const start = this.i;
      const area = this.tryArea(null);
      if (area && !isErr(area) && area.t === "area") {
        this.skip();
        if (this.s[this.i] === "(") this.i = start;
        else return area;
      } else {
        this.i = start;
      }
      const name = this.readName();
      if (!name) return err(PARSE);
      this.skip();
      if (this.s[this.i] === "(") return this.parseCall(name);
      if (this.s[this.i] === "!") {
        this.i += 1;
        return this.parseArea(name);
      }
      const upper = name.toUpperCase();
      if (upper === "TRUE") return { t: "bool", v: true };
      if (upper === "FALSE") return { t: "bool", v: false };
      return { t: "name", name };
    }
    readName() {
      if (!this.s[this.i] || !/[A-Za-z_\u0080-\uFFFF]/.test(this.s[this.i])) return "";
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
      if (this.s[this.i] === ":") {
        this.i += 1;
        const right = this.readEndpoint(true);
        if (!right) return err(PARSE);
        return combineEndpoints(sheet, left, right);
      }
      if (left.kind !== "cell") {
        this.i = start;
        return null;
      }
      return {
        t: "area",
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
        absR2: left.absRow
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
      if (this.s[this.i] === "$" || /[A-Za-z]/.test(this.s[this.i] || "")) {
        const abs1 = this.s[this.i] === "$";
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
        const absRow = this.s[this.i] === "$";
        if (absRow) this.i += 1;
        const digits = this.readDigits();
        if (digits) {
          const row2 = Number(digits) - 1;
          if (row2 < 0 || row2 > 1048575) return err(PARSE);
          return { kind: "cell", col, row: row2, absCol: abs1, absRow };
        }
        this.i = after;
        if (this.s[this.i] === ":" || inRange) return { kind: "col", col, absCol: abs1 };
        this.i = start;
        return null;
      }
      const row = this.readRowRef();
      if (!row) return null;
      return { kind: "row", row: row.row, absRow: row.abs };
    }
    readLetters() {
      const start = this.i;
      while (/[A-Za-z]/.test(this.s[this.i] || "")) this.i += 1;
      return this.s.slice(start, this.i);
    }
    readDigits() {
      const start = this.i;
      while (this.s[this.i] >= "0" && this.s[this.i] <= "9") this.i += 1;
      return this.s.slice(start, this.i);
    }
    parseCall(name) {
      this.i += 1;
      const args = [];
      this.skip();
      if (this.s[this.i] === ")") {
        this.i += 1;
        return { t: "call", name: name.toUpperCase(), args };
      }
      for (; ; ) {
        const arg = this.parseExpr();
        if (isErr(arg)) return arg;
        args.push(arg);
        this.skip();
        const sep = this.s[this.i];
        if (sep === "," || sep === ";") {
          this.i += 1;
          continue;
        }
        if (sep === ")") {
          this.i += 1;
          return { t: "call", name: name.toUpperCase(), args };
        }
        return err(PARSE);
      }
    }
    matchOp(ops) {
      this.skip();
      const rest = this.s.slice(this.i);
      const found = ops.find((op) => rest.startsWith(op));
      if (!found) return "";
      this.i += found.length;
      return found;
    }
  };
  function combineEndpoints(sheet, left, right) {
    if (isErr(left) || isErr(right)) return isErr(left) ? left : right;
    if (left.kind === "col" && right.kind === "col") {
      return normalizeArea({
        t: "area",
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
        absR2: false
      });
    }
    if (left.kind === "row" && right.kind === "row") {
      return normalizeArea({
        t: "area",
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
        absR2: right.absRow
      });
    }
    if (left.kind === "cell" && right.kind === "cell") {
      return normalizeArea({
        t: "area",
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
        absR2: right.absRow
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
  function parseFormula(input) {
    const source = String(input ?? "");
    const body = source.startsWith("=") ? source.slice(1) : source;
    const parser = new Parser(body);
    const ast = parser.parseExpr();
    if (isErr(ast)) return ast;
    parser.skip();
    if (parser.i < parser.s.length) return err(PARSE);
    return ast;
  }
  function printAst(node) {
    if (!node) return PARSE;
    if (node.t === "err") return node.error;
    if (node.t === "num") return String(node.v);
    if (node.t === "str") return `"${node.v.replace(/"/g, '""')}"`;
    if (node.t === "bool") return node.v ? "TRUE" : "FALSE";
    if (node.t === "name") return node.name;
    if (node.t === "percent") return `${printAst(node.a)}%`;
    if (node.t === "unary") return `${node.op}${printAst(node.a)}`;
    if (node.t === "op") return `${printAst(node.args[0])}${node.op}${printAst(node.args[1])}`;
    if (node.t === "call") return `${node.name}(${node.args.map(printAst).join(",")})`;
    if (node.t === "area") return printArea(node);
    return PARSE;
  }
  function printArea(area) {
    const sheet = area.sheet ? `${quoteSheet(area.sheet)}!` : "";
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
    return `${abs ? "$" : ""}${indexToCol(col)}`;
  }
  function printRow(row, abs) {
    return `${abs ? "$" : ""}${row + 1}`;
  }
  function mapAst(node, fn) {
    if (node.t === "area") return fn(node);
    if (node.t === "percent") {
      const a = mapAst(node.a, fn);
      return a === node.a ? node : { ...node, a };
    }
    if (node.t === "unary") {
      const a = mapAst(node.a, fn);
      return a === node.a ? node : { ...node, a };
    }
    if (node.t === "op" || node.t === "call") {
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
  function adjustFormula(formula, homeSheet, editedSheet, mutate) {
    if (!formula.startsWith("=")) return formula;
    const ast = parseFormula(formula);
    if (isErr(ast)) return formula;
    let changed = false;
    const next = mapAst(ast, (area) => {
      const resolved = area.sheet ?? homeSheet;
      if (resolved.toLowerCase() !== editedSheet.toLowerCase()) return area;
      const mapped = mutate(area);
      if (mapped === area) return area;
      changed = true;
      if (!mapped) return { t: "err", error: REF };
      return mapped;
    });
    if (!changed) return formula;
    return `=${printAst(next)}`;
  }
  function renameInFormula(formula, from, to) {
    if (!formula.startsWith("=")) return formula;
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
  function insertRowsInArea(area, at, count) {
    if (area.wholeCol) return area;
    const r1 = shiftIndex(area.r1, at, count);
    const r2 = shiftIndex(area.r2, at, count);
    if (r1 === area.r1 && r2 === area.r2) return area;
    return { ...area, r1, r2 };
  }
  function insertColsInArea(area, at, count) {
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
  function deleteRowsInArea(area, at, count) {
    if (area.wholeCol) return area;
    const span = deleteSpan(area.r1, area.r2, at, count);
    if (!span) return null;
    if (span[0] === area.r1 && span[1] === area.r2) return area;
    return { ...area, r1: span[0], r2: span[1] };
  }
  function deleteColsInArea(area, at, count) {
    if (area.wholeRow) return area;
    const span = deleteSpan(area.c1, area.c2, at, count);
    if (!span) return null;
    if (span[0] === area.c1 && span[1] === area.c2) return area;
    return { ...area, c1: span[0], c2: span[1] };
  }
  function toNum(value) {
    if (isErr(value)) return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : err(NUM);
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value == null || value === "") return 0;
    if (typeof value === "string" && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
      return Number(value.trim());
    }
    return err(VALUE);
  }
  function toStr(value) {
    if (isErr(value)) return value;
    if (value == null) return "";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return err(NUM);
      if (Object.is(value, -0)) return "0";
      return String(value);
    }
    return String(value);
  }
  function cmpNum(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value == null || value === "") return 0;
    if (typeof value === "string" && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
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
    if (na != null && typeof b === "string") return -1;
    if (nb != null && typeof a === "string") return 1;
    const as = String(a ?? "").toLowerCase();
    const bs = String(b ?? "").toLowerCase();
    return as < bs ? -1 : as > bs ? 1 : 0;
  }
  function evalAst(node, ctx) {
    if (isErr(node)) return node;
    if (node.t === "num") return node.v;
    if (node.t === "str") return node.v;
    if (node.t === "bool") return node.v;
    if (node.t === "err") return err(node.error);
    if (node.t === "name") {
      const upper = node.name.toUpperCase();
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      return err(NAME);
    }
    if (node.t === "percent") {
      const n = toNum(evalAst(node.a, ctx));
      if (isErr(n)) return n;
      return n / 100;
    }
    if (node.t === "unary") {
      const n = toNum(evalAst(node.a, ctx));
      if (isErr(n)) return n;
      return node.op === "-" ? -n : n;
    }
    if (node.t === "area") {
      if (!node.wholeCol && !node.wholeRow && node.c1 === node.c2 && node.r1 === node.r2) {
        return ctx.at(node.sheet, node.r1, node.c1);
      }
      return err(VALUE);
    }
    if (node.t === "op") return evalOp(node, ctx);
    if (node.t === "call") return evalCall(node, ctx);
    return err(PARSE);
  }
  function evalOp(node, ctx) {
    if (node.op === "&") {
      const a2 = toStr(evalAst(node.args[0], ctx));
      if (isErr(a2)) return a2;
      const b2 = toStr(evalAst(node.args[1], ctx));
      if (isErr(b2)) return b2;
      return a2 + b2;
    }
    const a = evalAst(node.args[0], ctx);
    const b = evalAst(node.args[1], ctx);
    if ("=<>".includes(node.op[0]) || node.op === "<=") {
      const order = compare(a, b);
      if (isErr(order)) return order;
      if (node.op === "=") return order === 0;
      if (node.op === "<>") return order !== 0;
      if (node.op === "<") return order < 0;
      if (node.op === ">") return order > 0;
      if (node.op === "<=") return order <= 0;
      if (node.op === ">=") return order >= 0;
    }
    const na = toNum(a);
    if (isErr(na)) return na;
    const nb = toNum(b);
    if (isErr(nb)) return nb;
    if (node.op === "+") return na + nb;
    if (node.op === "-") return na - nb;
    if (node.op === "*") return na * nb;
    if (node.op === "/") {
      if (nb === 0) return err(DIV0);
      return na / nb;
    }
    if (node.op === "^") {
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
    if (node.t === "area") {
      const values = valuesOfArea(node, ctx);
      if (isErr(values)) return values;
      for (const value2 of values) {
        const stop = visit(value2, true);
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
        if (typeof value === "number") {
          sum += value;
          count += 1;
          return null;
        }
        if (!fromRange && typeof value === "boolean") {
          sum += value ? 1 : 0;
          count += 1;
          return null;
        }
        if (!fromRange && value != null && value !== "") return err(VALUE);
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
    return sign * Math.round(Math.abs(x)) / p;
  }
  function asText(value) {
    const text = toStr(value);
    return text;
  }
  function wildcard(text, pattern) {
    let src = "^";
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === "~" && "*?~".includes(pattern[i + 1] || "")) {
        src += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i += 1;
      } else if (ch === "*") src += ".*";
      else if (ch === "?") src += ".";
      else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`${src}$`, "i").test(text);
  }
  function parseCriteria(value) {
    if (isErr(value)) return value;
    if (typeof value === "string") {
      const m = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(value);
      if (m) {
        return { op: m[1], rhs: coerceCriteria(m[2]) };
      }
      if (value.includes("*") || value.includes("?")) return { op: "wild", rhs: value };
    }
    return { op: "=", rhs: value };
  }
  function coerceCriteria(text) {
    const trimmed = text.trim();
    if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
    return text;
  }
  function matchesCriteria(value, criteria) {
    const spec = parseCriteria(criteria);
    if (isErr(spec)) return spec;
    if (isErr(value)) return false;
    if (spec.op === "wild") return wildcard(value == null ? "" : String(value), spec.rhs);
    const empty = value == null || value === "";
    if ((spec.op === "=" || spec.op === "wild") && (spec.rhs === "" || spec.rhs == null)) return empty;
    if (spec.op === "=" && spec.rhs === "") return empty;
    if (empty) return spec.op === "<>";
    if (typeof spec.rhs === "number" || typeof spec.rhs === "boolean") {
      const rhs = typeof spec.rhs === "boolean" ? spec.rhs ? 1 : 0 : spec.rhs;
      let n = null;
      if (typeof value === "number") n = value;
      else if (typeof value === "boolean") n = value ? 1 : 0;
      else if (typeof value === "string" && cmpNum(value) != null && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) n = cmpNum(value);
      if (n == null) return spec.op === "<>";
      if (spec.op === "=") return n === rhs;
      if (spec.op === "<>") return n !== rhs;
      if (spec.op === "<") return n < rhs;
      if (spec.op === ">") return n > rhs;
      if (spec.op === "<=") return n <= rhs;
      if (spec.op === ">=") return n >= rhs;
    }
    const order = compare(value, spec.rhs);
    if (isErr(order)) return order;
    if (spec.op === "=") return order === 0;
    if (spec.op === "<>") return order !== 0;
    if (spec.op === "<") return order < 0;
    if (spec.op === ">") return order > 0;
    if (spec.op === "<=") return order <= 0;
    if (spec.op === ">=") return order >= 0;
    return false;
  }
  function truthy(value) {
    if (isErr(value)) return value;
    if (value == null || value === "" || value === false || value === 0) return false;
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    return err(VALUE);
  }
  var FUNCS = {
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
          if (!isErr(value) && typeof value === "number") count += 1;
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
          if (isErr(value) || value != null && value !== "") count += 1;
          return null;
        });
        if (isErr(stop)) return stop;
      }
      return count;
    },
    COUNTIF(args, ctx) {
      if (args.length !== 2 || args[0].t !== "area") return err(VALUE);
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
      if (args.length !== 2 && args.length !== 3 || args[0].t !== "area") return err(VALUE);
      if (args.length === 3 && args[2].t !== "area") return err(VALUE);
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
          if (typeof add === "number") total += add;
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
      return evalOp({ t: "op", op: "^", args }, ctx);
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
      return side(args, ctx, "left");
    },
    RIGHT(args, ctx) {
      return side(args, ctx, "right");
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
      return [...text].slice(start - 1, start - 1 + Math.trunc(len)).join("");
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
      return mapText(args, ctx, (text) => text.trim().replace(/ {2,}/g, " "));
    }
  };
  function extreme(args, ctx, pick) {
    if (!args.length) return err(VALUE);
    let best = null;
    for (const arg of args) {
      const stop = eachScalar(arg, ctx, (value, fromRange) => {
        if (isErr(value)) return value;
        let n = null;
        if (typeof value === "number") n = value;
        else if (!fromRange) {
          const coerced = toNum(value);
          if (isErr(coerced)) return coerced;
          if (value != null && value !== "") n = coerced;
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
        if (fromRange && (value == null || value === "")) return null;
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
    let out = "";
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
    return dir === "left" ? chars.slice(0, count).join("") : chars.slice(chars.length - count).join("");
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
    if (node.name === "IF" || node.name === "IFERROR") return fn(node.args, ctx);
    return fn(node.args, ctx);
  }
  function evaluateFormula(formula, ctx) {
    const ast = parseFormula(formula);
    if (isErr(ast)) return ast;
    return evalAst(ast, ctx);
  }

  // packages/enso.spreadsheet/src/session.mjs
  var HISTORY = 80;
  function isNumericLiteral(raw) {
    return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(raw) || /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw);
  }
  function remap(cells, map) {
    const next = {};
    for (const [key, value] of Object.entries(cells)) {
      const [r, c] = key.split(",").map(Number);
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
      const [r, c] = key.split(",").map(Number);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    return { maxR, maxC, rows: maxR + 1, cols: maxC + 1 };
  }
  function createSession({ text = "", rel = "\u5DE5\u4F5C\u7C3F.xlsx", onChange = null } = {}) {
    const session = {
      rel,
      book: blankBook(),
      kind: "xlsx",
      warning: "",
      sheetIndex: 0,
      active: { r: 0, c: 0 },
      anchor: { r: 0, c: 0 },
      editing: false,
      draft: "",
      past: [],
      future: [],
      cache: /* @__PURE__ */ new Map(),
      viewRows: 0,
      viewCols: 0,
      onChange,
      load(nextText, nextRel = this.rel) {
        const parsed = parseDocument(nextText, nextRel);
        this.rel = nextRel;
        this.book = parsed.book;
        this.kind = parsed.kind;
        this.warning = parsed.error || "";
        const visible = this.book.sheets.findIndex((sheet) => !sheet.hidden);
        this.sheetIndex = visible < 0 ? 0 : visible;
        this.active = { r: 0, c: 0 };
        this.anchor = { r: 0, c: 0 };
        this.editing = false;
        this.draft = "";
        this.past = [];
        this.future = [];
        this.cache = /* @__PURE__ */ new Map();
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
          usedCols: used.cols
        };
      },
      ensure(r, c) {
        if (r + 8 > this.viewRows) this.viewRows = Math.min(MAX_ROW, Math.max(this.viewRows, r + 24));
        if (c + 3 > this.viewCols) this.viewCols = Math.min(MAX_COL, Math.max(this.viewCols, c + 8));
      },
      raw(r, c, sheet = this.current()) {
        return sheet.cells[`${r},${c}`] ?? "";
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
        if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
        if (raw.startsWith("=")) return this.evalFormula(sheet, r, c, raw);
        if (isNumericLiteral(raw)) return Number(raw.replace(/,/g, ""));
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
            if (height * width > 2e5) return err(REF);
            const sheet = this.resolveSheet(box.sheet, home);
            const values = [];
            for (let r = box.r1; r <= box.r2; r += 1) {
              for (let c = box.c1; c <= box.c2; c += 1) values.push(this.valueOn(sheet, r, c));
            }
            return values;
          }
        };
      },
      cellView(r, c) {
        const raw = this.raw(r, c);
        if (!raw) return { text: "", align: "left", raw: "" };
        if (raw.startsWith("'")) return { text: raw.slice(1), align: "left", raw };
        if (raw.startsWith("=")) return { ...displayOf(this.value(r, c)), raw };
        if (/^(true|false)$/i.test(raw)) return { text: raw.toUpperCase(), align: "center", raw };
        if (isNumericLiteral(raw)) return { text: raw, align: "right", raw };
        return { text: raw, align: "left", raw };
      },
      editText() {
        return this.editing ? this.draft : this.raw(this.active.r, this.active.c);
      },
      selection() {
        return {
          r1: Math.min(this.anchor.r, this.active.r),
          c1: Math.min(this.anchor.c, this.active.c),
          r2: Math.max(this.anchor.r, this.active.r),
          c2: Math.max(this.anchor.c, this.active.c)
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
          const [r, c] = key.split(",").map(Number);
          if (r < r1 || r > r2 || c < c1 || c > c2) continue;
          const value = this.valueOn(sheet, r, c);
          if (value == null || value === "") continue;
          count += 1;
          if (typeof value === "number" && Number.isFinite(value)) {
            numeric += 1;
            sum += value;
          }
        }
        return {
          address: `${formatAddress(c1, r1)}:${formatAddress(c2, r2)}`,
          count,
          sum: numeric ? sum : null,
          average: numeric ? sum / numeric : null
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
        const filled = (rr, cc) => rr >= 0 && cc >= 0 && this.raw(rr, cc) !== "";
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
          c: Math.max(0, used.maxC)
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
      setDraft(text2) {
        this.editing = true;
        this.draft = String(text2 ?? "");
      },
      commit(dr = 0, dc = 0) {
        if (!this.editing) {
          if (dr || dc) this.move(dr, dc);
          return;
        }
        const { r, c } = this.active;
        const text2 = this.draft;
        this.editing = false;
        this.draft = "";
        if (this.raw(r, c) !== text2.replace(/\u0000/g, "")) this.setCell(r, c, text2);
        if (dr || dc) this.move(dr, dc);
      },
      cancel() {
        this.editing = false;
        this.draft = "";
      },
      setCell(r, c, raw) {
        const sheet = this.current();
        const key = `${r},${c}`;
        const text2 = String(raw ?? "").replace(/\u0000/g, "");
        if ((sheet.cells[key] ?? "") === text2) return;
        this.snapshot();
        if (!text2) delete sheet.cells[key];
        else sheet.cells[key] = text2;
        this.cache = /* @__PURE__ */ new Map();
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
        this.cache = /* @__PURE__ */ new Map();
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
          anchor: this.anchor
        };
      },
      restore(raw) {
        const data = JSON.parse(raw);
        this.book = { sheets: data.sheets };
        this.sheetIndex = data.sheetIndex;
        this.active = data.active;
        this.anchor = data.anchor;
        this.editing = false;
        this.draft = "";
        this.cache = /* @__PURE__ */ new Map();
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
        this.warning = "";
        if (this.onChange) this.onChange(this.serialize());
      },
      rewrite(editedName, mutate) {
        for (const sheet of this.book.sheets) {
          for (const [key, raw] of Object.entries(sheet.cells)) {
            if (typeof raw === "string" && raw.startsWith("=")) {
              sheet.cells[key] = adjustFormula(raw, sheet.name, editedName, mutate);
            }
          }
        }
      },
      insertRows(where) {
        const { r1, r2 } = this.selection();
        const count = r2 - r1 + 1;
        const at = where === "below" ? r2 + 1 : r1;
        const used = usedOf(this.current());
        if (used.maxR + count >= MAX_ROW) {
          this.warning = "\u8D85\u51FA\u884C\u6570\u4E0A\u9650";
          return;
        }
        this.snapshot();
        const name = this.current().name;
        this.rewrite(name, (area) => insertRowsInArea(area, at, count));
        this.current().cells = remap(this.current().cells, (r, c) => ({ r: r >= at ? r + count : r, c }));
        if (this.active.r >= at) this.active = { ...this.active, r: this.active.r + count };
        if (this.anchor.r >= at) this.anchor = { ...this.anchor, r: this.anchor.r + count };
        this.cache = /* @__PURE__ */ new Map();
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
        this.cache = /* @__PURE__ */ new Map();
        this.emit();
      },
      insertCols(where) {
        const { c1, c2 } = this.selection();
        const count = c2 - c1 + 1;
        const at = where === "right" ? c2 + 1 : c1;
        const used = usedOf(this.current());
        if (used.maxC + count >= MAX_COL) {
          this.warning = "\u8D85\u51FA\u5217\u6570\u4E0A\u9650";
          return;
        }
        this.snapshot();
        const name = this.current().name;
        this.rewrite(name, (area) => insertColsInArea(area, at, count));
        this.current().cells = remap(this.current().cells, (r, c) => ({ r, c: c >= at ? c + count : c }));
        if (this.active.c >= at) this.active = { ...this.active, c: this.active.c + count };
        if (this.anchor.c >= at) this.anchor = { ...this.anchor, c: this.anchor.c + count };
        this.cache = /* @__PURE__ */ new Map();
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
        this.cache = /* @__PURE__ */ new Map();
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
        return stringifyDelimited(matrix, "	");
      },
      paste(text2) {
        const source = String(text2 ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (!source) return;
        const matrix = source.includes("	") ? parseDelimited(source, "	") : source.includes("\n") && source.includes(",") ? parseDelimited(source, ",") : [[source]];
        if (!matrix.length) return;
        const { r1, c1, r2, c2 } = this.selection();
        const single = matrix.length === 1 && matrix[0].length === 1;
        this.snapshot();
        const sheet = this.current();
        if (single && (r1 !== r2 || c1 !== c2)) {
          for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
              const value = matrix[0][0].replace(/\u0000/g, "");
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
              const text3 = value.replace(/\u0000/g, "");
              if (text3) sheet.cells[`${r},${c}`] = text3;
              else delete sheet.cells[`${r},${c}`];
            });
          });
          this.ensure(origin.r + matrix.length - 1, origin.c + Math.max(...matrix.map((row) => row.length)) - 1);
        }
        this.cache = /* @__PURE__ */ new Map();
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
        this.cache = /* @__PURE__ */ new Map();
      },
      addSheet() {
        if (!allowsManySheets(this.kind)) {
          this.warning = "CSV / TSV \u53EA\u6709\u4E00\u5F20\u5DE5\u4F5C\u8868";
          return;
        }
        this.snapshot();
        const names = new Set(this.book.sheets.map((sheet) => sheet.name.toLowerCase()));
        let n = this.book.sheets.length + 1;
        let name = `\u5DE5\u4F5C\u8868${n}`;
        while (names.has(name.toLowerCase())) {
          n += 1;
          name = `\u5DE5\u4F5C\u8868${n}`;
        }
        this.book.sheets.push({ name, hidden: false, cells: {} });
        this.sheetIndex = this.book.sheets.length - 1;
        this.active = { r: 0, c: 0 };
        this.anchor = { r: 0, c: 0 };
        this.cache = /* @__PURE__ */ new Map();
        this.emit();
      },
      deleteSheet(index = this.sheetIndex) {
        if (this.book.sheets.length <= 1) {
          this.warning = "\u81F3\u5C11\u4FDD\u7559\u4E00\u5F20\u5DE5\u4F5C\u8868";
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
        this.cache = /* @__PURE__ */ new Map();
        this.emit();
      },
      markDeletedSheet(name) {
        for (const sheet of this.book.sheets) {
          for (const [key, raw] of Object.entries(sheet.cells)) {
            if (typeof raw !== "string" || !raw.startsWith("=")) continue;
            sheet.cells[key] = adjustFormula(raw, sheet.name, name, () => null);
          }
        }
      },
      renameSheet(index, nextName) {
        const sheet = this.book.sheets[index];
        if (!sheet) return;
        let name = String(nextName ?? "").replace(/[\\/?*[\]:]/g, "").trim();
        name = [...name].slice(0, 31).join("");
        if (!name || name.toLowerCase() === sheet.name.toLowerCase()) {
          if (name && name !== sheet.name) {
            this.snapshot();
            const previous2 = sheet.name;
            sheet.name = name;
            this.renameRefs(previous2, name);
            this.cache = /* @__PURE__ */ new Map();
            this.emit();
          }
          return;
        }
        if (this.book.sheets.some((item, i) => i !== index && item.name.toLowerCase() === name.toLowerCase())) {
          this.warning = "\u5DF2\u6709\u540C\u540D\u5DE5\u4F5C\u8868";
          return;
        }
        this.snapshot();
        const previous = sheet.name;
        sheet.name = name;
        this.renameRefs(previous, name);
        this.cache = /* @__PURE__ */ new Map();
        this.emit();
      },
      renameRefs(from, to) {
        for (const sheet of this.book.sheets) {
          for (const [key, raw] of Object.entries(sheet.cells)) {
            if (typeof raw === "string" && raw.startsWith("=")) sheet.cells[key] = renameInFormula(raw, from, to);
          }
        }
      },
      hideSheet(index = this.sheetIndex) {
        const visible = this.book.sheets.filter((sheet) => !sheet.hidden);
        if (visible.length <= 1) {
          this.warning = "\u4E0D\u80FD\u9690\u85CF\u6700\u540E\u4E00\u5F20\u5DE5\u4F5C\u8868";
          return;
        }
        this.snapshot();
        this.book.sheets[index].hidden = true;
        if (this.sheetIndex === index) {
          this.sheetIndex = this.book.sheets.findIndex((sheet) => !sheet.hidden);
          this.active = { r: 0, c: 0 };
          this.anchor = { r: 0, c: 0 };
        }
        this.cache = /* @__PURE__ */ new Map();
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
        this.cache = /* @__PURE__ */ new Map();
        this.emit();
      },
      hiddenSheets() {
        return this.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => item.sheet.hidden);
      },
      goTo(text2) {
        const ref = parseAddress(text2);
        if (!ref) {
          this.warning = "\u65E0\u6CD5\u8BC6\u522B\u5355\u5143\u683C\u5730\u5740";
          return;
        }
        if (ref.sheet) {
          const index = this.book.sheets.findIndex((sheet) => sheet.name.toLowerCase() === ref.sheet.toLowerCase() && !sheet.hidden);
          if (index < 0) {
            this.warning = "\u627E\u4E0D\u5230\u8FD9\u4E2A\u5DE5\u4F5C\u8868";
            return;
          }
          this.sheetIndex = index;
        }
        this.select(ref.row, ref.col);
        this.warning = "";
      }
    };
    session.load(text, rel);
    session.onChange = onChange;
    return session;
  }
  var PENDING = Symbol("pending");

  // packages/enso.spreadsheet/src/view.mjs
  var ROW_H = 24;
  var COL_W = 108;
  var HEAD_W = 46;
  var HEAD_H = 26;
  function demoText() {
    const book = createSession({ rel: "\u5B63\u5EA6\u6C47\u603B.xlsx" });
    book.renameSheet(0, "Summary");
    const rows = [
      ["\u5B63\u5EA6\u6C47\u603B"],
      ["\u5730\u533A", "\u6536\u5165", "\u6210\u672C", "\u6BDB\u5229", "\u5360\u6BD4", "\u66F4\u65B0", "\u76EE\u6807"],
      ["North", "125000", "80000", "=B3-C3", "=B3/$B$7", "2025-01-01", "=B3*1.1"],
      ["South", "98000", "61000", "=B4-C4", "=B4/$B$7", "2025-01-08", "=B4*1.1"],
      ["East", "104000", "99000", "=B5-C5", "=B5/$B$7", "2025-01-15", "=B5*1.1"],
      ["West", "76000", "52000", "=B6-C6", "=B6/$B$7", "2025-01-22", "=B6*1.1"],
      ["\u5408\u8BA1", "=SUM(B3:B6)", "=SUM(C3:C6)", "=B7-C7", "=B7/$B$7", "", "=B7*1.1"],
      [],
      ["\u574F\u8D26\u7387", "=1/0"],
      ["\u5DF2\u5BA1\u6838", "TRUE"],
      [],
      ["\u5907\u6CE8", "\u6536\u5165\u5728\u8BA2\u5355\u53D1\u8D27\u65F6\u786E\u8BA4\uFF0C\u91D1\u989D\u4E3A\u7F8E\u5143\u4E14\u4E0D\u542B\u7A0E\u3002"]
    ];
    rows.forEach((row, r) => row.forEach((value, c) => value && book.setCell(r, c, value)));
    book.addSheet();
    book.renameSheet(1, "Data");
    book.setCell(0, 0, "\u7F16\u53F7");
    book.setCell(0, 1, "\u540D\u79F0");
    book.setCell(0, 2, "\u6570\u91CF");
    book.setCell(1, 0, "1");
    book.setCell(1, 1, "Hardware");
    book.setCell(1, 2, "12");
    book.addSheet();
    book.renameSheet(2, "Empty");
    book.addSheet();
    book.renameSheet(3, "Archive");
    book.hideSheet(3);
    book.setActiveSheet(0);
    return book.serialize();
  }
  function fileHost(enso) {
    if (enso?.file) return enso;
    let text = demoText();
    const listeners = /* @__PURE__ */ new Set();
    return {
      theme: "light",
      demo: true,
      onTheme(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setTheme(theme) {
        this.theme = theme;
        for (const listener of listeners) listener(theme);
      },
      file: {
        rel: "\u5B63\u5EA6\u6C47\u603B.xlsx",
        get text() {
          return text;
        },
        onChange() {
          return () => {
          };
        },
        update(next) {
          text = String(next);
        }
      }
    };
  }
  function mount(root, host) {
    const enso = fileHost(host ?? globalThis.window?.enso);
    const file = enso.file;
    const session = createSession({
      text: file.text,
      rel: file.rel,
      onChange(next) {
        file.update(next);
      }
    });
    root.innerHTML = `
    <div class="app">
      <div class="formula-bar">
        <input class="namebox" aria-label="\u5355\u5143\u683C\u5730\u5740" spellcheck="false" />
        <span class="fx">fx</span>
        <input class="formula" aria-label="\u516C\u5F0F\u680F" spellcheck="false" />
        <button type="button" class="bar-btn" data-act="undo">\u64A4\u9500</button>
        <button type="button" class="bar-btn" data-act="redo">\u91CD\u505A</button>
        ${enso.demo ? '<button type="button" class="bar-btn" data-act="theme">\u6DF1\u8272</button>' : ""}
      </div>
      <div class="banner" hidden></div>
      <div class="grid-frame">
        <div class="corner" data-act="all"></div>
        <div class="colheads"><div class="track"></div></div>
        <div class="rowheads"><div class="track"></div></div>
        <div class="scroller" tabindex="0">
          <div class="spacer">
            <div class="sel"></div>
            <div class="active-box"></div>
            <div class="cells"></div>
            <textarea class="editor" aria-label="\u5355\u5143\u683C\u7F16\u8F91" spellcheck="false"></textarea>
          </div>
        </div>
      </div>
      <div class="bottom">
        <div class="tabs"></div>
        <div class="status"></div>
      </div>
    </div>`;
    const app = root.querySelector(".app");
    const nameBox = root.querySelector(".namebox");
    const formula = root.querySelector(".formula");
    const banner = root.querySelector(".banner");
    const scroller = root.querySelector(".scroller");
    const spacer = root.querySelector(".spacer");
    const cells = root.querySelector(".cells");
    const sel = root.querySelector(".sel");
    const activeBox = root.querySelector(".active-box");
    const editor = root.querySelector(".editor");
    const colTrack = root.querySelector(".colheads .track");
    const rowTrack = root.querySelector(".rowheads .track");
    const tabs = root.querySelector(".tabs");
    const status = root.querySelector(".status");
    let menu = null;
    let drag = false;
    let frame = 0;
    const applyTheme = (theme) => {
      document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
      const button = root.querySelector('[data-act="theme"]');
      if (button) button.textContent = theme === "dark" ? "\u6D45\u8272" : "\u6DF1\u8272";
    };
    applyTheme(enso.theme);
    enso.onTheme?.(applyTheme);
    file.onChange?.(({ rel, text }) => {
      if (text === session.serialize() && rel === session.rel) return;
      session.load(text, rel ?? session.rel);
      render();
    });
    if (enso.demo) session.select(2, 6);
    function closeMenu() {
      menu?.remove();
      menu = null;
    }
    function openMenu(x, y, items) {
      closeMenu();
      menu = document.createElement("div");
      menu.className = "menu";
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.label;
        button.addEventListener("click", () => {
          closeMenu();
          item.run();
          render();
        });
        menu.append(button);
      }
      document.body.append(menu);
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
    }
    function cellMenuItems() {
      const { r1, c1, r2, c2 } = session.selection();
      const rows = r2 - r1 + 1;
      const cols = c2 - c1 + 1;
      const rowLabel = rows > 1 ? ` ${rows} \u884C` : "\u884C";
      const colLabel = cols > 1 ? ` ${cols} \u5217` : "\u5217";
      return [
        { label: `\u5728\u4E0A\u65B9\u63D2\u5165${rowLabel}`, run: () => session.insertRows("above") },
        { label: `\u5728\u4E0B\u65B9\u63D2\u5165${rowLabel}`, run: () => session.insertRows("below") },
        { label: `\u5220\u9664${rowLabel}`, run: () => session.deleteRows() },
        { label: `\u5728\u5DE6\u4FA7\u63D2\u5165${colLabel}`, run: () => session.insertCols("left") },
        { label: `\u5728\u53F3\u4FA7\u63D2\u5165${colLabel}`, run: () => session.insertCols("right") },
        { label: `\u5220\u9664${colLabel}`, run: () => session.deleteCols() },
        { label: "\u6E05\u9664\u5185\u5BB9", run: () => session.clearSelection() }
      ];
    }
    function point(event) {
      const rect = spacer.getBoundingClientRect();
      const grid = session.grid();
      const c = Math.floor((event.clientX - rect.left) / COL_W);
      const r = Math.floor((event.clientY - rect.top) / ROW_H);
      if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) return null;
      return { r, c };
    }
    function reveal(r, c) {
      const top = r * ROW_H;
      const left = c * COL_W;
      const bottom = top + ROW_H;
      const right = left + COL_W;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
      if (left < scroller.scrollLeft) scroller.scrollLeft = left;
      else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
    }
    function placeEditor() {
      const { r, c } = session.active;
      const lines = Math.max(1, (session.editing ? session.draft : "").split("\n").length);
      editor.style.left = `${c * COL_W}px`;
      editor.style.top = `${r * ROW_H}px`;
      editor.style.width = `${Math.max(COL_W, 8 + session.draft.length * 8)}px`;
      editor.style.height = `${lines * ROW_H + 2}px`;
      editor.classList.toggle("open", session.editing);
    }
    function openEdit(seed) {
      session.startEdit(seed);
      editor.value = session.draft;
      formula.value = session.draft;
      placeEditor();
      editor.focus();
      const end = editor.value.length;
      editor.setSelectionRange(seed == null ? end : end, end);
    }
    function paint() {
      const grid = session.grid();
      spacer.style.width = `${grid.cols * COL_W}px`;
      spacer.style.height = `${grid.rows * ROW_H}px`;
      const c0 = Math.max(0, Math.floor(scroller.scrollLeft / COL_W) - 1);
      const c1 = Math.min(grid.cols - 1, Math.ceil((scroller.scrollLeft + scroller.clientWidth) / COL_W) + 1);
      const r0 = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - 1);
      const r1 = Math.min(grid.rows - 1, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_H) + 2);
      const selBox = session.selection();
      cells.replaceChildren();
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const view = session.cellView(r, c);
          const node = document.createElement("div");
          node.className = view.error ? "cell err" : "cell";
          node.style.left = `${c * COL_W}px`;
          node.style.top = `${r * ROW_H}px`;
          node.style.width = `${COL_W}px`;
          node.style.height = `${ROW_H}px`;
          node.style.textAlign = view.align;
          node.textContent = view.text;
          cells.append(node);
        }
      }
      sel.style.left = `${selBox.c1 * COL_W}px`;
      sel.style.top = `${selBox.r1 * ROW_H}px`;
      sel.style.width = `${(selBox.c2 - selBox.c1 + 1) * COL_W}px`;
      sel.style.height = `${(selBox.r2 - selBox.r1 + 1) * ROW_H}px`;
      activeBox.style.left = `${session.active.c * COL_W}px`;
      activeBox.style.top = `${session.active.r * ROW_H}px`;
      activeBox.style.width = `${COL_W}px`;
      activeBox.style.height = `${ROW_H}px`;
      placeEditor();
      colTrack.style.width = `${grid.cols * COL_W}px`;
      colTrack.style.height = `${HEAD_H}px`;
      colTrack.style.transform = `translateX(${-scroller.scrollLeft}px)`;
      colTrack.replaceChildren();
      for (let c = c0; c <= c1; c += 1) {
        const node = document.createElement("div");
        node.className = c >= selBox.c1 && c <= selBox.c2 ? "head on" : "head";
        node.style.left = `${c * COL_W}px`;
        node.style.top = "0";
        node.style.width = `${COL_W}px`;
        node.style.height = `${HEAD_H}px`;
        node.dataset.col = String(c);
        node.textContent = formatAddress(c, 0).replace(/\d+/, "");
        colTrack.append(node);
      }
      rowTrack.style.height = `${grid.rows * ROW_H}px`;
      rowTrack.style.width = `${HEAD_W}px`;
      rowTrack.style.transform = `translateY(${-scroller.scrollTop}px)`;
      rowTrack.replaceChildren();
      for (let r = r0; r <= r1; r += 1) {
        const node = document.createElement("div");
        node.className = r >= selBox.r1 && r <= selBox.r2 ? "head on" : "head";
        node.style.left = "0";
        node.style.top = `${r * ROW_H}px`;
        node.style.width = `${HEAD_W}px`;
        node.style.height = `${ROW_H}px`;
        node.dataset.row = String(r);
        node.textContent = String(r + 1);
        rowTrack.append(node);
      }
    }
    function renderChrome() {
      if (document.activeElement !== nameBox) nameBox.value = formatAddress(session.active.c, session.active.r);
      if (document.activeElement !== formula) formula.value = session.editText();
      banner.hidden = !session.warning;
      banner.textContent = session.warning;
      tabs.replaceChildren();
      session.book.sheets.forEach((sheet, index) => {
        if (sheet.hidden) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = index === session.sheetIndex ? "tab active" : "tab";
        button.textContent = sheet.name;
        button.title = sheet.name;
        button.addEventListener("click", () => {
          session.setActiveSheet(index);
          render();
        });
        button.addEventListener("dblclick", () => renameTab(button, index));
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY, [
            { label: "\u91CD\u547D\u540D", run: () => renameTab(button, index) },
            { label: "\u9690\u85CF", run: () => session.hideSheet(index) },
            { label: "\u5220\u9664\u5DE5\u4F5C\u8868", run: () => session.deleteSheet(index) }
          ]);
        });
        tabs.append(button);
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add";
      add.textContent = "+";
      add.title = allowsManySheets(session.kind) ? "\u65B0\u5EFA\u5DE5\u4F5C\u8868" : "CSV / TSV \u53EA\u6709\u4E00\u5F20\u5DE5\u4F5C\u8868";
      add.addEventListener("click", () => {
        session.addSheet();
        render();
      });
      tabs.append(add);
      for (const item of session.hiddenSheets()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tab";
        button.textContent = `\u663E\u793A ${item.sheet.name}`;
        button.addEventListener("click", () => {
          session.unhideSheet(item.index);
          render();
        });
        tabs.append(button);
      }
      const grid = session.grid();
      const parts = [];
      parts.push(grid.usedRows ? `${grid.usedRows} \u884C \xD7 ${grid.usedCols} \u5217` : "\u7A7A\u8868");
      const hidden = session.hiddenSheets().length;
      if (hidden) parts.push(`${hidden} \u4E2A\u9690\u85CF\u5DE5\u4F5C\u8868\u672A\u663E\u793A`);
      const stats = session.stats();
      if (stats) {
        let text = `${stats.address}  \u8BA1\u6570 ${stats.count}`;
        if (stats.sum != null) text += `  \u6C42\u548C ${formatNumber(stats.sum)}  \u5E73\u5747 ${formatNumber(stats.average)}`;
        parts.push(text);
      }
      const kind = session.kind === "csv" ? "CSV" : session.kind === "tsv" ? "TSV" : "\u5DE5\u4F5C\u7C3F";
      parts.push(kind);
      status.textContent = parts.join("    ");
    }
    function renameTab(button, index) {
      const input = document.createElement("input");
      input.className = "rename";
      input.value = session.book.sheets[index].name;
      button.replaceWith(input);
      input.focus();
      input.select();
      const finish = (save) => {
        if (save) session.renameSheet(index, input.value);
        render();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    }
    function render() {
      renderChrome();
      paint();
    }
    function afterMove() {
      reveal(session.active.r, session.active.c);
      render();
      if (document.activeElement !== formula && document.activeElement !== nameBox) editor.focus();
    }
    function gridKey(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) session.redo();
        else session.undo();
        render();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        session.redo();
        render();
        return;
      }
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        session.selectAll();
        render();
        return;
      }
      if (event.key === "F2") {
        event.preventDefault();
        openEdit(null);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        session.clearSelection();
        render();
        return;
      }
      if (event.key === "F10" && event.shiftKey) {
        event.preventDefault();
        const rect = activeBox.getBoundingClientRect();
        openMenu(rect.left, rect.bottom, cellMenuItems());
        return;
      }
      const extend = event.shiftKey;
      let handled = true;
      if (event.key === "ArrowUp") session.move(-1, 0, extend);
      else if (event.key === "ArrowDown") session.move(1, 0, extend);
      else if (event.key === "ArrowLeft") session.move(0, -1, extend);
      else if (event.key === "ArrowRight") session.move(0, 1, extend);
      else if (event.key === "Tab") session.move(0, event.shiftKey ? -1 : 1, false);
      else if (event.key === "Enter") session.move(event.shiftKey ? -1 : 1, 0, false);
      else if (event.key === "Home") session.select(mod ? 0 : session.active.r, 0, extend);
      else if (event.key === "End") {
        const used = session.grid();
        session.select(mod ? Math.max(0, used.usedRows - 1) : session.active.r, Math.max(0, used.usedCols - 1), extend);
      } else if (event.key === "PageDown" || event.key === "PageUp") {
        const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
        session.move(event.key === "PageDown" ? page : -page, 0, extend);
      } else if (mod && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
        session.jump(dir[0], dir[1], extend);
      } else if (mod && event.key === "PageUp") {
        const visible = session.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => !item.sheet.hidden);
        const at = visible.findIndex((item) => item.index === session.sheetIndex);
        session.setActiveSheet(visible[(at - 1 + visible.length) % visible.length].index);
      } else if (mod && event.key === "PageDown") {
        const visible = session.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => !item.sheet.hidden);
        const at = visible.findIndex((item) => item.index === session.sheetIndex);
        session.setActiveSheet(visible[(at + 1) % visible.length].index);
      } else if (event.key === " " && mod) session.selectCol();
      else if (event.key === " " && event.shiftKey) session.selectRow();
      else handled = false;
      if (!handled) return;
      event.preventDefault();
      afterMove();
    }
    scroller.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    });
    scroller.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target === editor) return;
      event.preventDefault();
      const pos = point(event);
      if (!pos) return;
      if (session.editing) session.commit();
      if (event.detail === 2) {
        session.select(pos.r, pos.c, false);
        openEdit(null);
        return;
      }
      session.select(pos.r, pos.c, event.shiftKey);
      drag = true;
      scroller.setPointerCapture?.(event.pointerId);
      render();
      editor.focus();
    });
    scroller.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const pos = point(event);
      if (!pos) return;
      session.select(pos.r, pos.c, true);
      paint();
      renderChrome();
    });
    scroller.addEventListener("pointerup", () => {
      drag = false;
    });
    scroller.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const pos = point(event);
      if (pos) {
        const box = session.selection();
        const inside = pos.r >= box.r1 && pos.r <= box.r2 && pos.c >= box.c1 && pos.c <= box.c2;
        if (!inside) session.select(pos.r, pos.c, false);
      }
      render();
      openMenu(event.clientX, event.clientY, cellMenuItems());
    });
    editor.addEventListener("keydown", (event) => {
      if (!session.editing) {
        if (event.key === "Process" || event.isComposing) return;
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          openEdit(event.key);
          return;
        }
        gridKey(event);
        return;
      }
      if (event.key === "Enter" && !event.altKey) {
        event.preventDefault();
        session.setDraft(editor.value);
        session.commit(event.shiftKey ? -1 : 1, 0);
        afterMove();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        session.setDraft(editor.value);
        session.commit(0, event.shiftKey ? -1 : 1);
        afterMove();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        session.cancel();
        editor.value = "";
        render();
        editor.focus();
        return;
      }
      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        const start = editor.selectionStart;
        editor.value = `${editor.value.slice(0, start)}
${editor.value.slice(editor.selectionEnd)}`;
        editor.setSelectionRange(start + 1, start + 1);
        session.setDraft(editor.value);
        formula.value = editor.value;
        placeEditor();
      }
    });
    editor.addEventListener("compositionstart", () => {
      if (!session.editing) openEdit("");
    });
    editor.addEventListener("input", () => {
      if (!session.editing) session.startEdit(editor.value);
      session.setDraft(editor.value);
      formula.value = editor.value;
      placeEditor();
    });
    formula.addEventListener("focus", () => {
      if (!session.editing) session.startEdit(null);
      formula.value = session.draft;
    });
    formula.addEventListener("input", () => {
      session.setDraft(formula.value);
      editor.value = formula.value;
      placeEditor();
    });
    formula.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        session.setDraft(formula.value);
        session.commit(1, 0);
        afterMove();
      } else if (event.key === "Escape") {
        event.preventDefault();
        session.cancel();
        render();
        editor.focus();
      }
    });
    nameBox.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      session.goTo(nameBox.value);
      afterMove();
    });
    nameBox.addEventListener("blur", () => {
      nameBox.value = formatAddress(session.active.c, session.active.r);
    });
    app.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (act === "undo") {
        session.undo();
        render();
      } else if (act === "redo") {
        session.redo();
        render();
      } else if (act === "theme") {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        enso.setTheme?.(next);
        applyTheme(next);
      } else if (act === "all") {
        session.selectAll();
        render();
      }
    });
    colTrack.addEventListener("pointerdown", (event) => {
      const col = Number(event.target.dataset.col);
      if (!Number.isInteger(col)) return;
      session.active = { r: session.active.r, c: col };
      if (event.shiftKey) session.anchor = { ...session.anchor, c: session.anchor.c };
      else session.anchor = { r: 0, c: col };
      session.active = { r: session.grid().rows - 1, c: col };
      session.editing = false;
      render();
    });
    rowTrack.addEventListener("pointerdown", (event) => {
      const row = Number(event.target.dataset.row);
      if (!Number.isInteger(row)) return;
      if (!event.shiftKey) session.anchor = { r: row, c: 0 };
      session.active = { r: row, c: session.grid().cols - 1 };
      session.editing = false;
      render();
    });
    app.addEventListener("copy", (event) => {
      if (event.target === formula || event.target === nameBox || event.target.classList?.contains("rename")) return;
      if (session.editing && event.target === editor) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", session.copyText());
    });
    app.addEventListener("cut", (event) => {
      if (session.editing && event.target === editor) return;
      if (event.target === formula || event.target === nameBox) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", session.copyText());
      session.clearSelection();
      render();
    });
    app.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      if ((event.target === editor || event.target === formula) && !text.includes("	") && !text.includes("\n")) return;
      event.preventDefault();
      if (session.editing) session.cancel();
      session.paste(text);
      render();
    });
    document.addEventListener("pointerdown", (event) => {
      if (menu && !menu.contains(event.target)) closeMenu();
    });
    window.addEventListener("resize", () => paint());
    render();
    editor.focus();
  }
  return __toCommonJS(view_exports);
})();
