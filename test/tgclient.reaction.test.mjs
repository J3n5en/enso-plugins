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
const tick = () => new Promise((r) => setImmediate(r));

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
      await tick();
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) break;
        const t = due[0];
        timers.splice(timers.indexOf(t), 1);
        nowMs = t.at;
        await t.fn();
        await tick();
      }
      nowMs = target;
      await tick();
    },
  };
}

const person = (id, name) => new Api.User({ id: BigInt(id), accessHash: 1n, firstName: name });

function incomingMessage(id, chatId, text, out = false) {
  const uid = BigInt(chatId);
  const who = person(chatId, `U${chatId}`);
  const m = new Api.Message({
    id,
    peerId: new Api.PeerUser({ userId: uid }),
    fromId: new Api.PeerUser({ userId: out ? 1n : uid }),
    date: 1_700_000_000,
    message: text,
    out,
  });
  m._sender = who;
  m._chat = who;
  return m;
}

async function setup({ reactError, status = 'idle' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tgreact-'));
  const clk = clock();
  const order = [];
  const reacts = [];
  const injected = [];
  const handlers = [];
  const listeners = [];
  const tools = new Map();
  let sendGate = null;
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
    async sendMessage(peer, { message }) {
      await sendGate?.promise;
      const m = incomingMessage(900, Number(peerId(peer)), message, true);
      return m;
    },
    async invoke(req) {
      if (req.className === 'messages.SendReaction') {
        const emoji = req.reaction.at(-1).emoticon;
        order.push(`react:${emoji}`);
        reacts.push({ chat: peerId(req.peer), msgId: req.msgId, emoji, at: clk.now() });
        const err = reactError?.(emoji);
        if (err) throw err;
        return { updates: [] };
      }
      if (req.className === 'messages.GetDialogFilters') return { filters: [] };
      return true;
    },
  };
  const enso = {
    dataDir,
    config: { get: async () => ({ notify: false }) },
    ui: { notify: async () => {}, openExternal: async () => {} },
    renderer: { handle: () => {} },
    tools: { register: (name, fn) => tools.set(name, fn) },
    session: {
      inject: async (input) => { order.push('inject'); injected.push(input); },
      onTurnEnd: (fn) => { listeners.push(fn); return () => {}; },
      status: async (sessionId) => ({ sessionId, state: typeof status === 'function' ? status() : status }),
    },
  };
  await activate(enso, { client, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  const watch = (args, sessionId = 's1') => tools.get('tg_watch')({ debounceSec: 1, ...args }, { sessionId });
  const push = async (chatId, id, out = false) => handlers[0]({ message: incomingMessage(id, chatId, 'hi', out) });
  const holdSend = () => {
    let release;
    sendGate = { promise: new Promise((r) => { release = r; }) };
    return () => { release(); sendGate = null; };
  };
  const deliver = async (chatId, id = 5) => {
    await push(chatId, id);
    await clk.advance(1000);
  };
  const turnEnd = async (sessionId = 's1') => {
    listeners[0]({ sessionId });
    await tick();
  };
  return { ...clk, order, reacts, injected, tools, dataDir, watch, push, deliver, turnEnd, holdSend };
}

async function run(opts, fn) {
  const t = await setup(opts);
  try {
    await fn(t);
  } finally {
    await deactivate();
    await rm(t.dataDir, { recursive: true, force: true });
  }
}

describe('tg_watch 处理状态表情', { concurrency: false }, () => {
  test('投递前给原消息点 ⚡，回合结束换成 ✅', () =>
    run({}, async (t) => {
      const r = await t.watch({ chat: '42' });
      assert.equal(r.watching.reactions, true);
      await t.deliver(42, 5);
      assert.deepEqual(t.order, ['react:⚡', 'inject']);
      assert.equal(t.reacts[0].chat, '42');
      assert.equal(t.reacts[0].msgId, 5);
      await t.advance(5000);
      await t.turnEnd();
      await t.advance(0);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡', '✅']);
      assert.equal(t.reacts[1].msgId, 5);
    }));

  test('回合失败时换成 ❌', () =>
    run({ status: 'error' }, async (t) => {
      await t.watch({ chat: '42' });
      await t.deliver(42, 5);
      await t.advance(5000);
      await t.turnEnd();
      await t.advance(0);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡', '❌']);
    }));

  test('表情不被允许时退到备选，其余错误不重试', () =>
    run({ reactError: (e) => (e === '✅' ? Object.assign(new Error('400: REACTION_INVALID'), { errorMessage: 'REACTION_INVALID' }) : null) }, async (t) => {
      await t.watch({ chat: '42' });
      await t.deliver(42, 5);
      await t.advance(5000);
      await t.turnEnd();
      await t.advance(0);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡', '✅', '👍']);
    }));

  test('表情请求抛错时投递照常成功', () =>
    run({ reactError: () => Object.assign(new Error('403: CHAT_ADMIN_REQUIRED'), { errorMessage: 'CHAT_ADMIN_REQUIRED' }) }, async (t) => {
      await t.watch({ chat: '42' });
      await t.deliver(42, 5);
      assert.equal(t.injected.length, 1);
      assert.equal(t.injected[0].triggerTurn, true);
      await t.advance(5000);
      await t.turnEnd();
      await t.advance(0);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡', '✅']);
      await t.deliver(42, 6);
      assert.equal(t.injected.length, 2);
    }));

  test('同一聊天只挂一个 ⚡，请求间隔至少 2 秒', () =>
    run({}, async (t) => {
      await t.watch({ chat: '42' });
      await t.deliver(42, 5);
      await t.deliver(42, 6);
      assert.equal(t.injected.length, 2);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡']);
      await t.turnEnd();
      await t.advance(999);
      assert.equal(t.reacts.length, 1);
      await t.advance(1);
      assert.deepEqual(t.reacts.map((x) => x.emoji), ['⚡', '✅']);
      assert.equal(t.reacts[1].at - t.reacts[0].at, 2000);
      assert.equal(t.reacts[1].msgId, 5);
      await t.deliver(42, 8);
      assert.equal(t.reacts.length, 2);
      await t.advance(1000);
      assert.deepEqual(t.reacts.map((x) => [x.emoji, x.msgId]), [['⚡', 5], ['✅', 5], ['⚡', 8]]);
      assert.ok(t.reacts[2].at - t.reacts[1].at >= 2000);
    }));

  test('reactions:false 时零请求', () =>
    run({}, async (t) => {
      const r = await t.watch({ chat: '42', reactions: false });
      assert.equal(r.watching.reactions, false);
      await t.deliver(42, 5);
      await t.turnEnd();
      await t.advance(10_000);
      assert.equal(t.injected.length, 1);
      assert.equal(t.reacts.length, 0);
    }));

  test('回合结束只更新该会话的表情', () =>
    run({}, async (t) => {
      await t.watch({ chat: '42' }, 's1');
      await t.watch({ chat: '43' }, 's2');
      await t.deliver(42, 5);
      await t.deliver(43, 6);
      await t.advance(5000);
      await t.turnEnd('s2');
      await t.advance(0);
      assert.deepEqual(t.reacts.map((x) => [x.chat, x.emoji]), [['42', '⚡'], ['43', '⚡'], ['43', '✅']]);
    }));

  test('用户自己（手机）发的消息同样点 ⚡', () =>
    run({}, async (t) => {
      await t.watch({ chat: '42' });
      await t.push(42, 5, true);
      await t.advance(1000);
      assert.equal(t.injected.length, 1);
      assert.deepEqual(t.reacts.map((x) => [x.chat, x.msgId, x.emoji]), [['42', 5, '⚡']]);
    }));

  test('插件自己发出去的回声不点表情', () =>
    run({}, async (t) => {
      await t.watch({ chat: '42' });
      await t.tools.get('tg_send_message')({ chat: '42', text: 'reply' }, { sessionId: 's1' });
      await t.push(42, 900, true);
      await t.advance(1000);
      assert.equal(t.injected.length, 0);
      assert.equal(t.reacts.length, 0);
    }));

  test('投递时本插件正在向该聊天发送，排队的 out 消息不点表情', () =>
    run({}, async (t) => {
      await t.watch({ chat: '42' });
      await t.push(42, 5, true);
      const release = t.holdSend();
      const sent = t.tools.get('tg_send_message')({ chat: '42', text: 'reply' }, { sessionId: 's1' });
      await t.advance(1000);
      assert.equal(t.injected.length, 1);
      assert.equal(t.reacts.length, 0);
      release();
      await sent;
    }));
});
