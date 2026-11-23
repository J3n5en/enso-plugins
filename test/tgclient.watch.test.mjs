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

async function withWatch(t, fn, { blankId = false, forum = false, inject, host } = {}) {
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
    async getMessages(_entity, query = {}) {
      const ids = query.ids;
      const all = this.scripted ?? [];
      if (!ids?.length) return all;
      return all.filter((m) => ids.some((id) => String(m.id) === String(id)));
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
    session: {
      inject: async (input) => {
        const result = await inject?.(input);
        injected.push(input);
        return result;
      },
    },
    ...host,
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
    client: () => clients.at(-1),
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

test('多群订阅时可以把话题约束绑到其中一个群，另一个群照收全部话题', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools, dataDir }) => {
    const watching = await tools.get('tg_watch')(
      { chats: ['100', { chat: '200', topic: 55 }], debounceSec: 30, minIntervalSec: 60 },
      { sessionId: 's1' },
    );
    assert.match(watching.watching.chat, /群 \(100\)/);
    assert.match(watching.watching.chat, /群200 \(200\) › 话题 55/);
    const saved = JSON.parse(await readFile(join(dataDir, 'account.json'), 'utf8'));
    assert.equal(saved.watches[0].chatTopics['200'].topic, 55);
    assert.equal(saved.watches[0].chatTopics['100'], undefined);

    await emit({ message: '100 的任意话题' });
    await emit({ chatId: 200, ...inTopic(55, '200 的话题里') });
    await emit({ chatId: 200, ...inTopic(77, '200 别的话题') });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /100 的任意话题/);
    assert.match(injected[0].text, /200 的话题里/);
    assert.doesNotMatch(injected[0].text, /200 别的话题/);
  }, { forum: true });
});

test('对象形式里的话题 id 非法、群没开话题、与顶层 topic 混用时都拒绝', async (t) => {
  await withWatch(t, async ({ tools }) => {
    await assert.rejects(
      () => tools.get('tg_watch')({ chats: [{ chat: '100', topic: 0 }] }, { sessionId: 's1' }),
      /话题 id 必须是正整数/,
    );
    await assert.rejects(
      () => tools.get('tg_watch')({ chats: [{ chat: '100', topic: 55 }], topic: 55 }, { sessionId: 's1' }),
      /不要再传顶层 topic/,
    );
  }, { forum: true });
});

test('对象形式指定话题时该群没开话题就拒绝', async (t) => {
  await withWatch(t, async ({ tools }) => {
    await assert.rejects(
      () => tools.get('tg_watch')({ chats: [{ chat: '100', topic: 55 }] }, { sessionId: 's1' }),
      /不是开了话题的群/,
    );
  });
});

const user = (id, name) => new Api.User({ id, firstName: name });
const noRole = (sender) => {
  for (const k of ['owner', 'isOwner', 'role', 'trusted']) assert.equal(k in sender, false);
};

test('单发送者投递附带 sender，自己的 out 消息带 userId，缺 senderId 时用 getMe', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '群友一句' });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.deepEqual(injected[0].sender, { channel: 'telegram', chatId: '100', userId: '7', displayName: 'Bob' });
    noRole(injected[0].sender);

    await emit({ out: true, message: '手机上说', senderId: 42, sender: user(42, 'Phone') });
    await tick(60_000);
    assert.equal(injected.length, 2);
    assert.deepEqual(injected[1].sender, { channel: 'telegram', chatId: '100', userId: '42', displayName: 'Me' });
    noRole(injected[1].sender);

    await emit({ out: true, message: '没带发送者', senderId: undefined, sender: undefined, fromId: undefined });
    await tick(60_000);
    assert.equal(injected.length, 3);
    assert.match(injected[2].text, /没带发送者/);
    assert.deepEqual(injected[2].sender, { channel: 'telegram', chatId: '100', userId: '42', displayName: 'Me' });
    noRole(injected[2].sender);
  });
});

