// Drives the plugin's tools against a fake host, then asks AGY's own pane API
// what it sees. That second half is the alignment check: if the pane payload
// has the posts and members we wrote, the board format matches AGY's.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'enso-swarm-'));
const tools = new Map();
const methods = new Map();
const schedules = new Map();
const handlers = new Map();
const focusCalls = [];
/** Sessions the fake renderer still has a tab for; anything else is NOT_FOUND. */
const liveSessions = new Set();

const enso = {
  pluginId: 'enso.swarm',
  dataDir,
  tools: { register: (name, fn) => tools.set(name, fn) },
  renderer: { handle: (name, fn) => methods.set(name, fn) },
  schedules: { register: (id, fn) => schedules.set(id, fn) },
  commands: { register: (id, fn) => methods.set(`command:${id}`, fn) },
  session: {
    inject: async () => {},
    list: async () => ({ sessions: [] }),
    status: async () => ({ state: 'idle' }),
    focusSubagent: async (sessionId, agentId) =>
      void focusCalls.push(['focusSubagent', sessionId, agentId]),
    // The host rejects session.focus with NOT_FOUND when the发起窗口 has no such
    // conversation — that is the only observable verdict a click has.
    focus: async (id) => {
      if (!liveSessions.has(id)) {
        const error = new Error('会话不在本窗口');
        error.code = 'NOT_FOUND';
        throw error;
      }
      focusCalls.push(['focus', id]);
    },
    openChildRun: async (parentId, childId) => void focusCalls.push(['openChildRun', parentId, childId]),
  },
  ui: { view: { emit() {}, open: async () => {}, close() {} }, notify() {} },
  fs: { readText: async () => '', writeText: async () => {} },
  config: { get: () => undefined },
  events: { on: (event, fn) => handlers.set(event, fn) },
};

const { activate, deactivate } = await import('../main.mjs');
await activate(enso);

const coordinator = 'conv-coordinator-0001';
const call = (name, args, ctx = { sessionId: coordinator }) => tools.get(name)(args, ctx);
const fire = (event, data, child) => handlers.get(event)(data, { sessionId: coordinator, agent: child });
const api = (url) => methods.get('api')({ url }, { sessionId: coordinator });
const snapshot = async () => JSON.parse((await api('/api/swarm')).text);

const swarmRoot = () => {
  const brain = join(dataDir, 'state', 'brain');
  for (const entry of readdirSync(brain)) {
    const dir = join(brain, entry, '.system_generated', 'swarm');
    if (existsSync(join(dir, 'members.json'))) return dir;
  }
  throw new Error('no swarm dir');
};
const members = () => JSON.parse(readFileSync(join(swarmRoot(), 'members.json'), 'utf8'));
const boardLines = () =>
  readFileSync(join(swarmRoot(), 'board.jsonl'), 'utf8').split('\n').filter(Boolean);

test('open creates a swarm the pane can read', async () => {
  const opened = await call('swarm', { action: 'open', title: 'parser rewrite' });
  assert.match(opened.content, /Opened/);

  const snap = await snapshot();
  assert.ok(snap.swarm, 'the pane resolved the swarm');
  assert.equal(snap.members.length, 1);
  assert.equal(snap.members[0].role, 'coordinator');
  assert.equal(snap.messages.length, 0);
});

test('add posts the brief and hands back a spawn with a bind key', async () => {
  const added = await call('swarm', { action: 'add', name: 'parser', brief: 'Rewrite the parser. Touch only src/parser/.' });
  assert.match(added.content, /agent_type="swarm:worker"/);
  assert.match(added.content, /swarm\{action:"bind", key:"[0-9a-f]{8}"\}/);

  const snap = await snapshot();
  assert.equal(snap.members.length, 2);
  const parser = snap.members.find((m) => m.name === 'parser');
  assert.equal(parser.role, 'worker');
  assert.equal(parser.status, 'waiting');
  assert.deepEqual(snap.messages[0].mentions, ['parser']);
  assert.equal(members().members.parser.key.length, 8);
});

