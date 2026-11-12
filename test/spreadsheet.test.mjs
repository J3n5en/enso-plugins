import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDelimited, stringifyDelimited } from '../packages/enso.spreadsheet/src/csv.mjs';
import { parseDocument, serializeDocument } from '../packages/enso.spreadsheet/src/document.mjs';
import { formatNumber } from '../packages/enso.spreadsheet/src/formula.mjs';
import { createSession } from '../packages/enso.spreadsheet/src/session.mjs';

function session(text, rel = 'book.xlsx') {
  const writes = [];
  const sheet = createSession({
    text,
    rel,
    onChange(next) {
      writes.push(next);
    },
  });
  sheet.writes = writes;
  return sheet;
}

function valueText(sheet, addr) {
  const { row, col } = address(addr);
  const view = sheet.cellView(row, col);
  return view.text;
}

function address(addr) {
  const col = addr.match(/[A-Z]+/)[0];
  const row = Number(addr.match(/\d+/)[0]) - 1;
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return { row, col: n - 1 };
}

test('数字格式去掉二进制浮点尾巴', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(137500), '137,500');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(1.25), '1.25');
});

test('CSV 保留引号、换行和公式原文', () => {
  const matrix = [
    ['North', '125000', '=B1*1.1'],
    ['说,明', '含"引号"', '一行\n两行'],
  ];
  const text = stringifyDelimited(matrix, ',');
  assert.deepEqual(parseDelimited(text, ','), matrix);
  const sheet = session(text, 'quarter.csv');
  assert.equal(sheet.raw(0, 2), '=B1*1.1');
  assert.equal(valueText(sheet, 'C1'), '137,500');
  assert.equal(sheet.serialize().includes('\0'), false);
  sheet.setCell(0, 1, '100');
  assert.equal(sheet.writes.at(-1).includes('=B1*1.1'), true);
  assert.equal(valueText(sheet, 'C1'), '110');
});

test('算术、比较、文本和 #DIV/0!', () => {
  const sheet = session('10,0', 't.csv');
  sheet.setCell(0, 2, '=A1/B1');
  sheet.setCell(0, 3, '=IF(B1=0,"无",A1/B1)');
  sheet.setCell(0, 4, '=IFERROR(A1/B1,"出错")');
  sheet.setCell(0, 5, '=1/0');
  assert.equal(valueText(sheet, 'C1'), '#DIV/0!');
  assert.equal(sheet.cellView(0, 2).error, true);
  assert.equal(valueText(sheet, 'D1'), '无');
  assert.equal(valueText(sheet, 'E1'), '出错');
  assert.equal(valueText(sheet, 'F1'), '#DIV/0!');
  sheet.setCell(0, 1, '4');
  assert.equal(valueText(sheet, 'C1'), '2.5');
  assert.equal(valueText(sheet, 'D1'), '2.5');
});

test('SUM、AVERAGE、COUNT、COUNTIF、SUMIF 与整列', () => {
  const sheet = session('1\n2\ntext\n3\n', 'n.csv');
  sheet.setCell(0, 1, '=SUM(A1:A4)');
  sheet.setCell(1, 1, '=AVERAGE(A1:A4)');
  sheet.setCell(2, 1, '=COUNT(A1:A4)');
  sheet.setCell(3, 1, '=COUNTA(A1:A4)');
  sheet.setCell(4, 1, '=COUNTIF(A1:A4,">1")');
  sheet.setCell(5, 1, '=SUMIF(A1:A4,">1",A1:A4)');
  sheet.setCell(6, 1, '=SUM(A:A)');
  assert.equal(sheet.value(0, 1), 6);
  assert.equal(sheet.value(1, 1), 2);
  assert.equal(sheet.value(2, 1), 3);
  assert.equal(sheet.value(3, 1), 4);
  assert.equal(sheet.value(4, 1), 2);
  assert.equal(sheet.value(5, 1), 5);
  assert.equal(sheet.value(6, 1), 6);
});

test('空区域的 AVERAGE 是 #DIV/0!，IF 不计算未选中的分支', () => {
  const sheet = session('', 'e.csv');
  sheet.setCell(0, 0, '=AVERAGE(Z1:Z3)');
  sheet.setCell(1, 0, '=IF(1,2,1/0)');
  sheet.setCell(2, 0, '=IF(0,1/0,3)');
  assert.equal(valueText(sheet, 'A1'), '#DIV/0!');
  assert.equal(sheet.value(1, 0), 2);
  assert.equal(sheet.value(2, 0), 3);
});

