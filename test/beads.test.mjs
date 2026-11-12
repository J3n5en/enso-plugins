import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFileChange,
  deriveMembership,
  groupOf,
  handoffPrompt,
  looksUninitialized,
  normalizeIssue,
  parseBdPayload,
  parseJsonl,
  prefixFromConfig,
  resolveMembership,
  serializeJsonl,
} from '../packages/enso.beads/beads.mjs';
import { activate, createBeads, runProcess } from '../packages/enso.beads/main.mjs';

const ctx = { projectRoot: '/proj' };
const line = (issue) => JSON.stringify(issue);

function sampleIssues() {
  return [
    { id: 'bd-b', title: '堵住的依赖', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
    {
      id: 'bd-a',
      title: '被堵住',
      status: 'open',
      priority: 0,
      issue_type: 'bug',
      assignee: '',
      created_at: '2026-01-01T00:00:00Z',
      dependencies: [{ issue_id: 'bd-a', depends_on_id: 'bd-b', type: 'blocks' }],
      comments: [{ id: 1, issue_id: 'bd-a', author: 'ada', text: '先看依赖', created_at: '2026-01-01T01:00:00Z' }],
    },
    { id: 'bd-c', title: '正在做', status: 'in_progress', priority: 2, issue_type: 'feature', assignee: 'ada', created_at: '2026-01-01T00:00:00Z' },
    { id: 'bd-d', title: '做完了', status: 'closed', priority: 3, issue_type: 'task', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-02T00:00:00Z' },
    { id: 'bd-e', title: '先放着', status: 'open', priority: 2, issue_type: 'task', defer_until: '2099-01-01T00:00:00Z' },
    { id: 'bd-agent', title: '代理人', status: 'open', priority: 2, issue_type: 'agent' },
    { _type: 'memory', id: 'mem-1', title: '记住这个' },
  ];
}

function jsonl(issues = sampleIssues()) {
  return `${issues.map((issue) => JSON.stringify(issue)).join('\n')}\n`;
}

function ok(payload) {
  return { code: 0, stdout: JSON.stringify(payload), stderr: '', overflow: false };
}

async function service(files, extra = {}) {
  const writes = [];
  const calls = [];
  const dir = extra.dataDir || (await mkdtemp(join(tmpdir(), 'beads-')));
  const session = extra.session || {
    create: async ({ text }) => ({ sessionId: 'sess-1', text }),
    focus: async () => {},
  };
  const beads = createBeads({
    readText: async (_root, rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
    writeText: async (_root, rel, text) => {
      writes.push(rel);
      files[rel] = text;
    },
    locateBd: extra.locateBd || (async () => null),
    execBd: extra.execBd || (async () => { throw new Error('不应调用 bd'); }),
    dataDir: dir,
    session,
    now: () => '2026-04-01T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}-new1`,
  });
  return { beads, files, writes, calls, session, dir };
}

test('JSONL 跳过记忆、墓碑和坏行，保留优先级 0', () => {
  const text = [
    '{"_schema":"beads-jsonl/1"}',
    line({ _type: 'memory', id: 'mem-1', title: '记住' }),
    line({ id: 'bd-old', title: '删掉', status: 'tombstone' }),
    '{不是 json',
    line({ id: 'bd-a', title: '紧急', status: 'open', priority: 0, issue_type: 'bug' }),
  ].join('\n');
  const doc = parseJsonl(text);
  assert.equal(doc.issues.length, 1);
  assert.equal(doc.bad.length, 1);
  assert.equal(normalizeIssue(doc.issues[0]).priority, 0);
  const again = serializeJsonl(doc);
  assert.match(again, /_schema/);
  assert.match(again, /memory/);
  assert.match(again, /tombstone/);
  assert.equal(parseJsonl(again).issues[0].id, 'bd-a');
});

test('show 形式的依赖和阻塞列', () => {
  const blocker = normalizeIssue({ id: 'bd-b', title: '依赖', status: 'open', priority: 1, issue_type: 'task' });
  const blocked = normalizeIssue({
    id: 'bd-a',
    title: '被堵住',
    status: 'open',
    priority: 2,
    dependencies: [{ id: 'bd-b', title: '依赖', status: 'open', dependency_type: 'blocks' }],
  });
  assert.equal(blocked.dependencies[0].dependsOnId, 'bd-b');
  const membership = resolveMembership([blocker, blocked], null, null);
  assert.equal(membership.authoritative, false);
  assert.equal(groupOf(blocker, membership), 'ready');
  assert.equal(groupOf(blocked, membership), 'blocked');
  const doing = normalizeIssue({ id: 'bd-c', title: '做', status: 'in_progress', priority: 1 });
  const authoritative = resolveMembership([doing], ['bd-c'], []);
  assert.equal(groupOf(doing, authoritative), 'in_progress');
  const pinned = normalizeIssue({ id: 'bd-p', title: '钉住', status: 'pinned', priority: 2 });
  assert.equal(groupOf(pinned, resolveMembership([pinned], null, null)), 'other');
});

test('延后的任务不进就绪列', () => {
  const issue = normalizeIssue({ id: 'bd-e', title: '以后', status: 'open', priority: 2, defer_until: '2099-01-01T00:00:00Z' });
  const membership = deriveMembership([issue], Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(membership.ready.has('bd-e'), false);
  assert.equal(groupOf(issue, resolveMembership([issue], null, null)), 'deferred');
});

test('前缀、非法 id 和交接提示', () => {
  assert.equal(prefixFromConfig('issue-prefix: "demo"\n'), 'demo');
  assert.equal(prefixFromConfig(''), 'bd');
  assert.throws(() => applyFileChange({ passthrough: [], issues: [] }, { op: 'claim', id: '--claim' }), /不合法/);
  const issue = normalizeIssue({ id: 'bd-a', title: '做登录', status: 'open', priority: 1, issue_type: 'task', description: '说明' });
  const prompt = handoffPrompt(issue, { blockedBy: [{ id: 'bd-b' }], blocks: [], parent: null, children: [], related: [] });
  assert.match(prompt, /bd-a/);
  assert.match(prompt, /bd update bd-a --claim/);
  assert.match(prompt, /没有认领或关闭/);
  assert.equal(looksUninitialized('Error: no beads database found. Run bd init'), true);
  assert.equal(looksUninitialized('database is locked'), false);
});

test('文件模式：分组、认领、评论、关闭、重开和新建', async () => {
  const files = {
    '.beads/config.yaml': 'issue-prefix: demo\n',
    '.beads/issues.jsonl': jsonl(),
  };
  const { beads } = await service(files);
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.state, 'ready');
  assert.equal(snap.source, 'jsonl');
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-a').group, 'blocked');
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-a').priority, 0);
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-b').group, 'ready');
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-c').group, 'in_progress');
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-d').group, 'closed');
  assert.equal(snap.issues.find((issue) => issue.id === 'bd-e').group, 'deferred');
  assert.equal(snap.issues.some((issue) => issue.id === 'bd-agent'), false);
  assert.match(snap.warning, /issues\.jsonl/);

  const opened = await beads.issue({ id: 'bd-a' }, ctx);
  assert.equal(opened.issue.comments[0].text, '先看依赖');
  assert.equal(opened.relations.blockedBy[0].id, 'bd-b');
  assert.equal(opened.relations.blockedBy[0].title, '堵住的依赖');

  await assert.rejects(beads.claim({ id: 'bd-c' }, ctx), /ada/);
  const claimed = await beads.claim({ id: 'bd-b' }, ctx);
  assert.equal(claimed.detail.issue.status, 'in_progress');
  assert.equal(claimed.detail.issue.assignee, 'enso');
  const stored = parseJsonl(files['.beads/issues.jsonl']);
  assert.equal(stored.issues.find((issue) => issue.id === 'bd-b').status, 'in_progress');
  assert.ok(stored.passthrough.some((row) => row.includes('memory')));

  const commented = await beads.comment({ id: 'bd-a', text: '补一句' }, ctx);
  assert.equal(commented.detail.issue.comments.at(-1).text, '补一句');
  await beads.close({ id: 'bd-a', reason: '依赖还在，但先收工' }, ctx);
  const closed = parseJsonl(files['.beads/issues.jsonl']).issues.find((issue) => issue.id === 'bd-a');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, '依赖还在，但先收工');
  await beads.reopen({ id: 'bd-a' }, ctx);
  const reopened = parseJsonl(files['.beads/issues.jsonl']).issues.find((issue) => issue.id === 'bd-a');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.close_reason, undefined);

  const created = await beads.create({ title: '新任务', description: '细节', type: 'task', priority: 1 }, ctx);
  assert.equal(created.detail.issue.id, 'demo-new1');
  assert.equal(created.snapshot.issues.find((issue) => issue.id === 'demo-new1').group, 'ready');
  await assert.rejects(beads.claim({ id: '--force' }, ctx), /不合法/);
});

test('没有 .beads 时是空状态，不是一块空看板', async () => {
  const { beads } = await service({});
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.state, 'uninitialized');
  assert.equal(snap.issues.length, 0);
  assert.match(snap.message, /bd init/);
  assert.equal((await beads.snapshot(null, {})).state, 'no-project');
});

