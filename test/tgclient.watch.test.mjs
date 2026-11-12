import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { Api } from '../packages/enso.tgclient/vendor/gramjs.mjs';
import { activate, deactivate, useTelegramClient } from '../packages/enso.tgclient/main.mjs';

const session = (() => {
  const dc = Buffer.from([2]);
  const addr = Buffer.from('127.0.0.1');
  const alen = Buffer.alloc(2);
  alen.writeInt16BE(addr.length, 0);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443, 0);
  const key = Buffer.alloc(256, 1);
  return `1${Buffer.concat([dc, alen, addr, port, key]).toString('base64')}`;
})();

async function withWatch(t, fn, { blankId = false, forum = false } = {}) {
  let dataDir;
  let timers = false;
  let failSelf = false;
  const injected = [];
  const clients = [];
  t.after(async () => {
    useTelegramClient(null);
    await deactivate().catch(() => {});
    if (timers) mock.timers.reset();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  timers = true;
  dataDir = await mkdtemp(join(tmpdir(), 'tgw-'));
  await writeFile(join(dataDir, 'account.json'), JSON.stringify({ session }), { mode: 0o600 });
  class FakeClient {
    constructor() {
      clients.push(this);
      this.handlers = [];
    }
    setLogLevel() {}
    async connect() {}
    async checkAuthorization() { return true; }
    async destroy() {}
    async getMe() {
      if (failSelf) throw new Error('getMe failed');
      if (blankId) return new Api.User({ id: { toString() { return ''; } }, firstName: 'Me', username: 'me' });
      return new Api.User({ id: 42, firstName: 'Me', username: 'me' });
    }
    async getDialogs() { return []; }
    async getInputEntity() { return null; }
    async getEntity(ref) {
      const n = Number(ref) || 100;
      if (forum) return new Api.Channel({ id: n, title: n === 100 ? '群' : `群${n}`, megagroup: true, forum: true });
      return new Api.Chat({ id: n, title: '群' });
    }
    async sendMessage(entity, { message }) {
      // 真实的发送结果里 chatId 由 peerId 推出来，这里直接给普通对象，测试只关心 id 与 chatId
      return { id: 900, chatId: 100, message, out: true, date: 1_700_000_001, peerId: { chatId: 100 } };
    }
    async invoke(req) {
      if (req instanceof Api.account.GetNotifySettings) return { muteUntil: 0 };
      if (req instanceof Api.messages.GetDialogFilters) return { filters: [] };
      return {};
    }
    addEventHandler(fn) { this.handlers.push(fn); }
    session = { save: () => session };
  }
  useTelegramClient(FakeClient);
  const tools = new Map();
  await activate({
    dataDir,
    config: { get: async () => ({ notify: false }) },
    ui: { notify: async () => {}, openExternal: async () => {} },
    renderer: { handle: () => {} },
    tools: { register: (name, fn) => tools.set(name, fn) },
    session: { inject: async (input) => injected.push(input) },
  });
  await tools.get('tg_watch')({ debounceSec: 30, minIntervalSec: 60 }, { sessionId: 's1' });
  let n = 0;
  const emit = async (extra = {}) => {
    const m = {
      id: ++n,
      date: 1_700_000_000,
      out: false,
      chatId: 100,
      senderId: 7,
      sender: new Api.User({ id: 7, firstName: 'Bob' }),
      message: '',
      getChat: async () => new Api.Chat({ id: 100, title: '群' }),
      getSender: async () => new Api.User({ id: 7, firstName: 'Bob' }),
      ...extra,
    };
    const handler = clients.at(-1)?.handlers?.[0];
    assert.ok(handler, '新消息处理器未注册');
    await handler({ message: m });
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  const tick = async (ms) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  await fn({
    injected,
    emit,
    tick,
    tools,
    dataDir,
    failSelf() { failSelf = true; },
  });
}

test('没有自己的 id，或消息解析失败时，不算优先', async () => {
  const mod = await import('../packages/enso.tgclient/main.mjs');
  const self = { id: 42, username: 'me' };
  assert.equal(mod.isPriorityMessage({ mentioned: true, message: '@me' }, null), false);
  assert.equal(mod.isPriorityMessage({ mentioned: true, message: 'x' }, self), true);
  assert.equal(mod.isPriorityMessage({
    mentioned: true,
    message: 'x',
    get entities() { throw new Error('bad'); },
  }, self), true);
  assert.equal(mod.isPriorityMessage({
    message: 'x',
    entities: [{ get className() { throw new Error('bad'); } }],
  }, self), false);
  assert.equal(mod.isPriorityMessage({ message: '回复你', replyTo: { userId: 42 } }, self), true);
  assert.equal(mod.isPriorityMessage({ message: '回复别人', replyTo: { userId: 7 } }, self), false);
  assert.equal(mod.isPriorityMessage({
    message: '回复',
    replyTo: { replyFrom: { fromId: { userId: 42 } } },
  }, self), true);
  assert.equal(mod.isPriorityMessage({
    message: '@me 在吗',
    entities: [{ className: 'MessageEntityMention', offset: 0, length: 3 }],
  }, self), true);
  assert.equal(mod.isPriorityMessage({
    message: '点名',
    entities: [{ className: 'MessageEntityMentionName', offset: 0, length: 2, userId: 42 }],
  }, { id: '42' }), true);
  assert.equal(mod.isPriorityMessage({
    message: '@bob',
    entities: [{ className: 'MessageEntityMention', offset: 0, length: 4 }],
  }, self), false);
});

test('@我或回复我的消息在安静期未到时立即投递，普通消息仍等待', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '普通' });
    assert.equal(injected.length, 0);
    await tick(29_000);
    assert.equal(injected.length, 0);
    await tick(1_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /普通/);
    assert.equal(injected[0].sessionId, 's1');
    assert.equal(injected[0].deliverAs, 'followUp');
    assert.equal(injected[0].triggerTurn, true);

    await emit({ message: '看我', mentioned: true });
    assert.equal(injected.length, 2);
    assert.match(injected[1].text, /看我/);

    await emit({ message: '回复你', replyTo: { replyToMsgId: 3, userId: 42 } });
    assert.equal(injected.length, 3);
    await emit({
      message: '@me 在吗',
      entities: [{ className: 'MessageEntityMention', offset: 0, length: 3 }],
    });
    assert.equal(injected.length, 4);
    await emit({
      message: '点名',
      entities: [{ className: 'MessageEntityMentionName', offset: 0, length: 2, userId: 42 }],
    });
    assert.equal(injected.length, 5);

    await emit({ message: '回复别人', replyTo: { replyToMsgId: 9, userId: 7 } });
    assert.equal(injected.length, 5);
    await tick(59_000);
    assert.equal(injected.length, 5);
    await tick(1_000);
    assert.equal(injected.length, 6);
    assert.match(injected[5].text, /回复别人/);
  });
});

