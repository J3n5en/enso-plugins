import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindRoute,
  bufferDecision,
  chunkMarkdown,
  closeAsksFor,
  createPairing,
  encodeAskCallback,
  emptyState,
  findRoute,
  inboundText,
  isAllowed,
  markdownToHtml,
  mergeBuffered,
  migrate,
  mirrorTargets,
  openAsksForSession,
  registerAsk,
  rootSession,
  route,
  routeKeyOf,
  senderOf,
  shortIdOf,
  splitRouteKey,
  threadParams,
  topicOf,
  visuallyEmpty,
} from '../packages/enso.telegram/lib.mjs';

const BOT = { id: 99, username: 'enso_bot' };
const msg = (text, chatId = 42, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 5,
    chat: { id: chatId, type: 'private' },
    from: { id: 7, username: 'alice' },
    text,
    ...extra,
  },
});
const group = (text, extra = {}) =>
  msg(text, -100, { chat: { id: -100, type: 'supergroup', title: 'G' }, ...extra });
/** 论坛群话题消息 */
const topic = (text, threadId, extra = {}) =>
  msg(text, -200, {
    chat: { id: -200, type: 'supergroup', title: 'F', is_forum: true },
    message_thread_id: threadId,
    is_topic_message: true,
    ...extra,
  });
const bound = (patch = {}) => {
  const state = emptyState();
  bindRoute(state, { key: '42', chatId: 42, chatType: 'private', title: 'alice', sessionId: 's1', ...patch });
  return state;
};

test('routeKey 编解码与 General 出站规则', () => {
  assert.equal(routeKeyOf(-100, '5'), '-100:5');
  assert.equal(routeKeyOf(-100), '-100');
  assert.deepEqual(splitRouteKey('-100:5'), { chatId: '-100', topicId: '5' });
  assert.deepEqual(splitRouteKey('-100'), { chatId: '-100', topicId: undefined });
  // 话题 1（General）绝不带 message_thread_id，其余话题带
  assert.deepEqual(threadParams('-100:1'), {});
  assert.deepEqual(threadParams('-100:5'), { message_thread_id: 5 });
  assert.deepEqual(threadParams('-100'), {});
  assert.deepEqual(threadParams('42'), {});
});

test('topicOf：论坛群无 thread 或 thread=1 归 General；普通群无话题', () => {
  assert.equal(topicOf({ chat: { is_forum: true }, message_thread_id: undefined }), '1');
  assert.equal(topicOf({ chat: { is_forum: true }, message_thread_id: 1 }), '1');
  assert.equal(topicOf({ chat: { is_forum: true }, message_thread_id: 5 }), '5');
  assert.equal(topicOf({ chat: { type: 'supergroup' }, message_thread_id: 5 }), undefined);
  assert.equal(topicOf({ chat: { type: 'supergroup' }, message_thread_id: 5, is_topic_message: true }), '5');
  assert.equal(topicOf({ chat: { type: 'private' } }), undefined);
});

test('findRoute：话题级优先于整群兜底', () => {
  const state = emptyState();
  bindRoute(state, { key: '-100', chatId: -100, sessionId: 's1' });
  bindRoute(state, { key: '-100:5', chatId: -100, topicId: '5', sessionId: 's2' });
  assert.equal(findRoute(state, -100, '5')?.sessionId, 's2');
  assert.equal(findRoute(state, -100, '9')?.sessionId, 's1');
  assert.equal(findRoute(state, -100, undefined)?.sessionId, 's1');
  assert.equal(findRoute(state, -999, '5'), null);
});

