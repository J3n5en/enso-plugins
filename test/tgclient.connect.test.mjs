import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Api } from '../packages/enso.tgclient/vendor/gramjs.mjs';
import { activate, connectRetryDelay, deactivate, useTelegramClient, withTimeout } from '../packages/enso.tgclient/main.mjs';

// 假 session，只用来让插件走「已登录、启动即连接」的路径，不会真的连 Telegram
const session = (() => {
  const addr = Buffer.from('127.0.0.1');
  const alen = Buffer.alloc(2);
  alen.writeInt16BE(addr.length, 0);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443, 0);
  return `1${Buffer.concat([Buffer.from([2]), alen, addr, port, Buffer.alloc(256, 1)]).toString('base64')}`;
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await sleep(10);
  }
}

/**
 * 模拟 GramJS 的行为：connect() 重试用完返回 false 而不是抛错；没连上时 invoke/getMe 永远等「已连接」。
 * plan(i) 决定第 i 个客户端的 connect 结果：'ok' | 'false' | 'hang'
 */
async function setup(t, plan, { getDialogs, retryMs = [30, 60] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tgc-'));
  await writeFile(join(dataDir, 'account.json'), JSON.stringify({ phone: '+10000000000', session }), { mode: 0o600 });
  const clients = [];
  class FakeClient {
    constructor() {
      this.i = clients.length;
      this.connected = false;
      this.destroyed = false;
      clients.push(this);
    }
    setLogLevel() {}
    async connect() {
      const how = plan(this.i);
      if (how === 'hang') return never();
      if (how === 'false') return false;
      this.connected = true;
      return true;
    }
    async checkAuthorization() {
      return this.connected ? true : never();
    }
    async destroy() {
      this.destroyed = true;
    }
    async getMe() {
      if (!this.connected) return never();
      return new Api.User({ id: 42, firstName: 'Me' });
    }
    async getDialogs(args) {
      return getDialogs ? getDialogs(this, args) : [];
    }
    async invoke(req) {
      if (!this.connected) return never();
      if (req instanceof Api.messages.GetDialogFilters) return { filters: [] };
      return { muteUntil: 0 };
    }
    addEventHandler() {}
    session = { save: () => session };
  }
  useTelegramClient(FakeClient);
  const handlers = new Map();
  t.after(async () => {
    await deactivate().catch(() => {});
    useTelegramClient(null);
    await rm(dataDir, { recursive: true, force: true });
  });
  await activate(
    {
      dataDir,
      config: { get: async () => ({ notify: false }) },
      ui: { notify: async () => {}, openExternal: async () => {} },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      tools: { register: () => {} },
      session: {},
    },
    { connectTimeoutMs: 80, retryMs, listTimeoutMs: 80 },
  );
  const call = (name, args = {}) => handlers.get(name)(args);
  const saved = async () => JSON.parse(await readFile(join(dataDir, 'account.json'), 'utf8'));
  return { clients, call, saved };
}

test('连接重试：有限次退避，用完后转低频探测', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => connectRetryDelay(n).delayMs), [2_000, 5_000, 15_000, 30_000, 60_000]);
  assert.deepEqual([1, 5].map((n) => connectRetryDelay(n).exhausted), [false, false]);
  assert.deepEqual(connectRetryDelay(6), { delayMs: 300_000, exhausted: true });
  assert.deepEqual(connectRetryDelay(99), { delayMs: 300_000, exhausted: true });
});

test('withTimeout：超时拒绝并带 TIMEOUT，按时完成则透传', async () => {
  await assert.rejects(withTimeout(never(), 10, '慢'), (e) => e.code === 'TIMEOUT' && e.message === '慢');
  assert.equal(await withTimeout(Promise.resolve(7), 10, '慢'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('原错')), 10, '慢'), /原错/);
});

test('冷启动时网络/代理没就绪（connect 返回 false）：不再永久 connecting，退避重试后自动恢复并能拉列表，不丢登录', async (t) => {
  const { clients, call, saved } = await setup(t, (i) => (i < 2 ? 'false' : 'ok'));
  // 旧实现在这里永远停在 connecting：checkAuthorization 等一个永远不会来的「已连接」
  const failed = await until(async () => {
    const s = await call('state');
    return s.status === 'offline' && !s.connecting && s;
  });
  assert.match(failed.error, /连不上 Telegram/);
  assert.ok(failed.retryAt > Date.now() - 50);
  assert.equal(failed.failures, 1);
  const ready = await until(async () => {
    const s = await call('state');
    return s.status === 'ready' && s;
  });
  assert.equal(ready.error, '');
  assert.equal(ready.failures, 0);
  assert.equal(ready.me.id, '42');
  assert.equal(clients.length, 3);
  // 失败的旧连接都释放了，正在用的没动
  assert.deepEqual(clients.map((c) => c.destroyed), [true, true, false]);
  assert.deepEqual((await call('dialogs')).items, []);
  assert.equal((await saved()).session, session);
});

test('connect 一直不返回：超时后显示失败原因与下次重试时间，释放连接', async (t) => {
  const { clients, call, saved } = await setup(t, () => 'hang');
  const s = await until(async () => {
    const v = await call('state');
    return v.status === 'offline' && !v.connecting && v;
  });
  assert.match(s.error, /连接超时/);
  assert.ok(s.retryAt > 0);
  assert.equal(clients[0].destroyed, true);
  // 数据接口给出明确原因，而不是「请先登录」或一直等
  await assert.rejects(call('dialogs'), /连接 Telegram 失败/);
  assert.equal((await saved()).session, session);
});

test('手动重试：清零退避立即重连', async (t) => {
  let up = false;
  // 第二次失败后要等 10 秒才自动重试，这里不等它
  const { call } = await setup(t, () => (up ? 'ok' : 'false'), { retryMs: [30, 10_000] });
  await until(async () => {
    const s = await call('state');
    return s.failures >= 2 && !s.connecting;
  });
  up = true;
  const r = await call('reconnect');
  assert.equal(r.status, 'ready');
  assert.equal(r.failures, 0);
});

test('停用时释放连接，之后不再自动重连', async (t) => {
  const { clients, call } = await setup(t, () => 'false');
  await until(async () => (await call('state')).status === 'offline');
  await deactivate();
  const n = clients.length;
  await sleep(200);
  assert.equal(clients.length, n);
  assert.ok(clients.every((c) => c.destroyed));
});

test('GetDialogs 卡住：列表请求超时报错且不占住串行锁，下次请求正常返回', async (t) => {
  let stuck = true;
  const { call } = await setup(t, () => 'ok', {
    getDialogs: () => (stuck ? never() : []),
  });
  await until(async () => (await call('state')).status === 'ready');
  await assert.rejects(call('dialogs'), /拉取会话列表超时/);
  stuck = false;
  assert.deepEqual((await call('dialogs')).items, []);
});
