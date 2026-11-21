import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { ensureData } from '../packages/enso.fingerprint/data.mjs';
import {
  MAX_PARALLEL,
  activate,
  compareModel,
  createFingerprint,
  isEntryId,
  languageOf,
  probabilityNote,
  summarize,
} from '../packages/enso.fingerprint/main.mjs';
import { generateChallenges, parseNumbers } from '../packages/enso.fingerprint/vendor/lmfpd-sdk.mjs';

const dir = new URL('../packages/enso.fingerprint/', import.meta.url);
const LIVE = ['loading', 'answering', 'scoring'];

const ANALYSIS = {
  decision: 'scored',
  prediction: 'claude-opus-4.7',
  prediction_name: 'claude-opus-4.7',
  family_prediction: 'claude',
  family_prediction_name: 'Claude',
  probability: 0.97,
  probability_status: 'reference_calibrated',
  ranking_score: 3.5,
  results: Array.from({ length: 20 }, (_, i) => ({
    model: `m${i}`,
    display_name: `M${i}`,
    family: 'f',
    family_name: 'F',
    score: 3 - i * 0.1,
    probability: i === 0 ? 0.97 : 0.03 / 19,
  })),
  used_outputs: 3,
  diagnostics: [{ parsed_numbers: 300, minimum_numbers: 165, accepted: true, raw_out_of_range_count: 2 }],
  sequence: { autocorrelation: -0.4, small_step_share: 0.01, model_like: true },
  evidence: { label: 'Calibrated ranking', reason: 'ok' },
  method: 'shared-detector-v2',
  model_version: 'v',
};

const numbers = (n) => Array.from({ length: n }, (_, i) => ((i * 97) % 355) + 1).join(', ');

async function setup({ analysis = ANALYSIS, fetchData, dataDir } = {}) {
  const handlers = new Map();
  const emitted = [];
  const runs = [];
  const analyzed = [];
  let running = 0;
  let peak = 0;
  const enso = {
    dataDir: dataDir ?? (await mkdtemp(join(tmpdir(), 'fp-'))),
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    ui: { view: { emit: async (name, data) => emitted.push({ name, data }) } },
    net: { fetch: async () => ({ status: 500, headers: {}, body: '' }) },
    agent: {
      run: (input) => {
        running += 1;
        peak = Math.max(peak, running);
        return new Promise((resolve, reject) => {
          const entry = { input, settled: false };
          const done = (fn) => (value) => {
            if (entry.settled) return;
            entry.settled = true;
            running -= 1;
            fn(value);
          };
          entry.resolve = done(resolve);
          entry.reject = done(reject);
          input.signal.addEventListener('abort', () =>
            entry.reject(Object.assign(new Error('已取消'), { code: 'ABORTED' }))
          );
          runs.push(entry);
        });
      },
    },
  };
  const sdk = {
    generateChallenges,
    parseNumbers,
    loadDetector: async () => ({
      analyze: (outputs) => {
        analyzed.push(outputs);
        return typeof analysis === 'function' ? analysis(outputs) : analysis;
      },
    }),
  };
  const app = createFingerprint(enso, {
    sdk,
    fetchData: fetchData ?? (async ({ dir }) => ({ dir, meta: { builtAt: '2026-11-19T00:00:00Z', models: 75 } })),
  });
  const ctx = { sessionId: 's1' };
  const call = (name, args = {}, c = ctx) => app[name](args, c);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** 跟侧栏一样循环 wait，直到这一轮结束 */
  const follow = async (runId, c = ctx, each) => {
    let rev = -1;
    for (let i = 0; i < 50; i++) {
      const res = await app.wait({ runId, rev }, c);
      rev = res.rev;
      if (!LIVE.includes(res.status)) return res;
      await each?.();
    }
    throw new Error('wait 没有结束');
  };
  return { app, enso, handlers, emitted, runs, analyzed, call, follow, settle, peak: () => peak };
}

