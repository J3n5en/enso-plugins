import assert from 'node:assert/strict';
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import vm from 'node:vm';
import { activate, deactivate, loadProtocol } from '../packages/enso.whatsapp/main.mjs';

const SECRET = 'SECRET-NOISE-KEY-0123456789abcdef';
const ME = { id: '8613800000001:7@s.whatsapp.net', lid: '99001:7@lid', name: '副号' };
const ME_PN = '8613800000001@s.whatsapp.net';
const OWNER = '8613900000002@s.whatsapp.net';
const STRANGER = '8613700000009@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000002@g.us';
const MEMBER = '8613600000003@s.whatsapp.net';

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, what, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(5);
  }
  throw new Error(`等不到：${what}`);
}

class Ev {
  constructor() {
    this.map = new Map();
  }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, []);
    this.map.get(name).push(fn);
  }
  emit(name, data) {
    for (const fn of this.map.get(name) ?? []) fn(data);
  }
  removeAllListeners() {
    this.map.clear();
  }
}

/** 假协议层：auth 落在 dataDir/auth/creds.json，socket 只记录调用，不碰网络 */
function fakeProtocol({ groups = {} } = {}) {
  const sockets = [];
  let seq = 0;
  const proto = {
    sockets,
    browser: ['Mac OS', 'EnsoCode', 'test'],
    useAuth: async (dir) => {
      let creds;
      try {
        creds = JSON.parse(await readFile(join(dir, 'creds.json'), 'utf8'));
      } catch {
        creds = { noiseKey: SECRET };
      }
      return {
        creds,
        keys: {},
        saveCreds: async () => {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'creds.json'), JSON.stringify(creds));
        },
      };
    },
    newMessageId: () => `BOT${++seq}`,
    mediaPath: (type) => ({ image: '/mms/image', document: '/mms/document' })[type],
    uploadToken: (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    makeSocket: (config) => {
      // 协议层自己的日志（可能带密钥）必须被吞掉
      config.logger.error({ creds: config.auth.creds }, 'debug dump');
      config.logger.child({}).info({ creds: config.auth.creds });
      const sock = {
        config,
        ev: new Ev(),
        user: null,
        sent: [],
        presence: [],
        read: [],
        ended: 0,
        loggedOut: 0,
        sendMessage: async (jid, content, opts = {}) => {
          if ((content.image || content.document) && opts.upload) {
            const file = join(tmpdir(), `wa-up-${Date.now()}-${Math.random()}`);
            await writeFile(file, content.image ?? content.document);
            sock.uploaded = await opts.upload(file, { mediaType: content.image ? 'image' : 'document', fileEncSha256B64: 'ab+/cd==' });
          }
          sock.sent.push({ jid, content, opts });
          return { key: { remoteJid: jid, fromMe: true, id: opts.messageId }, message: { conversation: content.text ?? '' } };
        },
        sendPresenceUpdate: async (type, jid) => sock.presence.push({ type, jid }),
        readMessages: async (keys) => sock.read.push(...keys),
        groupFetchAllParticipating: async () => groups,
        refreshMediaConn: async () => ({ auth: 'MEDIA-AUTH', hosts: [{ hostname: 'evil.example' }, { hostname: 'mmg.whatsapp.net' }] }),
        logout: async () => {
          sock.loggedOut += 1;
        },
        end: () => {
          sock.ended += 1;
        },
        // 测试驱动
        qr: (text) => sock.ev.emit('connection.update', { qr: text }),
        pair: () => {
          config.auth.creds.me = { id: ME.id, lid: ME.lid, name: ME.name };
          sock.ev.emit('creds.update', { me: config.auth.creds.me });
        },
        open: (user = ME) => {
          sock.user = user;
          sock.ev.emit('connection.update', { connection: 'open' });
        },
        close: (statusCode) =>
          sock.ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error: Object.assign(new Error(`closed ${statusCode}`), { output: { statusCode } }) },
          }),
        receive: (messages, type = 'notify') => sock.ev.emit('messages.upsert', { messages, type }),
      };
      sockets.push(sock);
      return sock;
    },
  };
  return proto;
}

const dm = (from, text, extra = {}) => ({
  key: { remoteJid: from, fromMe: false, id: extra.id ?? `IN-${Math.random()}`, ...extra.key },
  message: { conversation: text },
  pushName: extra.pushName ?? '某人',
  messageTimestamp: 1700000000,
});
const inGroup = (participant, text, contextInfo, extra = {}) => ({
  key: { remoteJid: extra.group ?? GROUP, fromMe: false, id: extra.id ?? `G-${Math.random()}`, participant, ...extra.key },
  message: { extendedTextMessage: { text, contextInfo } },
  pushName: '群友',
  messageTimestamp: 1700000001,
});

