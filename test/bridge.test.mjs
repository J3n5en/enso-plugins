import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.bridge/main.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createHarness(dir, options = {}) {
  const tools = {};
  const renderer = {};
  const events = {};
  const injected = [];
  const aborted = [];
  const focused = [];
  const emitted = [];
  let openedCount = 0;

  const sessions = options.sessions ?? [
    { id: 'sess-a', title: '架构主控 A', updatedAt: 3000, state: 'running', running: true },
    { id: 'sess-b', title: '后端接口 B', updatedAt: 2000, state: 'idle', running: true },
    { id: 'sess-c', title: '前端组件 C', updatedAt: 1000, state: 'idle', running: true },
  ];

  const view = {
    emit: (name, data) => emitted.push({ name, data }),
    ...(options.withoutViewOpen
      ? {}
      : {
          open: async () => {
            if (options.viewOpenThrows) throw new Error('UNSUPPORTED');
            openedCount += 1;
          },
        }),
  };

  const enso = {
    pluginId: 'enso.bridge',
    dataDir: dir,
    tools: {
      register: (name, fn) => {
        tools[name] = fn;
      },
    },
    renderer: {
      handle: (name, fn) => {
        renderer[name] = fn;
      },
    },
    events: {
      on: (name, fn) => {
        events[name] = fn;
      },
    },
    session: {
      list: async () => ({ current: options.current ?? 'sess-a', sessions }),
      status: async (id) => {
        const found = sessions.find((s) => s.id === id);
        return { sessionId: id, state: found?.state ?? 'idle', pendingAsks: 0, pendingApprovals: 0 };
      },
      inject: async (input) => {
        injected.push(input);
        if (options.onInject) await options.onInject(input, { tools, events, sessions });
      },
      abort: async (id) => {
        aborted.push(id);
      },
      focus: async (id) => {
        focused.push(id);
      },
    },
    ui: {
      notify: () => {},
      view,
    },
  };

  activate(enso);

  return {
    tools,
    renderer,
    events,
    injected,
    aborted,
    focused,
    emitted,
    get openedCount() {
      return openedCount;
    },
  };
}

test('bridge_sessions 列出同项目活跃会话并标明当前会话与对端会话', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir);
    const res = await h.tools.bridge_sessions({}, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.equal(typeof res.content, 'string');
    assert.ok(res.content.includes('后端接口 B'));
    assert.ok(res.content.includes('前端组件 C'));
    assert.equal(res.details.current, 'sess-a');
    assert.equal(res.details.peers.length, 2);
  });
});

test('bridge_sessions activeOnly 只把最近群聊参与者算作活跃，久远参与者不再计入', async () => {
  await withDir(async (dir) => {
    const now = Date.now();
    const key = createHash('sha256').update('/proj').digest('hex').slice(0, 16);
    await mkdir(join(dir, 'rooms'), { recursive: true });
    await writeFile(
      join(dir, 'rooms', `${key}.json`),
      JSON.stringify({
        rev: 1,
        messages: [
          { id: 'req-old', kind: 'question', fromId: 'sess-a', targets: [{ id: 'sess-b' }], createdAt: now - 2 * 60 * 60 * 1000 },
          { id: 'req-new', kind: 'question', fromId: 'sess-a', targets: [{ id: 'sess-c' }], createdAt: now - 60 * 1000 },
        ],
      })
    );
    const h = createHarness(dir, {
      sessions: [
        { id: 'sess-a', title: '主控 A', updatedAt: 4000, state: 'running', running: true },
        { id: 'sess-b', title: '久远成员 B', updatedAt: 3000, state: 'idle', running: false },
        { id: 'sess-c', title: '最近成员 C', updatedAt: 2000, state: 'idle', running: false },
        { id: 'sess-d', title: '无关会话 D', updatedAt: 1000, state: 'idle', running: false },
      ],
    });
    const res = await h.tools.bridge_sessions({ activeOnly: true }, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.deepEqual(
      res.details.peers.map((s) => s.id),
      ['sess-c']
    );
  });
});

test('bridge_ask 同步等待多个目标会话回复（支持 bridge_reply 与 agent_end 自动捕获）并自动打开侧栏', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir, {
      onInject: async (input, { tools, events }) => {
        if (input.sessionId === 'sess-b') {
          queueMicrotask(async () => {
            await tools.bridge_reply(
              { reply: 'B 确认：接口参数为 userId 和 token' },
              { sessionId: 'sess-b', projectRoot: '/proj', agent: null }
            );
          });
        } else if (input.sessionId === 'sess-c') {
          queueMicrotask(async () => {
            await events.agent_end(
              { text: 'C 确认：登录表单已绑定这两个字段' },
              { sessionId: 'sess-c', projectRoot: '/proj', agent: null }
            );
          });
        }
      },
    });

    const progressLogs = [];
    const res = await h.tools.bridge_ask(
      {
        targets: ['sess-b', '前端组件 C'],
        question: '请确认登录接口的入参与表单绑定情况',
        wait: true,
      },
      {
        sessionId: 'sess-a',
        projectRoot: '/proj',
        agent: null,
        progress: (text) => progressLogs.push(text),
      }
    );

    assert.equal(h.openedCount, 1);
    assert.equal(h.injected.length, 2);
    assert.ok(res.content.includes('B 确认：接口参数为 userId 和 token'));
    assert.ok(res.content.includes('C 确认：登录表单已绑定这两个字段'));
    assert.ok(progressLogs.length >= 1);

    const snap = await h.renderer.snapshot({}, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.equal(snap.messages.length, 3);
    assert.equal(snap.messages[0].kind, 'question');
    assert.equal(snap.messages[0].fromId, 'sess-a');
    assert.equal(snap.messages[1].kind, 'reply');
    assert.equal(snap.messages[2].kind, 'reply');
  });
});

