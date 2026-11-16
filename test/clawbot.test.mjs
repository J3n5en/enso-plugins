import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import vm from 'node:vm';
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

async function setup({ dataDir, state, queues } = {}) {
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
  };
  const enso = {
    dataDir: dir,
    net: {
      fetch: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init.method, headers: init.headers ?? {}, body });
        let data;
        if (url.includes('/get_bot_qrcode')) data = shift(q.qrcode, url);
        else if (url.includes('/get_qrcode_status')) data = shift(q.status, url);
        else if (url.includes('/getupdates')) data = shift(q.updates, url);
        else if (url.includes('/sendmessage')) data = shift(q.send, url);
        else if (url.includes('/getconfig')) data = shift(q.config, url);
        else if (url.includes('/sendtyping')) data = shift(q.typing, url);
        else throw new Error(`未预期的请求 ${url}`);
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
  const { tick } = await activate(enso, { loop: false });
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
        });
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
        assert.deepEqual(inbounds[0].msg, { peerId: 'U', text: '你好\n语音转写', at: 1700000000000 });
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

  test('语音无转写、文字带附件、单独附件各回一句说明；正常文字和语音不打扰', async () => {
    const from = (...items) => ({ from_user_id: 'U', message_type: 1, item_list: items });
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
});
