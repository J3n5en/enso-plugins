import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { activate, deactivate, mediaRoots } from '../packages/enso.tgclient/main.mjs';
import { Api, getPeerId } from '../packages/enso.tgclient/vendor/gramjs.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(repo, 'packages/enso.tgclient/enso-plugin.json');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF = Buffer.from('GIF89a-body');
const person = (id, name) => new Api.User({ id: BigInt(id), accessHash: 1n, firstName: name });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tgmedia-'));
  const dataDir = join(dir, 'data');
  const tools = new Map();
  const sent = [];
  const parts = [];
  let nextId = 900;
  const msg = (peer, caption) => new Api.Message({
    id: nextId++,
    peerId: new Api.PeerUser({ userId: BigInt(getPeerId(peer).toString()) }),
    fromId: new Api.PeerUser({ userId: 1n }),
    date: 1_700_000_000,
    message: caption,
    out: true,
  });
  const client = {
    session: { save: () => 'sess' },
    async connect() {},
    async checkAuthorization() { return true; },
    async getMe() { return person(1, 'Me'); },
    async destroy() {},
    addEventHandler() {},
    async getDialogs() { return []; },
    async getEntity(id) {
      const n = Number(id?.toString?.() ?? id);
      if (n === 404) throw new Error('nope');
      return person(n, `U${n}`);
    },
    async getInputEntity() { return null; },
    async sendFile(peer, opts) {
      sent.push(opts);
      if (Array.isArray(opts.file)) return opts.file.map((_, i) => msg(peer, i ? '' : opts.caption[0]));
      return msg(peer, opts.caption);
    },
    async invoke(req) {
      if (req.className === 'upload.SaveFilePart') parts.push(req);
      if (req.className === 'messages.GetDialogFilters') return { filters: [] };
      return true;
    },
  };
  await activate({
    dataDir,
    config: { get: async () => ({ notify: false }) },
    ui: { notify: async () => {}, openExternal: async () => {} },
    renderer: { handle: () => {} },
    tools: { register: (name, fn) => tools.set(name, fn) },
  }, { client });
  const file = async (name, data) => {
    const p = join(dir, name);
    await writeFile(p, data);
    return p;
  };
  const send = (args, ctx = { sessionId: 's1' }) => tools.get('tg_send_media')({ chat: '42', ...args }, ctx);
  return { dir, sent, parts, file, send };
}

async function run(fn) {
  const t = await setup();
  try {
    await fn(t);
  } finally {
    await deactivate();
    await rm(t.dir, { recursive: true, force: true });
  }
}

