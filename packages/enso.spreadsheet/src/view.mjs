import { allowsManySheets } from './document.mjs';
import { formatNumber } from './formula.mjs';
import { formatAddress } from './refs.mjs';
import { createSession } from './session.mjs';

const ROW_H = 24;
const COL_W = 108;
const HEAD_W = 46;
const HEAD_H = 26;

function demoText() {
  const book = createSession({ rel: '季度汇总.xlsx' });
  book.renameSheet(0, 'Summary');
  const rows = [
    ['季度汇总'],
    ['地区', '收入', '成本', '毛利', '占比', '更新', '目标'],
    ['North', '125000', '80000', '=B3-C3', '=B3/$B$7', '2025-01-01', '=B3*1.1'],
    ['South', '98000', '61000', '=B4-C4', '=B4/$B$7', '2025-01-08', '=B4*1.1'],
    ['East', '104000', '99000', '=B5-C5', '=B5/$B$7', '2025-01-15', '=B5*1.1'],
    ['West', '76000', '52000', '=B6-C6', '=B6/$B$7', '2025-01-22', '=B6*1.1'],
    ['合计', '=SUM(B3:B6)', '=SUM(C3:C6)', '=B7-C7', '=B7/$B$7', '', '=B7*1.1'],
    [],
    ['坏账率', '=1/0'],
    ['已审核', 'TRUE'],
    [],
    ['备注', '收入在订单发货时确认，金额为美元且不含税。'],
  ];
  rows.forEach((row, r) => row.forEach((value, c) => value && book.setCell(r, c, value)));
  book.addSheet();
  book.renameSheet(1, 'Data');
  book.setCell(0, 0, '编号');
  book.setCell(0, 1, '名称');
  book.setCell(0, 2, '数量');
  book.setCell(1, 0, '1');
  book.setCell(1, 1, 'Hardware');
  book.setCell(1, 2, '12');
  book.addSheet();
  book.renameSheet(2, 'Empty');
  book.addSheet();
  book.renameSheet(3, 'Archive');
  book.hideSheet(3);
  book.setActiveSheet(0);
  return book.serialize();
}

function fileHost(enso) {
  if (enso?.file) return enso;
  let text = demoText();
  const listeners = new Set();
  return {
    theme: 'light',
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
      rel: '季度汇总.xlsx',
      get text() {
        return text;
      },
      onChange() {
        return () => {};
      },
      update(next) {
        text = String(next);
      },
    },
  };
}

