import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { Api } from '../packages/enso.tgclient/vendor/gramjs.mjs';
import { activate, deactivate, INJECT_IMAGE_LIMITS, useTelegramClient } from '../packages/enso.tgclient/main.mjs';

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03, 0x04]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

async function withWatch(t, fn) {
  let dataDir;
  let timers = false;
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
  dataDir = await mkdtemp(join(tmpdir(), 'tgi-'));
  await writeFile(join(dataDir, 'account.json'), JSON.stringify({ session }), { mode: 0o600 });
  class FakeClient {
    constructor() {
      clients.push(this);
      this.handlers = [];
      this.media = new Map();
    }
    setLogLevel() {}
    async connect() {}
    async checkAuthorization() { return true; }
    async destroy() {}
    async getMe() { return new Api.User({ id: 42, firstName: 'Me', username: 'me' }); }
    async getDialogs() { return []; }
    async getInputEntity() { return null; }
    async getEntity() { return new Api.Chat({ id: 100, title: '群' }); }
    async sendMessage(entity, { message }) {
      return { id: 900, chatId: 100, message, out: true, date: 1_700_000_001, peerId: { chatId: 100 } };
    }
    async invoke(req) {
      if (req instanceof Api.account.GetNotifySettings) return { muteUntil: 0 };
      if (req instanceof Api.messages.GetDialogFilters) return { filters: [] };
      return {};
    }
    async downloadMedia(msg) {
      const v = this.media.get(msg?.id);
      if (typeof v === 'function') return v();
      if (v instanceof Error) throw v;
      if (v) return v;
      throw new Error('no media');
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
  const drain = async (n = 200) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const emit = async (extra = {}) => {
    const { bytes, downloadError, ...rest } = extra;
    const id = ++n;
    const m = {
      id,
      date: 1_700_000_000,
      out: false,
      chatId: 100,
      senderId: 7,
      sender: new Api.User({ id: 7, firstName: 'Bob' }),
      message: '',
      getChat: async () => new Api.Chat({ id: 100, title: '群' }),
      getSender: async () => new Api.User({ id: 7, firstName: 'Bob' }),
      ...rest,
    };
    const c = clients.at(-1);
    if (downloadError) c.media.set(id, downloadError);
    else if (bytes !== undefined) c.media.set(id, bytes);
    const handler = c?.handlers?.[0];
    assert.ok(handler, '新消息处理器未注册');
    await handler({ message: m });
    await drain();
  };
  const tick = async (ms) => {
    mock.timers.tick(ms);
    await drain();
  };
  await fn({ injected, emit, tick });
}

test('带 photo 的消息会把图片投递给模型', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ photo: { id: 1 }, message: '看图', bytes: JPEG });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images?.length, 1);
    assert.equal(injected[0].images[0].mimeType, 'image/jpeg');
    assert.deepEqual(Buffer.from(injected[0].images[0].data, 'base64'), JPEG);
    assert.match(injected[0].text, /看图/);
  });
});

test('一次投递最多 4 张图，超出的在正文提示未转达', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    for (let i = 0; i < 5; i++) {
      await emit({ photo: { id: i + 1 }, message: `图${i + 1}`, bytes: JPEG });
    }
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images?.length, 4);
    assert.match(injected[0].text, /还有 1 张图片未转达/);
  });
});

test('base64 超限的图片不进 images，正文提示体积过大', async (t) => {
  const prev = INJECT_IMAGE_LIMITS.maxBase64Chars;
  INJECT_IMAGE_LIMITS.maxBase64Chars = 8;
  t.after(() => { INJECT_IMAGE_LIMITS.maxBase64Chars = prev; });
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ photo: { id: 1 }, message: '大图', bytes: JPEG });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images, undefined);
    assert.match(injected[0].text, /体积过大未转达/);
  });
});

test('webp 贴纸会按 image/webp 转达', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({
      document: { mimeType: 'image/webp' },
      message: '贴纸',
      bytes: WEBP,
    });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images?.length, 1);
    assert.equal(injected[0].images[0].mimeType, 'image/webp');
    assert.deepEqual(Buffer.from(injected[0].images[0].data, 'base64'), WEBP);
  });
});

test('视频、语音、pdf 不转达图片也不加提示', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({ document: { mimeType: 'video/mp4' }, message: '视频', bytes: JPEG });
    await emit({ document: { mimeType: 'audio/ogg' }, message: '语音', bytes: JPEG });
    await emit({ document: { mimeType: 'application/pdf' }, message: '文档', bytes: JPEG });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images, undefined);
    assert.doesNotMatch(injected[0].text, /未转达/);
  });
});

test('downloadMedia 抛错时文字仍投递，提示未转达', async (t) => {
  await withWatch(t, async ({ injected, emit, tick }) => {
    await emit({
      photo: { id: 1 },
      message: '坏图',
      downloadError: new Error('boom'),
    });
    await tick(30_000);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].images, undefined);
    assert.match(injected[0].text, /坏图/);
    assert.match(injected[0].text, /未转达/);
  });
});
