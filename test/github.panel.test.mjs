import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../packages/enso.github/main.mjs';
import { attachSessions, createWatcher, EVENTS } from '../packages/enso.github/watch.mjs';

const T0 = Date.parse('2025-03-01T00:00:00Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();
const byUpdated = (list) => [...list].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

function fakeGitHub(env) {
  const repos = {};
  const repo = (name) => (repos[name] ??= { pulls: [], issues: [], comments: [], reviewComments: [], runs: {}, reviews: {}, meta: { default_branch: 'main' } });
  const routes = [
    [/^\/repos\/([^/]+\/[^/]+)$/, (r) => r.meta],
    [/^\/repos\/([^/]+\/[^/]+)\/pulls$/, (r) => byUpdated(r.pulls)],
    [/^\/repos\/([^/]+\/[^/]+)\/issues$/, (r) => byUpdated([...r.issues, ...r.pulls.map((p) => ({ ...p, pull_request: {} }))])],
    [/^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/, (r) => byUpdated(r.comments)],
    [/^\/repos\/([^/]+\/[^/]+)\/pulls\/comments$/, (r) => byUpdated(r.reviewComments)],
    [/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/, (r, n) => r.reviews[n] ?? []],
    [/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/, (r, n) => [...r.issues, ...r.pulls].find((x) => x.number === Number(n))],
    [/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/, (r, _n, q) => ({ workflow_runs: r.runs[q.get('branch')] ?? [] })],
  ];
  const request = async (path, { etag } = {}) => {
    env.calls.push({ path, etag });
    const reset = Math.floor((env.reset ?? env.clock + 3600_000) / 1000);
    const headers = { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': String(env.remaining ?? 4999), 'X-RateLimit-Reset': String(reset) };
    const forced = env.fail?.(path);
    if (forced) return { status: forced, headers, data: { message: 'boom' } };
    const url = new URL(path, 'https://api.github.com');
    for (const [re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      let data = repos[m[1]] && fn(repos[m[1]], m[2], url.searchParams);
      if (data === undefined) return { status: 404, headers, data: { message: 'Not Found' } };
      if (Array.isArray(data)) {
        const size = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        data = data.slice((page - 1) * size, page * size);
      }
      const tag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;
      if (etag === tag) return { status: 304, headers: { ...headers, ETag: tag }, data: null };
      return { status: 200, headers: { ...headers, ETag: tag }, data };
    }
    return { status: 404, headers, data: { message: 'Not Found' } };
  };
  return { repo, request };
}

function setup() {
  const env = { clock: T0, calls: [], timers: new Set(), login: 'me' };
  const gh = fakeGitHub(env);
  const at = (t) => iso(t ?? env.clock);
  const w = createWatcher({
    request: gh.request,
    login: async () => env.login,
    inject: async (input) => {
      if (env.injectError) throw env.injectError;
      env.injected.push(input);
    },
    notify: async () => {},
    load: async () => null,
    save: async (state) => {
      env.saved = JSON.stringify(state);
    },
    now: () => env.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: env.clock + ms };
      env.timers.add(t);
      return t;
    },
    clearTimer: (t) => env.timers.delete(t),
  });
  env.injected = [];
  return {
    env,
    w,
    repo: gh.repo,
    openPR(repo, n) {
      gh.repo(repo).pulls.push({
        number: n,
        title: `PR ${n}`,
        user: { login: 'bob' },
        state: 'open',
        draft: false,
        merged_at: null,
        head: { sha: `${n}aaaaaaaaaa`, ref: `b${n}` },
        requested_reviewers: [],
        labels: [],
        created_at: at(),
        updated_at: at(),
        closed_at: null,
        html_url: `https://github.com/${repo}/pull/${n}`,
        body: '',
      });
    },
    step: async (ms = MIN) => {
      env.clock += ms;
      await w.tick();
    },
  };
}

test('overview 汇总仓库、限流和投递，denied 随投递成功消失', async () => {
  const s = setup();
  s.repo('o/a');
  s.repo('o/b');
  await s.w.watch('s1', { repos: ['o/a', 'o/b'], events: ['pr_opened', 'pr_ready'], settleSec: 900 }, 'proj');
  s.env.clock += 1000;
  await s.w.watch('s2', { repos: ['o/b'], events: ['pr_opened'] }, 'other');
  await s.step();
  const before = s.env.calls.length;
  const ov = await s.w.overview();
  assert.equal(s.env.calls.length, before, 'overview 不请求 GitHub');
  assert.equal(ov.repos['o/a'].watchers, 1);
  assert.equal(ov.repos['o/b'].watchers, 2);
  assert.equal(ov.repos['o/b'].failures, 0);
  assert.equal(ov.repos['o/b'].error, undefined);
  assert.equal(typeof ov.repos['o/a'].lastPollAt, 'string');
  assert.ok(Date.parse(ov.repos['o/a'].nextPollAt) >= Date.parse(ov.repos['o/a'].lastPollAt));
  assert.deepEqual([ov.rate.limit, ov.rate.remaining], [5000, 4999]);
  assert.equal(typeof ov.rate.resetAt, 'string');
  assert.equal(ov.rate.until, undefined);
  assert.deepEqual(ov.watches.map((w) => w.sessionId), ['s2', 's1']);
  assert.equal(ov.watches[1].project, 'proj');
  for (const w of ov.watches) assert.deepEqual([w.pending, w.waitingReady, w.delivered, w.denied], [0, 0, 0, undefined]);

  s.env.fail = (path) => (path.includes('/repos/o/a/') ? 500 : null);
  await s.step(2 * MIN);
  const failed = await s.w.overview();
  assert.equal(failed.repos['o/a'].failures, 1);
  assert.equal(failed.repos['o/a'].error, 'GitHub 500：boom');
  assert.equal(failed.repos['o/b'].failures, 0);

  s.env.fail = null;
  s.env.injectError = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
  s.env.clock += 10_000;
  s.openPR('o/a', 1);
  await s.step();
  await s.step(4 * MIN);
  const mid = await s.w.overview();
  const s1 = mid.watches.find((w) => w.sessionId === 's1');
  const s2 = mid.watches.find((w) => w.sessionId === 's2');
  assert.deepEqual([s1.pending, s1.waitingReady, s1.delivered, s1.denied], [1, 1, 0, true]);
  assert.equal(s1.pendingSince, iso(s.env.clock - 4 * MIN));
  assert.deepEqual([s2.pending, s2.waitingReady, s2.delivered, s2.denied], [0, 0, 0, undefined]);

  s.env.injectError = null;
  await s.step(5 * MIN);
  const done = (await s.w.overview()).watches.find((w) => w.sessionId === 's1');
  assert.equal(done.denied, undefined);
  assert.deepEqual([done.pending, done.waitingReady, done.delivered], [0, 1, 1]);
});

test('attachSessions 只在同项目且列表能确定时标记 orphan 与 canFocus', () => {
  const watches = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }];
  const listed = {
    current: 'a',
    sessions: [
      { id: 'a', title: '甲', projectId: 'p1', projectName: 'one' },
      { id: 'b', title: '乙', projectId: 'p2', projectName: 'two', archived: true },
    ],
  };
  const [a, b, c] = attachSessions(watches, listed);
  assert.equal(a.orphan, false);
  assert.equal(a.canFocus, true);
  assert.deepEqual(a.session, { title: '甲', projectName: 'one', archived: false });
  assert.equal(b.orphan, false);
  assert.equal(b.canFocus, false);
  assert.deepEqual(b.session, { title: '乙', projectName: 'two', archived: true });
  assert.equal(c.orphan, true);
  assert.equal(c.canFocus, false);
  assert.equal(c.session, null);

  for (const row of attachSessions(watches, null)) {
    assert.equal(row.orphan, null);
    assert.equal(row.session, null);
    assert.equal(row.canFocus, false);
  }

  const full = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: 't', projectId: 'p1', projectName: 'n' }));
  const [missing, hit, other] = attachSessions(
    [{ sessionId: 'gone' }, { sessionId: 's0' }, { sessionId: 's1' }],
    { current: 's0', sessions: full },
  );
  assert.equal(missing.orphan, null);
  assert.equal(hit.orphan, false);
  assert.equal(hit.canFocus, true);
  assert.equal(other.canFocus, true);

  const [capped] = attachSessions([{ sessionId: 'z' }], { current: 'a', sessions: listed.sessions }, 2);
  assert.equal(capped.orphan, null);
  const [found] = attachSessions([{ sessionId: 'a' }], { current: 'b', sessions: listed.sessions }, 2);
  assert.equal(found.orphan, false);
  assert.equal(found.canFocus, false);

  const [child] = attachSessions([{ sessionId: 'a::sub' }], listed);
  assert.equal(child.orphan, false, '子会话按所属主会话判断');
  assert.equal(child.session.title, '甲');
});

