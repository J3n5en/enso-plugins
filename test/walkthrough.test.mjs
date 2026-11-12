import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectDiff, normalizeSpec, parseCheckpointMessage, parseRange } from '../packages/enso.walkthrough/collect.mjs';
import {
  buildWalkthrough,
  filterDiffBlocks,
  mergeEdits,
  newFilePatch,
  parsePatch,
  recordEdit,
  toMarkdown,
  unquoteGitPath,
} from '../packages/enso.walkthrough/diff.mjs';
import { activate } from '../packages/enso.walkthrough/main.mjs';

function git(cwd, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'walkthrough-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 't@example.com']);
  git(cwd, ['config', 'user.name', 't']);
  return cwd;
}

function commitFile(cwd, path, content, message) {
  return writeFile(join(cwd, path), content).then(() => {
    git(cwd, ['add', path]);
    git(cwd, ['commit', '-m', message]);
  });
}

function checkpoint(cwd, sessionId) {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const tree = git(cwd, ['write-tree']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const message = [
    `enso-checkpoint:tool-${sessionId}-1`,
    '',
    `sessionId ${sessionId}`,
    'trigger tool',
    `branch ${branch}`,
    `head ${head}`,
    `index-tree ${tree}`,
    `worktree-tree ${tree}`,
    'created 2026-01-01T00:00:00.000Z',
    '',
  ].join('\n');
  const sha = git(cwd, ['commit-tree', tree, '-F', '-'], message);
  git(cwd, ['update-ref', `refs/enso-checkpoints/tool-${sessionId}-1`, sha]);
  return sha;
}

const readTextAt = (cwd) => (path) => readFile(join(cwd, path), 'utf8');

test('解析 diff：修改、新增、重命名、二进制、引号路径', () => {
  const patch = [
    'diff --git a/src/session.ts b/src/session.ts',
    '--- a/src/session.ts',
    '+++ b/src/session.ts',
    '@@ -1,2 +1,2 @@ function createSession',
    ' keep',
    '-old',
    '+new',
    '\\ No newline at end of file',
    'diff --git "a/src/my file.ts" "b/src/my file.ts"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/src/my file.ts"',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.ts b/new.ts',
    'rename from old.ts',
    'rename to new.ts',
    'diff --git a/pic.png b/pic.png',
    'Binary files a/pic.png and b/pic.png differ',
  ].join('\n');
  const files = parsePatch(patch);
  assert.equal(files.length, 4);
  assert.equal(files[0].path, 'src/session.ts');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[0].hunks[0].header, 'function createSession');
  assert.equal(files[0].hunks[0].lines.at(-1).text, 'new');
  assert.equal(files[1].path, 'src/my file.ts');
  assert.equal(files[1].status, 'added');
  assert.equal(files[2].status, 'renamed');
  assert.equal(files[2].path, 'new.ts');
  assert.equal(files[2].oldPath, 'old.ts');
  assert.equal(files[3].binary, true);
  assert.equal(unquoteGitPath('"\\346\\272\\220.ts"'), '源.ts');
});

test('hunk 里以 -- 或 ++ 开头的行仍是代码', () => {
  const patch = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,2 +1,2 @@',
    '--- heading',
    '+++ heading',
  ].join('\n');
  const [file] = parsePatch(patch);
  assert.equal(file.path, 'a.md');
  assert.deepEqual(
    file.hunks[0].lines.map((line) => [line.kind, line.text]),
    [
      ['del', '-- heading'],
      ['add', '++ heading'],
    ],
  );
});

test('按阅读顺序分组，测试跟实现走，生成文件不展开', () => {
  const patch = [
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1 +1 @@',
    '-1',
    '+2',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/session.ts b/src/session.ts',
    '--- a/src/session.ts',
    '+++ b/src/session.ts',
    '@@ -1,2 +1,3 @@ function createSession',
    ' keep',
    '-old',
    '+new',
    '+extra',
    'diff --git a/src/session.test.ts b/src/session.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/session.test.ts',
    '@@ -0,0 +1 @@',
    '+ok',
    'diff --git a/src/types.ts b/src/types.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/types.ts',
    '@@ -0,0 +1,2 @@ export interface Session',
    '+export interface Session {}',
    '+',
  ].join('\n');
  const walk = buildWalkthrough({
    source: { kind: 'worktree', label: '未提交的改动', detail: 'HEAD' },
    patch,
  });
  assert.deepEqual(
    walk.steps.map((step) => step.files.map((file) => file.path)),
    [['src/types.ts'], ['src/session.ts', 'src/session.test.ts'], ['README.md']],
  );
  assert.match(walk.steps[0].title, /types\.ts/);
  assert.match(walk.steps[1].body, /测试和对应实现/);
  assert.match(walk.steps[1].body, /createSession/);
  assert.equal(walk.omitted.length, 1);
  assert.equal(walk.omitted[0].path, 'package-lock.json');
  assert.equal(walk.omitted[0].reason, '生成文件');
  assert.match(walk.summary, /3 步/);
});

