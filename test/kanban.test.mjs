import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.kanban/main.mjs';

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kanban-'));
  const tools = new Map();
  const handlers = new Map();
  const injected = [];
  const inserted = [];
  const created = [];
  const enso = {
    dataDir,
    tools: { register: (name, fn) => tools.set(name, fn) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    session: {
      inject: async (input) => injected.push(input),
      create: async (input) => {
        created.push(input);
        return { sessionId: 'new-1' };
      },
    },
    composer: { insertText: async (input) => inserted.push(input) },
  };
  await activate(enso);
  return { tools, handlers, injected, inserted, created, dataDir };
}

const ctx = { projectRoot: '/proj/kanban', sessionId: 'current-1' };

async function addCard(handlers, { title, body, bind }) {
  const board = await handlers.get('upsert')({ title, body, bind }, ctx);
  return board.cards.find((card) => card.title === title);
}

test('工具清单与 manifest 声明一致', async () => {
  const { tools, dataDir } = await setup();
  try {
    const manifest = JSON.parse(
      await readFile(new URL('../packages/enso.kanban/enso-plugin.json', import.meta.url), 'utf8')
    );
    assert.deepEqual(
      [...tools.keys()].sort(),
      manifest.contributes.agentTools.map((tool) => tool.name).sort()
    );
    assert.ok(manifest.permissions.includes('agent.inject'));
    assert.ok(manifest.permissions.includes('agent.injectTrusted'));
    assert.equal(manifest.engines.enso, '>=0.3.14');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('发送到 current 和 bound 时按可信任务注入', async () => {
  const { handlers, injected, dataDir } = await setup();
  try {
    const bound = await addCard(handlers, { title: '绑卡', body: '绑定正文', bind: 'bound-1' });
    await handlers.get('send')({ id: bound.id, target: 'bound' }, ctx);
    const current = await addCard(handlers, { title: '当前卡', body: '当前正文' });
    await handlers.get('send')({ id: current.id, target: 'current' }, ctx);

    assert.equal(injected.length, 2);
    assert.equal(injected[0].sessionId, 'bound-1');
    assert.equal(injected[1].sessionId, 'current-1');
    for (const call of injected) {
      assert.equal(call.deliverAs, 'followUp');
      assert.equal(call.triggerTurn, true);
      assert.equal(call.trusted, true);
    }
    assert.match(injected[0].text, /绑卡/);
    assert.match(injected[0].text, /绑定正文/);
    assert.match(injected[1].text, /当前卡/);
    assert.match(injected[1].text, /当前正文/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('发送到 draft 和 new 不调用 session.inject', async () => {
  const { handlers, injected, inserted, created, dataDir } = await setup();
  try {
    const card = await addCard(handlers, { title: '草稿卡', body: '草稿正文' });
    await handlers.get('send')({ id: card.id, target: 'draft' }, ctx);
    assert.equal(injected.length, 0);
    assert.equal(created.length, 0);
    assert.equal(inserted.length, 1);
    assert.match(inserted[0].text, /草稿卡/);
    assert.match(inserted[0].text, /草稿正文/);

    await handlers.get('send')({ id: card.id, target: 'new' }, ctx);
    assert.equal(injected.length, 0);
    assert.equal(inserted.length, 1);
    assert.equal(created.length, 1);
    assert.match(created[0].text, /草稿卡/);
    assert.match(created[0].text, /草稿正文/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
