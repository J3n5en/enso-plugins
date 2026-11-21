import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = await readFile(new URL('../packages/enso.tgclient/view.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 宽松的假 DOM：没模拟的属性都当成空操作，只记录 innerHTML / hidden，够检查侧栏显示了什么
function fakeNode(id = '') {
  const classes = new Set();
  const node = {
    id,
    innerHTML: '',
    hidden: false,
    dataset: {},
    style: {},
    value: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on) },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return new Proxy(node, {
    get: (t, k) => (k in t || typeof k === 'symbol' ? t[k] : () => fakeNode()),
    set: (t, k, v) => ((t[k] = v), true),
  });
}

const running = new Set();
test.afterEach(() => {
  for (const app of running) app.stop();
  running.clear();
});

function boot(call) {
  let stopped = false;
  const nodes = new Map();
  const byId = (id) => nodes.get(id) ?? nodes.set(id, fakeNode(id)).get(id);
  const document = fakeNode('document');
  Object.assign(document, {
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeNode(),
    body: fakeNode('body'),
    documentElement: fakeNode('html'),
    visibilityState: 'visible',
    hasFocus: () => true,
  });
  const mem = new Map();
  const ctx = {
    document,
    localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
    ensoUI: { tooltip() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    // 侧栏里的等待一律缩到 5ms，测试不用真等几秒
    setTimeout: (fn, ms) => (stopped ? 0 : setTimeout(fn, Math.min(ms ?? 0, 5))),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: { userAgent: 'test' },
    console,
  };
  ctx.window = ctx;
  ctx.window.enso = { call: (...a) => (stopped ? new Promise(() => {}) : call(...a)) };
  createContext(ctx);
  runInContext(script, ctx);
  const app = { $: byId, stop: () => (stopped = true) };
  running.add(app);
  return app;
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await sleep(5);
  }
}

const base = { me: null, phone: '', hint: '', codeVia: '', error: '', connecting: false, retryAt: 0, failures: 0, cursor: 0 };
// poll 没有新状态时挂起，模拟 25 秒长轮询，避免测试里空转
const idle = () => new Promise(() => {});

test('侧栏比后端先起来：第一次 state 失败后自动重试，连接超时显示失败原因和重试按钮而不是一直转圈', async () => {
  let n = 0;
  const calls = [];
  const { $ } = boot(async (method) => {
    calls.push(method);
    if (method === 'state') {
      if (++n === 1) throw new Error('插件还没启动');
      return { ...base, status: 'offline', error: '连接超时（30 秒没有响应）', retryAt: Date.now() + 60_000, failures: 2 };
    }
    if (method === 'poll') return idle();
    if (method === 'reconnect') return { ...base, status: 'offline', connecting: true, failures: 0 };
    throw new Error(`未预期的调用 ${method}`);
  });
  const auth = await until(() => /连接 Telegram 失败/.test($('auth').innerHTML) && $('auth').innerHTML);
  assert.equal(n, 2);
  assert.match(auth, /连接超时（30 秒没有响应）/);
  assert.match(auth, /自动重试/);
  assert.match(auth, /data-act="reconnect"/);
  assert.doesNotMatch(auth, /ui-spin/);
  assert.ok(calls.includes('poll'));
});

test('正在重连时显示转圈和上次失败原因', async () => {
  const { $ } = boot(async (method) => {
    if (method === 'state') return { ...base, status: 'connecting', connecting: true, error: '连不上 Telegram 服务器，请检查网络或代理', failures: 1 };
    if (method === 'poll') return idle();
    throw new Error(method);
  });
  const auth = await until(() => /正在连接 Telegram/.test($('auth').innerHTML) && $('auth').innerHTML);
  assert.match(auth, /ui-spin/);
  assert.match(auth, /第 2 次尝试/);
  assert.match(auth, /上次失败：连不上 Telegram 服务器/);
});

test('会话列表首次请求失败（后端还在拉取 / 超时）后退避自动重试，成功后显示列表', async () => {
  let tries = 0;
  const me = { id: '42', name: 'Me', phone: '', username: '', photo: false, premium: false };
  const { $ } = boot(async (method) => {
    if (method === 'state') return { ...base, status: 'ready', me };
    if (method === 'poll') return idle();
    if (method === 'watches') return { items: [] };
    if (method === 'dialogs') {
      if (++tries === 1) throw new Error('拉取会话列表超时，请检查网络');
      return { items: [{ id: '7', title: '测试群', kind: 'group', unread: 0, mentions: 0, date: 1_700_000_000, last: 'hi' }], more: false, folders: [] };
    }
    if (method === 'avatars') return { items: [] };
    throw new Error(method);
  });
  await until(() => /测试群/.test($('dialogs').innerHTML));
  assert.equal(tries, 2);
});

test('会话列表连续失败：自动重试有上限，最后显示原因和重试按钮', async () => {
  let tries = 0;
  const me = { id: '42', name: 'Me', phone: '', username: '', photo: false, premium: false };
  const { $ } = boot(async (method) => {
    if (method === 'state') return { ...base, status: 'ready', me };
    if (method === 'poll') return idle();
    if (method === 'watches') return { items: [] };
    if (method === 'dialogs') {
      tries++;
      throw new Error('拉取会话列表超时，请检查网络');
    }
    throw new Error(method);
  });
  await until(() => tries === 4 && /加载会话列表失败：拉取会话列表超时/.test($('dialogs').innerHTML) && !/秒后自动重试/.test($('dialogs').innerHTML));
  await sleep(100);
  assert.equal(tries, 4);
  assert.match($('dialogs').innerHTML, /data-act="dialogs"/);
});