export function mount(root, host) {
  const enso = fileHost(host ?? globalThis.window?.enso);
  const file = enso.file;
  const session = createSession({
    text: file.text,
    rel: file.rel,
    onChange(next) {
      file.update(next);
    },
  });

  root.innerHTML = `
    <div class="app">
      <div class="formula-bar">
        <input class="namebox" aria-label="单元格地址" spellcheck="false" />
        <span class="fx">fx</span>
        <input class="formula" aria-label="公式栏" spellcheck="false" />
        <button type="button" class="bar-btn" data-act="undo">撤销</button>
        <button type="button" class="bar-btn" data-act="redo">重做</button>
        ${enso.demo ? '<button type="button" class="bar-btn" data-act="theme">深色</button>' : ''}
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
            <textarea class="editor" aria-label="单元格编辑" spellcheck="false"></textarea>
          </div>
        </div>
      </div>
      <div class="bottom">
        <div class="tabs"></div>
        <div class="status"></div>
      </div>
    </div>`;

  const app = root.querySelector('.app');
  const nameBox = root.querySelector('.namebox');
  const formula = root.querySelector('.formula');
  const banner = root.querySelector('.banner');
  const scroller = root.querySelector('.scroller');
  const spacer = root.querySelector('.spacer');
  const cells = root.querySelector('.cells');
  const sel = root.querySelector('.sel');
  const activeBox = root.querySelector('.active-box');
  const editor = root.querySelector('.editor');
  const colTrack = root.querySelector('.colheads .track');
  const rowTrack = root.querySelector('.rowheads .track');
  const tabs = root.querySelector('.tabs');
  const status = root.querySelector('.status');
  let menu = null;
  let drag = false;
  let frame = 0;

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    const button = root.querySelector('[data-act="theme"]');
    if (button) button.textContent = theme === 'dark' ? '浅色' : '深色';
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
    menu = document.createElement('div');
    menu.className = 'menu';
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.addEventListener('click', () => {
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
    const rowLabel = rows > 1 ? ` ${rows} 行` : '行';
    const colLabel = cols > 1 ? ` ${cols} 列` : '列';
    return [
      { label: `在上方插入${rowLabel}`, run: () => session.insertRows('above') },
      { label: `在下方插入${rowLabel}`, run: () => session.insertRows('below') },
      { label: `删除${rowLabel}`, run: () => session.deleteRows() },
      { label: `在左侧插入${colLabel}`, run: () => session.insertCols('left') },
      { label: `在右侧插入${colLabel}`, run: () => session.insertCols('right') },
      { label: `删除${colLabel}`, run: () => session.deleteCols() },
      { label: '清除内容', run: () => session.clearSelection() },
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
    const lines = Math.max(1, (session.editing ? session.draft : '').split('\n').length);
    editor.style.left = `${c * COL_W}px`;
    editor.style.top = `${r * ROW_H}px`;
    editor.style.width = `${Math.max(COL_W, 8 + session.draft.length * 8)}px`;
    editor.style.height = `${lines * ROW_H + 2}px`;
    editor.classList.toggle('open', session.editing);
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
        const node = document.createElement('div');
        node.className = view.error ? 'cell err' : 'cell';
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
      const node = document.createElement('div');
      node.className = c >= selBox.c1 && c <= selBox.c2 ? 'head on' : 'head';
      node.style.left = `${c * COL_W}px`;
      node.style.top = '0';
      node.style.width = `${COL_W}px`;
      node.style.height = `${HEAD_H}px`;
      node.dataset.col = String(c);
      node.textContent = formatAddress(c, 0).replace(/\d+/, '');
      colTrack.append(node);
    }
    rowTrack.style.height = `${grid.rows * ROW_H}px`;
    rowTrack.style.width = `${HEAD_W}px`;
    rowTrack.style.transform = `translateY(${-scroller.scrollTop}px)`;
    rowTrack.replaceChildren();
    for (let r = r0; r <= r1; r += 1) {
      const node = document.createElement('div');
      node.className = r >= selBox.r1 && r <= selBox.r2 ? 'head on' : 'head';
      node.style.left = '0';
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
      const button = document.createElement('button');
      button.type = 'button';
      button.className = index === session.sheetIndex ? 'tab active' : 'tab';
      button.textContent = sheet.name;
      button.title = sheet.name;
      button.addEventListener('click', () => {
        session.setActiveSheet(index);
        render();
      });
      button.addEventListener('dblclick', () => renameTab(button, index));
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          { label: '重命名', run: () => renameTab(button, index) },
          { label: '隐藏', run: () => session.hideSheet(index) },
          { label: '删除工作表', run: () => session.deleteSheet(index) },
        ]);
      });
      tabs.append(button);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.textContent = '+';
    add.title = allowsManySheets(session.kind) ? '新建工作表' : 'CSV / TSV 只有一张工作表';
    add.addEventListener('click', () => {
      session.addSheet();
      render();
    });
    tabs.append(add);
    for (const item of session.hiddenSheets()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab';
      button.textContent = `显示 ${item.sheet.name}`;
      button.addEventListener('click', () => {
        session.unhideSheet(item.index);
        render();
      });
      tabs.append(button);
    }
    const grid = session.grid();
    const parts = [];
    parts.push(grid.usedRows ? `${grid.usedRows} 行 × ${grid.usedCols} 列` : '空表');
    const hidden = session.hiddenSheets().length;
    if (hidden) parts.push(`${hidden} 个隐藏工作表未显示`);
    const stats = session.stats();
    if (stats) {
      let text = `${stats.address}  计数 ${stats.count}`;
      if (stats.sum != null) text += `  求和 ${formatNumber(stats.sum)}  平均 ${formatNumber(stats.average)}`;
      parts.push(text);
    }
    const kind = session.kind === 'csv' ? 'CSV' : session.kind === 'tsv' ? 'TSV' : '工作簿';
    parts.push(kind);
    status.textContent = parts.join('    ');
  }

  function renameTab(button, index) {
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = session.book.sheets[index].name;
    button.replaceWith(input);
    input.focus();
    input.select();
    const finish = (save) => {
      if (save) session.renameSheet(index, input.value);
      render();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
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
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
      render();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      session.redo();
      render();
      return;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      session.selectAll();
      render();
      return;
    }
    if (event.key === 'F2') {
      event.preventDefault();
      openEdit(null);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      session.clearSelection();
      render();
      return;
    }
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      const rect = activeBox.getBoundingClientRect();
      openMenu(rect.left, rect.bottom, cellMenuItems());
      return;
    }
    const extend = event.shiftKey;
    let handled = true;
    if (event.key === 'ArrowUp') session.move(-1, 0, extend);
    else if (event.key === 'ArrowDown') session.move(1, 0, extend);
    else if (event.key === 'ArrowLeft') session.move(0, -1, extend);
    else if (event.key === 'ArrowRight') session.move(0, 1, extend);
    else if (event.key === 'Tab') session.move(0, event.shiftKey ? -1 : 1, false);
    else if (event.key === 'Enter') session.move(event.shiftKey ? -1 : 1, 0, false);
    else if (event.key === 'Home') session.select(mod ? 0 : session.active.r, 0, extend);
    else if (event.key === 'End') {
      const used = session.grid();
      session.select(mod ? Math.max(0, used.usedRows - 1) : session.active.r, Math.max(0, used.usedCols - 1), extend);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
      session.move(event.key === 'PageDown' ? page : -page, 0, extend);
    } else if (mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      session.jump(dir[0], dir[1], extend);
    } else if (mod && event.key === 'PageUp') {
      const visible = session.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => !item.sheet.hidden);
      const at = visible.findIndex((item) => item.index === session.sheetIndex);
      session.setActiveSheet(visible[(at - 1 + visible.length) % visible.length].index);
    } else if (mod && event.key === 'PageDown') {
      const visible = session.book.sheets.map((sheet, index) => ({ sheet, index })).filter((item) => !item.sheet.hidden);
      const at = visible.findIndex((item) => item.index === session.sheetIndex);
      session.setActiveSheet(visible[(at + 1) % visible.length].index);
    } else if (event.key === ' ' && mod) session.selectCol();
    else if (event.key === ' ' && event.shiftKey) session.selectRow();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    afterMove();
  }

  scroller.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  });
  scroller.addEventListener('pointerdown', (event) => {
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
  scroller.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const pos = point(event);
    if (!pos) return;
    session.select(pos.r, pos.c, true);
    paint();
    renderChrome();
  });
  scroller.addEventListener('pointerup', () => {
    drag = false;
  });
  scroller.addEventListener('contextmenu', (event) => {
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

  editor.addEventListener('keydown', (event) => {
    if (!session.editing) {
      if (event.key === 'Process' || event.isComposing) return;
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        openEdit(event.key);
        return;
      }
      gridKey(event);
      return;
    }
    if (event.key === 'Enter' && !event.altKey) {
      event.preventDefault();
      session.setDraft(editor.value);
      session.commit(event.shiftKey ? -1 : 1, 0);
      afterMove();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      session.setDraft(editor.value);
      session.commit(0, event.shiftKey ? -1 : 1);
      afterMove();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      session.cancel();
      editor.value = '';
      render();
      editor.focus();
      return;
    }
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      const start = editor.selectionStart;
      editor.value = `${editor.value.slice(0, start)}\n${editor.value.slice(editor.selectionEnd)}`;
      editor.setSelectionRange(start + 1, start + 1);
      session.setDraft(editor.value);
      formula.value = editor.value;
      placeEditor();
    }
  });
  editor.addEventListener('compositionstart', () => {
    if (!session.editing) openEdit('');
  });
  editor.addEventListener('input', () => {
    if (!session.editing) session.startEdit(editor.value);
    session.setDraft(editor.value);
    formula.value = editor.value;
    placeEditor();
  });

  formula.addEventListener('focus', () => {
    if (!session.editing) session.startEdit(null);
    formula.value = session.draft;
  });
  formula.addEventListener('input', () => {
    session.setDraft(formula.value);
    editor.value = formula.value;
    placeEditor();
  });
  formula.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      session.setDraft(formula.value);
      session.commit(1, 0);
      afterMove();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      session.cancel();
      render();
      editor.focus();
    }
  });
  nameBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    session.goTo(nameBox.value);
    afterMove();
  });
  nameBox.addEventListener('blur', () => {
    nameBox.value = formatAddress(session.active.c, session.active.r);
  });

  app.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'undo') {
      session.undo();
      render();
    } else if (act === 'redo') {
      session.redo();
      render();
    } else if (act === 'theme') {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      enso.setTheme?.(next);
      applyTheme(next);
    } else if (act === 'all') {
      session.selectAll();
      render();
    }
  });
  colTrack.addEventListener('pointerdown', (event) => {
    const col = Number(event.target.dataset.col);
    if (!Number.isInteger(col)) return;
    session.active = { r: session.active.r, c: col };
    if (event.shiftKey) session.anchor = { ...session.anchor, c: session.anchor.c };
    else session.anchor = { r: 0, c: col };
    session.active = { r: session.grid().rows - 1, c: col };
    session.editing = false;
    render();
  });
  rowTrack.addEventListener('pointerdown', (event) => {
    const row = Number(event.target.dataset.row);
    if (!Number.isInteger(row)) return;
    if (!event.shiftKey) session.anchor = { r: row, c: 0 };
    session.active = { r: row, c: session.grid().cols - 1 };
    session.editing = false;
    render();
  });

  app.addEventListener('copy', (event) => {
    if (event.target === formula || event.target === nameBox || event.target.classList?.contains('rename')) return;
    if (session.editing && event.target === editor) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', session.copyText());
  });
  app.addEventListener('cut', (event) => {
    if (session.editing && event.target === editor) return;
    if (event.target === formula || event.target === nameBox) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', session.copyText());
    session.clearSelection();
    render();
  });
  app.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    if ((event.target === editor || event.target === formula) && !text.includes('\t') && !text.includes('\n')) return;
    event.preventDefault();
    if (session.editing) session.cancel();
    session.paste(text);
    render();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', () => paint());
  render();
  editor.focus();
}