test('防抖批里 owner 和群友交替出现时按发送者拆成两批', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '主1', senderId: 42, sender: user(42, 'Ann') });
    await emit({ message: '群1', senderId: 7, sender: user(7, 'Bob') });
    await emit({ message: '主2', senderId: 42, sender: user(42, 'Ann') });
    await tick(30_000);
    assert.equal(injected.length, 2);
    assert.match(injected[0].text, /共 2 条/);
    assert.match(injected[0].text, /主1/);
    assert.match(injected[0].text, /主2/);
    assert.doesNotMatch(injected[0].text, /群1/);
    assert.equal(injected[0].sender.userId, '42');
    assert.match(injected[1].text, /共 1 条/);
    assert.match(injected[1].text, /群1/);
    assert.doesNotMatch(injected[1].text, /主1|主2/);
    assert.equal(injected[1].sender.userId, '7');
    noRole(injected[0].sender);
    noRole(injected[1].sender);
  });
});

test('频道身份或缺失 senderId 与个人消息拆成两批，非个人批不填 userId', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '人话', senderId: 7, sender: user(7, 'Bob') });
    await emit({
      message: '频道说',
      senderId: 7,
      sender: undefined,
      fromId: new Api.PeerChannel({ channelId: 999n }),
    });
    await tick(30_000);
    assert.equal(injected.length, 2);
    const human = injected.find((x) => x.sender.userId === '7');
    const anon = injected.find((x) => !('userId' in x.sender));
    assert.ok(human);
    assert.match(human.text, /人话/);
    assert.doesNotMatch(human.text, /频道说/);
    assert.ok(anon);
    assert.match(anon.text, /频道说/);
    assert.equal(anon.sender.channel, 'telegram');
    assert.equal(anon.sender.chatId, '100');
    noRole(anon.sender);

    await emit({ message: '又是人' });
    await emit({ message: '没身份', senderId: undefined, sender: undefined });
    await tick(60_000);
    assert.equal(injected.length, 4);
    const named = injected[2];
    const nameless = injected[3];
    assert.equal(named.sender.userId, '7');
    assert.match(named.text, /又是人/);
    assert.equal('userId' in nameless.sender, false);
    assert.match(nameless.text, /没身份/);
    assert.equal(nameless.sender.channel, 'telegram');
  });
});

test('同一发送者跨聊天时省略 chatId', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    const me = user(42, 'Ann');
    await emit({ message: '这边', senderId: 42, sender: me });
    await emit({
      message: '那边',
      chatId: 200,
      senderId: 42,
      sender: me,
      getChat: async () => new Api.Chat({ id: 200, title: '另' }),
    });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /这边/);
    assert.match(injected[0].text, /那边/);
    assert.deepEqual(injected[0].sender, { channel: 'telegram', userId: '42', displayName: 'Ann' });
    assert.equal('chatId' in injected[0].sender, false);
  });
});

test('拆批中途后一组投递失败时，已成功的不重投，失败的退避后补上', async (t) => {
  let calls = 0;
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ message: '主人甲', senderId: 42, sender: user(42, 'Ann') });
    await emit({ message: '群友乙', senderId: 7, sender: user(7, 'Bob') });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.match(injected[0].text, /主人甲/);
    assert.doesNotMatch(injected[0].text, /群友乙/);
    assert.equal(injected[0].sender.userId, '42');
    await tick(4_999);
    assert.equal(injected.length, 1);
    await tick(1);
    assert.equal(injected.length, 2);
    assert.match(injected[1].text, /群友乙/);
    assert.doesNotMatch(injected[1].text, /主人甲/);
    assert.deepEqual(injected[1].sender, { channel: 'telegram', chatId: '100', userId: '7', displayName: 'Bob' });
    await tick(120_000);
    assert.equal(injected.length, 2);
  }, {
    inject: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('inject down'), { code: 'SESSION_NOT_RUNNING' });
    },
  });
});

function memoryClaims({ owner = 's1', throwOnClaim = false, rows = [], listError = false, releaseError = false } = {}) {
  const calls = [];
  const renewed = [];
  const released = [];
  const listed = [];
  const host = {
    claims: {
      async claim(input) {
        calls.push(input);
        if (throwOnClaim) throw new Error('claim down');
        const ownerSessionId = typeof owner === 'function' ? owner(input) : owner;
        return { acquired: ownerSessionId === input.sessionId, status: 'claimed', ownerSessionId };
      },
      async renew(key, sessionId) { renewed.push({ key, sessionId }); },
      async list(filter) {
        listed.push(filter);
        if (listError) throw new Error('list down');
        return rows;
      },
      async release(key, sessionId) {
        released.push({ key, sessionId });
        if (releaseError) throw new Error('release down');
        return true;
      },
    },
  };
  return { host, calls, renewed, released, listed };
}