test('队列里的普通消息随优先消息合并投递一次，不会再投第二遍', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '普通甲' });
    assert.equal(injected.length, 0);
    await emit({ message: '优先乙', mentioned: true });
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /普通甲/);
    assert.match(injected[0].text, /优先乙/);
    assert.match(injected[0].text, /共 2 条/);
    await tick(120_000);
    assert.equal(injected.length, 1);
  });
});

test('最小间隔未到也立即投优先消息，之后的普通消息仍受间隔约束且不丢', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '先来' });
    await tick(30_000);
    assert.equal(injected.length, 1);

    await emit({ message: '再来' });
    await tick(30_000);
    assert.equal(injected.length, 1);

    await emit({ message: '@我', mentioned: true });
    assert.equal(injected.length, 2);
    assert.match(injected[1].text, /再来/);
    assert.match(injected[1].text, /@我/);

    await emit({ message: '还得等' });
    assert.equal(injected.length, 2);
    await tick(59_000);
    assert.equal(injected.length, 2);
    await tick(1_000);
    assert.equal(injected.length, 3);
    assert.match(injected[2].text, /还得等/);
    await tick(120_000);
    assert.equal(injected.length, 3);
  });
});

test('再次 getMe 失败时沿用已缓存的自己 id；解析失败则退回攒批且不抛错', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, failSelf }) => {
    failSelf();
    await emit({ message: '还是我', mentioned: true });
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /还是我/);

    await emit({
      message: '坏实体',
      entities: [{
        className: 'MessageEntityMentionName',
        offset: 0,
        length: 1,
        get userId() { throw new Error('bad entity'); },
      }],
    });
    assert.equal(injected.length, 1);
    await tick(60_000);
    assert.equal(injected.length, 2);
    assert.match(injected[1].text, /坏实体/);
  });
});

