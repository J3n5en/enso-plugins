import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { activate, deactivate } from '../packages/enso.tgclient/main.mjs';
import { Api, getPeerId } from '../packages/enso.tgclient/vendor/gramjs.mjs';

const peerId = (p) => {
  try { return getPeerId(p).toString(); } catch { return p?.toString?.(); }
};

function clock() {
  let nowMs = 1_000_000;
  let seq = 1;
  const timers = [];
  return {
    now: () => nowMs,
    setTimer(fn, ms) {
      const id = seq++;
      timers.push({ id, at: nowMs + ms, fn });
      return id;
    },
    clearTimer(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) break;
        const t = due[0];
        timers.splice(timers.indexOf(t), 1);
        nowMs = t.at;
        await t.fn();
      }
      nowMs = target;
    },
  };
}

const person = (id, name) => new Api.User({ id: BigInt(id), accessHash: 1n, firstName: name });

function incomingMessage(id, chatId, text) {
  const uid = BigInt(chatId);
  const who = person(chatId, `U${chatId}`);
  const m = new Api.Message({
    id,
    peerId: new Api.PeerUser({ userId: uid }),
    fromId: new Api.PeerUser({ userId: uid }),
    date: 1_700_000_000,
    message: text,
    out: false,
  });
  m._sender = who;
  m._chat = who;
  return m;
}

async function setup({ typingError = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tgtype-'));
  const clk = clock();
  const calls = [];
  const injected = [];
  const handlers = [];
  const tools = new Map();
  const client = {
    session: { save: () => 'sess' },
    async connect() {},
    async checkAuthorization() { return true; },
    async getMe() { return person(1, 'Me'); },
    async destroy() {},
    addEventHandler(fn) { handlers.push(fn); },
    async getDialogs() { return []; },
    async getEntity(id) {
      const n = Number(id?.toString?.() ?? id);
      return person(n, `U${n}`);
    },
    async getInputEntity() { return null; },
    async sendMessage(_entity, { message }) {
      return new Api.Message({
        id: 99,
        peerId: new Api.PeerUser({ userId: 1n }),
        date: 1_700_000_000,
        message,
        out: true,
      });
    },
    async invoke(req) {
      calls.push(req);
      if (req.className === 'messages.SetTyping') {
        if (typingError) throw new Error('network down');
        return true;
      }
      if (req.className === 'messages.GetDialogFilters') return { filters: [] };
      return null;
    },
  };
  const enso = {
    dataDir,
    config: { get: async () => ({ notify: false }) },
    ui: { notify: async () => {}, openExternal: async () => {} },
    renderer: { handle: () => {} },
    tools: { register: (name, fn) => tools.set(name, fn) },
    session: { inject: async (input) => injected.push(input) },
  };
  await activate(enso, { client, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  const typing = () => calls.filter((c) => c.className === 'messages.SetTyping');
  const watch = (args, sessionId = 's1') => tools.get('tg_watch')({ debounceSec: 1, ...args }, { sessionId });
  const push = async (chatId, id) => handlers[0]({ message: incomingMessage(id, chatId, 'hi') });
  const deliver = async (chatId, id = 5) => {
    await push(chatId, id);
    await clk.advance(1000);
  };
  return { ...clk, injected, tools, dataDir, typing, watch, push, deliver };
}

describe('tg_watch 处理期间显示正在输入', { concurrency: false }, () => {
  test('投递时发送一次，4 秒后再发送一次', async () => {
    const t = await setup();
    try {
      await t.watch({ chat: '42' });
      assert.equal(t.typing().length, 0);
      await t.deliver(42);
      assert.equal(t.injected.length, 1);
      assert.equal(t.injected[0].deliverAs, 'followUp');
      assert.equal(t.injected[0].triggerTurn, true);
      assert.equal(t.typing().length, 1);
      assert.equal(t.typing()[0].action.className, 'SendMessageTypingAction');
      assert.equal(peerId(t.typing()[0].peer), '42');
      await t.advance(3999);
      assert.equal(t.typing().length, 1);
      await t.advance(1);
      assert.equal(t.typing().length, 2);
      assert.equal(peerId(t.typing()[1].peer), '42');
    } finally {
      await deactivate();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });

  test('send_message 成功后不再发送，取消或替换监听也会停', async () => {
    const t = await setup();
    try {
      await t.watch({ chat: '42' });
      await t.deliver(42);
      assert.equal(t.typing().length, 1);
      await t.tools.get('tg_send_message')({ chat: '42', text: '好' }, { sessionId: 's1' });
      await t.advance(12_000);
      assert.equal(t.typing().length, 1);

      await t.deliver(42, 6);
      assert.equal(t.typing().length, 2);
      await t.tools.get('tg_unwatch')({}, { sessionId: 's1' });
      await t.advance(12_000);
      assert.equal(t.typing().length, 2);

      await t.watch({ chat: '42' });
      await t.deliver(42, 7);
      assert.equal(t.typing().length, 3);
      await t.watch({ chat: '42' });
      await t.advance(12_000);
      assert.equal(t.typing().length, 3);
    } finally {
      await deactivate();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });

  test('两个聊天各自刷新，发出其中一个后另一个继续', async () => {
    const t = await setup();
    try {
      await t.watch({ chats: ['42', '43'] });
      await t.push(42, 5);
      await t.push(43, 6);
      await t.advance(1000);
      assert.equal(t.injected.length, 1);
      assert.deepEqual(t.typing().map((c) => peerId(c.peer)), ['42', '43']);
      await t.tools.get('tg_send_message')({ chat: '42', text: '只回这个' }, { sessionId: 's1' });
      await t.advance(4000);
      assert.deepEqual(t.typing().slice(2).map((c) => peerId(c.peer)), ['43']);
      await t.advance(4000);
      assert.deepEqual(t.typing().slice(2).map((c) => peerId(c.peer)), ['43', '43']);
    } finally {
      await deactivate();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });

  test('正在输入失败时投递仍然成功，且不会反复重投', async () => {
    const t = await setup({ typingError: true });
    try {
      await t.watch({ chat: '42' });
      await t.deliver(42);
      assert.equal(t.injected.length, 1);
      assert.equal(t.injected[0].triggerTurn, true);
      assert.equal(t.typing().length, 1);
      await t.advance(20_000);
      assert.equal(t.injected.length, 1);
    } finally {
      await deactivate();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });

  test('同一聊天的正在输入最多持续 5 分钟', async () => {
    const t = await setup();
    try {
      await t.watch({ chat: '42' });
      await t.deliver(42);
      const first = t.typing().length;
      assert.equal(first, 1);
      await t.advance(5 * 60_000);
      const stopped = t.typing().length;
      assert.ok(stopped > first);
      await t.advance(20_000);
      assert.equal(t.typing().length, stopped);
    } finally {
      await deactivate();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });
});
