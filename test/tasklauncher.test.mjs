import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  activate,
  assertBranch,
  buildPrompt,
  checkoutPlan,
  fitPrompt,
  matchIssue,
  MAX_PROMPT_BYTES,
  normalizeStore,
  parseRemote,
  renderTemplate,
  suggestBranch,
} from '../packages/enso.tasklauncher/main.mjs';

const exec = promisify(execFile);
const ISSUE = {
  number: 7,
  title: 'Fix the thing',
  state: 'open',
  user: { login: 'ada' },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'ada' }],
  comments: 1,
  updated_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/o/r/issues/7',
  body: '按钮点了没反应',
};
const PR = { number: 8, title: 'a pr', state: 'open', pull_request: { url: 'x' }, user: { login: 'ada' }, labels: [], html_url: 'https://github.com/o/r/pull/8', body: '' };

test('parseRemote 识别 github 远程地址', () => {
  assert.equal(parseRemote('git@github.com:J3n5en/enso-plugins.git'), 'J3n5en/enso-plugins');
  assert.equal(parseRemote('https://github.com/a/b.c\n'), 'a/b.c');
  assert.equal(parseRemote('ssh://git@github.com/a/b'), 'a/b');
  assert.equal(parseRemote('https://gitlab.com/a/b.git'), null);
});

test('suggestBranch 只留下安全的分支名', () => {
  assert.equal(suggestBranch(40, 'Fix the date picker on Safari'), 'issue/40-fix-the-date-picker-on-safari');
  assert.equal(suggestBranch(3, '修复登录'), 'issue/3');
  assert.equal(suggestBranch(3, '../../etc/passwd'), 'issue/3-etc-passwd');
  assert.equal(suggestBranch(3, '---'), 'issue/3');
  assert.throws(() => assertBranch('issue/../x'), /不合法/);
  assert.throws(() => assertBranch('-c'), /不合法/);
  assert.throws(() => suggestBranch(0, 'x'), /正整数/);
});

test('模板替换未知变量，超长正文按字节截断', () => {
  assert.equal(renderTemplate('{{ issue_url }} {{nope}}', { issue_url: 'U' }), 'U {{nope}}');
  const small = buildPrompt('{{issue_url}}\n{{issue_body}}', {
    url: 'https://github.com/o/r/issues/7',
    number: 7,
    title: 't',
    body: '短',
    repo: 'o/r',
    branch: 'main',
  });
  assert.equal(small.includes('截断'), false);
  assert.equal(small.includes('https://github.com/o/r/issues/7'), true);
  const prompt = fitPrompt('{{issue_url}}\n{{issue_body}}', {
    issue_url: 'https://github.com/o/r/issues/7',
    issue_body: '测'.repeat(50000),
  });
  assert.ok(Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES);
  assert.equal(prompt.includes('https://github.com/o/r/issues/7'), true);
  assert.equal(prompt.includes('截断'), true);
  const bare = fitPrompt('x'.repeat(40000), { issue_body: '' });
  assert.ok(Buffer.byteLength(bare) <= MAX_PROMPT_BYTES);
});

test('checkoutPlan 脏工作区只在需要切换时拒绝', () => {
  assert.deepEqual(checkoutPlan({ dirty: false, current: 'main', exists: false, branch: 'issue/1' }), {
    action: 'create',
    branch: 'issue/1',
  });
  assert.deepEqual(checkoutPlan({ dirty: false, current: 'main', exists: true, branch: 'issue/1' }), {
    action: 'switch',
    branch: 'issue/1',
  });
  assert.deepEqual(checkoutPlan({ dirty: true, current: 'issue/1', exists: true, branch: 'issue/1' }), {
    action: 'stay',
    branch: 'issue/1',
  });
  assert.deepEqual(checkoutPlan({ dirty: true, current: 'main', exists: false, branch: null }), {
    action: 'stay',
    branch: 'main',
  });
  assert.throws(() => checkoutPlan({ dirty: true, current: 'main', exists: false, branch: 'issue/1' }), /未提交/);
});

test('matchIssue 与损坏的模板存储', () => {
  const item = { title: 'Fix', number: 7, author: 'ada', labels: ['bug'], assignees: [] };
  assert.equal(matchIssue(item, '#7'), true);
  assert.equal(matchIssue(item, 'nope'), false);
  const store = normalizeStore({
    templates: [
      { id: 'default', name: '默认', body: '  ' },
      { id: 'a', name: '', body: 'A {{issue_url}}' },
      { id: 'a', name: '重复', body: 'B' },
    ],
    selected: { 'o/r': 'a', bad: 1 },
    createBranch: true,
  });
  assert.deepEqual(store.templates.map((tpl) => tpl.id), ['a']);
  assert.equal(store.templates[0].name, '未命名');
  assert.equal(store.createBranch, true);
  assert.equal(store.selected['o/r'], 'a');
  assert.equal(normalizeStore(null).templates[0].id, 'default');
});

