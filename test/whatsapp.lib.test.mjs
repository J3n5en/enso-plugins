import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  backoffDelay,
  chunkText,
  classifyInbound,
  disconnectAction,
  markdownToWhatsApp,
  safeError,
  selfIds,
  silentLogger,
} from '../packages/enso.whatsapp/lib/wa.mjs';

const ME = selfIds({ id: '8613800000001:7@s.whatsapp.net', lid: '99001:7@lid' });
const OWNER = { jid: '8613900000002@s.whatsapp.net', pn: '8613900000002@s.whatsapp.net', lid: '77002@lid', name: '主人' };
const GROUP = '120363000000000001@g.us';

const text = (remoteJid, body, extra = {}) => ({
  key: { remoteJid, fromMe: false, id: extra.id ?? `IN${Math.random()}`, ...extra.key },
  message: extra.message ?? { conversation: body },
  pushName: extra.pushName,
  messageTimestamp: 1700000000,
});
const groupMsg = (participant, body, contextInfo, extra = {}) => ({
  key: { remoteJid: GROUP, fromMe: false, id: extra.id ?? `G${Math.random()}`, participant, ...extra.key },
  message: { extendedTextMessage: { text: body, contextInfo } },
  pushName: '路人',
});

function classify(msg, over = {}) {
  return classifyInbound({
    msg,
    type: 'notify',
    mode: 'secondary',
    me: ME,
    owner: OWNER,
    groups: {},
    sentIds: new Set(),
    bindActive: false,
    now: 1700000100000,
    ...over,
  });
}

