/**
 * Enso swarm host.
 *
 * The AGY swarm plugin is two things: a board the model writes to through four
 * tools, and a pane that renders that board. This file is the first half only.
 * The pane half is AGY's own swarm_board/ directory, byte-identical except for
 * its `sidecar_sdk` import, which becomes an in-process router instead of a
 * loopback HTTP server.
 *
 * Everything the pane reads is produced by AGY's upstream code from three files
 * per swarm, in AGY's own layout:
 *
 *   <dataDir>/state/brain/<coordinatorConv>/.system_generated/swarm/
 *     board.jsonl    append-only posts: {seq, agent, text, time[, channel]}
 *     members.json   {title, members: {name: {role, conversation_id, killed, channels}}}
 *     view.json      the narrator's Overview (written by the narrator)
 *
 * and one transcript per member conversation, which is how AGY derives each
 * member's status and current activity:
 *
 *   <dataDir>/state/brain/<memberConv>/.system_generated/logs/transcript.jsonl
 *
 * We never recompute what the pane shows: we only append, and upstream derives.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

let enso = null;
let app = null;
let ready = null;

const MAIN = 'main';
const ROLE_WORKER = /^(?:narrator|monitor)(?:-\d+)?$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const RESERVED = new Set(['all', 'coordinator']);

const convId = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
const nowTime = () => new Date().toISOString();

function root() {
  return join(enso.dataDir, 'state');
}
function brainDir(conv) {
  return join(root(), 'brain', conv);
}
function swarmDir(conv) {
  return join(brainDir(conv), '.system_generated', 'swarm');
}
function transcriptPath(conv) {
  return join(brainDir(conv), '.system_generated', 'logs', 'transcript.jsonl');
}
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path, fallback) {
  try {
    const text = readFileSync(path, 'utf-8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Atomic replace: the pane polls these files and must never read a half write. */
function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readRoster(conv) {
  const roster = readJson(join(swarmDir(conv), 'members.json'), null);
  if (!roster || typeof roster.members !== 'object' || !roster.members) return null;
  return { title: String(roster.title || ''), members: roster.members };
}

function readBoard(conv) {
  let text = '';
  try {
    text = readFileSync(join(swarmDir(conv), 'board.jsonl'), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg === 'object') out.push(msg);
    } catch {
      /* a torn trailing line is picked up next read */
    }
  }
  return out;
}

function appendBoard(conv, agent, text, extra = {}) {
  ensureDir(swarmDir(conv));
  const board = readBoard(conv);
  const seq = board.length ? Number(board[board.length - 1].seq || 0) + 1 : 1;
  const msg = { seq, agent, text: String(text), time: nowTime(), ...extra };
  appendFileSync(join(swarmDir(conv), 'board.jsonl'), `${JSON.stringify(msg)}\n`);
  return msg;
}

/** Mimes board/mentions.go closely enough for the four tools that need it. */
const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;
function named(lowerText, lowerName) {
  for (let i = lowerText.indexOf('@'); i >= 0; i = lowerText.indexOf('@', i + 1)) {
    if (i > 0 && NAME_RUNE.test([...lowerText.slice(Math.max(0, i - 2), i)].pop())) continue;
    if (!lowerText.startsWith(lowerName, i + 1)) continue;
    const j = i + 1 + lowerName.length;
    if (j >= lowerText.length) return true;
    if (!NAME_RUNE.test(String.fromCodePoint(lowerText.codePointAt(j)))) return true;
  }
  return false;
}
function mentionsOf(text, names) {
  const lower = String(text || '').toLowerCase();
  return {
    mentions: names.filter((name) => named(lower, String(name).toLowerCase())),
    all: named(lower, 'all'),
  };
}

function appendTranscriptStep(conv, step) {
  ensureDir(dirname(transcriptPath(conv)));
  appendFileSync(transcriptPath(conv), `${JSON.stringify(step)}\n`);
}

/**
 * Who is calling, and which swarm they belong to.
 *
 * A worker runs as its own top-level session (that is what coworker mode gives
 * us), so a session id is the only reliable tie to a member — and only after
 * the member calls swarm{action:"bind"} with the key from its brief. The
 * coordinator owns the swarm whose dir is hashed from its own session id.
 * Returns null for a caller that belongs to no swarm.
 */
function identify(ctx) {
  const session = String((ctx && ctx.sessionId) || '');
  const agent = ctx && ctx.agent ? ctx.agent : null;
  const agentSession = agent && agent.sessionId ? String(agent.sessionId) : '';
  const agentName = agent && agent.name ? String(agent.name) : '';
  // A coworker's ctx.sessionId is the session that spawned it, so the member
  // match has to run before the coordinator's own-dir check; the child session
  // id is what bind wrote down and is the only per-worker identity we have.
  for (const conv of swarmConvs()) {
    const roster = readRoster(conv);
    if (!roster) continue;
    for (const [name, member] of Object.entries(roster.members)) {
      const m = member && typeof member === 'object' ? member : {};
      if (!m.session_id && !m.conversation_id) continue;
      if (agentSession && m.session_id === agentSession)
        return { swarm: conv, name, conv: convId(agentSession) };
      // ctx.sessionId is shared with every worker this session spawned, so it
      // only identifies the caller when there is no agent source at all.
      if (!agentSession && session && m.session_id === session)
        return { swarm: conv, name, conv: convId(session) };
      if (m.conversation_id && m.conversation_id === convId(agentSession || session))
        return { swarm: conv, name, conv: m.conversation_id };
    }
  }
  if (agentName) {
    for (const conv of swarmConvs()) {
      const roster = readRoster(conv);
      if (roster && roster.members[agentName])
        return { swarm: conv, name: agentName, conv: convId(agentSession || agentName) };
    }
  }
  return null;
}

