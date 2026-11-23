import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMMANDS,
  MAX_CONTEXT,
  chunkText,
  createPairing,
  emptyState,
  inboundText,
  markdownToHtml,
  markPending,
  mirrorTargets,
  pendingTargets,
  rootSession,
  route,
  senderOf,
  setAllowed,
  takeReply,
} from './lib.mjs';

/** 每轮长轮询的等待；收到消息立即返回，空闲时最多这么久 */
const POLL_SECONDS = 25;
/** 轮询出错后退避，封顶 */
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
const PROGRESS_EVERY_MS = 3_000;
/** 给 HTML 标签留余量，转换后仍超 4096 时整段退回纯文本 */
const CHUNK = 3500;
const COMMANDS_VERSION = 5;
/** /session 列出的会话数，太多按钮在手机上不好点 */
const MENU_SIZE = 10;
/** 会话没启动时排队，按这个间隔重试投递；每个会话最多排这么多条 */
const RETRY_EVERY_MS = 5_000;
const MAX_QUEUED = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每个 activate 自己的停止开关和唤醒句柄；共享一个布尔量会让旧轮询在新实例起来后复活 */
let current = null;
export function deactivate() {
  if (!current) return;
  current.stopped = true;
  clearInterval(current.retryTimer);
  void current.wake?.();
  current = null;
}

