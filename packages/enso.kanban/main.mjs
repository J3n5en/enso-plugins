import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_COLUMNS = [
  { id: 'todo', name: '待办' },
  { id: 'doing', name: '进行中' },
  { id: 'done', name: '完成' },
];
const MAX_COLUMNS = 20;
const MAX_CARDS = 500;
const MAX_TITLE = 200;
const MAX_BODY = 8000;

export function activate(enso) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const fileFor = (ctx) => {
    if (!ctx?.projectRoot) throw new Error('请先打开一个项目，看板按项目保存');
    const key = createHash('sha256').update(ctx.projectRoot).digest('hex').slice(0, 16);
    return join(enso.dataDir, 'boards', `${key}.json`);
  };
  const load = async (file) => {
    try {
      const b = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(b?.cards)) return { columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), ...b };
    } catch {}
    return { rev: 0, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), cards: [] };
  };
  const save = async (file, board) => {
    board.rev += 1;
    await mkdir(join(enso.dataDir, 'boards'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(board, null, 2));
    await rename(tmp, file);
    return board;
  };
  const withBoard = (ctx, fn) =>
    locked(async () => {
      const file = fileFor(ctx);
      const board = await load(file);
      return (await fn(board)) === false ? board : save(file, board);
    });

  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  // true 绑定到调用方会话，字符串为会话 id，其余视为解绑
  const bindTarget = (v, ctx) => (v === true ? ctx?.sessionId ?? null : typeof v === 'string' && v ? v : null);
  // 列可按 id 或名称指定
  const column = (board, v) => {
    if (v == null || v === '') return null;
    const col = board.columns.find((c) => c.id === v) ?? board.columns.find((c) => c.name === String(v).trim());
    if (!col) throw new Error(`列不存在：${v}（现有：${board.columns.map((c) => c.name).join('、')}）`);
    return col.id;
  };
  const topOrder = (board, col) =>
    Math.min(0, ...board.cards.filter((c) => c.column === col).map((c) => c.order)) - 1;
  const find = (board, id) => {
    const card = board.cards.find((c) => c.id === id);
    if (!card) throw new Error(`卡片不存在：${id}`);
    return card;
  };

  const upsert = (args, ctx, by) =>
    withBoard(ctx, (board) => {
      const now = Date.now();
      if (args?.id) {
        const card = find(board, args.id);
        if (args.title !== undefined) card.title = text(args.title, MAX_TITLE) || card.title;
        if (args.body !== undefined) card.body = text(args.body, MAX_BODY);
        if (args.bind !== undefined) card.boundTo = bindTarget(args.bind, ctx);
        const col = column(board, args.column);
        if (col && col !== card.column) {
          card.column = col;
          card.order = topOrder(board, col);
        }
        card.updatedAt = now;
        card.updatedBy = by;
        return;
      }
      const title = text(args?.title, MAX_TITLE);
      if (!title) throw new Error('请填写标题');
      if (board.cards.length >= MAX_CARDS) throw new Error(`最多 ${MAX_CARDS} 张卡片`);
      const col = column(board, args?.column) ?? board.columns[0]?.id;
      if (!col) throw new Error('请先创建一列');
      board.cards.push({
        id: randomUUID().slice(0, 8),
        title,
        body: text(args?.body, MAX_BODY),
        column: col,
        order: topOrder(board, col),
        createdAt: now,
        createdBy: by,
        boundTo: args?.bind === undefined ? (by.kind === 'session' ? by.sessionId : null) : bindTarget(args.bind, ctx),
        updatedAt: now,
        updatedBy: by,
      });
    });

  const remove = (args, ctx) =>
    withBoard(ctx, (board) => {
      find(board, args?.id);
      board.cards = board.cards.filter((c) => c.id !== args.id);
    });

  // 拖动：放到 col 列中 beforeId 之前（无则放末尾）
  const move = (args, ctx, by) =>
    withBoard(ctx, (board) => {
      const card = find(board, args?.id);
      const col = column(board, args?.column) ?? card.column;
      const rest = board.cards
        .filter((c) => c.column === col && c !== card)
        .sort((a, b) => a.order - b.order);
      const at = rest.findIndex((c) => c.id === args?.beforeId);
      rest.splice(at < 0 ? rest.length : at, 0, card);
      rest.forEach((c, i) => (c.order = i));
      card.column = col;
      card.updatedAt = Date.now();
      card.updatedBy = by;
    });

  // 列管理：add / rename / delete / move（index 为目标位置）
  const editColumn = (args, ctx) =>
    withBoard(ctx, (board) => {
      const name = text(args?.name, 40);
      const action = args?.action;
      if (action === 'add') {
        if (!name) throw new Error('请填写列名');
        if (board.columns.length >= MAX_COLUMNS) throw new Error(`最多 ${MAX_COLUMNS} 列`);
        if (board.columns.some((c) => c.name === name)) throw new Error(`列已存在：${name}`);
        const at = Number.isInteger(args?.index) ? args.index : board.columns.length;
        board.columns.splice(at, 0, { id: randomUUID().slice(0, 8), name });
        return;
      }
      const id = column(board, args?.id);
      if (!id) throw new Error('请指定列');
      const col = board.columns.find((c) => c.id === id);
      if (action === 'rename') {
        if (!name) throw new Error('请填写列名');
        col.name = name;
      } else if (action === 'delete') {
        if (board.cards.some((c) => c.column === id)) throw new Error('列里还有卡片，先移走或删除');
        board.columns = board.columns.filter((c) => c !== col);
      } else if (action === 'move') {
        board.columns = board.columns.filter((c) => c !== col);
        const at = Math.max(0, Math.min(board.columns.length, Number(args?.index) || 0));
        board.columns.splice(at, 0, col);
      } else throw new Error(`未知操作：${action}`);
    });

  const sessionBy = (ctx) => ({ kind: 'session', sessionId: ctx?.sessionId ?? null, agent: ctx?.agent ?? null });
  const userBy = (ctx) => ({ kind: 'user', sessionId: ctx?.sessionId ?? null });
  const view = (board, ctx) => ({ ...board, sessionId: ctx?.sessionId ?? null });
  const brief = (board) => ({
    columns: board.columns.map((col) => ({
      id: col.id,
      name: col.name,
      cards: board.cards
        .filter((c) => c.column === col.id)
        .sort((a, b) => a.order - b.order)
        .map(({ id, title, body, createdBy, boundTo }) => ({
          id,
          title,
          body,
          createdBy: createdBy.kind,
          boundSession: boundTo ?? null,
        })),
    })),
  });

  enso.tools.register('kanban_list', async (_args, ctx) => brief(await locked(() => load(fileFor(ctx)))));
  enso.tools.register('kanban_upsert', async (args, ctx) => brief(await upsert(args, ctx, sessionBy(ctx))));
  enso.tools.register('kanban_delete', async (args, ctx) => brief(await remove(args, ctx)));
  enso.tools.register('kanban_column', async (args, ctx) => brief(await editColumn(args, ctx)));

  enso.renderer.handle('rev', async (_args, ctx) => (ctx?.projectRoot ? (await load(fileFor(ctx))).rev : -1));
  enso.renderer.handle('list', async (_args, ctx) => view(await locked(() => load(fileFor(ctx))), ctx));
  enso.renderer.handle('upsert', async (args, ctx) => view(await upsert(args, ctx, userBy(ctx)), ctx));
  enso.renderer.handle('remove', async (args, ctx) => view(await remove(args, ctx), ctx));
  enso.renderer.handle('move', async (args, ctx) => view(await move(args, ctx, userBy(ctx)), ctx));
  enso.renderer.handle('column', async (args, ctx) => view(await editColumn(args, ctx), ctx));

  enso.renderer.handle('sessions', () => enso.session.list());
  enso.renderer.handle('focus', (args) => enso.session.focus(String(args?.sessionId ?? '')));
  enso.renderer.handle('bind', (args, ctx) =>
    withBoard(ctx, (board) => {
      const card = find(board, args?.id);
      card.boundTo = bindTarget(args?.sessionId, ctx);
      card.updatedAt = Date.now();
      card.updatedBy = userBy(ctx);
    }).then((b) => view(b, ctx))
  );

  const setBound = (ctx, id, sessionId, sent) =>
    withBoard(ctx, (b) => {
      const c = b.cards.find((x) => x.id === id);
      if (!c) return false;
      c.boundTo = sessionId;
      if (sent) {
        c.sentTo = sessionId;
        c.sentAt = Date.now();
      }
    }).then((b) => view(b, ctx));

  // 把卡片交给会话：bound 绑定会话 / current 当前会话直接开跑；new 新建会话并预填；draft 插入输入框
  enso.renderer.handle('send', async (args, ctx) => {
    const board = await locked(() => load(fileFor(ctx)));
    const card = find(board, args?.id);
    const col = board.columns.find((c) => c.id === card.column)?.name ?? card.column;
    const text = [
      `请处理看板卡片「${card.title}」（id: ${card.id}，当前列：${col}）`,
      card.body,
      '开始和完成时用 kanban_upsert 移动这张卡片到相应的列，必要时在 body 里补充进展。',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (args?.target === 'draft') {
      await enso.composer.insertText({ text });
      return view(board, ctx);
    }
    if (args?.target === 'new') {
      const { sessionId } = await enso.session.create({ text });
      return setBound(ctx, card.id, sessionId, false);
    }
    const sessionId = args?.target === 'bound' ? card.boundTo : ctx?.sessionId;
    if (!sessionId) throw new Error(args?.target === 'bound' ? '卡片没有绑定会话' : '请先打开一个会话');
    try {
      await enso.session.inject({ sessionId, text, deliverAs: 'followUp', triggerTurn: true, trusted: true });
    } catch (error) {
      if (error?.code === 'PERMISSION_DENIED')
        throw new Error('未允许向其他会话发消息：到 设置 → 插件 → Kanban 打开“允许向任意运行中的会话发送消息”');
      if (error?.code === 'INJECT_FAILED') throw new Error(`目标会话不可用（可能已关闭）：${error.message}`);
      throw error;
    }
    return setBound(ctx, card.id, sessionId, true);
  });
}