const fastWatch = (tools, sessionId) =>
  tools.get('tg_watch')({ chat: '100', debounceSec: 1, minIntervalSec: 0 }, { sessionId });

test('旧宿主两个会话都收到，inject 不带 claimKey', async (t) => {
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await fastWatch(tools, 's2');
    await emit({ message: '两边都要' });
    await tick(1_000);
    assert.equal(injected.length, 2);
    assert.deepEqual(injected.map((x) => x.sessionId).sort(), ['s1', 's2']);
    for (const input of injected) {
      assert.equal('claimKey' in input, false);
      assert.equal('claimLabel' in input, false);
      assert.equal(input.sender.userId, '7');
    }
  });
});

test('有认领时只投给 owner，并带上 claimKey 与 sender', async (t) => {
  const bag = memoryClaims({ owner: 's2' });
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await fastWatch(tools, 's2');
    await emit({ message: '只给负责人' });
    await tick(1_000);
    assert.equal(bag.calls.length, 1);
    assert.deepEqual(bag.calls[0].candidates.map((c) => c.sessionId).sort(), ['s1', 's2']);
    assert.equal(bag.calls[0].key, 'tg:100:1');
    assert.equal(bag.calls[0].label, '群 #1');
    assert.equal(injected.length, 1);
    assert.equal(injected[0].sessionId, 's2');
    assert.equal(injected[0].claimKey, 'tg:100:1');
    assert.equal(injected[0].claimLabel, '群 #1');
    assert.deepEqual(injected[0].sender, { channel: 'telegram', chatId: '100', userId: '7', displayName: 'Bob' });
    await tick(120_000);
    assert.equal(injected.length, 1);
  }, { host: bag.host });
});

test('只有一个监听会话时照常收到并带 claimKey', async (t) => {
  const bag = memoryClaims({ owner: 's1' });
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await emit({ message: '秘书自己的' });
    await tick(1_000);
    assert.equal(bag.calls.length, 1);
    assert.deepEqual(bag.calls[0].candidates.map((c) => c.sessionId), ['s1']);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].sessionId, 's1');
    assert.equal(injected[0].claimKey, 'tg:100:1');
  }, { host: bag.host });
});

test('认领抛错时回落为全部收到且不带 claimKey', async (t) => {
  const thrown = memoryClaims({ throwOnClaim: true });
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await fastWatch(tools, 's2');
    await emit({ message: '认领挂了' });
    await tick(1_000);
    assert.equal(thrown.calls.length, 1);
    assert.deepEqual(injected.map((x) => x.sessionId).sort(), ['s1', 's2']);
    for (const input of injected) assert.equal('claimKey' in input, false);
  }, { host: thrown.host });
});

test('认领 owner 不在候选里时回落为全部收到且不带 claimKey', async (t) => {
  const stale = memoryClaims({ owner: 'ghost' });
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await fastWatch(tools, 's2');
    await emit({ message: '别人持有' });
    await tick(1_000);
    assert.equal(stale.calls.length, 1);
    assert.deepEqual(injected.map((x) => x.sessionId).sort(), ['s1', 's2']);
    for (const input of injected) assert.equal('claimKey' in input, false);
  }, { host: stale.host });
});

test('回复消息的 claimKey 用被回复的消息 id，同批其余键会 renew', async (t) => {
  const bag = memoryClaims({ owner: 's1' });
  await withWatch(t, async ({ injected, emit, tick, tools }) => {
    await fastWatch(tools, 's1');
    await emit({ id: 4, message: '跟进甲', replyTo: { replyToMsgId: 9 } });
    await emit({ id: 5, message: '跟进乙', replyTo: { replyToMsgId: 11 } });
    await tick(1_000);
    assert.deepEqual(bag.calls.map((c) => c.key), ['tg:100:9', 'tg:100:11']);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].claimKey, 'tg:100:9');
    assert.equal(injected[0].claimLabel, '群 #9');
    assert.deepEqual(bag.renewed, [{ key: 'tg:100:11', sessionId: 's1' }]);

    await emit({ id: 8, message: '话题根', replyTo: { forumTopic: true, replyToMsgId: 55 } });
    await tick(1_000);
    assert.equal(injected.at(-1).claimKey, 'tg:100:8');
  }, { host: bag.host });
});

