import { displayBytes } from './lib/format.mjs';
import { findDatabases, loadDatabaseBytes, normalizeRel } from './lib/files.mjs';
import { disposeSessions, takeSession } from './lib/session.mjs';

function argsOf(args) {
  if (args == null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('参数不合法');
  return args;
}

function walNotice(file) {
  if (file.wal && file.journal) return '旁边有未合并的 -wal 和 -journal 文件，最近的写入可能还没进入主文件。';
  if (file.wal) return '旁边有未合并的 -wal 文件，最近的写入可能还没进入主文件。';
  if (file.journal) return '旁边有 -journal 文件，最近的写入可能还没进入主文件。';
  return null;
}

function withSignal(signal, work) {
  if (signal?.aborted) throw new Error('已取消');
  return work();
}

export function activate(enso) {
  const open = async (args, ctx) => {
    const input = argsOf(args);
    const file = await loadDatabaseBytes(enso, ctx?.projectRoot, input.rel);
    const session = takeSession(ctx?.sessionId, file.rel);
    const opened = await withSignal(ctx?.signal, () => session.open(file.bytes, file));
    return {
      rel: file.rel,
      name: file.name,
      size: file.size,
      sizeLabel: displayBytes(file.size),
      wal: file.wal,
      journal: file.journal,
      notice: walNotice(file),
      readOnly: true,
      objects: opened.objects,
    };
  };

  enso.renderer.handle('open', (args, ctx) => open(args, ctx));
  enso.renderer.handle('find', async (_args, ctx) => ({ files: await findDatabases(ctx?.projectRoot) }));

  const ready = async (args, ctx) => {
    const input = argsOf(args);
    const rel = normalizeRel(input.rel);
    const session = takeSession(ctx?.sessionId, rel);
    if (!session.bytes) {
      const file = await loadDatabaseBytes(enso, ctx?.projectRoot, rel);
      await withSignal(ctx?.signal, () => session.open(file.bytes, file));
    }
    return { session, input: { ...input, rel } };
  };

  enso.renderer.handle('rows', async (args, ctx) => {
    const { session, input } = await ready(args, ctx);
    return withSignal(ctx?.signal, () => session.request('rows', input));
  });
  enso.renderer.handle('query', async (args, ctx) => {
    const { session, input } = await ready(args, ctx);
    return withSignal(ctx?.signal, () => session.request('query', input));
  });
  enso.renderer.handle('schema', async (args, ctx) => {
    const { session } = await ready(args, ctx);
    return withSignal(ctx?.signal, () => session.request('schema', {}));
  });
  enso.renderer.handle('cell', async (args, ctx) => {
    const { session, input } = await ready(args, ctx);
    return withSignal(ctx?.signal, () => session.request('cell', input));
  });
  enso.renderer.handle('export', async (args, ctx) => {
    const { session, input } = await ready(args, ctx);
    return withSignal(ctx?.signal, () => session.request('export', input));
  });
  enso.renderer.handle('cancel', async (args, ctx) => {
    const input = argsOf(args);
    let rel = '';
    try {
      rel = normalizeRel(input.rel);
    } catch {
      return { cancelled: false };
    }
    takeSession(ctx?.sessionId, rel).cancel();
    return { cancelled: true };
  });
}

export function deactivate() {
  disposeSessions();
}