test('只有数据库、没有 bd 和 JSONL 时提示安装命令', async () => {
  const { beads } = await service({ '.beads/metadata.json': '{"backend":"dolt","database":"dolt"}\n' });
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.state, 'needs-cli');
  assert.match(snap.message, /bd/);
  assert.equal(snap.issues.length, 0);
});

test('metadata 指向的 JSONL 会被读到', async () => {
  const files = {
    '.beads/metadata.json': '{"jsonl_export":"custom.jsonl"}\n',
    '.beads/custom.jsonl': line({ id: 'bd-z', title: '自定义导出', status: 'open', priority: 2, issue_type: 'task' }),
  };
  const { beads } = await service(files);
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.issues[0].id, 'bd-z');
  await beads.claim({ id: 'bd-z' }, ctx);
  assert.match(files['.beads/custom.jsonl'], /in_progress/);
});

test('坏掉的 JSONL 不会显示成零任务', async () => {
  const { beads } = await service({ '.beads/issues.jsonl': '{bad\n{still bad\n' });
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.state, 'error');
  assert.equal(snap.issues.length, 0);
});

test('bd 失败时不退回可能过期的 JSONL', async () => {
  const files = {
    '.beads/metadata.json': '{"backend":"dolt"}\n',
    '.beads/issues.jsonl': line({ id: 'bd-a', title: '旧导出', status: 'open', priority: 1, issue_type: 'task' }),
  };
  const { beads } = await service(files, {
    locateBd: async () => '/usr/bin/bd',
    execBd: async () => ({ code: 1, stdout: '', stderr: 'database is locked', overflow: false }),
  });
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.state, 'error');
  assert.match(snap.message, /locked/);
  assert.equal(snap.issues.length, 0);
});

