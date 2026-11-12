import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assignPlaces,
  commandText,
  commandsFor,
  explainHostError,
  fillTemplate,
  parseConfig,
  parseTaskDocument,
  placeChange,
  pullRequestsIn,
  readBoard,
  readDetail,
  requiredFromSchema,
  resumeText,
  safeChangeName,
  stageOf,
  ticketOf,
} from '../packages/enso.openspec/board.mjs';
import { createOpenspecFiles, listOpenspec } from '../packages/enso.openspec/files.mjs';

function memoryFiles(entries) {
  const files = new Map();
  const dirs = new Set();
  for (const [path, value] of Object.entries(entries)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (value == null) dirs.add(path);
    else {
      files.set(path, value);
      dirs.add(path.slice(0, path.lastIndexOf('/')));
    }
  }
  return {
    async list(path) {
      if (!dirs.has(path)) return null;
      const prefix = `${path}/`;
      const names = new Map();
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue;
        const name = dir.slice(prefix.length).split('/')[0];
        if (name) names.set(name, { name, directory: true });
      }
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest.includes('/')) names.set(rest, { name: rest, directory: false });
      }
      return [...names.values()];
    },
    async text(path) {
      return files.has(path) ? files.get(path) : null;
    },
  };
}

test('任务清单统计有序列表、续行，并忽略代码块', () => {
  const parsed = parseTaskDocument(`
# 实现

- [x] 第一项
  续行说明
* [ ] 第二项
+ [X] 第三项
1. [ ] 第四项
2) [x] 第五项

\`\`\`
- [ ] 不要算这段
\`\`\`

## 空的

## 收尾
- [ ] 第六项
`);
  assert.equal(parsed.tasks.length, 6);
  assert.equal(parsed.tasks.filter((task) => task.done).length, 3);
  assert.equal(parsed.tasks[0].text, '第一项 续行说明');
  assert.deepEqual(parsed.sections.map((section) => section.title), ['实现', '收尾']);
});

test('下一步读到段落结束', () => {
  const text = resumeText('说明\nNext: 先对两台设备上的修改\n再确认仓库\n\n- [ ] 其他', /^(?:Next:|下一步[:：])/m);
  assert.equal(text, '先对两台设备上的修改 再确认仓库');
  assert.equal(resumeText('下一步：核对规格\n\n- [ ] 写代码', /^(?:Next:|下一步[:：])/m), '核对规格');
});

test('阶段由产物、任务和写明状态的 PR 决定', () => {
  const tasks = { done: 1, total: 4 };
  assert.equal(stageOf({ missing: ['specs'], tasks, pullRequests: [] }), 'planning');
  assert.equal(stageOf({ missing: [], tasks: { done: 0, total: 3 }, pullRequests: [] }), 'ready');
  assert.equal(stageOf({ missing: [], tasks, pullRequests: [] }), 'in-progress');
  assert.equal(stageOf({ missing: [], tasks, pullRequests: [{ state: 'open' }] }), 'in-review');
  assert.equal(stageOf({ missing: [], tasks, pullRequests: [{ state: 'merged' }] }), 'merged');
  assert.equal(stageOf({ missing: [], tasks: { done: 4, total: 4 }, pullRequests: [{ state: 'merged' }] }), 'complete');
  assert.equal(stageOf({ missing: [], tasks: { done: 4, total: 4 }, pullRequests: [{ state: 'open' }] }), 'in-review');
  assert.equal(stageOf({ missing: [], tasks: { done: 0, total: 0 }, pullRequests: [] }), 'ready');
});

test('评审中完成八成才同时给出收尾，相同文本只保留一个', () => {
  const config = { apply: '/opsx:apply {change}', finish: '/opsx:apply {change}' };
  assert.deepEqual(commandsFor('in-review', { done: 3, total: 4 }, config, 'add-auth', null).commands.map((command) => command.name), ['apply']);
  assert.deepEqual(commandsFor('in-review', { done: 8, total: 10 }, config, 'add-auth', null).commands.map((command) => command.name), ['apply']);
  const both = commandsFor('complete', { done: 2, total: 2 }, { apply: '实现 {change}', finish: '归档 {change}' }, 'add-auth', null);
  assert.deepEqual(both.commands.map((command) => command.name), ['finish']);
});