test('0.4.0 迁移：bindings 变 routes，pending 目标 chatId 变 key，配置保留', () => {
  const legacy = {
    offset: 7,
    bindings: [
      { chatId: 42, chatType: 'private', title: 'al', sessionId: 's1', sync: true },
      { chatId: -100, chatType: 'group', title: 'G', sessionId: 's2', whitelist: true, allow: [{ id: 7, name: '@al' }], context: 5 },
    ],
    pending: { s1: [{ chatId: 42, placeholderId: 9 }] },
    pairings: [{ code: '111111', sessionId: 's1', expiresAt: 1 }],
    history: { '-100': [{ from: 'Bob', text: 'hi' }] },
  };
  const state = migrate(legacy);
  assert.equal(state.version, 2);
  assert.equal(state.bindings, undefined);
  const priv = state.routes['42'];
  assert.equal(priv.sessionId, 's1');
  assert.equal(priv.sync, true);
  assert.equal(priv.whitelistMode, 'inherit');
  const grp = state.routes['-100'];
  assert.equal(grp.whitelistMode, 'custom');
  assert.equal(grp.context, 5);
  assert.deepEqual(grp.allow, [{ id: 7, name: '@al' }]);
  assert.deepEqual(state.pending.s1, [{ chatId: 42, placeholderId: 9, key: '42' }]);
  assert.equal(state.offset, 7);
  assert.deepEqual(state.history['-100'], [{ from: 'Bob', text: 'hi' }]);
  // 幂等：再迁移一次不变
  const again = migrate(JSON.parse(JSON.stringify(state)));
  assert.equal(again.routes['-100'].context, 5);
});

test('两层白名单三种模式', () => {
  const state = emptyState();
  state.globalAllow = [{ id: 7, name: '@alice' }];
  const r = { whitelistMode: 'inherit', allow: [{ id: 8, name: 'Bob' }] };
  assert.equal(isAllowed(state, r, 7), true); // 全局
  assert.equal(isAllowed(state, r, 8), true); // 本路由
  assert.equal(isAllowed(state, r, 9), false);
  r.whitelistMode = 'custom';
  assert.equal(isAllowed(state, r, 7), false); // custom 不看全局
  assert.equal(isAllowed(state, r, 8), true);
  r.whitelistMode = 'open';
  assert.equal(isAllowed(state, r, 9), true); // open 放全群
});

test('未配对的聊天被忽略，错误配对码被拒', () => {
  const state = emptyState();
  assert.deepEqual(route(state, msg('rm -rf /'), 1000, BOT), { kind: 'ignore' });
  assert.equal(route(state, msg('/bind 123456'), 1000, BOT).kind, 'reply');
  assert.equal(Object.keys(state.routes).length, 0);
});

test('配对码一次有效、过期失效；私聊配对后消息投到绑定的会话', () => {
  const state = emptyState();
  const code = createPairing(state, 's1', 1000, () => 0.5);
  assert.match(code, /^\d{6}$/);
  assert.equal(route(state, msg(`/bind ${code}`), 1000 + 11 * 60_000, BOT).kind, 'reply');
  const fresh = createPairing(state, 's1', 2000, () => 0.5);
  const boundAction = route(state, msg(`/bind ${fresh}`), 2000, BOT);
  assert.equal(boundAction.kind, 'bound');
  assert.equal(boundAction.key, '42');
  assert.equal(state.pairings.length, 0);
  assert.equal(state.routes['42'].sessionId, 's1');
  const injected = route(state, msg('你好'), 3000, BOT);
  assert.equal(injected.kind, 'inject');
  assert.equal(injected.key, '42');
  assert.equal(injected.sessionId, 's1');
  assert.equal(injected.text, '你好');
  assert.equal(injected.fromId, '7');
});

test('话题内 /bind 绑当前话题；群聊主界面绑整群', () => {
  const state = emptyState();
  const c1 = createPairing(state, 's1', 0, () => 0.1);
  const inTopic = route(state, topic(`/bind ${c1}`, 5), 0, BOT);
  assert.equal(inTopic.kind, 'bound');
  assert.equal(inTopic.key, '-200:5');
  assert.equal(state.routes['-200:5'].topicId, '5');
  // 论坛群 General（thread=1）也按话题 1 绑定
  const c2 = createPairing(state, 's2', 0, () => 0.2);
  const inGeneral = route(state, topic(`/bind ${c2}`, 1), 0, BOT);
  assert.equal(inGeneral.key, '-200:1');
  // 普通群绑整群
  const c3 = createPairing(state, 's3', 0, () => 0.3);
  const inGroup = route(state, group(`/start@enso_bot ${c3}`), 0, BOT);
  assert.equal(inGroup.key, '-100');
  assert.equal(state.routes['-100'].topicId, undefined);
});