test('清单声明的方法都已注册，权限与域名齐全', async () => {
  const manifest = JSON.parse(await readFile(new URL('enso-plugin.json', dir), 'utf8'));
  const handlers = new Map();
  activate({ dataDir: tmpdir(), renderer: { handle: (n, f) => handlers.set(n, f) } });
  assert.deepEqual([...handlers.keys()].sort(), manifest.contributes.methods.map((m) => m.name).sort());
  for (const m of manifest.contributes.methods) assert.ok(m.timeoutMs >= 1000 && m.timeoutMs <= 120000);
  assert.deepEqual(manifest.permissions.sort(), ['agent.run', 'net.fetch', 'ui.view']);
  assert.deepEqual(manifest.net.domains, ['lm.ikale.io', 'cdn.jsdmirror.com']);
  assert.equal(manifest.engines.enso, '>=0.3.8');
});

test('出题：3 道、个数 292–332 且互不相同，识别题目语言', () => {
  for (let i = 0; i < 20; i++) {
    const list = generateChallenges(3);
    assert.equal(list.length, 3);
    assert.equal(new Set(list.map((c) => c.expected_count)).size, 3);
    for (const c of list) {
      assert.ok(c.expected_count >= 292 && c.expected_count <= 332);
      assert.ok(['中文', '英文', '日文', '韩文', '法文'].includes(languageOf(c.prompt)));
    }
  }
  assert.equal(languageOf('정수 300개를 고르세요'), '韩文');
  assert.equal(languageOf('整数を 300 個選んでください'), '日文');
  assert.equal(languageOf('逐项选择 300 个整数'), '中文');
  assert.equal(languageOf('Choisissez 300 entiers compris entre 1 et 355, bornes incluses'), '法文');
  assert.equal(languageOf('Pick 300 integers'), '英文');
});

test('评分结果映射：只留前 12 名，没有置信度时说明原因', () => {
  const s = summarize(ANALYSIS);
  assert.equal(s.predictionName, 'claude-opus-4.7');
  assert.equal(s.familyName, 'Claude');
  assert.equal(s.probability, 0.97);
  assert.equal(s.total, 20);
  assert.equal(s.candidates.length, 12);
  assert.deepEqual(s.diagnostics, [{ parsed: 300, minimum: 165, accepted: true, outOfRange: 2 }]);
  assert.deepEqual(s.sequence, { modelLike: true, autocorrelation: -0.4, smallStepShare: 0.01 });
  assert.equal(probabilityNote(s), null);
  assert.match(probabilityNote(summarize({ ...ANALYSIS, decision: 'partial', probability: null, used_outputs: 2 })), /2 条有效/);
  assert.match(probabilityNote(summarize({ decision: 'not_model', results: [] })), /不像语言模型/);
  assert.match(probabilityNote(summarize({ decision: 'unscorable' })), /没有有效回答/);
  assert.match(probabilityNote(summarize({ ...ANALYSIS, probability: null, probability_status: 'unavailable' })), /校准/);
  const empty = summarize({ decision: 'unscorable', prediction: '', results: [] });
  assert.equal(empty.prediction, null);
  assert.equal(empty.sequence, null);
});

test('实际模型与预测对照', () => {
  const s = summarize(ANALYSIS);
  assert.equal(compareModel('claude-opus-4.7', s), 'same');
  assert.equal(compareModel('anthropic/claude-opus-4-7', s), 'same');
  assert.equal(compareModel('claude-opus-4-7-20260101', s), 'same');
  assert.equal(compareModel('claude-sonnet-4-6', s), 'family');
  assert.equal(compareModel('gpt-6.2-sol', s), 'different');
  assert.equal(compareModel(null, s), 'unknown');
  assert.equal(compareModel('x', summarize({ decision: 'not_model' })), 'unknown');
});