test('提交按从早到晚变成步骤，说明保留提交正文', () => {
  const walk = buildWalkthrough({
    source: { kind: 'commits', label: '最近 2 次提交', detail: 'HEAD~2..HEAD' },
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        subject: '先加类型',
        body: '类型放在实现前面。',
        patch: ['diff --git a/types.ts b/types.ts', 'new file mode 100644', '--- /dev/null', '+++ b/types.ts', '@@ -0,0 +1 @@', '+export type Id = string'].join('\n'),
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        subject: '再写逻辑',
        body: '',
        patch: ['diff --git a/app.ts b/app.ts', '--- a/app.ts', '+++ b/app.ts', '@@ -1 +1 @@ run', '-a', '+b'].join('\n'),
      },
    ],
  });
  assert.deepEqual(
    walk.steps.map((step) => step.title),
    ['先加类型', '再写逻辑'],
  );
  assert.match(walk.steps[0].body, /类型放在实现前面/);
  assert.equal(walk.steps[0].commit.sha.startsWith('aaaa'), true);
});

test('改过的步骤文字会按改动身份保留', () => {
  const collected = {
    source: { kind: 'worktree', label: '未提交的改动', detail: 'HEAD' },
    patch: ['diff --git a/app.ts b/app.ts', '--- a/app.ts', '+++ b/app.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
  };
  const first = buildWalkthrough(collected);
  const edits = recordEdit(null, { walkId: first.id, stepId: first.steps[0].id, title: '改成校验', body: '这里只校验输入。' });
  const again = mergeEdits(buildWalkthrough(collected), edits);
  assert.equal(again.steps[0].title, '改成校验');
  assert.equal(again.steps[0].body, '这里只校验输入。');
  assert.equal(again.steps[0].edited, true);
  assert.throws(() => recordEdit(edits, { walkId: first.id, stepId: first.steps[0].id, title: '  ' }), /标题不能为空/);
  const markdown = toMarkdown(again);
  assert.match(markdown, /改成校验/);
  assert.match(markdown, /```diff/);
  assert.match(markdown, /\+b/);
});

test('版本范围只接受 git 修订名', () => {
  assert.deepEqual(parseRange('HEAD~5..HEAD'), { from: 'HEAD~5', to: 'HEAD', triple: false });
  assert.equal(parseRange('origin/main...feature/walk').triple, true);
  assert.equal(normalizeSpec(normalizeSpec({ kind: 'commits', range: 'origin/main...HEAD' })).range.triple, true);
  assert.throws(() => parseRange('HEAD;touch /tmp/x'), /不合法|提交范围/);
  assert.throws(() => normalizeSpec({ kind: 'commits', range: '--output=/tmp/x..HEAD' }), /不合法/);
  assert.throws(() => normalizeSpec({ kind: 'nope' }), /未知的讲解范围/);
  assert.equal(normalizeSpec({ kind: 'commits', count: 99 }).count, 30);
});

test('检查点说明能还原会话和树', () => {
  const parsed = parseCheckpointMessage(
    ['enso-checkpoint:tool-sess-1', '', 'sessionId sess', 'trigger tool', 'branch main', 'head abc', 'index-tree def', 'worktree-tree ghi', 'created 2026-01-01T00:00:00.000Z'].join('\n'),
  );
  assert.equal(parsed.sessionId, 'sess');
  assert.equal(parsed.worktreeTreeSha, 'ghi');
  assert.equal(parsed.branch, 'main');
  assert.equal(parseCheckpointMessage('nope'), null);
});

test('未跟踪文件的合成 diff 能被解析', () => {
  const files = parsePatch(newFilePatch('notes/今日.md', '你好\n'));
  assert.equal(files[0].path, 'notes/今日.md');
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].hunks[0].lines[0].text, '你好');
  const kept = filterDiffBlocks(`${newFilePatch('keep.ts', 'a')}\n${newFilePatch('drop.ts', 'b')}`, (path) => path === 'drop.ts');
  assert.match(kept, /keep\.ts/);
  assert.doesNotMatch(kept, /drop\.ts/);
});

test('真实仓库：会话检查点、提交和未跟踪文件', async () => {
  const cwd = await repo();
  try {
    await commitFile(cwd, 'a.txt', 'v1\n', 'init');
    checkpoint(cwd, 'sess');
    await writeFile(join(cwd, 'a.txt'), 'v2\n');
    const session = await collectDiff(cwd, { kind: 'session' }, { readText: readTextAt(cwd), sessionId: 'sess' });
    assert.match(session.notice, /检查点/);
    assert.equal(session.commits, null);
    const fromTree = buildWalkthrough(session);
    assert.match(fromTree.steps[0].body, /a\.txt/);
    assert.equal(fromTree.steps[0].hunks[0].lines.some((line) => line.kind === 'add' && line.text === 'v2'), true);

    git(cwd, ['add', 'a.txt']);
    git(cwd, ['commit', '-m', '解释这一步']);
    await writeFile(join(cwd, 'extra.txt'), '新文件\n');
    const after = await collectDiff(cwd, { kind: 'session' }, { readText: readTextAt(cwd), sessionId: 'sess' });
    assert.equal(after.commits.length, 1);
    assert.equal(after.commits[0].subject, '解释这一步');
    const story = buildWalkthrough(after);
    assert.equal(story.steps[0].title, '解释这一步');
    assert.equal(story.steps.at(-1).files.some((file) => file.path === 'extra.txt'), true);

    const other = await collectDiff(cwd, { kind: 'session' }, { readText: readTextAt(cwd), sessionId: 'other' });
    assert.match(other.notice, /还没有检查点/);

    const commits = await collectDiff(cwd, { kind: 'commits', count: 2 }, { readText: readTextAt(cwd) });
    assert.deepEqual(
      commits.commits.map((item) => item.subject),
      ['init', '解释这一步'],
    );
    git(cwd, ['add', 'extra.txt']);
    const staged = buildWalkthrough(await collectDiff(cwd, { kind: 'staged' }, { readText: readTextAt(cwd) }));
    assert.equal(staged.steps.some((step) => step.files.some((file) => file.path === 'extra.txt')), true);
    const branch = buildWalkthrough(await collectDiff(cwd, { kind: 'branch', base: 'main' }, { readText: readTextAt(cwd) }));
    assert.equal(branch.source.detail, 'main');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('侧栏可以生成讲解并改步骤文字', async () => {
  const cwd = await repo();
  const dataDir = await mkdtemp(join(tmpdir(), 'walkthrough-data-'));
  try {
    await commitFile(cwd, 'app.ts', 'a\n', 'init');
    await writeFile(join(cwd, 'app.ts'), 'b\n');
    const tools = {};
    const handlers = {};
    const commands = {};
    const clipboard = [];
    const opened = [];
    activate({
      dataDir,
      tools: { register: (name, fn) => (tools[name] = fn) },
      renderer: { handle: (name, fn) => (handlers[name] = fn) },
      commands: { register: (id, fn) => (commands[id] = fn) },
      session: { list: async () => ({ current: 'sess', sessions: [] }) },
      fs: { readText: readTextAt(cwd) },
      ui: {
        view: {
          emit: async () => {},
          open: async (id) => opened.push(id),
        },
        clipboard: { writeText: async (text) => clipboard.push(text) },
      },
    });
    const ctx = { projectRoot: cwd, sessionId: 'sess' };
    const built = await handlers.build({ spec: { kind: 'worktree' } }, ctx);
    assert.equal(built.error, undefined);
    assert.match(built.walk.steps[0].title, /app\.ts/);
    const stepId = built.walk.steps[0].id;
    const saved = await handlers.save({ walkId: built.walk.id, stepId, title: '校验输入', body: '只改了返回值。' }, ctx);
    assert.equal(saved.walk.steps[0].title, '校验输入');
    const again = await handlers.state({}, ctx);
    assert.equal(again.walk.steps[0].body, '只改了返回值。');
    const rebuilt = await tools.walkthrough_build({ kind: 'worktree' }, ctx);
    assert.match(rebuilt.content, /校验输入/);
    const current = await tools.walkthrough_current({}, ctx);
    assert.match(current.content, /只改了返回值/);
    await handlers.copy({ walkId: saved.walk.id, stepId }, ctx);
    assert.match(clipboard[0], /校验输入/);
    await commands.open();
    assert.deepEqual(opened, ['walk']);
    const bad = await handlers.build({ spec: { kind: 'commits', range: 'HEAD;rm..HEAD' } }, ctx);
    assert.match(bad.error, /不合法|提交范围/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