test('群聊只响应 @机器人 或回复机器人；开了免 @ 直发后直接发也触发', () => {
  const state = emptyState();
  bindRoute(state, { key: '-100', chatId: -100, chatType: 'supergroup', sessionId: 's1', user: { id: 7, name: '@alice' } });
  assert.deepEqual(route(state, group('大家好'), 0, BOT), { kind: 'ignore' });
  assert.equal(route(state, group('@enso_bot 看下日志'), 0, BOT).text, '看下日志');
  const reply = group('继续', { reply_to_message: { from: { id: 99 } } });
  assert.equal(route(state, reply, 0, BOT).text, '继续');
  // 打开直发
  state.routes['-100'].directTrigger = true;
  const direct = route(state, group('直接说事'), 0, BOT);
  assert.equal(direct.kind, 'inject');
  assert.equal(direct.text, '直接说事');
  // 话题路由的直发独立：整群开不影响未开的话题
  bindRoute(state, { key: '-100:5', chatId: -100, topicId: '5', sessionId: 's2', user: { id: 7, name: '@alice' } });
  state.routes['-100'].directTrigger = false;
  const t5msg = msg('话题里直接说', -100, { chat: { id: -100, type: 'supergroup', title: 'G', is_forum: true }, message_thread_id: 5, is_topic_message: true });
  assert.deepEqual(route(state, t5msg, 0, BOT), { kind: 'ignore' });
  state.routes['-100:5'].directTrigger = true;
  assert.equal(route(state, t5msg, 0, BOT).kind, 'inject');
});

test('群内命令：/status /steer /sync /unbind /stop；回发带路由 key', () => {
  const state = bound();
  assert.match(route(state, msg('/status'), 0, BOT).text, /s1/);
  assert.equal(route(state, msg('/status'), 0, BOT).key, '42');
  assert.equal(route(state, msg('/steer 改用 pnpm'), 0, BOT).deliverAs, 'steer');
  assert.equal(route(state, msg('/steer'), 0, BOT).kind, 'reply');
  route(state, msg('/sync on'), 0, BOT);
  assert.equal(state.routes['42'].sync, true);
  assert.deepEqual(route(state, msg('/stop'), 0, BOT), { kind: 'stop', key: '42', chatId: 42, topicId: undefined, sessionId: 's1' });
  route(state, msg('/unbind'), 0, BOT);
  assert.equal(state.routes['42'], undefined);
});

test('/allow /deny 管理本路由名单并进全局；非白名单成员触发被拦并记待批准', () => {
  const state = emptyState();
  bindRoute(state, { key: '-100', chatId: -100, chatType: 'supergroup', sessionId: 's1', user: { id: 7, name: '@alice' } });
  const b = state.routes['-100'];
  assert.equal(b.whitelistMode, 'custom'); // 群聊首次绑定自动 custom
  const bob = { id: 8, first_name: 'Bob' };
  assert.deepEqual(route(state, group('闲聊', { from: bob }), 0, BOT), { kind: 'ignore' });
  assert.match(route(state, group('@enso_bot rm -rf', { from: bob }), 0, BOT).text, /不在白名单/);
  assert.deepEqual(b.requests, [{ id: 8, name: 'Bob' }]);
  assert.match(route(state, group('/allow', { reply_to_message: { from: bob } }), 0, BOT).text, /加入白名单/);
  assert.deepEqual(b.requests, []);
  assert.ok(state.globalAllow.some((u) => u.id === 8));
  assert.equal(route(state, group('@enso_bot 你好', { from: bob }), 0, BOT).kind, 'inject');
  route(state, group('/deny', { reply_to_message: { from: bob } }), 0, BOT);
  // custom 模式只看本路由名单，deny 后立刻被拦（即使全局名单里还有）
  assert.equal(isAllowed(state, b, 8), false);
  // inherit 模式叠加全局名单：deny 只出本路由，全局仍在则放行
  b.whitelistMode = 'inherit';
  assert.equal(isAllowed(state, b, 8), true);
  state.globalAllow = [];
  b.whitelistMode = 'custom';
  assert.match(route(state, group('@enso_bot 你好', { from: bob }), 0, BOT).text, /不在白名单/);
  // open 模式全群放行
  b.whitelistMode = 'open';
  assert.equal(route(state, group('@enso_bot 你好', { from: bob }), 0, BOT).kind, 'inject');
});