function plugin(dataDir, routes, extra = {}) {
  const tools = {};
  const handlers = {};
  const net = [];
  activate(
    {
      dataDir,
      config: { get: async () => ({ token: 'pat' }) },
      net: {
        fetch: async (url, init) => {
          net.push({ url, auth: init.headers.authorization });
          const hit = Object.entries(routes).find(([key]) => url.includes(key));
          return hit ? { status: 200, body: JSON.stringify(hit[1]) } : { status: 404, body: '{"message":"no"}' };
        },
      },
      ui: { openExternal: async () => {} },
      tools: { register: (name, fn) => (tools[name] = fn) },
      renderer: { handle: (name, fn) => (handlers[name] = fn) },
      session: extra.session ?? { create: async () => ({ sessionId: 'ses_1' }), focus: async () => {} },
    },
    extra.opts,
  );
  return { tools, handlers, net };
}

test('list 去掉 PR，并带上 PAT', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tl-data-'));
  try {
    const { tools, net } = plugin(dataDir, { '/repos/o/r/issues?': [ISSUE, PR] });
    const listed = await tools.task_list({ repo: 'o/r', query: 'bug' });
    assert.deepEqual(listed.items.map((issue) => issue.number), [7]);
    assert.equal(listed.items[0].suggestedBranch, 'issue/7-fix-the-thing');
    assert.equal(listed.items[0].labels[0], 'bug');
    assert.equal(net[0].auth, 'Bearer pat');
    await assert.rejects(tools.task_list({ repo: 'bad' }), /owner\/name/);
    const none = await tools.task_list({ repo: 'o/r', query: 'missing' });
    assert.equal(none.items.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('模板按仓库记住选择，不能删光', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tl-data-'));
  try {
    const { handlers } = plugin(dataDir, {});
    const created = await handlers.saveTemplate({ repo: 'p/q', name: '另一套', body: 'B {{issue_number}}' });
    await handlers.selectTemplate({ repo: 'o/r', id: 'default' });
    const origin = await handlers.templates({ repo: 'o/r' });
    const other = await handlers.templates({ repo: 'p/q' });
    assert.equal(origin.selectedId, 'default');
    assert.equal(other.selectedId, created.selectedId);
    assert.notEqual(created.selectedId, 'default');
    await assert.rejects(handlers.deleteTemplate({ repo: 'o/r', id: 'missing' }), /不存在/);
    await handlers.deleteTemplate({ repo: 'p/q', id: created.selectedId });
    await assert.rejects(handlers.deleteTemplate({ repo: 'o/r', id: 'default' }), /至少保留/);
    await assert.rejects(handlers.saveTemplate({ repo: 'o/r', id: 'default', name: '空', body: '  ' }), /不能为空/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('只打开 github.com 链接', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tl-data-'));
  try {
    const opened = [];
    const local = {};
    activate({
      dataDir,
      config: { get: async () => ({}) },
      net: { fetch: async () => ({ status: 404, body: '' }) },
      ui: { openExternal: async (url) => opened.push(url) },
      tools: { register: () => {} },
      renderer: { handle: (name, fn) => (local[name] = fn) },
      session: { create: async () => ({ sessionId: 's' }), focus: async () => {} },
    });
    await local.open({ url: 'https://github.com/o/r/issues/7' });
    assert.deepEqual(opened, ['https://github.com/o/r/issues/7']);
    await assert.rejects(local.open({ url: 'https://github.com.evil/r' }), /github.com/);
    await assert.rejects(local.open({ url: 'https://evil.com/github.com/a' }), /github.com/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), 'tl-repo-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'tl-data-'));
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  const git = async (args) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
  await git(['config', 'user.email', 't@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'README.md'), 'x\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'init']);
  await git(['remote', 'add', 'origin', 'git@github.com:o/r.git']);
  return { root, dataDir, git };
}

function trackGit(argv) {
  return async (args, cwd) => {
    argv.push({ args: [...args], cwd });
    if (args.includes('worktree')) throw new Error('不应调用 worktree');
    try {
      const { stdout } = await exec('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return stdout;
    } catch (error) {
      throw new Error(String(error.stderr || error.message).trim() || 'git failed');
    }
  };
}

function repoPlugin(root, dataDir, argv, sessions) {
  return plugin(
    dataDir,
    {
      '/repos/o/r/issues/7': ISSUE,
      '/repos/o/r/issues/8': PR,
      '/repos/o/r/issues?': [ISSUE, PR],
    },
    {
      opts: { run: trackGit(argv) },
      session: {
        create: async (input) => {
          const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
          sessions.push({ op: 'create', input, branch: stdout.trim() });
          return { sessionId: 'ses_1' };
        },
        focus: async (id) => sessions.push({ op: 'focus', id }),
      },
    },
  );
}

test('干净工作区创建分支后 session.create 并 focus，且不调用 worktree', async () => {
  const { root, dataDir, git } = await setupRepo();
  const argv = [];
  const sessions = [];
  try {
    const { handlers } = repoPlugin(root, dataDir, argv, sessions);
    const result = await handlers.launch(
      { repo: 'o/r', number: 7, createBranch: true, cwd: '/tmp/not-the-repo', projectRoot: '/tmp/not-the-repo' },
      { projectRoot: root },
    );
    assert.equal(result.sessionId, 'ses_1');
    assert.equal(result.action, 'create');
    assert.equal(result.branch, 'issue/7-fix-the-thing');
    assert.equal(await git(['branch', '--show-current']), 'issue/7-fix-the-thing');
    assert.equal(sessions[0].branch, 'issue/7-fix-the-thing');
    assert.match(sessions[0].input.text, /https:\/\/github.com\/o\/r\/issues\/7/);
    assert.match(sessions[0].input.text, /按钮点了没反应/);
    assert.match(sessions[0].input.text, /issue\/7-fix-the-thing/);
    assert.deepEqual(sessions[1], { op: 'focus', id: 'ses_1' });
    assert.equal(argv.some(({ args }) => args.includes('worktree')), false);
    assert.ok(argv.some(({ args, cwd }) => args.join(' ') === 'switch -c issue/7-fix-the-thing' && cwd === root));
    assert.equal(argv.every(({ cwd }) => cwd === root), true);
    const saved = await handlers.templates({ repo: 'o/r' });
    assert.equal(saved.createBranch, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('同名分支改为切换；脏工作区需要换分支时不创建会话', async () => {
  const { root, dataDir, git } = await setupRepo();
  const argv = [];
  const sessions = [];
  try {
    await git(['branch', 'issue/7-fix-the-thing']);
    const { handlers } = repoPlugin(root, dataDir, argv, sessions);
    const switched = await handlers.launch({ repo: 'o/r', number: 7, createBranch: true }, { projectRoot: root });
    assert.equal(switched.action, 'switch');
    assert.equal(await git(['branch', '--show-current']), 'issue/7-fix-the-thing');
    assert.equal(argv.some(({ args }) => args[0] === 'switch' && args.includes('-c')), false);
    assert.ok(argv.some(({ args }) => args.join(' ') === 'switch issue/7-fix-the-thing'));

    await writeFile(join(root, 'dirty.txt'), 'wip\n');
    const again = await handlers.launch({ repo: 'o/r', number: 7, createBranch: true }, { projectRoot: root });
    assert.equal(again.action, 'stay');
    assert.equal(sessions.at(-2).op, 'create');

    await git(['switch', 'main']);
    const before = sessions.length;
    await assert.rejects(
      handlers.launch({ repo: 'o/r', number: 7, createBranch: true }, { projectRoot: root }),
      /未提交/,
    );
    assert.equal(sessions.length, before);
    assert.equal(await git(['branch', '--show-current']), 'main');
    assert.equal(argv.some(({ args }) => args.includes('worktree')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('不创建分支时脏工作区也能开会话，Pull Request 会被拒绝', async () => {
  const { root, dataDir, git } = await setupRepo();
  const argv = [];
  const sessions = [];
  try {
    await writeFile(join(root, 'dirty.txt'), 'wip\n');
    const { handlers } = repoPlugin(root, dataDir, argv, sessions);
    const result = await handlers.launch(
      { number: 7, createBranch: false, body: '看 {{issue_url}}，停在 {{branch}}' },
      { projectRoot: root },
    );
    assert.equal(result.action, 'stay');
    assert.equal(result.branch, 'main');
    assert.equal(sessions[0].input.text, '看 https://github.com/o/r/issues/7，停在 main');
    assert.equal(await git(['branch', '--show-current']), 'main');
    assert.equal(argv.some(({ args }) => args[0] === 'switch'), false);
    await assert.rejects(handlers.launch({ number: 8, createBranch: false }, { projectRoot: root }), /Pull Request/);
    assert.equal(sessions.filter((item) => item.op === 'create').length, 1);
    const preview = await handlers.preview({ repo: 'o/r', number: 7, createBranch: true }, { projectRoot: root });
    assert.equal(preview.blocked, true);
    assert.match(preview.reason, /未提交/);
    assert.equal(preview.suggestedBranch, 'issue/7-fix-the-thing');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
