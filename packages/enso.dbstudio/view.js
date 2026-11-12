const enso = window.enso;
const fileMode = Boolean(enso.file);
const $ = (id) => document.getElementById(id);
const sqlInput = $('sql');
const paint = $('paint');
const gutter = $('gutter');
const suggest = $('suggest');

const KEYWORDS = new Set(
  `select from where limit offset fetch insert update delete join left right full inner outer on as and or not null is in like ilike order by group having with union all distinct create table view drop alter values returning case when then else end exists between asc desc true false explain show set into using primary key references default check index cascade replace describe desc pragma use begin commit rollback`.split(/\s+/),
);

let model = { connections: [], env: null, rowLimit: 100, hardCap: 5000 };
let active = null;
let database = '';
let schema = '';
let opened = {};
let tables = [];
let result = null;
let running = false;
let inflight = null;
let selectedCell = null;
let suggestItems = [];
let suggestAt = 0;
let editing = null;
let writingFile = false;

const storage = {
  get(key) {
    try {
      return enso.storage.get(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      enso.storage.set(key, value);
    } catch {
      // 页面状态满了或不可用时，草稿只留在当前页。
    }
  },
};

function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function quoteIdent(engine, name) {
  const text = String(name ?? '');
  if (engine === 'mysql' || engine === 'mariadb') return `\`${text.replaceAll('`', '``')}\``;
  return `"${text.replaceAll('"', '""')}"`;
}

function engineOf(id) {
  if (model.env?.id === id) return model.env.engine;
  return model.connections.find((item) => item.id === id)?.engine || 'postgres';
}

function connectionOf(id) {
  if (model.env?.id === id) return model.env;
  return model.connections.find((item) => item.id === id) || null;
}

function badge(env) {
  if (!env) return '';
  return `<span class="ui-badge env-${esc(env)}">${esc(env)}</span>`;
}

function paintSql() {
  const text = sqlInput.value;
  const html = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      html.push(`<span class="com">${esc(text.slice(i, stop))}</span>`);
      i = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      html.push(`<span class="com">${esc(text.slice(i, stop))}</span>`);
      i = stop;
      continue;
    }
    const quote = text[i] === "'" || text[i] === '"' || text[i] === '`' ? text[i] : '';
    if (quote) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote && text[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      html.push(`<span class="str">${esc(text.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (/[0-9]/.test(text[i]) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1;
      html.push(`<span class="num">${esc(text.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      html.push(KEYWORDS.has(word.toLowerCase()) ? `<span class="kw">${esc(word)}</span>` : esc(word));
      i = j;
      continue;
    }
    html.push(esc(text[i]));
    i += 1;
  }
  paint.innerHTML = `${html.join('')}\n`;
  const lines = text.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_item, index) => index + 1).join('\n');
}

function syncScroll() {
  paint.scrollTop = sqlInput.scrollTop;
  paint.scrollLeft = sqlInput.scrollLeft;
  gutter.scrollTop = sqlInput.scrollTop;
}

function tokenAt(cursor) {
  const text = sqlInput.value.slice(0, cursor);
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text);
  return match ? { word: match[0], start: cursor - match[0].length } : null;
}

function suggestions() {
  const token = tokenAt(sqlInput.selectionStart);
  const word = (token?.word || '').toLowerCase();
  const items = [];
  for (const table of tables) {
    if (!word || table.name.toLowerCase().includes(word)) items.push({ label: table.name, detail: table.kind || 'table', insert: table.name });
    for (const column of table.columns || []) {
      if (word && column.toLowerCase().includes(word)) items.push({ label: column, detail: table.name, insert: column });
    }
  }
  for (const keyword of KEYWORDS) {
    if (word && keyword.startsWith(word) && keyword !== word) items.push({ label: keyword.toUpperCase(), detail: '关键字', insert: keyword.toUpperCase() });
  }
  return { token, items: items.slice(0, 12) };
}

function showSuggest(force) {
  const { token, items } = suggestions();
  if (!force && (!token || token.word.length < 1 || !items.length)) {
    suggest.hidden = true;
    return;
  }
  suggestItems = items;
  suggestAt = 0;
  suggest.hidden = !items.length;
  suggest.innerHTML = items
    .map((item, index) => `<button type="button" data-i="${index}" aria-selected="${index === 0}">${esc(item.label)} <span class="muted">${esc(item.detail)}</span></button>`)
    .join('');
}

