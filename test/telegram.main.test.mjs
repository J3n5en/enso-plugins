import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate, deactivate } from '../packages/enso.telegram/main.mjs';

/** 假宿主 + 假 Bot API：记录每次调用，按队列返回 getUpdates */
async function setup({ injectError, sessions, dataDir, configSet, answerAsk } = {}) {
  const calls = [];
  const updates = [];
  const injected = [];
  const configWrites = [];
  const askAnswers = [];
  let nextId = 100;
  const handlers = { events: {}, renderer: {}, tools: {} };
  const opened = [];
  let token = 'T';
  const enso = {
    dataDir: dataDir ?? (await mkdtemp(join(tmpdir(), 'tg-'))),
    config: {
      get: async () => ({ botToken: token }),
      ...(configSet !== false
        ? {
            set: async (patch) => {
              configWrites.push(patch);
              token = patch.botToken;
            },
          }
        : {}),
    },
    net: {
      fetch: async (url, init) => {
        if (url.includes('/file/bot')) {
          calls.push({ method: 'download', url, init });
          return { status: 200, body: 'iVBORw0K' };
        }
        const method = url.split('/').pop();
        let body = {};
        try {
          body = init?.bodyEncoding === 'base64' ? { __upload: true } : JSON.parse(init.body ?? '{}');
        } catch {
          body = {};
        }
        calls.push({ method, body });
        const ok = (result) => ({ status: 200, body: JSON.stringify({ ok: true, result }) });
        if (method === 'getMe') return ok({ id: 99, username: 'enso_bot', can_read_all_group_messages: true });
        if (method === 'getUpdates') return ok(updates.splice(0));
        if (method === 'getFile') return ok({ file_path: `photos/${body.file_id}.jpg` });
        if (body.parse_mode === 'HTML' && body.text?.includes('<b>坏'))
          return { status: 400, body: JSON.stringify({ ok: false, description: "can't parse entities" }) };
        if (method === 'sendMessage') {
          const id = nextId++;
          calls[calls.length - 1].resultMessageId = id;
          return ok({ message_id: id });
        }
        return ok(true);
      },
    },
    session: {
      list: async (opts) => {
        if (!sessions) throw Object.assign(new Error('x'), { code: 'NO_SESSION' });
        return { current: 's1', sessions, scope: opts?.scope };
      },
      create: async () => ({ sessionId: 'new1' }),
      abort: async (sessionId) => {
        if (injectError) throw Object.assign(new Error('x'), { code: 'ABORT_FAILED' });
        injected.push({ abort: sessionId });
      },
      inject: async (input) => {
        if (injectError) throw Object.assign(new Error('会话不在运行'), { code: injectError });
        injected.push(input);
      },
      ...(answerAsk !== false
        ? {
            answerAsk: async (input) => {
              askAnswers.push(input);
              return { ok: true };
            },
          }
        : {}),
    },
    ui: { notify: async () => {}, openExternal: async (url) => opened.push(url) },
    events: { on: (name, fn) => (handlers.events[name] = fn) },
    renderer: { handle: (id, fn) => (handlers.renderer[id] = fn) },
    tools: { register: (id, fn) => (handlers.tools[id] = fn) },
  };
  const handle0 = activate(enso, { loop: false });
  const message = (text, extra = {}) =>
    updates.push({
      update_id: updates.length + calls.length + 1,
      message: { message_id: nextId++, chat: { id: 42, type: 'private' }, from: { id: 7, username: 'al' }, text, ...extra },
    });
  const pair = async () => {
    const view = await handlers.renderer.pair({}, { sessionId: 's1' });
    message(`/start ${view.pairing.code}`);
  };
  const callback = (q) => updates.push({ update_id: updates.length + calls.length + 1, callback_query: q });
  return {
    enso,
    ...handle0,
    calls,
    injected,
    opened,
    handlers,
    message,
    callback,
    pair,
    configWrites,
    askAnswers,
    of: (m) => calls.filter((c) => c.method === m),
  };
}

test.afterEach(() => deactivate());

const runPoll = (t) => t.tick(0);