test('排队：同时最多 2 个 agent.run，第三道题在侧栏的 wait 里派出，实时计数，评分后写入历史', async () => {
  const s = await setup();
  const { runId } = await s.call('start');
  assert.equal(s.runs.length, MAX_PARALLEL);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    s.emitted.at(-1).data.challenges.map((c) => c.status),
    ['running', 'running', 'queued']
  );
  for (const run of s.runs) {
    assert.equal(run.input.context, 'none');
    assert.equal(run.input.systemPrompt, undefined);
    assert.ok(run.input.timeoutMs >= 10_000);
  }
  s.runs[0].input.onEvent({ type: 'text', text: `好的：${numbers(42)}` });
  s.runs[0].input.onEvent({ type: 'tool-start', id: 't', name: 'ls', args: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const live = s.emitted.at(-1).data.challenges[0];
  assert.equal(live.count, 42);
  assert.equal(live.tools, 1);
  assert.equal(live.status, 'running');

  const expected = s.runs.map((r) => r.input.prompt);
  const done = s.follow(runId, undefined, async () => {
    const pending = s.runs.find((r) => !r.settled);
    if (pending) pending.resolve({ text: numbers(310), model: 'claude-opus-4-7' });
    await s.settle();
  });
  const res = await done;
  assert.equal(res.status, 'done');
  assert.equal(s.runs.length, 3);
  assert.equal(s.peak(), MAX_PARALLEL);
  assert.ok(expected.every((p) => s.runs.some((r) => r.input.prompt === p)));
  assert.equal(s.analyzed.length, 1);
  assert.equal(s.analyzed[0].length, 3);
  assert.ok(s.analyzed[0].every((o) => o.text && o.expected_count >= 292));

  const snap = await s.call('snapshot');
  assert.equal(snap.live, null);
  assert.equal(snap.history.length, 1);
  const entry = snap.history[0];
  assert.equal(entry.result.prediction, 'claude-opus-4.7');
  assert.deepEqual(entry.result.actualModels, ['claude-opus-4-7']);
  assert.equal(entry.result.match, 'same');
  assert.ok(entry.challenges.every((c) => c.status === 'done' && c.count === 310 && c.text));
  assert.deepEqual((await s.call('snapshot', {}, { sessionId: 's2' })).history, []);
});

test('虚拟模型会话：result.model 是条目 UUID，不当模型名展示，也不拿来对照', async () => {
  const uuid = '7b11a559-f632-4648-a52b-f0c2e536e19f';
  assert.ok(isEntryId(uuid));
  assert.ok(!isEntryId('claude-opus-4-7'));
  const s = await setup();
  const { runId } = await s.call('start');
  const res = await s.follow(runId, undefined, async () => {
    const pending = s.runs.find((r) => !r.settled);
    if (pending) pending.resolve({ text: numbers(310), model: uuid });
    await s.settle();
  });
  assert.equal(res.status, 'done');
  const entry = (await s.call('snapshot')).history[0];
  assert.deepEqual(entry.result.actualModels, []);
  assert.equal(entry.result.modelHidden, true);
  assert.equal(entry.result.match, 'unknown');
  assert.ok(entry.challenges.every((c) => c.model === null && c.modelHidden));
  assert.ok(!JSON.stringify(entry).includes(uuid));
});

test('旧历史里存成模型名的条目 UUID，读出时清掉', async () => {
  const uuid = '7b11a559-f632-4648-a52b-f0c2e536e19f';
  const dataDir = await mkdtemp(join(tmpdir(), 'fp-'));
  const legacy = {
    id: 'old',
    status: 'done',
    challenges: [{ index: 0, status: 'done', model: uuid }],
    result: { prediction: 'claude-opus-4.7', actualModels: [uuid], match: 'different' },
  };
  await writeFile(join(dataDir, 'history.json'), JSON.stringify({ s1: [legacy] }));
  const s = await setup({ dataDir });
  const [entry] = (await s.call('snapshot')).history;
  assert.deepEqual(entry.result.actualModels, []);
  assert.equal(entry.result.match, 'unknown');
  assert.equal(entry.result.modelHidden, true);
  assert.equal(entry.challenges[0].model, null);
});

test('同会话重复点开始复用进行中的一轮；没有会话时报错', async () => {
  const s = await setup();
  const first = await s.call('start');
  assert.deepEqual(await s.call('start'), first);
  assert.equal(s.runs.length, 2);
  await assert.rejects(s.call('start', {}, { sessionId: null }), (e) => e.code === 'NO_SESSION');
});

test('取消：中止进行中的回答，排队的不再派出，这一轮不评分', async () => {
  const s = await setup();
  const { runId } = await s.call('start');
  await s.call('cancel', { runId });
  const res = await s.follow(runId);
  assert.equal(res.status, 'cancelled');
  await s.settle();
  assert.equal(s.runs.length, 2);
  assert.ok(s.runs.every((r) => r.settled));
  assert.equal(s.analyzed.length, 0);
  const entry = (await s.call('snapshot')).history[0];
  assert.equal(entry.status, 'cancelled');
  assert.ok(entry.challenges.every((c) => c.status === 'cancelled'));
  assert.equal(entry.result, null);
});

test('一道题失败时用其余两道评分；全部失败报错', async () => {
  const partial = { ...ANALYSIS, decision: 'partial', probability: null, used_outputs: 2 };
  const s = await setup({ analysis: partial });
  const { runId } = await s.call('start');
  s.runs[0].reject(Object.assign(new Error('模型出错'), { code: 'AGENT_FAILED' }));
  const res = await s.follow(runId, undefined, async () => {
    const pending = s.runs.find((r) => !r.settled);
    if (pending) pending.resolve({ text: numbers(300), model: 'gpt-6' });
    await s.settle();
  });
  assert.equal(res.status, 'done');
  assert.equal(s.analyzed[0].length, 2);
  const entry = (await s.call('snapshot')).history[0];
  assert.equal(entry.challenges[0].status, 'error');
  assert.equal(entry.challenges[0].error, '模型出错');
  assert.match(entry.result.note, /2 条有效/);
  assert.equal(entry.result.match, 'different');

  const t = await setup();
  const second = await t.call('start');
  const fail = await t.follow(second.runId, undefined, async () => {
    const pending = t.runs.find((r) => !r.settled);
    if (pending) pending.reject(Object.assign(new Error('没有回复'), { code: 'AGENT_FAILED' }));
    await t.settle();
  });
  assert.equal(fail.status, 'error');
  assert.equal(t.analyzed.length, 0);
  assert.match((await t.call('snapshot')).history[0].error, /没有拿到回答：没有回复/);
});

test('回答写到要求个数 1.5 倍还不停：中止这道题，用已收到的文本评分', async () => {
  const s = await setup();
  const { runId } = await s.call('start');
  const runaway = s.runs[0];
  runaway.input.onEvent({ type: 'text', text: numbers(600) });
  assert.ok(runaway.settled);
  const res = await s.follow(runId, undefined, async () => {
    const pending = s.runs.find((r) => !r.settled);
    if (pending) pending.resolve({ text: numbers(300), model: 'glm-5.3' });
    await s.settle();
  });
  assert.equal(res.status, 'done');
  assert.equal(s.analyzed[0].length, 3);
  const entry = (await s.call('snapshot')).history[0];
  assert.equal(entry.challenges[0].status, 'done');
  assert.equal(entry.challenges[0].truncated, true);
  assert.equal(entry.challenges[0].count, 600);
  assert.deepEqual(entry.result.actualModels, ['glm-5.3']);
});

test('宿主报 RATE_LIMITED 时放回队列稍后重发', async () => {
  const s = await setup();
  const { runId } = await s.call('start');
  s.runs[0].reject(Object.assign(new Error('太多'), { code: 'RATE_LIMITED' }));
  await s.settle();
  const res = await s.follow(runId, undefined, async () => {
    const pending = s.runs.find((r) => !r.settled);
    if (pending) pending.resolve({ text: numbers(300), model: 'm' });
    await s.settle();
  });
  assert.equal(res.status, 'done');
  assert.equal(s.runs.length, 4);
  assert.equal(s.analyzed[0].length, 3);
});

test('参考数据加载失败：不调用模型，直接报错', async () => {
  const s = await setup({
    fetchData: async () => {
      throw Object.assign(new Error('参考数据下载失败：x'), { code: 'DATA_UNAVAILABLE' });
    },
  });
  const { runId } = await s.call('start');
  const res = await s.follow(runId);
  assert.equal(res.status, 'error');
  assert.equal(s.runs.length, 0);
  assert.match((await s.call('snapshot')).history[0].error, /下载失败/);
});

test('历史每个会话保留最近 5 次，重启后仍在', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fp-'));
  const s = await setup({ dataDir });
  for (let i = 0; i < 7; i++) {
    const { runId } = await s.call('start');
    await s.call('cancel', { runId });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await s.call('snapshot')).history.length, 5);
  const again = await setup({ dataDir });
  assert.equal((await again.call('snapshot')).history.length, 5);
});