function applySuggest(index) {
  const item = suggestItems[index];
  const token = tokenAt(sqlInput.selectionStart);
  if (!item || !token) return;
  const value = sqlInput.value;
  sqlInput.value = value.slice(0, token.start) + item.insert + value.slice(sqlInput.selectionStart);
  const next = token.start + item.insert.length;
  sqlInput.setSelectionRange(next, next);
  suggest.hidden = true;
  paintSql();
}

function setBanner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
}

function renderStatus(text) {
  $('status').textContent = text;
}

function renderHeader() {
  const current = connectionOf(active);
  const badgeEl = $('badge');
  if (current?.env) {
    badgeEl.hidden = false;
    badgeEl.className = `ui-badge env-${current.env}`;
    badgeEl.textContent = current.env;
  } else if (current?.source === 'env') {
    badgeEl.hidden = false;
    badgeEl.className = 'ui-badge';
    badgeEl.textContent = 'env';
  } else badgeEl.hidden = true;
  $('title').textContent = current ? current.name : 'DB Studio';
  $('run').disabled = running || !active;
  $('cancel').disabled = !running;
}

function renderTree() {
  const host = $('tree');
  host.innerHTML = '';
  const items = [...(model.env ? [model.env] : []), ...model.connections];
  if (!items.length) {
    host.innerHTML = '<p class="muted">还没有连接。可以新建，或者在项目的 .env 里提供连接串。</p>';
    return;
  }
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'conn';
    row.dataset.id = item.id;
    row.tabIndex = 0;
    const label = document.createElement('span');
    label.textContent = item.name;
    row.append(label);
    if (item.env) {
      const pill = document.createElement('span');
      pill.className = `ui-badge env-${item.env}`;
      pill.textContent = item.env;
      row.append(pill);
    } else if (item.source === 'env') {
      const pill = document.createElement('span');
      pill.className = 'ui-badge';
      pill.textContent = 'env';
      row.append(pill);
    }
    const meta = document.createElement('span');
    meta.className = 'kind';
    meta.textContent = item.engine;
    row.append(meta);
    row.addEventListener('click', () => {
      activateConnection(item.id).catch((error) => setBanner(error.message || String(error)));
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && item.source !== 'env') {
        event.preventDefault();
        openForm(item);
      }
    });
    host.append(row);
    const node = opened[item.id];
    if (node?.databases) renderLevel(host, item.id, node.databases, 1);
  }
}

function renderLevel(host, connectionId, nodes, depth) {
  for (const node of nodes) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'node';
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.textContent = node.name;
    if (node.kind === 'view' || node.kind === 'table') {
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = node.kind === 'view' ? 'view' : '';
      row.append(kind);
    }
    row.addEventListener('click', () => toggleNode(connectionId, node));
    host.append(row);
    if (node.children) renderLevel(host, connectionId, node.children, depth + 1);
  }
}

async function activateConnection(id) {
  active = id;
  const current = connectionOf(id);
  database = current?.database || (current?.engine === 'sqlite' ? 'main' : '');
  schema = current?.engine === 'postgres' ? 'public' : database || 'main';
  storage.set('active', id);
  renderHeader();
  await loadNode(id, {}, 'database');
  if (connectionOf(id)?.engine === 'sqlite') {
    const db = opened[id]?.databases?.[0];
    if (db) {
      await loadNode(id, db);
      const schemaNode = db.children?.[0];
      if (schemaNode) await loadNode(id, schemaNode);
    }
  }
}

async function loadNode(connectionId, node) {
  const args = { connectionId };
  if (node.database) args.database = node.database;
  if (node.schema) args.schema = node.schema;
  const data = await enso.call('tree', args);
  const children = (data.nodes || []).map((item) => ({ ...item, children: null }));
  const root = opened[connectionId] || { databases: null };
  if (!node.database) root.databases = children;
  else assignChildren(root.databases || [], node, children);
  opened[connectionId] = root;
  renderTree();
  if (node.schema) {
    const columns = await enso.call('columns', { connectionId, database: node.database, schema: node.schema });
    tables = columns.tables || [];
    database = node.database;
    schema = node.schema;
  }
}