test('配对后发消息：先发占位，注入会话，进度原位更新，结束时把回复写进占位', async () => {
  const t = await setup();
  await t.pair();
  t.message('帮我看下测试');
  await runPoll(t);
  assert.equal(t.of('setMyCommands').length, 1);
  assert.equal(t.injected.length, 1);
  assert.equal(t.injected[0].sessionId, 's1');
  assert.match(t.injected[0].text, /帮我看下测试$/);
  const placeholder = t.of('sendMessage').find((c) => c.body.text?.startsWith('⏳'));
  assert.ok(placeholder);
  // typing 指示带 chat_id
  assert.ok(t.of('sendChatAction').length >= 1);

  await t.handlers.events.tool_call({ toolName: 'bash' }, { sessionId: 's1', agent: null });
  assert.match(t.of('editMessageText').at(-1).body.text, /第 1 步：bash/);

  await t.handlers.events.agent_end({ text: '**全部通过**' }, { sessionId: 's1', agent: null });
  const final = t.of('editMessageText').at(-1).body;
  assert.equal(final.text, '<b>全部通过</b>');
  assert.equal(final.parse_mode, 'HTML');

  const before = t.calls.length;
  await t.handlers.events.agent_end({ text: '别的' }, { sessionId: 's1', agent: null });
  assert.equal(t.calls.length, before);
});

test('silent 轮次：不回发不镜像，待回清掉', async () => {
  const t = await setup();
  await t.pair();
  t.message('hi');
  await runPoll(t);
  const before = t.of('sendMessage').length;
  await t.handlers.events.agent_end({ text: ' secret ', silent: true }, { sessionId: 's1', agent: null });
  // 只有占位消息的 edit（🤫），没有新的 sendMessage 正文
  assert.ok(!t.of('sendMessage').slice(before).some((c) => c.body.text?.includes('secret')));
  await t.handlers.events.agent_end({ text: '下一轮' }, { sessionId: 's1', agent: null });
  assert.ok(!t.calls.some((c) => c.body?.text?.includes?.('下一轮')), 'pending 已清，下一轮不回发');
});

test('话题路由：出站带 message_thread_id，General 不带', async () => {
  const t = await setup();
  // 在话题 5 里配对绑定
  const view = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  t.message(`/bind ${view.pairing.code}`, {
    chat: { id: -200, type: 'supergroup', title: 'F', is_forum: true },
    message_thread_id: 5,
    is_topic_message: true,
  });
  await runPoll(t);
  const boundMsg = t.of('sendMessage').at(-1).body;
  assert.equal(boundMsg.chat_id, -200);
  assert.equal(boundMsg.message_thread_id, 5);
});

test('General 话题（thread 1）出站不传 message_thread_id', async () => {
  const t = await setup();
  const view = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  t.message(`/bind ${view.pairing.code}`, {
    chat: { id: -200, type: 'supergroup', title: 'F', is_forum: true },
    message_thread_id: 1,
    is_topic_message: true,
  });
  await runPoll(t);
  const boundMsg = t.of('sendMessage').at(-1).body;
  assert.equal(boundMsg.chat_id, -200);
  assert.equal(boundMsg.message_thread_id, undefined);
  // 在 General 里发消息注入
  t.message('@enso_bot 你好', {
    chat: { id: -200, type: 'supergroup', title: 'F', is_forum: true },
    message_thread_id: 1,
    is_topic_message: true,
  });
  await runPoll(t);
  const placeholder = t.of('sendMessage').filter((c) => c.body.text?.startsWith('⏳')).at(-1);
  assert.equal(placeholder.body.message_thread_id, undefined);
});

test('入站相册：同 media_group_id 分片合并为一次注入，保留唯一 caption', async () => {
  const t = await setup();
  await t.pair();
  await runPoll(t);
  const photo = [{ file_id: 'F', file_size: 100 }];
  t.message(undefined, { photo: [{ file_id: 'A1', file_size: 100 }], caption: '这组图啥情况', media_group_id: 'mg1' });
  t.message(undefined, { photo: [{ file_id: 'A2', file_size: 100 }], media_group_id: 'mg1' });
  await runPoll(t);
  assert.equal(t.injected.length, 0, '防抖期内还没投');
  // 手动触发相册 flush（1.2s 防抖）
  await t.flushAlbum('42|mg1');
  assert.equal(t.injected.length, 1);
  assert.equal(t.injected[0].images.length, 2);
  assert.match(t.injected[0].text, /这组图啥情况/);
});

