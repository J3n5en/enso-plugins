import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildItems,
  clampCount,
  filterItems,
  fingerprint,
  groupItems,
  noteToolError,
  pruneSeen,
  sameProject,
  snippet,
  statusPatch,
  summarize,
} from '../packages/enso.agentinbox/inbox.mjs';
import { activate } from '../packages/enso.agentinbox/main.mjs';

const session = (id, extra = {}) => ({
  id,
  title: extra.title ?? id,
  updatedAt: extra.updatedAt ?? 1_000,
  state: extra.state ?? 'idle',
  projectId: extra.projectId ?? 'p1',
  projectName: extra.projectName ?? 'alpha',
  ...extra,
});

function itemsOf(sessions, statuses, toolErrors = new Map(), seen = {}) {
  return buildItems({ sessions, statuses, toolErrors, seen, now: 5_000 });
}

test('审批和提问按数量分卡，失败回合单独成卡', () => {
  const statuses = new Map([
    ['a', { sessionId: 'a', state: 'waiting', pendingAsks: 1, pendingApprovals: 2 }],
    ['b', { sessionId: 'b', state: 'error', pendingAsks: 0, pendingApprovals: 1 }],
  ]);
  const errors = new Map([['b', { toolName: 'bash', content: 'exit 1', at: 4_000 }]]);
  const items = itemsOf([
    session('a', { state: 'waiting', title: '接口' }),
    session('b', { state: 'error', title: '脚本', projectId: 'p2', projectName: 'beta' }),
    session('c', { state: 'running' }),
  ], statuses, errors);
  assert.deepEqual(items.map((item) => item.id).sort(), ['a:approval', 'a:ask', 'b:approval', 'b:failure']);
  assert.equal(items.find((item) => item.id === 'a:approval').title, '2 项工具调用等待审批');
  assert.equal(items.find((item) => item.id === 'b:failure').detail, 'bash 失败：exit 1');
  assert.equal(items.find((item) => item.sessionId === 'c'), undefined);
  const summary = summarize(items);
  assert.equal(summary.approvals, 3);
  assert.equal(summary.asks, 1);
  assert.equal(summary.failures, 1);
  assert.equal(summary.total, 5);
  assert.equal(summary.unread, 4);
});

test('运行中的工具错误不会变成收件箱条目', () => {
  const errors = new Map();
  assert.equal(noteToolError(errors, 'a::child', { isError: true, toolName: 'bash', content: 'nope' }, 10), true);
  assert.equal(noteToolError(errors, 'a', { isError: false, toolName: 'bash', content: 'ok' }, 11), false);
  const items = itemsOf([session('a', { state: 'running' })], new Map(), errors);
  assert.equal(items.length, 0);
  assert.equal(errors.get('a').toolName, 'bash');
});

test('没有工具错误时，失败卡片只说明宿主没给原因', () => {
  const items = itemsOf(
    [session('a', { state: 'error' })],
    new Map([['a', { sessionId: 'a', state: 'error', pendingAsks: 0, pendingApprovals: 0 }]]),
  );
  assert.equal(items.length, 1);
  assert.match(items[0].detail, /没有附带原因/);
});

test('已读指纹跟着数量和失败文本变', () => {
  const statuses = new Map([['a', { sessionId: 'a', state: 'waiting', pendingAsks: 0, pendingApprovals: 1 }]]);
  const once = itemsOf([session('a')], statuses);
  const seen = { [once[0].id]: fingerprint(once[0]) };
  const read = itemsOf([session('a')], statuses, new Map(), seen);
  assert.equal(read[0].unread, false);
  statuses.set('a', { sessionId: 'a', state: 'waiting', pendingAsks: 0, pendingApprovals: 2 });
  const again = itemsOf([session('a')], statuses, new Map(), seen);
  assert.equal(again[0].unread, true);
  assert.equal(again[0].title, '2 项工具调用等待审批');
});

