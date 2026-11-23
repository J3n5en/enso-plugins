import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.telegram/main.mjs';

/** 假宿主 + 假 Bot API：记录每次调用，按队列返回 getUpdates */
async function setup({ injectError, sessions, dataDir } = {}) {
  const calls = [];
  const updates = [];
  const injected = [];
  const notes = [];
  let nextId = 100;
  const handlers = { events: {}, renderer: {}, tools: {}, schedules: {} };
  const opened = [];
  const enso = {
    dataDir: dataDir ?? (await mkdtemp(join(tmpdir(), 'tg-'))),
    config: { get: async () => ({ botToken: 'T' }) },
    net: {
      fetch: async (url, init) => {
        if (url.includes('/file/botT/')) {
          calls.push({ method: 'download', url, init });
          return { status: 200, body: 'iVBORw0K' };
        }
        const method = url.split('/').pop();
        const body = JSON.parse(init.body);
        calls.push({ method, body });
        const ok = (result) => ({ status: 200, body: JSON.stringify({ ok: true, result }) });
        if (method === 'getMe') return ok({ id: 99, username: 'enso_bot' });
        if (method === 'getUpdates') return ok(updates.splice(0));
        if (method === 'getFile') return ok({ file_path: `photos/${body.file_id}.jpg` });
        if (body.parse_mode === 'HTML' && body.text.includes('<b>坏'))
          return { status: 400, body: JSON.stringify({ ok: false, description: "can't parse entities" }) };
        if (method === 'sendMessage') return ok({ message_id: nextId++ });
        return ok(true);
      },
    },
    session: {
      ...(sessions ? { list: async () => ({ current: 's1', sessions }) } : {}),
      create: async () => ({ sessionId: 'new1' }),
      abort: async (sessionId) => {
        if (injectError) throw Object.assign(new Error('x'), { code: 'ABORT_FAILED' });
        injected.push({ abort: sessionId });
      },
      inject: async (input) => {
        if (injectError) throw Object.assign(new Error('x'), { code: injectError });
        injected.push(input);
      },
    },
    ui: { notify: async (title, body) => notes.push(body), openExternal: async (url) => opened.push(url) },
    events: { on: (name, fn) => (handlers.events[name] = fn) },
    renderer: { handle: (id, fn) => (handlers.renderer[id] = fn) },
    tools: { register: (id, fn) => (handlers.tools[id] = fn) },
  };
  const { tick, flush } = activate(enso, { loop: false });
  const message = (text, extra = {}) =>
    updates.push({
      update_id: updates.length + calls.length + 1,
      message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 7, username: 'al' }, text, ...extra },
    });
  const pair = async () => {
    const view = await handlers.renderer.pair({}, { sessionId: 's1' });
    message(`/start ${view.pairing.code}`);
  };
  const callback = (q) => updates.push({ update_id: updates.length + calls.length + 1, callback_query: q });
  return { enso, tick, flush, calls, injected, opened, handlers, message, callback, pair, of: (m) => calls.filter((c) => c.method === m) };
}

const runPoll = (t) => t.tick(0);

test('配对后发消息：先发占位，注入会话，进度原位更新，结束时把回复写进占位', async () => {
  const t = await setup();
  await t.pair();
  t.message('帮我看下测试');
  await runPoll(t);
  assert.equal(t.of('setMyCommands').length, 1);
  assert.equal(t.injected.length, 1);
  assert.equal(t.injected[0].sessionId, 's1');
  assert.equal(t.injected[0].deliverAs, 'followUp');
  assert.match(t.injected[0].text, /帮我看下测试$/);
  const placeholder = t.of('sendMessage').find((c) => c.body.text.startsWith('⏳'));
  assert.ok(placeholder);

  await t.handlers.events.tool_call({ toolName: 'bash' }, { sessionId: 's1', agent: null });
  assert.match(t.of('editMessageText').at(-1).body.text, /第 1 步：bash/);

  await t.handlers.events.agent_end({ text: '**全部通过**' }, { sessionId: 's1', agent: null });
  const final = t.of('editMessageText').at(-1).body;
  assert.equal(final.text, '<b>全部通过</b>');
  assert.equal(final.parse_mode, 'HTML');

  // 已回发，再结束一轮不会重复发
  const before = t.calls.length;
  await t.handlers.events.agent_end({ text: '别的' }, { sessionId: 's1', agent: null });
  assert.equal(t.calls.length, before);
});