test('攒批：debounceSec 内多条合并为一条注入，steer 不受限立即投递', async () => {
  const t = await setup();
  await t.pair();
  await runPoll(t);
  await t.handlers.renderer.route({ key: '42', patch: { debounceSec: 60 } }, { sessionId: 's1' });
  t.message('第一句');
  t.message('第二句');
  await runPoll(t);
  assert.equal(t.injected.filter((x) => x.text).length, 0, '安静期内缓冲');
  // steer 立即投
  t.message('/steer 插一句');
  await runPoll(t);
  assert.equal(t.injected.at(-1).deliverAs, 'steer');
  assert.match(t.injected.at(-1).text, /插一句/);
  // 模拟安静期过后投递
  await t.flushTextBuffer('42');
  const merged = t.injected.find((x) => x.text?.includes('第一句'));
  assert.ok(merged);
  assert.match(merged.text, /第二句/);
});

test('提示词前置拼在注入文本顶部', async () => {
  const t = await setup();
  await t.pair();
  await runPoll(t);
  await t.handlers.renderer.route({ key: '42', patch: { promptPrefix: '你是本群客服' } }, { sessionId: 's1' });
  t.message('hi');
  await runPoll(t);
  assert.ok(t.injected.at(-1).text.startsWith('你是本群客服\n\n[Telegram 消息'));
});

test('上下文 X 条：群聊未触发消息随触发附上', async () => {
  const t = await setup();
  const view = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  const chat = { id: -100, type: 'supergroup', title: 'G' };
  t.message(`/start@enso_bot ${view.pairing.code}`, { chat });
  await runPoll(t);
  await t.handlers.renderer.route({ key: '-100', patch: { context: 3 } }, { sessionId: 's1' });
  const bob = { id: 8, first_name: 'Bob' };
  await t.handlers.renderer.route({ key: '-100', patch: { whitelistMode: 'open' } }, { sessionId: 's1' });
  t.message('背景一', { chat, from: bob });
  t.message('@enso_bot 总结下', { chat });
  await runPoll(t);
  const injectedText = t.injected.at(-1).text;
  assert.match(injectedText, /此前的其他消息/);
  assert.match(injectedText, /Bob：背景一/);
});

test('ask_user：提问卡片带按钮，点击按钮回填答案并原位清按钮', async () => {
  const t = await setup({ sessions: [{ id: 's1', title: '主线' }] });
  await t.pair();
  await runPoll(t);
  await t.handlers.events.ask_request({
    sessionId: 's1',
    requestId: 'req-1',
    question: '要继续吗？',
    options: ['继续', '停下'],
    recommended: '继续',
  });
  const card = t.of('sendMessage').at(-1).body;
  assert.match(card.text, /要继续吗/);
  const buttons = card.reply_markup.inline_keyboard;
  assert.equal(buttons.length, 2);
  assert.match(buttons[0][0].text, /★ 继续/);
  assert.ok(Buffer.byteLength(buttons[0][0].callback_data) <= 64);
  assert.match(buttons[0][0].callback_data, /^ask:/);
  // 点击第一个选项
  t.callback({
    id: 'q1',
    data: buttons[0][0].callback_data,
    from: { id: 7, username: 'al' },
    message: { message_id: card.message_id ?? 100, chat: { id: 42, type: 'private' } },
  });
  await runPoll(t);
  assert.equal(t.askAnswers.length, 1);
  assert.deepEqual(t.askAnswers[0], { sessionId: 's1', requestId: 'req-1', answer: '继续' });
  const acked = t.of('answerCallbackQuery').at(-1).body;
  assert.match(acked.text ?? '', /✓/);
  const edited = t.of('editMessageText').at(-1).body;
  assert.match(edited.text, /选择了：继续/);
  assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
});