test('an unbound session is told to bind, and bind makes it a member', async () => {
  const worker = { sessionId: 'coworker-session-abc' };
  await assert.rejects(() => call('swarm_post', { text: 'hello' }, worker), /swarm\{action:"bind"/);

  const bound = await call('swarm', { action: 'bind', key: members().members.parser.key }, worker);
  assert.match(bound.content, /Bound as parser/);

  const posted = await call('swarm_post', { text: '@coordinator done: 42 tests pass' }, worker);
  assert.match(posted.content, /Posted as parser/);
  assert.equal(members().members.parser.session_id, 'coworker-session-abc');

  const snap = await snapshot();
  const parser = snap.members.find((m) => m.name === 'parser');
  assert.equal(parser.status, 'working');
  assert.ok(parser.conversation_id, 'binding gives the pane a conversation to read');
});

test('a coworker that shares the coordinator session id still posts as itself', async () => {
  // The real shape: ctx.sessionId is the session that spawned the worker, and
  // only ctx.agent.sessionId (a <main>::cw-… id) tells the members apart.
  await call('swarm', { action: 'add', name: 'ipc', brief: 'List the IPC channels.' });
  const child = {
    sessionId: coordinator,
    agent: { kind: 'coworker', sessionId: `${coordinator}::cw-1`, name: 'ipc' },
  };
  const bound = await call('swarm', { action: 'bind', key: members().members.ipc.key }, child);
  assert.match(bound.content, /Bound as ipc/, bound.content);

  const posted = await call('swarm_post', { text: '@coordinator ipc reporting' }, child);
  assert.match(posted.content, /Posted as ipc/, 'not as the coordinator');

  const snap = await snapshot();
  assert.ok(snap.messages.some((m) => m.agent === 'ipc' && /ipc reporting/.test(m.text)));
  assert.equal(snap.members.find((m) => m.name === 'ipc').status, 'working');
});

test('swarm_wait returns new posts and honours since', async () => {
  const out = await call('swarm_wait', { since: 1, timeoutSec: 1 }, { sessionId: 'coworker-session-abc' });
  assert.match(out.content, /#2 parser/, out.content);
});

test('status shows binding state and what each member is doing', async () => {
  await call('swarm', { action: 'add', name: 'verifier', role: 'worker', brief: 'Review the parser.' });
  const out = await call('swarm', { action: 'status' });
  assert.match(out.content, /parser\tworker\twaiting\t1 posts/, 'a worker asleep on swarm_wait reads waiting');
  assert.match(out.content, /verifier\tworker\tunbound/, 'a worker that never bound says so');
  assert.match(out.content, /coordinator\tcoordinator/);
});

test('swarm_plan writes the plan the Overview is drawn from', async () => {
  const plan = { goal: { title: 'Parser rewrite', line: 'Audit, fix, verify.' }, tasks: { parser: 'Rewrite it' }, threads: [] };
  const out = await call('swarm_plan', { plan });
  assert.match(out.content, /plan\.json/);
  assert.deepEqual(JSON.parse(readFileSync(join(swarmRoot(), 'plan.json'), 'utf8')), plan);
});

test('a lull right after posting is not a stall', async () => {
  await schedules.get('stall-check')();
  const snap = await snapshot();
  assert.ok(!snap.messages.some((m) => m.agent === 'monitor'), 'no monitor nudge on a fresh board');
  assert.ok(!existsSync(join(dataDir, 'state', 'brain', '.stalled')), 'no side effects');
});

test('raw route matches AGY shapes', async () => {
  const raw = JSON.parse((await api('/api/swarm/raw')).text);
  assert.ok(raw.raw.board.includes('@parser'));
  assert.ok(raw.raw.members.includes('"members"'));
});

test.after(() => {
  deactivate();
  rmSync(dataDir, { recursive: true, force: true });
});

test('a title passed to an already-open swarm is actually written', async () => {
  const renamed = await call('swarm', { action: 'open', title: 'Attribution Retest' });
  assert.match(renamed.content, /Already open, retitled: swarm .* \("Attribution Retest"\)/);
  assert.equal(members().title, 'Attribution Retest');

  const again = await call('swarm', { action: 'open', title: 'Attribution Retest' });
  assert.match(again.content, /Already open: swarm .* \("Attribution Retest"\)/);

  const untitled = await call('swarm', { action: 'open' });
  assert.match(untitled.content, /\("Attribution Retest"\)/, 'reports the board title, not an empty one');
  assert.equal(members().title, 'Attribution Retest', 'no title argument never clears the title');
});

test('a dismissed worker stops reading as working', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-gone`, name: 'ipc' };
  // The same member from the previous test, now bound to this child session.
  await call('swarm', { action: 'add', name: 'stub', brief: 'Stub.' });
  await call('swarm', { action: 'bind', key: members().members.stub.key }, child);
  await call('swarm_post', { text: 'stub reporting' }, child);
  const working = await call('swarm', { action: 'status' });
  assert.match(working.content, /stub\tworker\tworking\t1 posts/, 'touching the board reads as working');

  fire('session_end', { reason: 'dismissed' }, child);
  const gone = await call('swarm', { action: 'status' });
  assert.match(gone.content, /stub\tworker\tgone \(dismissed\)\t1 posts/);
  assert.equal(members().members.stub.killed, true);
  const killedInPane = (await snapshot()).members.find((m) => m.name === 'stub');
  assert.equal(killedInPane.status, 'killed', 'the pane stops claiming it is active');

  fire('session_start', { reason: 'resume' }, child);
  const back = await call('swarm', { action: 'status' });
  assert.doesNotMatch(back.content, /gone \(/);
  assert.equal(members().members.stub.killed, undefined, 'a resumed coworker may work again');
});

test('a kill records its reason, reads as gone (killed), and stays dead', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-dead`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'dead', brief: 'Doomed.' });
  await call('swarm', { action: 'bind', key: members().members.dead.key }, child);
  const before = boardLines().length;
  await call('swarm', { action: 'kill', name: 'dead' });

  assert.equal(members().members.dead.killed, true);
  assert.equal(members().members.dead.killed_reason, 'killed', 'kill is symmetric with dismiss');
  assert.equal(boardLines().length, before, 'killing does not pad the board');
  // A kill does not stop the process, so the row must not imply it did.
  assert.match(
    (await call('swarm', { action: 'status' })).content,
    /dead\tworker\tgone \(killed · session open\)\t0 posts/,
    'a kill whose session is still running says so'
  );

  // Killing is permanent: neither a resume of that session nor another bind
  // may bring the member back ('killed' is not one of ENDED's host reasons).
  fire('session_start', { reason: 'resume' }, child);
  assert.equal(members().members.dead.killed, true);
  const rebound = await call('swarm', { action: 'bind', key: members().members.dead.key }, child);
  assert.match(rebound.content, /dead was killed/);

  // The coordinator dismissing that session later must be recorded even though
  // the member was already killed: only then does "session open" go away.
  fire('session_end', { reason: 'dismissed' }, child);
  assert.equal(members().members.dead.session_ended, 'dismissed');
  assert.equal(members().members.dead.killed_reason, 'killed', 'the reason is not rewritten');
  assert.equal(members().members.dead.killed, true, 'a closed kill is still a kill');
  assert.match(
    (await call('swarm', { action: 'status' })).content,
    /dead\tworker\tgone \(killed\)\t0 posts/,
    'a closed kill is distinguishable from a running one'
  );
});

