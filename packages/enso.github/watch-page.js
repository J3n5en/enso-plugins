// GitHub 侧栏里的「监听」子页面：列出所有会话的订阅，只读本地状态
(() => {
  const DICT = {
    zh: {
      count: (n) => `${n} 个监听`,
      refresh: '刷新',
      back: '← 返回',
      rate: (left, limit, at) => `剩余 ${left}/${limit} · ${at} 重置`,
      paused: (at) => `已暂停轮询到 ${at}`,
      deniedBadge: '未投递',
      denied: '跨会话投递没打开，事件暂存未送达。到 设置 → 插件 → GitHub 打开「允许向任意运行中的会话发送消息」。',
      deleted: '会话已删除',
      unknown: '会话状态未知',
      archived: '已归档',
      other: '在其他项目',
      stop: '停止',
      confirm: '确认停止',
      empty: '还没有会话在监听。在会话里让 agent 调用 github_watch 即可开始。',
      repos: '仓库',
      events: '事件',
      authors: '作者',
      excludeAuthors: '排除作者',
      labels: '标签',
      excludeNumbers: '排除编号',
      branches: '分支',
      drafts: '包含草稿',
      settle: '就绪静默',
      debounce: '攒批',
      gap: '最小间隔',
      since: '开始',
      pending: '待投递',
      waiting: '等待静默的 PR',
      delivered: '已投递',
      last: '上次投递',
      polled: '上次轮询',
      next: '下次轮询',
      failures: '连续失败',
      subs: '订阅',
      sec: ' 秒',
      justNow: '刚刚',
      rel: (n, future, unit) => (future ? `${n} ${unit}后` : `${n} ${unit}前`),
      units: ['分钟', '小时', '天'],
      ev: {
        pr_opened: '新 PR',
        pr_ready: 'PR 稳定可处理',
        pr_merged_closed: '合并/关闭',
        issue_opened: '新 issue',
        mention: '提及',
        ci_failed: 'CI 失败',
        pr_commented: 'PR 评论',
        issue_commented: 'issue 评论',
      },
    },
    en: {
      count: (n) => (n === 1 ? '1 watch' : `${n} watches`),
      refresh: 'Refresh',
      back: '← Back',
      rate: (left, limit, at) => `${left}/${limit} left · resets ${at}`,
      paused: (at) => `Polling paused until ${at}`,
      deniedBadge: 'Not delivered',
      denied: 'Cross-session delivery is off, so events are queued but not delivered. Open Settings → Plugins → GitHub and turn on “允许向任意运行中的会话发送消息” (Allow messages to any running session).',
      deleted: 'Session deleted',
      unknown: 'Session unknown',
      archived: 'Archived',
      other: 'In another project',
      stop: 'Stop',
      confirm: 'Confirm stop',
      empty: 'No session is watching yet. In a session, ask the agent to call github_watch.',
      repos: 'Repos',
      events: 'Events',
      authors: 'Authors',
      excludeAuthors: 'Excluded authors',
      labels: 'Labels',
      excludeNumbers: 'Excluded numbers',
      branches: 'Branches',
      drafts: 'Drafts included',
      settle: 'Settle',
      debounce: 'Debounce',
      gap: 'Min gap',
      since: 'Since',
      pending: 'Pending',
      waiting: 'PRs waiting to settle',
      delivered: 'Delivered',
      last: 'Last delivery',
      polled: 'Last poll',
      next: 'Next poll',
      failures: 'Failures',
      subs: 'Watchers',
      sec: 's',
      justNow: 'just now',
      rel: (n, future, one, many) => {
        const unit = n === 1 ? one : many;
        return future ? `in ${n} ${unit}` : `${n} ${unit} ago`;
      },
      units: [['minute', 'minutes'], ['hour', 'hours'], ['day', 'days']],
      ev: {
        pr_opened: 'New PR',
        pr_ready: 'PR ready for review',
        pr_merged_closed: 'Merged/closed',
        issue_opened: 'New issue',
        mention: 'Mention',
        ci_failed: 'CI failed',
        pr_commented: 'PR comment',
        issue_commented: 'Issue comment',
      },
    },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const langOf = () => (String(globalThis.navigator?.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

  function render(data, { lang = langOf(), error = '', confirming = new Map(), now = Date.now() } = {}) {
    const zh = lang === 'zh';
    const L = DICT[lang];
    const when = (iso) => {
      const ms = Date.parse(iso);
      if (!iso || !Number.isFinite(ms)) return '';
      const delta = Math.round((ms - now) / 1000);
      const abs = Math.abs(delta);
      if (abs < 45) return L.justNow;
      const i = abs < 3600 ? 0 : abs < 86400 ? 1 : 2;
      const n = Math.max(1, Math.round(abs / [60, 3600, 86400][i]));
      const unit = L.units[i];
      return Array.isArray(unit) ? L.rel(n, delta > 0, unit[0], unit[1]) : L.rel(n, delta > 0, unit);
    };
    const local = (iso) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? new Date(ms).toLocaleString(zh ? 'zh-CN' : undefined, { hour12: false }) : '';
    };
    const noteOf = (text) => {
      if (!text) return '';
      const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      return `<div class="m" data-tip="${esc(text)}">${esc(short)}</div>`;
    };
    const filters = (w) => {
      const bits = [
        [L.authors, w.authors],
        [L.excludeAuthors, w.excludeAuthors],
        [L.labels, w.labels],
        [L.excludeNumbers, w.excludeNumbers],
        [L.branches, w.branches],
      ].filter(([, v]) => v?.length).map(([k, v]) => `${k} ${v.join(', ')}`);
      if (w.includeDrafts) bits.push(L.drafts);
      return bits.length ? `<div class="m">${esc(bits.join(' · '))}</div>` : '';
    };
    const watchCard = (w) => {
      const title = w.session?.title || w.sessionId.slice(0, 8);
      const name = w.canFocus
        ? `<button class="ui-btn ui-btn--sm name" data-focus="${esc(w.sessionId)}" data-tip="${esc(w.sessionId)}">${esc(title)}</button>`
        : `<b class="name ellipsis" data-tip="${esc(w.sessionId)}">${esc(title)}</b>`;
      const where = w.session && !w.canFocus ? `<span class="m">${w.session.projectName ? `${esc(w.session.projectName)} · ` : ''}${esc(L.other)}</span>` : '';
      const badges = [
        w.orphan === true ? `<span class="ui-badge ui-badge--destructive">${esc(L.deleted)}</span>` : '',
        w.orphan === null ? `<span class="ui-badge">${esc(L.unknown)}</span>` : '',
        w.session?.archived ? `<span class="ui-badge">${esc(L.archived)}</span>` : '',
        w.denied ? `<span class="ui-badge ui-badge--destructive">${esc(L.deniedBadge)}</span>` : '',
      ].join('');
      const armed = confirming.has(w.sessionId);
      const stopClass = w.orphan === true || armed ? ' ui-btn--destructive' : '';
      const pending = `${L.pending} ${w.pending ?? 0}${w.pendingSince ? ` (${when(w.pendingSince)})` : ''}`;
      const stats = [pending, `${L.waiting} ${w.waitingReady ?? 0}`, `${L.delivered} ${w.delivered ?? 0}`, w.lastAt ? `${L.last} ${when(w.lastAt)}` : '']
        .filter(Boolean)
        .join(' · ');
      return `<div class="ui-card card${w.denied ? ' bad' : ''}">
        <div class="row">${name}${where}${badges}<span class="grow"></span>
          <button class="ui-btn ui-btn--sm${stopClass}" data-stop="${esc(w.sessionId)}">${esc(armed ? L.confirm : L.stop)}</button></div>
        <div class="m">${esc(L.repos)} <span class="ui-mono">${esc((w.repos ?? []).join(', '))}</span></div>
        <div class="m">${esc(L.events)} <span data-tip="${esc((w.events ?? []).join(', '))}">${esc((w.events ?? []).map((e) => L.ev[e] ?? e).join(zh ? '、' : ', '))}</span></div>
        ${filters(w)}
        <div class="m">${esc(L.settle)} ${w.settleSec}${esc(L.sec)} · ${esc(L.debounce)} ${w.debounceSec}${esc(L.sec)} · ${esc(L.gap)} ${w.minIntervalSec}${esc(L.sec)} · ${esc(L.since)} ${esc(when(w.since) || local(w.since))}</div>
        ${noteOf(w.note)}
        <div class="m">${esc(stats)}</div>
        ${w.deliveryError && !w.denied ? `<div class="err">${esc(w.deliveryError)}</div>` : ''}
      </div>`;
    };
    const repoCard = (repos) => {
      const names = Object.keys(repos ?? {});
      if (!names.length) return '';
      const rows = names.map((name) => {
        const r = repos[name];
        const fail = (r.failures ?? 0) > 0;
        return `<div class="row"><b class="ui-mono ellipsis grow">${esc(name)}</b>
          <span class="${fail ? 'err' : 'm'}">${esc(L.failures)} ${r.failures ?? 0}</span>
          <span class="m">${esc(L.subs)} ${r.watchers ?? 0}</span></div>
          <div class="m">${esc(L.polled)} ${esc(when(r.lastPollAt) || '—')} · ${esc(L.next)} ${esc(when(r.nextPollAt) || local(r.nextPollAt) || '—')}</div>
          ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}`;
      }).join('');
      return `<div class="ui-card card"><h2>${esc(L.repos)}</h2>${rows}</div>`;
    };

    const head = `<div class="row"><button class="ui-btn ui-btn--sm" data-back>${esc(L.back)}</button>
      <b class="grow ellipsis">${data ? esc(L.count(data.watches?.length ?? 0)) : ''}</b>
      <button class="ui-btn ui-btn--sm" data-reload>${esc(L.refresh)}</button></div>`;
    const err = error ? `<div class="err">${esc(error)}</div>` : '';
    if (!data) return head + (err || '<div class="ui-card card"><div class="ui-skeleton" style="height: 14px; width: 50%"></div></div>');
    const rate = data.rate ?? {};
    const rateLine = rate.remaining == null && rate.limit == null ? '' : `<div class="m">${esc(L.rate(rate.remaining ?? '?', rate.limit ?? '?', rate.resetAt ? local(rate.resetAt) : '—'))}</div>`;
    const paused = rate.until ? `<div class="ui-card card"><span class="ui-badge ui-badge--warning">${esc(L.paused(local(rate.until)))}</span></div>` : '';
    const denied = (data.watches ?? []).some((w) => w.denied)
      ? `<div class="ui-card card bad" data-denied><div class="row"><span class="ui-badge ui-badge--destructive">${esc(L.deniedBadge)}</span></div><div>${esc(L.denied)}</div></div>`
      : '';
    const list = data.watches?.length ? data.watches.map(watchCard).join('') : `<div class="ui-empty">${esc(L.empty)}</div>`;
    return head + rateLine + paused + denied + err + list + repoCard(data.repos);
  }

  /** 挂到 root 上；open 时每 5 秒读一次本地状态，close 时停掉计时器 */
  function mount({ root, call, onBack, lang = langOf(), timers = globalThis }) {
    const st = { data: null, error: '', confirming: new Map(), timer: null, open: false };
    const draw = () => {
      if (st.open) root.innerHTML = render(st.data, { lang, error: st.error, confirming: st.confirming });
    };
    const fail = (e) => {
      st.error = e?.message ?? String(e);
      draw();
    };
    async function load() {
      try {
        st.data = await call('watches');
        st.error = '';
      } catch (e) {
        st.error = e?.message ?? String(e);
      }
      draw();
    }
    const page = {
      get isOpen() {
        return st.open;
      },
      open() {
        if (st.open) return;
        st.open = true;
        draw();
        load();
        st.timer = timers.setInterval(load, 5000);
      },
      close() {
        st.open = false;
        timers.clearInterval(st.timer);
        st.timer = null;
        for (const t of st.confirming.values()) timers.clearTimeout(t);
        st.confirming.clear();
      },
    };
    root.addEventListener('click', (e) => {
      const t = e.target.closest?.('button');
      if (!t || t.disabled) return;
      const d = t.dataset;
      if ('back' in d) {
        page.close();
        onBack?.();
      } else if ('reload' in d) load();
      else if (d.focus) call('focusSession', { sessionId: d.focus }).catch(fail);
      else if (d.stop) {
        const sid = d.stop;
        if (!st.confirming.has(sid)) {
          st.confirming.set(sid, timers.setTimeout(() => (st.confirming.delete(sid), draw()), 3000));
          draw();
          return;
        }
        timers.clearTimeout(st.confirming.get(sid));
        st.confirming.delete(sid);
        call('stopWatch', { sessionId: sid }).then(load, fail);
      }
    });
    return page;
  }

  globalThis.GithubWatch = { DICT, render, mount };
})();
