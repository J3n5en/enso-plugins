import { createHash } from 'node:crypto';
// enso.telegram 1.0 —— 纯函数核心：路由、迁移、富文本、限速、白名单判定。
// 不碰宿主与网络，main.mjs 负责 IO。state 形状见 migrate()。

export const STATE_VERSION = 2;
export const MAX_CONTEXT = 50;
export const MAX_PREFIX = 2000;
export const MAX_DEBOUNCE = 3600;
export const MAX_MIN_INTERVAL = 86400;
/** 上下文缓存的单条截断 */
const CONTEXT_CHARS = 500;
/** Telegram 下载单张图片的上限（宿主单次响应 5MB） */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MEDIA_KEYS = ['document', 'voice', 'video', 'audio', 'sticker', 'video_note', 'animation'];
const MAX_REQUESTS = 10;
const PAIR_TTL_MS = 10 * 60_000;
const MAX_PAIRINGS = 5;
/** 群里以匿名管理员身份发言时 from 固定是这个账号 */
const ANONYMOUS_ADMIN = 1087968824;
const SENDER_MAX = 128;
/** 零宽字符：视觉空消息检测 */
const ZERO_WIDTH = /[​‌‍⁠﻿\s]/g;

export const COMMANDS = [
  { command: 'help', description: '查看用法' },
  { command: 'status', description: '查看绑定与本路由配置' },
  { command: 'steer', description: '向正在运行的任务插话' },
  { command: 'stop', description: '停止正在运行的任务' },
  { command: 'sync', description: '开关 EnsoCode 对话同步（on / off）' },
  { command: 'allow', description: '回复某人的消息加白名单；单独发送查看名单' },
  { command: 'deny', description: '回复某人的消息移出白名单' },
  { command: 'context', description: '触发时附带最近几条其他消息（0 关闭）' },
  { command: 'session', description: '切换绑定的 EnsoCode 会话' },
  { command: 'bind', description: '绑定：/bind 配对码' },
  { command: 'unbind', description: '解除本话题/群的绑定' },
];

export const HELP = [
  '直接发消息即可交给 EnsoCode 会话，回复会自动发回这里。',
  '/steer <内容>：插入正在运行的任务（不受限速影响）',
  '/stop：停止正在运行的任务',
  '可以直接发图片或多图相册（附文字说明更好）。',
  '/sync on|off：把 EnsoCode 里的对话也同步到这里',
  '/status：查看绑定与本路由配置',
  '/unbind：解除本话题/群的绑定',
  '群聊里默认需要 @机器人 或回复机器人的消息；路由开了「免 @ 直发」则直接发即可。',
  '白名单：回复某人的消息发 /allow 或 /deny；单独发 /allow 查看名单。更多开关在 EnsoCode 右侧「Telegram」面板。',
  `/context <0-${MAX_CONTEXT}>：触发时附带最近几条其他人的消息`,
  '/session：切换这个聊天绑定的 EnsoCode 会话',
].join('\n');

// ---------- 基础 ----------

export const emptyState = () => ({
  version: STATE_VERSION,
  offset: 0,
  routes: {},
  knownChats: {},
  globalAllow: [],
  pairings: [],
  pending: {},
  history: {},
  menus: {},
  queue: {},
  asks: {},
  commandsVersion: 0,
});

export const routeKeyOf = (chatId, topicId) => {
  const chat = String(chatId);
  return topicId != null && topicId !== '' ? `${chat}:${topicId}` : chat;
};
/** 负数群 id 也安全：chatId 本身不含冒号，话题段在第一个冒号右侧 */
export const splitRouteKey = (key) => {
  const s = String(key);
  const i = s.indexOf(':');
  if (i === -1) return { chatId: s, topicId: undefined };
  return { chatId: s.slice(0, i), topicId: s.slice(i + 1) };
};
/** 出站参数：话题 1（General）绝不带 message_thread_id，其余话题带数字 thread */
export const threadParams = (key) => {
  const { topicId } = splitRouteKey(key);
  return topicId != null && topicId !== '1' ? { message_thread_id: Number(topicId) } : {};
};
export const routeChatId = (key) => {
  const raw = splitRouteKey(key).chatId;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
};

export const rootSession = (id) => String(id).split('::')[0];

/** 入站话题归属：论坛群无 thread 或 thread 为 1 都归 General（1）；非论坛只在 is_topic_message 时算话题 */
export const topicOf = (m) => {
  const chat = m?.chat;
  if (!chat) return undefined;
  const thread = m.message_thread_id;
  if (chat.is_forum === true) {
    if (thread == null || Number(thread) === 1) return '1';
    return String(thread);
  }
  return m.is_topic_message && thread != null ? String(thread) : undefined;
};

