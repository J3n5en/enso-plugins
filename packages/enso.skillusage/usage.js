const root = document.getElementById('root');
const statusEl = document.getElementById('status');
const projectEl = document.getElementById('project');
const presetEl = document.getElementById('preset');
const profileEl = document.getElementById('profile');
const searchEl = document.getElementById('search');
const daysEl = document.getElementById('days');
const tabsEl = document.getElementById('tabs');

const state = { days: 30, project: 'all', preset: 'default', profile: 'all', tab: 'overview', q: '' };
let report = null;
let loading = false;

function saved() {
  try {
    const raw = window.enso?.storage?.get('filters');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') Object.assign(state, parsed);
  } catch {
    // 侧栏状态坏了就用默认筛选
  }
}

function remember() {
  const payload = JSON.stringify({
    days: state.days,
    project: state.project,
    preset: state.preset,
    profile: state.profile,
    tab: state.tab,
  });
  try {
    window.enso?.storage?.set('filters', payload);
  } catch {
    // 宿主没开侧栏存储时忽略
  }
}

function selectSeg(host, attr, value) {
  for (const button of host.querySelectorAll('button')) {
    button.setAttribute('aria-selected', button.getAttribute(attr) === String(value) ? 'true' : 'false');
  }
  window.ensoUI?.seg(host);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function tokens(value) {
  if (value == null) return '未知';
  return value.toLocaleString('zh-CN');
}

function fillSelect(select, options, current, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder, 'all'));
  for (const option of options) select.append(new Option(option.name, option.id));
  const values = [...select.options].map((option) => option.value);
  select.value = values.includes(current) ? current : values[0] || '';
}

function setStatus(text) {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
}

async function reload() {
  if (loading) return;
  loading = true;
  setStatus('正在读取 Enso 的会话和技能清单…');
  try {
    const requested = { project: state.project, preset: state.preset, profile: state.profile };
    report = await window.enso.call('report', {
      days: state.days,
      project: state.project,
      preset: state.preset,
      profile: state.profile,
    });
    const profiles = report.profiles || [];
    profileEl.hidden = profiles.length < 2;
    if (profiles.length > 1) {
      fillSelect(profileEl, profiles, state.profile, '全部数据目录');
      state.profile = profileEl.value;
    }
    fillSelect(projectEl, [{ id: 'all', name: '全部项目' }, ...(report.projects || [])], state.project);
    state.project = projectEl.value;
    fillSelect(presetEl, report.presets || [], state.preset);
    state.preset = presetEl.value;
    setStatus('');
    if (state.project !== requested.project || state.preset !== requested.preset || state.profile !== requested.profile) {
      remember();
      loading = false;
      return reload();
    }
    render();
  } catch (error) {
    report = null;
    root.replaceChildren(el('div', 'ui-empty', error && error.message ? error.message : '读取失败'));
    setStatus('');
  } finally {
    loading = false;
  }
}

function render() {
  if (!report) return;
  const q = state.q.trim().toLowerCase();
  const match = (card) => !q || card.name.toLowerCase().includes(q) || (card.description || '').toLowerCase().includes(q);
  root.replaceChildren();
  if (state.tab === 'overview') root.append(overview(report));
  else if (state.tab === 'unused') root.append(unused(report, match));
  else root.append(cardList((report.cards || []).filter((card) => card.kind === state.tab && match(card)), '这个范围里没有这类条目。'));
  window.ensoUI?.stagger?.(root);
}

function overview(data) {
  const box = el('div', 'list');
  const stats = el('div', 'stats');
  const view = data.overview || {};
  stats.append(
    stat('每次占用', tokens(view.loadedTokens), view.tokensPartial ? 'MCP schema 未计入' : 'token'),
    stat('从未调用', String(view.unusedCount ?? 0), `技能 ${view.unusedSkills ?? 0} · MCP ${view.unusedMcp ?? 0} · 子代理 ${view.unusedAgents ?? 0}`),
    stat('很少调用', String(view.rareCount ?? 0), '1–2 次'),
    stat('调用次数', String(view.calls ?? 0), view.sessions ? `${view.sessions} 个会话` : '所选范围内'),
  );
  box.append(stats);
  if (view.profileNote) box.append(el('p', 'note', view.profileNote));
  box.append(el('p', 'note', '占用是「如果现在用这个预设开一场会话，提示词里会带上什么」。调用次数来自历史会话，jsonl 里没有当时的预设。'));
  const rare = (data.rare || []).slice(0, 3);
  if (rare.length) {
    box.append(el('p', 'note', '很少调用、但会占上下文：'));
    box.append(cardList(rare, ''));
  }
  if ((data.warnings || []).length) {
    for (const warning of data.warnings) box.append(el('p', 'warn', warning));
  }
  box.append(sources(data));
  box.append(access());
  return box;
}

function stat(label, value, extra) {
  const node = el('div', 'stat');
  node.append(el('span', '', label), el('b', '', value));
  if (extra) node.append(el('em', '', extra));
  return node;
}

function unused(data, match) {
  const box = el('div', 'list');
  const known = (data.unused || []).filter((card) => card.loadedTokens != null && match(card));
  const unknown = (data.unused || []).filter((card) => card.loadedTokens == null && match(card));
  box.append(el('p', 'note', '会进提示词、但在当前项目和时间里一次都没调用。技能和子代理按占用从高到低。'));
  box.append(cardList(known, '没有算得出占用、又从未调用的条目。'));
  if (unknown.length) {
    box.append(el('p', 'note', '这些 MCP 会加载，但工具 schema 没缓存在本地，占用未知。'));
    box.append(cardList(unknown, ''));
  }
  return box;
}

