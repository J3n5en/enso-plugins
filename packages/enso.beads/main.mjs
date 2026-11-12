import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  applyFileChange,
  assertId,
  assertText,
  clip,
  coerceIssues,
  handoffPrompt,
  jsonlRel,
  looksUninitialized,
  normalizeIssue,
  parseBdPayload,
  parseJsonl,
  parsePriority,
  parseType,
  payloadError,
  prefixFromConfig,
  present,
  publicIssue,
  relationsOf,
  resolveMembership,
  serializeJsonl,
  stampOf,
} from './beads.mjs';

const MARKERS = ['.beads/metadata.json', '.beads/config.yaml', '.beads/config.yml', '.beads/issues.jsonl', '.beads/beads.jsonl', '.beads/README.md'];
const FLAG_ERROR = /unknown flag|unknown command|unknown shorthand|flag provided but not defined|unrecognized flag|invalid option/i;
const JSONL_WARNING = '当前没有 bd，认领、关闭和评论会写入 issues.jsonl。安装 bd 后改为调用命令行。';

export function runProcess(bin, args, cwd, timeout = 25000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: bdEnv(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error.message, overflow: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const cap = 16 * 1024 * 1024;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < cap) stdout += chunk;
      else overflow = true;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < cap) stderr += chunk;
      else overflow = true;
    });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr || error.message, overflow }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr: stderr.slice(-8000), overflow }));
  });
}

function bdEnv(cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'BEADS_DIR' || key === 'BD_DB' || key.startsWith('BD_DOLT') || key.startsWith('DOLT_')) delete env[key];
  }
  if (cwd) env.BEADS_DIR = join(cwd, '.beads');
  env.BD_DIRECTORY_LABELS = '{}';
  env.BD_LAST_TOUCHED_FALLBACK = '0';
  env.NO_COLOR = '1';
  return env;
}

export async function locateBd(exec = runProcess) {
  const candidates = [process.env.BD_BIN, 'bd', '/opt/homebrew/bin/bd', '/usr/local/bin/bd', '/usr/bin/bd', join(homedir(), '.local/bin/bd'), join(homedir(), 'go/bin/bd')].filter(Boolean);
  for (const bin of candidates) {
    const version = await exec(bin, ['version'], undefined, 4000);
    if (version.code === 0) return bin;
    const dashed = await exec(bin, ['--version'], undefined, 4000);
    if (dashed.code === 0) return bin;
  }
  return null;
}

async function runBd(exec, kind, readonly, variants) {
  let last = null;
  for (const args of variants) {
    for (const ro of readonly ? [true, false] : [false]) {
      const result = await exec(['--no-color', '--json', ...(ro ? ['--readonly'] : []), ...args]);
      last = result;
      if (result.overflow) throw new Error('bd 输出过大，已中止读取');
      if (result.code === 0) {
        const stdout = String(result.stdout ?? '').trim();
        if (!stdout) return null;
        let payload;
        try {
          payload = parseBdPayload(stdout);
        } catch {
          if (kind === 'write') return null;
          throw new Error('bd 返回的不是 JSON');
        }
        const message = payloadError(payload);
        if (message) throw new Error(message);
        return payload;
      }
      const diag = `${result.stderr || ''}\n${result.stdout || ''}`;
      if (!FLAG_ERROR.test(diag)) {
        throw new Error((result.stderr || result.stdout || `bd 退出码 ${result.code}`).trim().slice(0, 500));
      }
    }
  }
  throw new Error((last?.stderr || last?.stdout || '当前 bd 不支持这条命令').trim().slice(0, 500));
}

