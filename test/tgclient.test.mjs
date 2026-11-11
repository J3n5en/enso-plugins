import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, deactivate, keywordHit, normalizeKeywords, parseProxy, planWatchRetry, watchDelayMs } from '../packages/enso.tgclient/main.mjs';

test('解析代理', () => {
  assert.equal(parseProxy(''), undefined);
  assert.deepEqual(parseProxy('socks5://127.0.0.1:7890'), { ip: '127.0.0.1', port: 7890, socksType: 5 });
  assert.deepEqual(parseProxy('socks5://u:p%40@h:1'), { ip: 'h', port: 1, socksType: 5, username: 'u', password: 'p@' });
  assert.deepEqual(parseProxy('tg://proxy?server=a.b&port=443&secret=ee00'), { ip: 'a.b', port: 443, secret: 'ee00', MTProxy: true });
  assert.deepEqual(parseProxy('https://t.me/proxy?server=a.b&port=443&secret=dd11'), { ip: 'a.b', port: 443, secret: 'dd11', MTProxy: true });
  assert.throws(() => parseProxy('http://127.0.0.1:8080'));
});

test('投递失败时保留订阅并退避重试', () => {
  const denied = Object.assign(new Error('permission'), { code: 'PERMISSION_DENIED' });
  const first = planWatchRetry(denied, {});
  assert.equal(first.notify, 'permission');
  assert.equal(first.delayMs, 300_000);
  assert.match(first.error, /授权后补投/);
  assert.equal(planWatchRetry(denied, { warned: true }).notify, null);

  const rate = planWatchRetry(Object.assign(new Error('flood'), { code: 'RATE_LIMITED' }), { failures: 3 });
  assert.equal(rate.delayMs, 5_000);
  assert.equal(rate.failures, 3);
  assert.equal(rate.notify, null);

  // 会话没在跑 / 注入失败：从 5 秒指数退避到 5 分钟封顶，连续 5 次才提醒一次
  const failed = () => Object.assign(new Error('会话没在运行'), { code: 'INJECT_FAILED' });
  const state = {};
  const plans = [];
  for (let i = 0; i < 8; i++) {
    const plan = planWatchRetry(failed(), state);
    plans.push(plan);
    Object.assign(state, { failures: plan.failures, ...(plan.notify === 'failed' ? { failNotified: true } : {}) });
  }
  assert.deepEqual(plans.map((p) => p.delayMs), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.deepEqual(plans.map((p) => p.failures), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plans.map((p) => p.notify), [null, null, null, null, 'failed', null, null, null]);
  assert.equal(planWatchRetry(failed(), { failures: 5, failNotified: true }).notify, null);
  assert.match(plans[0].error, /INJECT_FAILED 会话没在运行/);
});

test('订阅可设安静期与最小投递间隔', () => {
  // 默认安静 3 秒
  assert.equal(watchDelayMs({}, 0), 3_000);
  assert.equal(watchDelayMs({ debounceSec: 30 }, 0), 30_000);
  // 最小间隔没到：等到间隔满
  assert.equal(watchDelayMs({ minIntervalSec: 60, lastAt: 1_000 }, 11_000), 50_000);
  // 安静期比剩余间隔更晚时以安静期为准
  assert.equal(watchDelayMs({ debounceSec: 90, minIntervalSec: 60, lastAt: 1_000 }, 1_000), 90_000);
  // 间隔已过，只等安静期
  assert.equal(watchDelayMs({ minIntervalSec: 60, lastAt: 1_000 }, 121_000), 3_000);
  // 越界收敛：安静期封顶 1 小时，最小间隔封顶 24 小时
  assert.equal(watchDelayMs({ debounceSec: 9_999 }, 0), 3_600_000);
  assert.equal(watchDelayMs({ debounceSec: 0 }, 0), 1_000);
  assert.equal(watchDelayMs({ minIntervalSec: 1e9, lastAt: 1_000 }, 1_000), 86_400_000);
  assert.equal(watchDelayMs({ minIntervalSec: 1_800, lastAt: 1_000 }, 1_000), 1_800_000);
});

test('未登录时停在登录页，校验参数，轮询立即返回状态', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tgclient-'));
  const handlers = new Map();
  const tools = new Map();
  const enso = {
    tools: { register: (name, fn) => tools.set(name, fn) },
    dataDir,
    config: { get: async () => ({}) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    ui: { notify: async () => {}, openExternal: async () => {} },
  };
  try {
    await activate(enso);
    const st = await handlers.get('state')({});
    assert.equal(st.status, 'setup');
    await assert.rejects(handlers.get('login')({ phone: 'abc' }), /手机号/);
    await assert.rejects(handlers.get('dialogs')({}), /请先登录/);
    for (const m of ['edit', 'react', 'reactionList', 'press', 'stickers', 'stickerThumbs', 'sendSticker', 'readers', 'sendAs', 'setSendAs', 'topics'])
      await assert.rejects(handlers.get(m)({ chat: '1', id: 1 }), /请先登录/);
    const r = await handlers.get('poll')({ cursor: 0 });
    assert.equal(r.status, 'setup');
    assert.ok(r.events.some((e) => e.type === 'status'));
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 64 * 1024);
    await assert.rejects(handlers.get('open')({ url: 'file:///etc/passwd' }));
    const manifest = JSON.parse(await readFile(new URL('../packages/enso.tgclient/enso-plugin.json', import.meta.url), 'utf8'));
    assert.deepEqual([...tools.keys()].sort(), manifest.contributes.agentTools.map((t) => t.name).sort());
    for (const [name, fn] of tools) if (name !== 'tg_unwatch') await assert.rejects(fn({ chat: 'me', query: 'x', text: 'x' }), /请先登录/);
    assert.deepEqual(await tools.get('tg_unwatch')({}, { sessionId: 's1' }), { ok: true, watching: null });
  } finally {
    await deactivate();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('关键词过滤：整理关键词', () => {
  assert.equal(normalizeKeywords(undefined), undefined);
  assert.equal(normalizeKeywords([' ', '']), undefined);
  assert.deepEqual(normalizeKeywords([' EnsoCode ', 'ensocode', 'Bug', 3]), ['EnsoCode', 'Bug', '3']);
  assert.equal(normalizeKeywords(Array.from({ length: 50 }, (_, i) => `k${i}`)).length, 20);
});

test('关键词过滤：命中关键词或被提及', () => {
  const kw = ['EnsoCode', 'bug'];
  assert.equal(keywordHit({ message: '新版 ensocode 好用' }, kw), true);
  assert.equal(keywordHit({ message: '发现个 BUG' }, kw), true);
  assert.equal(keywordHit({ message: '英伟达新芯片' }, kw), false);
  assert.equal(keywordHit({ message: '你看下这个', mentioned: true }, kw), true);
  assert.equal(keywordHit({ message: undefined }, kw), false);
  assert.equal(keywordHit({ message: '随便聊' }, undefined), true);
});
