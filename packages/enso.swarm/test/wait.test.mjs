// swarm_wait and the stall check, against AGY's semantics:
//   - mentionsOnly only decides what wakes you; the wake hands back every post
//     after since, so nothing addressed to nobody is lost on the way.
//   - a timeout never moves since; you have not read what came after it.
//   - "@name" counts when the characters around it are not ASCII name runes,
//     so Chinese text may touch it ("请@worker回答") and email stays out.
//   - "@shard" calls on every "shard-<n>", as in board/mentions.go.
//   - who wakes, the pane's "→ @name" chips and the pane's highlight agree.
//   - a [stall] post is not repeated within 15 minutes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'enso-swarm-wait-'));
const tools = new Map();
const methods = new Map();
const schedules = new Map();
const handlers = new Map();
const enso = {
  pluginId: 'enso.swarm',
  dataDir,
  tools: { register: (name, fn) => tools.set(name, fn) },
  renderer: { handle: (name, fn) => methods.set(name, fn) },
  schedules: { register: (id, fn) => schedules.set(id, fn) },
  commands: { register() {} },
  session: {
    inject: async () => {},
    list: async () => ({ sessions: [] }),
    status: async () => ({ state: 'idle' }),
    focusSubagent: async () => {},
    focus: async () => {},
    openChildRun: async () => {},
  },
  ui: { view: { emit() {}, open: async () => {}, close() {} }, notify() {} },
  fs: { readText: async () => '', writeText: async () => {} },
  config: { get: () => undefined },
  events: { on: (event, fn) => handlers.set(event, fn) },
};