describe('tg_send_media', { concurrency: false }, () => {
  test('单张图片：上传原始字节，caption 挂在这条消息上', () =>
    run(async (t) => {
      const p = await t.file('shot.png', PNG);
      const r = await t.send({ files: [p], caption: '更新图' });
      assert.deepEqual(r.ids, [900]);
      assert.equal(r.album, false);
      assert.equal(r.chat.id, '42');
      assert.equal(t.sent.length, 1);
      assert.ok(t.sent[0].file instanceof Api.InputFile);
      assert.match(t.sent[0].file.name, /\.png$/);
      assert.equal(t.sent[0].caption, '更新图');
      assert.deepEqual(Buffer.concat(t.parts.map((x) => x.bytes)), PNG);
    }));

  test('多张默认合成一个相册，caption 只给第一张，返回一组 id', () =>
    run(async (t) => {
      const files = [await t.file('a.png', PNG), await t.file('b.jpg', JPEG), await t.file('c.png', PNG)];
      const r = await t.send({ files, caption: '三张' });
      assert.equal(t.sent.length, 1);
      assert.equal(t.sent[0].file.length, 3);
      assert.deepEqual(t.sent[0].caption, ['三张']);
      assert.equal(t.sent[0].forceDocument, false);
      assert.equal(r.album, true);
      assert.deepEqual(r.ids, [900, 901, 902]);
    }));

  test('相册里有 gif 时整组按文件发', () =>
    run(async (t) => {
      const files = [await t.file('a.png', PNG), await t.file('b.gif', GIF)];
      await t.send({ files });
      assert.equal(t.sent[0].forceDocument, true);
    }));

  test('asAlbum:false 逐张发送，caption 只在第一条', () =>
    run(async (t) => {
      const files = [await t.file('a.png', PNG), await t.file('b.png', PNG)];
      const r = await t.send({ files, caption: '说明', asAlbum: false });
      assert.deepEqual(t.sent.map((s) => s.caption), ['说明', '']);
      assert.equal(r.album, false);
      assert.deepEqual(r.ids, [900, 901]);
    }));

  test('topic 与 replyTo 传给 GramJS', () =>
    run(async (t) => {
      const p = await t.file('a.png', PNG);
      await t.send({ files: [p], topic: 7 });
      assert.equal(t.sent[0].replyTo, 7);
      await t.send({ files: [p], topic: 7, replyTo: 9 });
      assert.equal(t.sent[1].replyTo, 9);
      assert.equal(t.sent[1].topMsgId, 7);
    }));

  test('允许目录外的文件和越界的符号链接被拒，不上传', () =>
    run(async (t) => {
      await assert.rejects(t.send({ files: [manifestPath] }), /不在允许的目录/);
      const link = join(t.dir, 'link.png');
      await symlink(manifestPath, link);
      await assert.rejects(t.send({ files: [link] }), /不在允许的目录/);
      await assert.rejects(t.send({ files: ['relative.png'] }), /绝对路径/);
      assert.equal(t.sent.length, 0);
      assert.equal(t.parts.length, 0);
    }));

  test('调用会话的项目目录在白名单内', () =>
    run(async (t) => {
      await assert.rejects(t.send({ files: [manifestPath] }, { sessionId: 's1', projectRoot: repo }), /只支持图片/);
    }));

  test('类型不对、过大、数量不对都被拒', () =>
    run(async (t) => {
      await assert.rejects(t.send({ files: [await t.file('fake.png', 'not an image')] }), /只支持图片/);
      const big = Buffer.alloc(10 * 1024 * 1024 + 1);
      PNG.copy(big);
      await assert.rejects(t.send({ files: [await t.file('big.png', big)] }), /10MB/);
      await assert.rejects(t.send({ files: [] }), /1 到 10/);
      const p = await t.file('a.png', PNG);
      await assert.rejects(t.send({ files: Array(11).fill(p) }), /1 到 10/);
      await assert.rejects(t.send({ files: [join(t.dir, 'missing.png')] }), /读不到/);
      assert.equal(t.sent.length, 0);
    }));

  test('chat 解析失败时不上传不发送', () =>
    run(async (t) => {
      const p = await t.file('a.png', PNG);
      await assert.rejects(t.send({ files: [p], chat: '不存在的群' }), /没找到/);
      await assert.rejects(t.send({ files: [p], chat: '404' }), /找不到聊天/);
      assert.equal(t.sent.length, 0);
      assert.equal(t.parts.length, 0);
    }));
});

test('mediaRoots：临时目录、项目目录、聊天图片与会话 worktree', () => {
  const userData = '/Users/x/Library/Application Support/enso-code';
  const roots = mediaRoots({
    dataDir: join(userData, 'extension-plugins/data/enso.tgclient'),
    projectRoot: '/Users/x/proj',
    env: { ENSO_USER_IMAGE_DIRS: '/Users/x/imgs' },
    tmp: '/var/folders/ab/T',
  });
  for (const p of ['/tmp', '/private/tmp', '/var/folders/ab/T', '/var/folders', '/private/var/folders', '/Users/x/proj', join(userData, 'bot-chats'), join(userData, 'worktrees'), '/Users/x/imgs'])
    assert.ok(roots.includes(p), p);
  const bare = mediaRoots({ dataDir: '/somewhere/else', env: {}, tmp: '/tmp' });
  assert.ok(!bare.some((p) => p.includes('bot-chats') || p.includes('somewhere')));
});
