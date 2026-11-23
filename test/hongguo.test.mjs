import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.hongguo/main.mjs';

const err = (code) => Object.assign(new Error(`sdk ${code}`), { code, retryable: false });

/** 假 SDK：每个方法按队列依次返回结果或抛错，记录 createClient 选项与 resetDevice 次数 */
async function setup(script) {
  const handlers = {};
  const state = { resets: 0, options: null, calls: {} };
  const next = (name) => {
    state.calls[name] = (state.calls[name] ?? 0) + 1;
    const queue = script[name] ?? [];
    const step = queue.length > 1 ? queue.shift() : queue[0];
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  const client = {
    discover: () => next('discover'),
    search: () => next('search'),
    getSeries: () => next('getSeries'),
    listEpisodes: () => next('listEpisodes'),
    resolvePlayback: () => next('resolvePlayback'),
    resetDevice: async () => void state.resets++,
  };
  const enso = {
    dataDir: await mkdtemp(join(tmpdir(), 'hg-')),
    renderer: { handle: (id, fn) => (handlers[id] = fn) },
  };
  activate(enso, { createClient: async (options) => ((state.options = options), client) });
  return { call: (id, args) => handlers[id](args, {}), state };
}

const page = { items: [{ id: 's1', title: '剧', cover_url: 'https://x/c', episode_count: 3 }], cursor: 'c2', has_more: true };

test('createClient 只传档案路径，换设备次数用 SDK 默认值', async () => {
  const { call, state } = await setup({ discover: [page] });
  await call('discover', {});
  assert.match(state.options.profile, /anonymous\.json$/);
  assert.equal('deviceResets' in state.options, false);
});

test('播放遇到设备被拒或空结果：交给 SDK，插件不再自己换设备', async () => {
  // SDK 自己会换设备（deviceResets 默认 2），插件这边只负责把错误码翻译成人话
  const wording = { DEVICE_REJECTED: /已换新设备仍/, ANONYMOUS_LIMITED: /限制了匿名访问/ };
  for (const code of ['DEVICE_REJECTED', 'ANONYMOUS_LIMITED']) {
    const { call, state } = await setup({ resolvePlayback: [err(code)] });
    await assert.rejects(call('open', { episodeId: 'e1' }), (e) => {
      assert.equal(e.code, code);
      assert.match(e.message, wording[code]);
      assert.doesNotMatch(e.message, /稍后再试/);
      return true;
    });
    assert.equal(state.resets, 0);
    assert.equal(state.calls.resolvePlayback, 1);
  }
});

test('选集设备被拒不重复换设备，空结果换设备后重试', async () => {
  const rejected = await setup({ listEpisodes: [err('DEVICE_REJECTED')] });
  await assert.rejects(rejected.call('episodes', { seriesId: 's1' }), /匿名设备被服务端拒绝/);
  assert.equal(rejected.state.resets, 0);

  const limited = await setup({ listEpisodes: [err('ANONYMOUS_LIMITED'), { items: [{ id: 'e1', number: 1, title: '第1集' }] }] });
  assert.deepEqual(await limited.call('episodes', { seriesId: 's1' }), [['e1', 1, 1]]);
  assert.equal(limited.state.resets, 1);
});

test('推荐空结果：换设备重试，仍为空时报错而不是当成看完了', async () => {
  const ok = await setup({ discover: [err('ANONYMOUS_LIMITED'), page] });
  const res = await ok.call('discover', {});
  assert.equal(res.items[0].id, 's1');
  assert.equal(ok.state.resets, 1);

  const bad = await setup({ discover: [err('ANONYMOUS_LIMITED')] });
  await assert.rejects(bad.call('discover', {}), (e) => e.code === 'ANONYMOUS_LIMITED' && !/稍后再试/.test(e.message));
  // 服务端按 IP 限流，连续换设备只会更快触发风控，所以只换一次
  assert.equal(bad.state.resets, 1);
  assert.equal(bad.state.calls.discover, 2);

  const end = await setup({ discover: [err('END_OF_LIST')] });
  assert.deepEqual(await end.call('discover', { cursor: 'c2' }), { items: [], hasMore: false });
});

test('搜索空结果当成没搜到，不换设备', async () => {
  const { call, state } = await setup({ search: [err('ANONYMOUS_LIMITED')] });
  assert.deepEqual(await call('search', { q: '总裁' }), { items: [], hasMore: false });
  assert.equal(state.resets, 0);
});

const sdkPath = new URL('../packages/enso.hongguo/node_modules/openhongguo/index.js', import.meta.url);
test('已安装的 openhongguo 提供插件用到的方法', { skip: !existsSync(sdkPath) && '未安装依赖' }, async () => {
  const { Client, createClient } = await import(sdkPath.href);
  assert.equal(typeof createClient, 'function');
  for (const m of ['discover', 'search', 'getSeries', 'listEpisodes', 'resolvePlayback', 'resetDevice'])
    assert.equal(typeof Client.prototype[m], 'function', m);
});