async function loadFromBd(exec) {
  const listPayload = await runBd(exec, 'read', true, [
    ['list', '--all', '--limit=0', '--flat'],
    ['list', '--limit=0'],
    ['list'],
  ]);
  const list = coerceIssues(listPayload);
  if (!list) throw new Error('bd list 没有返回任务列表');
  let readyIds = null;
  let blockedIds = null;
  try {
    const ready = coerceIssues(await runBd(exec, 'read', true, [['ready', '--limit=0'], ['ready']]));
    if (ready) readyIds = ready.map((issue) => issue?.id).filter(Boolean);
  } catch {
    readyIds = null;
  }
  try {
    const blocked = coerceIssues(await runBd(exec, 'read', true, [['blocked']]));
    if (blocked) blockedIds = blocked.map((issue) => issue?.id).filter(Boolean);
  } catch {
    blockedIds = null;
  }
  return { raw: list, readyIds, blockedIds };
}

async function showFromBd(exec, id) {
  const payload = await runBd(exec, 'read', true, [
    ['show', `--id=${id}`, '--include-comments'],
    ['show', `--id=${id}`],
    ['show', id],
  ]);
  const rows = coerceIssues(payload);
  if (!rows?.[0]) throw new Error(`任务不存在：${id}`);
  let raw = rows[0];
  if (raw.comments_omitted || (!Array.isArray(raw.comments) && Number(raw.comment_count) > 0)) {
    try {
      const commentsPayload = await runBd(exec, 'read', true, [
        ['comments', id],
        ['comments', '--', id],
      ]);
      const comments = Array.isArray(commentsPayload) ? commentsPayload : commentsPayload?.comments;
      if (Array.isArray(comments)) raw = { ...raw, comments };
    } catch {
      /* 详情仍返回任务本身 */
    }
  }
  return raw;
}

async function mutateBd(exec, action) {
  if (action.op === 'claim') {
    await runBd(exec, 'write', false, [
      ['update', '--claim', '--', action.id],
      ['update', '--status=in_progress', '--', action.id],
    ]);
    return action.id;
  }
  if (action.op === 'close') {
    const reason = String(action.reason ?? '').trim();
    if (reason.length > 2000) throw new Error('关闭原因太长');
    await runBd(exec, 'write', false, [
      reason ? ['close', `--reason=${reason}`, '--', action.id] : ['close', '--', action.id],
      reason ? ['close', action.id, '--reason', reason] : ['close', action.id],
    ]);
    return action.id;
  }
  if (action.op === 'reopen') {
    await runBd(exec, 'write', false, [
      ['reopen', '--', action.id],
      ['update', '--status=open', '--', action.id],
    ]);
    return action.id;
  }
  if (action.op === 'comment') {
    const text = String(action.text ?? '');
    await runBd(exec, 'write', false, [
      ['comments', 'add', action.id, text],
      ['comment', '--', action.id, text],
    ]);
    return action.id;
  }
  if (action.op === 'create') {
    const args = ['create', '--repo=.', `--title=${action.title}`, `--priority=${action.priority}`, `--type=${action.type}`];
    if (action.description) args.push(`--description=${action.description}`);
    const payload = await runBd(exec, 'write', false, [args, args.filter((arg) => arg !== '--repo=.')]);
    return coerceIssues(payload)?.[0]?.id || null;
  }
  throw new Error('未知操作');
}

function emptyCounts() {
  return { all: 0, ready: 0, in_progress: 0, blocked: 0, deferred: 0, closed: 0, other: 0 };
}

function isMissing(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return true;
  return /ENOENT|no such file|not found/i.test(String(error?.message ?? ''));
}

