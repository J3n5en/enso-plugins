import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { childTrajectory, compose, loadParsed, pickSession } from '../assemble.mjs';
import { findUserData, isInside, listChildRuns, matchChild, sessionFileFor } from '../locate.mjs';
import { createLive } from '../live.mjs';
import { activate } from '../main.mjs';
import { cacheRatio, mergeLive, parseSessionText, visibleText } from '../parse.mjs';

const BASE = Date.parse('2026-09-03T05:06:36.891Z');
const iso = (ms) => new Date(BASE + ms).toISOString();
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'enso-trajectory-'));
  roots.push(dir);
  return dir;
};
const jsonl = (lines) => lines.map((line) => JSON.stringify(line)).join('\n');

function header(id = 'sess') {
  return { type: 'session', version: 3, id, timestamp: iso(0), cwd: '/work/enso-plugins' };
}
function user(id, parentId, ms, text) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(ms),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: BASE + ms },
  };
}
function assistant(id, parentId, ms, extra = {}) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(ms),
    message: {
      role: 'assistant',
      provider: 'enso',
      model: 'claude-opus-5',
      content: extra.content ?? [{ type: 'text', text: extra.text ?? '好' }],
      usage: extra.usage ?? { input: 10, output: 20, cacheRead: 70, cacheWrite: 20, totalTokens: 120 },
      stopReason: extra.stopReason ?? 'stop',
      timestamp: BASE + ms,
      ...(extra.duration != null ? { duration: extra.duration } : {}),
      ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
    },
  };
}
function tool(id, parentId, ms, callId, name, text, extra = {}) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(ms),
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      isError: extra.isError === true,
      content: [{ type: 'text', text }],
      timestamp: BASE + ms,
      ...(extra.toolDurationMs != null ? { toolDurationMs: extra.toolDurationMs } : {}),
    },
  };
}

