import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, extname, isAbsolute, join, relative } from 'node:path';
import {
  ANONYMOUS_ADMIN,
  COMMANDS,
  MAX_CONTEXT,
  MAX_DEBOUNCE,
  MAX_MIN_INTERVAL,
  MAX_PREFIX,
  bindRoute,
  bufferDecision,
  cancelPairing,
  chunkMarkdown,
  closeAsksFor,
  createPairing,
  encodeAskCallback,
  findRoute,
  inboundText,
  isAdmin,
  isRouteEnabled,
  isTopicRootReply,
  markPending,
  markdownToHtml,
  mergeBuffered,
  migrate,
  mirrorTargets,
  normalizeRoute,
  noteRequest,
  openAsksForSession,
  pendingTargets,
  registerAsk,
  rootSession,
  route,
  routeChatId,
  routesOfSession,
  senderOf,
  setAdmin,
  setAllowed,
  shortIdOf,
  splitRouteKey,
  takeReply,
  threadParams,
  unbindRoute,
  userOf,
  visuallyEmpty,
  routeKeyOf,
} from './lib.mjs';

/** 每轮长轮询的等待；收到消息立即返回，空闲时最多这么久 */
const POLL_SECONDS = 25;
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
const PROGRESS_EVERY_MS = 3_000;
const COMMANDS_VERSION = 7;
/** 可信注入被宿主拒绝（旧宿主没有该字段/未授予 agent.injectTrusted）时降级为外部消息再投一次 */
const TRUST_FALLBACK = new Set(['PERMISSION_DENIED', 'INVALID_ARGS', 'UNSUPPORTED']);
/** /session 列出的会话数，太多按钮在手机上不好点 */
const MENU_SIZE = 10;
const RETRY_EVERY_MS = 5_000;
const MAX_QUEUED = 10;
/** 入站相册：同组消息 1.2s 防抖后合并且 inflight 下载计数的等待上限 */
const ALBUM_DEBOUNCE_MS = 1_200;
const ALBUM_WAIT_MS = 8_000;
/** typing 指示最长持续 90s（onTurnEnd 缺失时兜底） */
const TYPING_MAX_MS = 90_000;
/** 出站图片单张上限 10MB，与 tgclient 一致 */
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** caption 超过 1024 拆成独立消息 */
const CAPTION_MAX = 1024;
const IMAGE_SIGS = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], offset8: [0x57, 0x45, 0x42, 0x50] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个 activate 自己的停止开关和唤醒句柄；共享一个布尔量会让旧轮询在新实例起来后复活 */
let current = null;
export function deactivate() {
  if (!current) return;
  current.stopped = true;
  for (const t of current.timers ?? []) clearInterval(t);
  for (const t of current.timeouts ?? []) clearTimeout(t);
  current.timeouts?.clear?.();
  void current.wake?.();
  current = null;
}