test('插入删除行列会带动引用，被删单元格变成 #REF!', () => {
  const sheet = session('1,10\n2,20\n3,30\n=SUM(A1:A3),=B1*1.1', 'rows.csv');
  sheet.select(1, 0);
  sheet.insertRows('above');
  assert.equal(sheet.raw(4, 0), '=SUM(A1:A4)');
  assert.equal(sheet.value(4, 0), 6);
  assert.equal(sheet.raw(4, 1), '=B1*1.1');
  assert.equal(sheet.value(4, 1), 11);
  sheet.select(0, 1);
  sheet.insertCols('left');
  assert.equal(sheet.raw(4, 0), '=SUM(A1:A4)');
  assert.equal(sheet.raw(4, 2), '=C1*1.1');
  assert.equal(sheet.value(4, 2), 11);
  sheet.select(0, 0);
  sheet.deleteRows();
  assert.equal(sheet.raw(3, 0), '=SUM(A1:A3)');
  assert.match(sheet.raw(3, 2), /#REF!/);
});

test('跨表公式、重命名和删除工作表', () => {
  const sheet = session('', 'model.xlsx');
  sheet.renameSheet(0, 'Summary');
  sheet.setCell(0, 0, '10');
  sheet.addSheet();
  sheet.renameSheet(1, '明细');
  sheet.setCell(0, 0, '=Summary!A1*2');
  assert.equal(sheet.value(0, 0), 20);
  sheet.renameSheet(0, '汇总');
  assert.match(sheet.raw(0, 0), /汇总/);
  assert.equal(sheet.value(0, 0), 20);
  sheet.deleteSheet(0);
  assert.equal(valueText(sheet, 'A1'), '#REF!');
  const saved = sheet.serialize();
  assert.equal(saved.includes('\0'), false);
  assert.match(saved, /"enso\.spreadsheet": 1/);
  const again = session(saved, 'model.xlsx');
  assert.equal(again.book.sheets[0].name, '明细');
  assert.equal(valueText(again, 'A1'), '#REF!');
});

test('隐藏工作表仍参与计算，选区给出计数、求和与平均', () => {
  const sheet = session('', 'model.xlsx');
  sheet.renameSheet(0, 'Summary');
  sheet.setCell(0, 0, '2');
  sheet.setCell(0, 1, '4');
  sheet.setCell(1, 0, 'text');
  sheet.setCell(1, 1, '=1/0');
  sheet.select(0, 0);
  assert.equal(sheet.stats(), null);
  sheet.anchor = { r: 0, c: 0 };
  sheet.active = { r: 1, c: 1 };
  const stats = sheet.stats();
  assert.equal(stats.address, 'A1:B2');
  assert.equal(stats.count, 4);
  assert.equal(stats.sum, 6);
  assert.equal(stats.average, 3);
  sheet.addSheet();
  sheet.setCell(0, 0, '=Summary!A1');
  assert.equal(sheet.value(0, 0), 2);
  sheet.hideSheet(0);
  assert.equal(sheet.hiddenSheets().length, 1);
  assert.equal(sheet.current().name !== 'Summary', true);
  assert.equal(sheet.value(0, 0), 2);
  const round = session(sheet.serialize(), 'model.xlsx');
  assert.equal(round.book.sheets.some((item) => item.hidden), true);
  round.setActiveSheet(round.book.sheets.findIndex((item) => !item.hidden));
  assert.equal(round.value(0, 0), 2);
});

test('选区统计跳过空单元格，文本开头的撇号不当公式', () => {
  const sheet = session("'=1+1,5,,7", 's.csv');
  assert.equal(valueText(sheet, 'A1'), '=1+1');
  sheet.anchor = { r: 0, c: 0 };
  sheet.active = { r: 0, c: 3 };
  const stats = sheet.stats();
  assert.equal(stats.count, 3);
  assert.equal(stats.sum, 12);
  assert.equal(stats.average, 6);
});

test('循环引用、未知函数和文本函数', () => {
  const sheet = session('', 'c.csv');
  sheet.setCell(0, 0, '=B1');
  sheet.setCell(0, 1, '=A1');
  sheet.setCell(0, 2, '=LEFT("汉字表",1)');
  sheet.setCell(0, 3, '=LEN("汉字表")');
  sheet.setCell(0, 4, '=ROUND(1.5,0)');
  sheet.setCell(0, 5, '=ROUND(-1.5,0)');
  sheet.setCell(0, 6, '=NOPE()');
  assert.equal(valueText(sheet, 'A1'), '#CYCLE!');
  assert.equal(valueText(sheet, 'C1'), '汉');
  assert.equal(sheet.value(0, 3), 3);
  assert.equal(sheet.value(0, 4), 2);
  assert.equal(sheet.value(0, 5), -2);
  assert.equal(valueText(sheet, 'G1'), '#NAME?');
});

test('撤销重做、粘贴公式和 TSV', () => {
  const sheet = session('1\t2\n3\t4\n', 'data.tsv');
  assert.equal(sheet.value(1, 1), 4);
  sheet.setCell(0, 0, '9');
  assert.equal(sheet.value(0, 0), 9);
  sheet.undo();
  assert.equal(sheet.value(0, 0), 1);
  sheet.redo();
  assert.equal(sheet.value(0, 0), 9);
  sheet.select(2, 0);
  sheet.paste('=A1+A2\t=SUM(A1,A2)');
  assert.equal(sheet.raw(2, 0), '=A1+A2');
  assert.equal(sheet.raw(2, 1), '=SUM(A1,A2)');
  assert.equal(sheet.value(2, 0), 12);
  assert.equal(sheet.value(2, 1), 12);
  assert.equal(sheet.serialize().includes('\0'), false);
});

test('空文件和二进制内容有明确结果', () => {
  const empty = session('', 'new.xlsx');
  assert.equal(empty.book.sheets.length, 1);
  assert.equal(empty.warning, '');
  assert.match(empty.serialize(), /工作表1/);
  const binary = session('PK\u0000\u0003', 'real.xlsx');
  assert.match(binary.warning, /空字节/);
});

test('分号参数和百分号', () => {
  const sheet = session('=SUM(1;2;3),=50%,=2^3^2,=-2^2', 'op.csv');
  assert.equal(sheet.value(0, 0), 6);
  assert.equal(sheet.value(0, 1), 0.5);
  assert.equal(sheet.value(0, 2), 512);
  assert.equal(sheet.value(0, 3), 4);
});
