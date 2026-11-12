(() => {
  const enso = window.enso;
  const root = document.getElementById('root');
  document.documentElement.dataset.theme = enso?.theme || 'light';
  enso?.onTheme?.((theme) => {
    document.documentElement.dataset.theme = theme;
  });

  const KINDS = [
    ['all', '全部'],
    ['user', '用户'],
    ['model', '模型'],
    ['tool', '工具'],
    ['agent', '子代理'],
  ];
  const STATE = { running: '运行中', waiting: '等待', error: '出错', idle: '空闲' };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const fmtK = (n) => {
    n = Math.max(0, Math.round(n || 0));
    const short = (x, d) => x.toFixed(d).replace(/\.0+$/, '');
    if (n >= 1e6) return `${short(n / 1e6, n >= 1e7 ? 1 : 2)}M`;
    if (n >= 1e3) return `${short(n / 1e3, n >= 1e5 ? 0 : 1)}K`;
    return String(n);
  };
  const pct = (x) => (x == null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`);
  const dur = (ms) => {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
    const s = ms / 1000;
    if (s < 60) return `${s >= 10 ? Math.round(s) : s.toFixed(1).replace(/\.0$/, '')} 秒`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
    const h = Math.floor(m / 60);
    return `${h} 小时 ${m % 60} 分`;
  };
  const clock = (at) => {
    if (!at) return '';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const base = (cwd) => {
    if (!cwd) return '';
    const parts = String(cwd).split(/[/\\]/).filter(Boolean);
    return parts.at(-1) || '';
  };

  let data = null;
  let kind = 'all';
  let query = '';
  let sessionId = '';
  let openId = '';
  let openDetail = null;
  let error = '';
  let loading = true;
  try {
    sessionId = enso?.storage?.get('session') || '';
  } catch {
    sessionId = '';
  }

  const shell = el('div', 'card ui-card');
  const top = el('div', 'top');
  const title = el('h1', '', '会话轨迹');
  const badge = el('span', 'ui-badge');
  const select = el('select', 'ui-input');
  select.setAttribute('aria-label', '选择会话');
  top.append(title, badge, el('span', 'grow'), select);
  const sub = el('div', 'sub');
  const lanes = el('div', 'lanes');
  const stats = el('div', 'stats');
  const tokens = el('div', 'tokens');
  const filters = el('div', 'filters');
  const search = el('input', 'ui-input');
  search.type = 'search';
  search.placeholder = '过滤提示词、工具、模型';
  search.setAttribute('aria-label', '过滤');
  const seg = el('div', 'ui-seg');
  for (const [id, label] of KINDS) {
    const button = el('button', '', label);
    button.type = 'button';
    button.dataset.kind = id;
    button.setAttribute('aria-pressed', id === 'all' ? 'true' : 'false');
    button.onclick = () => {
      kind = id;
      for (const node of seg.children) node.setAttribute('aria-pressed', node === button ? 'true' : 'false');
      paint();
    };
    seg.append(button);
  }
  filters.append(search, seg);
  const list = el('ul', 'list');
  const note = el('div', 'note');
  shell.append(top, sub, lanes, stats, tokens, filters, list, note);
  root.append(shell);
  ensoUI?.seg?.(seg);

  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    paint();
  };
  select.onchange = () => {
    sessionId = select.value;
    openId = '';
    openDetail = null;
    try {
      enso?.storage?.set('session', sessionId);
    } catch {
      /* 页面状态写失败不影响查看 */
    }
    refresh();
  };

  function stat(label, value) {
    const box = el('div', 'stat');
    box.append(el('span', '', label), el('b', '', value));
    return box;
  }

  function drawLanes(view) {
    lanes.replaceChildren();
    const spanStart = view.lanes?.start;
    const spanEnd = view.lanes?.end;
    const span = spanStart != null && spanEnd != null ? Math.max(1, spanEnd - spanStart) : 0;
    if (!span) return;
    const rows = [
      ['输入', 'input', 'var(--lane-input)'],
      ['模型', 'model', 'var(--lane-model)'],
      ['工具', 'tools', 'var(--lane-tool)'],
    ];
    for (const [label, key, color] of rows) {
      const segs = view.lanes[key] || [];
      if (!segs.length && key !== 'input') continue;
      const row = el('div', 'lane');
      const track = el('div', 'track');
      const shown = segs.length > 240 ? segs.slice(-240) : segs;
      for (const seg of shown) {
        const from = seg.d ? seg.t - seg.d : seg.t;
        const left = ((from - spanStart) / span) * 100;
        const width = Math.max(0.4, ((seg.d || 0) / span) * 100);
        const bar = el('i');
        bar.style.left = `${Math.max(0, Math.min(99, left))}%`;
        bar.style.width = `${Math.min(100, width)}%`;
        bar.style.setProperty('--c', color);
        if (seg.agent) bar.classList.add('agent');
        track.append(bar);
      }
      row.append(el('b', '', label), track);
      lanes.append(row);
    }
  }

  function match(text) {
    if (!query) return true;
    return String(text || '').toLowerCase().includes(query);
  }

  function visibleTurns(view) {
    const out = [];
    for (const turn of view.turns || []) {
      const userHit = match(`${turn.who} ${turn.preview}`);
      const items = (turn.items || []).filter((item) => {
        if (kind !== 'all' && kind !== 'user' && item.kind !== kind) return false;
        if (!query) return true;
        return userHit || match(`${item.title} ${item.preview} ${item.name} ${item.model}`);
      });
      if (kind === 'user' && query && !userHit) continue;
      if (kind !== 'all' && kind !== 'user' && !items.length) continue;
      if (query && !userHit && !items.length) continue;
      out.push({ turn, items, showUser: true });
    }
    return out;
  }

  function row(kindName, titleText, previewText, ms, pending, isError, id) {
    const node = el('div', `row ${kindName}${isError ? ' error' : ''}${id && id === openId ? ' open' : ''}`);
    const label = { user: '用户', model: '模型', tool: '工具', agent: '子代理', compact: '压缩' }[kindName] || kindName;
    node.append(el('span', `kind ${kindName}`, label));
    const main = el('div', 'main');
    main.append(el('div', 'title', titleText));
    if (previewText && previewText !== titleText) main.append(el('div', 'preview', previewText));
    node.append(main);
    node.append(el('span', `dur${pending ? ' pending' : ''}`, pending ? '进行中' : ms));
    if (id) {
      node.onclick = () => toggle(id);
      node.tabIndex = 0;
      node.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle(id);
        }
      };
    }
    return node;
  }

  function detailBlock(id) {
    const box = el('div', 'detail');
    if (openId !== id) {
      box.hidden = true;
      return box;
    }
    if (!openDetail || openDetail.id !== id) {
      box.append(el('div', 'note', '正在读取…'));
      return box;
    }
    const d = openDetail;
    const add = (heading, text, cls) => {
      if (!text) return;
      box.append(el('h3', '', heading), Object.assign(el('pre', cls || ''), { textContent: text }));
    };
    add('正文', d.text);
    add('参数', d.input);
    add('输出', d.output);
    add('思考', d.thinking);
    add('错误', d.error, 'err');
    if (d.extra) box.append(el('div', 'note', d.extra));
    if (d.child) {
      const child = el('div', 'child');
      const head = [d.child.title, d.child.agentType].filter(Boolean).join(' · ');
      const st = d.child.stats || {};
      child.append(
        el('h3', '', `子会话 · ${head || '子代理'}`),
        el('div', 'mini', `${st.turns || 0} 轮 · ${st.tools || 0} 次工具 · 缓存 ${pct(st.cacheHit)}`),
      );
      for (const turn of d.child.turns || []) {
        child.append(el('div', 'mini', `${turn.who}：${turn.preview}`));
        for (const item of turn.items || []) child.append(el('div', 'mini', `${item.title} · ${item.preview}`));
      }
      if (d.child.truncated) child.append(el('div', 'note', '子会话文件很大，只显示最近一段。'));
      box.append(child);
    }
    return box;
  }

  async function toggle(id) {
    if (openId === id) {
      openId = '';
      openDetail = null;
      paint();
      return;
    }
    openId = id;
    openDetail = null;
    paint();
    try {
      openDetail = await enso.call('detail', { sessionId, id });
    } catch (err) {
      openDetail = { id, error: err?.message || '读取失败' };
    }
    if (openId === id) paint();
  }

  function paint() {
    const view = data;
    badge.className = 'ui-badge';
    if (!view) {
      badge.textContent = loading ? '读取中' : '';
      sub.textContent = error || (loading ? '正在读取会话记录…' : '');
      lanes.replaceChildren();
      stats.replaceChildren();
      tokens.textContent = '';
      list.replaceChildren();
      note.textContent = error || '';
      return;
    }
    const state = view.state || 'idle';
    badge.textContent = STATE[state] || '';
    badge.classList.add(state === 'error' ? 'ui-badge--destructive' : state === 'waiting' ? 'ui-badge--warning' : state === 'running' ? 'ui-badge--success' : '');
    const bits = [];
    if (view.model) bits.push(view.model);
    const folder = base(view.cwd);
    if (folder) bits.push(folder);
    if (view.pendingAsks) bits.push(`${view.pendingAsks} 个待回答`);
    if (view.pendingApprovals) bits.push(`${view.pendingApprovals} 个待审批`);
    if (view.context?.window) {
      const ratio = view.context.percent != null ? view.context.percent / (view.context.percent > 1 ? 100 : 1) : view.context.used / view.context.window;
      bits.push(`窗口 ${pct(ratio)}${view.context.estimated ? ' · 估算' : ''}`);
    }
    sub.textContent = bits.join(' · ');
    const current = select.value;
    const options = view.sessions || [];
    if (select.childElementCount !== options.length || [...select.options].some((option, i) => option.value !== options[i]?.id)) {
      select.replaceChildren();
      for (const session of options) {
        const option = el('option', '', session.title || '未命名会话');
        option.value = session.id;
        select.append(option);
      }
    }
    if (sessionId && [...select.options].some((option) => option.value === sessionId)) select.value = sessionId;
    else if (current && [...select.options].some((option) => option.value === current)) select.value = current;
    drawLanes(view);
    const s = view.stats || {};
    stats.replaceChildren(
      stat('轮次', String(s.turns || 0)),
      stat('模型请求', String(s.requests || 0)),
      stat('工具', s.agents ? `${s.tools || 0}+${s.agents}` : String(s.tools || 0)),
      stat('缓存', pct(s.cacheHit)),
    );
    if (s.agents) stats.children[2].title = `工具 ${s.tools || 0} 次，子代理 ${s.agents} 次`;
    tokens.textContent = s.requests
      ? `输入 ${fmtK(s.input)} · 输出 ${fmtK(s.output)} · 缓存读 ${fmtK(s.cacheRead)} · 缓存写 ${fmtK(s.cacheWrite)} · 活跃 ${dur(s.activeMs)}`
      : '';
    list.replaceChildren();
    const turns = visibleTurns(view);
    if (!turns.length) {
      list.append(el('li', 'ui-empty', view.warning || (query || kind !== 'all' ? '没有匹配的记录。' : '还没有轨迹。在会话里发一条消息后这里会显示。')));
    }
    for (const entry of turns) {
      const li = el('li', 'turn');
      if (entry.showUser && (kind !== 'user' || match(`${entry.turn.who} ${entry.turn.preview}`))) {
        const user = row('user', entry.turn.who === '用户' ? entry.turn.preview : `${entry.turn.who}：${entry.turn.preview}`, clock(entry.turn.at), dur(entry.turn.ms), false, false, entry.turn.id);
        li.append(user, detailBlock(entry.turn.id));
      }
      const items = el('div', 'items');
      for (const item of entry.items) {
        const label = item.kind === 'model' && item.model ? item.model : item.title;
        const cache = item.kind === 'model' && item.cacheHit != null ? ` · 缓存 ${pct(item.cacheHit)}` : '';
        const node = row(item.kind, label, item.preview, `${dur(item.ms)}${cache}`, item.pending, item.error, item.id);
        items.append(node, detailBlock(item.id));
      }
      li.append(items);
      list.append(li);
    }
    note.textContent = view.warning || view.truncated ? view.warning || '只显示最近一段。' : error;
  }

  let inflight = 0;
  async function refresh() {
    const ticket = ++inflight;
    try {
      const view = await enso.call('snapshot', sessionId ? { sessionId } : {});
      if (ticket !== inflight) return;
      loading = false;
      error = '';
      data = view;
      if (!sessionId && view?.sessionId) sessionId = view.sessionId;
      paint();
    } catch (err) {
      if (ticket !== inflight) return;
      loading = false;
      error = err?.message || '读取失败';
      paint();
    }
  }

  paint();
  refresh();
  enso?.on?.('refresh', (payload) => {
    if (payload?.sessionId && sessionId && payload.sessionId !== sessionId) return;
    refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    refresh();
  }, 2000);
})();
