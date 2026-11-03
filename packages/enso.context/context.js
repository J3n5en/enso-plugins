(() => {
  const PARTS = ['system', 'tools', 'skills', 'memory', 'files', 'results', 'chat'];
  const NAMES = {
    system: '系统提示词', tools: '工具', skills: 'Skills', memory: '指令与记忆',
    files: '文件', results: '工具结果', chat: '会话',
  };
  const NOTES = {
    system: 'Agent 自身的指令',
    tools: '可调用工具的定义',
    skills: '可加载的 skill：名称与用途',
    memory: '指令文件与系统提醒',
    files: '读入的文件和图片',
    results: '其余工具调用返回的内容',
    chat: '你和模型的对话，按轮次',
  };
  const ITEM_NAMES = { system: '系统提示词', reminders: '系统提醒', summary: '压缩摘要', image: '图片' };
  const TAG_NAMES = { mcp: 'MCP', project: '指令', read: '读取', shell: 'shell', result: '', image: '', reminder: '', skills: '' };
  const TILE_MIN = 1500, TILE_MAX = 12, TILE_FLOOR = 700, TILE_SIDE = 16;

  const itemName = (it) => {
    if (it.tag === 'turn') return `第 ${it.name} 轮`;
    if (it.tag === 'turns') return `更早的 ${it.n} 轮`;
    if (it.tag === 'more') return `其余 ${it.n} 项`;
    if (it.tag === 'mcp') return it.name.replace(/^mcp__/, '');
    return ITEM_NAMES[it.name] || it.name;
  };
  const tagName = (it) => TAG_NAMES[it.tag] ?? '';
  // 路径先显示文件名，目录跟在后面
  function itemLabel(it, kind) {
    const name = itemName(it);
    const e = el('span', 'name');
    const at = name.lastIndexOf('/');
    if ((kind === 'files' || kind === 'memory') && at >= 0) e.append(el('b', '', name.slice(at + 1)), el('small', '', name.slice(0, at + 1)));
    else e.append(el('b', '', name));
    return e;
  }

  document.documentElement.dataset.theme = window.enso?.theme || 'light';
  const root = document.getElementById('root');

  const fmtK = (n) => {
    n = Math.max(0, Math.round(n || 0));
    const short = (x, d) => x.toFixed(d).replace(/\.0+$/, '');
    if (n >= 1e6) return short(n / 1e6, n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return short(n / 1e3, n >= 1e5 ? 0 : 1) + 'K';
    return String(n);
  };
  const pct = (x) => Math.round(x * 100) + '%';
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);

  // Bruls, Huizing, van Wijk 的 squarified treemap，按 vals 顺序铺进矩形
  function squarify(vals, x, y, w, h) {
    const out = [];
    vals = vals.filter((a) => a.v > 0);
    const total = vals.reduce((s, a) => s + a.v, 0);
    if (!total || w <= 0 || h <= 0) return out;
    const k = (w * h) / total;
    const worst = (row, side) => {
      let sum = 0, hi = 0, lo = Infinity;
      for (const a of row) { const s = a.v * k; sum += s; hi = Math.max(hi, s); lo = Math.min(lo, s); }
      return Math.max((side * side * hi) / (sum * sum), (sum * sum) / (side * side * lo));
    };
    const lay = (row) => {
      const sum = row.reduce((s, a) => s + a.v * k, 0);
      if (w >= h) {
        const cw = sum / h;
        let cy = y;
        for (const a of row) { const ch = (a.v * k) / cw; out.push({ a, x, y: cy, w: cw, h: ch }); cy += ch; }
        x += cw; w -= cw;
      } else {
        const rh = sum / w;
        let cx = x;
        for (const a of row) { const cw = (a.v * k) / rh; out.push({ a, x: cx, y, w: cw, h: rh }); cx += cw; }
        y += rh; h -= rh;
      }
    };
    let row = [];
    for (const a of vals) {
      const side = Math.min(w, h);
      if (!row.length || worst([...row, a], side) <= worst(row, side)) { row.push(a); continue; }
      lay(row);
      row = [a];
    }
    if (row.length) lay(row);
    return out;
  }

  // 与 magpie 相同：已用部分沿长边按 share^0.35 放大，类铺进已用区，条目再铺进类；
  // 太小看不清的条目并进同类的「其余」块，类本身太小时整块显示
  function tilesOf(s, W, H) {
    const scale = Math.max(s.window, s.used, 1);
    const across = W >= H;
    const long = across ? W : H;
    let usedLen = long;
    if (s.used < scale) usedLen = Math.min(long, Math.max(long * Math.pow(s.used / scale, 0.35), Math.min(long, 36)));
    const ur = across ? [0, 0, usedLen, H] : [0, 0, W, usedLen];
    const floored = (vals, area) => {
      const sum = vals.reduce((t, a) => t + a.v, 0);
      const lo = (sum * TILE_FLOOR) / Math.max(1, area);
      return vals.map((a) => ({ ...a, v: Math.max(a.v, lo) }));
    };
    const parts = PARTS.map((k) => s.parts.find((x) => x.kind === k)).filter((x) => x && x.tokens > 0);
    const partVals = floored(parts.map((x) => ({ v: x.tokens, x })), ur[2] * ur[3]);
    let partRects = squarify(partVals, ...ur);
    for (let n = 0; n < 8; n++) {
      const thin = partRects.filter((r) => Math.min(r.w, r.h) < TILE_SIDE);
      if (!thin.length) break;
      for (const r of thin) r.a.v *= (TILE_SIDE / Math.max(1, Math.min(r.w, r.h))) * 1.05;
      partRects = squarify(partVals, ...ur);
    }
    const tiles = [];
    for (const r of partRects) {
      const x = r.a.x;
      const items = x.items.filter((it) => it.tokens > 0).sort((a, b) => b.tokens - a.tokens);
      const isum = items.reduce((t, it) => t + it.tokens, 0);
      const area = r.w * r.h;
      const whole = () => tiles.push({ key: x.kind, kind: x.kind, its: items, tokens: x.tokens, x: r.x, y: r.y, w: r.w, h: r.h });
      if (!items.length || area < TILE_MIN * 2) { whole(); continue; }
      const kept = [], rest = [];
      for (const it of items) {
        if (kept.length < TILE_MAX && (it.tokens / isum) * area >= TILE_MIN) kept.push(it);
        else rest.push(it);
      }
      const vals = kept.map((it) => ({ v: it.tokens, it }));
      if (rest.length === 1 && !kept.length) vals.push({ v: rest[0].tokens, it: rest[0] });
      else if (rest.length) vals.push({ v: rest.reduce((t, it) => t + it.tokens, 0), rest });
      const laid = squarify(floored(vals, area), r.x, r.y, r.w, r.h);
      if (laid.some((q) => Math.min(q.w, q.h) < 14)) { whole(); continue; }
      for (const q of laid) {
        const it = q.a.it;
        tiles.push({
          key: x.kind + '\x00' + (it ? it.tag + '\x00' + it.name : '\x01rest'),
          kind: x.kind, it, its: it ? [it] : q.a.rest,
          tokens: ((it ? it.tokens : q.a.rest.reduce((t, y) => t + y.tokens, 0)) / isum) * x.tokens,
          x: q.x, y: q.y, w: q.w, h: q.h,
        });
      }
    }
    if (s.used < scale) {
      const fr = across ? [usedLen, 0, W - usedLen, H] : [0, usedLen, W, H - usedLen];
      tiles.push({ key: '\x00free', kind: 'free', free: true, tokens: scale - s.used, x: fr[0], y: fr[1], w: fr[2], h: fr[3] });
    }
    return tiles;
  }

  const cacheHit = (u) => {
    if (!u) return null;
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    return prompt ? u.cacheRead / prompt : null;
  };

  // 统计格按标签复用，数值变化时做 TextSwap
  function stat(box, label, value, note) {
    let e = [...box.children].find((c) => c.dataset.label === label);
    if (!e) {
      e = el('div', 'stat');
      e.dataset.label = label;
      e.append(el('span', '', label), el('b'));
      box.append(e);
    }
    ensoUI.swap(e.children[1], value);
    if (note) setTip(e, () => [el('div', 'tip-head', label), ...[].concat(note).map((n) => el('div', 'tip-sub', n))]);
  }

  const tileName = (t) => {
    if (t.free) return '剩余空间';
    if (t.it) {
      const name = itemName(t.it);
      return t.kind === 'files' || t.kind === 'memory' ? name.slice(name.lastIndexOf('/') + 1) : name;
    }
    if (t.its.length && t.key !== t.kind) return `${NAMES[t.kind]} · 其余 ${t.its.length} 项`;
    return NAMES[t.kind];
  };
  // 自绘浮层：沙箱 iframe 里原生 title 不显示
  const tip = el('div', 'tip');
  tip.hidden = true;
  document.body.append(tip);
  const tipHead = (kind, name, tokens, share) => {
    const h = el('div', 'tip-head');
    const dot = el('i', 'dot' + (kind === 'free' ? ' free' : ''));
    if (kind !== 'free') dot.style.setProperty('--k', `var(--k-${kind})`);
    h.append(dot, el('b', '', name), el('span', 'grow'), el('span', '', fmtK(tokens) + (share == null ? '' : ' · ' + pct(share))));
    return h;
  };
  const tipRows = (items, kind, on) => {
    if (items.length < 2) return [];
    const rows = items.slice(0, 8).map((it) => {
      const r = el('div', 'tip-row' + (it === on ? ' on' : ''));
      const tag = tagName(it);
      r.append(el('span', 'n', itemName(it) + (tag ? ' · ' + tag : '') + (it.n ? ' ×' + it.n : '')), el('span', '', fmtK(it.tokens)));
      return r;
    });
    if (items.length > 8) rows.push(el('div', 'tip-more', `还有 ${items.length - 8} 项`));
    return rows;
  };
  const tileTip = (t, s) => () => {
    const scale = Math.max(s.window, s.used, 1);
    if (t.free) return [tipHead('free', '剩余空间', t.tokens, t.tokens / scale), el('div', 'tip-sub', s.window ? `窗口 ${fmtK(s.window)}，还没用到的部分` : '')];
    const part = s.parts.find((x) => x.kind === t.kind);
    if (t.it) {
      return [tipHead(t.kind, itemName(t.it), t.tokens, t.tokens / scale),
        el('div', 'tip-sub', `${NAMES[t.kind]} · 占该类 ${pct(t.tokens / Math.max(1, part.tokens))}`)];
    }
    return [tipHead(t.kind, tileName(t), t.tokens, t.tokens / scale), el('div', 'tip-sub', NOTES[t.kind]), ...tipRows(t.its, t.kind)];
  };
  const place = (e) => {
    tip.style.left = '0px';
    tip.style.top = '0px';
    const pad = 10, r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - pad) x = Math.max(pad, e.clientX - r.width - 10);
    if (y + r.height > innerHeight - pad) y = Math.max(pad, e.clientY - r.height - 10);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  document.addEventListener('mousemove', (e) => {
    const host = e.target.closest?.('[data-tip]') ? e.target.closest('[data-tip]') : null;
    if (!host || !host._tip) { tip.hidden = true; return; }
    tip.replaceChildren(...host._tip().filter((n) => n.textContent));
    tip.hidden = false;
    place(e);
  });
  document.addEventListener('mouseleave', () => { tip.hidden = true; });
  const setTip = (node, fn) => { node.dataset.tip = ''; node._tip = fn; node.removeAttribute('title'); };

  function drawMap(map, s) {
    const W = map.clientWidth, H = map.clientHeight;
    if (!W || !H) return;
    const scale = Math.max(s.window, s.used, 1);
    const old = new Map([...map.children].map((c) => [c.dataset.k, c]));
    for (const t of tilesOf(s, W, H)) {
      let tile = old.get(t.key);
      old.delete(t.key);
      if (!tile) {
        tile = el('div', 'tile' + (t.free ? ' free' : ''));
        tile.dataset.k = t.key;
        if (!t.free) tile.style.setProperty('--k', `var(--k-${t.kind})`);
        tile.append(el('span', 'n'), el('span', 'v'));
        map.append(tile);
      }
      tile.classList.toggle('item', Boolean(t.it));
      tile.children[0].textContent = tileName(t);
      tile.children[1].textContent = fmtK(t.tokens) + ' · ' + pct(t.tokens / scale);
      setTip(tile, tileTip(t, s));
      tile.classList.toggle('low', t.h < 38);
      tile.classList.toggle('bare', t.h < 22 || t.w < 34);
      Object.assign(tile.style, { left: t.x + 'px', top: t.y + 'px', width: Math.max(0, t.w - 3) + 'px', height: Math.max(0, t.h - 3) + 'px' });
    }
    for (const gone of old.values()) gone.remove();
  }

  let current = null;
  const opened = new Set();
  const partTokens = (s, k) => s.parts.find((x) => x.kind === k)?.tokens || 0;
  function render(s) {
    current = s;
    if (!s) {
      root.replaceChildren(el('div', 'ui-empty', '还没有上下文数据。在会话里发一条消息后这里会显示。'));
      return;
    }
    let card = root.querySelector('.card');
    if (!card) {
      card = el('div', 'card ui-card');
      const head = el('div', 'head');
      const bar = el('div', 'bar');
      bar.append(el('i'));
      head.append(el('b', 'used'), el('span', 'm'), el('span', 'pct'), bar);
      card.append(head, el('div', 'stats'), el('div', 'map'), el('ul'), el('div', 'note'));
      root.replaceChildren(card);
      ensoUI.fill(card.children[3]);
    }
    const [head, stats, map, list, note] = card.children;
    const free = s.window ? Math.max(0, s.window - s.used) : 0;
    const [usedEl, windowEl, pctEl, bar] = head.children;
    ensoUI.swap(usedEl, fmtK(s.used));
    windowEl.textContent = s.window ? '/ ' + fmtK(s.window) + ' tokens' : 'tokens';
    // .ui-swap 自带 display，hidden 属性压不住，直接写 display
    pctEl.style.display = bar.style.display = s.window ? '' : 'none';
    if (s.window) {
      const ratio = s.used / s.window;
      ensoUI.swap(pctEl, pct(ratio));
      bar.firstChild.style.width = Math.min(100, ratio * 100) + '%';
      bar.classList.toggle('warn', ratio >= 0.7 && ratio < 0.9);
      bar.classList.toggle('full', ratio >= 0.9);
    }

    const hit = cacheHit(s.usage);
    stat(stats, '提示词缓存', hit == null ? '—' : pct(hit), s.usage
      ? ['最近一次请求的提示词里，厂商从缓存读到的比例', `缓存读 ${fmtK(s.usage.cacheRead)} · 缓存写 ${fmtK(s.usage.cacheWrite)} · 未缓存 ${fmtK(s.usage.input)} · 输出 ${fmtK(s.usage.output)}`]
      : '还没有模型实报用量');
    const fixed = ['system', 'tools', 'skills', 'memory'].reduce((t, k) => t + partTokens(s, k), 0);
    stat(stats, '起步占用', fmtK(fixed), '系统提示词、工具定义、Skills、指令与记忆：每次请求都带着');
    const steps = (s.history || []).slice(1).map((v, i) => v - s.history[i]).filter((d) => d > 0);
    const growth = median(steps);
    stat(stats, '每次增长', growth ? '+' + fmtK(growth) : '—', '相邻两次请求之间占用增加的中位数');
    stat(stats, '还能容纳', growth && s.window ? '约 ' + Math.floor(free / growth) + ' 次' : '—', '按每次增长估算，压缩前还能发多少次请求');

    drawMap(map, s);

    // 保留 HoverFill 的背景层，2 秒一次的刷新不打断 hover
    const fillBg = list.querySelector(':scope > .ui-fill-bg');
    list.replaceChildren();
    if (fillBg) list.append(fillBg);
    const scale = Math.max(s.window, s.used, 1);
    for (const k of PARTS) {
      const part = s.parts.find((x) => x.kind === k);
      const v = part?.tokens || 0;
      if (!v) continue;
      const li = el('li', 'part' + (opened.has(k) ? ' open' : ''));
      const row = el('div', 'row');
      row.dataset.fill = '';
      const dot = el('i', 'dot');
      dot.style.setProperty('--k', `var(--k-${k})`);
      const items = part.items.filter((it) => it.tokens > 0);
      const caret = el('span', 'caret', items.length ? '›' : '');
      row.append(caret, dot, el('span', 'grow', NAMES[k]), el('span', 'c', items.length > 1 ? String(items.length) : ''), el('b', '', fmtK(v)), el('span', 'p', pct(v / scale)));
      setTip(row, () => [tipHead(k, NAMES[k], v, v / scale), el('div', 'tip-sub', NOTES[k]), ...tipRows(items, k)]);
      li.append(row);
      if (items.length) {
        row.onclick = () => {
          opened.has(k) ? opened.delete(k) : opened.add(k);
          li.classList.toggle('open');
        };
        const sub = el('ul', 'items');
        for (const it of items) {
          const r = el('li');
          r.dataset.fill = '';
          const tag = tagName(it);
          r.append(itemLabel(it, k));
          if (tag) r.append(el('span', 'tag ui-badge', tag));
          if (it.n) r.append(el('span', 'c', '×' + it.n));
          r.append(el('b', '', fmtK(it.tokens)), el('span', 'p', pct(it.tokens / Math.max(1, v))));
          setTip(r, () => [tipHead(k, itemName(it), it.tokens, it.tokens / scale),
            el('div', 'tip-sub', `${NAMES[k]}${tag ? ' · ' + tag : ''}${it.n ? ' · 合并 ' + it.n + ' 项' : ''} · 占该类 ${pct(it.tokens / Math.max(1, v))}`)]);
          sub.append(r);
        }
        li.append(sub);
      }
      list.append(li);
    }
    if (s.window) {
      const li = el('li', 'part');
      const row = el('div', 'row');
      row.dataset.fill = '';
      row.append(el('span', 'caret'), el('i', 'dot free'), el('span', 'grow', '剩余空间'), el('b', '', fmtK(free)), el('span', 'p', pct(free / scale)));
      setTip(row, () => [tipHead('free', '剩余空间', free, free / scale), el('div', 'tip-sub', `窗口 ${fmtK(s.window)}，还没用到的部分`)]);
      li.append(row);
      list.append(li);
    }
    note.textContent = [s.turns ? `${s.turns} 轮` : '', s.estimated ? '估算值：还没有模型实报用量' : '', '更新于 ' + new Date(s.at).toLocaleTimeString()].filter(Boolean).join(' · ');
  }

  async function refresh() {
    let s;
    try {
      s = await window.enso.call('current');
    } catch {
      return;
    }
    if (current && s && current.id !== s.id) root.replaceChildren();
    render(s);
  }

  new ResizeObserver(() => current && drawMap(root.querySelector('.map'), current)).observe(root);
  refresh();
  setInterval(refresh, 2000);
})();