function fakeSource(raw, { sha } = {}) {
  const compressed = zstdCompressSync(raw);
  const half = Math.ceil(compressed.length / 2);
  const parts = { 'd.0.zst': compressed.subarray(0, half), 'd.1.zst': compressed.subarray(half) };
  const bundle = JSON.stringify({
    schema: 'lmfpd-data-v1',
    detector_schema: 'shared-detector-v2',
    built_at: '2026-11-19T05:26:09Z',
    models: [{ id: 'a' }, { id: 'b' }],
    files: {
      'shared_detector.bin': {
        parts: Object.keys(parts),
        bytes: compressed.length,
        sha256: sha ?? createHash('sha256').update(raw).digest('hex'),
      },
    },
  });
  return { bundle, parts };
}

function fakeFetch(sources, log) {
  return async (url, init = {}) => {
    log.push(url);
    for (const [base, src] of Object.entries(sources)) {
      if (!url.startsWith(base)) continue;
      if (!src) return { status: 503, headers: {}, body: '' };
      if (url.endsWith('bundle.json')) return { status: 200, headers: {}, body: src.bundle };
      const part = src.parts[url.slice(url.lastIndexOf('/') + 1)];
      assert.equal(init.responseType, 'base64');
      return { status: 200, headers: {}, body: Buffer.from(part).toString('base64') };
    }
    return { status: 404, headers: {}, body: '' };
  };
}

