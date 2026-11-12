import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addColumn,
  clearClosed,
  columnForNew,
  DEFAULT_COLUMNS,
  deleteColumn,
  emptyBoard,
  focusBlock,
  mergeSessions,
  moveCard,
  normalizeBoard,
  removeCard,
  renameColumn,
  sameStored,
  setNote,
  setPrefs,
  unpin,
} from '../packages/enso.chatboard/board.mjs';
import { activate } from '../packages/enso.chatboard/main.mjs';

const session = (id, state, extra = {}) => ({ id, state, title: extra.title ?? id, ...extra });

test('新会话按状态落列，再次合并不改位置', () => {
  const now = 1_700_000_000_000;
  const board = mergeSessions(emptyBoard(), {
    now,
    current: null,
    sessions: [
      session('run', 'running', { projectId: 'p1', projectName: 'alpha' }),
      session('wait', 'waiting'),
      session('bad', 'error'),
      session('idle', 'idle'),
      session('old', 'idle', { archived: true }),
      session('hot', 'running', { archived: true }),
    ],
  });
  assert.equal(board.cards.run.column, 'doing');
  assert.equal(board.cards.wait.column, 'waiting');
  assert.equal(board.cards.bad.column, 'waiting');
  assert.equal(board.cards.idle.column, 'backlog');
  assert.equal(board.cards.old.column, 'done');
  assert.equal(board.cards.hot.column, 'doing');
  assert.equal(board.cards.run.projectName, 'alpha');
  assert.ok(board.cards.run.order < board.cards.hot.order);
  assert.deepEqual(board.columns.map((column) => column.name), DEFAULT_COLUMNS.map((column) => column.name));

  const again = mergeSessions(board, {
    now: now + 10,
    sessions: [
      session('run', 'running', { projectId: 'p1', projectName: 'alpha' }),
      session('wait', 'waiting'),
      session('bad', 'error'),
      session('idle', 'idle'),
      session('old', 'idle', { archived: true }),
      session('hot', 'running', { archived: true }),
    ],
  });
  assert.equal(sameStored(board, again), true);
});

test('停下来且不在当前会话时标未读，再次运行或正在看时清掉', () => {
  let board = mergeSessions(emptyBoard(), { now: 10, current: 'other', sessions: [session('a', 'running')] });
  assert.equal(board.cards.a.unseenAt, null);
  board = mergeSessions(board, { now: 20, current: 'other', sessions: [session('a', 'idle')] });
  assert.equal(board.cards.a.unseenAt, 20);
  board = mergeSessions(board, { now: 30, current: 'other', sessions: [session('a', 'waiting')] });
  assert.equal(board.cards.a.unseenAt, 20);
  board = mergeSessions(board, { now: 40, current: 'a', sessions: [session('a', 'waiting')] });
  assert.equal(board.cards.a.unseenAt, null);
  board = mergeSessions(board, { now: 50, current: 'other', sessions: [session('a', 'running')] });
  board = mergeSessions(board, { now: 60, current: 'a::coworker', sessions: [session('a', 'idle')] });
  assert.equal(board.cards.a.unseenAt, null);
});

test('跟随状态会换列，固定后留下；待处理一开始运行仍会移走', () => {
  let board = mergeSessions(emptyBoard(), { now: 1, sessions: [session('a', 'idle')] });
  assert.equal(board.cards.a.column, 'backlog');
  board = mergeSessions(board, { now: 2, sessions: [session('a', 'running')] });
  assert.equal(board.cards.a.column, 'doing');
  assert.equal(board.cards.a.manual, false);

  board = moveCard(board, 'a', 'backlog', null);
  assert.equal(board.cards.a.manual, true);
  board = mergeSessions(board, { now: 3, sessions: [session('a', 'running')] });
  assert.equal(board.cards.a.column, 'backlog');

  board = mergeSessions(board, { now: 4, sessions: [session('a', 'idle')] });
  board = mergeSessions(board, { now: 5, sessions: [session('a', 'running')] });
  assert.equal(board.cards.a.column, 'doing');
  assert.equal(board.cards.a.manual, true);

  board = setPrefs(board, { followState: false, moveOnStart: false });
  board = unpin(board, 'a');
  board = moveCard(board, 'a', 'backlog', null);
  board = unpin(board, 'a');
  board = mergeSessions(board, { now: 6, sessions: [session('a', 'waiting')] });
  assert.equal(board.cards.a.column, 'backlog');
});

test('关闭跟随状态时，新的空闲会话仍进待处理，已在待处理的一开始运行才移走', () => {
  let board = setPrefs(emptyBoard(), { followState: false, moveOnStart: true });
  board = mergeSessions(board, { now: 1, sessions: [session('a', 'idle'), session('b', 'running')] });
  assert.equal(board.cards.a.column, 'backlog');
  assert.equal(board.cards.b.column, 'doing');
  board = mergeSessions(board, { now: 2, sessions: [session('a', 'running'), session('b', 'waiting')] });
  assert.equal(board.cards.a.column, 'doing');
  assert.equal(board.cards.b.column, 'doing');
});

