import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, parseRemote, trimLog } from '../packages/enso.github/main.mjs';

test('parseRemote 识别 github 远程地址', () => {
  assert.equal(parseRemote('git@github.com:J3n5en/enso-plugins.git'), 'J3n5en/enso-plugins');
  assert.equal(parseRemote('https://github.com/a/b.c\n'), 'a/b.c');
  assert.equal(parseRemote('ssh://git@github.com/a/b'), 'a/b');
  assert.equal(parseRemote('https://gitlab.com/a/b.git'), null);
});

async function setup(routes) {
  const calls = [];
  const tools = {};
  const handlers = {};
  activate({
    dataDir: await mkdtemp(join(tmpdir(), 'gh-test-')),
    config: { get: async () => ({ token: 'pat' }) },
    net: {
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
        const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
        const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
        return hit ? { status: 200, body: JSON.stringify(hit[1]) } : { status: 404, body: '{"message":"Not Found"}' };
      },
    },
    ui: { openExternal: async () => {} },
    tools: { register: (n, fn) => (tools[n] = fn) },
    renderer: { handle: (n, fn) => (handlers[n] = fn) },
  });
  return { calls, tools, handlers };
}

test('list 过滤掉 issues 接口里的 PR，并带上 PAT', async () => {
  const { calls, tools } = await setup({
    'GET /repos/o/r/issues?': [
      { number: 1, title: 'bug', state: 'open', user: { login: 'u' }, labels: [{ name: 'x' }] },
      { number: 2, title: 'pr', state: 'open', pull_request: {} },
    ],
  });
  const r = await tools.github_list({ repo: 'o/r' });
  assert.deepEqual(r.items.map((i) => i.number), [1]);
  assert.equal(r.items[0].labels[0], 'x');
  assert.equal(calls[0].auth, 'Bearer pat');
});