/** 路由匹配优先级 chatId:topicId > chatId；返回附 key 的副本 */
export const findRoute = (state, chatId, topicId) => {
  if (topicId != null) {
    const key = routeKeyOf(chatId, topicId);
    if (state.routes[key]) return { ...state.routes[key], key };
  }
  const key = routeKeyOf(chatId);
  if (state.routes[key]) return { ...state.routes[key], key };
  return null;
};

export const defaultRoute = () => ({
  chatType: 'group',
  title: '',
  sessionId: null,
  sync: false,
  directTrigger: false,
  whitelistMode: 'inherit', // inherit | custom | open
  allow: [],
  requests: [],
  context: 0,
  debounceSec: 0,
  minIntervalSec: 0,
  promptPrefix: '',
  lastDeliveredAt: 0,
});

// ---------- 迁移 ----------

/** 0.4.0 旧 state：{bindings[], pending, history, queue, menus, pairings, offset} 平滑迁移为 routeKey 结构 */
export function migrate(raw) {
  const state = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  state.version = STATE_VERSION;
  state.routes ??= {};
  state.knownChats ??= {};
  state.globalAllow ??= [];
  state.pairings ??= [];
  state.pending ??= {};
  state.history ??= {};
  state.menus ??= {};
  state.queue ??= {};
  state.asks ??= {};
  state.offset = Number(state.offset) || 0;

  if (Array.isArray(state.bindings)) {
    for (const b of state.bindings) {
      if (!b || b.chatId == null) continue;
      const key = routeKeyOf(b.chatId);
      if (state.routes[key]) continue;
      state.routes[key] = normalizeRoute({
        ...defaultRoute(),
        key,
        chatType: b.chatType ?? 'group',
        title: b.title ?? '',
        sessionId: b.sessionId ? rootSession(b.sessionId) : null,
        sync: b.sync === true,
        context: b.context,
        whitelistMode: b.whitelist ? 'custom' : 'inherit',
        allow: Array.isArray(b.allow) ? b.allow : [],
        requests: Array.isArray(b.requests) ? b.requests : [],
      });
      rememberChat(state, { id: Number(b.chatId), type: b.chatType, title: b.title });
    }
    delete state.bindings;
    // pending 目标里的 chatId 换成 key；旧 history/queue 的数字键在 JS 里本就当字符串用，语义不变
    for (const [sid, targets] of Object.entries(state.pending)) {
      if (!Array.isArray(targets)) {
        delete state.pending[sid];
        continue;
      }
      state.pending[sid] = targets.map((t) =>
        t && t.chatId != null && t.key == null ? { ...t, key: routeKeyOf(t.chatId) } : t
      );
    }
  }
  for (const key of Object.keys(state.history)) {
    if (!Array.isArray(state.history[key])) delete state.history[key];
  }
  for (const [k, r] of Object.entries(state.routes)) {
    normalizeRoute(r);
    r.key = k;
  }
  pruneAsks(state);
  return state;
}