test('bridge_ask 兼容旧版 main（无 ui.view.open 或调用抛错时不中断提问）且支持异步回推', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir, {
      withoutViewOpen: true,
    });

    const askRes = await h.tools.bridge_ask(
      {
        targets: ['sess-b'],
        question: '异步检查数据库迁移状态',
        wait: false,
      },
      { sessionId: 'sess-a', projectRoot: '/proj', agent: null }
    );
    assert.ok(askRes.content.includes('已发送'));
    assert.equal(h.injected.length, 1);
    assert.equal(h.injected[0].sessionId, 'sess-b');

    // 当会话 B 完成回复触发 agent_end 时，应自动通过 session.inject 把回答推回给会话 A
    await h.events.agent_end(
      { text: '数据库迁移已全部执行完毕' },
      { sessionId: 'sess-b', projectRoot: '/proj', agent: null }
    );
    assert.equal(h.injected.length, 2);
    assert.equal(h.injected[1].sessionId, 'sess-a');
    assert.ok(h.injected[1].text.includes('数据库迁移已全部执行完毕'));
  });
});

test('按会话隔离：仅提问方与目标会话可见消息，无关会话不串味，点击头像可跳转', async () => {
  await withDir(async (dir) => {
    const h = createHarness(dir, { viewOpenThrows: true });
    await h.tools.bridge_ask(
      { targets: ['sess-b'], question: '帮我看一下日志报错', wait: false },
      { sessionId: 'sess-a', projectRoot: '/proj', progress: () => {} }
    );

    await h.events.agent_end(
      { text: '日志里是端口 3000 冲突' },
      { sessionId: 'sess-b', projectRoot: '/proj', agent: null }
    );

    // 提问方 sess-a 与被提问方 sess-b 均能看到这组问答
    const snapA = await h.renderer.snapshot({}, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.equal(snapA.messages.length, 2);
    assert.equal(snapA.messages[1].text, '日志里是端口 3000 冲突');

    const snapB = await h.renderer.snapshot({}, { sessionId: 'sess-b', projectRoot: '/proj' });
    assert.equal(snapB.messages.length, 2);

    // 未参与该问答的 sess-c 打开会话桥应为空，互不污染
    const snapC = await h.renderer.snapshot({}, { sessionId: 'sess-c', projectRoot: '/proj' });
    assert.equal(snapC.messages.length, 0);

    // sess-a 清空自己的会话桥记录后，不影响 sess-b 查看
    const afterClearA = await h.renderer.clear({}, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.equal(afterClearA.messages.length, 0);
    const snapBAfterClear = await h.renderer.snapshot({}, { sessionId: 'sess-b', projectRoot: '/proj' });
    assert.equal(snapBAfterClear.messages.length, 2);

    await h.renderer.focus({ sessionId: 'sess-b' }, { sessionId: 'sess-a', projectRoot: '/proj' });
    assert.deepEqual(h.focused, ['sess-b']);
  });
});