export function createBeads(deps) {
  const readText = deps.readText;
  const writeText = deps.writeText;
  const locate = deps.locateBd;
  const execBd = deps.execBd;
  const dataDir = deps.dataDir;
  const session = deps.session;
  const now = deps.now || (() => new Date().toISOString());
  const chains = new Map();
  let bin;

  const lock = (root, fn) => {
    const prev = chains.get(root) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(root, run.then(() => {}, () => {}));
    return run;
  };

  const bdBin = async () => {
    if (bin) return bin;
    const found = await locate();
    if (found) bin = found;
    return found || null;
  };

  const projectKey = (root) => createHash('sha256').update(root).digest('hex').slice(0, 16);

  const readHandoffs = async (root) => {
    if (!dataDir) return {};
    try {
      const all = JSON.parse(await readFile(join(dataDir, 'handoffs.json'), 'utf8'));
      const mine = all?.[projectKey(root)];
      return mine && typeof mine === 'object' ? mine : {};
    } catch {
      return {};
    }
  };

  const saveHandoff = async (root, id, sessionId) => {
    if (!dataDir) return;
    const file = join(dataDir, 'handoffs.json');
    let all = {};
    try {
      all = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      all = {};
    }
    const key = projectKey(root);
    all[key] = { ...(all[key] && typeof all[key] === 'object' ? all[key] : {}), [id]: sessionId };
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all));
    await rename(tmp, file);
  };

  const capabilities = () => ({
    write: false,
    handoff: typeof session?.create === 'function',
    focus: typeof session?.focus === 'function',
  });

  const baseView = (root, extra = {}) => ({
    state: 'ready',
    message: null,
    source: null,
    warning: null,
    projectName: root ? basename(root) : null,
    truncated: false,
    stamp: '',
    counts: emptyCounts(),
    columns: ['ready', 'in_progress', 'blocked', 'closed'],
    issues: [],
    types: [],
    assignees: [],
    capabilities: capabilities(),
    handoffs: {},
    ...extra,
  });

  const probe = async (root) => {
    const found = {};
    const read = async (rel) => {
      if (!rel || rel in found) return;
      try {
        const text = await readText(root, rel);
        if (text != null) found[rel] = String(text);
      } catch (error) {
        if (rel.endsWith('.db') && !isMissing(error)) found[rel] = '';
        else if (!isMissing(error)) throw error;
      }
    };
    for (const rel of MARKERS) await read(rel);
    try {
      await read(jsonlRel(JSON.parse(found['.beads/metadata.json'] || 'null')?.jsonl_export));
    } catch {
      /* metadata 不是 JSON 时仍把已读到的文件当作已初始化 */
    }
    return found;
  };

  const readJsonlDoc = (found) => {
    let named = null;
    try {
      const meta = JSON.parse(found['.beads/metadata.json'] || 'null');
      named = jsonlRel(meta?.jsonl_export);
    } catch {
      named = null;
    }
    const rel = named && found[named] != null ? named : found['.beads/issues.jsonl'] != null ? '.beads/issues.jsonl' : found['.beads/beads.jsonl'] != null ? '.beads/beads.jsonl' : named || '.beads/issues.jsonl';
    const text = found[rel];
    return { rel, text: text == null ? null : text };
  };

  const modelsFrom = (raw, readyIds, blockedIds) => {
    const models = raw.map(normalizeIssue).filter((issue) => issue.id && issue.title);
    const membership = resolveMembership(models, readyIds, blockedIds);
    return { models, membership };
  };

  const load = async (root) => {
    const found = await probe(root);
    const hasMarker = Object.keys(found).length > 0;
    const command = await bdBin();
    if (command) {
      try {
        const loaded = await loadFromBd((args) => execBd(command, args, root));
        const built = modelsFrom(loaded.raw, loaded.readyIds, loaded.blockedIds);
        return { state: 'ready', source: 'bd', warning: null, found, jsonlRel: null, doc: null, ...built };
      } catch (error) {
        if (!hasMarker && looksUninitialized(error.message)) return { state: 'uninitialized', message: '这个项目还没有初始化 Beads。在项目根目录运行 bd init 即可，数据留在本地，不需要云服务。' };
        if (hasMarker && looksUninitialized(error.message)) {
          return { state: 'error', message: '项目里已有 .beads，但 bd 认为还没初始化。请在项目根目录运行 bd init 或 bd doctor。' };
        }
        return { state: 'error', message: error.message || '读取 Beads 失败' };
      }
    }
    if (!hasMarker) return { state: 'uninitialized', message: '这个项目还没有初始化 Beads。在项目根目录运行 bd init 即可，数据留在本地，不需要云服务。' };
    const file = readJsonlDoc(found);
    if (file.text == null) {
      return { state: 'needs-cli', message: '项目里已有 .beads，但没有 bd 命令，也没有可读的 issues.jsonl。安装 bd 后才能查看和更新任务。' };
    }
    const doc = parseJsonl(file.text);
    if (!doc.issues.length && doc.bad.length) return { state: 'error', message: 'issues.jsonl 无法解析，没有把它当成空看板。' };
    const built = modelsFrom(doc.issues, null, null);
    const warning = doc.bad.length ? `${JSONL_WARNING}另有 ${doc.bad.length} 行无法解析，已跳过。` : JSONL_WARNING;
    return { state: 'ready', source: 'jsonl', warning, found, jsonlRel: file.rel, doc, ...built };
  };

  const toSnapshot = async (root, loaded) => {
    if (loaded.state !== 'ready') return baseView(root, { state: loaded.state, message: loaded.message, capabilities: capabilities() });
    const view = present(loaded.models, loaded.membership);
    const handoffs = await readHandoffs(root);
    return baseView(root, {
      source: loaded.source,
      warning: loaded.warning,
      truncated: view.truncated,
      stamp: stampOf(loaded.source, view.issues),
      counts: view.counts,
      columns: view.columns,
      issues: view.issues,
      types: [...new Set(view.issues.map((issue) => issue.type))].sort(),
      assignees: [...new Set(view.issues.map((issue) => issue.assignee).filter(Boolean))].sort(),
      capabilities: { ...capabilities(), write: true },
      handoffs,
    });
  };

  const requireRoot = (ctx) => {
    if (!ctx?.projectRoot) throw new Error('请先打开一个项目');
    return ctx.projectRoot;
  };

  const detailFor = (loaded, id, handoffs) => {
    const model = loaded.models.find((issue) => issue.id === id);
    if (!model) return null;
    return { issue: publicIssue(model), relations: relationsOf(model, loaded.models), handoffSessionId: handoffs[id] || null };
  };

  const mutate = (action) => async (args, ctx) => {
    const root = requireRoot(ctx);
    return lock(root, async () => {
      const loaded = await load(root);
      if (loaded.state !== 'ready') throw new Error(loaded.message || 'Beads 还不可用');
      let id = null;
      if (loaded.source === 'bd') {
        const fields = action(args);
        id = await mutateBd((cli) => execBd(bin, cli, root), fields);
      } else {
        const fields = action(args);
        const prefix = prefixFromConfig(loaded.found['.beads/config.yaml'] || loaded.found['.beads/config.yml']);
        const next = applyFileChange(loaded.doc, fields, { now: now(), prefix, idFactory: deps.idFactory });
        await writeText(root, loaded.jsonlRel, serializeJsonl(next));
        id = next.id;
      }
      const fresh = await load(root);
      const handoffs = await readHandoffs(root);
      return { snapshot: await toSnapshot(root, fresh), detail: id ? detailFor(fresh, id, handoffs) : null };
    });
  };

  return {
    async snapshot(_args, ctx) {
      if (!ctx?.projectRoot) return baseView(null, { state: 'no-project', message: '请先打开一个项目。看板读取该项目里的 .beads。' });
      const root = ctx.projectRoot;
      return lock(root, async () => toSnapshot(root, await load(root)));
    },
    async issue(args, ctx) {
      const root = requireRoot(ctx);
      return lock(root, async () => {
        const loaded = await load(root);
        if (loaded.state !== 'ready') return { state: loaded.state, message: loaded.message };
        const id = assertId(args?.id);
        let models = loaded.models;
        let model = models.find((issue) => issue.id === id);
        if (loaded.source === 'bd') {
          const raw = await showFromBd((cli) => execBd(bin, cli, root), id);
          model = normalizeIssue(raw);
          models = models.some((issue) => issue.id === id) ? models.map((issue) => (issue.id === id ? model : issue)) : [...models, model];
        }
        if (!model) throw new Error(`任务不存在：${id}`);
        const handoffs = await readHandoffs(root);
        return {
          state: 'ready',
          source: loaded.source,
          issue: publicIssue(model),
          relations: relationsOf(model, models),
          handoffSessionId: handoffs[id] || null,
          capabilities: { ...capabilities(), write: true },
        };
      });
    },
    create: mutate((args) => ({
      op: 'create',
      title: assertText(args?.title, '标题', 200),
      description: clip(String(args?.description ?? '').trim(), 16000),
      type: parseType(args?.type),
      priority: parsePriority(args?.priority, 2),
    })),
    claim: mutate((args) => ({ op: 'claim', id: assertId(args?.id) })),
    close: mutate((args) => {
      const reason = String(args?.reason ?? '').trim();
      if (reason.length > 2000) throw new Error('关闭原因太长');
      return { op: 'close', id: assertId(args?.id), reason };
    }),
    reopen: mutate((args) => ({ op: 'reopen', id: assertId(args?.id) })),
    comment: mutate((args) => ({ op: 'comment', id: assertId(args?.id), text: assertText(args?.text, '评论', 8000) })),
    async handoff(args, ctx) {
      const root = requireRoot(ctx);
      if (typeof session?.create !== 'function') throw new Error('当前宿主不能新建会话');
      return lock(root, async () => {
        const loaded = await load(root);
        if (loaded.state !== 'ready') throw new Error(loaded.message || 'Beads 还不可用');
        const id = assertId(args?.id);
        let model = loaded.models.find((issue) => issue.id === id);
        let models = loaded.models;
        if (loaded.source === 'bd') {
          model = normalizeIssue(await showFromBd((cli) => execBd(bin, cli, root), id));
          models = models.map((issue) => (issue.id === id ? model : issue));
        }
        if (!model) throw new Error(`任务不存在：${id}`);
        const text = handoffPrompt(model, relationsOf(model, models));
        const created = await session.create({ text });
        const sessionId = created?.sessionId || created?.id;
        if (!sessionId) throw new Error('宿主没有返回会话 id');
        await saveHandoff(root, id, sessionId);
        let warning = null;
        if (typeof session.focus === 'function') {
          try {
            await session.focus(sessionId);
          } catch {
            warning = '会话已创建，但没能切换过去';
          }
        }
        const fresh = await load(root);
        const handoffs = await readHandoffs(root);
        return { sessionId, warning, snapshot: await toSnapshot(root, fresh), detail: detailFor(fresh, id, handoffs) };
      });
    },
    async focus(args) {
      const sessionId = String(args?.sessionId ?? '').trim();
      if (!sessionId) throw new Error('没有会话');
      if (typeof session?.focus !== 'function') throw new Error('当前宿主不能切换会话');
      await session.focus(sessionId);
      return { ok: true };
    },
  };
}

export function activate(enso) {
  const beads = createBeads({
    readText: async (root, rel) => readProject(enso, root, rel),
    writeText: async (root, rel, text) => writeProject(enso, root, rel, text),
    locateBd: () => locateBd(),
    execBd: (bin, args, cwd) => runProcess(bin, args, cwd),
    dataDir: enso.dataDir,
    session: enso.session,
  });
  for (const name of ['snapshot', 'issue', 'create', 'claim', 'close', 'reopen', 'comment', 'handoff', 'focus']) {
    enso.renderer.handle(name, (args, ctx) => beads[name](args, ctx));
  }
}

async function readProject(enso, root, rel) {
  if (typeof enso.fs?.readText === 'function') {
    try {
      const text = await enso.fs.readText(rel);
      return text == null ? null : String(text);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  try {
    return await readFile(join(root, rel), 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeProject(enso, root, rel, text) {
  if (!/^\.beads\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(rel)) throw new Error('拒绝写入 Beads 目录以外的文件');
  const writer = enso.fs?.writeText || enso.fs?.writeFile || enso.fs?.write;
  if (typeof writer === 'function') {
    await writer.call(enso.fs, rel, text);
    return;
  }
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, abs);
}