/** The session a member is bound to: its own, even when ctx reports the parent. */
function callerSession(ctx) {
  const agent = ctx && ctx.agent ? ctx.agent : null;
  return String((agent && agent.sessionId) || (ctx && ctx.sessionId) || '');
}

/** identify(), plus a name for a caller that has none yet (swarm{action:"open"}). */
function whoami(ctx, conv) {
  const me = identify(ctx);
  if (me) return me;
  const own = convId((ctx && ctx.sessionId) || '');
  return { swarm: conv || own, name: 'coordinator', conv: own };
}

const isRoleWorker = (name, member) =>
  Boolean(member && (member.role === 'narrator' || member.role === 'monitor')) || ROLE_WORKER.test(name);

function roleOf(name, member) {
  const role = member && typeof member.role === 'string' ? member.role : '';
  if (['coordinator', 'worker', 'narrator', 'monitor'].includes(role)) {
    if ((role === 'worker' || !role) && ROLE_WORKER.test(name)) {
      return /^monitor/.test(name) ? 'monitor' : 'narrator';
    }
    return role;
  }
  if (ROLE_WORKER.test(name)) return /^monitor/.test(name) ? 'monitor' : 'narrator';
  return 'worker';
}

/** Creates the swarm's two files and makes this session its coordinator. */
function openSwarm(ctx, { title }) {
  const me = whoami(ctx, '');
  const conv = me.conv;
  const membersFile = join(swarmDir(conv), 'members.json');
  const wanted = String(title || '').trim().slice(0, 80);
  if (existsSync(membersFile)) {
    const existing = readRoster(conv);
    if (!existing) throw new Error(`swarm ${conv} has an unreadable members.json`);
    // A title passed to open() must be visible on the board and in the reply,
    // like swarm{action:"title"}; echoing an input we never wrote is a lie.
    const retitled = Boolean(wanted && wanted !== existing.title);
    if (retitled) {
      existing.title = wanted;
      writeJsonAtomic(membersFile, existing);
    }
    return { conv, created: false, title: existing.title, retitled };
  }
  const roster = {
    title: wanted,
    members: {
      coordinator: {
        role: 'coordinator',
        conversation_id: conv,
        session_id: String((ctx && ctx.sessionId) || ''),
      },
    },
  };
  writeJsonAtomic(membersFile, roster);
  ensureDir(swarmDir(conv));
  writeFileSync(join(swarmDir(conv), 'board.jsonl'), '', { flag: 'a' });
  return { conv, created: true, title: roster.title, retitled: false };
}

/** The swarm this session belongs to, if any. */
function findSwarm(ctx) {
  const me = identify(ctx);
  return me ? me.swarm : null;
}

/** Every swarm dir under the data root (coordinator conversations). */
function swarmConvs() {
  try {
    return readdirSync(join(root(), 'brain')).filter((conv) =>
      existsSync(join(swarmDir(conv), 'members.json'))
    );
  } catch {
    return [];
  }
}

/**
 * A member's state read the way the pane reads it: from its own transcript.
 * The newest planner step decides — sleeping on swarm_wait is "waiting",
 * anything else is "working".
 */
/** A turn that ended this long ago, with nothing written since, is parked. */
const IDLE_AFTER_MS = 10 * 60 * 1000;

function activityOf(member, memberConv) {
  const path = transcriptPath(memberConv);
  if (!existsSync(path)) return { status: 'waiting', activity: '' };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-60);
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || step.type !== 'PLANNER_RESPONSE') continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const label = calls.length
      ? String((calls[calls.length - 1].args && calls[calls.length - 1].args.toolSummary) || calls[calls.length - 1].name || '')
      : '';
    const sleeping = calls.some((tc) => tc && tc.name === 'swarm_wait');
    // agent_end parks a member (wake_mode) so the pane and status agree; the
    // transcript is the fallback for turns we never saw an event for.
    if (sleeping || (member && member.wake_mode)) return { status: 'waiting', activity: label };
    const at = Number(step.step_index) || 0;
    const idleFor = at ? Date.now() - at : 0;
    if (idleFor > IDLE_AFTER_MS) {
      return { status: 'waiting', activity: `quiet for ${Math.round(idleFor / 60000)}m` };
    }
    return { status: 'working', activity: label };
  }
  return { status: 'waiting', activity: '' };
}