test('会话消失后保留备注和项目，回来时还在', () => {
  let board = mergeSessions(emptyBoard(), {
    now: 1,
    sessions: [session('a', 'running', { title: '修登录', projectId: 'p', projectName: 'app' })],
  });
  board = setNote(board, 'a', '先看失败的用例');
  board = mergeSessions(board, { now: 8, current: 'other', sessions: [] });
  assert.equal(board.cards.a.closed, true);
  assert.equal(board.cards.a.note, '先看失败的用例');
  assert.equal(board.cards.a.title, '修登录');
  assert.equal(board.cards.a.projectName, 'app');
  assert.equal(board.cards.a.unseenAt, 8);
  board = mergeSessions(board, { now: 9, sessions: [session('a', 'idle', { title: '修登录', projectId: 'p', projectName: 'app' })] });
  assert.equal(board.cards.a.closed, false);
  assert.equal(board.cards.a.note, '先看失败的用例');
  assert.throws(() => removeCard(board, 'a'), /不能从看板上移除/);
  const closed = mergeSessions(board, { now: 10, sessions: [] });
  const cleared = clearClosed(closed);
  assert.equal(cleared.cards.a, undefined);
});

test('拖动排序、改列和备注', () => {
  let board = mergeSessions(emptyBoard(), { now: 1, sessions: [session('a', 'idle'), session('b', 'idle'), session('c', 'idle')] });
  board = moveCard(board, 'c', 'backlog', 'a');
  const order = Object.values(board.cards)
    .filter((card) => card.column === 'backlog')
    .sort((a, b) => a.order - b.order)
    .map((card) => card.id);
  assert.deepEqual(order, ['c', 'a', 'b']);
  assert.equal(board.cards.c.manual, true);
  assert.equal(sameStored(board, moveCard(board, 'c', 'backlog', 'a')), true);

  board = moveCard(board, 'b', 'done', null);
  assert.equal(board.cards.b.column, 'done');
  const noted = setNote(board, 'b', `${'记'.repeat(3000)}`);
  assert.equal(noted.cards.b.note.length, 2000);
  assert.equal(sameStored(noted, setNote(noted, 'b', noted.cards.b.note)), true);
});

test('列可以增删改和移动，最后一列不能删', () => {
  let board = emptyBoard();
  board = addColumn(board, '暂放');
  assert.equal(board.columns.at(-1).name, '暂放');
  assert.throws(() => addColumn(board, '暂放'), /列已存在/);
  assert.throws(() => addColumn(board, '  '), /请填写列名/);
  const id = board.columns.at(-1).id;
  board = renameColumn(board, id, '稍后再看');
  assert.equal(board.columns.at(-1).name, '稍后再看');
  board = mergeSessions(board, { now: 1, sessions: [session('a', 'idle')] });
  board = moveCard(board, 'a', id, null);
  const removed = deleteColumn(board, id);
  assert.equal(removed.columns.some((column) => column.id === id), false);
  assert.equal(removed.cards.a.column, 'done');
  assert.throws(() => {
    let last = removed;
    while (last.columns.length) last = deleteColumn(last, last.columns[0].id);
  }, /至少保留一列/);
});

test('列没了的卡片回到第一列，损坏的看板不会把备注读丢', () => {
  const board = normalizeBoard({
    version: 1,
    columns: [],
    cards: { a: { id: 'a', column: 'missing', note: '留下', manual: true, order: 3 } },
  });
  assert.equal(board.cards.a.column, 'backlog');
  assert.equal(board.cards.a.note, '留下');
  assert.equal(board.cards.a.manual, true);
  assert.equal(columnForNew(session('x', 'idle'), board.columns), 'backlog');
});

test('只能聚焦当前项目里的会话', () => {
  const sessions = [
    session('here', 'idle', { projectId: 'p1', projectName: 'app' }),
    session('there', 'running', { projectId: 'p2', projectName: 'other', title: '修支付' }),
  ];
  assert.equal(focusBlock(sessions, 'here', 'here').ok, true);
  assert.equal(focusBlock(sessions, 'here::coworker', 'here').sessionId, 'here');
  const blocked = focusBlock(sessions, 'here', 'there');
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /修支付/);
  assert.match(blocked.message, /other/);
  assert.match(focusBlock(sessions, null, 'here').message, /请先打开一个会话/);
  assert.match(focusBlock(sessions, 'here', 'gone').message, /已结束或不在列表里/);
  assert.equal(focusBlock(sessions, 'here', 'there::child').ok, false);
});

