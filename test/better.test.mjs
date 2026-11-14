import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  activate,
  buildTask,
  describeTool,
  parseMarkedPrompt,
  stepOf,
} from '../packages/enso.better/main.mjs';
import { mergeDraft } from '../packages/enso.better/ui.js';

function setup({ config = {} } = {}) {
  const closed = [];
  const handlers = new Map();
  const emitted = [];
  const runs = [];
  const enso = {
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    config: { get: async () => config },
    ui: {
      view: {
        emit: async (name, data) => emitted.push({ name, data }),
        open: async () => {},
        close: async (viewId) => closed.push(viewId),
      },
      clipboard: { writeText: async () => {} },
    },
    composer: { insertText: async () => ({ rev: 1 }) },
    agent: {
      run: (input) =>
        new Promise((resolve, reject) => {
          runs.push({ input, resolve, reject });
          input.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('已取消'), { code: 'ABORTED' }))
          );
        }),
    },
  };
  activate(enso);
  const call = (name, args, sessionId = 's1') => handlers.get(name)(args, { sessionId });
  return { handlers, emitted, runs, call, closed };
}

const reply = '(1) a\n(2) b\n(3) c\n(4) d\n\n<improved-prompt>\n深入的提示词\n</improved-prompt>';

test('清单声明的方法都已注册', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../packages/enso.better/enso-plugin.json', import.meta.url), 'utf8')
  );
  const { handlers } = setup();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    manifest.contributes.methods.map((m) => m.name).sort()
  );
  assert.ok(manifest.permissions.includes('agent.run'));
});

test('解析改写块：开标签须独占一行，取最后一个块', () => {
  assert.equal(parseMarkedPrompt(reply), '深入的提示词');
  assert.equal(
    parseMarkedPrompt('提到 <improved-prompt> 也没关系\n<improved-prompt>\nX\n</improved-prompt>'),
    'X'
  );
  assert.throws(() => parseMarkedPrompt('(1) 没有块'), /没有/);
  assert.throws(() => parseMarkedPrompt('<improved-prompt>\n\n</improved-prompt>'), /空/);
});

test('进度按回答编号与改写块推进', () => {
  assert.equal(stepOf(''), 0);
  assert.equal(stepOf('(1) x\n(2) y'), 2);
  assert.equal(stepOf('**(4)** z'), 4);
  assert.equal(stepOf(`(4) z\n<improved-prompt>\n`), 5);
});

test('任务正文：空草稿改写进行中的任务', () => {
  assert.match(buildTask(''), /deepen the task in progress/);
  assert.match(buildTask('修 bug'), /## Prompt to deepen\n\n修 bug/);
  assert.equal(describeTool('read', '{"path":"src/a.ts"}'), 'read src/a.ts');
  assert.equal(describeTool('grep', '{"pattern":"foo","path":"src"}'), 'grep foo · src');
  assert.equal(describeTool('ls', 'not json'), 'ls');
});

test('保留等待期间新输入的内容', () => {
  assert.equal(mergeDraft('P', '原文', '原文'), 'P');
  assert.equal(mergeDraft('P', '原文', '  '), 'P');
  assert.equal(mergeDraft('P', '原文', '原文 加一句'), 'P\n\n原文 加一句');
});

test('start 立即返回，wait 在跑完后给出提示词；同会话复用进行中的改写', async () => {
  const s = setup({ config: { context: 'none' } });
  const { runId } = await s.call('start', { text: '  修 bug  ' });
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].input.context, 'none');
  assert.match(s.runs[0].input.prompt, /修 bug/);
  assert.deepEqual(await s.call('start', { text: 'x' }), { runId });
  assert.equal(s.runs.length, 1);

  s.runs[0].input.onEvent({ type: 'tool-start', id: 't1', name: 'read', args: '{"path":"a"}' });
  s.runs[0].input.onEvent({ type: 'tool-end', id: 't1', isError: false, output: '文件内容' });
  s.runs[0].input.onEvent({
    type: 'tool-start',
    id: 't2',
    name: 'grep',
    args: '{"pattern":"x"}',
    parentId: 'c1',
  });
  s.runs[0].input.onEvent({ type: 'text', text: '(1) a\n(2) b' });
  assert.deepEqual(await s.call('wait', { runId, step: -1 }), {
    status: 'running',
    step: 2,
    prompt: null,
    error: null,
  });
  const waiting = s.call('wait', { runId, step: 2 });
  s.runs[0].resolve({ text: reply, model: 'm1' });
  assert.deepEqual(await waiting, { status: 'done', step: 5, prompt: '深入的提示词', error: null });
  const last = s.emitted.at(-1).data;
  assert.equal(last.status, 'done');
  assert.equal(last.model, 'm1');
  // 推送只带摘要，输入输出按需取
  assert.deepEqual(last.tools, [
    { id: 't1', label: 'read a', status: 'ok' },
    { id: 't2', label: 'grep x', status: 'error', parentId: 'c1' },
  ]);
  assert.deepEqual(await s.call('tool', { runId, id: 't1' }), {
    input: '{\n  "path": "a"\n}',
    output: '文件内容',
  });
  assert.equal(await s.call('tool', { runId, id: 'nope' }), null);

  const snap = await s.call('snapshot', {});
  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.autoClose, 5);
  assert.equal(snap.runs[0].id, runId);
  assert.deepEqual((await s.call('snapshot', {}, 's2')).runs, []);
  await s.call('closeView', {});
  assert.deepEqual(s.closed, ['runs']);
});

test('autoClose 为 0 时不自动关闭', async () => {
  const s = setup({ config: { autoClose: 0 } });
  assert.equal((await s.call('snapshot', {})).autoClose, 0);
});

test('空草稿总带对话；取消后状态为 cancelled；缺块报错', async () => {
  const s = setup({ config: { context: 'none' } });
  const first = await s.call('start', { text: '' });
  assert.equal(s.runs[0].input.context, 'fork');
  await s.call('cancel', { runId: first.runId });
  assert.equal((await s.call('wait', { runId: first.runId, step: 0 })).status, 'cancelled');

  const second = await s.call('start', { text: 'y' });
  s.runs[1].resolve({ text: '(1) 只有回答' });
  const result = await s.call('wait', { runId: second.runId, step: 0 });
  assert.equal(result.status, 'error');
  assert.match(result.error, /没有/);
  await assert.rejects(s.call('insert', { runId: second.runId }), /没有可用/);
});
