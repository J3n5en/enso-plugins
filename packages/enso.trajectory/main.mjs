import { childTrajectory, compose, loadParsed, pickSession } from './assemble.mjs';
import { findUserData, listChildRuns } from './locate.mjs';
import { createLive } from './live.mjs';

const EVENTS = [
  'input',
  'tool_call',
  'tool_result',
  'agent_start',
  'agent_end',
  'context_usage',
  'session_status',
  'model_select',
  'before_compact',
  'after_compact',
];

const empty = (warning, sessions = []) => ({
  sessionId: '',
  title: '',
  state: null,
  pendingAsks: 0,
  pendingApprovals: 0,
  model: '',
  cwd: '',
  file: false,
  truncated: false,
  warning,
  context: null,
  stats: {
    turns: 0,
    requests: 0,
    tools: 0,
    agents: 0,
    cacheHit: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    activeMs: 0,
  },
  lanes: { start: null, end: null, input: [], model: [], tools: [] },
  turns: [],
  sessions,
});

let stopTimer = null;

export function activate(enso) {
  const live = createLive();
  const cache = new Map();
  let timer = null;
  let lastEmit = 0;
  stopTimer = () => clearTimeout(timer);

  const poke = (sessionId) => {
    const wait = Math.max(40, 280 - (Date.now() - lastEmit));
    clearTimeout(timer);
    timer = setTimeout(() => {
      lastEmit = Date.now();
      Promise.resolve(enso.ui.view.emit('refresh', { sessionId: sessionId || '' })).catch(() => {});
    }, wait);
  };

  for (const event of EVENTS) {
    enso.events.on(event, (data, ctx) => {
      live.note(event, data, ctx);
      if (ctx?.agent) return;
      poke(event === 'session_status' ? data?.sessionId : ctx?.sessionId);
    });
  }

  const listedSessions = async (ctx) => {
    try {
      const listed = await enso.session.list();
      return {
        current: listed?.current || ctx?.sessionId || '',
        sessions: Array.isArray(listed?.sessions) ? listed.sessions : [],
      };
    } catch {
      return { current: ctx?.sessionId || '', sessions: [] };
    }
  };

  const build = async (args, ctx) => {
    const { current, sessions } = await listedSessions(ctx);
    const sessionId = pickSession(args?.sessionId, current, sessions);
    if (!sessionId) return { view: empty(ctx?.sessionId ? '还没有可显示的会话。' : '先打开一个会话。'), details: {}, merged: null, userData: null };
    const info = sessions.find((session) => session.id === sessionId);
    const userData = findUserData(enso.dataDir);
    const loaded = userData ? loadParsed(userData, sessionId, cache) : { parsed: null, file: false };
    const runs = userData ? listChildRuns(userData, sessionId) : [];
    const snap = live.snapshot(sessionId);
    let status = null;
    try {
      status = await enso.session.status(sessionId);
    } catch {
      status = null;
    }
    const state = status?.state || snap?.state || info?.state || null;
    const warning = !userData
      ? '找不到 Enso 的会话目录。'
      : !loaded.file
        ? '这条会话还没有落盘记录。发出消息后，进行中的轮次会先出现在这里。'
        : loaded.parsed?.truncated
          ? '会话文件很大，只显示最近一段。'
          : '';
    const { view, details, merged } = compose({
      parsed: loaded.parsed,
      live: snap,
      runs,
      meta: {
        sessionId,
        title: info?.title || '',
        state,
        pendingAsks: status?.pendingAsks ?? snap?.pendingAsks ?? 0,
        pendingApprovals: status?.pendingApprovals ?? snap?.pendingApprovals ?? 0,
        model: snap?.model || '',
        file: loaded.file === true,
        warning: loaded.file ? warning : snap?.turns?.length ? '' : warning,
        context: snap?.context ?? null,
        sessions: sessions.map((session) => ({
          id: session.id,
          title: session.title || '未命名会话',
          state: session.id === sessionId ? state : session.state || null,
          updatedAt: session.updatedAt || 0,
          current: session.id === current,
        })),
      },
    });
    if (!view.sessions.some((session) => session.id === sessionId)) {
      view.sessions.unshift({
        id: sessionId,
        title: info?.title || '当前会话',
        state,
        updatedAt: Date.now(),
        current: sessionId === current,
      });
    }
    return { view, details, merged, userData };
  };

  enso.renderer.handle('snapshot', async (args, ctx) => (await build(args, ctx)).view);

  enso.renderer.handle('detail', async (args, ctx) => {
    const id = typeof args?.id === 'string' ? args.id : '';
    if (!id) return null;
    const { view, details, merged, userData } = await build(args, ctx);
    const row = details[id];
    if (!row) return null;
    let child = null;
    const item = merged?.turns.flatMap((turn) => turn.items).find((entry) => entry.id === id);
    if (item?.child && userData) child = childTrajectory(userData, view.sessionId, item.child);
    return {
      id,
      title: row.title || item?.title || '',
      text: row.text || '',
      input: row.input || '',
      output: row.output || '',
      thinking: row.thinking || '',
      error: row.error || '',
      extra: row.extra || '',
      child,
    };
  });

  }

export function deactivate() {
  stopTimer?.();
  stopTimer = null;
}