test('图片：取 5MB 内最大尺寸；相册消息带 mediaGroupId', () => {
  const state = bound();
  const photo = [
    { file_id: 's', file_size: 1000 },
    { file_id: 'm', file_size: 90_000 },
    { file_id: 'xl', file_size: 6 * 1024 * 1024 },
  ];
  const routed = route(state, msg(undefined, 42, { photo, caption: '看这个' }), 0, BOT);
  assert.equal(routed.kind, 'inject');
  assert.deepEqual(routed.image, { fileId: 'm', mimeType: 'image/jpeg' });
  const albumPiece = msg(undefined, 42, { photo: [photo[0]], media_group_id: 'g1' });
  const routed2 = route(state, albumPiece, 0, BOT);
  assert.equal(routed2.mediaGroupId, 'g1');
  assert.equal(route(state, msg(undefined, 42, { photo: [photo[2]] }), 0, BOT).kind, 'reply');
});

test('群聊上下文按路由隔离：不同话题各自缓存', () => {
  const state = emptyState();
  bindRoute(state, { key: '-200:5', chatId: -200, topicId: '5', chatType: 'supergroup', sessionId: 's1', user: { id: 7, name: '@alice' } });
  bindRoute(state, { key: '-200:9', chatId: -200, topicId: '9', chatType: 'supergroup', sessionId: 's2', user: { id: 7, name: '@alice' } });
  state.routes['-200:5'].context = 3;
  state.routes['-200:9'].context = 3;
  const bob = { id: 8, first_name: 'Bob' };
  route(state, topic('五号线索', 5, { from: bob }), 0, BOT);
  route(state, topic('九号线索', 9, { from: bob }), 0, BOT);
  const a5 = route(state, topic('@enso_bot 总结', 5), 0, BOT);
  assert.deepEqual(a5.context, [{ from: 'Bob', text: '五号线索' }]);
  const a9 = route(state, topic('@enso_bot 总结', 9), 0, BOT);
  assert.deepEqual(a9.context, [{ from: 'Bob', text: '九号线索' }]);
});

test('注入文本：提示词前置在最顶部', () => {
  const t = inboundText({ from: 'alice', text: 'hi', promptPrefix: '你是客服' });
  assert.equal(t, '你是客服\n\n[Telegram 消息，来自 alice]\n\nhi');
  const plain = inboundText({ from: 'alice', text: 'hi' });
  assert.equal(plain, '[Telegram 消息，来自 alice]\n\nhi');
});

