import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import vm from 'node:vm';
import { createDecipheriv, createHash } from 'node:crypto';
import { acceptedWeixinBase } from '../packages/enso.clawbot/lib/ilink.mjs';
import { activate, deactivate } from '../packages/enso.clawbot/main.mjs';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';

function shift(queue, what) {
  if (!queue?.length) throw new Error(`没有预设响应：${what}`);
  return queue.shift();
}

/** 插件单例有模块状态，测试串行跑 */
let gate = Promise.resolve();
async function withBot(opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  const prev = gate;
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const ctx = await setup(opts);
    try {
      await fn(ctx);
    } finally {
      deactivate();
    }
  } finally {
    release();
  }
}

async function setup({ dataDir, state, queues, activateOptions } = {}) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'claw-')));
  if (state) await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const calls = [];
  const statuses = [];
  const inbounds = [];
  const events = [];
  const bag = { unregistered: 0 };
  const handlers = {};
  const q = {
    qrcode: [...(queues?.qrcode ?? [])],
    status: [...(queues?.status ?? [])],
    updates: [...(queues?.updates ?? [])],
    config: [...(queues?.config ?? [])],
    send: [...(queues?.send ?? [])],
    typing: [...(queues?.typing ?? [])],
    upload: [...(queues?.upload ?? [])],
    cdn: [...(queues?.cdn ?? [])],
  };
  const enso = {
    dataDir: dir,
    net: {
      fetch: async (url, init = {}) => {
        if (init.bodyEncoding === 'base64') {
          calls.push({ url, method: init.method, headers: init.headers ?? {}, raw: Buffer.from(init.body, 'base64') });
          const res = shift(q.cdn, url);
          if (res instanceof Error) throw res;
          return { body: '', ...res };
        }
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init.method, headers: init.headers ?? {}, body });
        let data;
        if (url.includes('/get_bot_qrcode')) data = shift(q.qrcode, url);
        else if (url.includes('/get_qrcode_status')) data = shift(q.status, url);
        else if (url.includes('/getupdates')) data = shift(q.updates, url);
        else if (url.includes('/sendmessage')) data = shift(q.send, url);
        else if (url.includes('/getconfig')) data = shift(q.config, url);
        else if (url.includes('/sendtyping')) data = shift(q.typing, url);
        else if (url.includes('/getuploadurl')) data = shift(q.upload, url);
        else throw new Error(`未预期的请求 ${url}`);
        if (typeof data === 'function') data = await data();
        if (data instanceof Error) throw data;
        return { status: 200, headers: {}, body: JSON.stringify(data) };
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
  const { tick } = await activate(enso, { loop: false, ...activateOptions });
  return { dir, tick, calls, statuses, inbounds, events, handlers, bag };
}

const of = (calls, part) => calls.filter((call) => call.url.includes(part));
const readState = async (dir) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
const logged = (extra = {}) => ({
  botToken: 'TOK',
  ilinkBotId: 'BOT',
  baseUrl: DEFAULT_BASE,
  ilinkUserId: 'U',
  cursor: '',
  contexts: {},
  ...extra,
});
const qr = (id) => ({ qrcode: `Q${id}`, qrcode_img_content: `img-${id}` });