test('bd 说未初始化且没有 .beads 时给出空状态', async () => {
  const { beads } = await service({}, {
    locateBd: async () => '/usr/bin/bd',
    execBd: async () => ({ code: 1, stdout: '', stderr: 'no beads database found. Run bd init', overflow: false }),
  });
  assert.equal((await beads.snapshot(null, ctx)).state, 'uninitialized');
});

test('bd 成功时认领走 --claim，不写 JSONL', async () => {
  const issue = { id: 'bd-1', title: '命令行', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z', description: '正文' };
  const calls = [];
  let claimed = false;
  const { beads, writes } = await service({ '.beads/issues.jsonl': line({ ...issue, title: '过期导出' }) }, {
    locateBd: async () => '/usr/bin/bd',
    execBd: async (_bin, args) => {
      calls.push(args);
      if (args.includes('list')) return ok(claimed ? [{ ...issue, status: 'in_progress', assignee: 'ada' }] : [issue]);
      if (args.includes('ready')) return ok(claimed ? [] : [issue]);
      if (args.includes('blocked')) return ok([]);
      if (args.includes('--claim')) {
        claimed = true;
        return { code: 0, stdout: '', stderr: '', overflow: false };
      }
      if (args.includes('show')) return ok([{ ...issue, description: '正文', comments_omitted: true, comment_count: 1 }]);
      if (args.includes('comments')) return ok([{ id: 7, author: 'ada', text: 'hello', created_at: '2026-01-01T00:00:00Z' }]);
      return ok([]);
    },
  });
  const snap = await beads.snapshot(null, ctx);
  assert.equal(snap.source, 'bd');
  assert.equal(snap.issues[0].title, '命令行');
  assert.equal(snap.issues[0].group, 'ready');
  const opened = await beads.issue({ id: 'bd-1' }, ctx);
  assert.equal(opened.issue.comments[0].text, 'hello');
  await beads.claim({ id: 'bd-1' }, ctx);
  assert.ok(calls.some((args) => args.includes('--claim') && args.at(-1) === 'bd-1'));
  assert.equal(writes.length, 0);
  await assert.rejects(beads.claim({ id: '--claim' }, ctx), /不合法/);
  assert.equal(calls.filter((args) => args.includes('--claim')).length, 1);
});

test('未知 flag 才回退，认领失败不会改状态', async () => {
  const issue = { id: 'bd-1', title: '命令行', status: 'open', priority: 2, issue_type: 'task' };
  const calls = [];
  const execBd = async (_bin, args) => {
    calls.push(args);
    if (args.includes('list')) return ok([issue]);
    if (args.includes('ready')) return ok([issue]);
    if (args.includes('blocked')) return ok([]);
    if (args.includes('--claim')) return { code: 1, stdout: '', stderr: 'unknown flag: --claim', overflow: false };
    if (args.includes('--status=in_progress')) return { code: 0, stdout: '', stderr: '', overflow: false };
    return ok([]);
  };
  const { beads } = await service({}, { locateBd: async () => 'bd', execBd });
  await beads.claim({ id: 'bd-1' }, ctx);
  assert.ok(calls.some((args) => args.includes('--status=in_progress')));

  const refused = [];
  const { beads: other } = await service({}, {
    locateBd: async () => 'bd',
    execBd: async (_bin, args) => {
      refused.push(args);
      if (args.includes('list')) return ok([issue]);
      if (args.includes('ready')) return ok([issue]);
      if (args.includes('blocked')) return ok([]);
      if (args.includes('--claim')) return { code: 1, stdout: '', stderr: 'already claimed by ada', overflow: false };
      return ok([]);
    },
  });
  await assert.rejects(other.claim({ id: 'bd-1' }, ctx), /ada/);
  assert.equal(refused.some((args) => args.includes('--status=in_progress')), false);
});

test('bd 关闭、重开和评论走对应子命令', async () => {
  const issue = { id: 'bd-1', title: '命令行', status: 'in_progress', priority: 1, issue_type: 'task' };
  const calls = [];
  const { beads } = await service({}, {
    locateBd: async () => 'bd',
    execBd: async (_bin, args) => {
      calls.push(args);
      if (args.includes('list')) return ok([issue]);
      if (args.includes('ready')) return ok([]);
      if (args.includes('blocked')) return ok([]);
      return { code: 0, stdout: '', stderr: '', overflow: false };
    },
  });
  await beads.close({ id: 'bd-1', reason: '做完了' }, ctx);
  await beads.reopen({ id: 'bd-1' }, ctx);
  await beads.comment({ id: 'bd-1', text: '记一笔' }, ctx);
  assert.ok(calls.some((args) => args.includes('close') && args.includes('--reason=做完了') && args.includes('bd-1')));
  assert.ok(calls.some((args) => args.includes('reopen') && args.includes('bd-1')));
  assert.ok(calls.some((args) => args.includes('comments') && args.includes('add') && args.includes('记一笔')));
});

test('交给新会话不会认领或关闭', async () => {
  const files = { '.beads/issues.jsonl': line({ id: 'bd-1', title: '交接', status: 'open', priority: 1, issue_type: 'task', description: '去做' }) };
  let created = null;
  let focused = null;
  const { beads } = await service(files, {
    session: {
      create: async (input) => { created = input; return { sessionId: 'sess-9' }; },
      focus: async (id) => { focused = id; },
    },
  });
  const result = await beads.handoff({ id: 'bd-1' }, ctx);
  assert.equal(result.sessionId, 'sess-9');
  assert.equal(focused, 'sess-9');
  assert.match(created.text, /bd-1/);
  assert.match(created.text, /bd update bd-1 --claim/);
  assert.equal(parseJsonl(files['.beads/issues.jsonl']).issues[0].status, 'open');
  assert.equal(result.detail.handoffSessionId, 'sess-9');
  const again = await beads.snapshot(null, ctx);
  assert.equal(again.handoffs['bd-1'], 'sess-9');
});

test('信封 JSON 和带前缀日志的数组', () => {
  const issue = { id: 'bd-1', title: '一', status: 'open' };
  assert.deepEqual(parseBdPayload(JSON.stringify({ schema_version: 1, data: [issue] })), [issue]);
  assert.equal(parseBdPayload(`warning: sync\n${JSON.stringify([issue])}`)[0].id, 'bd-1');
  assert.equal(parseBdPayload(JSON.stringify({ schema_version: 1, id: 'bd-1', title: '一' })).id, 'bd-1');
});

test('runProcess 把参数原样交给 bd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-bin-'));
  const script = join(dir, 'bd');
  const root = await mkdtemp(join(tmpdir(), 'bd-proj-'));
  await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(process.argv[1]), 'log'), JSON.stringify(args) + '\\n');