/**
 * One tab-separated cell, so no tabs or newlines here. A kill does not stop the
 * process: "session open" says it still holds a coworker slot, and it goes away
 * once the host reports that session's end.
 */
function goneLabel(m) {
  if (m.status === 'killed' && m.killed_reason) {
    if (m.killed_reason === 'killed' && !m.session_ended) return 'gone (killed · session open)';
    return `gone (${m.killed_reason})`;
  }
  return m.bound ? m.status : 'unbound';
}

function statusOf(conv) {
  const roster = readRoster(conv);
  if (!roster) return null;
  const board = readBoard(conv);
  const members = Object.entries(roster.members).map(([name, member]) => {
    const m = member && typeof member === 'object' ? member : {};
    const conv = m.conversation_id || '';
    const isCoordinator = roleOf(name, m) === 'coordinator';
    // Transcripts written before 0.1.9 still hold the coordinator's own board
    // calls, so its verdict is fixed here rather than read from them.
    const act = isCoordinator
      ? { status: 'waiting', activity: '' }
      : conv
        ? activityOf(m, conv)
        : { status: 'waiting', activity: '' };
    const last = board.filter((msg) => msg.agent === name).at(-1) || null;
    return {
      name,
      role: roleOf(name, m),
      killed: Boolean(m.killed),
      killed_reason: typeof m.killed_reason === 'string' ? m.killed_reason : '',
      session_ended: typeof m.session_ended === 'string' ? m.session_ended : '',
      model: typeof m.model === 'string' ? m.model : '',
      posts: board.filter((msg) => msg.agent === name).length,
      last_post: last ? last.seq : 0,
      last_read_seq: Number(m.last_read_seq) || 0,
      status: m.killed ? 'killed' : act.status,
      activity: act.activity,
      bound: Boolean(m.session_id || m.conversation_id),
      session: conv || null,
    };
  });
  const head = board.length ? Number(board[board.length - 1].seq) || board.length : 0;
  return { conv, title: roster.title, head, members, posts: board.length };
}

/** Appends the tool call to the caller's transcript so the pane shows activity. */
function recordActivity(ctx, conv, toolName, args, summary) {
  const me = whoami(ctx, conv);
  // The coordinator's own board calls are not work it needs to be watched
  // doing: writing them made its row read "working · Posted #31" forever, in
  // both swarm status and the pane. Workers keep their activity.
  if (me.name === 'coordinator') {
    if (toolName === 'swarm_read' || toolName === 'swarm_wait') markRead(conv, me.name);
    return;
  }
  appendTranscriptStep(me.conv, {
    step_index: Date.now(),
    type: 'PLANNER_RESPONSE',
    status: 'RUNNING',
    thinking: String(summary || '').slice(0, 200),
    tool_calls: [{ name: toolName, args: { toolSummary: String(summary || '').slice(0, 120) } }],
  });
  if (toolName === 'swarm_read' || toolName === 'swarm_wait') markRead(conv, me.name);
}

/** Reasons the host gives when a member's session is gone but nobody killed it. */
const ENDED = new Set(['dismissed', 'parent_ended', 'ended']);

/**
 * The session behind a member ended. Nothing else writes its state after that,
 * so without this the pane keeps replaying its last tool call as "Active".
 * Marked as killed so AGY's own statusOf() shows it as not running; the reason
 * says whether the board itself decided that (permanent) or the host did.
 */
function endMemberSession(sessionId, reason) {
  if (!sessionId) return;
  for (const conv of swarmConvs()) {
    const roster = readRoster(conv);
    if (!roster) continue;
    let changed = false;
    for (const member of Object.values(roster.members)) {
      const m = member && typeof member === 'object' ? member : null;
      if (!m || m.session_id !== sessionId) continue;
      if (m.killed) {
        // A killed member's session outlives the kill: it keeps holding a
        // coworker slot until someone dismisses it. Record that it really
        // closed, or status would claim "session open" forever — and leave
        // killed / killed_reason alone, so a kill stays permanent.
        const ended = String(reason || 'ended').slice(0, 32);
        if (m.session_ended !== ended) {
          m.session_ended = ended;
          changed = true;
        }
        continue;
      }
      m.killed = true;
      m.killed_reason = ENDED.has(reason) ? reason : 'ended';
      changed = true;
    }
    if (changed) writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  }
}

/**
 * AGY reads "is this member idle" from its real transcript: a newest planner
 * step with no tool calls means the turn ended. We only ever wrote the board
 * calls, so we append that step ourselves — it is the same shape a real
 * transcript ends a turn with, and it is what the pane watches.
 */
function appendTurnEnded(conv) {
  const path = transcriptPath(conv);
  if (!path || !existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length > 0) {
    let last = null;
    try {
      last = JSON.parse(lines[lines.length - 1]);
    } catch {
      last = null;
    }
    const calls = last && Array.isArray(last.tool_calls) ? last.tool_calls : null;
    if (last && last.type === 'PLANNER_RESPONSE' && calls && calls.length === 0) return;
  }
  appendTranscriptStep(conv, {
    step_index: Date.now(),
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    tool_calls: [],
  });
}