/** options.loop=false 时不起常驻轮询，返回 tick() 供测试逐轮驱动 */
export function activate(enso, { loop = true } = {}) {
  deactivate();
  const self = { stopped: false, timers: [], timeouts: new Set(), wake: null };
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
      return migrate(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return migrate(null);
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
  let bot = null;
  let botTokenUsed = null;
  // 只信配置中心：用户在 设置 → 插件 里改/清 Token 立即生效，不做内存阴影缓存
  const tokenOf = async () => (await enso.config.get())?.botToken ?? null;
  const api = async (method, body, retry = true, tokenOverride) => {
    const token = tokenOverride ?? (await tokenOf());
    if (!token) throw new Error('还没有 Bot Token：在右侧「Telegram Bot」面板直接填写，或到 设置 → 插件 → Telegram Bot。');
    const res = await enso.net.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw Object.assign(new Error(`Telegram 返回 HTTP ${res.status}`), { status: res.status });
    }
    const wait = data.parameters?.retry_after;
    if (!data.ok && res.status === 429 && retry && wait <= 30) {
      await sleep(wait * 1000);
      return api(method, body, false, tokenOverride);
    }
    if (!data.ok) throw Object.assign(new Error(`Telegram：${data.description ?? res.status}`), { status: res.status });
    return data.result;
  };

  /** multipart/form-data 纯 Buffer 构造（媒体上传） */
  const apiUpload = async (method, fields, files) => {
    const token = await tokenOf();
    if (!token) throw new Error('还没有 Bot Token');
    const boundary = `----enso${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${typeof value === 'string' ? value : JSON.stringify(value)}\r\n`, 'utf8'));
    }
    for (const file of files) {
      // 文件名里的引号/反斜杠/换行会破坏 multipart 头
      const safeName = String(file.filename ?? 'image').replace(/["\\\r\n]/g, '_');
      parts.push(
        Buffer.from(
          `--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${safeName}"\r\ncontent-type: ${file.mime}\r\n\r\n`,
          'utf8'
        )
      );
      parts.push(file.data);
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);
    const res = await enso.net.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: body.toString('base64'),
      bodyEncoding: 'base64',
    });
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw Object.assign(new Error(`Telegram 返回 HTTP ${res.status}`), { status: res.status });
    }
    if (!data.ok) throw Object.assign(new Error(`Telegram：${data.description ?? res.status}`), { status: res.status, desc: data.description });
    return data.result;
  };

  /** 当前 token 的身份缓存：token 变化（面板更换/设置页修改）时自动重拉 getMe */
  const identity = async (tokenOverride) => {
    if (tokenOverride) return api('getMe', {}, true, tokenOverride);
    const token = await tokenOf();
    if (!bot || botTokenUsed !== token) {
      bot = await api('getMe', {}, true);
      botTokenUsed = token;
    }
    return bot;
  };

  // ---- 出站文本 ----
  const deliver = async (key, text, editId) => {
    const chatId = routeChatId(key);
    const html = markdownToHtml(text);
    const base = { chat_id: chatId, ...threadParams(key) };
    const attempts = html.length <= 4096 ? [{ text: html, parse_mode: 'HTML' }, { text }] : [{ text }];
    let lastError;
    for (const body of attempts) {
      try {
        if (editId) return await api('editMessageText', { ...base, message_id: editId, ...body });
        return await api('sendMessage', { ...base, ...body });
      } catch (error) {
        lastError = error;
        if (error.status !== 400) break;
      }
    }
    if (editId) return deliver(key, text);
    throw lastError;
  };
  /** 长文按围栏状态分片（代码块跨片不断裂），逐片投递；视觉空消息直接跳过 */
  const send = async (key, text, editId) => {
    if (visuallyEmpty(text)) return null;
    const parts = chunkMarkdown(text, 3500);
    let first = null;
    for (const [i, part] of parts.entries()) {
      const r = await deliver(key, part, i === 0 ? editId : undefined);
      first ??= r;
    }
    return first;
  };
  const edit = (key, messageId, text, extra = {}) =>
    api('editMessageText', { chat_id: routeChatId(key), message_id: messageId, text, ...extra }).catch(() => {});

  const explain = (error) => {
    if (error?.code === 'PERMISSION_DENIED')
      return '没有授权：到 EnsoCode 设置 → 插件 → Telegram Bot 打开“允许向任意运行中的会话发送消息”。';
    if (error?.code === 'INJECT_FAILED') return '绑定的会话没在运行，请在 EnsoCode 里打开它。';
    if (error?.code === 'RATE_LIMITED') return '发得太快了，稍后再试。';
    return `投递失败：${error?.message ?? error}`;
  };
  const notRunning = (error) => error?.code === 'INJECT_FAILED' && /不在运行/.test(error?.message ?? '');

  // ---- 入站图片下载 ----
  const images = new Map();
  const downloadImage = async ({ fileId, mimeType }) => {
    if (images.has(fileId)) return images.get(fileId);
    const { file_path: path } = await api('getFile', { file_id: fileId });
    const token = await tokenOf();
    const res = await enso.net.fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
      responseType: 'base64',
    });
    if (res.status !== 200 || !res.body) throw new Error(`图片下载失败：HTTP ${res.status}`);
    const image = { data: res.body, mimeType };
    images.set(fileId, image);
    return image;
  };
  const dropImage = ({ fileId }) => images.delete(fileId);

  // ---- 会话清单（跨项目 + 秘书；旧宿主回退） ----
  const cacheFile = join(enso.dataDir, 'sessions.json');
  let cachedSessions;
  const listSessions = async () => {
    const shape = (res) =>
      (res?.sessions ?? [])
        .filter((s) => s?.id && !s.archived && !String(s.id).includes('::'))
        .map((s) => ({
          id: s.id,
          title: s.title || '未命名会话',
          running: s.running === true,
          kind: s.kind === 'secretary' ? 'secretary' : 'normal',
          projectName: s.projectName,
        }));
    try {
      // 新宿主：跨项目 + 秘书会话
      const res = await enso.session.list({ scope: 'all', includeSecretary: true });
      const list = shape(res);
      await cacheSessions(list);
      return list;
    } catch {
      try {
        // 旧宿主：回退无参 list
        const res = await enso.session.list();
        const list = shape(res);
        await cacheSessions(list);
        return list;
      } catch {
        cachedSessions ??= await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
        return cachedSessions;
      }
    }
  };
  const cacheSessions = async (list) => {
    if (JSON.stringify(list) === JSON.stringify(cachedSessions)) return list;
    cachedSessions = list;
    try {
      await mkdir(enso.dataDir, { recursive: true });
      await writeFile(`${cacheFile}.tmp`, JSON.stringify(list));
      await rename(`${cacheFile}.tmp`, cacheFile);
    } catch {}
    return list;
  };
  const showSessions = async ({ key, current: cur }) => {
    const all = await listSessions();
    if (!all?.length) return send(key, '还拿不到 EnsoCode 会话列表：请在 EnsoCode 里打开一次「Telegram Bot」侧栏。');
    const list = all.slice(0, MENU_SIZE);
    await update((state) => {
      state.menus = { ...state.menus, [key]: list };
    });
    const rows = list.map((s, i) => [
      {
        text: `${s.id === cur ? '✅ ' : ''}${i + 1}. ${s.kind === 'secretary' ? '🤖 ' : ''}${s.title}`.slice(0, 60),
        callback_data: `sess:${i + 1}`,
      },
    ]);
    return api('sendMessage', {
      chat_id: routeChatId(key),
      ...threadParams(key),
      text: '选择要切换到的会话（也可以发 /session 序号）：',
      reply_markup: { inline_keyboard: rows },
    });
  };

  /** 路由关了进度提示：不发占位、攒批回执、工具进度、「已静默处理」和「正在输入」，只发最终回复；路由不存在时照旧显示 */
  const quiet = (state, key) => state?.routes[key]?.showProgress === false;

  // ---- typing 指示：注入后开始，轮末/90s/关掉进度提示时停止 ----
  const typingKeys = new Map(); // key -> expiry
  const typingStart = (key) => {
    typingKeys.set(key, Date.now() + TYPING_MAX_MS);
    void api('sendChatAction', { chat_id: routeChatId(key), ...threadParams(key), action: 'typing' }).catch(() => {});
  };
  const typingStop = (sessionIdOrKey) => {
    for (const key of [...typingKeys.keys()]) {
      if (key === sessionIdOrKey) typingKeys.delete(key);
    }
  };
  /** 续发 typing；续发前按最新配置再查一次，投递途中才关掉进度提示的路由也不再续发 */
  const typingTick = async () => {
    if (!typingKeys.size) return;
    const state = await load().catch(() => null);
    const now = Date.now();
    for (const [key, expiry] of typingKeys) {
      if (now >= expiry || quiet(state, key)) {
        typingKeys.delete(key);
        continue;
      }
      void api('sendChatAction', { chat_id: routeChatId(key), ...threadParams(key), action: 'typing' }).catch(() => {});
    }
  };
  if (loop) self.timers.push(setInterval(() => void typingTick(), 4_000));

  // ---- 入站投递（含排队与补投） ----
  /** 返回 false 表示会话仍没运行，留在队列里 */
  const deliverInject = async (action, retry = false) => {
    const latest = await load().catch(() => null);
    // 关掉开关前已进缓冲/队列的消息：投递前再看一次，静音了就丢掉
    if (latest?.routes[action.key]?.enabled === false) {
      typingStop(action.key);
      return true;
    }
    // 提示词前置：以当前路由配置为准
    if (action.promptPrefix === undefined) {
      const r = latest?.routes[action.key];
      if (r?.promptPrefix) action.promptPrefix = r.promptPrefix;
    }
    // 投递时按最新名单重新认人：排队期间被取消管理员的消息不再可信
    const trusted = action.admin === true && !!latest && isAdmin(latest, action.fromId);
    // 收集图片：单张 action.image 或相册 action.images
    const imageRefs = action.images?.length ? action.images : action.image ? [action.image] : [];
    let attached;
    if (imageRefs.length) {
      try {
        attached = await Promise.all(imageRefs.map((img) => downloadImage(img)));
      } catch (error) {
        await send(action.key, `图片没收到：${error?.message ?? error}`).catch(() => {});
        return true;
      }
    }
    // 管理员：trusted 且不带 sender（带 sender 的注入宿主一律按外部数据包裹）；普通用户：不可信 + sender
    const injectOnce = (imgs, asTrusted) =>
      enso.session.inject({
        sessionId: action.sessionId,
        text: inboundText({ ...action, admin: trusted, text: action.text + (action.note ? `\n\n（${action.note}）` : '') }),
        ...(imgs?.length ? { images: imgs } : {}),
        deliverAs: retry ? 'followUp' : action.deliverAs,
        triggerTurn: true,
        ...(asTrusted ? { trusted: true } : { trusted: false, sender: senderOf(action) }),
      });
    let downgraded = false;
    const injectTrust = async (imgs) => {
      if (!trusted) return injectOnce(imgs, false);
      try {
        await injectOnce(imgs, true);
      } catch (error) {
        if (!TRUST_FALLBACK.has(error?.code)) throw error;
        await injectOnce(imgs, false);
        downgraded = true;
      }
    };
    const inject = async () => {
      try {
        await injectTrust(attached);
      } catch (error) {
        // 新宿主上限 10 张；旧宿主 4 张。INVALID_ARGS 且图片数 > 4 时降级前 4 张并附提示
        if (error?.code === 'INVALID_ARGS' && attached?.length > 4) {
          action.note = [action.note, `图片一次最多 4 张，已只附前 4 张（升级 EnsoCode 可到 10 张）`].filter(Boolean).join('；');
          await injectTrust(attached.slice(0, 4));
        } else throw error;
      }
      if (downgraded && !self.trustWarned) {
        self.trustWarned = true;
        await send(
          action.key,
          '⚠️ 当前 EnsoCode 没有接受可信投递（旧版本或未授予 agent.injectTrusted 权限），管理员消息已按外部消息投递。请升级 EnsoCode，或在 设置 → 插件 → Telegram Bot 确认权限。'
        ).catch(() => {});
      }
    };
    const done = () => imageRefs.forEach(dropImage);
    if (retry) {
      try {
        await inject();
      } catch (error) {
        if (notRunning(error)) return false;
        done();
        await send(action.key, explain(error)).catch(() => {});
        return true;
      }
      done();
      const placeholder = quiet(latest, action.key)
        ? null
        : await api('sendMessage', {
            chat_id: routeChatId(action.key),
            ...threadParams(action.key),
            text: '▶️ 会话已启动，开始处理排队的消息…',
            reply_parameters: { message_id: action.messageId, allow_sending_without_reply: true },
          }).catch(() => null);
      await update((state) =>
        markPending(state, action.sessionId, { key: action.key, placeholderId: placeholder?.message_id })
      );
      if (!quiet(latest, action.key)) typingStart(action.key);
      return true;
    }
    const steer = action.deliverAs === 'steer';
    const placeholder = quiet(latest, action.key)
      ? null
      : await api('sendMessage', {
          chat_id: routeChatId(action.key),
          ...threadParams(action.key),
          text: steer ? '↪️ 已插入当前任务' : '⏳ 已收到，处理中…',
          reply_parameters: { message_id: action.messageId, allow_sending_without_reply: true },
        }).catch(() => null);
    await update((state) => {
      const existing = pendingTargets(state, action.sessionId).find((t) => t.key === action.key);
      if (!(steer && existing)) markPending(state, action.sessionId, { key: action.key, placeholderId: placeholder?.message_id });
    });
    try {
      await inject();
      if (!quiet(latest, action.key)) typingStart(action.key);
      done();
    } catch (error) {
      const queue = notRunning(error);
      await update((state) => {
        state.pending[rootSession(action.sessionId)] = pendingTargets(state, action.sessionId).filter(
          (t) => t.key !== action.key
        );
        if (queue) {
          const k = rootSession(action.sessionId);
          state.queue = { ...state.queue, [k]: [...(state.queue?.[k] ?? []), action].slice(-MAX_QUEUED) };
        }
      });
      if (!queue) done();
      const text = queue
        ? '⏸ 绑定的会话还没启动，消息已排队，会话启动后自动处理（EnsoCode 窗口需要开着）。'
        : explain(error);
      if (placeholder) await edit(action.key, placeholder.message_id, text);
      else await send(action.key, text);
    }
    return true;
  };

  /** 逐个会话按顺序重投排队的消息 */
  let flushing = null;
  const flush = (only) =>
    (flushing ??= (async () => {
      const queue = (await load()).queue ?? {};
      for (const [sid, items] of Object.entries(queue)) {
        if (only && sid !== rootSession(only)) continue;
        for (const item of items) {
          if (!(await deliverInject(item, true))) break;
          await update((state) => {
            const rest = (state.queue?.[sid] ?? []).filter(
              (q) => !(q.key === item.key && q.messageId === item.messageId)
            );
            if (rest.length) state.queue[sid] = rest;
            else delete state.queue?.[sid];
          });
        }
      }
    })().finally(() => (flushing = null)));

  // ---- 攒批与相册缓冲（内存态；重启丢失可接受，Telegram 不会重投同一条） ----
  // 缓冲按「路由 + 角色」分组，管理员与普通用户的消息绝不合并进同一条注入
  const textBuffers = new Map(); // `${routeKey}|admin|user` -> { routeKey, actions: [], firstAt, lastAt, timer }
  const albums = new Map(); // `${key}|${mediaGroupId}` -> { actions: [], timer, inflight, done }
  const bufferKeyOf = (action) => `${action.key}|${action.admin ? 'admin' : 'user'}`;
  /** steer/stop 等控制指令不进入攒批 */
  const instantKind = (action) => action.deliverAs === 'steer';

  /** 路由刚被关掉：停 typing，丢掉它还没投出去的攒批与相册（deliverInject 投递前还会再查一次开关） */
  const silence = (key) => {
    typingStop(key);
    for (const [id, buf] of [...textBuffers, ...albums]) {
      if ((buf.routeKey ?? id.slice(0, id.lastIndexOf('|'))) !== key) continue;
      if (buf.timer) {
        clearTimeout(buf.timer);
        self.timeouts.delete(buf.timer);
      }
      textBuffers.delete(id);
      albums.delete(id);
    }
  };

  /** 立即投递一个缓冲；给的是路由 key 时投递该路由的全部角色缓冲 */
  const flushTextBuffer = async (key) => {
    if (!textBuffers.has(key)) {
      for (const [bk, b] of [...textBuffers]) if (b.routeKey === key) await flushTextBuffer(bk);
      return;
    }
    const buf = textBuffers.get(key);
    textBuffers.delete(key);
    if (buf.timer) {
      clearTimeout(buf.timer);
      self.timeouts.delete(buf.timer);
    }
    const merged = mergeBuffered(buf.actions);
    await update((state) => {
      const r = state.routes[buf.routeKey];
      if (r) r.lastDeliveredAt = Date.now();
    });
    await deliverInject(merged).catch((e) => console.error('[telegram]', e?.message ?? e));
  };

  /** 统一登记一次性定时器：触发即自动注销，避免常驻运行时无限增长 */
  const armTimeout = (fn, ms) => {
    const t = setTimeout(() => {
      self.timeouts.delete(t);
      fn();
    }, ms);
    if (t.unref) t.unref();
    self.timeouts.add(t);
    return t;
  };

  const scheduleBuffer = (key, waitMs) => {
    const buf = textBuffers.get(key);
    if (!buf) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      self.timeouts.delete(buf.timer);
    }
    buf.timer = armTimeout(() => void tryFlushTextBuffer(key).catch(() => {}), Math.max(waitMs, 100));
  };

  /** 定时器到点不代表该发：重读最新路由配置重新判定，仍需等待就继续排下一跳 */
  const tryFlushTextBuffer = async (key) => {
    const buf = textBuffers.get(key);
    if (!buf) return;
    const r = (await load()).routes[buf.routeKey];
    const decision = bufferDecision(
      { debounceSec: r?.debounceSec ?? 0, minIntervalSec: r?.minIntervalSec ?? 0, lastDeliveredAt: r?.lastDeliveredAt ?? 0 },
      buf,
      Date.now()
    );
    if (decision.deliver) return flushTextBuffer(key);
    scheduleBuffer(key, decision.waitMs);
  };

  /** 普通注入动作：按路由 debounce/minInterval 攒批；steer 立即投递 */
  const deliverOrBuffer = async (action) => {
    if (instantKind(action)) return deliverInject(action);
    const state = await load();
    const r = state.routes[action.key];
    const debounceMs = (r?.debounceSec ?? 0) * 1000;
    const intervalMs = (r?.minIntervalSec ?? 0) * 1000;
    if (!debounceMs && !intervalMs) return deliverInject(action);
    const now = Date.now();
    const bufKey = bufferKeyOf(action);
    let buf = textBuffers.get(bufKey);
    if (!buf) {
      buf = { routeKey: action.key, actions: [], firstAt: now, lastAt: now, timer: null };
      textBuffers.set(bufKey, buf);
    }
    buf.actions.push(action);
    buf.lastAt = now;
    const decision = bufferDecision(
      { debounceSec: r?.debounceSec ?? 0, minIntervalSec: r?.minIntervalSec ?? 0, lastDeliveredAt: r?.lastDeliveredAt ?? 0 },
      buf,
      now
    );
    if (decision.deliver) return flushTextBuffer(bufKey);
    scheduleBuffer(bufKey, decision.waitMs);
    // 给用户一个已入缓冲的即时反馈（仅第一次）
    if (buf.actions.length === 1 && !quiet(state, action.key)) {
      await api('sendMessage', {
        chat_id: routeChatId(action.key),
        ...threadParams(action.key),
        text: `📥 已收到，将在安静期结束后合并处理…`,
        reply_parameters: { message_id: action.messageId, allow_sending_without_reply: true },
      }).catch(() => {});
    }
  };

  /** 相册：同 media_group_id 的分片 1.2s 防抖合并；in-flight 下载计入等待 */
  const albumArrive = async (action) => {
    const aid = `${action.key}|${action.mediaGroupId}`;
    let album = albums.get(aid);
    if (!album) {
      album = { actions: [], timer: null, firstAt: Date.now() };
      albums.set(aid, album);
    }
    album.actions.push(action);
    if (album.timer) {
      clearTimeout(album.timer);
      self.timeouts.delete(album.timer);
    }
    album.timer = armTimeout(() => void flushAlbum(aid).catch((e) => console.error('[telegram]', e?.message ?? e)), ALBUM_DEBOUNCE_MS);
    // 超时兜底：8s 还没凑齐也投递
    if (Date.now() - album.firstAt > ALBUM_WAIT_MS) void flushAlbum(aid).catch(() => {});
  };

  const flushAlbum = async (aid) => {
    const album = albums.get(aid);
    if (!album) return;
    albums.delete(aid);
    if (album.timer) {
      clearTimeout(album.timer);
      self.timeouts.delete(album.timer);
    }
    const actions = album.actions;
    // 整组唯一 caption：第一个非空文本；无文本则占位
    const caption = actions.map((a) => (a.text === '（用户发来图片）' ? '' : a.text)).find((t) => t) || '（用户发来一组图片）';
    const images = actions.filter((a) => a.image).map((a) => a.image);
    const skipped = actions.length - images.length;
    const first = actions[0];
    const merged = {
      ...first,
      text: caption,
      images,
      image: undefined,
      messageIds: actions.map((a) => a.messageId),
      note: skipped ? `${skipped} 张图片超过 5MB 或格式不支持，已跳过` : undefined,
    };
    delete merged.mediaGroupId;
    await deliverOrBuffer(merged);
  };

  // ---- ask_user ----
  const askCards = async (state, ask, shortId) => {
    const routes = routesOfSession(state, ask.sessionId).filter(({ route: r }) => isRouteEnabled(r));
    if (!routes.length) return [];
    const question = ask.question;
    const body = ask.options?.length
      ? `❓ ${question}\n\n点击按钮作答，或直接回复此消息输入自定义内容：`
      : `❓ ${question}\n\n请直接回复此消息作答：`;
    const cards = [];
    for (const { key } of routes) {
      try {
        const keyboard = ask.options?.length
          ? {
              inline_keyboard: ask.options
                .map((opt, i) => {
                  const data = encodeAskCallback(ask.requestId, i);
                  return data ? [{ text: `${i === (ask.recommendedIdx ?? -1) ? '★ ' : ''}${opt}`.slice(0, 60), callback_data: data }] : null;
                })
                .filter(Boolean),
            }
          : undefined;
        const msg = await api('sendMessage', {
          chat_id: routeChatId(key),
          ...threadParams(key),
          text: body.slice(0, 3900),
          ...(keyboard?.inline_keyboard.length ? { reply_markup: keyboard } : {}),
        });
        cards.push({ key, messageId: msg.message_id });
      } catch (error) {
        console.error('[telegram] ask 卡片发送失败', error?.message ?? error);
      }
    }
    return cards;
  };

  const onAskRequest = async (data) => {
    if (!data?.requestId || !data?.sessionId) return;
    const result = await update((state) => {
      const shortId = registerAsk(state, {
        sessionId: data.sessionId,
        requestId: data.requestId,
        question: data.question,
        options: data.options,
      });
      const ask = state.asks[shortId];
      if (data.recommended != null && Array.isArray(data.options)) {
        ask.recommendedIdx = data.options.findIndex((o) => o === data.recommended);
      }
      return { ask, shortId, state };
    });
    const cards = await askCards(result.state, result.ask, result.shortId);
    if (cards.length) {
      await update((state) => {
        const ask = state.asks[result.shortId];
        if (ask) ask.cards = cards;
      });
    }
  };

  const closeAskCards = async (closed, note) => {
    for (const ask of closed) {
      for (const card of ask.cards ?? []) {
        await api('editMessageText', {
          chat_id: routeChatId(card.key),
          message_id: card.messageId,
          text: `❓ ${ask.question}\n\n${note}`,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
    }
  };

  // 本插件正在/刚处理完的 requestId：宿主推回的 ask_resolved 不得把「某人选择了：X」覆盖成「已在别处作答」
  const answeringAsks = new Set();

  const onAskResolved = async (data) => {
    if (!data?.requestId || !data?.sessionId) return;
    if (answeringAsks.has(String(data.requestId))) return;
    const closed = await update((state) => closeAsksFor(state, data.sessionId, data.requestId));
    const by = data.answer ? `已在别处作答：${String(data.answer).slice(0, 80)}` : '已在别处作答或已取消';
    await closeAskCards(closed, by);
  };

  /** 点击选项按钮 */
  const answerAskClick = async (action) => {
    const answerCb = (text) =>
      api('answerCallbackQuery', { callback_query_id: action.callbackId, ...(text ? { text } : {}) }).catch(() => {});
    const state0 = await load();
    const ask = state0.asks[action.shortId];
    if (!ask || !ask.open) {
      await answerCb('该提问已失效');
      if (action.messageId) {
        await api('editMessageReplyMarkup', {
          chat_id: routeChatId(action.key),
          message_id: action.messageId,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
      return;
    }
    // 作答等于替会话拿主意：只有管理员可以
    if (!isAdmin(state0, action.userId)) {
      await answerCb('⛔ 只有管理员可以作答');
      return;
    }
    if (typeof enso.session.answerAsk !== 'function') {
      await answerCb('当前 EnsoCode 版本不支持远程作答，请升级');
      return;
    }
    const answer = ask.options?.[action.optionIdx];
    if (answer === undefined) {
      await answerCb('选项已失效');
      return;
    }
    answeringAsks.add(String(ask.requestId));
    try {
      let res;
      try {
        res = await enso.session.answerAsk({ sessionId: ask.sessionId, requestId: ask.requestId, answer });
      } catch (error) {
        await answerCb(`作答失败：${error?.message ?? error}`.slice(0, 180));
        return;
      }
      if (!res?.ok) {
        await answerCb((res?.error ? `作答失败：${res.error}` : '该提问已失效').slice(0, 180));
        return;
      }
      await answerCb(`✓ ${answer}`.slice(0, 180));
      const closed = await update((state) => closeAsksFor(state, ask.sessionId, ask.requestId));
      await closeAskCards(closed, `${action.userName ?? '有人'} 选择了：${answer}`);
    } finally {
      // 稍后再清，挡住紧随其后的宿主 ask_resolved 推送
      setTimeout(() => answeringAsks.delete(String(ask.requestId)), 5_000).unref?.();
    }
  };

  /** 自由文本作答：返回 true 表示这条消息被当作答案消费掉了 */
  const tryAnswerFreeText = async (update, action) => {
    // steer 是显式控制指令，绝不能被当成答案吞掉；带图消息也不是答案
    if (action.kind !== 'inject' || action.deliverAs === 'steer' || action.image || action.images) return false;
    const m = update.message;
    const state = await load();
    const open = openAsksForSession(state, action.sessionId);
    if (!open.length) return false;
    // 论坛话题的根消息自动挂载不是用户有意回复
    const isRootReply = isTopicRootReply(m);
    const replyToId = isRootReply ? undefined : m.reply_to_message?.message_id;
    let ask = null;
    if (replyToId != null) {
      // 卡片消息 id 跨群可能碰撞：路由 key 也必须一致
      ask = open.find((a) => (a.cards ?? []).some((c) => c.key === action.key && c.messageId === replyToId)) ?? null;
    }
    const explicit = !!ask;
    // 唯一待答 + 普通文字消息（未回复卡片但会话只有一个待答）
    if (!ask && open.length === 1 && (!m.reply_to_message || isRootReply)) ask = open[0];
    if (!ask || typeof enso.session.answerAsk !== 'function') return false;
    // 普通用户不能替会话作答：明确回复卡片的告知一声，其余照常当普通消息投递
    if (!action.admin) {
      if (!explicit) return false;
      await send(action.key, '⛔ 只有管理员可以回答提问，你的回复没有提交。').catch(() => {});
      return true;
    }
    answeringAsks.add(String(ask.requestId));
    try {
      const res = await enso.session.answerAsk({ sessionId: ask.sessionId, requestId: ask.requestId, answer: action.text });
      if (!res?.ok) return false;
    } catch {
      return false;
    } finally {
      setTimeout(() => answeringAsks.delete(String(ask.requestId)), 5_000).unref?.();
    }
    const closed = await update((state) => closeAsksFor(state, ask.sessionId, ask.requestId));
    await closeAskCards(closed, `${action.fromName ?? action.from} 回复了：${action.text.slice(0, 80)}`);
    await send(action.key, `✅ 已把你的回复「${action.text.slice(0, 60)}」作为答案提交。`).catch(() => {});
    return true;
  };

  // ---- 入站动作分发 ----
  const handle = async (action, update) => {
    if (action.callbackId && action.kind !== 'askAnswer') {
      await api('answerCallbackQuery', {
        callback_query_id: action.callbackId,
        ...(action.kind === 'answer' && action.text ? { text: action.text } : {}),
      }).catch(() => {});
    }
    switch (action.kind) {
      case 'answer':
      case 'ignore':
        return;
      case 'sessions':
        return showSessions(action);
      case 'switched': {
        const text = `🔀 已切换到会话「${action.title}」，之后的消息会发到这里。`;
        if (action.messageId) return edit(action.key, action.messageId, text);
        return send(action.key, text);
      }
      case 'reply':
        return send(action.key, action.text);
      case 'bound':
        return send(action.key, action.text);
      case 'askAnswer':
        return answerAskClick(action);
      case 'stop': {
        try {
          await enso.session.abort(action.sessionId);
          typingStop(action.key);
          return send(action.key, '⏹ 已停止当前任务。');
        } catch (error) {
          if (error?.code === 'ABORT_FAILED') return send(action.key, '没有正在运行的任务。');
          if (error?.code === 'UNSUPPORTED' || error?.code === 'INVALID_ARGS' || /session\.abort/.test(error?.message))
            return send(action.key, '当前 EnsoCode 版本不支持远程停止，请升级。');
          return send(action.key, explain(error));
        }
      }
      case 'inject': {
        if (await tryAnswerFreeText(update, action)) return;
        // 相册分片：进相册缓冲合并且只投一次
        if (action.mediaGroupId && action.image) return albumArrive(action);
        return deliverOrBuffer(action);
      }
    }
  };

  // ---- 长轮询 ----
  const pollOnce = async (seconds, me) => {
    const pollToken = await tokenOf();
    const { offset, commandsVersion } = await load();
    if (commandsVersion !== COMMANDS_VERSION) {
      await api('setMyCommands', { commands: COMMANDS }, true, pollToken).catch(() => {});
      await update((state) => {
        state.commandsVersion = COMMANDS_VERSION;
      });
    }
    // 唤醒/打断必须打同一个 Bot：换 Token 或断开时这轮 25s 长轮询才会立刻返回
    self.wake = () => void api('getUpdates', { offset, timeout: 0, limit: 1 }, true, pollToken).catch(() => {});
    let updates;
    try {
      updates = await api('getUpdates', {
        offset,
        timeout: seconds,
        allowed_updates: ['message', 'callback_query'],
      }, true, pollToken);
    } finally {
      self.wake = null;
    }
    if (!updates.length) return [];
    return update((state) =>
      updates.map((u) => {
        state.offset = Math.max(state.offset, u.update_id + 1);
        return { action: route(state, u, Date.now(), me), update: u };
      })
    );
  };

  const tick = async (seconds = POLL_SECONDS) => {
    if (!(await tokenOf())) return false;
    const items = await pollOnce(seconds, await identity());
    for (const { action, update } of items)
      await handle(action, update).catch((error) => console.error('[telegram]', error?.message ?? error));
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

  // ---- 出站事件 ----
  const progress = new Map();
  /** 路由被关掉（静音）：回发、进度、镜像都跳过；路由已不存在时沿用旧行为照发 */
  const isMuted = (state, key) => state.routes[key]?.enabled === false;
  enso.events.on('tool_call', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    const key = rootSession(ctx.sessionId);
    const entry = progress.get(key) ?? { steps: 0, at: 0 };
    entry.steps += 1;
    progress.set(key, entry);
    if (Date.now() - entry.at < PROGRESS_EVERY_MS) return;
    entry.at = Date.now();
    const state = await load();
    const targets = pendingTargets(state, key).filter((t) => t.placeholderId && !isMuted(state, t.key) && !quiet(state, t.key));
    const who = ctx.agent ? `${ctx.agent.name} · ` : '';
    for (const t of targets)
      await edit(t.key, t.placeholderId, `⏳ 处理中…（第 ${entry.steps} 步：${who}${data?.toolName ?? '工具'}）`);
  });

  enso.events.on('agent_end', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    void flush(ctx.sessionId).catch(() => {});
    if (ctx.agent) return;
    // silent：秘书 silence_turn 等不回发不镜像
    if (data?.silent === true) {
      // 秘书 silence_turn 等：既不回发也不镜像，但要把待回清掉，避免下轮借尸还魂
      const before = await load();
      const silentTargets = pendingTargets(before, ctx.sessionId);
      await update((state) => {
        delete state.pending[rootSession(ctx.sessionId)];
      });
      progress.delete(rootSession(ctx.sessionId));
      for (const t of silentTargets) {
        typingStop(t.key);
        if (!t.placeholderId || isMuted(before, t.key)) continue;
        // 关进度提示前留下的占位直接删掉，免得聊天里一直卡着「⏳」
        if (quiet(before, t.key))
          await api('deleteMessage', { chat_id: routeChatId(t.key), message_id: t.placeholderId }).catch(() => {});
        else await edit(t.key, t.placeholderId, '🤫 本轮已在别处静默处理。');
      }
      return;
    }
    const text = String(data?.text ?? '').trim();
    // 待回照样从 pending 取走（避免堆积），只是静音路由不发
    const { reply, muted } = await update((state) => {
      const taken = takeReply(state, ctx.sessionId, text);
      return { reply: taken, muted: new Set((taken?.targets ?? []).filter((t) => isMuted(state, t.key)).map((t) => t.key)) };
    });
    progress.delete(rootSession(ctx.sessionId));
    for (const t of reply?.targets ?? []) typingStop(t.key);
    const answered = [];
    for (const t of reply?.targets ?? []) {
      if (!visuallyEmpty(reply.text) && !muted.has(t.key)) {
        await send(t.key, reply.text, t.placeholderId).catch((e) => console.error('[telegram]', e.message));
      }
      answered.push(t.key);
    }
    if (!text || visuallyEmpty(text)) return;
    for (const key of mirrorTargets(await load(), ctx.sessionId, answered))
      await send(key, text).catch((e) => console.error('[telegram]', e.message));
  });

  enso.events.on('input', async (data, ctx) => {
    if (!ctx?.sessionId) return;
    void flush(ctx.sessionId).catch(() => {});
    if (ctx.agent || data?.source === 'extension') return;
    const text = String(data?.text ?? '').trim();
    if (!text || visuallyEmpty(text)) return;
    for (const key of mirrorTargets(await load(), ctx.sessionId))
      await send(key, `💬 EnsoCode：${text}`).catch(() => {});
  });

  // ask_user 事件：宿主按清单声明分发；更老的宿主（不认识这两个事件名）会在插件加载校验阶段拒收，根本走不到这里
  enso.events.on('ask_request', async (data, ctx) => {
    await onAskRequest({ ...data, sessionId: data?.sessionId ?? ctx?.sessionId }).catch((e) =>
      console.error('[telegram] ask_request', e?.message ?? e)
    );
  });
  enso.events.on('ask_resolved', async (data, ctx) => {
    await onAskResolved({ ...data, sessionId: data?.sessionId ?? ctx?.sessionId }).catch((e) =>
      console.error('[telegram] ask_resolved', e?.message ?? e)
    );
  });

  // ---- 出站媒体：telegram_send_media ----
  /** 目录白名单（与 tgclient 一致）：系统临时目录、调用会话的项目、EnsoCode 的 worktree 与聊天图片目录、额外配置目录 */
  const mediaRoots = ({ projectRoot } = {}) => {
    const roots = ['/tmp', '/private/tmp', tmpdir(), '/var/folders', '/private/var/folders'];
    if (projectRoot) roots.push(String(projectRoot));
    const userData = String(enso.dataDir ?? '').match(/^(.+)[\\/]extension-plugins[\\/]data[\\/][^\\/]+[\\/]?$/)?.[1];
    if (userData) roots.push(join(userData, 'bot-chats'), join(userData, 'worktrees'));
    for (const d of String(process.env.ENSO_USER_IMAGE_DIRS ?? '').split(delimiter)) if (isAbsolute(d)) roots.push(d);
    return roots;
  };
  const sniffImage = (buf) => {
    for (const sig of IMAGE_SIGS) {
      if (sig.magic.every((b, i) => buf[i] === b)) {
        if (!sig.offset8) return sig.mime;
        if (sig.offset8.every((b, i) => buf[8 + i] === b)) return sig.mime;
      }
    }
    return null;
  };
  /** 目录与文件都先 realpath；根目录/家目录本身不能当白名单；同一文件句柄校验大小后再读，防 TOCTOU 与超大文件 OOM */
  const readMediaFile = async (path, roots) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`只接受本地绝对路径：${path}`);
    const real = await realpath(path).catch(() => null);
    if (!real) throw new Error(`读不到文件：${path}`);
    const broad = await Promise.all(['/', homedir()].map((p) => realpath(p).catch(() => p)));
    const allowed = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r) => r && !broad.includes(r));
    const inside = allowed.some((r) => {
      const rel = relative(r, real);
      return rel && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!inside) throw new Error(`${path} 不在允许的目录里（系统临时目录、当前会话的项目或 worktree、聊天图片目录）`);
    const fh = await open(real, 'r');
    let buf;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error(`不是文件：${path}`);
      if (st.size > MEDIA_MAX_BYTES) throw new Error(`文件超过 10MB：${basename(real)}`);
      buf = Buffer.alloc(st.size + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > st.size) throw new Error(`${path} 在读取时还在变化，请等它写完再发`);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const mime = sniffImage(buf);
    if (!mime) throw new Error(`不是支持的图片（png/jpg/gif/webp）：${basename(real)}`);
    return { data: buf, mime, filename: basename(real) };
  };

  /**
   * 发送一组图片（media 为已读取的 {data,mime,filename}）：gif 单独 sendAnimation，其余 1 张 sendPhoto、多张 sendMediaGroup。
   * 分块同时受「每批 ≤10 张」和「单批原始字节 ≤14MB」限制（宿主 MAX_FETCH_BODY_BYTES 16MB，base64 后留余量）。
   * 回执不明（5xx/超时/TOO_LARGE 等非 400 错误）绝不自动重发，但计入 failures 如实回报，不静默吞错。
   */
  const MEDIA_BATCH_BYTES = 14 * 1024 * 1024;
  const chunkMedia = (stills) => {
    const chunks = [];
    let cur = [];
    let bytes = 0;
    for (const m of stills) {
      if (cur.length && (cur.length >= 10 || bytes + m.data.length > MEDIA_BATCH_BYTES)) {
        chunks.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(m);
      bytes += m.data.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  };
  const sendMediaTo = async (key, media, caption) => {
    const chatId = routeChatId(key);
    const thread = threadParams(key);
    const cap = (caption ?? '').slice(0, CAPTION_MAX);
    const extraCaption = caption && caption.length > CAPTION_MAX ? caption.slice(CAPTION_MAX) : null;
    const stills = media.filter((m) => m.mime !== 'image/gif');
    const gifs = media.filter((m) => m.mime === 'image/gif');
    const chunks = chunkMedia(stills);
    let captionUsed = false;
    const useCaption = () => {
      if (!captionUsed && cap) {
        captionUsed = true;
        return cap;
      }
      return undefined;
    };
    let sent = 0;
    const failures = [];
    const definiteRejects = [];
    for (const chunk of chunks) {
      try {
        if (chunk.length === 1) {
          const one = chunk[0];
          await apiUpload('sendPhoto', { chat_id: chatId, ...thread, caption: useCaption() }, [
            { name: 'photo', filename: one.filename, mime: one.mime, data: one.data },
          ]);
        } else {
          const files2 = chunk.map((m, i) => ({ name: `file${i}`, filename: m.filename, mime: m.mime, data: m.data }));
          const firstCaption = useCaption();
          const mediaDesc = chunk.map((m, i) => ({
            type: 'photo',
            media: `attach://file${i}`,
            ...(i === 0 && firstCaption ? { caption: firstCaption } : {}),
          }));
          await apiUpload('sendMediaGroup', { chat_id: chatId, ...thread, media: JSON.stringify(mediaDesc) }, files2);
        }
        sent += chunk.length;
      } catch (error) {
        if (error.status === 400 && chunk.length > 1) {
          definiteRejects.push(...chunk);
        } else if (error.status === 400) {
          failures.push(`${chunk.length} 张被 Telegram 拒绝：${error?.message ?? error}`);
        } else {
          // 回执不明：可能已送达，绝不自动重发，但要如实回报
          failures.push(`${chunk.length} 张上传回执不明（未重发防重复）：${error?.message ?? error}`);
        }
        captionUsed = true;
      }
    }
    for (const m of definiteRejects) {
      try {
        await apiUpload('sendPhoto', { chat_id: chatId, ...thread, caption: useCaption() }, [
          { name: 'photo', filename: m.filename, mime: m.mime, data: m.data },
        ]);
        sent += 1;
      } catch (e) {
        failures.push(`单张 ${m.filename} 发送失败：${e?.message ?? e}`);
      }
    }
    for (const gif of gifs) {
      try {
        await apiUpload('sendAnimation', { chat_id: chatId, ...thread, caption: useCaption() }, [
          { name: 'animation', filename: gif.filename, mime: gif.mime, data: gif.data },
        ]);
        sent += 1;
      } catch (e) {
        failures.push(`GIF ${gif.filename} 发送失败：${e?.message ?? e}`);
      }
    }
    if (extraCaption) await send(key, extraCaption);
    return { sent, failures };
  };

  // ---- 侧栏 state ----
  const needSession = (ctx) => {
    if (!ctx?.sessionId) throw new Error('请先打开一个会话');
    return rootSession(ctx.sessionId);
  };
  const mask = (token) => (token && token.length > 10 ? `${token.slice(0, 5)}…${token.slice(-4)}` : token ? '•••' : null);

  const view = async (sessionId) => {
    const token = await tokenOf();
    const configured = !!token;
    const canSet = typeof enso.config?.set === 'function';
    const canAnswer = typeof enso.session?.answerAsk === 'function';
    let me = null;
    let error = null;
    if (configured) {
      try {
        me = await identity();
      } catch (e) {
        error = e?.message ?? String(e);
      }
    }
    const state = await load();
    const root = sessionId ? rootSession(sessionId) : null;
    const now = Date.now();
    const pairing = root && state.pairings.find((p) => p.sessionId === root && p.expiresAt > now);
    const sessions = (await listSessions()) ?? [];
    const titleOf = (id) => sessions.find((s) => s.id === id)?.title ?? '未知会话';
    const projectOf = (id) => sessions.find((s) => s.id === id)?.projectName;
    const routeView = ([key, r]) => ({
      key,
      chatId: splitRouteKey(key).chatId,
      topicId: splitRouteKey(key).topicId,
      chatType: r.chatType,
      title: r.title || state.knownChats[splitRouteKey(key).chatId]?.title || key,
      topicName: splitRouteKey(key).topicId
        ? state.knownChats[splitRouteKey(key).chatId]?.topics?.[splitRouteKey(key).topicId] ??
          (splitRouteKey(key).topicId === '1' ? 'General' : undefined)
        : undefined,
      sessionId: r.sessionId,
      session: r.sessionId ? titleOf(r.sessionId) : null,
      project: r.sessionId ? projectOf(r.sessionId) : undefined,
      sync: r.sync,
      enabled: r.enabled !== false,
      directTrigger: r.directTrigger,
      showProgress: r.showProgress !== false,
      whitelistMode: r.whitelistMode,
      allow: r.allow,
      requests: r.requests,
      context: r.context,
      debounceSec: r.debounceSec,
      minIntervalSec: r.minIntervalSec,
      promptPrefix: r.promptPrefix,
    });
    const routes = Object.entries(state.routes).map(routeView);
    const admins = state.admins ?? [];
    // 可一键设为管理员的熟人：白名单成员与私聊绑定的人（待批准的陌生人不算）
    const adminCandidates = [];
    for (const u of [
      ...(state.globalAllow ?? []),
      ...routes.flatMap((r) => r.allow ?? []),
      ...routes.filter((r) => r.chatType === 'private').map((r) => ({ id: Number(r.chatId), name: r.title })),
    ]) {
      if (!Number.isInteger(u?.id) || u.id <= 0 || u.id === ANONYMOUS_ADMIN) continue;
      if (admins.some((a) => a.id === u.id) || adminCandidates.some((a) => a.id === u.id)) continue;
      adminCandidates.push({ id: u.id, name: u.name || String(u.id) });
    }
    const knownChats = Object.values(state.knownChats)
      .map((c) => ({
        id: c.id,
        type: c.type,
        title: c.title,
        isForum: c.isForum === true,
        topics: Object.entries(c.topics ?? {}).map(([tid, name]) => ({ id: tid, name })),
        boundKeys: routes.filter((r) => r.chatId === String(c.id)).map((r) => r.key),
      }))
      .sort((a, b) => (a.title > b.title ? 1 : -1));
    return {
      configured,
      canSetToken: canSet,
      canAnswer,
      tokenHint: configured ? mask(token) : null,
      bot: me && { username: me.username, name: me.first_name, readsAll: me.can_read_all_group_messages },
      error,
      sessionId: root,
      pairing: pairing && {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        link: me?.username ? `https://t.me/${me.username}?start=${pairing.code}` : null,
        groupLink: me?.username ? `https://t.me/${me.username}?startgroup=${pairing.code}` : null,
      },
      routes,
      knownChats,
      sessions,
      globalAllow: state.globalAllow ?? [],
      admins,
      adminCandidates,
      running: root && sessions.length ? sessions.some((s) => s.id === root && s.running) : null,
      queued: root ? (state.queue?.[root] ?? []).length : 0,
    };
  };

  /** 通用路由编辑：按 key 找到路由改完返回最新视图 */
  const editRoute = async (args, ctx, fn) => {
    await update((state) => {
      const r = state.routes[args?.key];
      if (r) {
        fn(r);
        normalizeRoute(r);
      }
    });
    return view(ctx?.sessionId ?? null);
  };

  // ---- 侧栏方法 ----
  enso.renderer.handle('state', (_args, ctx) => view(ctx?.sessionId));

  /** 校验并连接：先 getMe 验证 token，再 config.set 持久化并重置轮询 */
  enso.renderer.handle('connect', async (args, ctx) => {
    const token = String(args?.token ?? '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Token 格式不对，应该类似 123456:ABC-DEF…');
    let me;
    try {
      me = await api('getMe', {}, true, token);
    } catch (error) {
      throw new Error(`Token 校验失败：${error?.message ?? error}`);
    }
    if (typeof enso.config?.set !== 'function') {
      return {
        ok: false,
        needsUpgrade: true,
        bot: { username: me.username, name: me.first_name },
        message: 'Token 有效，但当前 EnsoCode 版本不支持从面板保存：请到 设置 → 插件 → Telegram Bot 填写 Bot Token（并建议升级 EnsoCode）。',
      };
    }
    await enso.config.set({ botToken: token });
    // 换到不同的 Bot：重置 offset（旧 Bot 的高 update_id 会让新 Bot 收不到消息）并重新注册命令菜单
    const switched = bot && bot.id !== me.id;
    if (switched) {
      await update((state) => {
        state.offset = 0;
        state.commandsVersion = 0;
      });
    }
    bot = me;
    botTokenUsed = token;
    void self.wake?.();
    const fresh = await view(ctx?.sessionId ?? null);
    return { ...fresh, ok: true };
  });

  enso.renderer.handle('disconnect', async (_args, ctx) => {
    if (typeof enso.config?.set !== 'function') throw new Error('当前 EnsoCode 版本不支持从面板修改 Token：请到设置里清空，或升级 EnsoCode。');
    await enso.config.set({ botToken: null });
    bot = null;
    botTokenUsed = null;
    void self.wake?.();
    return view(ctx?.sessionId ?? null);
  });

  enso.renderer.handle('pair', async (_args, ctx) => {
    const sessionId = needSession(ctx);
    await update((state) => createPairing(state, sessionId, Date.now()));
    return view(sessionId);
  });

  /** 关掉配对卡片：配对码立刻作废，之后再发 /bind 这个码会被拒 */
  enso.renderer.handle('cancelPair', async (args, ctx) => {
    const code = args?.code != null && args.code !== '' ? String(args.code) : undefined;
    const sessionId = ctx?.sessionId ? rootSession(ctx.sessionId) : null;
    if (!sessionId && !code) throw new Error('请先打开一个会话');
    await update((state) => {
      if (sessionId) cancelPairing(state, sessionId, code);
      else state.pairings = state.pairings.filter((p) => p.code !== code);
    });
    return view(ctx?.sessionId ?? null);
  });

  /** 从已发现的群/话题直接绑定（不需要配对码） */
  enso.renderer.handle('bind', async (args, ctx) => {
    const sessionId = needSession(ctx);
    const chatId = String(args?.chatId ?? '');
    const topicId = args?.topicId != null && args.topicId !== '' ? String(args.topicId) : undefined;
    if (!chatId) throw new Error('缺少 chatId');
    const bound = await update((state) => {
      const key = routeKeyOf(chatId, topicId);
      const chat = state.knownChats[chatId];
      const r = bindRoute(state, {
        key,
        chatId: Number(chatId),
        topicId,
        chatType: chat?.type ?? (Number(chatId) < 0 ? 'supergroup' : 'private'),
        title: chat?.title,
        sessionId,
      });
      return { r, key };
    });
    await send(bound.key, '✅ 已从 EnsoCode 侧栏绑定，直接发消息即可。/help 查看用法。').catch(() => {});
    return view(sessionId);
  });

  enso.renderer.handle('unbind', async (args, ctx) => {
    const removed = await update((state) => unbindRoute(state, args?.key));
    if (removed) await send(args.key, '已在 EnsoCode 里解绑。').catch(() => {});
    return view(ctx?.sessionId ?? null);
  });

  enso.renderer.handle('route', async (args, ctx) => {
    const patch = args?.patch ?? {};
    // 「绑定当前」取点击时宿主传来的实时会话，面板上的 view.sessionId 可能还落后一次 1.5s 轮询
    const current = patch.bindCurrent === true ? needSession(ctx) : undefined;
    return editRoute(args, ctx, (r) => {
      if (current) r.sessionId = current;
      else if (patch.sessionId !== undefined) r.sessionId = rootSession(patch.sessionId);
      if (patch.enabled !== undefined) {
        r.enabled = patch.enabled === true;
        if (!r.enabled) silence(args.key);
      }
      if (patch.sync !== undefined) r.sync = patch.sync === true;
      if (patch.directTrigger !== undefined) r.directTrigger = patch.directTrigger === true;
      if (patch.showProgress !== undefined) {
        r.showProgress = patch.showProgress === true;
        // 进行中的轮次也立刻停掉「正在输入」
        if (!r.showProgress) typingStop(args.key);
      }
      if (patch.whitelistMode !== undefined && ['inherit', 'custom', 'open'].includes(patch.whitelistMode)) r.whitelistMode = patch.whitelistMode;
      if (patch.context !== undefined) r.context = patch.context;
      if (patch.debounceSec !== undefined) r.debounceSec = patch.debounceSec;
      if (patch.minIntervalSec !== undefined) r.minIntervalSec = patch.minIntervalSec;
      if (patch.promptPrefix !== undefined) r.promptPrefix = String(patch.promptPrefix).slice(0, MAX_PREFIX);
    });
  });

  /** 新建会话（宿主要求手势触发）并把路由改绑过去 */
  enso.renderer.handle('fresh', async (args, ctx) => {
    needSession(ctx);
    const { sessionId: created } = await enso.session.create({});
    const target = rootSession(created);
    await update((state) => {
      const r = state.routes[args?.key];
      if (r) r.sessionId = target;
    });
    if (args?.key) await send(args.key, '🆕 已切换到一个新会话，之后的消息会发到那里。').catch(() => {});
    return view(target);
  });

  // ---- 白名单管理 ----
  enso.renderer.handle('globalAllow', async (args, ctx) => {
    await update((state) => {
      const id = Number(args?.userId);
      if (!Number.isInteger(id) || id <= 0) return;
      const user = { id, name: String(args?.name ?? id).slice(0, 100) };
      if (args?.on === false) {
        state.globalAllow = (state.globalAllow ?? []).filter((u) => u.id !== id);
        // 同时清理各路由待批准/名单里的同名 id？保守起见只动全局
      } else {
        state.globalAllow = setAllowed(state.globalAllow, user, true);
      }
    });
    return view(ctx?.sessionId ?? null);
  });

  /** 批准/拒绝某条路由的待批准请求；on=true 同时进路由名单与全局名单；asAdmin=true 直接设为管理员 */
  enso.renderer.handle('approve', async (args, ctx) => {
    await update((state) => {
      const r = state.routes[args?.key];
      if (!r) return;
      const userId = Number(args?.userId);
      const user = [...(r.allow ?? []), ...(r.requests ?? [])].find((u) => u.id === userId) ?? { id: userId, name: String(userId) };
      if (args?.on === true && args?.asAdmin === true && !setAdmin(state, user, true))
        throw new Error('匿名管理员认不出是谁，不能设为管理员');
      r.requests = (r.requests ?? []).filter((u) => u.id !== userId);
      if (args?.on === true && args?.asAdmin !== true) {
        r.allow = setAllowed(r.allow, user, true);
        state.globalAllow = setAllowed(state.globalAllow, user, true);
      } else if (args?.on === false) {
        r.allow = setAllowed(r.allow, user, false);
      }
    });
    return view(ctx?.sessionId ?? null);
  });

  /** 面板增删管理员（可信）；匿名管理员与非法 id 拒绝 */
  enso.renderer.handle('admin', async (args, ctx) => {
    const id = Number(args?.userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('User ID 要是正整数');
    if (id === ANONYMOUS_ADMIN) throw new Error('匿名管理员认不出是谁，不能设为管理员');
    await update((state) => {
      const known = [
        ...(state.admins ?? []),
        ...(state.globalAllow ?? []),
        ...Object.values(state.routes).flatMap((r) => [...(r.allow ?? []), ...(r.requests ?? [])]),
      ].find((u) => u.id === id);
      const name = String(args?.name || known?.name || id).slice(0, 100);
      setAdmin(state, { id, name }, args?.on !== false);
    });
    return view(ctx?.sessionId ?? null);
  });

  /** 跳到路由绑定的会话；旧宿主跨项目跳转会报找不到 */
  enso.renderer.handle('focus', async (args) => {
    const raw = String(args?.sessionId ?? '').trim();
    if (!raw || raw.length > 256) throw new Error('缺少要跳转的会话');
    if (typeof enso.session?.focus !== 'function') throw new Error('当前 EnsoCode 版本不支持跳转会话，请升级 EnsoCode。');
    try {
      await enso.session.focus(rootSession(raw));
    } catch (error) {
      if (error?.code === 'NOT_FOUND' || error?.code === 'NO_SESSION')
        throw new Error('跳转失败：这个会话不在当前窗口（可能属于别的项目或已关闭）。请先打开它所在的项目；当前 EnsoCode 版本若不支持跨项目跳转，升级后即可直接跳过去。');
      if (error?.code === 'PERMISSION_DENIED') throw new Error('没有跳转会话的权限：请在 设置 → 插件 → Telegram Bot 确认 session.focus 权限，或升级 EnsoCode。');
      throw new Error(`跳转失败：${error?.message ?? error}`);
    }
    return { ok: true };
  });

  enso.renderer.handle('open', async (args) => {
    if (typeof args?.url === 'string' && args.url.startsWith('https://t.me/')) await enso.ui.openExternal(args.url);
    return null;
  });

  // ---- Agent 工具 ----
  /** 工具的目标路由：广播时跳过静音路由；显式指定静音路由或全都静音时说清楚 */
  const toolTargets = (state, sessionId, target) => {
    if (target) {
      const r = state.routes[target];
      if (!r) throw new Error(`没有这条路由：${target}`);
      if (!isRouteEnabled(r)) throw new Error(`该路由已暂停（静音）：${target}。在 EnsoCode「Telegram Bot」面板打开它的开关后才能发送。`);
      return { targets: [target], skipped: 0 };
    }
    const all = routesOfSession(state, sessionId);
    if (!all.length) throw new Error('本会话没有绑定 Telegram 聊天');
    const targets = all.filter(({ route: r }) => isRouteEnabled(r)).map((x) => x.key);
    if (!targets.length) throw new Error('本会话绑定的 Telegram 路由都已暂停（静音），没有发送。在 EnsoCode「Telegram Bot」面板打开开关后再试。');
    return { targets, skipped: all.length - targets.length };
  };
  const skippedNote = (n) => (n ? `（跳过 ${n} 个已静音的路由）` : '');

  enso.tools.register('telegram_reply', async (args, ctx) => {
    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text 不能为空');
    if (!ctx.sessionId) throw new Error('调用不属于任何会话');
    const sessionId = rootSession(ctx.sessionId);
    const { targets, skipped } = toolTargets(await load(), sessionId, args?.target);
    for (const key of targets) await send(key, text);
    return `已发送到 ${targets.length} 个 Telegram 聊天${skippedNote(skipped)}`;
  });

  enso.tools.register('telegram_send_media', async (args, ctx) => {
    if (!ctx.sessionId) throw new Error('调用不属于任何会话');
    const files = Array.isArray(args?.files) ? args.files.filter((f) => typeof f === 'string') : [];
    if (!files.length) throw new Error('files 需要 1-10 个本地图片绝对路径');
    if (files.length > 10) throw new Error('一次最多 10 张');
    const sessionId = rootSession(ctx.sessionId);
    const { targets, skipped } = toolTargets(await load(), sessionId, args?.target);
    // 多路由循环外只读一次文件；项目目录以调用会话的 projectRoot 为准
    const media = [];
    const roots = mediaRoots({ projectRoot: ctx?.projectRoot });
    for (const f of files) media.push(await readMediaFile(f, roots));
    const asAlbum = args?.asAlbum !== false;
    const failures = [];
    let totalSent = 0;
    for (const key of targets) {
      if (asAlbum) {
        const r = await sendMediaTo(key, media, args?.caption);
        totalSent += r.sent;
        failures.push(...r.failures);
      } else {
        // 逐张发送：caption ≤1024 放首张，超出部分单独发文字
        const cap = (args?.caption ?? '').slice(0, CAPTION_MAX);
        const extraCaption = args?.caption && String(args.caption).length > CAPTION_MAX ? String(args.caption).slice(CAPTION_MAX) : null;
        let captionUsed = false;
        for (const one of media) {
          const method = one.mime === 'image/gif' ? 'sendAnimation' : 'sendPhoto';
          try {
            await apiUpload(
              method,
              { chat_id: routeChatId(key), ...threadParams(key), ...(captionUsed || !cap ? {} : { caption: cap }) },
              [{ name: method === 'sendPhoto' ? 'photo' : 'animation', filename: one.filename, mime: one.mime, data: one.data }]
            );
            captionUsed = captionUsed || !!cap;
            totalSent += 1;
          } catch (e) {
            failures.push(`${one.filename} 发送失败：${e?.message ?? e}`);
          }
        }
        if (extraCaption) await send(key, extraCaption);
      }
    }
    const tail = failures.length ? `；注意：${failures.join('；')}`.slice(0, 900) : '';
    if (!totalSent && failures.length) throw new Error(`全部发送失败：${failures.join('；')}`.slice(0, 900));
    return `已发送 ${totalSent} 张图片到 ${targets.length} 个 Telegram 聊天${skippedNote(skipped)}${tail}`;
  });

  if (loop) {
    void pollLoop();
    self.timers.push(
      setInterval(
        () => flush().catch((e) => console.error('[telegram]', e?.message ?? e)),
        RETRY_EVERY_MS
      )
    );
  }
  return { tick, flush, flushTextBuffer, flushAlbum, typingTick, view };
}