test('参考数据：经 net.fetch 分块下载、解压、校验，写成 SDK 的本地目录', async () => {
  const raw = Buffer.from('detector-bytes'.repeat(1000));
  const target = join(await mkdtemp(join(tmpdir(), 'fp-')), 'lmfpd');
  const log = [];
  const good = fakeSource(raw);
  const bad = fakeSource(raw, { sha: 'f'.repeat(64) });
  const sources = ['https://a.test/', 'https://b.test/'];
  let clock = 1000;
  const progress = [];
  const first = await ensureData({
    dir: target,
    fetch: fakeFetch({ 'https://a.test/': bad, 'https://b.test/': good }, log),
    sources,
    now: () => clock,
    onProgress: (p) => progress.push(p.phase),
  });
  assert.equal(first.fresh, true);
  assert.equal(first.meta.source, 'https://b.test/');
  assert.equal(first.meta.models, 2);
  assert.ok(progress.includes('download'));
  assert.deepEqual(await readFile(join(target, 'shared_detector.bin')), raw);
  assert.equal(await readFile(join(target, 'unified_bank.json'), 'utf8'), good.bundle);

  // 缓存新鲜：不联网
  log.length = 0;
  const cached = await ensureData({ dir: target, fetch: fakeFetch({}, log), sources, now: () => clock });
  assert.equal(cached.fresh, false);
  assert.deepEqual(log, []);

  // 过期：立即用缓存，后台只取 bundle.json（版本没变）
  clock += 25 * 3600_000;
  let task;
  const stale = await ensureData({
    dir: target,
    fetch: fakeFetch({ 'https://a.test/': good }, log),
    sources,
    now: () => clock,
    background: (p) => (task = p),
  });
  assert.equal(stale.fresh, false);
  await task;
  assert.deepEqual(log, ['https://a.test/bundle.json']);
  assert.equal(JSON.parse(await readFile(join(target, 'meta.json'), 'utf8')).checkedAt, clock);
});

test('参考数据：所有来源都失败且没有缓存时报 DATA_UNAVAILABLE', async () => {
  const target = join(await mkdtemp(join(tmpdir(), 'fp-')), 'lmfpd');
  await assert.rejects(
    ensureData({ dir: target, fetch: fakeFetch({ 'https://a.test/': null }, []), sources: ['https://a.test/', 'https://c.test/'] }),
    (e) => e.code === 'DATA_UNAVAILABLE' && /a\.test.*HTTP 503.*c\.test.*HTTP 404/.test(e.message)
  );
  const schema = { bundle: JSON.stringify({ schema: 'lmfpd-data-v9', detector_schema: 'x' }), parts: {} };
  await assert.rejects(
    ensureData({ dir: target, fetch: fakeFetch({ 'https://a.test/': schema }, []), sources: ['https://a.test/'] }),
    /不受支持/
  );
});
