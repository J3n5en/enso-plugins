import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDiff, inspectRepo, normalizeSpec } from './collect.mjs';
import { buildWalkthrough, mergeEdits, recordEdit, toMarkdown } from './diff.mjs';

const MAX_ENTRIES = 6;

function projectKey(root) {
  return createHash('sha256').update(String(root)).digest('hex').slice(0, 16);
}

function emptyStore() {
  return { latestId: null, spec: null, edits: { walks: {}, steps: {} }, entries: {}, cursor: {}, read: [] };
}

async function loadStore(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    parsed.edits ||= { walks: {}, steps: {} };
    parsed.edits.walks ||= {};
    parsed.edits.steps ||= {};
    parsed.entries ||= {};
    parsed.cursor ||= {};
    parsed.read ||= [];
    return parsed;
  } catch {
    return emptyStore();
  }
}

async function saveStore(file, store) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, file);
}

function present(store, id) {
  const entry = id ? store.entries[id] : null;
  if (!entry?.base) return null;
  const walk = mergeEdits(entry.base, store.edits);
  const cursor = Math.min(Math.max(0, store.cursor[id] ?? 0), Math.max(0, walk.steps.length - 1));
  const read = (store.read || []).filter((stepId) => walk.steps.some((step) => step.id === stepId));
  return { walk, cursor, read };
}

function remember(store, base) {
  store.entries[base.id] = { base, at: Date.now() };
  store.latestId = base.id;
  const ids = Object.entries(store.entries)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .map(([id]) => id);
  for (const id of ids.slice(MAX_ENTRIES)) delete store.entries[id];
  if (store.cursor[base.id] == null) store.cursor[base.id] = 0;
}

async function currentSession(enso, ctx) {
  try {
    const listed = await enso.session.list();
    return ctx?.sessionId || listed?.current || null;
  } catch {
    return ctx?.sessionId || null;
  }
}

function requireProject(ctx) {
  if (!ctx?.projectRoot) throw new Error('请先打开一个项目');
  return ctx.projectRoot;
}

export function activate(enso) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const fileFor = (ctx) => join(enso.dataDir, 'walks', `${projectKey(requireProject(ctx))}.json`);
  const readText = (path) => enso.fs.readText(path);

  const build = (specInput, ctx) =>
    locked(async () => {
      const root = requireProject(ctx);
      const spec = normalizeSpec(specInput || { kind: 'session' });
      const sessionId = spec.kind === 'session' ? await currentSession(enso, ctx) : null;
      const collected = await collectDiff(root, spec, { readText, sessionId });
      const base = buildWalkthrough(collected);
      const file = fileFor(ctx);
      const store = await loadStore(file);
      store.spec = spec;
      remember(store, base);
      await saveStore(file, store);
      return { spec, ...present(store, base.id) };
    });

  enso.renderer.handle('state', async (args, ctx) => {
    if (!ctx?.projectRoot) return { error: '请先打开一个项目' };
    const file = fileFor(ctx);
    const store = await loadStore(file);
    let meta = { git: false, reason: '无法读取仓库' };
    try {
      meta = await inspectRepo(ctx.projectRoot);
    } catch (error) {
      meta = { git: false, reason: error.message };
    }
    let sessionId = null;
    try {
      sessionId = await currentSession(enso, ctx);
    } catch {
      sessionId = null;
    }
    let spec = { kind: meta.suggested || 'session' };
    if (args?.spec) {
      try {
        spec = normalizeSpec(args.spec);
      } catch (error) {
        return { error: error.message, meta: { ...meta, sessionId }, walk: null, cursor: 0, read: [] };
      }
    } else if (store.spec) {
      try {
        spec = normalizeSpec(store.spec);
      } catch {
        spec = { kind: meta.suggested || 'session' };
      }
    }
    const view = present(store, store.latestId);
    return { spec, meta: { ...meta, sessionId }, ...(view || { walk: null, cursor: 0, read: [] }) };
  });

  enso.renderer.handle('build', async (args, ctx) => {
    try {
      const view = await build(args?.spec || args, ctx);
      await enso.ui.view.emit('changed', { id: view.walk.id });
      return view;
    } catch (error) {
      return { error: error.message || '无法生成讲解' };
    }
  });

  enso.renderer.handle('save', async (args, ctx) => {
    try {
      return await locked(async () => {
        const file = fileFor(ctx);
        const store = await loadStore(file);
        const walkId = args?.walkId || store.latestId;
        if (!walkId || !store.entries[walkId]) throw new Error('还没有讲解');
        if (args?.title != null || args?.body != null || args?.summary != null) {
          store.edits = recordEdit(store.edits, { ...args, walkId, stepId: args?.stepId || null });
        }
        if (Number.isInteger(args?.cursor)) store.cursor[walkId] = args.cursor;
        if (Array.isArray(args?.read)) store.read = args.read.filter((id) => typeof id === 'string').slice(0, 200);
        store.latestId = walkId;
        await saveStore(file, store);
        const view = present(store, walkId);
        await enso.ui.view.emit('changed', { id: walkId });
        return view;
      });
    } catch (error) {
      return { error: error.message || '无法保存' };
    }
  });

  enso.renderer.handle('copy', async (args, ctx) => {
    const file = fileFor(ctx);
    const store = await loadStore(file);
    const view = present(store, args?.walkId || store.latestId);
    if (!view?.walk) throw new Error('还没有讲解');
    const text = toMarkdown(view.walk, { stepId: args?.stepId || null });
    await enso.ui.clipboard.writeText(text);
    return { ok: true, chars: text.length };
  });

  const outline = (walk) => {
    const lines = [walk.title, walk.summary];
    if (walk.notice) lines.push(walk.notice);
    for (const step of walk.steps) {
      lines.push(`${step.index + 1}. [${step.id}] ${step.title}`, step.body);
    }
    return {
      content: lines.filter(Boolean).join('\n\n'),
      details: {
        id: walk.id,
        stats: walk.stats,
        steps: walk.steps.map((step) => ({
          id: step.id,
          index: step.index,
          title: step.title,
          body: step.body,
          edited: Boolean(step.edited),
          files: step.files,
        })),
      },
    };
  };

  enso.tools.register('walkthrough_build', async (args, ctx) => {
    if (ctx?.progress) await ctx.progress('正在根据 diff 组织讲解');
    const view = await build(args, ctx);
    return outline(view.walk);
  });

  enso.tools.register('walkthrough_edit', async (args, ctx) => {
    if (args?.body != null && !args?.stepId) throw new Error('修改步骤说明需要 stepId');
    const file = fileFor(ctx);
    const updated = await locked(async () => {
      const store = await loadStore(file);
      const walkId = args?.walkId || store.latestId;
      if (!walkId || !store.entries[walkId]) throw new Error('还没有讲解，先生成一次');
      store.edits = recordEdit(store.edits, {
        walkId,
        stepId: args?.stepId || null,
        title: args?.title,
        body: args?.body,
        summary: args?.summary,
      });
      store.latestId = walkId;
      await saveStore(file, store);
      return present(store, walkId);
    });
    await enso.ui.view.emit('changed', { id: updated.walk.id });
    return outline(updated.walk);
  });

  enso.tools.register('walkthrough_current', async (_args, ctx) => {
    const store = await loadStore(fileFor(ctx));
    const view = present(store, store.latestId);
    if (!view?.walk) return { content: '还没有讲解。', details: { id: null, steps: [] } };
    return outline(view.walk);
  });

  enso.commands.register('open', async () => {
    await enso.ui.view.open('walk');
  });
}