test('ask_user：自由文本回复卡片消息作答；ask_resolved 清掉按钮', async () => {
  const t = await setup();
  await t.pair();
  await runPoll(t);
  await t.handlers.events.ask_request({ sessionId: 's1', requestId: 'req-2', question: '随便说点啥？' });
  const cardMsg = t.of('sendMessage').at(-1);
  // 回复卡片消息
  t.message('我的自定义答案', { reply_to_message: { message_id: cardMsg.resultMessageId, from: { id: 99 } } });
  await runPoll(t);
  assert.equal(t.askAnswers.length, 1);
  assert.equal(t.askAnswers[0].answer, '我的自定义答案');
  assert.equal(t.injected.filter((x) => x.text?.includes('自定义答案')).length, 0, '答案不应当作普通消息注入');

  // 另一轮提问被桌面端解决：ask_resolved 清按钮
  await t.handlers.events.ask_request({ sessionId: 's1', requestId: 'req-3', question: '桌面答', options: ['A'] });
  await t.handlers.events.ask_resolved({ sessionId: 's1', requestId: 'req-3', by: 'desktop', answer: 'A' });
  const edit = t.of('editMessageText').at(-1).body;
  assert.match(edit.text, /已在别处作答/);
});

test('ask_user：失效提问再点按钮提示已失效；无 answerAsk 的旧宿主提示升级', async () => {
  const t = await setup();
  await t.pair();
  await runPoll(t);
  await t.handlers.events.ask_request({ sessionId: 's1', requestId: 'req-x', question: 'q', options: ['A', 'B'] });
  const card = t.of('sendMessage').at(-1).body;
  await t.handlers.events.ask_resolved({ sessionId: 's1', requestId: 'req-x', by: 'desktop', answer: 'A' });
  t.callback({
    id: 'q9',
    data: card.reply_markup.inline_keyboard[0][0].callback_data,
    from: { id: 7 },
    message: { message_id: 100, chat: { id: 42, type: 'private' } },
  });
  await runPoll(t);
  assert.match(t.of('answerCallbackQuery').at(-1).body.text, /已失效/);
  assert.equal(t.askAnswers.length, 0);

  const legacy = await setup({ answerAsk: false });
  await legacy.pair();
  await runPoll(legacy);
  await legacy.handlers.events.ask_request({ sessionId: 's1', requestId: 'req-y', question: 'q', options: ['A'] });
  legacy.callback({
    id: 'q10',
    data: legacy.of('sendMessage').at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,
    from: { id: 7 },
    message: { message_id: 100, chat: { id: 42, type: 'private' } },
  });
  await runPoll(legacy);
  assert.match(legacy.of('answerCallbackQuery').at(-1).body.text, /升级/);
});