test('控制字符和缺少工单号时拒绝发送', () => {
  assert.equal(fillTemplate('/opsx:apply {change}', { change: 'add-auth', ticket: '' }).text, '/opsx:apply add-auth');
  assert.match(fillTemplate('处理 {ticket}', { change: 'add-auth', ticket: '' }).refused, /工单号/);
  assert.match(fillTemplate('/opsx:apply {change}', { change: 'bad\nname', ticket: '' }).refused, /控制字符/);
  assert.equal(safeChangeName('archive'), false);
  assert.equal(safeChangeName('../secret'), false);
  assert.equal(safeChangeName('add-auth'), true);
});

test('从 Markdown 链接识别 PR，未知状态不影响阶段', () => {
  const prs = pullRequestsIn(`
- [ ] 打开 https://github.com/acme/app/pull/12
- [x] 已合并 https://github.com/acme/app/pull/8
见 https://github.com/acme/app/pull/3
`);
  assert.deepEqual(prs.map((pr) => [pr.number, pr.state]), [[3, 'unknown'], [8, 'merged'], [12, 'open']]);
  assert.equal(stageOf({ missing: [], tasks: { done: 1, total: 2 }, pullRequests: prs }), 'in-review');
});

test('工单号和 schema 产物', () => {
  const { config } = parseConfig(JSON.stringify({
    ticket: { pattern: '^proj-(\\d+)', key: 'PROJ-$1', url: 'https://tracker.example.com/browse/{ticket}' },
  }));
  assert.deepEqual(ticketOf('proj-12-notes', config), { key: 'PROJ-12', url: 'https://tracker.example.com/browse/PROJ-12' });
  assert.equal(ticketOf('add-notes', config), null);
  assert.deepEqual(requiredFromSchema('artifacts:\n  - generates: proposal.md\n  - generates: specs/**/*.md\n  - generates: tasks.md\n'), ['proposal.md', 'specs', 'tasks.md']);
});

test('配置损坏时保留默认并说明原因', () => {
  const broken = parseConfig('{');
  assert.match(broken.problems[0], /不是合法 JSON/);
  assert.equal(broken.config.apply.includes('{change}'), true);
  const old = parseConfig(JSON.stringify({ complete: 'tasks-done' }));
  assert.match(old.problems[0], /complete 已不再读取/);
});

test('读取变更目录：跳过归档，空 specs 算规划，skip_specs 放行', async () => {
  const files = memoryFiles({
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/archive/2026-01-01-old/tasks.md': '- [x] 旧的\n',
    'openspec/changes/add-auth/proposal.md': '# 给笔记加登录\n',
    'openspec/changes/add-auth/design.md': '# 设计\n',
    'openspec/changes/add-auth/tasks.md': 'Next: 先写会话\n\n- [x] 提案\n- [ ] 实现\n',
    'openspec/changes/add-auth/specs': null,
    'openspec/changes/refactor-logs/.openspec.yaml': 'skip_specs: true\n',
    'openspec/changes/refactor-logs/proposal.md': '# 只改日志\n',
    'openspec/changes/refactor-logs/design.md': '# 设计\n',
    'openspec/changes/refactor-logs/tasks.md': '- [ ] 替换 logger\n',
  });
  const board = await readBoard(files);
  assert.equal(board.status, 'ready');
  const auth = board.changes.find((change) => change.name === 'add-auth');
  const logs = board.changes.find((change) => change.name === 'refactor-logs');
  assert.equal(auth.stage, 'planning');
  assert.deepEqual(auth.missing, ['specs']);
  assert.equal(auth.title, '给笔记加登录');
  assert.equal(auth.resume, '先写会话');
  assert.equal(auth.tasks.done, 1);
  assert.equal(logs.stage, 'ready');
  assert.equal(board.changes.some((change) => change.name.includes('old')), false);
});

test('自定义 schema 的 generates 决定缺什么', async () => {
  const files = memoryFiles({
    'openspec/config.yaml': 'schema: review-first\n',
    'openspec/schemas/review-first/schema.yaml': 'artifacts:\n  - generates: proposal.md\n  - generates: tasks.md\n',
    'openspec/changes/trim-copy/proposal.md': '# 删掉多余文案\n',
    'openspec/changes/trim-copy/tasks.md': '- [ ] 改按钮\n',
  });
  const board = await readBoard(files);
  assert.equal(board.changes[0].stage, 'ready');
  assert.deepEqual(board.changes[0].missing, []);
});

test('没有 openspec 目录、没有 changes、只有归档，三种空状态不同', async () => {
  assert.equal((await readBoard(memoryFiles({}))).status, 'no-openspec');
  assert.equal((await readBoard(memoryFiles({ 'openspec/config.yaml': 'schema: spec-driven\n' }))).hasChangesDir, false);
  const archived = await readBoard(memoryFiles({
    'openspec/changes/archive/2026-01-01-old/tasks.md': '- [x] 完成\n',
  }));
  assert.equal(archived.status, 'no-changes');
  assert.equal(archived.hasChangesDir, true);
});