export function normalizeRoute(r) {
  const d = defaultRoute();
  for (const key of Object.keys(d)) if (r[key] === undefined) r[key] = d[key];
  r.sync = r.sync === true;
  r.directTrigger = r.directTrigger === true;
  if (!['inherit', 'custom', 'open'].includes(r.whitelistMode)) r.whitelistMode = 'inherit';
  r.context = clampInt(r.context, 0, MAX_CONTEXT, 0);
  r.debounceSec = clampInt(r.debounceSec, 0, MAX_DEBOUNCE, 0);
  r.minIntervalSec = clampInt(r.minIntervalSec, 0, MAX_MIN_INTERVAL, 0);
  r.promptPrefix = String(r.promptPrefix ?? '').slice(0, MAX_PREFIX);
  if (!Array.isArray(r.allow)) r.allow = [];
  if (!Array.isArray(r.requests)) r.requests = [];
  return r;
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

// ---------- 群与话题名册 ----------

export function rememberChat(state, chat) {
  if (!chat || chat.id == null) return null;
  const id = String(chat.id);
  const prev = state.knownChats[id] ?? { id, type: chat.type ?? 'private', title: '', topics: {} };
  if (chat.type) prev.type = chat.type;
  if (chat.title) prev.title = String(chat.title).slice(0, 100);
  if (chat.is_forum != null) prev.isForum = chat.is_forum === true;
  prev.topics ??= {};
  prev.seenAt = Date.now();
  state.knownChats[id] = prev;
  return prev;
}

export function rememberTopic(state, chatId, topicId, name) {
  if (topicId == null || !name) return;
  const chat = state.knownChats[String(chatId)];
  if (!chat) return;
  chat.topics ??= {};
  chat.topics[String(topicId)] = String(name).slice(0, 100);
}

/** 从一条消息里顺手观察群名/话题名（forum_topic_created / edited / reply 携带） */
export function observeNames(state, m) {
  if (!m?.chat) return;
  const chat = rememberChat(state, m.chat);
  if (!chat) return;
  if (chat.isForum) {
    // 论坛群永远有 General；未见过的话题先记占位名，见到真名后覆盖
    chat.topics['1'] ??= 'General';
    const tid = topicOf(m);
    if (tid != null && chat.topics[tid] == null) chat.topics[tid] = `话题 #${tid}`;
  }
  if (m.forum_topic_created) rememberTopic(state, m.chat.id, m.message_thread_id, m.forum_topic_created.name);
  if (m.forum_topic_edited?.name) rememberTopic(state, m.chat.id, m.message_thread_id, m.forum_topic_edited.name);
  const replied = m.reply_to_message?.forum_topic_created;
  if (replied) rememberTopic(state, m.chat.id, m.reply_to_message.message_thread_id, replied.name);
}

// ---------- 用户与白名单 ----------

export const userOf = (u) => ({
  id: u.id,
  name:
    u.id === ANONYMOUS_ADMIN
      ? '匿名管理员'
      : u.username
        ? `@${u.username}`
        : [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id),
});

export const isBotUser = (u) => u?.is_bot && u.id !== ANONYMOUS_ADMIN;

/** 两层白名单：open 放全群；custom 只看本路由名单；inherit 用全局名单 + 本路由名单 */
export function isAllowed(state, route, userId) {
  if (userId == null) return true; // 匿名管理员无法按人过滤
  if (route.whitelistMode === 'open') return true;
  if ((route.allow ?? []).some((u) => u.id === userId)) return true;
  if (route.whitelistMode === 'custom') return false;
  return (state.globalAllow ?? []).some((u) => u.id === userId);
}

export function setAllowed(list, user, on) {
  const rest = (list ?? []).filter((u) => u.id !== user.id);
  return on ? [...rest, user] : rest;
}

export function addGlobalAllow(state, user) {
  state.globalAllow = setAllowed(state.globalAllow, user, true);
}

export function noteRequest(route, user) {
  route.requests = [user, ...(route.requests ?? []).filter((u) => u.id !== user.id)].slice(0, MAX_REQUESTS);
}

// ---------- 配对与绑定 ----------

export function createPairing(state, sessionId, now, random = Math.random) {
  const code = String(Math.floor(random() * 1e6)).padStart(6, '0');
  state.pairings = [
    { code, sessionId: rootSession(sessionId), expiresAt: now + PAIR_TTL_MS },
    ...state.pairings.filter((p) => p.expiresAt > now && p.code !== code),
  ].slice(0, MAX_PAIRINGS);
  return code;
}

/** 绑定/重绑一个路由；群聊首次绑定时绑定者进本路由名单并切成 custom 模式 */
export function bindRoute(state, { key, chatId, topicId, chatType, title, sessionId, user, sync, directTrigger, whitelistMode, context, debounceSec, minIntervalSec, promptPrefix }) {
  const prev = state.routes[key];
  const route = normalizeRoute({ ...defaultRoute(), ...(prev ?? {}), key });
  route.chatType = chatType ?? route.chatType;
  if (title) route.title = title;
  route.sessionId = rootSession(sessionId);
  if (topicId != null) route.topicId = String(topicId);
  if (sync !== undefined) route.sync = sync === true;
  if (directTrigger !== undefined) route.directTrigger = directTrigger === true;
  if (whitelistMode !== undefined && ['inherit', 'custom', 'open'].includes(whitelistMode)) route.whitelistMode = whitelistMode;
  if (context !== undefined) route.context = context;
  if (debounceSec !== undefined) route.debounceSec = debounceSec;
  if (minIntervalSec !== undefined) route.minIntervalSec = minIntervalSec;
  if (promptPrefix !== undefined) route.promptPrefix = promptPrefix;
  normalizeRoute(route);
  if (user) {
    route.allow = setAllowed(route.allow, user, true);
    route.requests = (route.requests ?? []).filter((u) => u.id !== user.id);
    if (!prev) route.whitelistMode = 'custom';
  }
  state.routes[key] = route;
  return route;
}

export function unbindRoute(state, key) {
  const route = state.routes[key];
  delete state.routes[key];
  delete state.history[key];
  delete state.menus[key];
  // 解绑整群时，顺带清掉该群下没有单独绑定的话题历史
  if (!splitRouteKey(key).topicId) {
    const prefix = `${splitRouteKey(key).chatId}:`;
    for (const hk of Object.keys(state.history)) {
      if (hk.startsWith(prefix) && !state.routes[hk]) delete state.history[hk];
    }
  }
  for (const sid of Object.keys(state.pending)) {
    const rest = (state.pending[sid] ?? []).filter((t) => t.key !== key);
    if (rest.length) state.pending[sid] = rest;
    else delete state.pending[sid];
  }
  return route ?? null;
}

// ---------- 命令与入站路由 ----------

export const parseCommand = (text) => {
  const m = /^\/([a-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
  return m ? { name: m[1].toLowerCase(), target: m[2], arg: (m[3] ?? '').trim() } : null;
};

export const isGroupChat = (chat) => chat?.type === 'group' || chat?.type === 'supergroup';

/** 论坛话题的「根消息自动挂载回复」：不是用户有意回复，不应当作回复机器人/回复卡片 */
export const isTopicRootReply = (m) =>
  m?.reply_to_message?.forum_topic_created != null ||
  (m?.is_topic_message === true && m?.reply_to_message?.message_id != null && m.reply_to_message.message_id === m.message_thread_id);

function summarize(m) {
  const text = String(m.text ?? m.caption ?? '').trim();
  const media = m.photo ? '[图片]' : MEDIA_KEYS.some((k) => m[k] !== undefined) ? '[文件/语音等]' : '';
  const body = [media, text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)}…` : text].filter(Boolean).join(' ');
  return body && { from: m.from ? userOf(m.from).name : '匿名', text: body };
}

/** 照片取不超过上限的最大尺寸；以文件发送的图片按 mime 识别 */
export function imageOf(m) {
  if (Array.isArray(m.photo) && m.photo.length) {
    const fit = m.photo
      .filter((p) => p?.file_id && (p.file_size ?? 0) <= IMAGE_MAX_BYTES)
      .sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    return fit ? { fileId: fit.file_id, mimeType: 'image/jpeg' } : 'too-large';
  }
  const doc = m.document;
  if (doc?.file_id && IMAGE_MIME.includes(doc.mime_type)) {
    if ((doc.file_size ?? 0) > IMAGE_MAX_BYTES) return 'too-large';
    return { fileId: doc.file_id, mimeType: doc.mime_type };
  }
  return null;
}

/** 注入文本：提示词前置在最顶部，然后是上下文，最后才是本条消息 */
export const inboundText = ({ from, text, context, promptPrefix }) => {
  const prefix = promptPrefix ? `${promptPrefix.trim().slice(0, MAX_PREFIX)}\n\n` : '';
  const head = context?.length
    ? `[Telegram 群聊里此前的其他消息，仅供参考]\n${context.map((c) => `${c.from}：${c.text}`).join('\n')}\n\n`
    : '';
  return `${prefix}${head}[Telegram 消息，来自 ${from}]\n\n${text}`;
};

const boundedId = (value) => {
  if (value == null) return undefined;
  const id = String(value).trim();
  return id.length >= 1 && id.length <= SENDER_MAX ? id : undefined;
};
const displayNameOf = (value) => {
  const name = String(value ?? '').trim().slice(0, SENDER_MAX);
  return name || undefined;
};
const fromNameOf = (value) => displayNameOf(String(value ?? '').replace(/\s+/g, ' '));

const inject = (route, key, text, from, m, deliverAs, extra = {}) => {
  const action = {
    kind: 'inject',
    key,
    chatId: m.chat.id,
    topicId: topicOf(m),
    sessionId: route.sessionId,
    text,
    from,
    messageId: m.message_id,
    deliverAs,
    ...extra,
  };
  if (m.from?.id != null && m.from.id !== ANONYMOUS_ADMIN) action.fromId = String(m.from.id);
  action.fromName = m.from ? fromNameOf(userOf(m.from).name) : fromNameOf(from);
  return action;
};

export function senderOf(action) {
  const chatId = boundedId(action?.key ?? action?.chatId);
  const userId = boundedId(action?.fromId);
  const displayName = displayNameOf(action?.fromName ?? action?.from);
  return {
    channel: 'telegram',
    ...(chatId ? { chatId } : {}),
    ...(userId && userId !== String(ANONYMOUS_ADMIN) ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

/**
 * 把一条 update 归类成动作。state 就地更新（上下文缓存/待批准/名册）。
 * bot: { id, username }；now: ms。
 */
export function route(state, update, now, bot = {}) {
  const action = decide(state, update, now, bot);
  const m = update?.message;
  if (!isGroupChat(m?.chat)) return action;
  // context 配置按路由匹配读（含整群兜底）；history 一律按实际话题 key 存取，
  // 这样只绑整群时各话题的上下文也互相隔离
  const hit = findRoute(state, m.chat.id, topicOf(m));
  const key = routeKeyOf(m.chat.id, topicOf(m));
  const size = hit?.context ?? 0;
  if (!size) {
    delete state.history[key];
    return action;
  }
  const history = state.history[key] ?? [];
  if (action.kind === 'inject') {
    if (history.length) action.context = history.slice(-size);
    delete state.history[key];
  } else if (action.kind !== 'bound' && !parseCommand(String(m.text ?? m.caption ?? '').trim())) {
    const line = summarize(m);
    if (line) state.history[key] = [...history, line].slice(-MAX_CONTEXT);
  }
  return action;
}

function decide(state, update, now, bot) {
  if (update?.callback_query) return routeCallback(state, update.callback_query);
  const m = update?.message;
  const chatId = m?.chat?.id;
  if (typeof chatId !== 'number') return { kind: 'ignore' };
  observeNames(state, m);
  const isGroup = isGroupChat(m.chat);
  const topicId = topicOf(m);
  const key = routeKeyOf(chatId, topicId);
  const chatKey = routeKeyOf(chatId);
  const from = m.from?.username ?? m.from?.first_name ?? String(m.from?.id ?? chatId);
  const reply = (text) => ({ kind: 'reply', key, chatId, topicId, text });
  let text = String(m.text ?? m.caption ?? '').trim();

  const hit = findRoute(state, chatId, topicId);

  const command = parseCommand(text);
  if (command?.target && command.target.toLowerCase() !== String(bot.username).toLowerCase())
    return { kind: 'ignore' };
  const mention = isGroup && bot.username ? new RegExp(`@${bot.username}\\b`, 'i') : null;
  const repliedToBot = m.reply_to_message?.from?.id === bot.id && bot.id !== undefined && !isTopicRootReply(m);

  // 配对绑定：/bind <码> 或深链 /start <码>；在话题里发出即绑定当前话题
  if (command?.name === 'bind' || (command?.name === 'start' && command.arg)) {
    const pairing = /^\d{6}$/.test(command.arg)
      ? state.pairings.find((p) => p.code === command.arg && p.expiresAt > now)
      : null;
    if (!pairing) return reply('配对码无效或已过期，请在 EnsoCode 侧栏「Telegram」里重新生成。');
    state.pairings = state.pairings.filter((p) => p.sessionId !== pairing.sessionId);
    const inTopic = (m.chat.is_forum === true || m.is_topic_message) && topicId != null;
    const bindKey = inTopic ? key : chatKey;
    bindRoute(state, {
      key: bindKey,
      chatId,
      topicId: inTopic ? topicId : undefined,
      chatType: m.chat.type,
      title: m.chat.title ?? from,
      sessionId: pairing.sessionId,
      user: isGroup && m.from ? userOf(m.from) : undefined,
    });
    const where = inTopic ? '本话题' : '本聊天';
    return {
      kind: 'bound',
      key: bindKey,
      chatId,
      topicId: inTopic ? topicId : undefined,
      sessionId: pairing.sessionId,
      text: `✅ ${where}已绑定到 EnsoCode 会话，直接发消息即可。/help 查看用法。`,
    };
  }
  if (!hit || !hit.sessionId) {
    return command?.name === 'start' && !isGroup
      ? reply('在 EnsoCode 侧栏「Telegram」里点「绑定」，再点链接或把配对码发给我：/bind 123456')
      : { kind: 'ignore' };
  }
  const key2 = hit.key;
  // findRoute 返回副本，找回 state 里的本体以便命令就地修改
  const live = state.routes[key2];
  const reply2 = (t) => ({ kind: 'reply', key: key2, chatId, topicId, text: t });

  if (isGroup && m.from && !isBotUser(m.from) && !isAllowed(state, live, m.from.id)) {
    if (!(command || mention?.test(text) || repliedToBot || live.directTrigger)) return { kind: 'ignore' };
    noteRequest(live, userOf(m.from));
    return reply2(`${userOf(m.from).name} 不在白名单里。请白名单成员回复 TA 的消息发 /allow，或在 EnsoCode 侧栏批准。`);
  }

  if (command) {
    switch (command.name) {
      case 'start':
      case 'help':
        return reply2(HELP);
      case 'status':
        return reply2(
          `已绑定会话 ${live.sessionId}\n同步 EnsoCode 对话：${live.sync ? '开' : '关'}` +
            `\n免 @ 直发：${live.directTrigger ? '开' : '关'}` +
            `\n白名单：${{ inherit: '继承全局', custom: `本路由（${live.allow?.length ?? 0} 人）`, open: '全群开放' }[live.whitelistMode]}` +
            `\n上下文：${live.context ? `最近 ${live.context} 条` : '关'}` +
            `\n攒批：${live.debounceSec ? `${live.debounceSec}s 安静期` : '即时'}；限速：${live.minIntervalSec ? `${live.minIntervalSec}s` : '不限'}` +
            (live.promptPrefix ? '\n提示词前置：已设置' : '')
        );
      case 'allow':
      case 'deny': {
        if (!isGroup) return reply2('白名单管理只用于群聊。');
        const target = m.reply_to_message?.from;
        if (!target || isBotUser(target)) {
          if (command.name === 'deny') return reply2('用法：回复某人的消息发 /deny');
          const names = (live.allow ?? []).map((u) => u.name).join('、') || '（空）';
          return reply2(
            `白名单模式：${{ inherit: '继承全局', custom: '本路由独立', open: '全群开放' }[live.whitelistMode]}\n本路由名单：${names}\n回复某人的消息发 /allow 添加（同时加入全局名单）。`
          );
        }
        const user = userOf(target);
        live.allow = setAllowed(live.allow, user, command.name === 'allow');
        live.requests = (live.requests ?? []).filter((u) => u.id !== user.id);
        if (command.name === 'allow') addGlobalAllow(state, user);
        return reply2(command.name === 'allow' ? `已把 ${user.name} 加入白名单。` : `已把 ${user.name} 移出本路由白名单。`);
      }
      case 'context': {
        if (!isGroup) return reply2('上下文只用于群聊。');
        if (!command.arg) return reply2(`当前附带最近 ${live.context} 条消息。用法：/context 5（0 关闭）`);
        const n = Number(command.arg);
        if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT) return reply2(`请给 0 到 ${MAX_CONTEXT} 的整数。`);
        live.context = n;
        return reply2(n ? `之后触发时会附带最近 ${n} 条其他消息。` : '已关闭群聊上下文。');
      }
      case 'session':
        if (!command.arg) return { kind: 'sessions', key: key2, chatId, topicId, current: live.sessionId };
        return switchSession(state, live, key2, Number(command.arg));
      case 'new':
        return reply2('请在 EnsoCode「Telegram」侧栏使用「新建会话」，或在 EnsoCode 里新建后发 /session 切过去。');
      case 'unbind':
        unbindRoute(state, key2);
        return { kind: 'reply', key: key2, chatId, topicId, text: '已解绑本话题/聊天。' };
      case 'sync': {
        if (!/^(on|off)$/i.test(command.arg)) return reply2('用法：/sync on 或 /sync off');
        live.sync = command.arg.toLowerCase() === 'on';
        return reply2(live.sync ? '已开启同步：EnsoCode 里的对话也会发到这里。' : '已关闭同步。');
      }
      case 'stop':
        return { kind: 'stop', key: key2, chatId, topicId, sessionId: live.sessionId };
      case 'steer':
        if (!command.arg) return reply2('用法：/steer 补充内容');
        return inject(live, key2, command.arg, from, m, 'steer');
    }
    return { kind: 'ignore' };
  }

  if (isGroup) {
    const triggered = mention?.test(text) || repliedToBot || live.directTrigger;
    if (!triggered) return { kind: 'ignore' };
    if (mention) text = text.replace(mention, '').trim();
  }
  const image = imageOf(m);
  if (image === 'too-large') return reply2('图片超过 5MB，请压缩后再发。');
  if (image) {
    return {
      ...inject(live, key2, text || '（用户发来图片）', from, m, 'followUp'),
      image,
      mediaGroupId: m.media_group_id,
    };
  }
  if (!text) {
    return MEDIA_KEYS.some((k) => m[k] !== undefined)
      ? reply2('暂只支持文字和图片，文件、语音等请附带文字说明或改用 EnsoCode。')
      : { kind: 'ignore' };
  }
  const action = inject(live, key2, text, from, m, 'followUp');
  if (m.media_group_id) action.mediaGroupId = m.media_group_id;
  return action;
}

function routeCallback(state, q) {
  const chatId = q.message?.chat?.id;
  const answer = (text = '') => ({ kind: 'answer', callbackId: q.id, text });
  if (typeof chatId !== 'number') return answer();
  const topicId = topicOf({
    chat: q.message.chat,
    message_thread_id: q.message.message_thread_id,
    is_topic_message: q.message.is_topic_message,
  });
  const hit = findRoute(state, chatId, topicId);
  const key = hit?.key ?? routeKeyOf(chatId, topicId);

  // ask_user 按钮：ask:<shortId>:<idx>
  const askHit = /^ask:([a-z0-9]+):(\d+)$/i.exec(q.data ?? '');
  if (askHit) {
    return {
      kind: 'askAnswer',
      key,
      chatId,
      chatType: q.message.chat.type,
      topicId,
      callbackId: q.id,
      messageId: q.message?.message_id,
      shortId: askHit[1].toLowerCase(),
      optionIdx: Number(askHit[2]),
      userId: q.from?.id,
      userName: q.from ? userOf(q.from).name : undefined,
    };
  }

  const sessHit = /^sess:(\d+)$/.exec(q.data ?? '');
  if (!hit || !sessHit) return answer();
  if (isGroupChat(q.message.chat) && !isAllowed(state, state.routes[hit.key], q.from?.id)) return answer('你不在白名单里');
  return {
    ...switchSession(state, state.routes[hit.key], hit.key, Number(sessHit[1])),
    callbackId: q.id,
    messageId: q.message.message_id,
    topicId,
  };
}

function switchSession(state, route, key, n) {
  const pick = state.menus?.[key]?.[n - 1];
  const base = { key, chatId: routeChatId(key), topicId: splitRouteKey(key).topicId };
  if (!pick) return { kind: 'reply', ...base, text: '列表已过期或序号不对，请重新发 /session。' };
  route.sessionId = rootSession(pick.id);
  return { kind: 'switched', ...base, sessionId: route.sessionId, title: pick.title };
}

// ---------- 出站辅助 ----------

export function chunkText(text, size = 4000) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 视觉空消息：去掉零宽字符与空白后什么都不剩 */
export const visuallyEmpty = (text) => !String(text ?? '').replace(ZERO_WIDTH, '');

/** 记下这个会话有一轮由 Telegram 发起，结束时回发；同一路由只保留最新的占位消息 */
export function markPending(state, sessionId, target) {
  const key = rootSession(sessionId);
  state.pending[key] = [...(state.pending[key] ?? []).filter((t) => t.key !== target.key), target];
}

export const pendingTargets = (state, sessionId) => state.pending[rootSession(sessionId)] ?? [];

/** 轮次结束：有待回且正文非空时取出并清掉待回 */
export function takeReply(state, sessionId, text) {
  const key = rootSession(sessionId);
  const targets = state.pending[key];
  const body = String(text ?? '').trim();
  if (!targets?.length || !body) return null;
  delete state.pending[key];
  return { targets, text: body };
}

/** 开启同步的路由 key，排除本轮已经回发过的 */
export const mirrorTargets = (state, sessionId, exclude = []) =>
  Object.entries(state.routes)
    .filter(([key, r]) => r.sync && r.sessionId === rootSession(sessionId) && !exclude.includes(key))
    .map(([key]) => key);

/** 该会话绑定的全部路由 */
export const routesOfSession = (state, sessionId) =>
  Object.entries(state.routes)
    .filter(([, r]) => r.sessionId === rootSession(sessionId))
    .map(([key, r]) => ({ key, route: r }));

// ---------- Markdown → Telegram HTML ----------

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 代码段先用 NUL 包裹的槽位占位，避免里面的内容被行内规则误伤
const SLOT = '\u0000';
/**
 * 先转义再转标签。支持标题、粗斜体、删除线、链接、引用、表格、行内代码与围栏代码块。
 * 代码块内容不做任何行内转换。
 */
export function markdownToHtml(md) {
  const slots = [];
  const hold = (html) => `${SLOT}${slots.push(html) - 1}${SLOT}`;
  let text = String(md ?? '')
    .replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      hold(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    )
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text)
    // 表格：连续的 | ... | 行转成等宽 pre，分隔线行丢弃
    .replace(/(?:^\|.+\|[ \t]*(?:\n|$))+/gm, (block) => {
      const rows = block
        .replace(/\n$/, '')
        .split('\n')
        .filter((row) => !/^\|[\s:|-]+\|[ \t]*$/.test(row.trim()))
        .map((row) =>
          row
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim())
            .join(' ｜ ')
        );
      if (!rows.length) return '';
      return `${SLOT}T${SLOT}${rows.join('\n')}${SLOT}/T${SLOT}${block.endsWith('\n') ? '\n' : ''}`;
    })
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (block) => {
      const body = block.replace(/\n$/, '').replace(/^&gt; ?/gm, '');
      return `<blockquote>${body}</blockquote>${block.endsWith('\n') ? '\n' : ''}`;
    })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(?!\s)(.+?)\*\*/g, '<b>$1</b>')
    .replace(/~~(?!\s)(.+?)~~/g, '<s>$1</s>')
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<!\w)_(?![\s_])([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
  text = text.replace(/\u0000T\u0000([\s\S]*?)\u0000\/T\u0000/g, (_, body) => `<pre>${body}</pre>`);
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/**
 * 分片发送 Markdown：跟踪围栏代码块状态，跨片的代码块在片尾闭合、下一片重新打开，
 * 保证每片各自是合法 HTML（代码块跨分片不断裂）。
 */
export function chunkMarkdown(md, size = 3500) {
  const text = String(md ?? '').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const parts = [];
  let cur = [];
  let curLen = 0;
  let fence = null; // 当前打开的 ```lang（不含反引号），null 表示在代码块外
  const flush = () => {
    if (!cur.length) return;
    let body = cur.join('\n');
    if (fence !== null) body += '\n```';
    if (body.trim()) parts.push(body);
    cur = fence !== null ? ['```' + fence] : [];
    curLen = cur.length ? cur[0].length + 1 : 0;
  };
  for (const line of lines) {
    const fenceHit = /^```([\w+-]*)\s*$/.exec(line);
    const add = line.length + 1;
    if (curLen + add > size && cur.length) flush();
    cur.push(line);
    curLen += add;
    if (fenceHit) fence = fence === null ? fenceHit[1] || '' : null;
  }
  flush();
  return parts;
}

// ---------- ask_user ----------

export const shortIdOf = (requestId) =>
  createHash('sha256').update(String(requestId)).digest('hex').slice(0, 16);

/** callback_data 预算 64 字节：ask:<shortId>:<idx> */
export function encodeAskCallback(requestId, idx) {
  const data = `ask:${shortIdOf(requestId)}:${idx}`;
  return Buffer.byteLength(data) <= 64 ? data : null;
}

const ASK_CLOSED_TTL_MS = 24 * 3600_000;
const ASK_CLOSED_KEEP = 50;

/** 清理已关闭的 ask：超过 24h 的删掉，最多只保留最近 50 条，避免 state.asks 无限膨胀 */
export function pruneAsks(state, now = Date.now()) {
  const closed = Object.entries(state.asks ?? {}).filter(([, a]) => !a.open);
  for (const [id, a] of closed) if (now - (a.closedAt ?? a.createdAt ?? 0) > ASK_CLOSED_TTL_MS) delete state.asks[id];
  const rest = Object.entries(state.asks ?? {})
    .filter(([, a]) => !a.open)
    .sort((a, b) => (b[1].closedAt ?? b[1].createdAt ?? 0) - (a[1].closedAt ?? a[1].createdAt ?? 0));
  for (const [id] of rest.slice(ASK_CLOSED_KEEP)) delete state.asks[id];
}

/** state.asks: shortId -> { sessionId, requestId, question, options, createdAt, cards: [{key,messageId}], open } */
export function registerAsk(state, { sessionId, requestId, question, options }) {
  pruneAsks(state);
  const shortId = shortIdOf(requestId);
  for (const [id, ask] of Object.entries(state.asks)) {
    if (ask.requestId === requestId && ask.sessionId === rootSession(sessionId) && id !== shortId) delete state.asks[id];
  }
  state.asks[shortId] = {
    sessionId: rootSession(sessionId),
    requestId,
    question: String(question ?? ''),
    options: Array.isArray(options) ? options.map(String) : undefined,
    createdAt: Date.now(),
    cards: [],
    open: true,
  };
  return shortId;
}

/** 关闭并返回受影响的 ask（requestId 精确关闭；省略则关整个会话的） */
export function closeAsksFor(state, sessionId, requestId) {
  const closed = [];
  for (const ask of Object.values(state.asks)) {
    if (!ask.open) continue;
    if (ask.sessionId !== rootSession(sessionId)) continue;
    if (requestId != null && ask.requestId !== requestId) continue;
    ask.open = false;
    ask.closedAt = Date.now();
    closed.push(ask);
  }
  pruneAsks(state);
  return closed;
}

/** 某会话开着的待答提问（自由文本作答的启发条件用） */
export function openAsksForSession(state, sessionId) {
  return Object.values(state.asks).filter((a) => a.open && a.sessionId === rootSession(sessionId));
}

// ---------- 限速与攒批 ----------

/** 计算缓冲的消息现在是否该投递；返回 { deliver, waitMs } */
export function bufferDecision(route, buffer, now) {
  const lastAt = buffer.lastAt ?? now;
  const quietFor = now - lastAt;
  if (route.debounceSec > 0 && quietFor < route.debounceSec * 1000) {
    return { deliver: false, waitMs: route.debounceSec * 1000 - quietFor };
  }
  if (route.minIntervalSec > 0 && route.lastDeliveredAt) {
    const elapsed = now - route.lastDeliveredAt;
    if (elapsed < route.minIntervalSec * 1000) {
      return { deliver: false, waitMs: Math.max(route.minIntervalSec * 1000 - elapsed, 100) };
    }
  }
  return { deliver: true, waitMs: 0 };
}

/** 把同一路由多条消息合并成一条注入（文本拼接，图片归拢） */
export function mergeBuffered(actions) {
  if (actions.length === 1) return actions[0];
  const first = actions[0];
  const images = actions.flatMap((a) => a.images ?? (a.image ? [a.image] : []));
  const texts = actions.map((a) => a.text).filter(Boolean);
  const context = actions.flatMap((a) => a.context ?? []);
  const merged = {
    ...first,
    text: texts.join('\n\n'),
    messageIds: actions.map((a) => a.messageId),
    merged: actions.length,
  };
  if (images.length) merged.images = images;
  delete merged.image;
  if (context.length) merged.context = context.slice(-MAX_CONTEXT);
  return merged;
}
