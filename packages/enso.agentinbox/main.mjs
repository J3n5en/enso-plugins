import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildItems,
  filterItems,
  fingerprint,
  groupItems,
  normalizeStatus,
  noteToolError,
  pruneSeen,
  rootId,
  sameProject,
  statusPatch,
  summarize,
} from './inbox.mjs';

const emptyModel = () => ({
  sessions: [],
  statuses: new Map(),
  toolErrors: new Map(),
  seen: {},
  loaded: false,
  error: '',
  updatedAt: 0,
});

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function activate(enso) {
  const model = emptyModel();
  const file = join(enso.dataDir, 'seen.json');
  let tail = Promise.resolve();
  let publishQueued = false;

  const exclusive = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const currentItems = () => buildItems({
    sessions: model.sessions,
    statuses: model.statuses,
    toolErrors: model.toolErrors,
    seen: model.seen,
  });

  const viewerFrom = (sessionId) => {
    const id = rootId(sessionId);
    return model.sessions.find((session) => session.id === id) || null;
  };

  const snapshotFor = (sessionId, args) => {
    const items = currentItems();
    const viewer = viewerFrom(sessionId);
    const viewerProjectId = viewer?.projectId || '';
    const visible = filterItems(items, args);
    return {
      loaded: model.loaded,
      error: model.error,
      updatedAt: model.updatedAt,
      viewerSessionId: viewer?.id || rootId(sessionId),
      viewerProjectId,
      viewerProjectName: viewer?.projectName || '',
      items: visible,
      groups: groupItems(visible, viewerProjectId),
      summary: summarize(items),
    };
  };

  const publish = () => {
    if (publishQueued) return;
    publishQueued = true;
    queueMicrotask(() => {
      publishQueued = false;
      const summary = summarize(currentItems());
      Promise.resolve()
        .then(() => enso.ui.status.update('waiting', statusPatch(summary)))
        .catch((error) => console.error('状态项更新失败', errorText(error)));
      Promise.resolve()
        .then(() => enso.ui.view.emit('inbox', { at: model.updatedAt }))
        .catch((error) => console.error('侧栏通知失败', errorText(error)));
    });
  };

  const loadSeen = async () => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      model.seen = pruneSeen(parsed && typeof parsed === 'object' ? parsed : {}, []);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('读取未读记录失败', errorText(error));
      model.seen = {};
    }
  };

  const saveSeen = async () => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(model.seen));
    await rename(tmp, file);
  };

  const mark = async (ids) => {
    const items = currentItems();
    const wanted = ids === 'all' ? items.map((item) => item.id) : ids;
    let changed = false;
    for (const id of wanted) {
      const item = items.find((entry) => entry.id === id);
      if (!item) continue;
      const fp = fingerprint(item);
      if (model.seen[id] !== fp) {
        model.seen[id] = fp;
        changed = true;
      }
    }
    model.seen = pruneSeen(model.seen, items);
    if (changed) await saveSeen();
    model.updatedAt = Date.now();
    publish();
  };

  const refreshBody = async () => {
    let listed;
    try {
      listed = await enso.session.list({ scope: 'all' });
    } catch (error) {
      model.error = errorText(error);
      model.loaded = true;
      model.updatedAt = Date.now();
      publish();
      return;
    }
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions.filter((session) => session && typeof session.id === 'string') : [];
    const nextStatuses = new Map();
    const errors = [];
    for (const session of sessions) {
      if (session.state !== 'waiting' && session.state !== 'error') continue;
      try {
        nextStatuses.set(session.id, normalizeStatus(await enso.session.status(session.id), session.id));
      } catch (error) {
        if (error?.code === 'NOT_FOUND') continue;
        errors.push(errorText(error));
        if (model.statuses.has(session.id)) nextStatuses.set(session.id, model.statuses.get(session.id));
      }
    }
    const live = new Set(sessions.map((session) => session.id));
    for (const id of [...model.toolErrors.keys()]) {
      const state = nextStatuses.get(id)?.state ?? sessions.find((session) => session.id === id)?.state;
      if (!live.has(id) || state !== 'error') model.toolErrors.delete(id);
    }
    model.sessions = sessions;
    model.statuses = nextStatuses;
    model.error = errors[0] || '';
    model.loaded = true;
    model.updatedAt = Date.now();
    publish();
  };

  const onStatus = (data) => {
    const next = normalizeStatus(data);
    if (!next.sessionId) return;
    model.statuses.set(next.sessionId, next);
    if (next.state !== 'error') model.toolErrors.delete(next.sessionId);
    const row = model.sessions.find((session) => session.id === next.sessionId);
    if (!row) return refreshBody();
    row.state = next.state;
    model.error = '';
    model.updatedAt = Date.now();
    publish();
  };

  const onTool = (data, ctx) => {
    const id = rootId(ctx?.sessionId);
    if (!noteToolError(model.toolErrors, id, data, Date.now())) return;
    const state = model.statuses.get(id)?.state || model.sessions.find((session) => session.id === id)?.state;
    if (state !== 'error') return;
    model.updatedAt = Date.now();
    publish();
  };

  const onEnd = (ctx) => {
    if (ctx?.agent) return;
    const id = rootId(ctx?.sessionId);
    if (!id) return;
    const had = model.sessions.some((session) => session.id === id) || model.statuses.has(id);
    model.sessions = model.sessions.filter((session) => session.id !== id);
    model.statuses.delete(id);
    model.toolErrors.delete(id);
    if (!had) return;
    model.updatedAt = Date.now();
    publish();
  };

  const guard = (work) => exclusive(work).catch((error) => console.error(errorText(error)));
  enso.events.on('session_status', (data) => guard(() => onStatus(data)));
  enso.events.on('tool_result', (data, ctx) => guard(() => onTool(data, ctx)));
  enso.events.on('session_end', (_data, ctx) => guard(() => onEnd(ctx)));
  enso.schedules.register('reconcile', () => guard(() => refreshBody()));
  enso.commands.register('open', () => enso.ui.view.open('inbox'));

  enso.renderer.handle('snapshot', (args, ctx) => snapshotFor(ctx?.sessionId, args));
  enso.renderer.handle('refresh', async (args, ctx) => {
    await exclusive(() => refreshBody());
    return snapshotFor(ctx?.sessionId, args);
  });
  enso.renderer.handle('markRead', async (args, ctx) => {
    const all = args?.all === true;
    const id = typeof args?.id === 'string' ? args.id : '';
    await exclusive(() => mark(all ? 'all' : id ? [id] : []));
    return snapshotFor(ctx?.sessionId, args);
  });
  enso.renderer.handle('focus', async (args, ctx) => {
    const sessionId = rootId(args?.sessionId);
    const itemId = typeof args?.id === 'string' ? args.id : '';
    if (!sessionId) return { ok: false, reason: 'missing' };
    const target = model.sessions.find((session) => session.id === sessionId);
    if (!target) return { ok: false, reason: 'missing' };
    const viewer = viewerFrom(ctx?.sessionId);
    if (!sameProject(viewer, target)) {
      if (itemId) await exclusive(() => mark([itemId]));
      return { ok: false, reason: 'other-project', projectName: target.projectName || '未命名项目' };
    }
    try {
      await enso.session.focus(sessionId);
    } catch (error) {
      return { ok: false, reason: 'failed', message: errorText(error) };
    }
    if (itemId) await exclusive(() => mark([itemId]));
    return { ok: true };
  });

  exclusive(async () => {
    await loadSeen();
    await refreshBody();
  }).catch((error) => console.error(errorText(error)));
}