test('关闭 PR 走 pulls 接口，先发评论', async () => {
  const { calls, tools } = await setup({
    'POST /repos/o/r/issues/5/comments': { html_url: 'u' },
    'GET /repos/o/r/issues/5': { number: 5, pull_request: {} },
    'PATCH /repos/o/r/pulls/5': {},
  });
  const r = await tools.github_set_state({ repo: 'o/r', number: 5, state: 'closed', comment: 'bye' });
  assert.equal(r.pr, true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.slice(22)}`), [
    'POST /repos/o/r/issues/5/comments',
    'GET /repos/o/r/issues/5',
    'PATCH /repos/o/r/pulls/5',
  ]);
  assert.deepEqual(calls[2].body, { state: 'closed' });
});

test('关闭 issue 带 state_reason；非法 repo 报错', async () => {
  const { calls, tools } = await setup({ 'GET /repos/o/r/issues/3': { number: 3 }, 'PATCH /repos/o/r/issues/3': {} });
  await tools.github_set_state({ repo: 'o/r', number: 3, state: 'closed', reason: 'not_planned' });
  assert.deepEqual(calls.at(-1).body, { state: 'closed', state_reason: 'not_planned' });
  await assert.rejects(tools.github_list({ repo: 'bad' }), /owner\/name/);
});

test('github_runs 透传 branch 与 status，sha 只留 7 位', async () => {
  const run = {
    id: 9,
    name: 'CI',
    display_title: 'fix',
    run_number: 3,
    run_attempt: 2,
    event: 'push',
    head_branch: 'feat/x',
    head_sha: 'abcdef1234567890',
    status: 'completed',
    conclusion: 'success',
    actor: { login: 'me' },
    updated_at: '2024-01-01T00:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/9',
  };
  const { calls, tools } = await setup({ 'GET /repos/o/r/actions/runs?': { workflow_runs: [run] } });
  const r = await tools.github_runs({ repo: 'o/r', branch: 'feat/x', status: 'success' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/runs?per_page=30&branch=feat%2Fx&status=success');
  assert.deepEqual(r.items[0], {
    id: 9,
    name: 'CI',
    title: 'fix',
    number: 3,
    attempt: 2,
    event: 'push',
    branch: 'feat/x',
    sha: 'abcdef1',
    status: 'completed',
    conclusion: 'success',
    actor: 'me',
    updatedAt: '2024-01-01T00:00:00Z',
    url: run.html_url,
  });
});

test('github_run 只给失败 job 拉 annotations，并丢掉 notice', async () => {
  const raw = {
    id: 9,
    name: 'CI',
    display_title: 't',
    run_number: 1,
    run_attempt: 1,
    event: 'push',
    head_branch: 'main',
    head_sha: 'abc1234ffff',
    status: 'completed',
    conclusion: 'failure',
    actor: { login: 'me' },
    updated_at: 't',
    html_url: 'u',
  };
  const jobs = {
    jobs: [
      { id: 1, name: 'ok', status: 'completed', conclusion: 'success', steps: [{ number: 1, name: 's', status: 'completed', conclusion: 'success' }] },
      { id: 2, name: 'bad', status: 'completed', conclusion: 'failure', started_at: 'a', completed_at: 'b', html_url: 'ju', steps: [] },
      { id: 3, name: 'note', status: 'completed', conclusion: 'failure', steps: [] },
    ],
  };
  const { calls, tools } = await setup({
    'GET /repos/o/r/actions/runs/9/jobs': jobs,
    'GET /repos/o/r/actions/runs/9': raw,
    'GET /repos/o/r/check-runs/2/annotations': [
      { annotation_level: 'failure', message: 'boom', path: 'a.js', start_line: 4 },
      { annotation_level: 'notice', message: 'n', path: 'a.js', start_line: 1 },
      { annotation_level: 'warning', message: 'w', path: 'b.js', start_line: 2 },
    ],
    'GET /repos/o/r/check-runs/3/annotations': [{ annotation_level: 'notice', message: 'only', path: 'c.js', start_line: 1 }],
  });
  const r = await tools.github_run({ repo: 'o/r', id: 9 });
  assert.equal('annotations' in r.jobs[0], false);
  assert.deepEqual(r.jobs[0].steps, [{ number: 1, name: 's', status: 'completed', conclusion: 'success' }]);
  assert.deepEqual(r.jobs[1].annotations, [
    { level: 'failure', message: 'boom', path: 'a.js', line: 4 },
    { level: 'warning', message: 'w', path: 'b.js', line: 2 },
  ]);
  assert.equal('annotations' in r.jobs[2], false);
  assert.equal(calls.some((c) => c.url.includes('/check-runs/1/')), false);
  assert.equal(calls.filter((c) => c.url.includes('/check-runs/')).length, 2);
});

test('github_run_action 把 rerun_failed 打到 rerun-failed-jobs，非法 action 不发请求', async () => {
  const { calls, tools } = await setup({ 'POST /repos/o/r/actions/runs/9/rerun-failed-jobs': {} });
  const r = await tools.github_run_action({ repo: 'o/r', id: 9, action: 'rerun_failed' });
  assert.deepEqual(r, { repo: 'o/r', id: 9, action: 'rerun_failed' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/runs/9/rerun-failed-jobs');
  assert.equal(calls[0].method, 'POST');
  const n = calls.length;
  await assert.rejects(tools.github_run_action({ repo: 'o/r', id: 9, action: 'nope' }), /action/);
  assert.equal(calls.length, n);
});

test('trimLog 去掉时间戳，合并 error 上下文，否则取尾部', () => {
  const stamp = (s) => `2024-01-02T03:04:05.1234567Z ${s}`;
  const overlapped = Array.from({ length: 100 }, (_, i) => stamp(`L${i}`));
  overlapped[50] = stamp('##[error] a');
  overlapped[60] = stamp('##[error] b');
  const merged = trimLog(overlapped.join('\n') + '\n');
  assert.equal(merged.log.includes('2024-'), false);
  assert.equal(merged.log.split('\n')[0], 'L10');
  assert.equal(merged.log.split('\n').at(-1), '##[error] b');
  assert.equal(merged.log.includes('…'), false);
  assert.equal(merged.truncated, true);

  const apart = Array.from({ length: 100 }, (_, i) => `L${i}`);
  apart[10] = '##[error] a';
  apart[80] = '##[error] b';
  const parts = trimLog(apart.join('\n')).log.split('\n…\n');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], [...Array.from({ length: 10 }, (_, i) => `L${i}`), '##[error] a'].join('\n'));
  assert.equal(parts[1], [...Array.from({ length: 40 }, (_, i) => `L${i + 40}`), '##[error] b'].join('\n'));

  const tail = trimLog(Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n'), 5);
  assert.equal(tail.log, 'L15\nL16\nL17\nL18\nL19');
  assert.equal(tail.truncated, true);
  assert.equal(trimLog('only', 10).truncated, false);
});