/** 插件有模块级单例，测试串行跑 */
let gate = Promise.resolve();
async function withPlugin(opts, fn) {
  const prev = gate;
  let release;
  gate = new Promise((resolve) => (release = resolve));
  await prev;
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...args) => logs.push(args.map(String).join(' '));
  try {
    const dir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'wa-')));
    if (opts.state) await writeFile(join(dir, 'state.json'), JSON.stringify(opts.state));
    if (opts.creds) {
      await mkdir(join(dir, 'auth'), { recursive: true });
      await writeFile(join(dir, 'auth', 'creds.json'), JSON.stringify(opts.creds));
    }
    const proto = opts.protocol ?? fakeProtocol(opts);
    const statuses = [];
    const inbounds = [];
    const events = [];
    const fetches = [];
    const handlers = {};
    const bag = { unregistered: 0 };
    const enso = {
      dataDir: dir,
      net: {
        fetch: async (url, init) => {
          fetches.push({ url, init });
          if (init?.responseType === 'base64' && opts.media) return opts.media(url, init);
          return { status: 200, headers: {}, body: JSON.stringify({ url: 'https://mmg.whatsapp.net/d/x', direct_path: '/d/x' }) };
        },
      },
      renderer: { handle: (name, fn) => (handlers[name] = fn) },
      ui: { view: { emit: (name, data) => events.push({ name, data }) } },
      contact: {
        register: async (id, channel) => {
          handlers.channel = { id, ...channel };
          return () => {
            bag.unregistered += 1;
          };
        },
        inbound: async (id, msg) => inbounds.push({ id, msg }),
        setStatus: async (id, st) => statuses.push({ id, ...st }),
      },
    };
    const hooks = await activate(enso, {
      protocol: proto,
      connectTimeoutMs: 300,
      loginWaitMs: 200,
      qrStaleMs: 1000,
      typingIdleMs: 40,
      chunkGapMs: 0,
      backoff: { start: 30, max: 120 },
      random: () => 0.5,
      now: () => 1700000100000,
      ...opts.options,
    });
    const sock = () => proto.sockets.at(-1);
    const ctx = { dir, proto, sock, statuses, inbounds, events, fetches, handlers, bag, hooks, logs };
    try {
      await fn(ctx);
    } finally {
      deactivate();
    }
    return ctx;
  } finally {
    Object.assign(console, orig);
    release();
  }
}

/** 已登录的副号（或自己号码），连接打开 */
async function online(ctx) {
  await until(() => ctx.proto.sockets.length > 0, 'socket');
  ctx.sock().open();
  await until(() => ctx.handlers.state().connected, 'open');
}