test('当前项目排在前面，其他项目不能聚焦', () => {
  const items = itemsOf(
    [
      session('a', { projectId: 'near', projectName: '当前', updatedAt: 1 }),
      session('b', { projectId: 'far', projectName: '别处', updatedAt: 9 }),
    ],
    new Map([
      ['a', { sessionId: 'a', state: 'waiting', pendingAsks: 1, pendingApprovals: 0 }],
      ['b', { sessionId: 'b', state: 'waiting', pendingAsks: 1, pendingApprovals: 0 }],
    ]),
  );
  const groups = groupItems(items, 'near');
  assert.deepEqual(groups.map((group) => group.projectName), ['当前', '别处']);
  assert.equal(groups[0].focusable, true);
  assert.equal(groups[1].focusable, false);
  assert.equal(sameProject({ projectId: 'near' }, { projectId: 'near' }), true);
  assert.equal(sameProject({ projectId: 'near' }, { projectId: 'far' }), false);
  assert.equal(sameProject(null, { projectId: 'near' }), false);
  const asks = filterItems(items, { kind: 'ask', unreadOnly: true });
  assert.equal(asks.length, 2);
  assert.equal(filterItems(items, { kind: 'failure' }).length, 0);
});

test('状态项在没有事项时隐藏，文案不超过 24 字', () => {
  const idle = statusPatch(summarize([]));
  assert.equal(idle.visible, false);
  const busy = statusPatch({ approvals: 2, asks: 0, failures: 1, unread: 3, total: 3 });
  assert.equal(busy.visible, true);
  assert.equal(busy.tone, 'warning');
  assert.ok(busy.text.length <= 24);
  assert.match(busy.tooltip, /2 项审批/);
  const failed = statusPatch({ approvals: 0, asks: 0, failures: 4, unread: 0, total: 4 });
  assert.equal(failed.tone, 'danger');
  assert.equal(clampCount(0), 0);
  assert.equal(clampCount(1.5), 0);
  assert.equal(clampCount(5000), 999);
  assert.equal(snippet('a\nb  c', 10), 'a b c');
});

test('过期的已读记录会被裁掉，活着的条目留着', () => {
  const seen = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`old-${i}`, 'approval:1:x']));
  seen.live = 'ask:1:y';
  const pruned = pruneSeen(seen, [{ id: 'live' }], 2);
  assert.equal(pruned.live, 'ask:1:y');
  assert.ok(Object.keys(pruned).length <= 2);
});

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'agentinbox-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createHarness(dir, options = {}) {
  const renderer = {};
  const events = {};
  const schedules = {};
  const commands = {};
  const focused = [];
  const emitted = [];
  const status = [];
  const opened = [];
  const listCalls = [];
  let sessions = options.sessions ?? [
    session('near', { title: '当前会话', projectId: 'near', projectName: '这个项目', state: 'waiting', updatedAt: 3_000 }),
    session('far', { title: '别处会话', projectId: 'far', projectName: '那个项目', state: 'error', updatedAt: 2_000 }),
    session('idle', { title: '空闲', projectId: 'near', projectName: '这个项目', state: 'idle', updatedAt: 1_000 }),
  ];
  const statuses = {
    near: { sessionId: 'near', state: 'waiting', pendingAsks: 1, pendingApprovals: 2 },
    far: { sessionId: 'far', state: 'error', pendingAsks: 0, pendingApprovals: 0 },
    idle: { sessionId: 'idle', state: 'idle', pendingAsks: 0, pendingApprovals: 0 },
  };
  const enso = {
    pluginId: 'enso.agentinbox',
    dataDir: dir,
    events: { on: (name, fn) => { events[name] = fn; } },
    schedules: { register: (id, fn) => { schedules[id] = fn; } },
    commands: { register: (id, fn) => { commands[id] = fn; } },
    renderer: { handle: (name, fn) => { renderer[name] = fn; } },
    session: {
      list: async (args) => {
        listCalls.push(args);
        if (options.listError) throw Object.assign(new Error('列不出来'), { code: 'UNSUPPORTED' });
        return { current: null, sessions };
      },
      status: async (id) => {
        if (!statuses[id]) throw Object.assign(new Error('没有这个会话'), { code: 'NOT_FOUND' });
        return statuses[id];
      },
      focus: async (id) => {
        if (options.focusError) throw Object.assign(new Error('会话不存在或不在本项目'), { code: 'NOT_FOUND' });
        focused.push(id);
      },
    },
    ui: {
      status: { update: async (id, patch) => { status.push({ id, patch }); } },
      view: {
        emit: async (name, data) => { emitted.push({ name, data }); },
        open: async (id) => { opened.push(id); },
      },
    },
  };
  activate(enso);
  return {
    renderer, events, schedules, commands, focused, emitted, status, opened, listCalls, statuses,
    setSessions(next) { sessions = next; },
  };
}

const ctx = (sessionId) => ({ sessionId, projectRoot: '/proj' });