const { activate, deactivate } = await import('../main.mjs');
await activate(enso);
test.after(() => {
  deactivate();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (name, args, ctx) => tools.get(name)(args, ctx);
const swarmDir = (lead) =>
  join(dataDir, 'state', 'brain', createHash('sha256').update(lead).digest('hex').slice(0, 32), '.system_generated', 'swarm');
const roster = (lead) => JSON.parse(readFileSync(join(swarmDir(lead), 'members.json'), 'utf8'));
const board = (lead) =>
  readFileSync(join(swarmDir(lead), 'board.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Opens a swarm led by `lead` with bound workers; returns each member's ctx. */
async function swarmWith(lead, names) {
  const ctx = { coordinator: { sessionId: lead } };
  await call('swarm', { action: 'open', title: lead }, ctx.coordinator);
  for (const name of names) {
    await call('swarm', { action: 'add', name, brief: `Brief for ${name}.` }, ctx.coordinator);
    ctx[name] = { sessionId: lead, agent: { kind: 'coworker', sessionId: `${lead}::cw-${name}`, name } };
    const bound = await call('swarm', { action: 'bind', key: roster(lead).members[name].key }, ctx[name]);
    assert.match(bound.content, new RegExp(`Bound as ${name}`));
  }
  return ctx;
}
const post = async (text, ctx) => {
  const out = await call('swarm_post', { text }, ctx);
  return Number(/#(\d+)/.exec(out.content)[1]);
};
const seqsIn = (content) => [...content.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));

const lead = 'wait-coordinator';
const crew = ['worker', 'receipts', 'shard-1', 'shard-2'];
const m = await swarmWith(lead, crew);

test('a mention wakes the waiter with every post after since, not just the mention', async () => {
  const since = board(lead).at(-1).seq;
  const result = await post('receipts: 3 of 4 files checked, nobody addressed', m.receipts);
  const ping = await post('@worker see the post above', m.coordinator);

  const out = await call('swarm_wait', { since, mentionsOnly: true, timeoutSec: 5 }, m.worker);
  assert.deepEqual(seqsIn(out.content), [result, ping], out.content);
});

test('a timeout keeps since where it was and says what is still unread', async () => {
  const since = board(lead).at(-1).seq;
  const first = await post('unaddressed progress note', m.receipts);
  const head = await post('another unaddressed note', m.coordinator);

  const out = await call('swarm_wait', { since, mentionsOnly: true, timeoutSec: 1 }, m.worker);
  assert.deepEqual(seqsIn(out.content), [], 'nothing addressed the waiter, so nothing is handed back');
  assert.ok(out.content.includes(`since:${since}`), out.content);
  assert.ok(!out.content.includes(`since:${head}`), `must not steer the waiter past #${first}: ${out.content}`);
  assert.ok(out.content.includes(`#${since}`), out.content);

  // Waiting again from the same since still finds the posts once someone calls.
  const ping = await post('@worker now it is for you', m.coordinator);
  const woke = await call('swarm_wait', { since, mentionsOnly: true, timeoutSec: 5 }, m.worker);
  assert.deepEqual(seqsIn(woke.content), [first, head, ping], woke.content);
});

test('a plain timeout with nothing new keeps since too', async () => {
  const since = board(lead).at(-1).seq;
  const out = await call('swarm_wait', { since, timeoutSec: 1 }, m.worker);
  assert.ok(out.content.includes(`since:${since}`), out.content);
});

/** Who actually wakes: every member waits, mentionsOnly, right before the post. */
async function woken(text) {
  const since = board(lead).at(-1).seq;
  const seq = await post(text, m.coordinator);
  const outs = await Promise.all(
    crew.map((name) => call('swarm_wait', { since, mentionsOnly: true, timeoutSec: 1 }, m[name]))
  );
  return { seq, names: crew.filter((_, i) => seqsIn(outs[i].content).length > 0) };
}

/** The "→ @name" chips: the pane's /api/swarm payload for that post. */
async function chips(seq) {
  const res = await methods.get('api')({ url: '/api/swarm?tail=200' }, m.coordinator);
  const msg = JSON.parse(res.text).messages.find((x) => x.seq === seq);
  assert.ok(msg, `the pane has #${seq}`);
  return (msg.all ? [...crew] : [...msg.mentions]).sort();
}

/**
 * The highlight: app.js's own MENTION_RE run over the escaped text, resolved
 * the way highlightMentions does (exact member, then "<prefix>" group, @all).
 */
const appJs = readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'swarm_board', 'app.js'), 'utf8');
const MENTION_RE = new Function(`return ${/const MENTION_RE = (\/.+\/[a-z]*);/.exec(appJs)[1]}`)();
function highlighted(text) {
  const esc = String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const out = new Set();
  for (const [, , name] of esc.matchAll(MENTION_RE)) {
    const lower = name.toLowerCase();
    if (lower === 'all') crew.forEach((n) => out.add(n));
    else if (crew.includes(lower)) out.add(lower);
    else crew.filter((n) => n.replace(/-\d+$/, '') === lower && n !== lower).forEach((n) => out.add(n));
  }
  return [...out].sort();
}

const CASES = [
  ['请@worker回答', ['worker']],
  ['@worker和@receipts一起看', ['receipts', 'worker']],
  ['@worker和@receipts', ['receipts', 'worker']],
  ['（@worker）', ['worker']],
  ['@worker，看一下', ['worker']],
  ['done @worker.', ['worker']],
  ['@WORKER: ping', ['worker']],
  ['@worker', ['worker']],
  ['mail foo@worker.com', []],
  ['@workers please', []],
  ['@worker-2 please', []],
  ['@worker_x please', []],
  ['请@shard看一下', ['shard-1', 'shard-2']],
  ['@shard-2 only', ['shard-2']],
  ['@shard-3 nobody', []],
  ['a@shard.io', []],
  ['请@all收尾', [...crew].sort()],
];

for (const [text, expected] of CASES) {
  test(`"${text}" calls on ${expected.join(', ') || 'nobody'}, the same in wake, chips and highlight`, async () => {
    const { seq, names } = await woken(text);
    assert.deepEqual([...names].sort(), expected, 'who wakes');
    assert.deepEqual(await chips(seq), expected, 'pane chips');
    assert.deepEqual(highlighted(text), expected, 'pane highlight');
  });
}

test('the stall check does not repeat itself within 15 minutes', async () => {
  const stalled = 'stall-coordinator';
  const s = await swarmWith(stalled, ['solo']);
  await post('solo: done with my part', s.solo);
  handlers.get('agent_end')({}, s.solo);

  // The board went quiet 11 minutes ago, which is what the check waits for.
  const age = () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const lines = board(stalled).map((msg) => JSON.stringify({ ...msg, time: old }));
    writeFileSync(join(swarmDir(stalled), 'board.jsonl'), `${lines.join('\n')}\n`);
  };
  const stalls = () => board(stalled).filter((msg) => msg.agent === 'monitor').length;

  age();
  await schedules.get('stall-check')();
  assert.equal(stalls(), 1, 'a quiet board with everyone waiting is a stall');
  assert.ok(Number.isFinite(roster(stalled).stall?.at), 'the nudge is recorded');

  age();
  await schedules.get('stall-check')();
  assert.equal(stalls(), 1, 'the same stall is not posted again inside 15 minutes');

  const r = roster(stalled);
  r.stall.at = Date.now() - 16 * 60 * 1000;
  writeFileSync(join(swarmDir(stalled), 'members.json'), JSON.stringify(r));
  age();
  await schedules.get('stall-check')();
  assert.equal(stalls(), 2, 'after 15 minutes it may nudge again');
});