test('Markdown 转 HTML：转义、代码、粗斜体、链接、标题、引用、表格', () => {
  assert.equal(markdownToHtml('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(markdownToHtml('**粗** *斜* ~~删~~'), '<b>粗</b> <i>斜</i> <s>删</s>');
  assert.equal(markdownToHtml('用 `a<b>` 吧'), '用 <code>a&lt;b&gt;</code> 吧');
  assert.equal(markdownToHtml('```js\nif (a < 1) **x**\n```'), '<pre><code class="language-js">if (a &lt; 1) **x**</code></pre>');
  assert.equal(markdownToHtml('[文档](https://x.y/?a=1&b=2)'), '<a href="https://x.y/?a=1&amp;b=2">文档</a>');
  assert.equal(markdownToHtml('[坏](javascript:alert(1))'), '[坏](javascript:alert(1))');
  assert.equal(markdownToHtml('## 标题\n> 引用'), '<b>标题</b>\n<blockquote>引用</blockquote>');
  assert.equal(markdownToHtml('snake_case_name 2*3*4'), 'snake_case_name 2*3*4');
  assert.equal(markdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |'), '<pre>a ｜ b\n1 ｜ 2</pre>');
});

test('chunkMarkdown：跨片代码块闭合重开，每片围栏配平', () => {
  const src = '前文\n```js\n' + 'x\n'.repeat(300) + '```\n后文';
  const parts = chunkMarkdown(src, 200);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    const fences = (p.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `围栏不配平：${p.slice(0, 60)}`);
  }
  assert.ok(parts[1].startsWith('```js'));
  assert.deepEqual(chunkMarkdown('短文本', 100), ['短文本']);
});

test('视觉空消息识别', () => {
  assert.equal(visuallyEmpty('​‌‍⁠﻿ \n\t'), true);
  assert.equal(visuallyEmpty(' hi '), false);
  assert.equal(visuallyEmpty(''), true);
});

test('ask：shortId 稳定、callback ≤64 字节、注册/关闭/查询', () => {
  assert.equal(shortIdOf('req-ABC_123'), 'reqabc123');
  const data = encodeAskCallback('req-abc', 2);
  assert.equal(data, 'ask:reqabc:2');
  assert.ok(Buffer.byteLength(data) <= 64);
  const state = emptyState();
  const sid = registerAsk(state, { sessionId: 's1', requestId: 'r1', question: '继续吗', options: ['好', '不好'] });
  assert.equal(state.asks[sid].open, true);
  assert.equal(openAsksForSession(state, 's1').length, 1);
  assert.equal(openAsksForSession(state, 's2').length, 0);
  const closed = closeAsksFor(state, 's1', 'r1');
  assert.equal(closed.length, 1);
  assert.equal(state.asks[sid].open, false);
});

test('bufferDecision：debounce 安静期内等待，限速间隔内等待', () => {
  const now = 100_000;
  const r = { debounceSec: 5, minIntervalSec: 0, lastDeliveredAt: 0 };
  assert.deepEqual(bufferDecision(r, { lastAt: now - 1000 }, now), { deliver: false, waitMs: 4000 });
  assert.equal(bufferDecision(r, { lastAt: now - 6000 }, now).deliver, true);
  const r2 = { debounceSec: 0, minIntervalSec: 60, lastDeliveredAt: now - 30_000 };
  assert.equal(bufferDecision(r2, { lastAt: now - 1000 }, now).deliver, false);
  const r3 = { debounceSec: 0, minIntervalSec: 60, lastDeliveredAt: now - 61_000 };
  assert.equal(bufferDecision(r3, { lastAt: now }, now).deliver, true);
});

test('mergeBuffered：多条合并文本与图片，附 merged 计数', () => {
  const a1 = { kind: 'inject', key: '42', text: '一', messageId: 1, sessionId: 's1' };
  const a2 = { kind: 'inject', key: '42', text: '二', messageId: 2, sessionId: 's1', image: { fileId: 'f' } };
  const merged = mergeBuffered([a1, a2]);
  assert.equal(merged.text, '一\n\n二');
  assert.equal(merged.merged, 2);
  assert.deepEqual(merged.images, [{ fileId: 'f' }]);
  assert.equal(merged.image, undefined);
  assert.equal(mergeBuffered([a1]), a1);
});

test('senderOf 组出宿主 sender；同步镜像按路由排除', () => {
  assert.deepEqual(senderOf({ key: '42', fromId: '7', fromName: '@alice' }), {
    channel: 'telegram',
    chatId: '42',
    userId: '7',
    displayName: '@alice',
  });
  const state = emptyState();
  bindRoute(state, { key: '-100', chatId: -100, sessionId: 's1', sync: true });
  bindRoute(state, { key: '-100:5', chatId: -100, topicId: '5', sessionId: 's1', sync: true });
  assert.deepEqual(mirrorTargets(state, 's1', ['-100']), ['-100:5']);
  assert.equal(rootSession('main::child'), 'main');
});