test('启动时拉全项目列表，等待和失败进收件箱，空闲不进', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir);
    const snap = await h.renderer.refresh(null, ctx('near'));
    assert.equal(h.listCalls[0].scope, 'all');
    assert.equal(snap.loaded, true);
    assert.equal(snap.viewerProjectId, 'near');
    assert.deepEqual(snap.groups.map((group) => group.projectName), ['这个项目', '那个项目']);
    assert.equal(snap.groups[0].focusable, true);
    assert.equal(snap.groups[1].focusable, false);
    assert.deepEqual(snap.items.map((item) => item.id), ['near:approval', 'near:ask', 'far:failure']);
    assert.equal(snap.summary.total, 4);
    assert.equal(h.status.at(-1).patch.visible, true);
    assert.match(h.status.at(-1).patch.text, /在等你/);
    assert.equal(h.emitted.at(-1).name, 'inbox');
  });
});

test('点击当前项目会聚焦并标已读，其他项目不会调用 focus', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir);
    await h.renderer.refresh(null, ctx('near'));
    const ok = await h.renderer.focus({ sessionId: 'near::child', id: 'near:approval' }, ctx('near::worker'));
    assert.equal(ok.ok, true);
    assert.deepEqual(h.focused, ['near']);
    const after = await h.renderer.snapshot(null, ctx('near'));
    assert.equal(after.items.find((item) => item.id === 'near:approval').unread, false);
    assert.equal(after.items.find((item) => item.id === 'near:ask').unread, true);
    const blocked = await h.renderer.focus({ sessionId: 'far', id: 'far:failure' }, ctx('near'));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'other-project');
    assert.deepEqual(h.focused, ['near']);
    const seen = JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8'));
    assert.equal(typeof seen['near:approval'], 'string');
    assert.equal(typeof seen['far:failure'], 'string');
  });
});

test('session_status 更新数量，tool_result 只补充失败文本，子会话结束不删主会话', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir);
    await h.renderer.refresh(null, ctx('near'));
    await h.events.tool_result({ toolName: 'bash', isError: true, content: 'permission denied' }, ctx('far::child'));
    await h.events.session_status({ sessionId: 'near', state: 'waiting', previous: 'running', pendingAsks: 0, pendingApprovals: 1 });
    let snap = await h.renderer.snapshot({ kind: 'approval' }, ctx('near'));
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].count, 1);
    snap = await h.renderer.snapshot({ kind: 'failure' }, ctx('near'));
    assert.match(snap.items[0].detail, /bash 失败：permission denied/);
    await h.events.session_end({ reason: 'dismissed' }, { sessionId: 'far', agent: { kind: 'subagent', sessionId: 'far::child', name: 'scout' } });
    snap = await h.renderer.snapshot(null, ctx('near'));
    assert.ok(snap.items.some((item) => item.id === 'far:failure'));
    await h.events.session_end({ reason: 'ended' }, ctx('far'));
    snap = await h.renderer.snapshot(null, ctx('near'));
    assert.equal(snap.items.some((item) => item.sessionId === 'far'), false);
  });
});

test('未知会话的状态事件会重新拉列表，全部已读会写盘', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir);
    await h.renderer.refresh(null, ctx('near'));
    const before = h.listCalls.length;
    h.statuses.fresh = { sessionId: 'fresh', state: 'waiting', pendingAsks: 2, pendingApprovals: 0 };
    h.setSessions([
      ...h.statuses.near ? [] : [],
      session('near', { title: '当前会话', projectId: 'near', projectName: '这个项目', state: 'waiting' }),
      session('fresh', { title: '新会话', projectId: 'near', projectName: '这个项目', state: 'waiting', updatedAt: 9_000 }),
    ]);
    await h.events.session_status({ sessionId: 'fresh', state: 'waiting', previous: 'idle', pendingAsks: 2, pendingApprovals: 0 });
    assert.ok(h.listCalls.length > before);
    const snap = await h.renderer.markRead({ all: true }, ctx('near'));
    assert.equal(snap.summary.unread, 0);
    assert.ok(snap.items.some((item) => item.id === 'fresh:ask' && item.unread === false));
    await h.commands.open();
    assert.deepEqual(h.opened, ['inbox']);
  });
});

test('列表失败时保留错误，不把空闲会话说成在等你', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir, { listError: true });
    const snap = await h.renderer.refresh(null, ctx('near'));
    assert.equal(snap.loaded, true);
    assert.match(snap.error, /列不出来/);
    assert.equal(snap.summary.total, 0);
    assert.equal(h.status.at(-1).patch.visible, false);
  });
});