test('watches 只读本地状态，stopWatch 卸下订阅和独占仓库', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gh-panel-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const env = { clock: Date.now(), calls: [] };
  const gh = fakeGitHub(env);
  gh.repo('o/a');
  gh.repo('o/b');
  gh.repo('o/c');
  const fetches = [];
  const gate = { error: null, focused: [] };
  const listed = {
    current: 's1',
    sessions: [{ id: 's1', title: '甲', projectId: 'p1', projectName: 'proj' }],
  };
  const tools = {};
  const handlers = {};
  activate({
    dataDir,
    config: { get: async () => ({ token: 'pat' }) },
    net: {
      fetch: async (url, init) => {
        fetches.push(url);
        const path = url.replace('https://api.github.com', '');
        if (path === '/user') return { status: 200, headers: {}, body: '{"login":"me"}' };
        const res = await gh.request(path, { etag: init.headers?.['if-none-match'] });
        return { status: res.status, headers: res.headers, body: res.data == null ? '' : JSON.stringify(res.data) };
      },
    },
    ui: { openExternal: async () => {}, notify: async () => {} },
    session: {
      inject: async () => {},
      list: async () => {
        if (gate.error) throw gate.error;
        return listed;
      },
      focus: async (id) => {
        gate.focused.push(id);
        return { ok: true };
      },
    },
    tools: { register: (name, fn) => (tools[name] = fn) },
    renderer: { handle: (name, fn) => (handlers[name] = fn) },
    schedules: { register: () => {} },
  });

  await tools.github_watch({ repos: ['o/a', 'o/b'], events: ['pr_opened'] }, { sessionId: 's1', projectRoot: '/work/proj' });
  await tools.github_watch({ repos: ['o/c'], events: ['pr_opened'] }, { sessionId: 's2', projectRoot: '/work/other' });
  const n = fetches.length;
  const view = await handlers.watches();
  assert.equal(fetches.length, n);
  assert.equal(view.sessionsKnown, true);
  const one = view.watches.find((w) => w.sessionId === 's1');
  const two = view.watches.find((w) => w.sessionId === 's2');
  assert.equal(one.orphan, false);
  assert.equal(one.canFocus, true);
  assert.deepEqual(one.session, { title: '甲', projectName: 'proj', archived: false });
  assert.equal(two.orphan, true);
  assert.equal(two.session, null);
  const stateCalls = fetches.length;
  assert.equal((await handlers.state()).watches, 2);
  assert.equal(fetches.length, stateCalls);

  await handlers.focusSession({ sessionId: 's1' });
  assert.deepEqual(gate.focused, ['s1']);

  const stopped = await handlers.stopWatch({ sessionId: 's2' });
  assert.equal(stopped.ok, true);
  const left = await handlers.watches();
  assert.deepEqual(left.watches.map((w) => w.sessionId), ['s1']);
  assert.equal(left.repos['o/c'], undefined);
  assert.equal(left.repos['o/a'].watchers, 1);
  assert.equal(left.repos['o/b'].watchers, 1);
  const disk = JSON.parse(await readFile(join(dataDir, 'watch.json'), 'utf8'));
  assert.equal(disk.watches.s2, undefined);
  assert.equal(disk.repos['o/c'], undefined);
  assert.ok(disk.watches.s1);

  await assert.rejects(() => handlers.stopWatch({}), /sessionId/);
  await assert.rejects(() => handlers.stopWatch({ sessionId: '' }), /sessionId/);
  assert.equal((await handlers.watches()).watches.length, 1);

  gate.error = new Error('down');
  const blind = await handlers.watches();
  assert.equal(fetches.length, n);
  assert.equal(blind.sessionsKnown, false);
  assert.equal(blind.watches[0].orphan, null);
  assert.equal(blind.watches[0].session, null);
});