/** 和 WhatsApp 一样加密：HKDF 展开 mediaKey，AES-256-CBC 加 10 字节 HMAC */
function encryptMedia(plain, keyType = 'image') {
  const mediaKey = randomBytes(32);
  const info = keyType === 'image' ? 'WhatsApp Image Keys' : 'WhatsApp Document Keys';
  const keys = Buffer.from(hkdfSync('sha256', mediaKey, Buffer.alloc(0), info, 112));
  const iv = keys.subarray(0, 16);
  const cipher = createCipheriv('aes-256-cbc', keys.subarray(16, 48), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', keys.subarray(48, 80)).update(iv).update(body).digest().subarray(0, 10);
  return { mediaKey, enc: Buffer.concat([body, mac]) };
}

/** 假媒体服务器：directPath → 密文；hang 永不返回，404 返回错误码 */
function mediaServer() {
  const files = new Map();
  let n = 0;
  return {
    files,
    add(plain, { keyType = 'image', path } = {}) {
      const { mediaKey, enc } = encryptMedia(plain, keyType);
      const directPath = path ?? `/v/t62/${keyType}-${++n}`;
      files.set(directPath, enc);
      return { mediaKey, directPath, url: `https://mmg.whatsapp.net${directPath}?enc=1`, fileLength: plain.length };
    },
    handle: async (url) => {
      const path = new URL(url).pathname;
      if (path.startsWith('/hang')) return new Promise(() => {});
      const enc = files.get(path);
      if (!enc) return { status: 404, headers: {}, body: '' };
      return { status: 200, headers: {}, body: enc.toString('base64') };
    },
  };
}

const loggedIn = { creds: { noiseKey: SECRET, me: { id: ME.id, lid: ME.lid } } };
const texts = (sock) => sock.sent.filter((s) => typeof s.content.text === 'string').map((s) => s.content.text);

describe('WhatsApp 联系方式', { concurrency: false }, () => {
  test('清单与设置页：方法都有实现，提示语齐全，二维码本地生成', async () => {
    const pkg = new URL('../packages/enso.whatsapp/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('enso-plugin.json', pkg), 'utf8'));
    assert.equal(manifest.id, 'enso.whatsapp');
    assert.equal(manifest.version, '0.1.0');
    assert.deepEqual(manifest.contributes.contactChannels.map((c) => c.id), ['whatsapp']);
    assert.deepEqual(manifest.net.domains, ['web.whatsapp.com', 'mmg.whatsapp.net', '*.cdn.whatsapp.net']);
    const meta = JSON.parse(await readFile(new URL('../registry/meta/enso.whatsapp.json', import.meta.url), 'utf8'));
    assert.ok(meta.tags.includes('contact') && meta.tags.includes('whatsapp'));
    await withPlugin({}, async ({ handlers }) => {
      for (const m of manifest.contributes.methods) assert.equal(typeof handlers[m.name], 'function', m.name);
    });
    const html = await readFile(new URL('view.html', pkg), 'utf8');
    for (const phrase of ['非官方协议', '建议用副号', '手机不会收到通知', '被封号的风险', '群消息会交给秘书', '任何成员', '绑定码']) {
      assert.ok(html.includes(phrase), phrase);
    }
    const sandbox = {};
    vm.runInNewContext(await readFile(new URL('lib/qrcode.js', pkg), 'utf8'), sandbox);
    const code = sandbox.qrcode(0, 'M');
    code.addData('2@abc,def,ghi,jkl');
    code.make();
    assert.match(code.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), /^<svg/);
  });

  test('注册的渠道 caps 与 clawbot 一致的无按钮渠道；未登录时 unconfigured 且不连接', async () => {
    await withPlugin({}, async ({ handlers, statuses, proto }) => {
      assert.equal(handlers.channel.id, 'whatsapp');
      assert.deepEqual(handlers.channel.caps, {
        buttons: false,
        urlButtons: false,
        edit: false,
        typing: true,
        format: 'plain',
        maxChars: 4000,
        commandMenu: false,
        images: true,
        files: true,
      });
      for (const k of ['sendText', 'typing', 'sendImage', 'sendFile']) assert.equal(typeof handlers.channel[k], 'function');
      assert.deepEqual(statuses.at(-1), { id: 'whatsapp', status: 'unconfigured', detail: '', peers: [] });
      assert.equal(proto.sockets.length, 0);
      assert.equal(handlers.state().mode, 'secondary');
    });
  });

  test('完整链路（副号）：扫码 → 二维码刷新 → 515 重启 → 绑定码绑主人 → 收消息交秘书 → 回复', async () => {
    await withPlugin({}, async (ctx) => {
      const { handlers, proto, statuses, inbounds, dir } = ctx;
      const loginP = handlers.login();
      await until(() => proto.sockets.length === 1, 'socket');
      const s1 = ctx.sock();
      assert.equal(s1.config.markOnlineOnConnect, false);
      assert.equal(s1.config.syncFullHistory, false);
      s1.qr('QR-1');
      const view = await loginP;
      assert.equal(view.status, 'pending');
      assert.equal(view.qrText, 'QR-1');
      s1.qr('QR-2');
      await until(() => handlers.state().qrText === 'QR-2', 'qr refresh');
      assert.match(handlers.state().detail, /刷新/);

      s1.pair();
      s1.close(515);
      await until(() => proto.sockets.length === 2, 'restart socket');
      const s2 = ctx.sock();
      assert.equal(s2.config.auth.creds.me.id, ME.id, '重启后用保存的凭据');
      s2.open();
      await until(() => handlers.state().connected, 'open');
      let st = handlers.state();
      assert.equal(st.account, '+8613800000001');
      assert.equal(st.qrText, '');
      assert.match(st.bindCode.code, /^\d{6}$/);
      assert.equal(statuses.at(-1).status, 'pending');
      assert.deepEqual(statuses.at(-1).peers, []);

      // 陌生人：普通消息、错的码、群消息都不交、不回
      s2.receive([dm(STRANGER, '你好'), dm(STRANGER, '000000' === st.bindCode.code ? '111111' : '000000'), inGroup(MEMBER, '群', null)]);
      await wait();
      assert.equal(inbounds.length, 0);
      assert.equal(s2.sent.length, 0);

      s2.receive([dm(OWNER, st.bindCode.code, { pushName: '主人', key: { remoteJidAlt: '77002@lid' } })]);
      await until(() => handlers.state().owner && statuses.at(-1).status === 'connected' && s2.sent.length === 1, 'owner');
      st = handlers.state();
      assert.deepEqual(st.owner, { number: '+8613900000002', name: '主人' });
      assert.equal(st.bindCode, null);
      assert.deepEqual(statuses.at(-1), { id: 'whatsapp', status: 'connected', detail: '已连接，主人 +8613900000002', peers: [OWNER] });
      assert.deepEqual(texts(s2), ['已绑定为主人。之后这个号只处理你发来的私聊消息。']);
      assert.equal(inbounds.length, 0, '绑定码本身不交给秘书');
      const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
      assert.equal(saved.owner.jid, OWNER);
      assert.equal(saved.owner.lid, '77002@lid');

      s2.receive([dm(OWNER, '帮我查下 **日程**', { pushName: '主人' }), dm(STRANGER, '我也要')]);
      await until(() => inbounds.length === 1, 'inbound');
      assert.deepEqual(inbounds[0], {
        id: 'whatsapp',
        msg: { peerId: OWNER, senderId: OWNER, chatType: 'private', text: '帮我查下 **日程**', name: '主人', at: 1700000000000 },
      });
      await wait();
      assert.equal(inbounds.length, 1);

      await handlers.channel.typing(OWNER, { on: true });
      assert.deepEqual(s2.presence.at(-1), { type: 'composing', jid: OWNER });
      await until(() => s2.presence.at(-1).type === 'paused', 'typing 自动收掉');

      const reply = await handlers.channel.sendText(OWNER, { text: '## 今天\n**10:00** 开会，*别迟到*' });
      const last = s2.sent.at(-1);
      assert.equal(last.jid, OWNER);
      assert.equal(last.content.text, '*今天*\n*10:00* 开会，_别迟到_');
      assert.equal(last.opts.messageId, reply.messageId);
      assert.equal(last.opts.quoted, undefined);

      // 自己的回复回到 upsert（notify 或 append）都不会再交给秘书
      s2.receive([{ key: { remoteJid: OWNER, fromMe: true, id: reply.messageId }, message: { conversation: last.content.text } }]);
      s2.receive([{ key: { remoteJid: OWNER, fromMe: true, id: reply.messageId }, message: { conversation: last.content.text } }], 'append');
      await wait();
      assert.equal(inbounds.length, 1);
      assert.ok(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).sent.includes(reply.messageId));

      await assert.rejects(handlers.channel.sendText(STRANGER, { text: 'x' }), /只能发给主人/);
    });
  });

  test('绑定码错 5 次作废；换码后才能绑定；解除主人后重新要码', async () => {
    await withPlugin(loggedIn, async (ctx) => {
      const { handlers, inbounds } = ctx;
      await online(ctx);
      const code = handlers.state().bindCode.code;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) ctx.sock().receive([dm(STRANGER, wrong)]);
      await until(() => handlers.state().bindExpired, '作废');
      ctx.sock().receive([dm(OWNER, code)]);
      await wait();
      assert.equal(handlers.state().owner, null, '作废的码不能再用');
      const next = await handlers.newBindCode();
      ctx.sock().receive([dm(OWNER, next.bindCode.code)]);
      await until(() => handlers.state().owner, 'owner');
      await handlers.unbindOwner();
      assert.equal(handlers.state().owner, null);
      assert.match(handlers.state().bindCode.code, /^\d{6}$/);
      ctx.sock().receive([dm(OWNER, '还在吗')]);
      await wait();
      assert.equal(inbounds.length, 0);
    });
  });

  test('自己号码模式：只认「给自己发消息」，回复不形成回环', async () => {
    await withPlugin({ ...loggedIn, state: { mode: 'self' } }, async (ctx) => {
      const { handlers, inbounds, statuses } = ctx;
      await online(ctx);
      assert.deepEqual(statuses.at(-1).peers, [ME_PN]);
      assert.equal(statuses.at(-1).status, 'connected');
      assert.equal(handlers.state().bindCode, null);
      const s = ctx.sock();
      s.receive([
        dm(OWNER, '朋友发来的'),
        dm(OWNER, '我发给朋友的', { key: { fromMe: true } }),
        inGroup(MEMBER, '群', null),
        dm(ME_PN, '提醒我买牛奶', { key: { fromMe: true }, pushName: '我' }),
      ]);
      await until(() => inbounds.length === 1, 'inbound');
      assert.equal(inbounds[0].msg.peerId, ME_PN);
      assert.equal(inbounds[0].msg.text, '提醒我买牛奶');
      await wait();
      assert.equal(inbounds.length, 1);
      assert.equal(s.read.length, 0, '自己号码模式不去标已读');

      const sent = await handlers.channel.sendText(ME_PN, { text: '好的，已记下' });
      assert.equal(s.sent.at(-1).jid, ME_PN);
      // 自己的号发到自己的对话：fromMe、同一个 chat，只能靠 id 认出来
      s.receive([{ key: { remoteJid: ME_PN, fromMe: true, id: sent.messageId }, message: { conversation: '好的，已记下' } }]);
      s.receive([{ key: { remoteJid: '99001@lid', fromMe: true, id: sent.messageId }, message: { conversation: '好的，已记下' } }]);
      await wait();
      assert.equal(inbounds.length, 1);
      await assert.rejects(handlers.channel.sendText(OWNER, { text: 'x' }), /只能发给主人/);
    });
  });

  test('群聊：列出所在的群勾选启用；只认 @ 和回复秘书；回到同一个群并引用', async () => {
    const groups = {
      [GROUP]: { id: GROUP, subject: '项目群', participants: [{}, {}, {}] },
      [OTHER_GROUP]: { id: OTHER_GROUP, subject: '闲聊群', participants: [{}] },
    };
    await withPlugin({ ...loggedIn, groups, state: { owner: { jid: OWNER, pn: OWNER } } }, async (ctx) => {
      const { handlers, inbounds, statuses } = ctx;
      await online(ctx);
      const s = ctx.sock();
      const at = { mentionedJid: [ME_PN] };

      // 没绑定：@ 了也不读
      s.receive([inGroup(MEMBER, '@8613800000001 在吗', at)]);
      await wait();
      assert.equal(inbounds.length, 0);
      await assert.rejects(handlers.setGroup({ jid: GROUP, enabled: true }), /刷新群列表/);

      const list = await handlers.groups();
      assert.deepEqual(list.groups.map((g) => [g.title, g.size, g.enabled]), [['闲聊群', 1, false], ['项目群', 3, false]]);
      const view = await handlers.setGroup({ jid: GROUP, enabled: true });
      assert.deepEqual(view.groups, [{ jid: GROUP, title: '项目群' }]);
      assert.deepEqual(statuses.at(-1).peers, [OWNER], '群不进主动推送名单');

      s.receive([inGroup(MEMBER, '大家早', null), inGroup(MEMBER, '@8613800000001 在吗', at, { group: OTHER_GROUP })]);
      await wait();
      assert.equal(inbounds.length, 0, '普通群消息和未绑定的群都忽略');

      const trigger = inGroup(MEMBER, '@8613800000001 明天几点开会', at, { id: 'T1' });
      s.receive([trigger]);
      await until(() => inbounds.length === 1, 'group inbound');
      assert.deepEqual(inbounds[0].msg, {
        peerId: GROUP,
        senderId: MEMBER,
        chatType: 'group',
        text: '明天几点开会',
        chatTitle: '项目群',
        name: '群友',
        at: 1700000001000,
      });

      const long = `${'甲'.repeat(3990)}\n${'乙'.repeat(100)}`;
      const sent = await handlers.channel.sendText(GROUP, { text: long });
      const out = s.sent.slice(-2);
      assert.equal(out.length, 2);
      assert.ok(out.every((m) => m.jid === GROUP));
      assert.equal(out[0].opts.quoted.key.id, 'T1', '第一条引用触发的那条消息');
      assert.equal(out[1].opts.quoted, undefined);
      assert.equal(sent.messageId, out[1].opts.messageId);

      // 秘书自己的群消息回到 upsert：不当入站
      for (const m of out) {
        s.receive([inGroup(ME_PN, m.content.text, at, { id: m.opts.messageId, key: { fromMe: true } })]);
      }
      await wait();
      assert.equal(inbounds.length, 1);

      // 回复秘书的消息会触发；回复别人的不会
      s.receive([inGroup(MEMBER, '收到，谢谢', { stanzaId: out[0].opts.messageId }, { id: 'T2' })]);
      s.receive([inGroup(MEMBER, '+1', { stanzaId: 'T1' })]);
      await until(() => inbounds.length === 2, 'reply inbound');
      await wait();
      assert.equal(inbounds.length, 2);
      assert.equal(inbounds[1].msg.text, '收到，谢谢');
      await handlers.channel.sendText(GROUP, { text: '不客气' });
      assert.equal(s.sent.at(-1).opts.quoted.key.id, 'T2');

      // 群成员不能用宿主命令和「确认 N」，主人可以
      s.receive([inGroup(MEMBER, '@8613800000001 /last', at), inGroup(MEMBER, '@8613800000001 确认 1', at)]);
      await wait();
      assert.equal(inbounds.length, 2);
      s.receive([inGroup(OWNER, '@8613800000001 /last', at)]);
      await until(() => inbounds.length === 3, 'owner command');
      assert.equal(inbounds[2].msg.text, '/last');

      // 陌生人的私聊照样忽略
      s.receive([dm(STRANGER, '私聊')]);
      await wait();
      assert.equal(inbounds.length, 3);

      await handlers.setGroup({ jid: GROUP, enabled: false });
      s.receive([inGroup(MEMBER, '@8613800000001 还在吗', at)]);
      await wait();
      assert.equal(inbounds.length, 3);
      await assert.rejects(handlers.channel.sendText(GROUP, { text: 'x' }), /只能发给主人或已绑定的群/);
    });
  });

  test('自己号码模式下群也要先绑定，绑定后只认 @ 和回复', async () => {
    const groups = { [GROUP]: { id: GROUP, subject: '家庭群', participants: [] } };
    await withPlugin({ ...loggedIn, groups, state: { mode: 'self' } }, async (ctx) => {
      const { handlers, inbounds } = ctx;
      await online(ctx);
      const s = ctx.sock();
      const at = { mentionedJid: [ME_PN] };
      s.receive([inGroup(MEMBER, '@8613800000001 hi', at)]);
      await wait();
      assert.equal(inbounds.length, 0);
      await handlers.groups();
      await handlers.setGroup({ jid: GROUP, enabled: true });
      s.receive([inGroup(MEMBER, '普通消息', null), inGroup(MEMBER, '@8613800000001 hi', at)]);
      await until(() => inbounds.length === 1, 'inbound');
      assert.equal(inbounds[0].msg.peerId, GROUP);
      await wait();
      assert.equal(inbounds.length, 1);
    });
  });

  test('收图片：放行的私聊才下载，说明当 text，只有图片时 text 为空，相册一张一条', async () => {
    const server = mediaServer();
    await withPlugin({ ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER } }, media: server.handle }, async (ctx) => {
      const { inbounds, fetches } = ctx;
      await online(ctx);
      const s = ctx.sock();
      const from = (jid, message, extra = {}) => ({ key: { remoteJid: jid, fromMe: false, id: `M${Math.random()}`, ...extra }, message, messageTimestamp: 1700000000 });
      const photo = Buffer.from('\xff\xd8\xff\xe0 jpeg 图片字节', 'latin1');
      const shot = server.add(photo);

      s.receive([from(STRANGER, { imageMessage: { ...server.add(photo), caption: '陌生人的图' } })]);
      await wait();
      assert.equal(fetches.length, 0, '被忽略的消息不下载');
      assert.equal(inbounds.length, 0);

      s.receive([from(OWNER, { imageMessage: { ...shot, caption: '看看这张' } })]);
      await until(() => inbounds.length === 1, 'caption image');
      assert.deepEqual(inbounds[0].msg.images, [{ data: photo.toString('base64') }]);
      assert.equal(inbounds[0].msg.text, '看看这张');
      assert.equal(inbounds[0].msg.chatType, 'private');
      const req = fetches.at(-1);
      assert.equal(new URL(req.url).hostname, 'mmg.whatsapp.net');
      assert.equal(new URL(req.url).pathname, shot.directPath);
      assert.equal(req.init.responseType, 'base64');
      assert.equal(req.init.headers.Origin, 'https://web.whatsapp.com');

      const album = [Buffer.from('一'), Buffer.from('二'), Buffer.from('三')];
      s.receive(album.map((p) => from(OWNER, { imageMessage: server.add(p) })));
      await until(() => inbounds.length === 4, 'album');
      for (const [i, p] of album.entries()) {
        assert.equal(inbounds[1 + i].msg.text, '', '只有图片时 text 是空串');
        assert.deepEqual(inbounds[1 + i].msg.images, [{ data: p.toString('base64') }], '一张一条');
      }

      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      s.receive([from(OWNER, { documentWithCaptionMessage: { message: { documentMessage: { ...server.add(png, { keyType: 'document' }), mimetype: 'image/png', caption: '原图' } } } })]);
      await until(() => inbounds.length === 5, 'png file');
      assert.deepEqual(inbounds[4].msg.images, [{ data: png.toString('base64') }]);
      assert.equal(inbounds[4].msg.text, '原图');

      const before = fetches.length;
      s.receive([
        from(OWNER, { videoMessage: { caption: '视频说明' } }),
        from(OWNER, { audioMessage: { ptt: true } }),
        from(OWNER, { stickerMessage: {} }),
        from(OWNER, { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', mediaKey: randomBytes(32), directPath: '/v/pdf' } }),
        from(OWNER, { imageMessage: { ...server.add(photo), fileLength: 6 * 1024 * 1024 } }),
        from(OWNER, { imageMessage: { mediaKey: randomBytes(32), url: 'https://evil.example/x.enc' } }),
      ]);
      await until(() => inbounds.length === 11, 'rejected');
      assert.equal(fetches.length, before, '视频、语音、贴纸、文件、超大、不在清单的主机都不下载');
      assert.deepEqual(
        inbounds.slice(5).map((i) => [i.msg.text, i.msg.images]),
        [
          ['视频说明', [{ rejected: 'not-image' }]],
          ['', [{ rejected: 'not-image' }]],
          ['', [{ rejected: 'not-image' }]],
          ['', [{ rejected: 'not-image' }]],
          ['', [{ rejected: 'too-large' }]],
          ['', [{ rejected: 'too-large' }]],
        ],
      );
      assert.deepEqual(texts(s), [], '收不下由宿主回复，插件自己不回');
    });
  });

  test('下载超时、失败、校验不过都按收不下交给宿主，不卡住后面的消息', async () => {
    const server = mediaServer();
    const ctx = await withPlugin(
      { ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER } }, media: server.handle, options: { downloadTimeoutMs: 60 } },
      async (ctx) => {
        const { inbounds } = ctx;
        await online(ctx);
        const s = ctx.sock();
        const hung = server.add(Buffer.from('x'), { path: '/hang/1' });
        const tampered = server.add(Buffer.from('原图'));
        server.files.get(tampered.directPath)[0] ^= 1;
        const missing = { ...server.add(Buffer.from('y')), directPath: '/v/gone' };
        const started = Date.now();
        s.receive([
          { key: { remoteJid: OWNER, id: 'H1' }, message: { imageMessage: { ...hung, caption: '卡住的图' } } },
          { key: { remoteJid: OWNER, id: 'H2' }, message: { imageMessage: tampered } },
          { key: { remoteJid: OWNER, id: 'H3' }, message: { imageMessage: missing } },
          dm(OWNER, '后面的文字'),
        ]);
        await until(() => inbounds.length === 4, 'all delivered', 2000);
        assert.ok(Date.now() - started < 1500);
        assert.deepEqual(
          inbounds.map((i) => [i.msg.text, i.msg.images]),
          [
            ['卡住的图', [{ rejected: 'too-large' }]],
            ['', [{ rejected: 'too-large' }]],
            ['', [{ rejected: 'too-large' }]],
            ['后面的文字', undefined],
          ],
        );
        assert.deepEqual(texts(s), []);
      },
    );
    assert.equal(ctx.logs.filter((l) => l.includes('下载图片失败')).length, 3);
    assert.ok(ctx.logs.every((l) => !l.includes('/v/') && !l.includes(SECRET)));
  });

  test('群里收图片：被忽略的不下载；@ 或回复秘书才下载；收不下的附件不带也不回', async () => {
    const server = mediaServer();
    const state = { owner: { jid: OWNER, pn: OWNER }, groups: { [GROUP]: { title: '项目群' } }, sent: ['BOTX'] };
    await withPlugin({ ...loggedIn, state, media: server.handle }, async (ctx) => {
      const { inbounds, fetches } = ctx;
      await online(ctx);
      const s = ctx.sock();
      const at = { mentionedJid: [ME_PN] };
      const reply = { stanzaId: 'BOTX' };
      const groupMedia = (message, extra = {}) => ({
        key: { remoteJid: extra.group ?? GROUP, fromMe: false, id: extra.id ?? `GM${Math.random()}`, participant: MEMBER },
        message,
        pushName: '群友',
        messageTimestamp: 1700000001,
      });
      const photo = Buffer.from('群里的图');

      s.receive([
        groupMedia({ imageMessage: { ...server.add(photo), caption: '没 @ 的图' } }),
        groupMedia({ imageMessage: server.add(photo) }),
        groupMedia({ imageMessage: { ...server.add(photo), caption: '@8613800000001 别的群', contextInfo: at } }, { group: OTHER_GROUP }),
        groupMedia({ imageMessage: { ...server.add(photo), caption: '@8613800000001 /last', contextInfo: at } }),
        groupMedia({ imageMessage: { ...server.add(photo), contextInfo: { stanzaId: 'SOMEONE' } } }),
      ]);
      await wait(40);
      assert.equal(fetches.length, 0, '没触发、未绑定、成员发命令、回复别人：都不下载');
      assert.equal(inbounds.length, 0);

      s.receive([groupMedia({ imageMessage: { ...server.add(photo), caption: '@8613800000001 看这个', contextInfo: at } }, { id: 'GI1' })]);
      await until(() => inbounds.length === 1, 'mention image');
      assert.deepEqual(inbounds[0].msg, {
        peerId: GROUP,
        senderId: MEMBER,
        chatType: 'group',
        text: '看这个',
        chatTitle: '项目群',
        name: '群友',
        at: 1700000001000,
        images: [{ data: photo.toString('base64') }],
      });
      await ctx.handlers.channel.sendText(GROUP, { text: '看到了' });
      assert.equal(s.sent.at(-1).opts.quoted.key.id, 'GI1', '回复引用那条图片消息');

      s.receive([groupMedia({ imageMessage: { ...server.add(photo), contextInfo: reply } })]);
      await until(() => inbounds.length === 2, 'reply image');
      assert.equal(inbounds[1].msg.text, '');
      assert.equal(inbounds[1].msg.images.length, 1);

      const sentBefore = s.sent.length;
      s.receive([
        groupMedia({ videoMessage: { caption: '@8613800000001 看视频', contextInfo: at } }),
        groupMedia({ videoMessage: { contextInfo: reply } }),
        groupMedia({ imageMessage: { ...server.add(photo), directPath: '/v/gone', contextInfo: reply } }),
        groupMedia({ imageMessage: { ...server.add(photo), fileLength: 6 * 1024 * 1024, caption: '@8613800000001 大图', contextInfo: at } }),
      ]);
      await until(() => inbounds.length === 4, 'rejected in group');
      await wait();
      assert.deepEqual(
        inbounds.slice(2).map((i) => [i.msg.text, i.msg.images]),
        [
          ['看视频', undefined],
          ['大图', undefined],
        ],
        '收不下的附件不带给宿主；没文字也没图就不交',
      );
      assert.equal(s.sent.length, sentBefore, '群里不回提示');
    });
  });

  test('发图片和文件：经 enso.net.fetch 上传到清单里的媒体域名，说明转格式', async () => {
    await withPlugin({ ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER } } }, async (ctx) => {
      const { handlers, fetches } = ctx;
      await online(ctx);
      const s = ctx.sock();
      const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
      const r = await handlers.channel.sendImage(OWNER, { data: png, fileName: 'a.png', mimeType: 'image/png', caption: '**截图**' });
      assert.equal(typeof r.messageId, 'string');
      const img = s.sent.at(-1);
      assert.deepEqual(img.content.image, png);
      assert.equal(img.content.mimetype, 'image/png');
      assert.equal(img.content.caption, '*截图*');
      assert.equal(typeof img.opts.upload, 'function');
      assert.equal(fetches.length, 1, '不在清单里的主机跳过');
      const url = new URL(fetches[0].url);
      assert.equal(url.hostname, 'mmg.whatsapp.net');
      assert.equal(url.pathname, '/mms/image/ab-_cd');
      assert.equal(fetches[0].init.method, 'POST');
      assert.equal(fetches[0].init.bodyEncoding, 'base64');
      assert.deepEqual(Buffer.from(fetches[0].init.body, 'base64'), png);
      assert.equal(s.uploaded.directPath, '/d/x');

      await handlers.channel.sendFile(OWNER, { data: Buffer.from('%PDF'), fileName: 'r.pdf' });
      const doc = s.sent.at(-1);
      assert.equal(doc.content.fileName, 'r.pdf');
      assert.equal(doc.content.mimetype, 'application/octet-stream');
      assert.equal(new URL(fetches[1].url).pathname.startsWith('/mms/document/'), true);
      await assert.rejects(handlers.channel.sendFile(STRANGER, { data: Buffer.from('x'), fileName: 'x' }), /只能发给主人/);
    });
  });

  test('断线自动重连带退避，连上后退避清零；连接超时也会收尾', async () => {
    await withPlugin({ ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER } } }, async (ctx) => {
      const { proto, handlers, statuses } = ctx;
      await online(ctx);
      ctx.sock().close(428);
      await until(() => /第 1 次重连/.test(handlers.state().detail), 'retry 1');
      assert.equal(handlers.state().connected, false);
      assert.deepEqual(statuses.at(-1).peers, []);
      await until(() => proto.sockets.length === 2, 'socket 2');
      ctx.sock().close(500);
      await until(() => /第 2 次重连/.test(handlers.state().detail), 'retry 2');
      await until(() => proto.sockets.length === 3, 'socket 3');
      // 第三个 socket 一直不出声：连接超时按断线处理，继续退避
      await until(() => /第 3 次重连/.test(handlers.state().detail), 'timeout → retry 3', 1000);
      await until(() => proto.sockets.length === 4, 'socket 4', 1000);
      ctx.sock().open();
      await until(() => handlers.state().connected, 'reopen');
      assert.equal(statuses.at(-1).status, 'connected');
      ctx.sock().close(408);
      await until(() => /第 1 次重连/.test(handlers.state().detail), 'attempt 清零');
      assert.ok(proto.sockets.slice(0, -1).every((s) => s.ended >= 1), '旧连接都关掉了');
    });
  });

  test('被登出（401）：清掉凭据、显示需要重新扫码、不再重连', async () => {
    await withPlugin({ ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER } } }, async (ctx) => {
      const { proto, handlers, statuses, dir } = ctx;
      await online(ctx);
      ctx.sock().close(401);
      await until(() => handlers.state().status === 'error', 'error');
      assert.match(handlers.state().detail, /需要重新扫码/);
      assert.deepEqual(statuses.at(-1).peers, []);
      assert.equal(existsSync(join(dir, 'auth')), false);
      await wait(300);
      assert.equal(proto.sockets.length, 1, '不重连');
      // 再点扫码登录：从头要二维码
      const p = handlers.login();
      await until(() => proto.sockets.length === 2, 'new login');
      assert.equal(ctx.sock().config.auth.creds.me, undefined);
      ctx.sock().qr('QR-NEW');
      assert.equal((await p).qrText, 'QR-NEW');
    });
  });

  test('被顶替（440）和被封（403）都停止重连', async () => {
    for (const code of [440, 403]) {
      await withPlugin({ ...loggedIn }, async (ctx) => {
        await online(ctx);
        ctx.sock().close(code);
        await until(() => ctx.handlers.state().status === 'error', 'error');
        await wait(250);
        assert.equal(ctx.proto.sockets.length, 1);
        assert.equal(existsSync(join(ctx.dir, 'auth', 'creds.json')), true, '凭据保留，可以手动重连');
      });
    }
  });

  test('二维码过期自动刷新，刷满 3 轮停止；一直拿不到二维码也不会无限 loading', async () => {
    await withPlugin({}, async (ctx) => {
      const { proto, handlers } = ctx;
      handlers.login();
      await until(() => proto.sockets.length === 1, 's1');
      ctx.sock().qr('A');
      ctx.sock().close(408);
      await until(() => proto.sockets.length === 2, 's2');
      ctx.sock().qr('B');
      await until(() => handlers.state().qrText === 'B', 'B');
      ctx.sock().close(408);
      await until(() => proto.sockets.length === 3, 's3');
      ctx.sock().qr('C');
      ctx.sock().close(408);
      await until(() => handlers.state().status === 'error', 'stop');
      assert.match(handlers.state().detail, /二维码已过期/);
      assert.equal(handlers.state().qrText, '');
      await wait(100);
      assert.equal(proto.sockets.length, 3);

      const view = await handlers.login();
      assert.equal(view.status, 'pending', 'login 有尽头：loginWaitMs 后先返回');
      await until(() => handlers.state().status === 'error', '连接超时收尾', 1000);
      assert.match(handlers.state().detail, /获取二维码失败/);
    });
  });

  test('凭据只在 dataDir/auth，不进日志、状态、页面和 state.json', async () => {
    const ctx = await withPlugin({}, async (c) => {
      const p = c.handlers.login();
      await until(() => c.proto.sockets.length === 1, 's1');
      c.sock().qr('QR');
      await p;
      c.sock().pair();
      c.sock().close(515);
      await until(() => c.proto.sockets.length === 2, 's2');
      c.sock().open();
      await until(() => c.handlers.state().connected, 'open');
      c.sock().close(428);
      await until(() => c.proto.sockets.length === 3, 's3');
      c.sock().ev.emit('messages.upsert', { messages: [null, { key: {} }], type: 'notify' });
      await c.hooks.flush();
      const authFiles = await readdir(join(c.dir, 'auth'));
      assert.deepEqual(authFiles, ['creds.json']);
      assert.match(await readFile(join(c.dir, 'auth', 'creds.json'), 'utf8'), new RegExp(SECRET));
      assert.doesNotMatch(await readFile(join(c.dir, 'state.json'), 'utf8'), new RegExp(SECRET));
    });
    const everything = JSON.stringify([ctx.logs, ctx.statuses, ctx.events, ctx.inbounds]);
    assert.doesNotMatch(everything, new RegExp(SECRET));
    assert.doesNotMatch(everything, /noiseKey/);
  });

  test('退出登录：通知服务器、删凭据、清主人和群；停用时注销渠道并关连接', async () => {
    await withPlugin({ ...loggedIn, state: { owner: { jid: OWNER, pn: OWNER }, groups: { [GROUP]: { title: '群' } } } }, async (ctx) => {
      await online(ctx);
      const s = ctx.sock();
      const view = await ctx.handlers.logout();
      assert.equal(view.status, 'unconfigured');
      assert.equal(s.loggedOut, 1);
      assert.equal(existsSync(join(ctx.dir, 'auth')), false);
      const saved = JSON.parse(await readFile(join(ctx.dir, 'state.json'), 'utf8'));
      assert.equal(saved.owner, null);
      assert.deepEqual(saved.groups, {});
    });
    const ctx = await withPlugin({ ...loggedIn }, async (c) => {
      await online(c);
    });
    assert.equal(ctx.bag.unregistered, 1);
    assert.ok(ctx.sock().ended >= 1);
  });

  test('换了号重新扫码：旧号的主人和群作废', async () => {
    await withPlugin(
      { ...loggedIn, state: { account: '8613111111111@s.whatsapp.net', owner: { jid: OWNER, pn: OWNER }, groups: { [GROUP]: { title: '群' } } } },
      async (ctx) => {
        await online(ctx);
        assert.equal(ctx.handlers.state().owner, null);
        assert.deepEqual(ctx.handlers.state().groups, []);
        assert.equal(ctx.hooks.session().account, ME_PN);
      },
    );
  });

  test('真协议层能加载（不联网）：凭据目录只在给定路径下生成', async () => {
    const proto = await loadProtocol();
    for (const k of ['makeSocket', 'useAuth', 'newMessageId', 'mediaPath', 'uploadToken']) assert.equal(typeof proto[k], 'function', k);
    assert.equal(proto.mediaPath('image'), '/mms/image');
    assert.equal(proto.mediaPath('document'), '/mms/document');
    assert.match(proto.newMessageId(ME.id), /^[0-9A-F]{16,}$/);
    const dir = await mkdtemp(join(tmpdir(), 'wa-auth-'));
    const auth = await proto.useAuth(join(dir, 'auth'));
    assert.equal(auth.creds.me, undefined);
    assert.ok(auth.creds.noiseKey);
    await auth.saveCreds();
    assert.deepEqual(await readdir(join(dir, 'auth')), ['creds.json']);
  });

  test('真 Baileys 接到本地不说话的服务器：连接超时收尾，不会一直 loading，日志干净', async () => {
    const real = await loadProtocol();
    let hits = 0;
    const server = createServer((socket) => {
      hits += 1;
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${server.address().port}/ws/chat`;
    const protocol = { ...real, makeSocket: (config) => real.makeSocket({ ...config, waWebSocketUrl: url }) };
    try {
      const ctx = await withPlugin({ protocol, options: { connectTimeoutMs: 400, loginWaitMs: 100 } }, async (c) => {
        const view = await c.handlers.login();
        assert.equal(view.status, 'pending');
        await until(() => c.handlers.state().status === 'error', '超时收尾', 3000);
        assert.match(c.handlers.state().detail, /获取二维码失败/);
        assert.ok(hits >= 1);
      });
      assert.deepEqual(ctx.logs, []);
    } finally {
      server.close();
    }
  });
});
