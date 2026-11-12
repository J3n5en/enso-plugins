import { randomBytes } from 'node:crypto';

export const MAX_COLUMNS = 20;
export const MAX_CARDS = 500;
export const MAX_NOTE = 2000;
export const MAX_NAME = 40;

/** 列 id 稳定，自动归列靠 id 而不是显示名。 */
export const DEFAULT_COLUMNS = [
  { id: 'backlog', name: '待处理' },
  { id: 'doing', name: '进行中' },
  { id: 'waiting', name: '等你处理' },
  { id: 'done', name: '已完成' },
];

const STATES = new Set(['running', 'waiting', 'error', 'idle']);

export function defaultColumns() {
  return DEFAULT_COLUMNS.map((column) => ({ id: column.id, name: column.name }));
}

export function emptyBoard() {
  return {
    version: 1,
    rev: 0,
    columns: defaultColumns(),
    cards: {},
    followState: true,
    moveOnStart: true,
  };
}

export function rootId(id) {
  if (typeof id !== 'string' || !id) return null;
  const root = id.split('::')[0];
  return root || null;
}

export function safeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
}

export function sessionState(session) {
  if (STATES.has(session?.state)) return session.state;
  if (session?.running) return 'running';
  return 'idle';
}

function textOf(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function makeCard(partial) {
  return {
    id: partial.id,
    column: partial.column,
    order: partial.order,
    note: textOf(partial.note, MAX_NOTE),
    unseenAt: Number.isFinite(partial.unseenAt) ? partial.unseenAt : null,
    manual: partial.manual === true,
    closed: partial.closed === true,
    closedAt: Number.isFinite(partial.closedAt) ? partial.closedAt : null,
    lastState: STATES.has(partial.lastState) ? partial.lastState : 'idle',
    addedAt: Number.isFinite(partial.addedAt) ? partial.addedAt : 0,
    title: textOf(partial.title, 200),
    projectId: textOf(partial.projectId, 200),
    projectName: textOf(partial.projectName, 200),
  };
}

function columnShape(column) {
  const item = { id: column.id, name: column.name };
  if (column.collapsed === true) item.collapsed = true;
  return item;
}

function hasColumn(columns, id) {
  return columns.some((column) => column.id === id);
}

function nextOrder(cards, column) {
  let max = -1;
  for (const card of Object.values(cards)) {
    if (card.column === column && card.order > max) max = card.order;
  }
  return max + 1;
}

function capCards(cards) {
  const list = Object.values(cards);
  if (list.length <= MAX_CARDS) return cards;
  const closed = list
    .filter((card) => card.closed)
    .sort((a, b) => {
      const note = (a.note ? 1 : 0) - (b.note ? 1 : 0);
      if (note) return note;
      return (a.closedAt ?? 0) - (b.closedAt ?? 0);
    });
  const drop = new Set();
  let extra = list.length - MAX_CARDS;
  for (const card of closed) {
    if (extra <= 0) break;
    drop.add(card.id);
    extra -= 1;
  }
  const next = {};
  for (const id of Object.keys(cards).sort()) {
    if (!drop.has(id)) next[id] = cards[id];
  }
  return next;
}

function cleanName(name) {
  return String(name ?? '').trim().slice(0, MAX_NAME);
}

/** 新会话第一次出现时按当前状态落列；空闲的进「待处理」（还在就用它，否则用第一列）。 */
export function columnForNew(session, columns) {
  const state = sessionState(session);
  if (state === 'running' && hasColumn(columns, 'doing')) return 'doing';
  if ((state === 'waiting' || state === 'error') && hasColumn(columns, 'waiting')) return 'waiting';
  if (session?.archived && hasColumn(columns, 'done')) return 'done';
  if (hasColumn(columns, 'backlog')) return 'backlog';
  return columns[0].id;
}

/**
 * 未固定的卡片在「跟随状态」打开时按状态换列。
 * 「待处理里一开始运行就移走」看的是进入 running 的瞬间，固定的卡片也走这条，避免已经开工的会话留在待处理。
 */
function autoColumn(card, session, columns, followState, moveOnStart) {
  const state = sessionState(session);
  if (!card.manual && followState) {
    if (state === 'running' && hasColumn(columns, 'doing')) return 'doing';
    if ((state === 'waiting' || state === 'error') && hasColumn(columns, 'waiting')) return 'waiting';
    if (session?.archived && state !== 'running' && hasColumn(columns, 'done')) return 'done';
  }
  if (
    moveOnStart &&
    card.column === 'backlog' &&
    card.lastState !== 'running' &&
    state === 'running' &&
    hasColumn(columns, 'doing')
  ) {
    return 'doing';
  }
  return null;
}

function place(cards, id, columnId) {
  const card = cards[id];
  if (!card || card.column === columnId) return cards;
  const next = { ...cards };
  delete next[id];
  const rest = Object.values(next)
    .filter((item) => item.column === columnId)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  rest.push(card);
  rest.forEach((item, index) => {
    next[item.id] = makeCard({ ...item, column: columnId, order: index });
  });
  return next;
}

export function normalizeBoard(raw) {
  const fresh = emptyBoard();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh;
  const columns = [];
  const seen = new Set();
  if (Array.isArray(raw.columns)) {
    for (const column of raw.columns) {
      if (!column || typeof column.id !== 'string') continue;
      const id = column.id.trim().slice(0, 40);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      columns.push(columnShape({ id, name: cleanName(column.name) || id, collapsed: column.collapsed === true }));
      if (columns.length >= MAX_COLUMNS) break;
    }
  }
  const cols = columns.length ? columns : fresh.columns;
  const ids = new Set(cols.map((column) => column.id));
  const first = cols[0].id;
  const cards = {};
  if (raw.cards && typeof raw.cards === 'object' && !Array.isArray(raw.cards)) {
    for (const [key, card] of Object.entries(raw.cards)) {
      if (!card || typeof card !== 'object') continue;
      const id = safeId(card.id) ? card.id : key;
      if (!safeId(id) || cards[id]) continue;
      cards[id] = makeCard({
        id,
        column: ids.has(card.column) ? card.column : first,
        order: Number.isFinite(card.order) ? card.order : 0,
        note: card.note,
        unseenAt: card.unseenAt,
        manual: card.manual,
        closed: card.closed,
        closedAt: card.closedAt,
        lastState: card.lastState,
        addedAt: card.addedAt,
        title: card.title,
        projectId: card.projectId,
        projectName: card.projectName,
      });
    }
  }
  return {
    version: 1,
    rev: Number.isFinite(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    columns: cols.map(columnShape),
    cards: capCards(cards),
    followState: raw.followState !== false,
    moveOnStart: raw.moveOnStart !== false,
  };
}

function snapshot(board) {
  const cards = {};
  for (const id of Object.keys(board.cards).sort()) cards[id] = board.cards[id];
  return JSON.stringify({
    columns: board.columns,
    cards,
    followState: board.followState !== false,
    moveOnStart: board.moveOnStart !== false,
  });
}

export function sameStored(a, b) {
  return snapshot(a) === snapshot(b);
}

export function mergeSessions(board, input = {}) {
  const base = normalizeBoard(board);
  const columns = base.columns;
  const followState = base.followState !== false;
  const moveOnStart = base.moveOnStart !== false;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const currentRoot = rootId(input.current);
  const sessions = [];
  const seen = new Set();
  for (const session of input.sessions ?? []) {
    if (!safeId(session?.id) || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  let cards = { ...base.cards };

  for (const session of sessions) {
    const id = session.id;
    const state = sessionState(session);
    const prev = cards[id];
    if (!prev) {
      const column = columnForNew(session, columns);
      cards[id] = makeCard({
        id,
        column,
        order: nextOrder(cards, column),
        lastState: state,
        addedAt: now,
        title: session.title,
        projectId: session.projectId,
        projectName: session.projectName,
      });
      continue;
    }
    let unseenAt = prev.unseenAt;
    if (id === currentRoot || state === 'running') unseenAt = null;
    else if (prev.lastState === 'running' && state !== 'running') unseenAt = prev.unseenAt || now;

    cards[id] = makeCard({ ...prev, closed: false, closedAt: null, unseenAt });
    const target = autoColumn(cards[id], session, columns, followState, moveOnStart);
    if (target && target !== cards[id].column) cards = place(cards, id, target);
    cards[id] = makeCard({
      ...cards[id],
      lastState: state,
      unseenAt,
      closed: false,
      closedAt: null,
      ...(typeof session.title === 'string' ? { title: session.title } : {}),
      ...(typeof session.projectId === 'string' ? { projectId: session.projectId } : {}),
      ...(typeof session.projectName === 'string' ? { projectName: session.projectName } : {}),
    });
  }

  for (const card of Object.values(cards)) {
    if (seen.has(card.id) || card.closed) continue;
    let unseenAt = card.unseenAt;
    if (card.id === currentRoot) unseenAt = null;
    else if (card.lastState === 'running') unseenAt = card.unseenAt || now;
    cards[card.id] = makeCard({
      ...card,
      closed: true,
      closedAt: card.closedAt || now,
      unseenAt,
      lastState: 'idle',
    });
  }

  return { ...base, columns, cards: capCards(cards) };
}

export function moveCard(board, id, columnId, beforeId) {
  const base = normalizeBoard(board);
  const card = base.cards[id];
  if (!card) throw new Error('会话不在看板上');
  if (!base.columns.some((column) => column.id === columnId)) throw new Error('列不存在');
  const rest = Object.values(base.cards)
    .filter((item) => item.column === columnId && item.id !== id)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const at = beforeId ? rest.findIndex((item) => item.id === beforeId) : -1;
  const index = at < 0 ? rest.length : at;
  const sameColumn = card.column === columnId;
  const currentIndex = sameColumn
    ? Object.values(base.cards)
        .filter((item) => item.column === columnId)
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
        .findIndex((item) => item.id === id)
    : -1;
  if (sameColumn && currentIndex === index) return base;
  rest.splice(index, 0, card);
  const cards = { ...base.cards };
  rest.forEach((item, order) => {
    cards[item.id] = makeCard({
      ...item,
      column: columnId,
      order,
      manual: item.id === id ? true : item.manual,
    });
  });
  return { ...base, cards };
}

export function setNote(board, id, note) {
  const base = normalizeBoard(board);
  const card = base.cards[id];
  if (!card) throw new Error('会话不在看板上');
  const text = String(note ?? '').slice(0, MAX_NOTE);
  if (text === card.note) return base;
  return { ...base, cards: { ...base.cards, [id]: makeCard({ ...card, note: text }) } };
}

export function clearUnseen(board, id) {
  const base = normalizeBoard(board);
  const card = base.cards[id];
  if (!card || card.unseenAt == null) return base;
  return { ...base, cards: { ...base.cards, [id]: makeCard({ ...card, unseenAt: null }) } };
}

export function unpin(board, id) {
  const base = normalizeBoard(board);
  const card = base.cards[id];
  if (!card || !card.manual) return base;
  return { ...base, cards: { ...base.cards, [id]: makeCard({ ...card, manual: false }) } };
}

export function removeCard(board, id) {
  const base = normalizeBoard(board);
  const card = base.cards[id];
  if (!card) throw new Error('会话不在看板上');
  if (!card.closed) throw new Error('进行中的会话不能从看板上移除');
  const cards = { ...base.cards };
  delete cards[id];
  return { ...base, cards };
}

export function clearClosed(board) {
  const base = normalizeBoard(board);
  const cards = {};
  for (const [id, card] of Object.entries(base.cards)) {
    if (!card.closed) cards[id] = card;
  }
  if (Object.keys(cards).length === Object.keys(base.cards).length) return base;
  return { ...base, cards };
}

export function setPrefs(board, prefs = {}) {
  const base = normalizeBoard(board);
  const followState = prefs.followState === undefined ? base.followState : !!prefs.followState;
  const moveOnStart = prefs.moveOnStart === undefined ? base.moveOnStart : !!prefs.moveOnStart;
  if (followState === base.followState && moveOnStart === base.moveOnStart) return base;
  return { ...base, followState, moveOnStart };
}

export function addColumn(board, name, index) {
  const base = normalizeBoard(board);
  const title = cleanName(name);
  if (!title) throw new Error('请填写列名');
  if (base.columns.length >= MAX_COLUMNS) throw new Error(`最多 ${MAX_COLUMNS} 列`);
  if (base.columns.some((column) => column.name === title)) throw new Error(`列已存在：${title}`);
  const columns = base.columns.slice();
  const at = Number.isInteger(index) ? Math.max(0, Math.min(columns.length, index)) : columns.length;
  columns.splice(at, 0, { id: randomBytes(4).toString('hex'), name: title });
  return { ...base, columns };
}

export function renameColumn(board, id, name) {
  const base = normalizeBoard(board);
  const title = cleanName(name);
  if (!title) throw new Error('请填写列名');
  const column = base.columns.find((item) => item.id === id);
  if (!column) throw new Error('列不存在');
  if (base.columns.some((item) => item !== column && item.name === title)) throw new Error(`列已存在：${title}`);
  if (column.name === title) return base;
  return {
    ...base,
    columns: base.columns.map((item) => (item.id === id ? columnShape({ ...item, name: title }) : item)),
  };
}

export function deleteColumn(board, id) {
  const base = normalizeBoard(board);
  if (base.columns.length <= 1) throw new Error('至少保留一列');
  const index = base.columns.findIndex((column) => column.id === id);
  if (index < 0) throw new Error('列不存在');
  const neighbor = base.columns[index - 1] ?? base.columns[index + 1];
  let cards = base.cards;
  for (const card of Object.values(base.cards)) {
    if (card.column === id) cards = place(cards, card.id, neighbor.id);
  }
  return { ...base, columns: base.columns.filter((column) => column.id !== id), cards };
}

export function moveColumn(board, id, index) {
  const base = normalizeBoard(board);
  const column = base.columns.find((item) => item.id === id);
  if (!column) throw new Error('列不存在');
  const columns = base.columns.filter((item) => item.id !== id);
  const at = Math.max(0, Math.min(columns.length, Number.isInteger(index) ? index : 0));
  const current = base.columns.findIndex((item) => item.id === id);
  if (current === at) return base;
  columns.splice(at, 0, column);
  return { ...base, columns };
}

export function setCollapsed(board, id, collapsed) {
  const base = normalizeBoard(board);
  const column = base.columns.find((item) => item.id === id);
  if (!column) throw new Error('列不存在');
  if (!!column.collapsed === !!collapsed) return base;
  return {
    ...base,
    columns: base.columns.map((item) => (item.id === id ? columnShape({ ...item, collapsed: !!collapsed }) : item)),
  };
}

/**
 * 宿主的 session.focus 只能切到当前项目。跨项目时直接说明，不去发一次必然失败的调用。
 * coworker 的 id 形如 `<根会话>::…`，根会话在当前项目里就可以切。
 */
export function focusBlock(sessions, current, sessionId) {
  if (!safeId(sessionId)) return { ok: false, message: '请指定要打开的会话' };
  const currentRoot = rootId(current);
  if (!currentRoot) return { ok: false, message: '请先打开一个会话，再从看板跳转' };
  const list = Array.isArray(sessions) ? sessions : [];
  const root = rootId(sessionId);
  const target = list.find((session) => session.id === sessionId) ?? list.find((session) => session.id === root);
  if (!target) return { ok: false, message: '会话已结束或不在列表里' };
  const here = list.find((session) => session.id === currentRoot);
  if (here?.projectId && target.projectId && here.projectId !== target.projectId) {
    const title = target.title?.trim() || '未命名会话';
    const project = target.projectName?.trim() || '其他项目';
    return { ok: false, message: `「${title}」在项目「${project}」里。目前只能切换到当前项目的会话。` };
  }
  return { ok: true, sessionId: target.id };
}
