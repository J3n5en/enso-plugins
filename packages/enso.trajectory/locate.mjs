import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const MAX_READ = 12 * 1024 * 1024;
const MAX_REGISTRY = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isInside(root, file) {
  if (!root || !file) return false;
  const base = resolve(root);
  let baseReal = base;
  try {
    baseReal = realpathSync(base);
  } catch {
    /* 目录还没有时用字面路径 */
  }
  let target = resolve(file);
  try {
    target = realpathSync(file);
  } catch {
    /* 文件还没落盘 */
  }
  return target === baseReal || target.startsWith(`${baseReal}${sep}`);
}

function hasSessions(dir) {
  return Boolean(dir) && existsSync(join(dir, 'agent', 'sessions'));
}

/** 插件 dataDir 在 userData/extension-plugins/data/<id>，往上能找到 agent/sessions。 */
export function findUserData(dataDir, env = process.env, home = homedir()) {
  let dir = dataDir ? resolve(dataDir) : '';
  for (let i = 0; i < 8 && dir; i += 1) {
    if (hasSessions(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const names = ['enso-code', 'EnsoCode'];
  const roots = [];
  if (env.APPDATA) roots.push(env.APPDATA);
  if (process.platform === 'darwin') roots.push(join(home, 'Library', 'Application Support'));
  roots.push(env.XDG_CONFIG_HOME || join(home, '.config'));
  roots.push(join(home, '.config'));
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (hasSessions(candidate)) return candidate;
    }
  }
  return null;
}

export function sessionsDir(userData) {
  return userData ? join(userData, 'agent', 'sessions') : '';
}

function readJson(file, max) {
  const stat = statSync(file);
  if (stat.size > max) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function sessionFileFor(userData, sessionId) {
  if (!userData || typeof sessionId !== 'string' || !sessionId) return null;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return null;
  const root = sessionsDir(userData);
  let registry;
  try {
    registry = readJson(join(userData, 'agent', 'source-registry.json'), MAX_REGISTRY);
  } catch {
    return null;
  }
  const conversations = Array.isArray(registry?.conversations) ? registry.conversations : [];
  const row = conversations.find((item) => item && item.conversationId === sessionId);
  const file = typeof row?.sessionFile === 'string' ? row.sessionFile : '';
  if (!file.endsWith('.jsonl') || !isInside(root, file)) return null;
  return resolve(file);
}

function safeBasename(file) {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    file === file.split(/[/\\]/).pop() &&
    !file.includes('..') &&
    file.endsWith('.jsonl')
  );
}

/** child-runs/<父会话>.jsonl：子代理 / coworker 的会话文件名 */
export function listChildRuns(userData, parentId) {
  if (!userData || !UUID.test(parentId ?? '')) return [];
  const file = join(sessionsDir(userData), 'child-runs', `${parentId}.jsonl`);
  let text;
  try {
    const stat = statSync(file);
    if (stat.size > 2 * 1024 * 1024) return [];
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const folded = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.v !== 1 || typeof row.childId !== 'string' || typeof row.file !== 'string') continue;
    if (!row.childId.startsWith(`${parentId}::`)) continue;
    if (!safeBasename(row.file) || typeof row.name !== 'string' || !row.name) continue;
    const prev = folded.get(row.childId);
    folded.set(row.childId, {
      childId: row.childId,
      name: row.name,
      title: typeof row.title === 'string' ? row.title : prev?.title || '',
      agentType: typeof row.agentType === 'string' ? row.agentType : '',
      file: row.file,
      startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
    });
  }
  return [...folded.values()];
}

export function matchChild(runs, agent) {
  if (!agent || !runs?.length) return null;
  const title = agent.description || '';
  const name = agent.name || '';
  const hits = runs.filter(
    (run) => (title && (run.title === title || run.name === title)) || (name && run.name === name),
  );
  if (!hits.length) return null;
  const at = agent.at || 0;
  hits.sort((a, b) => Math.abs(a.startedAt - at) - Math.abs(b.startedAt - at));
  return hits[0];
}

export function childFile(userData, parentId, run) {
  if (!run || !safeBasename(run.file)) return null;
  const root = sessionsDir(userData);
  const file = join(root, run.file);
  if (!isInside(root, file)) return null;
  return file;
}

/** 大文件只读尾部，避免把整段历史拉进插件进程。会话头单独留一行。 */
export function readSessionText(file) {
  const stat = statSync(file);
  if (stat.size <= MAX_READ) {
    return { text: readFileSync(file, 'utf8'), truncated: false, mtimeMs: stat.mtimeMs, size: stat.size };
  }
  const fd = openSync(file, 'r');
  try {
    const headLen = Math.min(4096, stat.size);
    const head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    const tail = Buffer.alloc(MAX_READ);
    readSync(fd, tail, 0, MAX_READ, stat.size - MAX_READ);
    let tailText = tail.toString('utf8');
    const nl = tailText.indexOf('\n');
    if (nl >= 0) tailText = tailText.slice(nl + 1);
    const headLine =
      head
        .toString('utf8')
        .split('\n')
        .find((line) => line.includes('"type":"session"') || line.includes('"type": "session"')) || '';
    return { text: `${headLine}\n${tailText}`, truncated: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } finally {
    closeSync(fd);
  }
}