test('富文本解析失败退回纯文本', async () => {
  const t = await setup();
  await t.pair();
  t.message('hi');
  await runPoll(t);
  await t.handlers.events.agent_end({ text: '**坏**' }, { sessionId: 's1', agent: null });
  const last = t.calls.at(-1).body;
  assert.equal(last.text, '**坏**');
  assert.equal(last.parse_mode, undefined);
});

test('子代理的轮次结束不回发；会话没运行时在占位里说明原因', async () => {
  const t = await setup({ injectError: 'INJECT_FAILED' });
  await t.pair();
  t.message('hi');
  await runPoll(t);
  assert.match(t.of('editMessageText').at(-1).body.text, /没在运行/);
  const before = t.calls.length;
  await t.handlers.events.agent_end({ text: 'x' }, { sessionId: 's1', agent: { name: 'Scout' } });
  await t.handlers.events.agent_end({ text: 'x' }, { sessionId: 's1', agent: null });
  assert.equal(t.calls.length, before);
});

test('/sync on 后，EnsoCode 里的输入和回复都同步过来；插件注入的消息不重复', async () => {
  const t = await setup();
  await t.pair();
  t.message('/sync on');
  await runPoll(t);
  await t.handlers.events.input({ text: '本地提问', source: 'interactive' }, { sessionId: 's1', agent: null });
  await t.handlers.events.input({ text: '注入', source: 'extension' }, { sessionId: 's1', agent: null });
  await t.handlers.events.agent_end({ text: '本地回答' }, { sessionId: 's1', agent: null });
  const texts = t.of('sendMessage').map((c) => c.body.text);
  assert.ok(texts.includes('💬 EnsoCode：本地提问'));
  assert.ok(texts.includes('本地回答'));
  assert.ok(!texts.some((x) => x.includes('注入')));
});

test('图片：先 getFile 再以 base64 下载，随文字注入会话', async () => {
  const t = await setup();
  await t.pair();
  t.message(undefined, { photo: [{ file_id: 'F1', file_size: 100 }], caption: '这是啥' });
  await runPoll(t);
  const download = t.calls.find((c) => c.method === 'download');
  assert.match(download.url, /\/file\/botT\/photos\/F1\.jpg$/);
  assert.equal(download.init.responseType, 'base64');
  assert.deepEqual(t.injected[0].images, [{ data: 'iVBORw0K', mimeType: 'image/jpeg' }]);
  assert.match(t.injected[0].text, /这是啥$/);
});

test('/stop 中止会话；失败时说明原因', async () => {
  const t = await setup();
  await t.pair();
  t.message('/stop');
  await runPoll(t);
  assert.deepEqual(t.injected.at(-1), { abort: 's1' });
  assert.match(t.of('sendMessage').at(-1).body.text, /已停止/);

  const f = await setup({ injectError: 'x' });
  await f.pair();
  f.message('/stop');
  await runPoll(f);
  assert.match(f.of('sendMessage').at(-1).body.text, /没有正在运行/);
});

test('侧栏：未配置时提示；生成配对码带 t.me 链接；列出绑定，可开关同步与解绑', async () => {
  const t = await setup();
  assert.equal((await t.handlers.renderer.state({}, { sessionId: null })).configured, true);
  await assert.rejects(t.handlers.renderer.pair({}, { sessionId: null }), /打开一个会话/);
  const paired = await t.handlers.renderer.pair({}, { sessionId: 's1::child' });
  assert.equal(paired.bot.username, 'enso_bot');
  assert.equal(paired.pairing.link, `https://t.me/enso_bot?start=${paired.pairing.code}`);
  t.message(`/start ${paired.pairing.code}`);
  await runPoll(t);
  let view = await t.handlers.renderer.state({}, { sessionId: 's1' });
  assert.equal(view.pairing, undefined);
  assert.equal(view.bindings.length, 1);
  view = await t.handlers.renderer.sync({ chatId: 42, on: true }, { sessionId: 's1' });
  assert.equal(view.bindings[0].sync, true);
  assert.equal((await t.handlers.renderer.state({}, { sessionId: 's2' })).others.length, 1);
  await t.handlers.renderer.unbind({ chatId: 42 }, { sessionId: 's2' });
  view = await t.handlers.renderer.unbind({ chatId: 42 }, { sessionId: 's1' });
  assert.equal(view.bindings.length, 0);
  assert.match(t.of('sendMessage').at(-1).body.text, /已在 EnsoCode 里解绑/);
  await t.handlers.renderer.open({ url: 'https://evil.com' });
  await t.handlers.renderer.open({ url: paired.pairing.link });
  assert.deepEqual(t.opened, [paired.pairing.link]);
});