test('可见正文去掉系统提醒', () => {
  assert.equal(visibleText('<system-reminder>\n任务完成\n</system-reminder>\n\n给 API 加限流'), '给 API 加限流');
  assert.equal(cacheRatio({ input: 10, cacheRead: 90, cacheWrite: 0 }), 0.9);
  assert.equal(cacheRatio({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test('按 parentId 丢掉放弃的分叉，并统计缓存和耗时', () => {
  const text = jsonl([
    header(),
    '{not json',
    user('u1', null, 0, '<system-reminder>\nx\n</system-reminder>\n\n给公共 API 加限流'),
    assistant('a1', 'u1', 2000, {
      duration: 1500,
      content: [
        { type: 'thinking', thinking: '先看中间件' },
        { type: 'text', text: '我来加限流。' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'rg limit src' } },
      ],
      stopReason: 'toolUse',
      usage: { input: 8, output: 30, cacheRead: 80, cacheWrite: 12 },
    }),
    tool('t1', 'a1', 2600, 'c1', 'bash', 'src/limit.ts', { toolDurationMs: 412 }),
    user('u2', 'a1', 9000, '这条在放弃的分叉上'),
    assistant('a2', 't1', 4000, { text: '已经加上。', usage: { input: 4, output: 11, cacheRead: 100, cacheWrite: 0 } }),
  ]);
  const parsed = parseSessionText(text);
  assert.equal(parsed.cwd, '/work/enso-plugins');
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].preview, '给公共 API 加限流');
  assert.equal(parsed.turns[0].items.some((item) => item.preview.includes('放弃')), false);
  const model = parsed.turns[0].items.find((item) => item.kind === 'model');
  const bash = parsed.turns[0].items.find((item) => item.name === 'bash');
  assert.equal(model.ms, 1500);
  assert.equal(model.tokens.cacheRead, 80);
  assert.equal(bash.ms, 412);
  assert.equal(bash.pending, false);
  assert.equal(bash.preview, 'src/limit.ts');
  assert.equal(parsed.details[model.id].thinking, '先看中间件');
  assert.equal(parsed.stats.turns, 1);
  assert.equal(parsed.stats.requests, 2);
  assert.equal(parsed.stats.tools, 1);
  assert.ok(Math.abs(parsed.stats.cacheHit - 180 / (8 + 80 + 12 + 4 + 100)) < 1e-9);
  assert.equal(parsed.truncated, false);
});

test('子代理、压缩、插件消息和工具失败', () => {
  const text = jsonl([
    header(),
    {
      type: 'custom_message',
      id: 'p1',
      parentId: null,
      timestamp: iso(0),
      customType: 'enso-plugin-message',
      content: '定时任务：检查构建',
      details: { pluginId: 'enso.scheduler', pluginName: 'Scheduler' },
    },
    assistant('a1', 'p1', 1000, {
      content: [
        {
          type: 'toolCall',
          id: 's1',
          name: 'subagent',
          arguments: { operation: 'spawn', description: '找现有中间件', prompt: '看 rate limit', agent_type: 'scout' },
        },
      ],
      stopReason: 'toolUse',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    }),
    tool('t1', 'a1', 5000, 's1', 'subagent', '没有现成中间件', { isError: true }),
    { type: 'compaction', id: 'k1', parentId: 't1', timestamp: iso(6000), summary: '已查过限流', tokensBefore: 9000 },
  ]);
  const parsed = parseSessionText(text);
  assert.equal(parsed.turns[0].who, 'Scheduler');
  const agent = parsed.turns[0].items.find((item) => item.kind === 'agent');
  assert.equal(agent.agent.description, '找现有中间件');
  assert.equal(agent.error, true);
  assert.equal(agent.pending, false);
  assert.equal(parsed.stats.agents, 1);
  assert.equal(parsed.stats.tools, 0);
  assert.equal(parsed.turns[0].items.at(-1).kind, 'compact');
  assert.match(parsed.details[parsed.turns[0].items.at(-1).id].text, /已查过限流/);
});

test('进行中的事件补在同一轮后面，不重复已经落盘的工具', () => {
  const parsed = parseSessionText(
    jsonl([
      header(),
      user('u1', null, 0, '继续'),
      assistant('a1', 'u1', 1000, {
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
        stopReason: 'toolUse',
      }),
      tool('t1', 'a1', 1200, 'c1', 'read', 'export const a = 1'),
    ]),
  );
  const live = createLive(() => BASE + 1500);
  const ctx = { sessionId: 'conv', agent: null };
  live.note('input', { text: '继续' }, ctx);
  live.note('tool_call', { toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } }, ctx);
  live.note('tool_call', { toolCallId: 'c2', toolName: 'bash', input: { command: 'node --test' } }, ctx);
  live.note('context_usage', { used: 100, contextWindow: 1000, estimated: false, percent: 10, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, ctx);
  const merged = mergeLive(parsed, live.snapshot('conv'));
  const names = merged.turns.at(-1).items.map((item) => item.name || item.kind);
  assert.deepEqual(names.filter((name) => name === 'read').length, 1);
  assert.ok(names.includes('bash'));
  assert.equal(merged.turns.length, 1);
});

test('子会话的工具事件不写进主会话', () => {
  const live = createLive(() => 10);
  live.note('input', { text: '主会话' }, { sessionId: 'parent' });
  live.note('tool_call', { toolCallId: 'x', toolName: 'bash', input: { command: 'ls' } }, {
    sessionId: 'parent',
    agent: { kind: 'subagent', sessionId: 'parent::cw-1', name: 'scout' },
  });
  const snap = live.snapshot('parent');
  assert.equal(snap.turns[0].items.length, 0);
});

test('会话文件只认 source-registry，并且必须落在 agent/sessions', () => {
  const root = temp();
  const sessions = join(root, 'agent', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const inside = join(sessions, '2026_conv.jsonl');
  const outside = join(root, 'escape.jsonl');
  writeFileSync(inside, `${JSON.stringify(header('pi-1'))}\n`);
  writeFileSync(outside, '{}\n');
  const parent = '11111111-1111-4111-8111-111111111111';
  writeFileSync(
    join(root, 'agent', 'source-registry.json'),
    JSON.stringify({
      migrationVersion: 1,
      projects: [],
      conversations: [
        { conversationId: parent, sessionFile: inside },
        { conversationId: 'other', sessionFile: outside },
      ],
    }),
  );
  const dataDir = join(root, 'extension-plugins', 'data', 'enso.trajectory');
  mkdirSync(dataDir, { recursive: true });
  assert.equal(findUserData(dataDir, {}, root), root);
  assert.equal(sessionFileFor(root, parent), inside);
  assert.equal(sessionFileFor(root, 'other'), null);
  assert.equal(sessionFileFor(root, '../agent/source-registry.json'), null);
  assert.equal(isInside(sessions, outside), false);

  mkdirSync(join(sessions, 'child-runs'), { recursive: true });
  const childFileName = 'enso-child.jsonl';
  writeFileSync(
    join(sessions, 'child-runs', `${parent}.jsonl`),
    `${JSON.stringify({
      v: 1,
      childId: `${parent}::cw-1`,
      name: 'scout',
      title: '找现有中间件',
      agentType: 'scout',
      file: childFileName,
      startedAt: BASE,
    })}\n${JSON.stringify({
      v: 1,
      childId: `${parent}::cw-1`,
      name: 'scout',
      title: '找现有中间件',
      agentType: 'scout',
      file: 'enso-child-2.jsonl',
      startedAt: BASE,
    })}\n`,
  );
  const runs = listChildRuns(root, parent);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, 'enso-child-2.jsonl');
  assert.equal(matchChild(runs, { description: '找现有中间件', name: '', at: BASE })?.file, 'enso-child-2.jsonl');
  assert.equal(listChildRuns(root, 'not-a-uuid').length, 0);
});

test('子会话轨迹只读目录内的 jsonl', () => {
  const root = temp();
  const parent = '22222222-2222-4222-8222-222222222222';
  const sessions = join(root, 'agent', 'sessions');
  mkdirSync(join(sessions, 'child-runs'), { recursive: true });
  writeFileSync(
    join(sessions, 'child.jsonl'),
    jsonl([header('child'), user('u', null, 0, '看限流'), assistant('a', 'u', 10, { text: '没有' })]),
  );
  writeFileSync(
    join(sessions, 'child-runs', `${parent}.jsonl`),
    `${JSON.stringify({
      v: 1,
      childId: `${parent}::cw-9`,
      name: 'scout',
      title: '找现有中间件',
      agentType: 'scout',
      file: 'child.jsonl',
      startedAt: 1,
    })}\n`,
  );
  const view = childTrajectory(root, parent, {
    childId: `${parent}::cw-9`,
    name: 'scout',
    title: '找现有中间件',
    agentType: 'scout',
    file: 'child.jsonl',
  });
  assert.equal(view.turns[0].preview, '看限流');
  assert.equal(view.stats.requests, 1);
  assert.equal(childTrajectory(root, parent, { childId: 'nope', file: '../escape.jsonl' }), null);
});

test('snapshot 用登记表里的会话，并带上还没写盘的这一轮', async () => {
  const root = temp();
  const parent = '33333333-3333-4333-8333-333333333333';
  const sessions = join(root, 'agent', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, 'parent.jsonl');
  writeFileSync(file, jsonl([header(), user('u1', null, 0, '第一轮'), assistant('a1', 'u1', 1000, { text: '收到' })]));
  writeFileSync(
    join(root, 'agent', 'source-registry.json'),
    JSON.stringify({ conversations: [{ conversationId: parent, sessionFile: file }] }),
  );
  const dataDir = join(root, 'extension-plugins', 'data', 'enso.trajectory');
  mkdirSync(dataDir, { recursive: true });
  const handlers = {};
  const enso = {
    dataDir,
    events: { on() {} },
    renderer: { handle(name, fn) { handlers[name] = fn; } },
    ui: { view: { emit() {} } },
    session: {
      async list() {
        return { current: parent, sessions: [{ id: parent, title: '限流', updatedAt: 5, state: 'running' }] };
      },
      async status() {
        return { sessionId: parent, state: 'running', pendingAsks: 0, pendingApprovals: 1 };
      },
    },
  };
  activate(enso);
  const live = createLive(() => BASE + 3000);
  live.note('input', { text: '第二轮' }, { sessionId: parent });
  live.note('agent_start', {}, { sessionId: parent });
  // activate 有自己的 live；这里改走已注册的事件
  enso.events = enso.events;
  const view = await handlers.snapshot({}, { sessionId: parent });
  assert.equal(view.sessionId, parent);
  assert.equal(view.title, '限流');
  assert.equal(view.state, 'running');
  assert.equal(view.pendingApprovals, 1);
  assert.equal(view.file, true);
  assert.equal(view.turns[0].preview, '第一轮');
  assert.equal(view.stats.requests, 1);
  assert.equal(pickSession('missing', parent, view.sessions), parent);
  const loaded = loadParsed(root, parent, new Map());
  const again = compose({
    parsed: loaded.parsed,
    live: live.snapshot(parent),
    runs: [],
    meta: { sessionId: parent, file: true },
  });
  assert.equal(again.view.turns.at(-1).preview, '第二轮');
  assert.equal(again.view.turns.at(-1).items[0].pending, true);
});
