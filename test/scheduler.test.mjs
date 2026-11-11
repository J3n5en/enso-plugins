import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.scheduler/main.mjs';

async function setup(dataDir) {
  const tools = new Map();
  const handlers = new Map();
  const schedules = new Map();
  const injected = [];
  const enso = {
    dataDir: dataDir ?? (await mkdtemp(join(tmpdir(), 'scheduler-'))),
    tools: { register: (name, fn) => tools.set(name, fn) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    schedules: { register: (id, fn) => schedules.set(id, fn) },
    session: { inject: async (input) => injected.push(input) },
    ui: { notify: async () => {} },
  };
  await activate(enso);
  return { tools, handlers, schedules, injected, dataDir: enso.dataDir };
}

test('工具清单与 manifest 声明一致', async () => {
  const { tools, dataDir } = await setup();
  try {
    const manifest = JSON.parse(
      await readFile(new URL('../packages/enso.scheduler/enso-plugin.json', import.meta.url), 'utf8')
    );
    assert.deepEqual(
      [...tools.keys()].sort(),
      manifest.contributes.agentTools.map((t) => t.name).sort()
    );
    assert.ok(manifest.permissions.includes('agent.tool'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cron_create 校验参数并把任务绑到当前会话', async () => {
  const { tools, dataDir } = await setup();
  const ctx = { sessionId: 's1' };
  try {
    const create = tools.get('cron_create');
    await assert.rejects(create({ schedule: '* * * * *', prompt: 'x' }, ctx), /任务名称/);
    await assert.rejects(create({ name: 'n', schedule: '* * * * *', prompt: '  ' }, ctx), /提示词/);
    await assert.rejects(create({ name: 'n', schedule: '99 * * * *', prompt: 'x' }, ctx), /执行时间无效/);
    await assert.rejects(create({ name: 'n', schedule: '* * * * *', prompt: 'x' }, {}), /请先打开一个会话/);

    const created = await create({ name: '看 PR', schedule: '*/10 * * * *', prompt: '查下 CI' }, ctx);
    assert.equal(created.ok, true);
    assert.equal(created.task.name, '看 PR');
    assert.equal(created.task.schedule, '*/10 * * * *');
    assert.equal(created.task.enabled, true);
    assert.match(created.task.description, /每 ?10 分钟/);
    assert.ok(created.task.nextRunAt > Date.now());
    assert.equal(created.total, 1);

    // 另一个会话看不到，也删不掉
    assert.deepEqual((await tools.get('cron_list')({}, { sessionId: 's2' })).tasks, []);
    await assert.rejects(tools.get('cron_delete')({ id: created.task.id }, { sessionId: 's2' }), /任务不存在/);

    // 带 id 是更新而不是新建
    const updated = await create({ id: created.task.id, name: '看 PR', schedule: '0 9 * * 1-5', prompt: '查下 CI' }, ctx);
    assert.equal(updated.task.id, created.task.id);
    assert.equal(updated.total, 1);
    assert.match(updated.task.description, /工作日/);

    const listed = await tools.get('cron_list')({}, ctx);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.task.id);

    const deleted = await tools.get('cron_delete')({ id: created.task.id }, ctx);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.remaining, 0);
    assert.deepEqual((await tools.get('cron_list')({}, ctx)).tasks, []);
    await assert.rejects(tools.get('cron_delete')({}, ctx), /任务 id/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('到点把提示词注入到绑定的会话，通知任务只弹通知', async () => {
  const { tools, handlers, injected, dataDir } = await setup();
  try {
    const promptTask = await tools.get('cron_create')(
      { name: 'p', schedule: '* * * * *', prompt: '继续盯' },
      { sessionId: 's1' }
    );
    await handlers.get('runNow')({ id: promptTask.task.id }, { sessionId: 's1' });
    assert.deepEqual(injected, [
      { sessionId: 's1', text: '继续盯', deliverAs: 'followUp', triggerTurn: true },
    ]);

    await tools.get('cron_create')(
      { name: 'n', schedule: '* * * * *', prompt: '喝口水', action: 'notify' },
      { sessionId: 's1' }
    );
    const { tasks } = await tools.get('cron_list')({}, { sessionId: 's1' });
    const notifyTask = tasks.find((t) => t.name === 'n');
    await handlers.get('runNow')({ id: notifyTask.id }, { sessionId: 's1' });
    assert.equal(injected.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