test('会话匹配：当前会话优先，否则去别的会话，再不然新建', () => {
  const change = {
    name: 'add-dark-mode',
    ticket: { key: 'PROJ-7', url: null },
    commands: [{ name: 'apply', text: '/opsx:apply add-dark-mode' }],
    refused: null,
  };
  const sessions = [
    { id: 's-old', title: '整理文档', updatedAt: 1, state: 'idle' },
    { id: 's-own', title: 'feature/add-dark-mode', updatedAt: 2, state: 'running' },
    { id: 's-ticket', title: '处理 PROJ-7', updatedAt: 3, state: 'idle' },
  ];
  assert.equal(placeChange(change, { sessions, currentId: 's-own', applyAnywhere: false }).kind, 'current');
  assert.equal(placeChange(change, { sessions, currentId: 's-old', applyAnywhere: false }).sessionId, 's-own');
  assert.equal(placeChange(change, { sessions: [sessions[0]], currentId: 's-old', applyAnywhere: false }).kind, 'new');
  assert.equal(placeChange(change, { sessions, currentId: 's-old', applyAnywhere: true }).kind, 'current');
  const placed = assignPlaces([change], { sessions, currentId: 's-own', applyAnywhere: false });
  assert.equal(placed[0].pinned, true);
});

test('单项任务使用看板上的原文，已完成的不能再发', () => {
  const change = {
    commands: [{ name: 'apply', text: '/opsx:apply demo' }],
    sections: [{ title: '', tasks: [{ index: 0, text: '写测试', done: false, runText: '/opsx:apply demo，只做这一项：写测试' }, { index: 1, text: '完成', done: true, runText: null }] }],
  };
  assert.match(commandText(change, 'task', 0).text, /写测试/);
  assert.match(commandText(change, 'task', 1).refused, /不能单独发送/);
  assert.match(commandText({ ...change, commands: [] }, 'apply', 0).refused, /没有这个操作/);
});

test('详情只读这个变更里的 Markdown', async () => {
  const files = memoryFiles({
    'openspec/changes/add-auth/proposal.md': '# 提案\n正文',
    'openspec/changes/add-auth/notes.txt': '不是 markdown',
  });
  const detail = await readDetail(files, 'add-auth', 'proposal.md');
  assert.match(detail.text, /正文/);
  await assert.rejects(() => readDetail(files, 'add-auth', '../config.yaml'), /Markdown|路径/);
  await assert.rejects(() => readDetail(files, '../secret', 'proposal.md'), /名称/);
});

test('列目录只留在 openspec 内，不跟随逃出项目的符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-openspec-'));
  await mkdir(join(root, 'openspec/changes/alpha'), { recursive: true });
  await mkdir(join(root, 'secret'), { recursive: true });
  await writeFile(join(root, 'openspec/changes/alpha/tasks.md'), '- [ ] 一项\n');
  await writeFile(join(root, 'secret/hidden.txt'), 'nope');
  await symlink(join(root, 'secret'), join(root, 'openspec/changes/leak'));
  const listed = await listOpenspec(root, 'openspec/changes');
  assert.deepEqual(listed.map((entry) => entry.name).sort(), ['alpha']);
  await assert.rejects(() => listOpenspec(root, 'secret'), /openspec/);
  await assert.rejects(() => listOpenspec(root, 'openspec/../../secret'), /openspec|路径/);
  const files = createOpenspecFiles(root, (path) => readFile(join(root, path), 'utf8'));
  assert.match(await files.text('openspec/changes/alpha/tasks.md'), /一项/);
  assert.equal(await files.text('secret/hidden.txt'), null);
  const missing = createOpenspecFiles(root, async () => {
    throw Object.assign(new Error('文件不存在'), { code: 'NOT_FOUND' });
  });
  assert.equal(await missing.text('openspec/changes/alpha/missing.md'), null);
});

test('宿主错误翻成能看懂的中文', () => {
  assert.match(explainHostError(Object.assign(new Error('未允许向其他会话发送消息'), { code: 'PERMISSION_DENIED' })), /允许向任意运行中的会话/);
  assert.match(explainHostError(Object.assign(new Error('gone'), { code: 'INJECT_FAILED' })), /目标会话不可用/);
  assert.match(explainHostError(Object.assign(new Error('x'), { code: 'NO_PROJECT' })), /打开一个项目/);
});