test('a kill reply says the session is still open', async () => {
  await call('swarm', { action: 'add', name: 'says', brief: 'Brief.' });
  const killed = await call('swarm', { action: 'kill', name: 'says' });
  assert.match(killed.content, /Its session is still open/);
  assert.match(killed.content, /subagent dismiss/);
  assert.doesNotMatch(killed.content, /stopped|process is gone|has been stopped/);
});

test('the coordinator is waiting on the board, not working', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-busy`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'busy', brief: 'Work.' });
  await call('swarm', { action: 'bind', key: members().members.busy.key }, child);
  await call('swarm_post', { text: 'busy reporting' }, child);
  // The coordinator's own board calls used to write transcript steps, which made
  // its row read "working · Posted #N" forever.
  await call('swarm_post', { text: 'coordinator ack' });
  await call('swarm', { action: 'status' });

  const status = await call('swarm', { action: 'status' });
  assert.match(status.content, /coordinator\tcoordinator\twaiting/, 'the coordinator waits');
  assert.match(status.content, /busy\tworker\tworking/, 'worker verdicts are untouched');
  assert.match(status.content, /busy\tworker\tworking\t1 posts\tlast #\d+\tPosted #\d+/);
});

test('clicking a member opens that subagent, and an unbound one says so', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-open-me`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'clicky', brief: 'Brief.' });
  await call('swarm', { action: 'bind', key: members().members.clicky.key }, child);
  await call('swarm', { action: 'add', name: 'ghost', brief: 'Brief.' });

  liveSessions.add(`${coordinator}::cw-open-me`);
  const open = methods.get('openMember');
  focusCalls.length = 0;
  const hit = await open({ conv: members().members.clicky.conversation_id }, { sessionId: coordinator });
  // A live member is still a conversation, so session.focus switches to its tab
  // and — unlike the other two — tells us it worked.
  assert.deepEqual(hit, { ok: true, opened: 'clicky', via: 'focus', tried: [] });
  assert.deepEqual(focusCalls, [['focus', `${coordinator}::cw-open-me`]]);

  const unbound = await open({ conv: 'ghost' }, { sessionId: coordinator });
  assert.equal(unbound.ok, false);
  assert.match(unbound.message, /unbound/);

  const lead = await open({ name: 'coordinator' }, { sessionId: coordinator });
  assert.deepEqual(lead, { ok: true, opened: 'coordinator' }, 'the coordinator needs no switch');
});