describe('WhatsApp 纯逻辑', () => {
  test('markdown 转 WhatsApp 格式', () => {
    assert.equal(markdownToWhatsApp('**粗体** 和 *斜体* 和 __也粗__ 和 _斜_'), '*粗体* 和 _斜体_ 和 *也粗* 和 _斜_');
    assert.equal(markdownToWhatsApp('~~删掉~~'), '~删掉~');
    assert.equal(markdownToWhatsApp('## 标题 **一**'), '*标题 一*');
    assert.equal(markdownToWhatsApp('* 第一\n+ 第二\n- 第三'), '- 第一\n- 第二\n- 第三');
    assert.equal(markdownToWhatsApp('[文档](https://a.example/x) 和 [https://b.example](https://b.example)'), '文档 (https://a.example/x) 和 https://b.example');
    assert.equal(markdownToWhatsApp('用 `**不动**` 就好'), '用 `**不动**` 就好');
    assert.equal(markdownToWhatsApp('```js\nconst a = **b**;\n```\n**后面**'), '```\nconst a = **b**;\n```\n*后面*');
    assert.equal(markdownToWhatsApp('2 * 3 * 4'), '2 * 3 * 4');
    assert.equal(markdownToWhatsApp('---'), '──────────');
  });

  test('超长分条：优先换行处切，代码块跨条时补上结尾并重新打开', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `第 ${i} 行 ${'字'.repeat(20)}`).join('\n');
    const parts = chunkText(lines, 200);
    assert.ok(parts.length > 3);
    assert.ok(parts.every((p) => p.length <= 200));
    assert.equal(parts.join('\n'), lines);

    const code = `前言\n\`\`\`\n${'x\n'.repeat(150)}\`\`\`\n结尾`;
    const split = chunkText(code, 120);
    assert.ok(split.length > 2);
    for (const part of split) assert.equal((part.match(/```/g) ?? []).length % 2, 0, part);
    assert.ok(split[1].startsWith('```\n'));

    const emoji = '😀'.repeat(100);
    const cut = chunkText(emoji, 51);
    assert.equal(cut.join(''), emoji);
    assert.ok(cut.every((p) => !/[\ud800-\udbff]$/.test(p)));
    assert.deepEqual(chunkText('   '), []);
  });

  test('重连退避：指数增长、封顶、带抖动', () => {
    const mid = () => 0.5;
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, { random: mid })), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    assert.equal(backoffDelay(1, { random: () => 0 }), 1600);
    assert.equal(backoffDelay(1, { random: () => 1 }), 2400);
    assert.equal(backoffDelay(3, { start: 10, max: 25, random: mid }), 25);
  });

  test('断线原因：登出、被顶替、被封停止；515 立即重启；其余退避重连', () => {
    assert.equal(disconnectAction(401), 'logged-out');
    assert.equal(disconnectAction(411), 'logged-out');
    assert.equal(disconnectAction(403), 'forbidden');
    assert.equal(disconnectAction(440), 'replaced');
    assert.equal(disconnectAction(515, { loggingIn: true }), 'restart');
    assert.equal(disconnectAction(408), 'retry');
    assert.equal(disconnectAction(428), 'retry');
    assert.equal(disconnectAction(undefined), 'retry');
    assert.equal(disconnectAction(408, { loggingIn: true }), 'qr-expired');
    assert.equal(disconnectAction(500, { loggingIn: true }), 'qr-failed');
  });

  test('Baileys logger 不输出任何东西；报错文案去掉长串', () => {
    const logger = silentLogger();
    const seen = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a);
    try {
      logger.error({ creds: { noiseKey: 'SECRET' } }, 'x');
      logger.child({}).child({}).trace('SECRET');
      logger.info('SECRET');
    } finally {
      Object.assign(console, orig);
    }
    assert.deepEqual(seen, []);
    assert.equal(safeError(new Error(`bad ${'A'.repeat(40)}\nstack`)), 'bad …');
  });

  describe('入站过滤：副号模式', () => {
    test('主人的私聊交给秘书；LID 地址也认', () => {
      const res = classify(text(OWNER.pn, '在吗', { pushName: '主人' }));
      assert.equal(res.kind, 'deliver');
      assert.equal(res.peerId, OWNER.jid);
      assert.equal(res.chatType, 'private');
      assert.equal(res.text, '在吗');
      assert.equal(res.at, 1700000000000);
      assert.equal(classify(text('77002@lid', '换了地址')).kind, 'deliver');
      assert.equal(classify(text('55555@lid', 'x', { key: { remoteJidAlt: OWNER.pn } })).kind, 'deliver');
    });

    test('陌生人、群、广播、自己发的、秘书的回声、历史同步都忽略', () => {
      assert.deepEqual(classify(text('8613700000009@s.whatsapp.net', '你好')), { kind: 'ignore', reason: 'stranger' });
      assert.equal(classify(text(GROUP, '群', { key: { participant: OWNER.pn } })).reason, 'group-not-bound');
      assert.equal(classify(text('status@broadcast', '动态', { key: { participant: OWNER.pn } })).reason, 'broadcast');
      assert.equal(classify(text('123@newsletter', '频道')).reason, 'broadcast');
      assert.equal(classify(text(OWNER.pn, '手机上打的', { key: { fromMe: true } })).reason, 'from-me');
      assert.equal(classify(text(OWNER.pn, '回声', { id: 'MINE' }), { sentIds: new Set(['MINE']) }).reason, 'own-echo');
      assert.equal(classify(text(OWNER.pn, '离线时发的'), { type: 'append' }).kind, 'deliver');
      assert.equal(classify(text(OWNER.pn, '一天前的'), { now: 1700000000000 + 25 * 3600 * 1000 }).reason, 'too-old');
      assert.equal(classify(text(OWNER.pn, '未知类型'), { type: 'history' }).reason, 'not-notify');
      assert.equal(classify(text(OWNER.pn, '', { message: { reactionMessage: { text: '👍' } } })).reason, 'no-content');
    });

    test('没主人时只认私聊里的 6 位数字绑定码', () => {
      const base = { owner: null, bindActive: true };
      const res = classify(text('8613900000002@s.whatsapp.net', '123456', { pushName: '新主人', key: { remoteJidAlt: '77002@lid' } }), base);
      assert.deepEqual(res, {
        kind: 'bind',
        code: '123456',
        owner: { jid: '8613900000002@s.whatsapp.net', pn: '8613900000002@s.whatsapp.net', lid: '77002@lid', name: '新主人' },
      });
      assert.equal(classify(text(OWNER.pn, '你好'), base).reason, 'awaiting-bind');
      assert.equal(classify(text(OWNER.pn, '123456'), { ...base, bindActive: false }).reason, 'no-owner');
      assert.equal(classify(text(GROUP, '123456', { key: { participant: OWNER.pn } }), base).reason, 'group-not-bound');
      assert.equal(classify(text(OWNER.pn, '123456', { key: { fromMe: true } }), base).reason, 'from-me');
    });

    test('图片带说明交文字并标记媒体；纯图片交空文字由上层回提示', () => {
      const res = classify(text(OWNER.pn, '', { message: { imageMessage: { caption: '看图' } } }));
      assert.equal(res.text, '看图');
      assert.equal(res.media, 'image');
      const voice = classify(text(OWNER.pn, '', { message: { audioMessage: {} } }));
      assert.equal(voice.text, '');
      assert.equal(voice.media, 'audio');
      const wrapped = classify(text(OWNER.pn, '', { message: { ephemeralMessage: { message: { extendedTextMessage: { text: '阅后即焚' } } } } }));
      assert.equal(wrapped.text, '阅后即焚');
    });
  });

  describe('入站过滤：自己号码模式', () => {
    const self = { mode: 'self', owner: null };
    test('只认「给自己发消息」，用 PN 或 LID 地址都行', () => {
      const res = classify(text('8613800000001@s.whatsapp.net', '记一下', { key: { fromMe: true } }), self);
      assert.equal(res.kind, 'deliver');
      assert.equal(res.peerId, ME.pn);
      assert.equal(classify(text('99001@lid', '记一下', { key: { fromMe: true } }), self).kind, 'deliver');
    });
    test('别人发来的、自己发给别人的、秘书的回声都忽略', () => {
      assert.equal(classify(text(OWNER.pn, '朋友'), self).reason, 'not-self-chat');
      assert.equal(classify(text(OWNER.pn, '我发给朋友', { key: { fromMe: true } }), self).reason, 'not-self-chat');
      assert.equal(classify(text(ME.pn, '秘书回复', { id: 'R1', key: { fromMe: true } }), { ...self, sentIds: new Set(['R1']) }).reason, 'own-echo');
    });
  });

  describe('入站过滤：群聊', () => {
    const groups = { [GROUP]: { title: '项目群' } };
    const member = '8613600000003@s.whatsapp.net';
    test('已绑定的群里普通消息忽略，@ 这个号交给秘书并去掉 @', () => {
      assert.equal(classify(groupMsg(member, '大家好'), { groups }).reason, 'group-not-addressed');
      assert.equal(classify(groupMsg(member, '@8613700000000 你好', { mentionedJid: ['8613700000000@s.whatsapp.net'] }), { groups }).reason, 'group-not-addressed');
      const res = classify(groupMsg(member, '@8613800000001 帮我看看', { mentionedJid: ['8613800000001@s.whatsapp.net'] }), { groups });
      assert.equal(res.kind, 'deliver');
      assert.equal(res.peerId, GROUP);
      assert.equal(res.chatType, 'group');
      assert.equal(res.chatTitle, '项目群');
      assert.equal(res.senderId, member);
      assert.equal(res.name, '路人');
      assert.equal(res.text, '帮我看看');
      assert.equal(res.quote, true);
      const lid = classify(groupMsg('5551@lid', '@99001 在吗', { mentionedJid: ['99001@lid'] }), { groups });
      assert.equal(lid.text, '在吗');
    });

    test('回复秘书发过的消息交给秘书；回复别人的消息不算', () => {
      const sentIds = new Set(['BOT1']);
      assert.equal(classify(groupMsg(member, '收到', { stanzaId: 'BOT1' }), { groups, sentIds }).kind, 'deliver');
      assert.equal(classify(groupMsg(member, '收到', { stanzaId: 'OTHER' }), { groups, sentIds }).reason, 'group-not-addressed');
    });

    test('秘书自己在群里发的消息不当入站；副号手机上发的也忽略', () => {
      const sentIds = new Set(['BOT2']);
      const echo = groupMsg(ME.pn, '@8613800000001 秘书', { mentionedJid: [ME.pn] }, { id: 'BOT2', key: { fromMe: true } });
      assert.equal(classify(echo, { groups, sentIds }).reason, 'own-echo');
      assert.equal(classify(echo, { groups, sentIds, mode: 'self' }).reason, 'own-echo');
      const typed = groupMsg(ME.pn, '回复', { stanzaId: 'BOT2' }, { key: { fromMe: true } });
      assert.equal(classify(typed, { groups, sentIds }).reason, 'from-me');
      // 自己号码模式：本人在群里回复秘书算触发
      assert.equal(classify(typed, { groups, sentIds, mode: 'self' }).kind, 'deliver');
    });

    test('群成员发宿主命令和「确认 N」一律忽略，主人可以', () => {
      const at = { mentionedJid: [ME.pn] };
      assert.equal(classify(groupMsg(member, '@8613800000001 /last', at), { groups }).reason, 'group-control-from-member');
      assert.equal(classify(groupMsg(member, '@8613800000001 确认 1', at), { groups }).reason, 'group-control-from-member');
      assert.equal(classify(groupMsg(OWNER.pn, '@8613800000001 /last', at), { groups }).kind, 'deliver');
      assert.equal(classify(groupMsg('5559@lid', '@8613800000001 /last', at, { key: { participantAlt: OWNER.pn } }), { groups }).kind, 'deliver');
    });

    test('自己号码模式下群同样要先绑定、只认 @ 和回复', () => {
      const self = { mode: 'self', owner: null };
      const at = { mentionedJid: [ME.pn] };
      assert.equal(classify(groupMsg(member, '@8613800000001 hi', at), self).reason, 'group-not-bound');
      assert.equal(classify(groupMsg(member, '普通', null), { ...self, groups }).reason, 'group-not-addressed');
      assert.equal(classify(groupMsg(member, '@8613800000001 hi', at), { ...self, groups }).kind, 'deliver');
    });
  });
});