const issue = { id: 'bd-1', title: 'One', status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' };
if (args.includes('list')) { process.stdout.write(JSON.stringify([issue])); process.exit(0); }
if (args.includes('ready')) { process.stdout.write(JSON.stringify([issue])); process.exit(0); }
if (args.includes('blocked')) { process.stdout.write('[]'); process.exit(0); }
if (args.includes('--claim')) { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`);
  await chmod(script, 0o755);
  const writes = [];
  const beads = createBeads({
    readText: async () => null,
    writeText: async (...args) => writes.push(args),
    locateBd: async () => script,
    execBd: (bin, args, cwd) => runProcess(bin, args, cwd, 5000),
    dataDir: dir,
    session: { create: async () => ({ sessionId: 's' }), focus: async () => {} },
  });
  const snap = await beads.snapshot(null, { projectRoot: root });
  assert.equal(snap.state, 'ready');
  assert.equal(snap.source, 'bd');
  assert.equal(snap.issues[0].group, 'ready');
  await beads.claim({ id: 'bd-1' }, { projectRoot: root });
  const logged = await readFile(join(dir, 'log'), 'utf8');
  assert.match(logged, /"--claim"/);
  assert.match(logged, /"bd-1"/);
  assert.equal(writes.length, 0);
});

test('activate 在没有项目时返回空状态', async () => {
  const handlers = {};
  activate({
    dataDir: await mkdtemp(join(tmpdir(), 'beads-act-')),
    renderer: { handle: (name, fn) => { handlers[name] = fn; } },
  });
  assert.equal((await handlers.snapshot(null, {})).state, 'no-project');
  for (const name of ['issue', 'create', 'claim', 'close', 'reopen', 'comment', 'handoff', 'focus']) {
    assert.equal(typeof handlers[name], 'function');
  }
});
