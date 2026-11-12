(() => {
  const enso = window.enso;
  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat('zh-CN');

  const state = {
    rel: '',
    locked: Boolean(enso?.file?.rel),
    info: null,
    mode: 'data',
    table: null,
    page: 0,
    pageSize: 100,
    sort: null,
    filters: {},
    search: '',
    grid: null,
    sqlGrid: null,
    schema: null,
    selection: null,
    sqlSelection: null,
    token: 0,
    busy: false,
  };

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  };
  applyTheme(enso?.theme || 'light');
  enso?.onTheme?.(applyTheme);
  window.ensoUI?.tooltip?.();
  window.ensoUI?.seg?.($('modes'));
  window.ensoUI?.fill?.($('objects'));

  const messageOf = (error) => (error instanceof Error ? error.message : String(error || '出错了'));
  const isCancel = (error) => messageOf(error) === '已取消';

  function showError(error) {
    const el = $('error');
    el.hidden = false;
    el.textContent = messageOf(error);
  }
  function clearError() {
    $('error').hidden = true;
    $('error').textContent = '';
  }
  function setNotice(text) {
    const el = $('notice');
    el.hidden = !text;
    el.textContent = text || '';
  }
  function setBusy(busy) {
    state.busy = busy;
    $('run').disabled = busy;
    $('cancel').disabled = !busy;
    $('refresh').disabled = busy;
  }

  function storageGet(key) {
    try {
      return enso?.storage?.get(key) ?? null;
    } catch {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      enso?.storage?.set(key, value);
    } catch {
      /* 页面状态写失败时忽略 */
    }
  }

  function recentPaths() {
    try {
      const parsed = JSON.parse(storageGet('recent') || '[]');
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  function remember(rel) {
    const next = [rel, ...recentPaths().filter((item) => item !== rel)].slice(0, 8);
    storageSet('recent', JSON.stringify(next));
    renderRecent();
  }

  function renderRecent() {
    const host = $('recent');
    host.replaceChildren();
    if (state.locked) return;
    for (const rel of recentPaths()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = rel;
      button.addEventListener('click', () => {
        $('path').value = rel;
        void openRel(rel);
      });
      host.append(button);
    }
  }

  function syncMode() {
    for (const button of $('modes').querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-selected', button.dataset.mode === state.mode ? 'true' : 'false');
    }
    window.ensoUI?.seg?.($('modes'));
    $('panel-data').hidden = state.mode !== 'data';
    $('panel-sql').hidden = state.mode !== 'sql';
    $('panel-schema').hidden = state.mode !== 'schema';
    $('aside').hidden = state.mode !== 'data';
    $('sql-hint').hidden = state.mode !== 'sql';
  }

  function renderObjects() {
    const host = $('objects');
    host.replaceChildren();
    const objects = state.info?.objects ?? [];
    if (!objects.length) {
      const empty = document.createElement('div');
      empty.className = 'ui-empty';
      empty.textContent = '这个库里没有表或视图';
      host.append(empty);
      return;
    }
    for (const object of objects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.fill = '';
      if (object.name === state.table) button.setAttribute('aria-current', 'true');
      const name = document.createElement('span');
      name.textContent = object.name;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = object.type === 'view' ? '视图' : '表';
      button.append(name, kind);
      button.addEventListener('click', () => {
        if (state.table === object.name) return;
        state.table = object.name;
        state.page = 0;
        state.sort = null;
        state.filters = {};
        state.selection = null;
        renderObjects();
        void loadRows();
      });
      host.append(button);
    }
  }

  function cellPlain(cell) {
    if (!cell || cell.t === 'null') return '';
    if (cell.t === 'blob') return cell.v ? `x'${cell.v}'` : '';
    return cell.v ?? '';
  }

  function renderGrid(target, result, which) {
    const host = $(target);
    const active = document.activeElement;
    const filtering = active?.classList?.contains('ui-input') && host.contains(active);
    const caret = filtering ? active.selectionStart : null;
    const filterKey = filtering ? active.getAttribute('aria-label') : null;
    host.replaceChildren();
    if (!result) return;
    if (!result.columns.length) {
      const empty = document.createElement('div');
      empty.className = 'ui-empty';
      empty.textContent = result.message || '没有返回行';
      host.append(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'data';
    const thead = document.createElement('thead');
    const names = document.createElement('tr');
    names.className = 'names';
    const filters = document.createElement('tr');
    filters.className = 'filters';
    const corner = document.createElement('th');
    corner.className = 'rownum';
    corner.textContent = '#';
    names.append(corner);
    const filterCorner = document.createElement('th');
    filterCorner.className = 'rownum';
    filters.append(filterCorner);
    result.columns.forEach((column, index) => {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort';
      const label = document.createElement('span');
      label.textContent = column;
      button.append(label);
      const sort = which === 'data' ? state.sort : state.sqlSort;
      if (sort?.index === index) {
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = sort.dir === 'desc' ? '▼' : '▲';
        button.append(mark);
        th.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
      }
      button.addEventListener('click', () => cycleSort(which, index));
      th.append(button);
      names.append(th);
      const filterCell = document.createElement('th');
      const input = document.createElement('input');
      input.className = 'ui-input';
      input.placeholder = '筛选';
      input.setAttribute('aria-label', `筛选 ${column}`);
      input.value = (which === 'data' ? state.filters : state.sqlFilters)[index] || '';
      input.addEventListener('input', () => {
        const bag = which === 'data' ? state.filters : state.sqlFilters;
        if (input.value) bag[index] = input.value;
        else delete bag[index];
        if (which === 'data') state.page = 0;
        else state.sqlPage = 0;
        schedule(which);
      });
      filterCell.append(input);
      filters.append(filterCell);
    });
    thead.append(names, filters);
    const tbody = document.createElement('tbody');
    if (!result.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = result.columns.length + 1;
      td.textContent = '没有匹配的行';
      tr.append(td);
      tbody.append(tr);
    }
    const selection = which === 'data' ? state.selection : state.sqlSelection;
    result.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const head = document.createElement('td');
      head.className = 'rownum';
      const absolute = (result.page || 0) * (result.pageSize || state.pageSize) + rowIndex + 1;
      head.textContent = numberFormat.format(absolute);
      head.addEventListener('click', (event) => selectRow(which, rowIndex, event.shiftKey));
      tr.append(head);
      row.forEach((cell, column) => {
        const td = document.createElement('td');
        td.dataset.row = String(rowIndex);
        td.dataset.col = String(column);
        if (cell.t === 'null') {
          td.classList.add('null');
          td.textContent = 'NULL';
        } else if (cell.t === 'blob') {
          td.classList.add('blob');
          td.textContent = `BLOB · ${numberFormat.format(cell.n || 0)} 字节`;
        } else {
          if (cell.t === 'int' || cell.t === 'float') td.classList.add('num');
          td.textContent = cell.v ?? '';
        }
        if (selection && inRange(selection, rowIndex, column)) td.classList.add('selected');
        if (selection && selection.focusR === rowIndex && selection.focusC === column) td.classList.add('active');
        td.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          selectCell(which, rowIndex, column, event.shiftKey);
        });
        td.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (!selection || !inRange(selection, rowIndex, column)) selectCell(which, rowIndex, column, false);
          openMenu(event.clientX, event.clientY, which);
        });
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    host.append(table);
    if (filterKey) {
      const next = [...host.querySelectorAll('thead input')].find((input) => input.getAttribute('aria-label') === filterKey);
      if (next) {
        next.focus();
        if (caret != null) next.setSelectionRange(caret, caret);
      }
    }
  }

  function inRange(selection, row, column) {
    const r0 = Math.min(selection.anchorR, selection.focusR);
    const r1 = Math.max(selection.anchorR, selection.focusR);
    const c0 = Math.min(selection.anchorC, selection.focusC);
    const c1 = Math.max(selection.anchorC, selection.focusC);
    return row >= r0 && row <= r1 && column >= c0 && column <= c1;
  }

  function gridOf(which) {
    return which === 'data' ? state.grid : state.sqlGrid;
  }

  function selectCell(which, row, column, extend) {
    const current = which === 'data' ? state.selection : state.sqlSelection;
    const next = extend && current
      ? { ...current, focusR: row, focusC: column }
      : { anchorR: row, focusR: row, anchorC: column, focusC: column };
    if (which === 'data') state.selection = next;
    else state.sqlSelection = next;
    renderGrid(which === 'data' ? 'grid-data' : 'grid-sql', gridOf(which), which);
    void showDetail();
  }

  function selectRow(which, row, extend) {
    const grid = gridOf(which);
    if (!grid?.columns.length) return;
    const last = grid.columns.length - 1;
    const current = which === 'data' ? state.selection : state.sqlSelection;
    const next = extend && current
      ? { ...current, focusR: row, focusC: last }
      : { anchorR: row, focusR: row, anchorC: 0, focusC: last };
    if (which === 'data') state.selection = next;
    else state.sqlSelection = next;
    renderGrid(which === 'data' ? 'grid-data' : 'grid-sql', grid, which);
    void showDetail();
  }

  function cycleSort(which, index) {
    const key = which === 'data' ? 'sort' : 'sqlSort';
    const current = state[key];
    let next = { index, dir: 'asc' };
    if (current?.index === index && current.dir === 'asc') next = { index, dir: 'desc' };
    else if (current?.index === index && current.dir === 'desc') next = null;
    state[key] = next;
    if (which === 'data') {
      state.page = 0;
      void loadRows();
    } else {
      state.sqlPage = 0;
      void runQuery();
    }
  }

  let timer = 0;
  function schedule(which) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (which === 'data') void loadRows();
      else void runQuery();
    }, 200);
  }

  function updatePageLabel() {
    const result = state.grid;
    const label = $('page-label');
    if (!result) {
      label.textContent = '';
      $('prev').disabled = true;
      $('next').disabled = true;
      return;
    }
    const start = result.total === 0 ? 0 : result.page * result.pageSize + 1;
    const end = result.page * result.pageSize + result.rows.length;
    const cap = result.capped ? ' · 只处理了前 1 万行' : '';
    label.textContent = result.total
      ? `第 ${numberFormat.format(start)}–${numberFormat.format(end)} 行，共 ${numberFormat.format(result.total)} 行 · ${result.elapsedMs} ms${cap}`
      : `没有匹配的行 · ${result.elapsedMs} ms${cap}`;
    $('prev').disabled = result.page <= 0;
    $('next').disabled = (result.page + 1) * result.pageSize >= result.total;
  }

  async function showDetail() {
    const detail = $('detail');
    const selection = state.selection;
    const grid = state.grid;
    if (!selection || !grid) {
      detail.textContent = '选择一个单元格查看完整内容';
      return;
    }
    const same = selection.anchorR === selection.focusR && selection.anchorC === selection.focusC;
    if (!same) {
      const rows = Math.abs(selection.focusR - selection.anchorR) + 1;
      const cols = Math.abs(selection.focusC - selection.anchorC) + 1;
      detail.textContent = `已选 ${rows * cols} 个单元格`;
      return;
    }
    const packed = grid.rows[selection.focusR]?.[selection.focusC];
    const name = grid.columns[selection.focusC] ?? '';
    if (!packed) {
      detail.textContent = '';
      return;
    }
    let cell = packed;
    if (packed.cut && state.mode === 'data') {
      try {
        const full = await enso.call('cell', {
          rel: state.rel,
          kind: 'table',
          table: state.table,
          row: grid.page * grid.pageSize + selection.focusR,
          column: selection.focusC,
          sort: state.sort,
          filters: state.filters,
          search: state.search,
        });
        cell = full.cell;
      } catch (error) {
        if (!isCancel(error)) showError(error);
      }
    }
    detail.replaceChildren();
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    detail.append(label, document.createTextNode(formatDetail(cell)));
  }

  function formatDetail(cell) {
    if (!cell || cell.t === 'null') return 'NULL';
    if (cell.t === 'blob') {
      const hex = cell.v ? cell.v.replace(/(.{2})/g, '$1 ').trim() : '（空）';
      const tail = cell.cut ? `\n… 已截断，共 ${numberFormat.format(cell.n || 0)} 字节` : '';
      return `${hex}${tail}`;
    }
    const tail = cell.cut ? `\n… 已截断，共 ${numberFormat.format(cell.n || cell.v.length)} 个字符` : '';
    return `${cell.v ?? ''}${tail}`;
  }

  async function loadRows() {
    if (!state.rel || !state.table) return;
    const mine = ++state.token;
    setBusy(true);
    clearError();
    try {
      const result = await enso.call('rows', {
        rel: state.rel,
        table: state.table,
        page: state.page,
        pageSize: state.pageSize,
        sort: state.sort,
        filters: state.filters,
        search: state.search,
      });
      if (mine !== state.token) return;
      state.grid = result;
      state.selection = null;
      renderGrid('grid-data', result, 'data');
      updatePageLabel();
      $('detail').textContent = '选择一个单元格查看完整内容';
    } catch (error) {
      if (mine !== state.token || isCancel(error)) return;
      showError(error);
    } finally {
      if (mine === state.token) setBusy(false);
    }
  }

  async function runQuery() {
    if (!state.rel) return;
    const sql = selectedSql();
    if (!sql.trim()) {
      showError('请输入 SQL');
      return;
    }
    const mine = ++state.token;
    setBusy(true);
    clearError();
    try {
      const result = await enso.call('query', {
        rel: state.rel,
        sql,
        page: state.sqlPage || 0,
        pageSize: state.pageSize,
        sort: state.sqlSort,
        filters: state.sqlFilters,
        search: '',
      });
      if (mine !== state.token) return;
      state.sqlGrid = result;
      state.sqlSelection = null;
      state.lastSql = sql;
      $('sql-message').textContent = result.message || '';
      renderGrid('grid-sql', result, 'sql');
    } catch (error) {
      if (mine !== state.token || isCancel(error)) return;
      showError(error);
    } finally {
      if (mine === state.token) setBusy(false);
    }
  }

  function selectedSql() {
    const box = $('sql');
    const start = box.selectionStart;
    const end = box.selectionEnd;
    if (start != null && end != null && end > start) return box.value.slice(start, end);
    return box.value;
  }

  async function loadSchema() {
    if (!state.rel) return;
    if (state.schema) {
      renderSchema();
      return;
    }
    setBusy(true);
    clearError();
    try {
      state.schema = await enso.call('schema', { rel: state.rel });
      renderSchema();
    } catch (error) {
      if (!isCancel(error)) showError(error);
    } finally {
      setBusy(false);
    }
  }

  function renderSchema() {
    const host = $('schema');
    host.replaceChildren();
    const groups = state.schema?.groups ?? [];
    if (!groups.some((group) => group.items.length)) {
      const empty = document.createElement('div');
      empty.className = 'ui-empty';
      empty.textContent = '没有结构对象';
      host.append(empty);
      return;
    }
    for (const group of groups) {
      if (!group.items.length) continue;
      const heading = document.createElement('h3');
      heading.textContent = `${group.title} · ${group.items.length}`;
      host.append(heading);
      for (const item of group.items) {
        const article = document.createElement('article');
        const name = document.createElement('div');
        name.className = 'name';
        const title = document.createElement('span');
        title.textContent = item.name;
        name.append(title);
        if (item.table && item.table !== item.name) {
          const on = document.createElement('button');
          on.type = 'button';
          on.className = 'ui-btn ui-btn--sm';
          on.textContent = item.table;
          on.addEventListener('click', () => focusObject(item.table));
          name.append(on);
        } else if (group.id === 'table' || group.id === 'view') {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'ui-btn ui-btn--sm';
          open.textContent = '查看数据';
          open.addEventListener('click', () => focusObject(item.name));
          name.append(open);
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ui-btn ui-btn--sm';
        copy.textContent = '复制';
        copy.disabled = !item.sql;
        copy.addEventListener('click', () => void writeClipboard(item.sql || ''));
        name.append(copy);
        const pre = document.createElement('pre');
        pre.textContent = item.sql || '（无 CREATE 语句）';
        article.append(name, pre);
        host.append(article);
      }
    }
  }

  function focusObject(name) {
    if (!state.info?.objects.some((object) => object.name === name)) return;
    state.table = name;
    state.page = 0;
    state.sort = null;
    state.filters = {};
    state.mode = 'data';
    syncMode();
    renderObjects();
    void loadRows();
  }

  async function openRel(rel) {
    const path = String(rel || '').trim();
    if (!path) {
      showError('请输入相对路径');
      return;
    }
    clearError();
    setBusy(true);
    state.token += 1;
    try {
      const info = await enso.call('open', { rel: path });
      state.rel = info.rel;
      state.info = info;
      state.table = info.objects[0]?.name ?? null;
      state.page = 0;
      state.sort = null;
      state.filters = {};
      state.schema = null;
      state.grid = null;
      state.sqlGrid = null;
      state.selection = null;
      $('title').textContent = info.name;
      $('meta').textContent = info.sizeLabel;
      $('path').value = info.rel;
      $('refresh').hidden = false;
      $('tabs').hidden = false;
      $('workspace').hidden = false;
      $('picker-help').hidden = true;
      $('recent').hidden = true;
      $('found').hidden = true;
      if (state.locked) $('picker').hidden = true;
      setNotice(info.notice);
      remember(info.rel);
      syncMode();
      renderObjects();
      if (state.table) await loadRows();
      else {
        $('grid-data').replaceChildren();
        updatePageLabel();
      }
    } catch (error) {
      if (!isCancel(error)) showError(error);
    } finally {
      setBusy(false);
    }
  }

  function selectionRange(which) {
    const selection = which === 'data' ? state.selection : state.sqlSelection;
    const grid = gridOf(which);
    if (!selection || !grid) return null;
    return {
      r0: Math.min(selection.anchorR, selection.focusR),
      r1: Math.max(selection.anchorR, selection.focusR),
      c0: Math.min(selection.anchorC, selection.focusC),
      c1: Math.max(selection.anchorC, selection.focusC),
      grid,
    };
  }

  function tsvOf(which, withHeader) {
    const range = selectionRange(which);
    if (!range) return '';
    const lines = [];
    if (withHeader) lines.push(range.grid.columns.slice(range.c0, range.c1 + 1).join('\t'));
    for (let row = range.r0; row <= range.r1; row += 1) {
      const cells = [];
      for (let column = range.c0; column <= range.c1; column += 1) {
        cells.push(cellPlain(range.grid.rows[row]?.[column]).replace(/[\t\r\n]/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }

  async function writeClipboard(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    if (!ok && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) showError('无法写入剪贴板');
    return ok;
  }

  function openMenu(x, y, which) {
    const menu = $('menu');
    menu.replaceChildren();
    const add = (label, run) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        menu.hidden = true;
        void run();
      });
      menu.append(button);
    };
    add('复制', () => writeClipboard(tsvOf(which, false)));
    add('复制（含列名）', () => writeClipboard(tsvOf(which, true)));
    add('导出 CSV', () => exportResult(which));
    menu.hidden = false;
    menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
  }

  async function exportResult(which) {
    if (!state.rel) return;
    setBusy(true);
    clearError();
    try {
      const payload = which === 'sql'
        ? {
            rel: state.rel,
            kind: 'sql',
            sql: state.lastSql || selectedSql(),
            sort: state.sqlSort,
            filters: state.sqlFilters,
            search: '',
          }
        : {
            rel: state.rel,
            kind: 'table',
            table: state.table,
            sort: state.sort,
            filters: state.filters,
            search: state.search,
          };
      const result = await enso.call('export', payload);
      if (!result.csv) {
        showError('没有可导出的行');
        return;
      }
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${(state.info?.name || 'sqlite').replace(/\.(db|sqlite3?)$/i, '')}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      await writeClipboard(result.csv);
      const tail = result.truncated ? '，已达到单次导出上限' : '';
      $('sql-message').textContent = which === 'sql' ? `已复制 ${result.rows} 行 CSV${tail}` : '';
      if (which === 'data') setNotice(`已复制 ${numberFormat.format(result.rows)} 行 CSV${tail}。页面若不能弹出保存对话框，请直接粘贴。`);
    } catch (error) {
      if (!isCancel(error)) showError(error);
    } finally {
      setBusy(false);
    }
  }

  state.sqlSort = null;
  state.sqlFilters = {};
  state.sqlPage = 0;
  state.lastSql = '';

  $('modes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    state.mode = button.dataset.mode;
    syncMode();
    if (state.mode === 'schema') void loadSchema();
    if (state.mode === 'data') renderGrid('grid-data', state.grid, 'data');
  });

  $('open-path').addEventListener('click', () => void openRel($('path').value));
  $('path').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openRel($('path').value);
  });
  $('refresh').addEventListener('click', () => void openRel(state.rel || $('path').value));
  $('find').addEventListener('click', async () => {
    clearError();
    setBusy(true);
    try {
      const result = await enso.call('find', {});
      const host = $('found');
      host.hidden = false;
      host.replaceChildren();
      if (!result.files.length) {
        const empty = document.createElement('p');
        empty.textContent = '项目里没有找到 .db、.sqlite、.sqlite3 文件。';
        host.append(empty);
        return;
      }
      for (const rel of result.files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = rel;
        button.addEventListener('click', () => {
          $('path').value = rel;
          void openRel(rel);
        });
        host.append(button);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  });
  $('search').addEventListener('input', () => {
    state.search = $('search').value;
    state.page = 0;
    schedule('data');
  });
  $('prev').addEventListener('click', () => {
    if (state.page <= 0) return;
    state.page -= 1;
    void loadRows();
  });
  $('next').addEventListener('click', () => {
    state.page += 1;
    void loadRows();
  });
  $('page-size').addEventListener('change', () => {
    state.pageSize = Number($('page-size').value) || 100;
    state.page = 0;
    storageSet('pageSize', String(state.pageSize));
    if (state.table) void loadRows();
  });
  $('run').addEventListener('click', () => void runQuery());
  $('cancel').addEventListener('click', () => {
    state.token += 1;
    setBusy(false);
    if (state.rel) void enso.call('cancel', { rel: state.rel });
  });
  $('export-data').addEventListener('click', () => void exportResult('data'));
  $('export-sql').addEventListener('click', () => void exportResult('sql'));
  $('sql').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      state.sqlPage = 0;
      void runQuery();
    }
  });
  $('sql').addEventListener('input', () => storageSet('sql', $('sql').value));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const which = state.mode === 'sql' ? 'sql' : 'data';
      const text = tsvOf(which, false);
      if (!text) return;
      event.preventDefault();
      void writeClipboard(text);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('menu').contains(event.target)) $('menu').hidden = true;
  });

  const savedSize = Number(storageGet('pageSize'));
  if ([50, 100, 200].includes(savedSize)) {
    state.pageSize = savedSize;
    $('page-size').value = String(savedSize);
  }
  const savedSql = storageGet('sql');
  if (savedSql) $('sql').value = savedSql;
  renderRecent();

  if (!enso?.call) {
    showError('请在 Enso 里打开这个页面。');
    return;
  }
  if (enso.file?.rel) {
    $('refresh').hidden = false;
    $('picker-help').textContent = '正在从项目里读取这个数据库。查看器只读，不会把内容写回编辑区。';
    $('path').value = enso.file.rel;
    $('path').disabled = true;
    $('open-path').hidden = true;
    $('find').hidden = true;
    void openRel(enso.file.rel);
    enso.file.onChange?.((next) => {
      if (next?.rel && next.rel !== state.rel) void openRel(next.rel);
    });
  }
})();