test('拿不到自己的 id 时 @我 也退回攒批，不报错', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '提到我', mentioned: true });
    assert.equal(injected.length, 0);
    await tick(29_000);
    assert.equal(injected.length, 0);
    await tick(1_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /提到我/);
  }, { blankId: true });
});

test('手机上自己发的消息照常进监听，不再被 out 一律丢掉', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ out: true, message: '手机手打的一句' });
    assert.equal(injected.length, 0);
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /手机手打的一句/);
  });
});

test('本插件自己发出去的消息回声不再投递，避免自我唤醒', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await tools.get('tg_send_message')({ chat: '100', text: '我回一句' });
    await emit({ id: 900, out: true, message: '我回一句' });
    await tick(30_000);
    assert.equal(injected.length, 0);

    await emit({ id: 901, out: true, message: '之后手机又发了一条' });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /之后手机又发了一条/);
  });
});

const inTopic = (id, message, extra = {}) => ({
  message,
  replyTo: { forumTopic: true, replyToMsgId: id, ...extra },
  ...extra,
});

test('指定话题后只投递这个话题，其它话题和 General 都不进队列', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools, dataDir }) => {
    const watching = await tools.get('tg_watch')({ chat: '100', topic: 55, debounceSec: 30, minIntervalSec: 60 }, { sessionId: 's1' });
    assert.equal(watching.watching.topic, 55);
    assert.match(watching.watching.chat, /群 \(100\).*话题 55/);
    const saved = JSON.parse(await readFile(join(dataDir, 'account.json'), 'utf8'));
    const row = saved.watches.find((w) => w.sessionId === 's1');
    assert.equal(row.topic, 55);
    assert.equal(row.chat, '100');
    assert.equal(row.topicTitle, '话题 55');

    await emit(inTopic(77, '别的话题'));
    await emit({ message: '总话题' });
    await emit({ message: '别的话题里@我', mentioned: true, replyTo: { forumTopic: true, replyToMsgId: 77 } });
    await tick(30_000);
    assert.equal(injected.length, 0);

    await emit(inTopic(55, '话题根上的一条'));
    await emit({ message: '话题里的回复', replyTo: { forumTopic: true, replyToTopId: 55, replyToMsgId: 90 } });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /话题根上的一条/);
    assert.match(injected[0].text, /话题里的回复/);
    assert.match(injected[0].text, /话题 55/);
    assert.doesNotMatch(injected[0].text, /别的话题|总话题/);
  }, { forum: true });
});

test('话题 1 只收 General，不填 topic 时各个话题仍然都收', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await tools.get('tg_watch')({ chat: '100', topic: 1, debounceSec: 30, minIntervalSec: 60 }, { sessionId: 's1' });
    await emit(inTopic(55, '其它话题'));
    await emit({ message: 'General 里' });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /General 里/);
    assert.doesNotMatch(injected[0].text, /其它话题/);
    assert.match(injected[0].text, /General/);

    await tools.get('tg_watch')({ chat: '100', debounceSec: 30, minIntervalSec: 60 }, { sessionId: 's1' });
    await emit(inTopic(55, '换回全话题'));
    await emit({ message: 'General 也在' });
    await tick(30_000);
    assert.match(injected.at(-1).text, /换回全话题/);
    assert.match(injected.at(-1).text, /General 也在/);
  }, { forum: true });
});

test('没指定单个聊天、聊天没开话题，或话题 id 不合法时拒绝，且不换掉原订阅', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await assert.rejects(() => tools.get('tg_watch')({ topic: 55 }, { sessionId: 's1' }), /只能指定一个聊天/);
    await assert.rejects(() => tools.get('tg_watch')({ chat: '100', topic: 0 }, { sessionId: 's1' }), /话题 id/);
    await assert.rejects(() => tools.get('tg_watch')({ chat: '100', topic: 55 }, { sessionId: 's1' }), /不是开了话题的群/);
    await emit({ message: '原订阅还在' });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /原订阅还在/);
  });
});

test('多个聊天不能再加单个话题', async (t) => {
  await withWatch(t, async ({ tools }) => {
    await assert.rejects(
      () => tools.get('tg_watch')({ chats: ['100', '200'], topic: 55 }, { sessionId: 's1' }),
      /只能指定一个聊天/,
    );
  }, { forum: true });
});