test('connect：校验 token 调 getMe 后 config.set 持久化；disconnect 清空；旧宿主提示升级', async () => {
  const t = await setup();
  const res = await t.handlers.renderer.connect({ token: '123456:ABCDEFGHIJKLMNOPQRSTUVWX' });
  assert.equal(res.ok, true);
  assert.equal(res.bot.username, 'enso_bot');
  assert.deepEqual(t.configWrites, [{ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX' }]);
  await assert.rejects(t.handlers.renderer.connect({ token: 'bad' }), /格式/);
  const d = await t.handlers.renderer.disconnect({}, { sessionId: 's1' });
  assert.deepEqual(t.configWrites.at(-1), { botToken: null });
  assert.equal(d.configured, false);

  // 旧宿主：没有 config.set，提示去设置里填
  const legacy = await setup({ configSet: false });
  const res2 = await legacy.handlers.renderer.connect({ token: '123456:ABCDEFGHIJKLMNOPQRSTUVWX' });
  assert.equal(res2.needsUpgrade, true);
  assert.match(res2.message, /设置 → 插件/);
});

test('侧栏 state：未配置与已配置；knownChats 出现在名册里', async () => {
  const t = await setup();
  const before = await t.handlers.renderer.state({}, { sessionId: null });
  assert.equal(before.configured, true); // mock 有 token
  assert.equal(before.bot.username, 'enso_bot');
  assert.ok(before.tokenHint.includes('…') || before.tokenHint === '•••');
  // 论坛群话题消息把群与话题记进名册
  t.message('hi', {
    chat: { id: -200, type: 'supergroup', title: '论坛群', is_forum: true },
    message_thread_id: 5,
    is_topic_message: true,
    forum_topic_created: { name: '发布讨论' },
  });
  await runPoll(t);
  const v = await t.handlers.renderer.state({}, { sessionId: 's1' });
  const chat = v.knownChats.find((c) => c.id === '-200' || c.id === -200);
  assert.ok(chat);
  assert.equal(chat.title, '论坛群');
  assert.deepEqual(chat.topics, [{ id: '5', name: '发布讨论' }]);
});

test('侧栏 bind：从名册一键绑定话题， Telegram 侧收到提示', async () => {
  const t = await setup();
  t.message('hi', {
    chat: { id: -200, type: 'supergroup', title: '论坛群', is_forum: true },
    message_thread_id: 5,
    is_topic_message: true,
  });
  await runPoll(t);
  const v = await t.handlers.renderer.bind({ chatId: '-200', topicId: '5' }, { sessionId: 's1' });
  const r = v.routes.find((x) => x.key === '-200:5');
  assert.ok(r);
  assert.equal(r.sessionId, 's1');
  assert.equal(r.chatType, 'supergroup');
  const notice = t.of('sendMessage').at(-1).body;
  assert.equal(notice.chat_id, -200);
  assert.equal(notice.message_thread_id, 5);
});

test('白名单面板：globalAllow 增删、approve 批准进路由与全局', async () => {
  const t = await setup();
  const v1 = await t.handlers.renderer.globalAllow({ userId: 42, name: '@someone', on: true }, { sessionId: 's1' });
  assert.deepEqual(v1.globalAllow, [{ id: 42, name: '@someone' }]);
  const v2 = await t.handlers.renderer.globalAllow({ userId: 42, on: false }, { sessionId: 's1' });
  assert.deepEqual(v2.globalAllow, []);
  // 群里有人被拦产生请求，approve 批准
  const view = await t.handlers.renderer.pair({}, { sessionId: 's1' });
  const chat = { id: -100, type: 'supergroup', title: 'G' };
  t.message(`/start@enso_bot ${view.pairing.code}`, { chat });
  t.message('@enso_bot hi', { chat, from: { id: 8, first_name: 'Bob' } });
  await runPoll(t);
  const v3 = await t.handlers.renderer.approve({ key: '-100', userId: 8, on: true }, { sessionId: 's1' });
  const r = v3.routes.find((x) => x.key === '-100');
  assert.deepEqual(r.requests, []);
  assert.ok(r.allow.some((u) => u.id === 8));
  assert.ok(v3.globalAllow.some((u) => u.id === 8));
});

test('/session 按钮切会话（含秘书会话分组）；session.list 用新宿主 scope all', async () => {
  const sessions = [
    { id: 's1', title: '主线', projectName: 'enso-plugins' },
    { id: 's2', title: '秘书', kind: 'secretary' },
  ];
  let listOpts = null;
  const t = await setup({ sessions });
  t.enso.session.list = async (opts) => {
    listOpts = opts;
    return { current: 's1', sessions };
  };
  await t.pair();
  await runPoll(t);
  t.message('/session');
  await runPoll(t);
  assert.deepEqual(listOpts, { scope: 'all', includeSecretary: true });
  const menu = t.of('sendMessage').at(-1).body;
  assert.match(menu.reply_markup.inline_keyboard[1][0].text, /🤖 秘书/);
  t.callback({ id: 'q1', data: 'sess:2', from: { id: 7 }, message: { message_id: 100, chat: { id: 42, type: 'private' } } });
  await runPoll(t);
  assert.match(t.of('editMessageText').at(-1).body.text, /秘书/);
  const v = await t.handlers.renderer.state({}, { sessionId: 's1' });
  assert.equal(v.routes.find((r) => r.key === '42')?.sessionId, 's2');
});

test('session.list 旧宿主回退：scope all 抛错后用无参 list', async () => {
  const t = await setup({ sessions: [{ id: 's1', title: '主线' }] });
  let n = 0;
  t.enso.session.list = async (opts) => {
    n += 1;
    if (opts?.scope) throw Object.assign(new Error('unknown args'), { code: 'INVALID_ARGS' });
    return { current: 's1', sessions: [{ id: 's1', title: '主线' }] };
  };
  await t.pair();
  await runPoll(t);
  t.message('/session');
  await runPoll(t);
  const menu = t.of('sendMessage').at(-1).body;
  assert.ok(menu.reply_markup.inline_keyboard.length >= 1);
});

test('排队与补投：会话没运行时排队，恢复后补投', async () => {
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
  await t.flush();
  assert.equal(t.injected.length, 1);
  assert.match(t.injected[0].text, /先排着$/);
});

test('富文本解析失败退回纯文本；视觉空消息不发送', async () => {
  const t = await setup();
  await t.pair();
  t.message('hi');
  await runPoll(t);
  await t.handlers.events.agent_end({ text: '**坏**' }, { sessionId: 's1', agent: null });
  const last = t.calls.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').at(-1).body;
  assert.equal(last.text, '**坏**');
  assert.equal(last.parse_mode, undefined);
  const before = t.calls.length;
  await t.handlers.events.input({ text: '​‌‍', source: 'interactive' }, { sessionId: 's1', agent: null });
  await t.handlers.events.agent_end({ text: '​‌‍⁠' }, { sessionId: 's1', agent: null });
  assert.equal(t.calls.length, before, '纯零宽消息不发');
});

test('telegram_reply 发到绑定路由并可指定 target；telegram_send_media 走 multipart', async () => {
  const { writeFile } = await import('node:fs/promises');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(20).fill(0)]);
  const p1 = join(tmpdir(), `tg-test-${process.pid}-1.png`);
  const p2 = join(tmpdir(), `tg-test-${process.pid}-2.png`);
  await writeFile(p1, png);
  await writeFile(p2, png);
  const t = await setup();
  await t.pair();
  await runPoll(t);
  const r = await t.handlers.tools.telegram_reply({ text: '进度更新' }, { sessionId: 's1' });
  assert.match(r, /1 个/);
  assert.match(t.of('sendMessage').at(-1).body.text, /进度更新/);
  const m = await t.handlers.tools.telegram_send_media({ files: [p1, p2], caption: '看图' }, { sessionId: 's1' });
  assert.match(m, /2 张图片到 1 个/);
  assert.ok(t.calls.some((c) => c.method === 'sendMediaGroup'), '两张走 sendMediaGroup');
  await assert.rejects(t.handlers.tools.telegram_send_media({ files: ['/etc/passwd'] }, { sessionId: 's1' }), /不在允许的目录|不是支持的图片/);
  const single = await t.handlers.tools.telegram_send_media({ files: [p1] }, { sessionId: 's1' });
  assert.ok(t.calls.some((c) => c.method === 'sendPhoto'), '单张走 sendPhoto');
  const sep = await t.handlers.tools.telegram_send_media({ files: [p1, p2], asAlbum: false }, { sessionId: 's1' });
  assert.equal(t.of('sendPhoto').length >= 2, true);
});

test('迁移：0.4.0 旧 state.json 自动升级，绑定不丢', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'tg-legacy-'));
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    offset: 5,
    bindings: [{ chatId: 42, chatType: 'private', title: 'al', sessionId: 's1', sync: false }],
    pairings: [],
    pending: {},
    history: {},
    menus: {},
  }));
  const t = await setup({ dataDir: dir });
  t.message('迁移后发消息');
  await runPoll(t);
  assert.equal(t.injected.length, 1);
  assert.equal(t.injected[0].sessionId, 's1');
  const v = await t.handlers.renderer.state({}, { sessionId: 's1' });
  assert.ok(v.routes.some((r) => r.key === '42' && r.sessionId === 's1'));
});

test('/sync on 后 EnsoCode 输入与回复镜像过来；/stop 停止会话', async () => {
  const t = await setup();
  await t.pair();
  t.message('/sync on');
  await runPoll(t);
  await t.handlers.events.input({ text: '本地提问', source: 'interactive' }, { sessionId: 's1', agent: null });
  await t.handlers.events.agent_end({ text: '本地回答' }, { sessionId: 's1', agent: null });
  const texts = t.of('sendMessage').map((c) => c.body.text);
  assert.ok(texts.includes('💬 EnsoCode：本地提问'));
  assert.ok(texts.includes('本地回答'));

  t.message('/stop');
  await runPoll(t);
  assert.deepEqual(t.injected.at(-1), { abort: 's1' });
});