test('a member whose session ended opens as history instead of a live tab', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-ended`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'ended', brief: 'Brief.' });
  await call('swarm', { action: 'bind', key: members().members.ended.key }, child);
  fire('session_end', { reason: 'dismissed' }, child);

  focusCalls.length = 0;
  // Even if the window would still "switch" to that id (the renderer resolves
  // ok through a silent focusSubagent), an ended member must take the dialog.
  liveSessions.add(`${coordinator}::cw-ended`);
  const res = await methods.get('openMember')(
    { conv: members().members.ended.conversation_id },
    { sessionId: coordinator }
  );
  assert.equal(res.ok, true);
  assert.equal(res.via, 'openChildRun', 'a gone tab falls back to the history dialog');
  assert.deepEqual(focusCalls, [['openChildRun', coordinator, `${coordinator}::cw-ended`]]);
});

test('a finished turn parks the member, and a new turn wakes it', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-park`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'parker', brief: 'Brief.' });
  await call('swarm', { action: 'bind', key: members().members.parker.key }, child);
  await call('swarm_post', { text: 'parker reporting' }, child);

  assert.match((await call('swarm', { action: 'status' })).content, /parker\tworker\tworking/);
  const activeInPane = (await snapshot()).members.find((m) => m.name === 'parker');
  assert.equal(activeInPane.status, 'working');

  // agent_end is the honest "this turn is over" signal, including for children.
  fire('agent_end', {}, child);
  assert.match((await call('swarm', { action: 'status' })).content, /parker\tworker\twaiting/);
  const parkedInPane = (await snapshot()).members.find((m) => m.name === 'parker');
  assert.equal(parkedInPane.status, 'waiting', 'the pane stops saying Active');

  fire('agent_start', {}, child);
  assert.match((await call('swarm', { action: 'status' })).content, /parker\tworker\tworking/);

  // A main session's turn ends the same way, so the coordinator row stops
  // claiming it is mid-turn too.
  fire('agent_end', {}, undefined);
  assert.match((await call('swarm', { action: 'status' })).content, /coordinator\tcoordinator\twaiting/);
});

test('a transcript nobody wrote to for 10 minutes reads as quiet, not working', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-quiet`, name: 'ipc' };
  await call('swarm', { action: 'add', name: 'quiet', brief: 'Brief.' });
  await call('swarm', { action: 'bind', key: members().members.quiet.key }, child);
  // Write the transcript by hand: no events ever arrived for this session, which
  // is what a pre-0.1.7 session looks like.
  const conv = members().members.quiet.conversation_id;
  const dir = join(dataDir, 'state', 'brain', conv, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'transcript.jsonl'),
    `${JSON.stringify({
      step_index: Date.now() - 11 * 60 * 1000,
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      tool_calls: [{ name: 'swarm_post', args: { toolSummary: 'Posted #9' } }],
    })}\n`
  );
  const status = await call('swarm', { action: 'status' });
  assert.match(status.content, /quiet\tworker\twaiting\t0 posts\tlast #0\tquiet for 11m/);
});

test('a worker busy in tools is not called stuck', async () => {
  const child = { kind: 'coworker', sessionId: `${coordinator}::cw-busy`, name: 'busy' };
  await call('swarm', { action: 'add', name: 'busy', brief: 'Brief.' });
  await call('swarm', { action: 'bind', key: members().members.busy.key }, child);
  await call('swarm_post', { text: 'busy starting' }, child);

  // Twelve minutes without a board call: the pane judges liveness from the
  // transcript mtime, so it calls a working member stuck.
  const conv = members().members.busy.conversation_id;
  const file = join(dataDir, 'state', 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');
  const old = new Date(Date.now() - 12 * 60 * 1000);
  utimesSync(file, old, old);
  let snap = await snapshot();
  assert.equal(snap.members.find((m) => m.name === 'busy').status, 'working');
  assert.ok(
    snap.systemAttention.some((i) => i.member === 'busy' && i.kind === 'stuck'),
    'the pane does call it stuck'
  );

  // Every tool the member runs is real activity, and the step names the tool.
  fire('tool_call', { toolName: 'bash', input: { command: 'pnpm test' } }, child);
  snap = await snapshot();
  const busy = snap.members.find((m) => m.name === 'busy');
  assert.equal(busy.status, 'working');
  assert.equal(busy.activity, 'bash: pnpm test');
  assert.ok(!snap.systemAttention.some((i) => i.member === 'busy'), 'and stops once it is working');

  // A long call only refreshes the mtime when it ends: no step, no growth.
  fire('tool_result', { toolName: 'bash', input: {}, isError: false }, child);
  snap = await snapshot();
  assert.equal(snap.members.find((m) => m.name === 'busy').steps, busy.steps);

  // Board calls already record themselves; no second step for them.
  fire('tool_call', { toolName: 'swarm_read', input: {} }, child);
  snap = await snapshot();
  assert.equal(snap.members.find((m) => m.name === 'busy').steps, busy.steps);

  // The coordinator's own tools belong to no member.
  fire('tool_call', { toolName: 'bash', input: { command: 'ls' } }, undefined);
  snap = await snapshot();
  assert.equal(snap.members.find((m) => m.name === 'coordinator').steps, 0);
});