describe('微信 Clawbot', { concurrency: false }, () => {
  test('重定向白名单只接受 https 的 weixin.qq.com 子域', () => {
    assert.equal(acceptedWeixinBase('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
    assert.equal(acceptedWeixinBase('Foo.Weixin.qq.com'), 'https://foo.weixin.qq.com');
    assert.equal(acceptedWeixinBase('https://a.b.weixin.qq.com/ilink?x=1'), 'https://a.b.weixin.qq.com');
    assert.equal(acceptedWeixinBase('https://a.weixin.qq.com:443'), 'https://a.weixin.qq.com');
    for (const bad of [
      'https://weixin.qq.com',
      'http://a.weixin.qq.com',
      'https://a.weixin.qq.com.evil.com',
      'https://evil.example',
      'https://notweixin.qq.com',
      'https://user:pass@a.weixin.qq.com',
      'https://a.weixin.qq.com:8443',
      '',
      null,
    ]) {
      assert.equal(acceptedWeixinBase(bad), null, String(bad));
    }
  });

  test('本地二维码库能生成 SVG', () => {
    const src = readFileSync(new URL('../packages/enso.clawbot/lib/qrcode.js', import.meta.url), 'utf8');
    const sandbox = {};
    vm.runInNewContext(src, sandbox);
    const code = sandbox.qrcode(0, 'M');
    code.addData('https://qr.example/1');
    code.make();
    const svg = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    assert.match(svg, /^<svg/);
    assert.match(svg, /<\/svg>$/);
  });

  test('wait → scaned → confirmed：保存凭证并 connected，之后用返回的 base', async () => {
    await withBot(
      {
        queues: {
          qrcode: [qr(1)],
          status: [
            { status: 'wait' },
            { status: 'scaned' },
            {
              status: 'confirmed',
              bot_token: 'TOK',
              ilink_bot_id: 'BOT',
              baseurl: 'https://bar.weixin.qq.com/ilink',
              ilink_user_id: 'USER',
            },
          ],
          updates: [{ ret: 0, msgs: [], get_updates_buf: '' }],
        },
      },
      async ({ dir, tick, calls, statuses, handlers }) => {
        assert.equal(handlers.channel.id, 'wechat');
        assert.deepEqual(handlers.channel.caps, {
          buttons: false,
          urlButtons: false,
          edit: false,
          typing: true,
          format: 'plain',
          maxChars: 2000,
          commandMenu: false,
          images: true,
          files: true,
        });
        assert.equal(typeof handlers.channel.sendImage, 'function');
        assert.equal(typeof handlers.channel.sendFile, 'function');
        const view = await handlers.login();
        assert.equal(view.status, 'pending');
        assert.equal(view.qrText, 'img-1');
        const posted = of(calls, '/get_bot_qrcode')[0];
        assert.equal(posted.method, 'POST');
        assert.deepEqual(posted.body, { local_token_list: [] });
        assert.equal(posted.headers.Authorization, undefined);
        assert.equal(posted.headers.AuthorizationType, 'ilink_bot_token');
        assert.equal(posted.headers['iLink-App-Id'], 'bot');
        assert.equal(posted.headers['iLink-App-ClientVersion'], '256');
        assert.ok(posted.headers['X-WECHAT-UIN']);

        await tick();
        await tick();
        await tick();
        const polls = of(calls, '/get_qrcode_status');
        assert.equal(polls.length, 3);
        assert.equal(polls[0].method, 'GET');
        assert.equal(polls[0].headers.Authorization, undefined);
        assert.equal(polls[0].headers['X-WECHAT-UIN'], undefined);
        assert.equal(new URL(polls[0].url).searchParams.get('qrcode'), 'Q1');

        const saved = await readState(dir);
        assert.equal(saved.botToken, 'TOK');
        assert.equal(saved.ilinkBotId, 'BOT');
        assert.equal(saved.ilinkUserId, 'USER');
        assert.equal(saved.baseUrl, 'https://bar.weixin.qq.com');
        assert.deepEqual(statuses.at(-1), {
          id: 'wechat',
          status: 'connected',
          detail: '已连接',
          peers: ['USER'],
        });

        await tick();
        const updates = of(calls, '/getupdates').at(-1);
        assert.equal(updates.url, 'https://bar.weixin.qq.com/ilink/bot/getupdates');
        assert.equal(updates.headers.Authorization, 'Bearer TOK');
        assert.equal(updates.body.get_updates_buf, '');
        assert.deepEqual(updates.body.base_info, {
          channel_version: '3.0.0/enso-clawbot-0.1.0',
          bot_agent: 'EnsoCode',
        });
      },
    );
  });

  test('验证码在下一次扫码轮询才带上，确认后不再带', async () => {
    await withBot(
      {
        queues: {
          qrcode: [qr(1)],
          status: [
            { status: 'need_verifycode' },
            { status: 'scaned' },
            { status: 'confirmed', bot_token: 'TOK', ilink_bot_id: 'BOT', ilink_user_id: 'USER' },
          ],
        },
      },
      async ({ tick, calls, handlers, statuses }) => {
        await handlers.login();
        await tick();
        assert.equal(new URL(of(calls, '/get_qrcode_status').at(-1).url).searchParams.get('verify_code'), null);
        const view = await handlers.verify({ code: '12 34' });
        assert.equal(view.needVerify, true);
        await tick();
        assert.equal(new URL(of(calls, '/get_qrcode_status').at(-1).url).searchParams.get('verify_code'), '1234');
        await tick();
        assert.equal(new URL(of(calls, '/get_qrcode_status').at(-1).url).searchParams.get('verify_code'), null);
        assert.equal(statuses.at(-1).status, 'connected');
        assert.equal(statuses.at(-1).peers[0], 'USER');
      },
    );
  });

  test('二维码 expired 会刷新，超过 3 次停止', async () => {
    await withBot(
      {
        queues: {
          qrcode: [qr(0), qr(1), qr(2), qr(3)],
          status: [{ status: 'expired' }, { status: 'expired' }, { status: 'expired' }, { status: 'expired' }],
        },
      },
      async ({ tick, calls, handlers, statuses }) => {
        await handlers.login();
        await tick();
        assert.equal((await handlers.state()).qrText, 'img-1');
        assert.equal(of(calls, '/get_bot_qrcode').length, 2);
        await tick();
        await tick();
        assert.equal((await handlers.state()).status, 'pending');
        assert.equal(of(calls, '/get_bot_qrcode').length, 4);
        await tick();
        assert.equal(of(calls, '/get_bot_qrcode').length, 4);
        assert.equal(of(calls, '/get_qrcode_status').length, 4);
        const view = await handlers.state();
        assert.equal(view.status, 'error');
        assert.equal(view.qrText, '');
        assert.match(view.detail, /3/);
        assert.equal(statuses.at(-1).status, 'error');
      },
    );
  });

  test('scaned_but_redirect：合法主机改轮询地址，非法主机报错并留在默认 base', async () => {
    await withBot(
      {
        queues: {
          qrcode: [qr(1)],
          status: [
            { status: 'scaned_but_redirect', redirect_host: 'ilink-a.weixin.qq.com' },
            { status: 'wait' },
          ],
        },
      },
      async ({ tick, calls, handlers }) => {
        await handlers.login();
        await tick();
        await tick();
        const polls = of(calls, '/get_qrcode_status');
        assert.equal(new URL(polls[0].url).host, 'ilinkai.weixin.qq.com');
        assert.equal(new URL(polls[1].url).host, 'ilink-a.weixin.qq.com');
      },
    );

    await withBot(
      {
        queues: {
          qrcode: [qr(1)],
          status: [
            { status: 'scaned_but_redirect', redirect_host: 'https://evil.example/steal' },
            { status: 'wait' },
          ],
        },
      },
      async ({ tick, calls, handlers, statuses }) => {
        await handlers.login();
        await tick();
        assert.equal(statuses.at(-1).status, 'error');
        assert.match(statuses.at(-1).detail, /evil\.example/);
        await tick();
        const polls = of(calls, '/get_qrcode_status');
        assert.equal(new URL(polls[1].url).host, 'ilinkai.weixin.qq.com');
        assert.ok(calls.every((call) => new URL(call.url).hostname.endsWith('.weixin.qq.com')));
      },
    );
  });

  test('confirmed 的 baseurl 不合法时拒绝该主机，并继续用默认 base', async () => {
    await withBot(
      {
        queues: {
          qrcode: [qr(1)],
          status: [
            {
              status: 'confirmed',
              bot_token: 'TOK',
              ilink_bot_id: 'BOT',
              baseurl: 'https://evil.example',
              ilink_user_id: 'USER',
            },
          ],
          updates: [{ ret: 0, msgs: [], get_updates_buf: '' }],
        },
      },
      async ({ dir, tick, calls, statuses, handlers }) => {
        await handlers.login();
        await tick();
        assert.equal(statuses.at(-1).status, 'error');
        assert.match(statuses.at(-1).detail, /evil\.example/);
        assert.equal((await readState(dir)).baseUrl, DEFAULT_BASE);
        assert.equal((await readState(dir)).botToken, 'TOK');
        await tick();
        assert.equal(of(calls, '/getupdates').at(-1).url, `${DEFAULT_BASE}/ilink/bot/getupdates`);
      },
    );
  });

  test('getupdates 游标只在非空时更新并落盘，重启后带上', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claw-'));
    await withBot(
      {
        dataDir: dir,
        state: logged(),
        queues: {
          updates: [
            {
              ret: 0,
              get_updates_buf: 'CUR1',
              msgs: [{ from_user_id: 'U', message_type: 1, item_list: [{ type: 1, text_item: { text: '在吗' } }] }],
            },
            { ret: 0, get_updates_buf: '', msgs: [] },
          ],
        },
      },
      async ({ tick, calls, inbounds }) => {
        await tick();
        await tick();
        const updates = of(calls, '/getupdates');
        assert.equal(updates[0].body.get_updates_buf, '');
        assert.equal(updates[1].body.get_updates_buf, 'CUR1');
        assert.equal(inbounds.length, 1);
        assert.equal((await readState(dir)).cursor, 'CUR1');
      },
    );

    await withBot(
      {
        dataDir: dir,
        queues: { updates: [{ ret: 0, get_updates_buf: '', msgs: [] }] },
      },
      async ({ tick, calls, statuses }) => {
        assert.equal(statuses[0].status, 'connected');
        assert.deepEqual(statuses[0].peers, ['U']);
        await tick();
        assert.equal(of(calls, '/getupdates')[0].body.get_updates_buf, 'CUR1');
      },
    );
  });

  test('sendmessage 带上该 peer 的 context_token；别人的消息不进 inbound', async () => {
    await withBot(
      {
        state: logged(),
        queues: {
          updates: [
            {
              ret: 0,
              get_updates_buf: 'C',
              msgs: [
                {
                  from_user_id: 'OTHER',
                  message_type: 1,
                  context_token: 'NO',
                  item_list: [{ type: 1, text_item: { text: '陌生人' } }],
                },
                {
                  from_user_id: 'U',
                  message_type: 2,
                  context_token: 'ECHO',
                  item_list: [{ type: 1, text_item: { text: '机器人自己' } }],
                },
                {
                  from_user_id: 'U',
                  message_type: 1,
                  context_token: 'CTX',
                  create_time_ms: 1700000000000,
                  item_list: [
                    { type: 1, text_item: { text: '你好' } },
                    { type: 3, voice_item: { text: '语音转写' } },
                  ],
                },
              ],
            },
            {
              ret: 0,
              msgs: [
                {
                  from_user_id: 'U',
                  message_type: 1,
                  item_list: [{ type: 4, file_item: { file_name: 'a.pdf' } }],
                },
              ],
            },
          ],
          send: [{ ret: 0 }, { ret: 0 }, { ret: 9, errmsg: 'rejected' }],
        },
      },
      async ({ dir, tick, calls, inbounds, handlers }) => {
        await tick();
        assert.equal(inbounds.length, 1);
        assert.equal(inbounds[0].id, 'wechat');
        assert.deepEqual(inbounds[0].msg, {
          peerId: 'U',
          senderId: 'U',
          chatType: 'private',
          text: '你好\n语音转写',
          at: 1700000000000,
        });
        assert.equal((await readState(dir)).contexts.U, 'CTX');

        const sent = await handlers.channel.sendText('U', { text: '回复' });
        assert.equal(typeof sent.messageId, 'string');
        const body = of(calls, '/sendmessage').at(-1).body;
        assert.equal(body.msg.to_user_id, 'U');
        assert.equal(body.msg.from_user_id, '');
        assert.equal(body.msg.message_type, 2);
        assert.equal(body.msg.message_state, 2);
        assert.equal(body.msg.context_token, 'CTX');
        assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '回复' } }]);
        assert.deepEqual(body.base_info, { channel_version: '3.0.0/enso-clawbot-0.1.0', bot_agent: 'EnsoCode' });

        await tick();
        assert.equal(inbounds.length, 1);
        assert.equal(of(calls, '/sendmessage').at(-1).body.msg.item_list[0].text_item.text, '暂不支持图片、文件和视频');

        await assert.rejects(handlers.channel.sendText('U', { text: '再来' }), /ret=9/);
      },
    );
  });

  test('发送者 id 取协议的 from_user_id；会话 id 是回复目标 to_user_id；带 group_id 时不标私聊', async () => {
    const owner = 'o9cq80abc@im.wechat';
    const direct = {
      from_user_id: owner,
      to_user_id: 'bot@im.bot',
      session_id: 'S1',
      message_type: 1,
      context_token: 'CTX',
      item_list: [{ type: 1, text_item: { text: '在吗' } }],
    };
    const grouped = { ...direct, group_id: 'G1', item_list: [{ type: 1, text_item: { text: '群里' } }] };
    await withBot(
      {
        state: logged({ ilinkUserId: owner }),
        queues: { updates: [{ ret: 0, msgs: [direct, grouped] }], send: [{ ret: 0 }] },
      },
      async ({ tick, calls, inbounds, handlers }) => {
        await tick();
        assert.equal(inbounds.length, 2);
        assert.deepEqual(inbounds[0].msg, {
          peerId: direct.from_user_id,
          senderId: direct.from_user_id,
          chatType: 'private',
          text: '在吗',
        });
        // 协议里 group_id 只是类型面，sendmessage 没有群目标：不猜成群，也不标私聊
        assert.deepEqual(inbounds[1].msg, {
          peerId: grouped.from_user_id,
          senderId: grouped.from_user_id,
          text: '群里',
        });
        await handlers.channel.sendText(inbounds[0].msg.peerId, { text: '回' });
        assert.equal(of(calls, '/sendmessage').at(-1).body.msg.to_user_id, owner);
      },
    );
  });

  test('语音无转写、文字带附件、单独附件各回一句说明；正常文字和语音不打扰', async () => {
    const from = (...items) => ({ from_user_id: 'U', message_type: 1, context_token: 'CTX', item_list: items });
    const cases = [
      { items: [{ type: 3, voice_item: {} }], inbound: null, hint: '这条语音没能转成文字，麻烦再发一次或者打字' },
      { items: [{ type: 3, voice_item: { text: '' } }], inbound: null, hint: '这条语音没能转成文字，麻烦再发一次或者打字' },
      {
        items: [{ type: 1, text_item: { text: '看看这张' } }, { type: 2, image_item: {} }],
        inbound: '看看这张',
        hint: '暂不支持图片、文件和视频，只处理了文字',
      },
      { items: [{ type: 2, image_item: {} }], inbound: null, hint: '暂不支持图片、文件和视频' },
      { items: [{ type: 4, file_item: { file_name: 'a.pdf' } }], inbound: null, hint: '暂不支持图片、文件和视频' },
      { items: [{ type: 5, video_item: {} }], inbound: null, hint: '暂不支持图片、文件和视频' },
      { items: [{ type: 1, text_item: { text: '在吗' } }], inbound: '在吗', hint: null },
      { items: [{ type: 3, voice_item: { text: '语音转写' } }], inbound: '语音转写', hint: null },
    ];
    for (const { items, inbound, hint } of cases) {
      await withBot(
        { state: logged(), queues: { updates: [{ ret: 0, msgs: [from(...items)] }], send: [{ ret: 0 }] } },
        async ({ tick, calls, inbounds }) => {
          await tick();
          const label = JSON.stringify(items);
          assert.deepEqual(inbounds.map((x) => x.msg.text), inbound ? [inbound] : [], label);
          const sent = of(calls, '/sendmessage').map((call) => call.body.msg.item_list[0].text_item.text);
          assert.deepEqual(sent, hint ? [hint] : [], label);
        },
      );
    }
  });

  test('ret=-14 进入重新扫码并停止轮询；其他 ret 不投递也不推进游标', async () => {
    await withBot(
      {
        state: logged({ cursor: 'KEEP', contexts: { U: 'CTX' } }),
        queues: {
          updates: [
            { ret: 5, errmsg: 'busy', get_updates_buf: 'NEXT', msgs: [
              { from_user_id: 'U', message_type: 1, item_list: [{ type: 1, text_item: { text: '不该进' } }] },
            ] },
          ],
        },
      },
      async ({ dir, tick, inbounds }) => {
        await assert.rejects(tick(), /ret=5/);
        assert.equal(inbounds.length, 0);
        const saved = await readState(dir);
        assert.equal(saved.cursor, 'KEEP');
        assert.equal(saved.botToken, 'TOK');
      },
    );

    await withBot(
      {
        state: logged(),
        queues: {
          updates: [
            {
              errcode: -14,
              get_updates_buf: 'GONE',
              msgs: [{ from_user_id: 'U', message_type: 1, item_list: [{ type: 1, text_item: { text: '晚了' } }] }],
            },
          ],
        },
      },
      async ({ dir, tick, calls, statuses, inbounds, handlers, bag }) => {
        await tick();
        assert.equal(inbounds.length, 0);
        assert.equal(of(calls, '/getupdates').length, 1);
        assert.equal(statuses.at(-1).status, 'error');
        assert.match(statuses.at(-1).detail, /relogin/);
        assert.deepEqual(statuses.at(-1).peers, []);
        const saved = await readState(dir);
        assert.equal(saved.botToken, '');
        assert.equal(saved.ilinkUserId, '');
        const before = calls.length;
        assert.equal(await tick(), 'idle');
        assert.equal(calls.length, before);
        const view = await handlers.state();
        assert.equal(view.status, 'error');
        assert.match(view.detail, /重新扫码/);
        deactivate();
        assert.equal(bag.unregistered, 1);
      },
    );
  });

  test('typing 失败吞掉；成功时先取票再按 status 发送', async () => {
    await withBot(
      {
        state: logged({ contexts: { U: 'CTX' } }),
        queues: {
          config: [{ ret: 7 }, { ret: 0, typing_ticket: 'TICK' }],
          typing: [{ ret: 0 }, { ret: 0 }],
        },
      },
      async ({ calls, handlers }) => {
        await handlers.channel.typing('U', { on: true });
        assert.equal(of(calls, '/sendtyping').length, 0);
        await handlers.channel.typing('U', { on: true });
        const config = of(calls, '/getconfig').at(-1);
        assert.equal(config.body.ilink_user_id, 'U');
        assert.equal(config.body.context_token, 'CTX');
        assert.equal(of(calls, '/sendtyping').at(-1).body.status, 1);
        assert.equal(of(calls, '/sendtyping').at(-1).body.typing_ticket, 'TICK');
        await handlers.channel.typing('U', { on: false });
        assert.equal(of(calls, '/getconfig').length, 2);
        assert.equal(of(calls, '/sendtyping').at(-1).body.status, 2);
      },
    );
  });

  const decrypt = (cipher, keyHex) => {
    const d = createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null);
    return Buffer.concat([d.update(cipher), d.final()]);
  };

  test('发图片：getuploadurl → AES-128-ECB 加密 POST 到 CDN → sendmessage 带 image_item；说明先单独发', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);
    await withBot(
      {
        state: logged({ contexts: { U: 'CTX' } }),
        queues: {
          upload: [{ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1' }],
          cdn: [{ status: 200, headers: { 'x-encrypted-param': 'DL-PARAM' } }],
          send: [{ ret: 0 }, { ret: 0 }],
        },
      },
      async ({ calls, handlers }) => {
        const sent = await handlers.channel.sendImage('U', {
          data: png,
          fileName: 'shot.png',
          mimeType: 'image/png',
          caption: '今天的截图',
        });
        assert.equal(typeof sent.messageId, 'string');

        const up = of(calls, '/getuploadurl')[0];
        assert.equal(up.url, 'https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl');
        assert.equal(up.headers.Authorization, 'Bearer TOK');
        assert.equal(up.body.media_type, 1);
        assert.equal(up.body.to_user_id, 'U');
        assert.equal(up.body.rawsize, png.length);
        assert.equal(up.body.rawfilemd5, createHash('md5').update(png).digest('hex'));
        assert.equal(up.body.filesize, 16);
        assert.equal(up.body.no_need_thumb, true);
        assert.match(up.body.filekey, /^[0-9a-f]{32}$/);
        assert.match(up.body.aeskey, /^[0-9a-f]{32}$/);
        assert.deepEqual(up.body.base_info, { channel_version: '3.0.0/enso-clawbot-0.1.0', bot_agent: 'EnsoCode' });

        const cdn = calls.find((call) => call.raw);
        assert.equal(cdn.url, 'https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1');
        assert.equal(cdn.method, 'POST');
        assert.equal(cdn.headers['Content-Type'], 'application/octet-stream');
        assert.equal(cdn.raw.length, 16);
        assert.deepEqual(decrypt(cdn.raw, up.body.aeskey), png);

        const sends = of(calls, '/sendmessage');
        assert.equal(sends.length, 2);
        assert.deepEqual(sends[0].body.msg.item_list, [{ type: 1, text_item: { text: '今天的截图' } }]);
        const msg = sends[1].body.msg;
        assert.equal(msg.to_user_id, 'U');
        assert.equal(msg.message_type, 2);
        assert.equal(msg.message_state, 2);
        assert.equal(msg.context_token, 'CTX');
        assert.deepEqual(msg.item_list, [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: 'DL-PARAM',
                aes_key: Buffer.from(up.body.aeskey).toString('base64'),
                encrypt_type: 1,
              },
              mid_size: 16,
            },
          },
        ]);
      },
    );
  });

  test('发文件：没有 upload_full_url 时按 upload_param + filekey 拼 CDN 地址，sendmessage 带 file_item', async () => {
    const pdf = Buffer.from('%PDF-1.4 report body that is longer than one block');
    await withBot(
      {
        state: logged({ contexts: { U: 'CTX' } }),
        queues: {
          upload: [{ ret: 0, upload_param: 'UP/PARAM=' }],
          cdn: [{ status: 200, headers: { 'x-encrypted-param': 'DL2' } }],
          send: [{ ret: 0 }],
        },
      },
      async ({ calls, handlers }) => {
        await handlers.channel.sendFile('U', { data: pdf, fileName: 'report.pdf' });
        const up = of(calls, '/getuploadurl')[0];
        assert.equal(up.body.media_type, 3);
        assert.equal(up.body.filesize, Math.ceil((pdf.length + 1) / 16) * 16);
        const cdn = calls.find((call) => call.raw);
        assert.equal(
          cdn.url,
          `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent('UP/PARAM=')}&filekey=${up.body.filekey}`,
        );
        assert.deepEqual(decrypt(cdn.raw, up.body.aeskey), pdf);
        const sends = of(calls, '/sendmessage');
        assert.equal(sends.length, 1);
        assert.deepEqual(sends[0].body.msg.item_list, [
          {
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: 'DL2',
                aes_key: Buffer.from(up.body.aeskey).toString('base64'),
                encrypt_type: 1,
              },
              file_name: 'report.pdf',
              len: String(pdf.length),
            },
          },
        ]);
      },
    );
  });

  test('CDN 5xx 重试后成功；4xx 不重试直接失败；缺 x-encrypted-param 算失败', async () => {
    const data = Buffer.from('hello');
    await withBot(
      {
        state: logged({ contexts: { U: 'CTX' } }),
        queues: {
          upload: [{ upload_param: 'P' }, { upload_param: 'P' }, { upload_param: 'P' }],
          cdn: [
            { status: 500, headers: { 'x-error-message': 'busy' } },
            { status: 200, headers: { 'x-encrypted-param': 'OK' } },
            { status: 403, headers: { 'x-error-message': 'denied' } },
            { status: 200, headers: {} },
            { status: 200, headers: {} },
            { status: 200, headers: {} },
          ],
          send: [{ ret: 0 }],
        },
      },
      async ({ calls, handlers }) => {
        await handlers.channel.sendFile('U', { data, fileName: 'a.txt' });
        assert.equal(calls.filter((call) => call.raw).length, 2);
        await assert.rejects(handlers.channel.sendFile('U', { data, fileName: 'a.txt' }), /HTTP 403 denied/);
        assert.equal(calls.filter((call) => call.raw).length, 3);
        await assert.rejects(handlers.channel.sendImage('U', { data, fileName: 'a.png' }), /x-encrypted-param/);
        assert.equal(calls.filter((call) => call.raw).length, 6);
        assert.equal(of(calls, '/sendmessage').length, 1);
      },
    );
  });

  test('getuploadurl 没给地址、sendmessage ret 非 0、未登录都抛错', async () => {
    const data = Buffer.from('x');
    await withBot(
      {
        state: logged({ contexts: { U: 'CTX' } }),
        queues: {
          upload: [{ ret: 0 }, { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?f=1' }],
          cdn: [{ status: 200, headers: { 'x-encrypted-param': 'D' } }],
          send: [{ ret: 9, errmsg: 'bad' }],
        },
      },
      async ({ handlers }) => {
        await assert.rejects(handlers.channel.sendImage('U', { data, fileName: 'a.png' }), /没有返回上传地址/);
        await assert.rejects(handlers.channel.sendImage('U', { data, fileName: 'a.png' }), /ret=9/);
      },
    );
    await withBot({}, async ({ handlers }) => {
      await assert.rejects(handlers.channel.sendFile('U', { data, fileName: 'a.txt' }), /未登录/);
    });
  });

  const EXPIRED = '微信会话已过期，请在微信给机器人发任意一条消息后恢复';
  const expired = (err) => {
    assert.equal(err.message, EXPIRED);
    assert.equal(err.code, 'SESSION_EXPIRED');
    assert.equal(err.userMessage, EXPIRED);
    return true;
  };

  test('没有 context_token 时文字、图片、文件都直接报会话过期，不请求接口', async () => {
    await withBot({ state: logged() }, async ({ calls, handlers }) => {
      await assert.rejects(handlers.channel.sendText('U', { text: '你好' }), expired);
      await assert.rejects(handlers.channel.sendImage('U', { data: Buffer.from('i'), fileName: 'a.png', caption: '图' }), expired);
      await assert.rejects(handlers.channel.sendFile('U', { data: Buffer.from('d'), fileName: 'a.pdf' }), expired);
      assert.equal(calls.length, 0);
    });
  });

  test('sendmessage ret=-2 标记 token 失效：之后快速失败、重启仍失效，新入站消息后恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claw-'));
    await withBot(
      { dataDir: dir, state: logged({ contexts: { U: 'OLD' } }), queues: { send: [{ ret: -2, errmsg: 'prepare failed' }] } },
      async ({ calls, handlers }) => {
        await assert.rejects(handlers.channel.sendText('U', { text: '第一条' }), expired);
        await assert.rejects(handlers.channel.sendText('U', { text: '第二条' }), expired);
        await assert.rejects(handlers.channel.sendImage('U', { data: Buffer.from('i'), fileName: 'a.png' }), expired);
        assert.equal(of(calls, '/sendmessage').length, 1);
        assert.equal(of(calls, '/getuploadurl').length, 0);
      },
    );
    await withBot(
      {
        dataDir: dir,
        queues: {
          updates: [
            {
              ret: 0,
              msgs: [{ from_user_id: 'U', message_type: 1, context_token: 'NEW', item_list: [{ type: 1, text_item: { text: '在' } }] }],
            },
          ],
          send: [{ ret: 0 }],
        },
      },
      async ({ tick, calls, handlers }) => {
        await assert.rejects(handlers.channel.sendText('U', { text: '重启后' }), expired);
        assert.equal(of(calls, '/sendmessage').length, 0);
        await tick();
        await handlers.channel.sendText('U', { text: '恢复' });
        assert.equal(of(calls, '/sendmessage').at(-1).body.msg.context_token, 'NEW');
      },
    );
  });

  test('媒体 sendmessage ret=-2 同样报会话过期并标记失效', async () => {
    await withBot(
      {
        state: logged({ contexts: { U: 'OLD' } }),
        queues: {
          upload: [{ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?f=1' }],
          cdn: [{ status: 200, headers: { 'x-encrypted-param': 'D' } }],
          send: [{ ret: -2 }],
        },
      },
      async ({ calls, handlers }) => {
        await assert.rejects(handlers.channel.sendFile('U', { data: Buffer.from('d'), fileName: 'a.pdf' }), expired);
        await assert.rejects(handlers.channel.sendText('U', { text: '再发' }), expired);
        assert.equal(of(calls, '/sendmessage').length, 1);
      },
    );
  });

  const captureConsole = async (levels, fn) => {
    const logs = Object.fromEntries(levels.map((level) => [level, []]));
    const saved = levels.map((level) => [level, console[level]]);
    for (const level of levels) console[level] = (...args) => logs[level].push(args.join(' '));
    try {
      await fn();
    } finally {
      for (const [level, original] of saved) console[level] = original;
    }
    return logs;
  };

  test('长轮询失败先记 warn，连续超过阈值才记 error，成功一次后重新计数', async () => {
    const fail = () => new TypeError('fetch failed');
    let finish;
    const finished = new Promise((resolve) => (finish = resolve));
    const logs = await captureConsole(['warn', 'error'], () =>
      withBot(
        {
          state: logged(),
          activateOptions: { loop: true, backoffStartMs: 1, backoffMaxMs: 2, minGapMs: 0, pollErrorAfter: 3 },
          queues: {
            updates: [fail, fail, fail, fail, { ret: 0, msgs: [] }, fail, () => (finish(), { ret: 0, msgs: [] })],
          },
        },
        () => finished,
      ),
    );
    assert.equal(logs.warn.length, 4);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /fetch failed/);
  });

  test('typing 被取消只记 debug，其他失败仍记 error', async () => {
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const logs = await captureConsole(['debug', 'error'], () =>
      withBot(
        { state: logged({ contexts: { U: 'CTX' } }), queues: { config: [aborted, new Error('微信 HTTP 500')] } },
        async ({ handlers }) => {
          await handlers.channel.typing('U', { on: true });
          await handlers.channel.typing('U', { on: true });
        },
      ),
    );
    assert.equal(logs.debug.length, 1);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /HTTP 500/);
  });
});

