import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  addColumn,
  clearClosed,
  clearUnseen,
  deleteColumn,
  focusBlock,
  mergeSessions,
  moveCard,
  moveColumn,
  normalizeBoard,
  removeCard,
  renameColumn,
  rootId,
  sameStored,
  sessionState,
  setCollapsed,
  setNote,
  setPrefs,
  unpin,
} from './board.mjs';

const EMPTY = { current: null, sessions: [] };

function mapError(error) {
  const code = error?.code;
  if (code === 'NOT_FOUND') return new Error('会话不存在或不在当前项目，暂时无法切换过去');
  if (code === 'UNSUPPORTED') return new Error('当前 Enso 版本不能列出全部项目的会话');
  if (code === 'RATE_LIMITED') return new Error('操作太频繁，请稍后再试');
  if (code === 'CIRCUIT_OPEN') return new Error('操作暂时不可用，请稍后再试');
  if (code === 'CREATE_FAILED') return new Error('新建会话失败');
  if (code === 'NO_SESSION') return new Error('请先打开一个会话');
  if (code === 'INVALID_ARGS') return new Error(error.message || '参数不合法');
  if (error instanceof Error) return error;
  return new Error(typeof error?.message === 'string' ? error.message : '操作失败');
}

function present(board, listed) {
  const current = rootId(listed?.current);
  const sessions = new Map((listed?.sessions ?? []).map((session) => [session.id, session]));
  const cards = Object.values(board.cards)
    .map((card) => {
      const live = sessions.get(card.id);
      return {
        id: card.id,
        column: card.column,
        order: card.order,
        note: card.note,
        unseenAt: card.unseenAt,
        manual: card.manual,
        closed: card.closed,
        closedAt: card.closedAt,
        title: typeof live?.title === 'string' ? live.title : card.title,
        projectId: live?.projectId ?? (card.projectId || null),
        projectName: typeof live?.projectName === 'string' ? live.projectName : card.projectName,
        state: live ? sessionState(live) : 'idle',
        running: live?.running === true,
        archived: live?.archived === true,
        updatedAt: Number.isFinite(live?.updatedAt) ? live.updatedAt : 0,
        current: card.id === current,
      };
    })
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  return {
    rev: board.rev,
    columns: board.columns,
    cards,
    current,
    followState: board.followState !== false,
    moveOnStart: board.moveOnStart !== false,
  };
}

export function activate(enso) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  const file = join(enso.dataDir, 'board.json');
  const load = async () => {
    try {
      return normalizeBoard(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeBoard(null);
      throw new Error('看板数据读不出来，没有改动它');
    }
  };
  const save = async (board) => {
    const next = { ...board, rev: board.rev + 1 };
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, file);
    return next;
  };
  const commit = async (board, next) => (sameStored(board, next) ? board : save(next));

  const sessions = async () => {
    try {
      const listed = await enso.session.list({ scope: 'all' });
      return listed && Array.isArray(listed.sessions) ? listed : EMPTY;
    } catch (error) {
      throw mapError(error);
    }
  };

  const refresh = async (board) => {
    const listed = await sessions();
    const merged = mergeSessions(board, { sessions: listed.sessions, current: listed.current, now: Date.now() });
    const stored = sameStored(board, merged) ? board : await save(merged);
    return present(stored, listed);
  };

  const mutate = (fn) =>
    locked(async () => {
      const board = await load();
      return refresh(await commit(board, fn(board)));
    });

  enso.renderer.handle('sync', () => locked(async () => refresh(await load())));
  enso.renderer.handle('move', (args) => mutate((board) => moveCard(board, String(args?.id ?? ''), String(args?.column ?? ''), args?.beforeId || null)));
  enso.renderer.handle('note', (args) => mutate((board) => setNote(board, String(args?.id ?? ''), args?.note)));
  enso.renderer.handle('seen', (args) => mutate((board) => clearUnseen(board, String(args?.id ?? ''))));
  enso.renderer.handle('unpin', (args) => mutate((board) => unpin(board, String(args?.id ?? ''))));
  enso.renderer.handle('remove', (args) => mutate((board) => removeCard(board, String(args?.id ?? ''))));
  enso.renderer.handle('clearClosed', () => mutate((board) => clearClosed(board)));
  enso.renderer.handle('prefs', (args) =>
    mutate((board) => setPrefs(board, { followState: args?.followState, moveOnStart: args?.moveOnStart }))
  );
  enso.renderer.handle('column', (args) =>
    mutate((board) => {
      const action = args?.action;
      const id = String(args?.id ?? '');
      if (action === 'add') return addColumn(board, args?.name, Number.isInteger(args?.index) ? args.index : undefined);
      if (action === 'rename') return renameColumn(board, id, args?.name);
      if (action === 'delete') return deleteColumn(board, id);
      if (action === 'move') {
        if (!Number.isInteger(args?.index)) throw new Error('请指定位置');
        return moveColumn(board, id, args.index);
      }
      if (action === 'collapse') return setCollapsed(board, id, args?.collapsed === true);
      throw new Error('未知的列操作');
    })
  );

  enso.renderer.handle('focus', async (args) => {
    const listed = await sessions();
    const gate = focusBlock(listed.sessions, listed.current, String(args?.sessionId ?? ''));
    if (!gate.ok) throw new Error(gate.message);
    try {
      await enso.session.focus(gate.sessionId);
    } catch (error) {
      throw mapError(error);
    }
    return locked(async () => {
      const board = await load();
      return refresh(await commit(board, clearUnseen(board, gate.sessionId)));
    });
  });

  enso.renderer.handle('create', async (args) => {
    const text = typeof args?.text === 'string' ? args.text : '';
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error('预填内容超过 32KB');
    const trimmed = text.trim();
    try {
      await enso.session.create(trimmed ? { text: trimmed } : {});
    } catch (error) {
      throw mapError(error);
    }
    return locked(async () => refresh(await load()));
  });
}