function assignChildren(list, node, children) {
  for (const item of list) {
    if (item.name === node.name && item.database === node.database && (item.schema || '') === (node.schema || '')) {
      item.children = children;
      return true;
    }
    if (item.children && assignChildren(item.children, node, children)) return true;
  }
  return false;
}

async function toggleNode(connectionId, node) {
  active = connectionId;
  storage.set('active', connectionId);
  setBanner('');
  try {
    if (node.kind === 'table' || node.kind === 'view') {
      database = node.database;
      schema = node.schema;
      const engine = engineOf(connectionId);
      sqlInput.value = `SELECT * FROM ${schema ? `${quoteIdent(engine, schema)}.` : ''}${quoteIdent(engine, node.name)} LIMIT ${model.rowLimit}`;
      paintSql();
      await runQuery({ mode: 'table', table: node.name, database, schema });
      return;
    }
    if (node.children) {
      node.children = null;
      renderTree();
      return;
    }
    await loadNode(connectionId, node, node.kind === 'database' ? 'schema' : 'table');
  } catch (error) {
    setBanner(error.message || String(error));
  }
}

function renderGrid() {
  const host = $('grid');
  if (!result?.columns) {
    host.innerHTML = '';
    return;
  }
  const head = ['#', ...result.columns.map((column) => column.name)];
  const body = (result.rows || [])
    .map((row, index) => {
      const cells = row
        .map((cell, column) => {
          if (cell.t === 'null') return `<td class="null" data-r="${index}" data-c="${column}">NULL</td>`;
          const text = cell.t === 'blob' ? `<blob ${cell.n} B>` : cell.v;
          return `<td data-r="${index}" data-c="${column}" title="${esc(text)}">${esc(text)}</td>`;
        })
        .join('');
      return `<tr><td class="rowno">${(result.offset || 0) + index + 1}</td>${cells}</tr>`;
    })
    .join('');
  const more = result.done ? '' : `<p style="padding:8px 12px"><button id="more" class="ui-btn ui-btn--sm" type="button">继续读取</button></p>`;
  host.innerHTML = `<table class="data"><thead><tr>${head.map((name, index) => `<th class="${index === 0 ? 'rowno' : ''}">${esc(name)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${more}`;
  host.querySelector('#more')?.addEventListener('click', moreRows);
  host.querySelectorAll('td[data-r]').forEach((cell) => {
    cell.addEventListener('click', () => openCell(Number(cell.dataset.r), Number(cell.dataset.c), cell));
  });
}

async function openCell(row, column, element) {
  document.querySelectorAll('td.on').forEach((item) => item.classList.remove('on'));
  element.classList.add('on');
  const preview = result.rows[row - (result.offset || 0)]?.[column];
  let full = preview;
  if (preview?.cut && result.queryId) {
    try {
      full = await enso.call('cell', { queryId: result.queryId, row: row, column });
    } catch (error) {
      setBanner(error.message || String(error));
    }
  }
  const text = !full || full.t === 'null' || full.missing ? (preview?.t === 'null' ? 'NULL' : preview?.v || '') : full.t === 'blob' ? full.v : full.v;
  let shown = text ?? '';
  if (typeof shown === 'string' && /^[[{]/.test(shown.trim())) {
    try {
      shown = JSON.stringify(JSON.parse(shown), null, 2);
    } catch {
      // 不是 JSON，按原文显示。
    }
  }
  $('cell').hidden = false;
  $('cell').textContent = shown;
}

async function runQuery(extra) {
  if (!active || running) return;
  running = true;
  inflight = null;
  renderHeader();
  setBanner('');
  const started = performance.now();
  try {
    const payload = await enso.call('query', {
      connectionId: active,
      database,
      schema,
      sql: sqlInput.value,
      selectionStart: sqlInput.selectionStart,
      selectionEnd: sqlInput.selectionEnd,
      cursor: sqlInput.selectionStart,
      ...extra,
    });
    result = { ...payload, offset: 0 };
    if (payload.cancelled) {
      renderStatus('已取消');
      return;
    }
    renderGrid();
    const notes = [];
    notes.push(`${payload.shown ?? payload.rows?.length ?? 0} 行`);
    notes.push(`${payload.tookMs ?? Math.round(performance.now() - started)} ms`);
    if (payload.bounded) notes.push(`已限制为 ${model.rowLimit} 行`);
    if (payload.hitCap) notes.push(`已到 ${model.hardCap} 行上限`);
    if (payload.affected) notes.push(`影响 ${payload.affected} 行`);
    renderStatus(notes.join(' · '));
    $('cell').hidden = true;
  } catch (error) {
    setBanner(error.message || String(error));
    renderStatus('查询失败');
  } finally {
    running = false;
    inflight = null;
    renderHeader();
  }
}

async function moreRows() {
  if (!result?.queryId || running) return;
  running = true;
  renderHeader();
  try {
    const payload = await enso.call('more', { queryId: result.queryId });
    if (payload.cancelled) {
      renderStatus('已取消');
      return;
    }
    const offset = result.rows.length;
    result = { ...result, ...payload, rows: [...result.rows, ...(payload.rows || [])], offset: 0 };
    renderGrid();
    renderStatus(`${result.shown ?? result.rows.length} 行 · ${payload.tookMs ?? 0} ms${payload.hitCap ? ` · 已到 ${model.hardCap} 行上限` : ''}`);
    selectedCell = offset;
  } catch (error) {
    setBanner(error.message || String(error));
  } finally {
    running = false;
    renderHeader();
  }
}

async function cancelQuery() {
  if (!inflight) return;
  try {
    await enso.call('cancel', { queryId: inflight });
  } catch (error) {
    setBanner(error.message || String(error));
  }
}

function formData() {
  const form = new FormData($('form'));
  const engine = form.get('engine');
  const file = form.get('file');
  return {
    id: editing?.id,
    name: String(form.get('name') || '').trim(),
    engine,
    env: form.get('env') || '',
    host: String(form.get('host') || '').trim(),
    port: Number(form.get('port') || (engine === 'postgres' ? 5432 : 3306)),
    user: String(form.get('user') || ''),
    password: String(form.get('password') || ''),
    database: String(form.get('database') || '').trim(),
    sslmode: form.get('sslmode') || 'disable',
    path: String(form.get('path') || file || '').trim(),
  };
}

function toggleEngineFields() {
  const sqlite = $('form').engine.value === 'sqlite';
  $('server-fields').hidden = sqlite;
  $('sqlite-fields').hidden = !sqlite;
}

async function openForm(connection) {
  editing = connection || null;
  $('form-title').textContent = connection ? '编辑连接' : '新建连接';
  $('remove').hidden = !connection || connection.source === 'env';
  const form = $('form');
  form.name.value = connection?.name || '';
  form.engine.value = connection?.engine || 'postgres';
  form.env.value = connection?.env || '';
  form.host.value = connection?.host || '';
  form.port.value = connection?.port || (form.engine.value === 'postgres' ? 5432 : 3306);
  form.user.value = connection?.user || '';
  form.password.value = '';
  form.database.value = connection?.database || '';
  form.sslmode.value = connection?.sslmode || 'disable';
  form.path.value = connection?.path || '';
  form.url.value = '';
  toggleEngineFields();
  try {
    const listed = await enso.call('files', {});
    form.file.innerHTML = `<option value="">选择项目里的文件</option>${(listed.files || []).map((file) => `<option>${esc(file)}</option>`).join('')}`;
  } catch {
    form.file.innerHTML = '<option value="">当前没有项目目录</option>';
  }
  $('dialog').hidden = false;
}

function applyUrl() {
  const raw = $('form').url.value.trim();
  if (!raw) return;
  const parsed = parseUrl(raw);
  if (!parsed) {
    setBanner('连接串无法解析');
    return;
  }
  const form = $('form');
  form.engine.value = parsed.engine;
  if (parsed.engine === 'sqlite') form.path.value = parsed.path || '';
  else {
    form.host.value = parsed.host || '';
    form.port.value = parsed.port || '';
    form.user.value = parsed.user || '';
    form.password.value = parsed.password || '';
    form.database.value = parsed.database || '';
    form.sslmode.value = parsed.sslmode || 'disable';
  }
  toggleEngineFields();
}

function parseUrl(text) {
  if (/^(sqlite|file):/i.test(text)) {
    const body = text.replace(/^(sqlite|file):/i, '').split('?')[0];
    const path = body.startsWith('///') ? body.slice(2) : body;
    return { engine: 'sqlite', path };
  }
  try {
    const url = new URL(text);
    const scheme = url.protocol.replace(':', '');
    const engine = scheme === 'postgresql' ? 'postgres' : scheme === 'mysql2' ? 'mysql' : scheme;
    if (!['postgres', 'mysql', 'mariadb'].includes(engine)) return null;
    let host = url.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    const ssl = (url.searchParams.get('sslmode') || '').toLowerCase();
    return {
      engine,
      host,
      port: url.port || (engine === 'postgres' ? 5432 : 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\/+/, '')),
      sslmode: ssl === 'verify-full' ? 'verify-full' : ssl === 'require' || ssl === 'verify-ca' ? 'require' : 'disable',
    };
  } catch {
    return null;
  }
}

async function refresh() {
  model = await enso.call('state', {});
  if (!active) active = storage.get('active') || model.env?.id || model.connections[0]?.id || null;
  renderHeader();
  renderTree();
  if (model.envError) setBanner(model.envError);
}

$('sql').addEventListener('input', () => {
  paintSql();
  showSuggest(false);
  if (fileMode && !writingFile) {
    clearTimeout(showSuggest._timer);
    showSuggest._timer = setTimeout(() => enso.file.update(sqlInput.value), 200);
  } else if (!fileMode) storage.set('draft', sqlInput.value.slice(0, 100000));
});
sqlInput.addEventListener('scroll', syncScroll);
sqlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void runQuery({});
    return;
  }
  if (!suggest.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab')) {
    event.preventDefault();
    if (event.key === 'Escape') suggest.hidden = true;
    else if (event.key === 'ArrowDown') suggestAt = Math.min(suggestItems.length - 1, suggestAt + 1);
    else if (event.key === 'ArrowUp') suggestAt = Math.max(0, suggestAt - 1);
    else applySuggest(suggestAt);
    [...suggest.children].forEach((button, index) => button.setAttribute('aria-selected', index === suggestAt ? 'true' : 'false'));
    return;
  }
  if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    showSuggest(true);
  }
});
suggest.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button) applySuggest(Number(button.dataset.i));
});
$('run').addEventListener('click', () => void runQuery({}));
$('cancel').addEventListener('click', () => void cancelQuery());
$('add').addEventListener('click', () => void openForm(null));
$('close-form').addEventListener('click', () => {
  $('dialog').hidden = true;
});
$('form').engine.addEventListener('change', toggleEngineFields);
$('form').url.addEventListener('change', applyUrl);
$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await enso.call('save', formData());
    $('dialog').hidden = true;
    active = saved.connection.id;
    await refresh();
  } catch (error) {
    setBanner(error.message || String(error));
  }
});
$('test').addEventListener('click', async () => {
  try {
    const saved = await enso.call('save', formData());
    active = saved.connection.id;
    await enso.call('ping', { connectionId: active });
    setBanner('');
    renderStatus('连接成功');
    await refresh();
  } catch (error) {
    setBanner(error.message || String(error));
  }
});
$('remove').addEventListener('click', async () => {
  if (!editing?.id) return;
  await enso.call('remove', { id: editing.id });
  if (active === editing.id) active = null;
  $('dialog').hidden = true;
  await refresh();
});

enso.on('query', (data) => {
  inflight = data?.queryId || null;
  $('cancel').disabled = !inflight;
});

if (fileMode) {
  const initial = enso.file.text || '';
  sqlInput.value = initial;
  const mark = /^--\s*enso\.dbstudio:\s*connection=(\S+)/.exec(initial);
  if (mark) active = mark[1];
  enso.file.onChange(({ text }) => {
    writingFile = true;
    sqlInput.value = text;
    paintSql();
    writingFile = false;
  });
} else if (storage.get('draft')) sqlInput.value = storage.get('draft');

paintSql();
refresh().catch((error) => setBanner(error.message || String(error)));