function cardList(cards, empty) {
  const list = el('div', 'list');
  if (!cards.length) {
    if (empty) list.append(el('div', 'ui-empty', empty));
    return list;
  }
  for (const card of cards) list.append(cardView(card));
  return list;
}

function cardView(card) {
  const node = el('article', 'ui-card card');
  const top = el('div', 'card-top');
  const title = el('div', 'name', card.name);
  const badges = el('div', 'badges');
  badges.append(badge(card.existence || kindLabel(card.kind), ''));
  if (card.inPrompt) badges.append(badge(card.calls === 0 ? '从未调用' : card.calls <= 2 ? '很少调用' : '会加载', card.calls === 0 ? 'ui-badge--warning' : 'ui-badge--success'));
  else badges.append(badge('未进提示词', ''));
  top.append(title, badges);
  node.append(top);
  if (card.description) node.append(el('p', 'desc', card.description));
  const metrics = el('div', 'metrics');
  metrics.append(metric('占用', card.loadedTokens == null ? '未知' : tokens(card.loadedTokens)));
  metrics.append(metric('调用', String(card.calls ?? 0)));
  if (card.kind === 'skill' && card.bodyTokens != null) {
    metrics.append(metric(card.bodyApproximate ? '正文约' : '正文', tokens(card.bodyTokens)));
  }
  if (card.loadMode) metrics.append(metric('加载', card.loadMode === 'deferred' ? '按需' : '直接'));
  if (card.toolCount != null) metrics.append(metric('工具名', String(card.toolCount)));
  node.append(metrics);
  if (card.projects?.length) node.append(chips('项目', card.projects.map((item) => `${item.name} ${item.calls}`)));
  if (card.models?.length) node.append(chips('模型', card.models));
  if (card.tools?.length) node.append(chips('工具', card.tools.map((item) => `${item.name} ${item.calls}`)));
  if (card.presets?.length) node.append(chips('预设', card.presets));
  if (card.location) node.append(el('p', 'foot', card.location));
  if (card.source) node.append(el('p', 'foot', card.source));
  if (card.note) node.append(el('p', 'foot', card.note));
  return node;
}

function metric(label, value) {
  const node = el('div', '');
  node.append(el('span', '', `${label} `), el('b', '', value));
  return node;
}

function chips(label, values) {
  const row = el('div', 'chips');
  row.append(badge(label, ''));
  for (const value of values) row.append(badge(value, 'ui-badge--brand'));
  return row;
}

function badge(text, extra) {
  return el('span', `ui-badge${extra ? ` ${extra}` : ''}`, text);
}

function kindLabel(kind) {
  if (kind === 'skill') return '技能';
  if (kind === 'mcp') return 'MCP';
  if (kind === 'agent') return '子代理';
  return kind;
}

function sources(data) {
  const box = el('details', 'ui-card card');
  box.append(el('summary', '', '数据来源'));
  const inner = el('div', 'inner');
  const list = data.sources || [];
  if (!list.length) inner.append(el('p', 'note', '还没有读到 Enso 的数据目录。'));
  for (const source of list) {
    const item = el('div', 'src');
    item.append(el('b', '', source.label || '来源'));
    if (source.path) item.append(el('span', 'foot', source.path));
    if (source.detail) item.append(el('span', 'foot', source.detail));
    inner.append(item);
  }
  box.append(inner);
  return box;
}

function access() {
  const box = el('details', 'ui-card card');
  box.append(el('summary', '', '它实际读什么'));
  const inner = el('div', 'inner');
  for (const line of [
    '只读。读 Enso 自己的设置、预设、插件登记和 agent/sessions。不改这些文件，计数缓存写在插件自己的数据目录。',
    '只留名字。技能名、MCP 服务名、子代理类型、工具名、时间、项目路径和模型 id。不留提示词、回答、env、请求头和密钥。',
    '不联网，也不去连 MCP。直接加载的工具 schema 因此显示为占用未知。',
    '不执行。不写项目文件，不往终端输入，不起子代理。',
  ]) {
    inner.append(el('p', '', line));
  }
  box.append(inner);
  return box;
}

saved();
selectSeg(daysEl, 'data-days', state.days);
selectSeg(tabsEl, 'data-tab', state.tab);
searchEl.value = '';

daysEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-days]');
  if (!button) return;
  state.days = Number(button.dataset.days);
  selectSeg(daysEl, 'data-days', state.days);
  remember();
  reload();
});

tabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  state.tab = button.dataset.tab;
  selectSeg(tabsEl, 'data-tab', state.tab);
  remember();
  render();
});

for (const [node, key] of [
  [projectEl, 'project'],
  [presetEl, 'preset'],
  [profileEl, 'profile'],
]) {
  node.addEventListener('change', () => {
    state[key] = node.value;
    remember();
    reload();
  });
}

searchEl.addEventListener('input', () => {
  state.q = searchEl.value;
  render();
});

document.getElementById('refresh').addEventListener('click', () => reload());
window.ensoUI?.tooltip();
reload();