async function host(initial) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatboard-'));
  const handlers = new Map();
  const calls = [];
  const state = { current: initial.current ?? null, sessions: initial.sessions ?? [] };
  const enso = {
    dataDir,
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    session: {
      list: async (options) => {
        calls.push(['list', options]);
        return { current: state.current, sessions: state.sessions };
      },
      focus: async (id) => calls.push(['focus', id]),
      create: async (input) => {
        calls.push(['create', input ?? null]);
        return { sessionId: 'created' };
      },
    },
  };
  activate(enso);
  return {
    dataDir,
    handlers,
    calls,
    state,
    async read() {
      return JSON.parse(await readFile(join(dataDir, 'board.json'), 'utf8'));
    },
    async cleanup() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('同步会落盘，没有变化时不升版本', async () => {
  const fx = await host({ current: 'a', sessions: [session('a', 'running', { projectId: 'p', projectName: 'app' })] });
  try {
    const view = await fx.handlers.get('sync')();
    assert.equal(view.cards[0].column, 'doing');
    assert.equal(view.cards[0].current, true);
    assert.equal(view.followState, true);
    const first = await fx.read();
    await fx.handlers.get('sync')();
    const second = await fx.read();
    assert.equal(second.rev, first.rev);
    assert.deepEqual(fx.calls[0][1], { scope: 'all' });
  } finally {
    await fx.cleanup();
  }
});

test('聚焦当前项目会清未读，其他项目不调用 focus', async () => {
  const fx = await host({
    current: 'me',
    sessions: [
      session('me', 'idle', { projectId: 'p1', projectName: 'app' }),
      session('them', 'idle', { projectId: 'p2', projectName: 'lib', title: '看日志' }),
    ],
  });
  try {
    await fx.handlers.get('sync')();
    fx.state.sessions = [
      session('me', 'idle', { projectId: 'p1', projectName: 'app' }),
      session('them', 'running', { projectId: 'p2', projectName: 'lib', title: '看日志' }),
    ];
    await fx.handlers.get('sync')();
    fx.state.sessions = [
      session('me', 'idle', { projectId: 'p1', projectName: 'app' }),
      session('them', 'waiting', { projectId: 'p2', projectName: 'lib', title: '看日志' }),
    ];
    const marked = await fx.handlers.get('sync')();
    assert.ok(marked.cards.find((card) => card.id === 'them').unseenAt);

    await assert.rejects(fx.handlers.get('focus')({ sessionId: 'them' }), /看日志/);
    assert.equal(fx.calls.some((call) => call[0] === 'focus'), false);

    fx.state.current = 'them';
    const opened = await fx.handlers.get('focus')({ sessionId: 'them' });
    assert.equal(fx.calls.some((call) => call[0] === 'focus' && call[1] === 'them'), true);
    assert.equal(opened.cards.find((card) => card.id === 'them').unseenAt, null);
  } finally {
    await fx.cleanup();
  }
});

test('新建会话只提交非空预填，超限时不调用宿主', async () => {
  const fx = await host({ current: 'a', sessions: [session('a', 'idle', { projectId: 'p', projectName: 'app' })] });
  try {
    await fx.handlers.get('create')({ text: '  看一下 CI  ' });
    assert.deepEqual(fx.calls.find((call) => call[0] === 'create')[1], { text: '看一下 CI' });
    await fx.handlers.get('create')({ text: '   ' });
    assert.deepEqual(fx.calls.filter((call) => call[0] === 'create').at(-1)[1], {});
    const before = fx.calls.length;
    await assert.rejects(fx.handlers.get('create')({ text: 'x'.repeat(32 * 1024 + 1) }), /32KB/);
    assert.equal(fx.calls.length, before);
  } finally {
    await fx.cleanup();
  }
});

test('看板文件损坏时不覆盖', async () => {
  const fx = await host({ current: null, sessions: [] });
  try {
    await writeFile(join(fx.dataDir, 'board.json'), '{');
    await assert.rejects(fx.handlers.get('sync')(), /读不出来/);
    assert.equal(await readFile(join(fx.dataDir, 'board.json'), 'utf8'), '{');
  } finally {
    await fx.cleanup();
  }
});

test('拖动、备注、列和开关都写回同一份看板', async () => {
  const fx = await host({
    current: 'a',
    sessions: [session('a', 'idle', { projectId: 'p', projectName: 'app' }), session('b', 'running', { projectId: 'p', projectName: 'app' })],
  });
  try {
    await fx.handlers.get('sync')();
    const moved = await fx.handlers.get('move')({ id: 'b', column: 'done' });
    assert.equal(moved.cards.find((card) => card.id === 'b').column, 'done');
    assert.equal(moved.cards.find((card) => card.id === 'b').manual, true);
    const noted = await fx.handlers.get('note')({ id: 'b', note: '等评审' });
    assert.equal(noted.cards.find((card) => card.id === 'b').note, '等评审');
    const added = await fx.handlers.get('column')({ action: 'add', name: '阻塞' });
    assert.equal(added.columns.at(-1).name, '阻塞');
    const prefs = await fx.handlers.get('prefs')({ followState: false });
    assert.equal(prefs.followState, false);
    assert.equal(prefs.moveOnStart, true);
    const stored = await fx.read();
    assert.equal(stored.cards.b.note, '等评审');
    assert.equal(stored.followState, false);
  } finally {
    await fx.cleanup();
  }
});