test('侧栏：群聊深链；开关白名单、批准与移除成员', async () => {
  const t = await setup();
  const paired = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  assert.equal(paired.pairing.groupLink, `https://t.me/enso_bot?startgroup=${paired.pairing.code}`);
  const chat = { id: -5, type: 'group', title: 'G' };
  t.message(`/start@enso_bot ${paired.pairing.code}`, { chat });
  t.message('@enso_bot hi', { chat, from: { id: 8, first_name: 'Bob' } });
  await runPoll(t);
  let [b] = (await t.handlers.renderer.state({}, { sessionId: 's1' })).bindings;
  assert.deepEqual(b.requests, [{ id: 8, name: 'Bob' }]);
  [b] = (await t.handlers.renderer.allow({ chatId: -5, userId: 8, on: true }, { sessionId: 's1' })).bindings;
  assert.deepEqual(b.allow.map((u) => u.id), [7, 8]);
  [b] = (await t.handlers.renderer.allow({ chatId: -5, userId: 7, on: false }, { sessionId: 's1' })).bindings;
  assert.deepEqual(b.allow.map((u) => u.id), [8]);
  [b] = (await t.handlers.renderer.whitelist({ chatId: -5, on: false }, { sessionId: 's1' })).bindings;
  assert.equal(b.whitelist, false);
  [b] = (await t.handlers.renderer.context({ chatId: -5, count: 5 }, { sessionId: 's1' })).bindings;
  assert.equal(b.context, 5);
  [b] = (await t.handlers.renderer.context({ chatId: -5, count: 999 }, { sessionId: 's1' })).bindings;
  assert.equal(b.context, 5);
  assert.equal(t.injected.length, 0);
});

test('切换会话：/session 列出按钮，点按钮改绑并改写菜单；侧栏可把聊天拉到本会话', async () => {
  const sessions = [
    { id: 's1', title: '主线' },
    { id: 's2', title: '修 bug' },
    { id: 's3', title: '旧的', archived: true },
  ];
  const t = await setup({ sessions });
  await t.pair();
  t.message('/session');
  await runPoll(t);
  const menu = t.of('sendMessage').at(-1).body;
  assert.deepEqual(menu.reply_markup.inline_keyboard.map((r) => r[0].text), ['✅ 1. 主线', '2. 修 bug']);
  assert.equal(t.of('getUpdates').at(-1).body.allowed_updates.includes('callback_query'), true);

  const view0 = await t.handlers.renderer.state({}, { sessionId: 's1' });
  assert.equal(view0.bindings.length, 1);
  assert.deepEqual(view0.sessions.map((s) => s.id), ['s1', 's2']);
  t.callback({ id: 'q1', data: 'sess:2', from: { id: 7 }, message: { message_id: 100, chat: { id: 42, type: 'private' } } });
  await runPoll(t);
  assert.equal(t.of('answerCallbackQuery').at(-1).body.callback_query_id, 'q1');
  assert.match(t.of('editMessageText').at(-1).body.text, /已切换到会话「修 bug」/);
  let view = await t.handlers.renderer.state({}, { sessionId: 's1' });
  assert.equal(view.bindings.length, 0);
  assert.deepEqual(view.others, [{ chatId: 42, chatType: 'private', title: 'al', session: '修 bug' }]);

  view = await t.handlers.renderer.move({ chatId: 42, sessionId: 's1' }, { sessionId: 's1' });
  assert.equal(view.bindings.length, 1);
  assert.match(t.of('sendMessage').at(-1).body.text, /切换到会话「主线」/);

  t.message('/session 9');
  await runPoll(t);
  assert.match(t.of('sendMessage').at(-1).body.text, /序号不对/);
});