test('清单声明全局监听页、新方法和会话权限', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/enso.github/enso-plugin.json', import.meta.url), 'utf8'));
  const view = manifest.contributes.views.find((v) => v.id === 'watch');
  assert.equal(view.scope, 'global');
  assert.equal(view.entry, 'watch.html');
  assert.equal(view.title, 'GitHub 监听');
  const names = manifest.contributes.methods.map((m) => m.name);
  assert.ok(names.includes('watches'));
  assert.ok(names.includes('stopWatch'));
  assert.ok(names.includes('focusSession'));
  assert.ok(manifest.permissions.includes('session.readAll'));
  assert.ok(manifest.permissions.includes('session.focus'));
});

test('监听页把事件原名翻成中英文说法', async () => {
  const html = await readFile(new URL('../packages/enso.github/watch.html', import.meta.url), 'utf8');
  const DICT = new Function(`return ${html.match(/const DICT = (\{[\s\S]*?\n {6}\});/)[1]}`)();
  assert.deepEqual(DICT.zh.ev, {
    pr_opened: '新 PR',
    pr_ready: 'PR 稳定可处理',
    pr_merged_closed: '合并/关闭',
    issue_opened: '新 issue',
    mention: '提及',
    ci_failed: 'CI 失败',
    pr_commented: 'PR 评论',
    issue_commented: 'issue 评论',
  });
  for (const lang of ['zh', 'en']) {
    assert.deepEqual(Object.keys(DICT[lang].ev).sort(), [...EVENTS].sort());
    for (const e of EVENTS) assert.ok(DICT[lang].ev[e] && !DICT[lang].ev[e].includes('_'), `${lang}.${e}`);
  }
  assert.match(html, /\(w\.events \?\? \[\]\)\.map\(\(e\) => L\.ev\[e\] \?\? e\)/);
});