/** parked = between turns, waiting to be addressed; the pane shows Waiting. */
function setMemberParked(sessionId, parked) {
  if (!sessionId) return;
  for (const conv of swarmConvs()) {
    const roster = readRoster(conv);
    if (!roster) continue;
    let changed = false;
    for (const member of Object.values(roster.members)) {
      const m = member && typeof member === 'object' ? member : null;
      if (!m || m.session_id !== sessionId || m.killed) continue;
      if (parked) {
        if (m.conversation_id) appendTurnEnded(m.conversation_id);
        if (m.wake_mode !== 'mentions') {
          m.wake_mode = 'mentions';
          changed = true;
        }
      } else if (m.wake_mode) {
        delete m.wake_mode;
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  }
}

/** The same session came back (a resumed coworker): let it work again. */
function reviveMemberSession(sessionId) {
  if (!sessionId) return;
  for (const conv of swarmConvs()) {
    const roster = readRoster(conv);
    if (!roster) continue;
    let changed = false;
    for (const member of Object.values(roster.members)) {
      const m = member && typeof member === 'object' ? member : null;
      if (!m || m.session_id !== sessionId || !m.killed) continue;
      if (!ENDED.has(m.killed_reason)) continue;
      delete m.killed;
      delete m.killed_reason;
      changed = true;
    }
    if (changed) writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  }
}

function markRead(conv, name) {
  const roster = readRoster(conv);
  if (!roster || !roster.members[name]) return;
  const board = readBoard(conv);
  const head = board.length ? Number(board[board.length - 1].seq) || 0 : 0;
  if ((Number(roster.members[name].last_read_seq) || 0) >= head) return;
  roster.members[name].last_read_seq = head;
  writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
}

function addMember(ctx, conv, { name, brief, role, model }) {
  const safeName = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(safeName)) return { error: `invalid member name ${JSON.stringify(name)}: lowercase letters, digits and dashes, up to 24` };
  if (RESERVED.has(safeName) || safeName === MAIN) return { error: `"${safeName}" is reserved` };
  const roster = readRoster(conv);
  if (!roster) return { error: 'no swarm in this conversation; call swarm{action:"open"} first' };
  if (roster.members[safeName]) return { error: `a member named "${safeName}" already exists` };
  const finalRole = role === 'narrator' || role === 'monitor' ? role : 'worker';
  // A worker is its own session, so the brief carries a key and bind() is what
  // ties that session to this member.
  const key = randomBytes(4).toString('hex');
  roster.members[safeName] = {
    role: finalRole,
    // Added, briefed, not yet spawned: parked on the board.
    wake_mode: 'mentions',
    key,
    ...(model ? { model: String(model) } : {}),
  };
  writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  const text = String(brief || '').trim();
  appendBoard(conv, 'coordinator', text ? `@${safeName} ${text}` : `@${safeName}`);
  const bind = `swarm{action:"bind", key:"${key}"}`;
  const agentType = `swarm:${finalRole}`;
  const prompt =
    finalRole === 'worker'
      ? `You are ${safeName} in this swarm. ${text}\n\n` +
        `First call ${bind} — that binds this session to your name on the board and is the only way the board knows who you are. ` +
        `Then swarm_read{since:0}, do the work, swarm_post your result, and swarm_wait{since:<head>, mentionsOnly:true} until you are addressed again.`
      : `You are the swarm's ${finalRole}. ${text}\n\n` +
        `First call ${bind}, then follow the loop in your skill.`;
  return {
    name: safeName,
    role: finalRole,
    key,
    bind,
    spawn: `subagent(operation="spawn", mode="coworker", name="${safeName}", agent_type="${agentType}", prompt=${JSON.stringify(prompt)})`,
  };
}

const SHOT_LINE = /^\s*(?:[-*]\s*)?screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/gim;

/** Copies screenshots a post cites into the data root, rewritten in place. */
function absorbScreenshots(conv, text) {
  return String(text).replace(SHOT_LINE, (line, path, caption) => {
    try {
      const bytes = readFileSync(path);
      const ext = (path.match(/\.[a-z]+$/i) || ['.png'])[0].toLowerCase();
      const shots = join(brainDir(conv), '.system_generated', 'shots');
      ensureDir(shots);
      const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${ext}`;
      const target = join(shots, name);
      if (!existsSync(target)) writeFileSync(target, bytes);
      return `Screenshot: ${target}${caption ? ` | ${caption}` : ''}`;
    } catch {
      return line; // not readable here: leave the author's line alone
    }
  });
}

function postMessage(ctx, conv, { text, channel }) {
  const me = whoami(ctx, conv);
  const roster = readRoster(conv);
  if (!roster) return { error: 'no swarm in this conversation' };
  if (!roster.members[me.name]) {
    roster.members[me.name] = { role: 'worker', conversation_id: me.conv };
    writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  } else if (!roster.members[me.name].conversation_id) {
    roster.members[me.name].conversation_id = me.conv;
    writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  }
  const body = String(text || '');
  if (!body.trim()) return { error: 'text is required' };
  if (roster.members[me.name].wake_mode) {
    delete roster.members[me.name].wake_mode;
    writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
  }
  const msg = appendBoard(
    conv,
    me.name,
    absorbScreenshots(conv, body),
    channel && channel !== MAIN ? { channel: String(channel) } : {}
  );
  recordActivity(ctx, conv, 'swarm_post', {}, `Posted #${msg.seq}`);
  return { seq: msg.seq, agent: me.name };
}

function readBoardFor(ctx, conv, { since = 0, limit = 40 }) {
  const board = readBoard(conv);
  const from = Number(since) || 0;
  const fresh = board.filter((msg) => Number(msg.seq) > from);
  const tail = fresh.slice(-Math.max(1, Math.min(200, Number(limit) || 40)));
  const head = board.length ? Number(board[board.length - 1].seq) || 0 : 0;
  recordActivity(ctx, conv, 'swarm_read', {}, `Read the board`);
  return { head, since: from, omitted: fresh.length - tail.length, posts: tail };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPosts(ctx, conv, { since = 0, timeoutSec = 120, mentionsOnly = false }) {
  const me = whoami(ctx, conv);
  const deadline = Date.now() + Math.max(1, Math.min(540, Number(timeoutSec) || 120)) * 1000;
  const from = Number(since) || 0;
  for (;;) {
    const board = readBoard(conv);
    const fresh = board.filter((msg) => Number(msg.seq) > from);
    const names = Object.keys((readRoster(conv) || { members: {} }).members);
    const relevant = mentionsOnly
      ? fresh.filter((msg) => {
          const { mentions, all } = mentionsOf(msg.text, names);
          return msg.agent !== me.name && (all || mentions.includes(me.name));
        })
      : fresh;
    if (relevant.length) {
      const head = Number(board[board.length - 1].seq) || 0;
      recordActivity(ctx, conv, 'swarm_wait', {}, 'Waiting for posts');
      return { head, timedOut: false, posts: relevant.slice(-40) };
    }
    if (Date.now() >= deadline) {
      recordActivity(ctx, conv, 'swarm_wait', {}, 'Waiting for posts');
      return { head: board.length ? Number(board[board.length - 1].seq) || 0 : 0, timedOut: true, posts: [] };
    }
    if (ctx && ctx.signal && ctx.signal.aborted) {
      return { head: board.length ? Number(board[board.length - 1].seq) || 0 : 0, timedOut: true, posts: [] };
    }
    await sleep(400);
  }
}

/**
 * The narrator's Overview. It cannot write into the plugin data dir with its
 * own file tools, so it hands the two files to the host.
 */
function writeView(ctx, conv, { view, html }) {
  const me = whoami(ctx, conv);
  const roster = readRoster(conv);
  const member = roster && roster.members[me.name];
  if (!member || roleOf(me.name, member) !== 'narrator') {
    return { error: 'only the swarm narrator writes the Overview' };
  }
  const dir = swarmDir(conv);
  ensureDir(dir);
  const written = [];
  if (view && typeof view === 'object' && !Array.isArray(view)) {
    const json = `${JSON.stringify(view, null, 2)}\n`;
    if (json.length > 256 * 1024) return { error: 'view.json is too large (256 KB)' };
    writeJsonAtomic(join(dir, 'view.json'), view);
    written.push('view.json');
  }
  if (typeof html === 'string' && html.trim()) {
    if (html.length > 512 * 1024) return { error: 'view.html is too large (512 KB)' };
    const path = join(dir, 'view.html');
    writeFileSync(`${path}.tmp`, html);
    renameSync(`${path}.tmp`, path);
    written.push('view.html');
  }
  if (!written.length) return { error: 'pass view (the Overview JSON) or html' };
  return { written };
}

/** Loads the upstream pane server and points it at our data root. */
async function loadPane() {
  const state = root();
  ensureDir(join(state, 'brain'));
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = join(state, 'sidecar_data', 'swarm', 'swarm_board', 'data');
  process.env.SWARM_OVERVIEW = process.env.SWARM_OVERVIEW || 'true';
  process.env.SWARM_GRAPH_TAB = process.env.SWARM_GRAPH_TAB || 'true';
  process.env.SWARM_RAW_TAB = process.env.SWARM_RAW_TAB || 'true';
  await import('./swarm_board/main.mjs');
  app = globalThis.__sidecarApp || null;
  return app;
}

function requireSwarm(ctx) {
  const me = identify(ctx);
  if (me && readRoster(me.swarm)) return me;
  throw new Error(
    'this session is not bound to a swarm. If you are a swarm member, call ' +
      'swarm{action:"bind", key:"<the key from your brief>"} once, then retry.'
  );
}

export async function activate(inner) {
  enso = inner;
  ready = loadPane();

  // Clicking a bee (or a graph node, or an Overview action) upstream calls
  // window.sidecar.ui.toggleConversation with the board's own conv hash. The
  // host knows how to show a subagent's detail; this maps one to the other.
  enso.renderer.handle('openMember', async (args, ctx) => {
    await ready;
    const want = String((args && (args.conv || args.name)) || '');
    if (!want) return { ok: false, message: 'nothing to open' };
    // The pane can be open on a coworker's tab, whose id is <main>::…; the
    // swarm always belongs to the session that opened it.
    const self = String((ctx && ctx.sessionId) || '');
    const root = self.includes('::') ? self.slice(0, self.indexOf('::')) : self;
    const roster = (root && readRoster(convId(root))) || (self && readRoster(convId(self)));
    if (!roster) return { ok: false, message: 'no swarm in this conversation' };
    const hit = Object.entries(roster.members).find(
      ([name, member]) =>
        member &&
        typeof member === 'object' &&
        (member.conversation_id === want || name === want)
    );
    if (!hit) return { ok: false, message: 'that member is not in this swarm' };
    const [name, member] = hit;
    const main = root || self;
    if (member.role === 'coordinator' || !member.session_id) {
      // The coordinator is this conversation; anything else unbound has no
      // session to show, and saying so beats opening the wrong one.
      if (member.role === 'coordinator') return { ok: true, opened: 'coordinator' };
      return { ok: false, message: `${name} has no session yet (unbound)` };
    }
    const sessionId = String(member.session_id);
    const child = sessionId.includes('::');
    // An ended member has no tab left, so only the history dialog can show it:
    // session.focus would still resolve ok (the renderer falls back to
    // focusSubagent, which silently does nothing when TaskBar has no row keyed
    // by the short id), and we would stop on a lie.
    const gone = member.killed === true || Boolean(member.killed_reason);
    // A live member is a conversation, so session.focus switches to its tab —
    // and unlike the other two it reports back (NOT_FOUND when the window has
    // no such conversation). openChildRun always resolves ok, and focusSubagent
    // needs a TaskBar row, so they are the fallbacks in that order.
    const order = gone
      ? ['openChildRun', 'focus', 'focusSubagent']
      : ['focus', 'openChildRun', 'focusSubagent'];
    const attempts = {
      focusSubagent: () =>
        child && enso.session && enso.session.focusSubagent
          ? enso.session.focusSubagent(main, sessionId)
          : Promise.reject(new Error('no child to expand')),
      openChildRun: () =>
        child && enso.session && enso.session.openChildRun
          ? enso.session.openChildRun(main, sessionId)
          : Promise.reject(new Error('no child run to open')),
      focus: () =>
        enso.session && enso.session.focus
          ? enso.session.focus(sessionId)
          : Promise.reject(new Error('this host cannot open sessions')),
    };
    // Every step is logged with its own verdict: when a click "does nothing" the
    // log says which host call refused and why.
    const tried = [];
    for (const via of order) {
      try {
        await attempts[via]();
        console.log(
          `[swarm] openMember ${name} (${gone ? 'ended' : 'live'}) via ${via} ok` +
            (tried.length ? ` (tried: ${tried.join('; ')})` : '')
        );
        return { ok: true, opened: name, via, tried };
      } catch (error) {
        const code = String((error && error.code) || '');
        const message = String((error && error.message) || error);
        tried.push(`${via}: ${code || 'ERR'} ${message}`);
        console.warn(
          `[swarm] openMember ${name} (${gone ? 'ended' : 'live'}) via ${via} failed:` +
            ` ${code || 'ERR'} ${message}`
        );
      }
    }
    return { ok: false, message: tried.join(' | ') || 'cannot open that member', tried };
  });

  enso.renderer.handle('api', async (args, ctx) => {
    await ready;
    if (!app) throw new Error('swarm pane server is not loaded');
    const url = typeof args?.url === 'string' ? args.url : '';
    const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : (ctx && ctx.sessionId) || '';
    if (sessionId) app.config.conversationId = convId(sessionId);
    return app.handle(url);
  });

  enso.renderer.handle('swarm.session', async (args) => {
    const conv = args?.sessionId ? convId(args.sessionId) : '';
    const roster = conv ? readRoster(conv) : null;
    if (!roster) return { swarm: null };
    const me = roster.members
      ? Object.entries(roster.members).find(([, m]) => m && m.conversation_id === conv)?.[0] || null
      : null;
    return { swarm: conv, title: roster.title, member: me };
  });

  enso.tools.register('swarm', async (args, ctx) => {
    await ready;
    const action = String(args?.action || 'status');
    if (action === 'open') {
      const { conv, created, title: swarmTitle, retitled } = openSwarm(ctx, args || {});
      recordActivity(ctx, conv, 'swarm', {}, 'Opened the swarm');
      try {
        await enso.ui.view.open('swarm');
      } catch {
        // The pane is a convenience; the board works without it.
      }
      return {
        content:
          `${created ? 'Opened' : retitled ? 'Already open, retitled' : 'Already open'}: swarm ${conv}` +
          `${swarmTitle ? ` ("${swarmTitle}")` : ''}.\n` +
          `Next: swarm{action:"add", name:"<worker>", brief:"…"} for each piece of work. ` +
          `The pane is in the sidebar; reopen it any time with /enso.swarm:board.`,
      };
    }

    if (action === 'bind') {
      const key = String(args?.key || '').trim();
      if (!/^[0-9a-f]{6,32}$/.test(key)) return { content: 'bind needs the key from your brief' };
      const session = callerSession(ctx);
      if (!session) return { content: 'bind needs a session' };
      for (const conv of swarmConvs()) {
        const roster = readRoster(conv);
        if (!roster) continue;
        const entry = Object.entries(roster.members).find(([, m]) => m && m.key === key);
        if (!entry) continue;
        const [name, member] = entry;
        if (member.killed) {
          if (!ENDED.has(member.killed_reason)) return { content: `${name} was killed; ask the coordinator` };
          delete member.killed;
          delete member.killed_reason;
        }
        if (member.session_id && member.session_id !== session)
          return { content: 'that key is already bound to another session' };
        member.session_id = session;
        member.conversation_id = convId(session);
        delete member.wake_mode;
        writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
        const board = readBoard(conv);
        const head = board.length ? Number(board[board.length - 1].seq) || 0 : 0;
        return {
          content:
            `Bound as ${name} (${member.role}) on swarm${roster.title ? ` "${roster.title}"` : ` ${conv}`}. head is #${head}.\n` +
            `Next: swarm_read{since:0}.`,
        };
      }
      return { content: 'no member is waiting for that key; copy it from the brief the coordinator posted' };
    }

    if (action === 'add') {
      const conv = requireSwarm(ctx).swarm;
      const res = addMember(ctx, conv, args || {});
      if (res.error) return { content: res.error };
      recordActivity(ctx, conv, 'swarm', {}, `Added ${res.name}`);
      return {
        content:
          `Added ${res.name} (${res.role}) and posted its brief on the board.\n` +
          `Now spawn it exactly like this:\n${res.spawn}\n` +
          `It sends ${res.bind} as its first call, and status shows it as unbound until then.`,
      };
    }

    if (action === 'kill') {
      const conv = requireSwarm(ctx).swarm;
      const roster = readRoster(conv);
      const target = String(args?.name || '').toLowerCase();
      if (!roster.members[target]) return { content: `no member named "${target}"` };
      roster.members[target].killed = true;
      // Symmetric with session_end: without a reason the status line can only
      // say a bare "killed", and bind's revival check would be reading ''.
      // 'killed' is deliberately NOT in ENDED, so a killed member stays dead
      // even if its session is ever resumed.
      roster.members[target].killed_reason = 'killed';
      writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
      // No board line: clearing ten members used to add ten lines and inflate
      // the swarm's post count (posts = board lines). members.json is the kill
      // record, and status/the pane read it from there.
      return {
        content:
          `Killed ${target}. Its workspace is gone; nothing it holds can be recovered.` +
          ` Its session is still open — run subagent dismiss on it to free a coworker slot.`,
      };
    }

    if (action === 'title') {
      const conv = requireSwarm(ctx).swarm;
      const roster = readRoster(conv);
      roster.title = String(args?.title || '').slice(0, 80);
      writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
      return { content: `Swarm title is now "${roster.title}".` };
    }

    const mine = identify(ctx);
    const status = mine ? statusOf(mine.swarm) : null;
    if (!status) return { content: 'No swarm in this conversation yet. Open one with swarm{action:"open", title:"…"}' };
    return {
      content: [
        `swarm ${status.conv}${status.title ? ` "${status.title}"` : ''} · ${status.head} posts`,
        ...status.members.map(
          (m) =>
            `${m.name}\t${m.role}\t${goneLabel(m)}` +
            `\t${m.posts} posts\tlast #${m.last_post}` +
            `${m.activity ? `\t${m.activity}` : ''}\t${m.model || 'session model'}`
        ),
      ].join('\n'),
    };
  });

  enso.tools.register('swarm_post', async (args, ctx) => {
    await ready;
    const conv = requireSwarm(ctx).swarm;
    const res = postMessage(ctx, conv, args || {});
    if (res.error) return { content: res.error };
    return { content: `Posted as ${res.agent} at #${res.seq}.` };
  });

  enso.tools.register('swarm_read', async (args, ctx) => {
    await ready;
    const conv = requireSwarm(ctx).swarm;
    const out = readBoardFor(ctx, conv, args || {});
    const lines = out.posts.map((msg) => `#${msg.seq} ${msg.agent}${msg.channel && msg.channel !== MAIN ? ` #${msg.channel}` : ''}: ${msg.text}`);
    return {
      content: `head #${out.head}${out.omitted ? ` (${out.omitted} older posts omitted; pass since to page back)` : ''}\n${lines.join('\n')}`,
    };
  });

  enso.tools.register('swarm_wait', async (args, ctx) => {
    await ready;
    const conv = requireSwarm(ctx).swarm;
    const out = await waitForPosts(ctx, conv, args || {});
    if (out.timedOut) {
      return { content: `No new posts. head is still #${out.head}; call swarm_wait{since:${out.head}} again to keep waiting.` };
    }
    const lines = out.posts.map((msg) => `#${msg.seq} ${msg.agent}: ${msg.text}`);
    return { content: `head #${out.head}\n${lines.join('\n')}` };
  });

  enso.tools.register('swarm_view', async (args, ctx) => {
    await ready;
    const conv = requireSwarm(ctx).swarm;
    const res = writeView(ctx, conv, args || {});
    if (res.error) return { content: res.error };
    return { content: `Wrote ${res.written.join(' and ')}; the pane picks it up on its next poll.` };
  });

  enso.tools.register('swarm_plan', async (args, ctx) => {
    await ready;
    const conv = requireSwarm(ctx).swarm;
    const plan = args && typeof args === 'object' ? args.plan : null;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan))
      return { content: 'pass plan: {goal:{title,line}, tasks:{member:task}, threads:[{id,title,goal,tasks}]}' };
    const dir = swarmDir(conv);
    ensureDir(dir);
    writeJsonAtomic(join(dir, 'plan.json'), plan);
    return { content: 'Wrote plan.json; the pane renders the Overview from it on its next poll.' };
  });

  enso.commands.register('board', async (ctx) => {
    await enso.ui.view.open('swarm');
    return undefined;
  });

  // Without these two the roster is frozen at a member's last tool call: a
  // dismissed or released worker keeps reading as "working" forever.
  if (enso.events && typeof enso.events.on === 'function') {
    enso.events.on('session_end', (data, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || !agent.sessionId) return;
      endMemberSession(String(agent.sessionId), String((data && data.reason) || 'ended'));
    });
    enso.events.on('session_start', (_data, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || !agent.sessionId) return;
      reviveMemberSession(String(agent.sessionId));
    });
    // Child sessions do get these two (only tool_call is intercept-only), and
    // they are the one honest "this member is not working right now" signal:
    // its turn ended. wake_mode is what AGY's own statusOf() reads.
    // The coordinator parks too: its row reads "working" forever otherwise,
    // because its own transcript only ever contains board calls.
    const turnSession = (ctx) => {
      const agent = ctx && ctx.agent;
      return String((agent && agent.sessionId) || (ctx && ctx.sessionId) || '');
    };
    enso.events.on('agent_start', (_data, ctx) => {
      setMemberParked(turnSession(ctx), false);
    });
    enso.events.on('agent_end', (_data, ctx) => {
      setMemberParked(turnSession(ctx), true);
    });
  }

  enso.schedules.register('stall-check', async () => {
    await ready;
    const QUIET_MS = 10 * 60 * 1000;
    const REPEAT_MS = 15 * 60 * 1000;
    for (const conv of swarmConvs()) {
      const status = statusOf(conv);
      if (!status) continue;
      // Only bound workers count: an unbound member is a coordinator that has
      // not spawned anyone yet, so there is nobody asleep to wake.
      const workers = status.members.filter((m) => m.role === 'worker' && !m.killed && m.bound);
      if (!workers.length) continue;
      if (!workers.some((m) => m.posts > 0)) continue;
      if (workers.some((m) => m.status === 'working')) continue;
      const roster = readRoster(conv);
      const board = readBoard(conv);
      const last = board.at(-1);
      const lastMs = last ? Date.parse(String(last.time).replace(' ', 'T')) : NaN;
      if (!Number.isFinite(lastMs) || Date.now() - lastMs < QUIET_MS) continue;
      const nudged = roster && roster.stall && Number.isFinite(roster.stall.at) ? roster.stall : null;
      if (nudged && Date.now() - nudged.at < REPEAT_MS) continue;

      const head = last ? Number(last.seq) || 0 : 0;
      const coordinator = roster && roster.members ? roster.members.coordinator : null;
      const waiting = workers.map((m) => `${m.name} (waiting since #${m.last_post})`).join(', ');
      const text =
        `@coordinator [stall] ${waiting}; nothing new on the board since #${head}. ` +
        `Post the next assignment or say what is blocked.`;
      appendBoard(conv, 'monitor', text);
      if (roster) {
        roster.stall = { seq: head, at: Date.now() };
        writeJsonAtomic(join(swarmDir(conv), 'members.json'), roster);
      }
      const target = coordinator && coordinator.session_id ? coordinator.session_id : '';
      if (!target) {
        console.warn('[swarm] stall noted on the board; the coordinator session is not recorded');
        continue;
      }
      try {
        await enso.session.inject({
          sessionId: target,
          text:
            `[swarm monitor] The swarm has stalled: every worker is asleep on the board and nothing ` +
            `is in progress. Read the new posts and either assign the next piece or tell the user what is blocked.`,
          deliverAs: 'nextTurn',
          triggerTurn: true,
          trusted: true,
        });
      } catch (error) {
        // Waking another session needs the user's "send to any running
        // session" switch; the board post stays the record either way.
        console.warn(`[swarm] could not wake the coordinator: ${String(error && error.message)}`);
      }
    }
  });
}

export function deactivate() {
  enso = null;
  app = null;
  ready = null;
}