test('后台拿不到会话列表时沿用侧栏缓存；侧栏「新会话」新建并改绑', async () => {
  const t = await setup({ sessions: [{ id: 's1', title: '主线' }, { id: 's2', title: '修 bug' }] });
  await t.pair();
  await runPoll(t);
  // 模拟宿主：后台调用没有会话上下文，session.list 失败
  t.enso.session.list = async () => {
    throw Object.assign(new Error('x'), { code: 'NO_SESSION' });
  };
  const fresh = await setup({ dataDir: t.enso.dataDir });
  fresh.message('/session');
  await runPoll(fresh);
  const menu = fresh.of('sendMessage').at(-1).body;
  assert.deepEqual(menu.reply_markup.inline_keyboard.map((r) => r[0].text), ['✅ 1. 主线', '2. 修 bug']);

  const view = await t.handlers.renderer.fresh({ chatId: 42 }, { sessionId: 's1' });
  assert.equal(view.sessionId, 'new1');
  assert.equal(view.bindings[0].sessionId, 'new1');
  assert.match(t.of('sendMessage').at(-1).body.text, /新会话/);
  fresh.message('/new');
  await runPoll(fresh);
  assert.match(fresh.of('sendMessage').at(-1).body.text, /侧栏/);
});

test('会话没运行时消息排队，会话有动静或重试时补投并回发', async () => {
  const t = await setup();
  await t.pair();
  const realInject = t.enso.session.inject;
  t.enso.session.inject = async () => {
    throw Object.assign(new Error('会话不在运行'), { code: 'INJECT_FAILED' });
  };
  t.message('先排着');
  await runPoll(t);
  assert.match(t.of('editMessageText').at(-1).body.text, /已排队/);
  await t.flush();
  assert.equal(t.injected.length, 0);

  t.enso.session.inject = realInject;
  await t.handlers.events.input({ text: '本地第一句', source: 'interactive' }, { sessionId: 's1', agent: null });
  await t.flush();
  assert.equal(t.injected.length, 1);
  assert.match(t.injected[0].text, /先排着$/);
  assert.match(t.of('sendMessage').at(-1).body.text, /开始处理排队/);
  await t.flush();
  assert.equal(t.injected.length, 1);
  await t.handlers.events.agent_end({ text: '处理完了' }, { sessionId: 's1', agent: null });
  assert.equal(t.of('editMessageText').at(-1).body.text, '处理完了');
});

const assertSender = (sender, expected) => {
  assert.deepEqual(sender, expected);
  for (const key of ['owner', 'isOwner', 'role', 'trusted']) assert.equal(Object.hasOwn(sender, key), false);
};

test('正常消息、插话、图片、群聊和排队重试都把 sender 传给 inject', async () => {
  const t = await setup();
  await t.pair();
  const privateSender = { channel: 'telegram', chatId: '42', userId: '7', displayName: '@al' };

  t.message('普通');
  await runPoll(t);
  assertSender(t.injected.at(-1).sender, privateSender);

  t.message('/steer 插一句');
  await runPoll(t);
  assert.equal(t.injected.at(-1).deliverAs, 'steer');
  assertSender(t.injected.at(-1).sender, privateSender);

  t.message(undefined, { photo: [{ file_id: 'F2', file_size: 100 }], caption: '图' });
  await runPoll(t);
  assert.deepEqual(t.injected.at(-1).images, [{ data: 'iVBORw0K', mimeType: 'image/jpeg' }]);
  assertSender(t.injected.at(-1).sender, privateSender);

  const paired = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  const chat = { id: -100, type: 'supergroup', title: 'G' };
  t.message(`/start@enso_bot ${paired.pairing.code}`, { chat });
  t.message('@enso_bot 群里', { chat });
  await runPoll(t);
  assert.match(t.injected.at(-1).text, /群里$/);
  assertSender(t.injected.at(-1).sender, {
    channel: 'telegram',
    chatId: '-100',
    userId: '7',
    displayName: '@al',
  });

  const q = await setup();
  await q.pair();
  const realInject = q.enso.session.inject;
  q.enso.session.inject = async () => {
    throw Object.assign(new Error('会话不在运行'), { code: 'INJECT_FAILED' });
  };
  q.message('排队');
  await runPoll(q);
  assert.equal(q.injected.length, 0);
  q.enso.session.inject = realInject;
  await q.flush();
  assert.equal(q.injected.at(-1).deliverAs, 'followUp');
  assert.match(q.injected.at(-1).text, /排队$/);
  assertSender(q.injected.at(-1).sender, privateSender);
});