test('替换监听和 tg_unwatch 释放 tg: 认领，释放失败也不影响停止', async (t) => {
  const bag = memoryClaims({ rows: [{ key: 'tg:100:3' }, { key: 'tg:100:4' }] });
  await withWatch(t, async ({ tools }) => {
    await fastWatch(tools, 's1');
    assert.deepEqual(bag.listed, [{ prefix: 'tg:', sessionId: 's1' }]);
    assert.deepEqual(bag.released, [
      { key: 'tg:100:3', sessionId: 's1' },
      { key: 'tg:100:4', sessionId: 's1' },
    ]);
    bag.released.length = 0;
    bag.listed.length = 0;
    const stopped = await tools.get('tg_unwatch')({}, { sessionId: 's1' });
    assert.equal(stopped.ok, true);
    assert.deepEqual(bag.listed, [{ prefix: 'tg:', sessionId: 's1' }]);
    assert.equal(bag.released.length, 2);
  }, { host: bag.host });
});

test('认领列表失败时替换监听和 tg_unwatch 仍然成功', async (t) => {
  const bad = memoryClaims({ rows: [{ key: 'tg:100:1' }], listError: true, releaseError: true });
  await withWatch(t, async ({ tools }) => {
    const replaced = await fastWatch(tools, 's1');
    assert.equal(replaced.watching.chat.includes('100'), true);
    const stopped = await tools.get('tg_unwatch')({}, { sessionId: 's1' });
    assert.equal(stopped.ok, true);
    assert.equal(bad.released.length, 0);
  }, { host: bad.host });
});

test('tg_track_demand 的 senderId 来自消息，旧宿主返回 tracked:false', async (t) => {
  await withWatch(t, async ({ tools }) => {
    assert.deepEqual(
      await tools.get('tg_track_demand')({ chat: '100', messageId: '15', senderId: '999' }, { sessionId: 's1' }),
      { tracked: false, reason: '宿主不支持需求线程' },
    );
  });
});

test('tg_track_demand 用消息里的 senderId 登记需求线程', async (t) => {
  const opened = [];
  const text = '请把登录改成扫码';
  await withWatch(t, async ({ tools, client }) => {
    client().scripted = [{
      id: 15,
      date: 1_700_000_000,
      out: false,
      chatId: 100,
      senderId: 7,
      message: text,
      sender: new Api.User({ id: 7, firstName: 'Bob' }),
      getChat: async () => new Api.Chat({ id: 100, title: '群' }),
      replyTo: { forumTopic: true, replyToTopId: 55, replyToMsgId: 90 },
    }, {
      id: 16,
      date: 1_700_000_000,
      out: false,
      chatId: 100,
      senderId: 7,
      message: '长'.repeat(600),
      sender: new Api.User({ id: 7, firstName: 'Bob' }),
      getChat: async () => new Api.Chat({ id: 100, title: '群' }),
    }];
    const tracked = await tools.get('tg_track_demand')(
      { chat: '100', messageId: '15', senderId: '999', senderName: 'Mallory' },
      { sessionId: 's1' },
    );
    assert.deepEqual(tracked, { tracked: true, threadId: 'th1', status: 'open', requesterIsOwner: false });
    assert.equal(opened[0].sessionId, 's1');
    assert.deepEqual(opened[0].source, {
      channel: 'telegram',
      chatId: '100',
      messageId: '15',
      topicId: '55',
      senderId: '7',
      senderName: 'Bob',
      summary: text,
    });
    await tools.get('tg_track_demand')({ chat: '100', messageId: '16', sessionId: 's9' }, { sessionId: 's1' });
    assert.equal(opened[1].sessionId, 's9');
    assert.equal(opened[1].source.summary, '长'.repeat(500));
    assert.equal(opened[1].source.senderId, '7');
    assert.equal('topicId' in opened[1].source, false);
    await assert.rejects(
      () => tools.get('tg_track_demand')({ chat: '100', messageId: '99' }, { sessionId: 's1' }),
      /消息不存在/,
    );
  }, {
    host: {
      threads: {
        open: async (input) => {
          opened.push(input);
          return { id: 'th1', status: 'open', requesterIsOwner: false };
        },
      },
    },
  });
});