/** options.loop=false 时不起常驻轮询，返回 tick() 供测试逐轮驱动 */
export function activate(enso, { loop = true } = {}) {
  deactivate();
  const self = { stopped: false, retryTimer: null, wake: null };
  current = self;
  const file = join(enso.dataDir, 'state.json');
  let chain = Promise.resolve();
  const locked = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const load = async () => {
    try {
      return { ...emptyState(), ...JSON.parse(await readFile(file, 'utf8')) };
    } catch {
      return emptyState();
    }
  };
  const save = async (state) => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, file);
  };
  const update = (fn) =>
    locked(async () => {
      const state = await load();
      const result = await fn(state);
      await save(state);
      return result;
    });

  // ---- Bot API ----
  const api = async (method, body, retry = true) => {
    const { botToken } = await enso.config.get();
    if (!botToken) throw new Error('请先在插件设置里填写 Bot Token');
    const res = await enso.net.fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw new Error(`Telegram 返回 HTTP ${res.status}`);
    }
    const wait = data.parameters?.retry_after;
    if (!data.ok && res.status === 429 && retry && wait <= 30) {
      await sleep(wait * 1000);
      return api(method, body, false);
    }
    if (!data.ok) throw Object.assign(new Error(`Telegram：${data.description ?? res.status}`), { status: res.status });
    return data.result;
  };

  /** 先试富文本，解析失败或超长退回纯文本 */
  const deliver = async (chatId, text, editId) => {
    const html = markdownToHtml(text);
    const attempts = html.length <= 4096 ? [{ text: html, parse_mode: 'HTML' }, { text }] : [{ text }];
    let lastError;
    for (const body of attempts) {
      try {
        if (editId) return await api('editMessageText', { chat_id: chatId, message_id: editId, ...body });
        return await api('sendMessage', { chat_id: chatId, ...body });
      } catch (error) {
        lastError = error;
        if (error.status !== 400) break;
      }
    }
    if (editId) return deliver(chatId, text);
    throw lastError;
  };
  const send = async (chatId, text, editId) => {
    const parts = chunkText(text, CHUNK);
    for (const [i, part] of parts.entries()) await deliver(chatId, part, i === 0 ? editId : undefined);
  };
  const edit = (chatId, messageId, text) =>
    api('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => {});

  let bot;
  const identity = async () => {
    if (!bot) bot = await api('getMe', {});
    return bot;
  };

  const explain = (error) => {
    if (error?.code === 'PERMISSION_DENIED')
      return '没有授权：到 EnsoCode 设置 → 插件 → Telegram 打开“允许向任意运行中的会话发送消息”。';
    if (error?.code === 'INJECT_FAILED') return '绑定的会话没在运行，请在 EnsoCode 里打开它。';
    if (error?.code === 'RATE_LIMITED') return '发得太快了，稍后再试。';
    return `投递失败：${error?.message ?? error}`;
  };

  /** Bot API 只给文件路径，再从文件端点按二进制取回；排队重试期间留在内存里，不重复下载 */
  const images = new Map();
  const downloadImage = async ({ fileId, mimeType }) => {
    if (images.has(fileId)) return images.get(fileId);
    const { file_path: path } = await api('getFile', { file_id: fileId });
    const { botToken } = await enso.config.get();
    const res = await enso.net.fetch(`https://api.telegram.org/file/bot${botToken}/${path}`, {
      responseType: 'base64',
    });
    if (res.status !== 200 || !res.body) throw new Error(`图片下载失败：HTTP ${res.status}`);
    const image = { data: res.body, mimeType };
    images.set(fileId, image);
    return image;
  };
  /** 新建的会话要在 EnsoCode 里发过消息、旧会话要打开过，宿主才认为它在运行 */
  const notRunning = (error) => error?.code === 'INJECT_FAILED' && /不在运行/.test(error?.message ?? '');

  // ---- 入站 ----
  /** 主会话列表。宿主只允许在会话内的调用（侧栏）里列出，后台轮询沿用侧栏最近一次拿到的列表 */
  const cacheFile = join(enso.dataDir, 'sessions.json');
  let cached;
  const listSessions = async () => {
    try {
      const res = await enso.session.list();
      const list = (res?.sessions ?? [])
        .filter((s) => s?.id && !s.archived && !String(s.id).includes('::'))
        .map((s) => ({ id: s.id, title: s.title || '未命名会话', running: s.running === true }));
      if (JSON.stringify(list) !== JSON.stringify(cached)) {
        cached = list;
        await mkdir(enso.dataDir, { recursive: true });
        await writeFile(`${cacheFile}.tmp`, JSON.stringify(list));
        await rename(`${cacheFile}.tmp`, cacheFile);
      }
      return list;
    } catch {
      cached ??= await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
      return cached;
    }
  };
  const showSessions = async ({ chatId, current }) => {
    const all = await listSessions();
    if (!all?.length) return send(chatId, '还拿不到 EnsoCode 会话列表：请在 EnsoCode 里打开一次「Telegram」侧栏。');
    const list = all.slice(0, MENU_SIZE);
    await update((state) => {
      state.menus = { ...state.menus, [chatId]: list };
    });
    const rows = list.map((s, i) => [
      { text: `${s.id === current ? '✅ ' : ''}${i + 1}. ${s.title}`.slice(0, 60), callback_data: `sess:${i + 1}` },
    ]);
    return api('sendMessage', {
      chat_id: chatId,
      text: '选择要切换到的会话（也可以发 /session 序号）：',
      reply_markup: { inline_keyboard: rows },
    });
  };

  const handle = async (action) => {
    if (action.callbackId)
      await api('answerCallbackQuery', {
        callback_query_id: action.callbackId,
        ...(action.kind === 'answer' && action.text ? { text: action.text } : {}),
      }).catch(() => {});
    if (action.kind === 'answer') return;
    if (action.kind === 'sessions') return showSessions(action);
    if (action.kind === 'switched') {
      const text = `🔀 已切换到会话「${action.title}」，之后的消息会发到这里。`;
      if (action.messageId) return edit(action.chatId, action.messageId, text);
      return send(action.chatId, text);
    }
    if (action.kind === 'reply') return send(action.chatId, action.text);
    if (action.kind === 'stop') {
      try {
        await enso.session.abort(action.sessionId);
        return send(action.chatId, '⏹ 已停止当前任务。');
      } catch (error) {
        if (error?.code === 'ABORT_FAILED') return send(action.chatId, '没有正在运行的任务。');
        if (error?.code === 'UNSUPPORTED' || error?.code === 'INVALID_ARGS' || /session\.abort/.test(error?.message))
          return send(action.chatId, '当前 EnsoCode 版本不支持远程停止，请升级。');
        return send(action.chatId, explain(error));
      }
    }
    if (action.kind === 'bound')
      return send(action.chatId, '✅ 已绑定到 EnsoCode 会话，直接发消息即可。/help 查看用法。');
    if (action.kind === 'inject') await deliverInject(action);
  };

  /** 返回 false 表示会话仍没运行，留在队列里 */
  const deliverInject = async (action, retry = false) => {
    let attached;
    if (action.image) {
      try {
        attached = [await downloadImage(action.image)];
      } catch (error) {
        await send(action.chatId, `图片没收到：${error?.message ?? error}`).catch(() => {});
        return true;
      }
    }
    const inject = () =>
      enso.session.inject({
        sessionId: action.sessionId,
        text: inboundText(action),
        ...(attached ? { images: attached } : {}),
        deliverAs: retry ? 'followUp' : action.deliverAs,
        triggerTurn: true,
        sender: senderOf(action),
      });
    const done = () => action.image && images.delete(action.image.fileId);
    if (retry) {
      try {
        await inject();
      } catch (error) {
        if (notRunning(error)) return false;
        done();
        await send(action.chatId, explain(error)).catch(() => {});
        return true;
      }
      done();
      const placeholder = await api('sendMessage', {
        chat_id: action.chatId,
        text: '▶️ 会话已启动，开始处理排队的消息…',
        reply_parameters: { message_id: action.messageId, allow_sending_without_reply: true },
      }).catch(() => null);
      await update((state) =>
        markPending(state, action.sessionId, { chatId: action.chatId, placeholderId: placeholder?.message_id })
      );
      return true;
    }
    const steer = action.deliverAs === 'steer';
    const placeholder = await api('sendMessage', {
      chat_id: action.chatId,
      text: steer ? '↪️ 已插入当前任务' : '⏳ 已收到，处理中…',
      reply_parameters: { message_id: action.messageId, allow_sending_without_reply: true },
    }).catch(() => null);
    await update((state) => {
      const existing = pendingTargets(state, action.sessionId).find((t) => t.chatId === action.chatId);
      // 插话并入正在进行的那一轮，沿用它的占位消息
      if (!(steer && existing))
        markPending(state, action.sessionId, { chatId: action.chatId, placeholderId: placeholder?.message_id });
    });
    try {
      await inject();
      done();
    } catch (error) {
      const queue = notRunning(error);
      await update((state) => {
        state.pending[rootSession(action.sessionId)] = pendingTargets(state, action.sessionId).filter(
          (t) => t.chatId !== action.chatId
        );
        if (queue) {
          const key = rootSession(action.sessionId);
          state.queue = { ...state.queue, [key]: [...(state.queue?.[key] ?? []), action].slice(-MAX_QUEUED) };
        }
      });
      if (!queue) done();
      const text = queue
        ? '⏸ 绑定的会话还没启动，消息已排队，会话启动后自动处理（EnsoCode 窗口需要开着）。'
        : explain(error);
      if (placeholder) await edit(action.chatId, placeholder.message_id, text);
      else await send(action.chatId, text);
    }
    return true;
  };

  /** 逐个会话按顺序重投排队的消息，遇到仍没运行的会话就跳到下一个 */
  // 已在补投时返回同一个 Promise，调用方能等到这一轮结束
  let flushing = null;
  const flush = (only) =>
    (flushing ??= (async () => {
      const queue = (await load()).queue ?? {};
      for (const [key, items] of Object.entries(queue)) {
        if (only && key !== rootSession(only)) continue;
        for (const item of items) {
          if (!(await deliverInject(item, true))) break;
          await update((state) => {
            const rest = (state.queue?.[key] ?? []).filter(
              (q) => !(q.chatId === item.chatId && q.messageId === item.messageId)
            );
            if (rest.length) state.queue[key] = rest;
            else delete state.queue?.[key];
          });
        }
      }
    })().finally(() => (flushing = null)));

  /** 长轮询不持锁，侧栏操作不用排队等它；只有一个轮询者，offset 不会冲突 */
  const pollOnce = async (seconds, me) => {
    const { offset, commandsVersion } = await load();
    if (commandsVersion !== COMMANDS_VERSION) {
      await api('setMyCommands', { commands: COMMANDS }).catch(() => {});
      await update((state) => {
        state.commandsVersion = COMMANDS_VERSION;
      });
    }
    // 退出时用同 offset 发一个短请求，终止这轮长轮询；offset 不推进，消息不会丢
    self.wake = () => void api('getUpdates', { offset, timeout: 0, limit: 1 }).catch(() => {});
    let updates;
    try {
      updates = await api('getUpdates', {
        offset,
        timeout: seconds,
        allowed_updates: ['message', 'callback_query'],
      });
    } finally {
      self.wake = null;
    }
    if (!updates.length) return [];
    // 先落盘 offset，处理失败也不会重复投递
    return update((state) =>
      updates.map((u) => {
        state.offset = Math.max(state.offset, u.update_id + 1);
        return route(state, u, Date.now(), me);
      })
    );
  };

  /** 常驻轮询：Telegram 长轮询收到消息就返回，所以延迟只是网络往返 */
  const tick = async (seconds = POLL_SECONDS) => {
    const { botToken } = await enso.config.get();
    if (!botToken) return false;
    const actions = await pollOnce(seconds, await identity());
    for (const action of actions)
      await handle(action).catch((error) => console.error('[telegram]', error?.message ?? error));
    return true;
  };
  const pollLoop = async () => {
    let backoff = BACKOFF_START_MS;
    while (!self.stopped) {
      try {
        if (!(await tick())) await sleep(5_000);
        backoff = BACKOFF_START_MS;
      } catch (error) {
        if (self.stopped) break;
        const hint = /Conflict/.test(error?.message ?? '') ? '（同一 Bot Token 有别的实例在轮询）' : '';
        console.error('[telegram] 轮询失败，', Math.round(backoff / 1000), '秒后重试：', error?.message ?? error, hint);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  };
  if (loop) {
    void pollLoop();
    self.retryTimer = setInterval(
      () => flush().catch((e) => console.error('[telegram]', e?.message ?? e)),
      RETRY_EVERY_MS
    );
  }

  // ---- 出站 ----
  const progress = new Map();
  enso.events.on('tool_call', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    const key = rootSession(ctx.sessionId);
    const entry = progress.get(key) ?? { steps: 0, at: 0 };
    entry.steps += 1;
    progress.set(key, entry);
    if (Date.now() - entry.at < PROGRESS_EVERY_MS) return;
    entry.at = Date.now();
    const targets = pendingTargets(await load(), key).filter((t) => t.placeholderId);
    const who = ctx.agent ? `${ctx.agent.name} · ` : '';
    for (const t of targets)
      await edit(t.chatId, t.placeholderId, `⏳ 处理中…（第 ${entry.steps} 步：${who}${data?.toolName ?? '工具'}）`);
  });

  enso.events.on('agent_end', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    void flush(ctx.sessionId).catch(() => {});
    if (ctx.agent) return;
    const text = String(data?.text ?? '').trim();
    const reply = await update((state) => takeReply(state, ctx.sessionId, text));
    progress.delete(rootSession(ctx.sessionId));
    const answered = [];
    for (const t of reply?.targets ?? []) {
      await send(t.chatId, reply.text, t.placeholderId).catch((e) => console.error('[telegram]', e.message));
      answered.push(t.chatId);
    }
    if (!text) return;
    for (const chatId of mirrorTargets(await load(), ctx.sessionId, answered))
      await send(chatId, text).catch((e) => console.error('[telegram]', e.message));
  });

  enso.events.on('input', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    // 会话有了动静说明已在运行，排队的消息立刻补投
    void flush(ctx.sessionId).catch(() => {});
    if (ctx.agent || data?.source === 'extension') return;
    const text = String(data?.text ?? '').trim();
    if (!text) return;
    for (const chatId of mirrorTargets(await load(), ctx.sessionId))
      await send(chatId, `💬 EnsoCode：${text}`).catch(() => {});
  });

  // ---- 侧栏 ----
  const view = async (sessionId) => {
    const { botToken } = await enso.config.get();
    if (!botToken) return { configured: false };
    let me = null;
    let error = null;
    try {
      me = await identity();
    } catch (e) {
      error = e?.message ?? String(e);
    }
    const state = await load();
    const root = sessionId ? rootSession(sessionId) : null;
    const now = Date.now();
    const pairing = root && state.pairings.find((p) => p.sessionId === root && p.expiresAt > now);
    const sessions = (await listSessions()) ?? [];
    const titleOf = (id) => sessions.find((s) => s.id === id)?.title ?? '未知会话';
    return {
      configured: true,
      bot: me && { username: me.username, name: me.first_name, readsAll: me.can_read_all_group_messages },
      error,
      sessionId: root,
      pairing: pairing && {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        link: link(me, `start=${pairing.code}`),
        groupLink: link(me, `startgroup=${pairing.code}`),
      },
      bindings: root ? state.bindings.filter((b) => b.sessionId === root) : [],
      others: state.bindings
        .filter((b) => b.sessionId !== root)
        .map((b) => ({ chatId: b.chatId, chatType: b.chatType, title: b.title, session: titleOf(b.sessionId) })),
      sessions,
      running: root && sessions.length ? sessions.some((s) => s.id === root && s.running) : null,
      queued: root ? (state.queue?.[root] ?? []).length : 0,
    };
  };
  const link = (me, query) => (me?.username ? `https://t.me/${me.username}?${query}` : null);
  const needSession = (ctx) => {
    if (!ctx?.sessionId) throw new Error('请先打开一个会话');
    return rootSession(ctx.sessionId);
  };
  /** 改本会话的某个绑定后返回最新视图 */
  const editBinding = async (args, ctx, fn) => {
    const sessionId = needSession(ctx);
    await update((state) => {
      const hit = state.bindings.find((b) => b.chatId === args?.chatId && b.sessionId === sessionId);
      if (hit) fn(hit);
    });
    return view(sessionId);
  };

  enso.renderer.handle('state', (_args, ctx) => view(ctx?.sessionId));
  enso.renderer.handle('pair', async (_args, ctx) => {
    const sessionId = needSession(ctx);
    await update((state) => createPairing(state, sessionId, Date.now()));
    return view(sessionId);
  });
  enso.renderer.handle('unbind', async (args, ctx) => {
    const sessionId = needSession(ctx);
    const removed = await update((state) => {
      const hit = state.bindings.find((b) => b.chatId === args?.chatId && b.sessionId === sessionId);
      if (!hit) return null;
      state.bindings = state.bindings.filter((b) => b !== hit);
      delete state.history?.[hit.chatId];
      const pending = pendingTargets(state, sessionId).filter((t) => t.chatId !== hit.chatId);
      if (pending.length) state.pending[sessionId] = pending;
      else delete state.pending[sessionId];
      return hit;
    });
    if (removed) await send(removed.chatId, '已在 EnsoCode 里解绑。').catch(() => {});
    return view(sessionId);
  });
  enso.renderer.handle('sync', (args, ctx) => editBinding(args, ctx, (b) => (b.sync = args?.on === true)));
  /** 把聊天改绑到另一个会话；侧栏既能把本会话的聊天切走，也能把别的会话的聊天拉过来 */
  enso.renderer.handle('move', async (args, ctx) => {
    const sessionId = needSession(ctx);
    const target = typeof args?.sessionId === 'string' && args.sessionId ? rootSession(args.sessionId) : null;
    if (!target) throw new Error('缺少目标会话');
    const moved = await update((state) => {
      const hit = state.bindings.find((b) => b.chatId === args?.chatId);
      if (!hit || hit.sessionId === target) return null;
      hit.sessionId = target;
      return hit;
    });
    if (moved) {
      const title = (await listSessions())?.find((s) => s.id === target)?.title ?? '另一个会话';
      await send(moved.chatId, `🔀 已在 EnsoCode 里切换到会话「${title}」。`).catch(() => {});
    }
    return view(sessionId);
  });
  /** 新建会话只能由用户点击触发（宿主要求手势），新会话会在 EnsoCode 里打开，聊天随之改绑 */
  enso.renderer.handle('fresh', async (args, ctx) => {
    needSession(ctx);
    const { sessionId: created } = await enso.session.create({});
    const target = rootSession(created);
    const moved = await update((state) => {
      const hit = state.bindings.find((b) => b.chatId === args?.chatId);
      if (hit) hit.sessionId = target;
      return hit;
    });
    if (moved)
      await send(moved.chatId, '🆕 已切换到一个新会话，之后的消息会发到那里。').catch(() => {});
    return view(target);
  });
  enso.renderer.handle('context', (args, ctx) =>
    editBinding(args, ctx, (b) => {
      const n = Number(args?.count);
      if (Number.isInteger(n) && n >= 0 && n <= MAX_CONTEXT) b.context = n;
    })
  );
  enso.renderer.handle('whitelist', (args, ctx) =>
    editBinding(args, ctx, (b) => {
      b.whitelist = args?.on === true;
      b.allow ??= [];
    })
  );
  enso.renderer.handle('allow', (args, ctx) =>
    editBinding(args, ctx, (b) => {
      const user = [...(b.allow ?? []), ...(b.requests ?? [])].find((u) => u.id === args?.userId);
      if (user) setAllowed(b, user, args?.on === true);
    })
  );
  enso.renderer.handle('open', async (args) => {
    if (typeof args?.url === 'string' && args.url.startsWith('https://t.me/')) await enso.ui.openExternal(args.url);
    return null;
  });

  enso.tools.register('telegram_reply', async (args, ctx) => {
    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text 不能为空');
    if (!ctx.sessionId) throw new Error('调用不属于任何会话');
    const sessionId = rootSession(ctx.sessionId);
    const chats = (await load()).bindings.filter((b) => b.sessionId === sessionId);
    if (!chats.length) throw new Error('本会话没有绑定 Telegram 聊天');
    for (const chat of chats) await send(chat.chatId, text);
    return `已发送到 ${chats.length} 个 Telegram 聊天`;
  });
  return { tick, flush };
}
