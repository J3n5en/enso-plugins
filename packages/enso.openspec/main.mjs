import { assignPlaces, commandText, explainHostError, readBoard, readDetail, safeChangeName } from './board.mjs';
import { createOpenspecFiles } from './files.mjs';

const mainId = (sessionId) => (sessionId ? String(sessionId).split('::')[0] : null);

async function sessionContext(enso, ctx) {
  const listed = await enso.session.list();
  const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
  const current = mainId(listed?.current) ?? mainId(ctx?.sessionId);
  return { sessions, current };
}

async function placedChange(enso, ctx, name) {
  if (!ctx?.projectRoot) throw Object.assign(new Error('请先打开一个项目'), { code: 'NO_PROJECT' });
  if (!safeChangeName(name)) throw Object.assign(new Error('变更名称不合法'), { code: 'INVALID_ARGS' });
  const files = createOpenspecFiles(ctx.projectRoot, (path) => enso.fs.readText(path));
  const snapshot = await readBoard(files);
  const { sessions, current } = await sessionContext(enso, ctx);
  const [change] = assignPlaces(
    snapshot.changes.filter((item) => item.name === name),
    { sessions, currentId: current, applyAnywhere: snapshot.applyAnywhere },
  );
  if (!change) throw Object.assign(new Error(`找不到变更：${name}`), { code: 'NOT_FOUND' });
  return change;
}

export function activate(enso) {
  enso.renderer.handle('board', async (_args, ctx) => {
    const sessionId = mainId(ctx?.sessionId);
    if (!ctx?.projectRoot) {
      return { status: 'no-project', hasChangesDir: false, problems: [], notes: [], changes: [], sessionId, checkedAt: Date.now() };
    }
    try {
      const files = createOpenspecFiles(ctx.projectRoot, (path) => enso.fs.readText(path));
      const snapshot = await readBoard(files);
      let sessions = [];
      let current = sessionId;
      try {
        const listed = await sessionContext(enso, ctx);
        sessions = listed.sessions;
        current = listed.current ?? current;
      } catch (error) {
        snapshot.problems = [...snapshot.problems, `读不到本项目的会话：${explainHostError(error)}`];
      }
      return {
        status: snapshot.status,
        hasChangesDir: snapshot.hasChangesDir,
        problems: snapshot.problems,
        notes: snapshot.notes,
        changes: assignPlaces(snapshot.changes, { sessions, currentId: current, applyAnywhere: snapshot.applyAnywhere }),
        sessionId: current,
        checkedAt: Date.now(),
      };
    } catch (error) {
      return {
        status: 'error',
        message: explainHostError(error),
        hasChangesDir: false,
        problems: [],
        notes: [],
        changes: [],
        sessionId,
        checkedAt: Date.now(),
      };
    }
  });

  enso.renderer.handle('detail', async (args, ctx) => {
    if (!ctx?.projectRoot) throw Object.assign(new Error('请先打开一个项目'), { code: 'NO_PROJECT' });
    const files = createOpenspecFiles(ctx.projectRoot, (path) => enso.fs.readText(path));
    return readDetail(files, args?.name, args?.path);
  });

  enso.renderer.handle('act', async (args, ctx) => {
    const op = args?.op;
    if (op !== 'apply' && op !== 'finish' && op !== 'task' && op !== 'focus') {
      throw Object.assign(new Error('未知操作'), { code: 'INVALID_ARGS' });
    }
    const change = await placedChange(enso, ctx, args?.name);
    if (op === 'focus') {
      if (change.place.kind !== 'elsewhere' || !change.place.sessionId) throw new Error('这个变更没有可切换的会话');
      await enso.session.focus(change.place.sessionId);
      return { ok: true, message: `已切换到「${change.place.title}」` };
    }
    const built = commandText(change, op, Number(args?.taskIndex));
    if (built.refused) throw new Error(built.refused);
    if (change.place.kind === 'none') throw new Error(change.place.reason || '现在不能发送');
    if (change.place.kind === 'new') {
      const created = await enso.session.create({ text: built.text });
      return { ok: true, message: '已新建会话，提示词在输入框里，确认后才会发送。', sessionId: created?.sessionId ?? null };
    }
    const sessionId = change.place.kind === 'elsewhere' ? change.place.sessionId : undefined;
    try {
      await enso.session.inject({
        ...(sessionId ? { sessionId } : {}),
        text: built.text,
        deliverAs: 'followUp',
        triggerTurn: true,
      });
    } catch (error) {
      throw Object.assign(new Error(explainHostError(error)), { code: error?.code });
    }
    const where = change.place.kind === 'current' ? '当前会话' : `「${change.place.title}」`;
    return { ok: true, message: `已发送到${where}` };
  });
}
