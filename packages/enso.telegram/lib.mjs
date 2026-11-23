const PAIR_TTL_MS = 10 * 60_000;
const MAX_PAIRINGS = 5;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Telegram 下载上限 20MB；宿主单次响应 5MB */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA = ['photo', 'document', 'voice', 'video', 'audio', 'sticker', 'video_note', 'animation'];
const MAX_REQUESTS = 5;
/** 群聊上下文：每个群最多缓存的条数、单条截断长度 */
export const MAX_CONTEXT = 50;
const CONTEXT_CHARS = 500;

export const COMMANDS = [
  { command: 'help', description: '查看用法' },
  { command: 'status', description: '查看绑定状态' },
  { command: 'steer', description: '向正在运行的任务插话' },
  { command: 'stop', description: '停止正在运行的任务' },
  { command: 'sync', description: '开关 EnsoCode 对话同步（on / off）' },
  { command: 'allow', description: '群聊：回复某人的消息把 TA 加入白名单；单独发送查看白名单' },
  { command: 'deny', description: '群聊：回复某人的消息把 TA 移出白名单' },
  { command: 'context', description: '群聊：触发时附带最近几条其他消息（0 关闭）' },
  { command: 'session', description: '切换绑定的 EnsoCode 会话' },
  { command: 'unbind', description: '解除绑定' },
];

const HELP = [
  '直接发消息即可交给 EnsoCode 会话，回复会自动发回这里。',
  '/steer <内容>：插入正在运行的任务',
  '/stop：停止正在运行的任务',
  '可以直接发图片（附文字说明更好）。',
  '/sync on|off：把 EnsoCode 里的对话也同步到这里',
  '/status：查看绑定',
  '/unbind：解除绑定',
  '群聊里请 @机器人 或回复机器人的消息。',
  '群聊白名单：回复某人的消息发 /allow 或 /deny；单独发 /allow 查看名单。',
  `/context <0-${MAX_CONTEXT}>：群聊里触发时附带最近几条其他人的消息`,
  '/session：切换这个聊天绑定的 EnsoCode 会话',
].join('\n');

export const emptyState = () => ({ offset: 0, bindings: [], pairings: [], pending: {}, history: {}, menus: {} });

export const rootSession = (id) => String(id).split('::')[0];

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

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 模型常用的 Markdown 子集转 Telegram HTML；不认识的写法按原文转义 */
export function markdownToHtml(md) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let text = String(md ?? '')
    .replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      hold(
        `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
      )
    )
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text)
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
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

export function createPairing(state, sessionId, now, random = Math.random) {
  const code = String(Math.floor(random() * 1e6)).padStart(6, '0');
  state.pairings = [
    { code, sessionId: rootSession(sessionId), expiresAt: now + PAIR_TTL_MS },
    ...state.pairings.filter((p) => p.expiresAt > now && p.code !== code),
  ].slice(0, MAX_PAIRINGS);
  return code;
}

/** 群里以匿名管理员身份发言时，from 固定是这个机器人账号 */
const ANONYMOUS_ADMIN = 1087968824;
const isBotUser = (u) => u.is_bot && u.id !== ANONYMOUS_ADMIN;
const SENDER_MAX = 128;

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

export const userOf = (u) => ({
  id: u.id,
  name:
    u.id === ANONYMOUS_ADMIN
      ? '匿名管理员'
      : u.username
        ? `@${u.username}`
        : [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id),
});

/** 白名单开启时只放行名单内的人；旧绑定没有该字段视为关闭 */
export const isAllowed = (binding, userId) =>
  !binding.whitelist || (binding.allow ?? []).some((u) => u.id === userId);

export function setAllowed(binding, user, on) {
  const allow = (binding.allow ?? []).filter((u) => u.id !== user.id);
  binding.allow = on ? [...allow, user] : allow;
  binding.requests = (binding.requests ?? []).filter((u) => u.id !== user.id);
}

function noteRequest(binding, user) {
  binding.requests = [user, ...(binding.requests ?? []).filter((u) => u.id !== user.id)].slice(0, MAX_REQUESTS);
}

/** 群聊绑定时把绑定者加入白名单并默认开启；重新绑定沿用原名单 */
export function bindChat(state, { chatId, chatType, title, sessionId, sync = false, user }) {
  const prev = state.bindings.find((b) => b.chatId === chatId);
  const binding = { chatId, chatType, title, sessionId: rootSession(sessionId), sync };
  if (user) {
    binding.whitelist = prev?.whitelist ?? true;
    binding.allow = prev?.allow ?? [];
    binding.requests = prev?.requests ?? [];
    setAllowed(binding, user, true);
  }
  state.bindings = [binding, ...state.bindings.filter((b) => b.chatId !== chatId)];
}

const parseCommand = (text) => {
  const m = /^\/([a-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
  return m ? { name: m[1].toLowerCase(), target: m[2], arg: (m[3] ?? '').trim() } : null;
};

const isGroupChat = (chat) => chat?.type === 'group' || chat?.type === 'supergroup';

function summarize(m) {
  const text = String(m.text ?? m.caption ?? '').trim();
  const media = m.photo ? '[图片]' : MEDIA.some((k) => m[k] !== undefined) ? '[文件/语音等]' : '';
  const body = [media, text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)}…` : text].filter(Boolean).join(' ');
  return body && { from: m.from ? userOf(m.from).name : '匿名', text: body };
}

/** 把一条 update 归类成要做的事；群聊开了上下文时，缓存没投递的消息，投递时带上最近几条 */
export function route(state, update, now, bot = {}) {
  const action = decide(state, update, now, bot);
  const m = update?.message;
  if (!isGroupChat(m?.chat)) return action;
  state.history ??= {};
  const chatId = m.chat.id;
  const binding = state.bindings.find((b) => b.chatId === chatId);
  const size = binding?.context ?? 0;
  if (!size) {
    delete state.history[chatId];
    return action;
  }
  const history = state.history[chatId] ?? [];
  if (action.kind === 'inject') {
    if (history.length) action.context = history.slice(-size);
    delete state.history[chatId];
  } else if (action.kind !== 'bound' && !parseCommand(String(m.text ?? m.caption ?? '').trim())) {
    const line = summarize(m);
    if (line) state.history[chatId] = [...history, line].slice(-MAX_CONTEXT);
  }
  return action;
}

function decide(state, update, now, bot) {
  if (update?.callback_query) return routeCallback(state, update.callback_query);
  const m = update?.message;
  const chatId = m?.chat?.id;
  if (typeof chatId !== 'number') return { kind: 'ignore' };
  const isGroup = isGroupChat(m.chat);
  const from = m.from?.username ?? m.from?.first_name ?? String(m.from?.id ?? chatId);
  const fromId = m.from?.id != null && m.from.id !== ANONYMOUS_ADMIN ? String(m.from.id) : undefined;
  const fromName = fromNameOf(m.from ? userOf(m.from).name : from);
  const reply = (text) => ({ kind: 'reply', chatId, text });
  let text = String(m.text ?? m.caption ?? '').trim();
  const binding = state.bindings.find((b) => b.chatId === chatId);

  const command = parseCommand(text);
  if (command?.target && command.target.toLowerCase() !== String(bot.username).toLowerCase())
    return { kind: 'ignore' };
  const mention = isGroup && bot.username ? new RegExp(`@${bot.username}\\b`, 'i') : null;
  const repliedToBot = m.reply_to_message?.from?.id === bot.id && bot.id !== undefined;

  // 侧栏的 t.me 链接会带着配对码发 /start <码>
  if (command?.name === 'bind' || (command?.name === 'start' && command.arg)) {
    const pairing = /^\d{6}$/.test(command.arg)
      ? state.pairings.find((p) => p.code === command.arg && p.expiresAt > now)
      : null;
    if (!pairing) return reply('配对码无效或已过期，请在 EnsoCode 侧栏「Telegram」里重新生成。');
    // 同一会话的其他配对码一并作废，侧栏不再显示配对界面
    state.pairings = state.pairings.filter((p) => p.sessionId !== pairing.sessionId);
    bindChat(state, {
      chatId,
      chatType: m.chat.type,
      title: m.chat.title ?? from,
      sessionId: pairing.sessionId,
      user: isGroup && m.from ? userOf(m.from) : undefined,
    });
    return { kind: 'bound', chatId, sessionId: pairing.sessionId };
  }
  if (!binding) {
    return command?.name === 'start' && !isGroup
      ? reply('在 EnsoCode 侧栏「Telegram」里点「绑定」，再点链接或把配对码发给我：/bind 123456')
      : { kind: 'ignore' };
  }

  if (isGroup && !isAllowed(binding, m.from?.id)) {
    if (!(command || mention?.test(text) || repliedToBot) || !m.from || isBotUser(m.from)) return { kind: 'ignore' };
    noteRequest(binding, userOf(m.from));
    return reply(`${userOf(m.from).name} 不在本群白名单里。请白名单成员回复 TA 的消息发 /allow，或在 EnsoCode 侧栏批准。`);
  }

  if (command) {
    switch (command.name) {
      case 'start':
      case 'help':
        return reply(HELP);
      case 'status':
        return reply(
          `已绑定会话 ${binding.sessionId}\n同步 EnsoCode 对话：${binding.sync ? '开' : '关'}` +
            (isGroup ? `\n白名单：${binding.whitelist ? `开（${binding.allow?.length ?? 0} 人）` : '关，群内所有人可用'}` : '')
        );
      case 'allow':
      case 'deny': {
        if (!isGroup) return reply('白名单只用于群聊。');
        const target = m.reply_to_message?.from;
        if (!target || isBotUser(target)) {
          if (command.name === 'deny') return reply('用法：回复某人的消息发 /deny');
          const names = (binding.allow ?? []).map((u) => u.name).join('、') || '（空）';
          return reply(`白名单${binding.whitelist ? '' : '（未开启，群内所有人可用）'}：${names}\n回复某人的消息发 /allow 添加。`);
        }
        const user = userOf(target);
        setAllowed(binding, user, command.name === 'allow');
        return reply(command.name === 'allow' ? `已把 ${user.name} 加入白名单。` : `已把 ${user.name} 移出白名单。`);
      }
      case 'context': {
        if (!isGroup) return reply('上下文只用于群聊。');
        if (!command.arg) return reply(`当前附带最近 ${binding.context ?? 0} 条消息。用法：/context 5（0 关闭）`);
        const n = Number(command.arg);
        if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT) return reply(`请给 0 到 ${MAX_CONTEXT} 的整数。`);
        binding.context = n;
        return reply(n ? `之后触发时会附带最近 ${n} 条其他消息。` : '已关闭群聊上下文。');
      }
      case 'session':
        if (!command.arg) return { kind: 'sessions', chatId, current: binding.sessionId };
        return switchSession(state, binding, Number(command.arg));
      case 'new':
        return reply('EnsoCode 只允许在界面上点击新建会话：请在 EnsoCode「Telegram」侧栏点这个聊天的「新会话」，或在 EnsoCode 里新建后发 /session 切过去。');
      case 'unbind':
        state.bindings = state.bindings.filter((b) => b !== binding);
        return reply('已解绑。');
      case 'sync': {
        if (!/^(on|off)$/i.test(command.arg)) return reply('用法：/sync on 或 /sync off');
        binding.sync = command.arg.toLowerCase() === 'on';
        return reply(binding.sync ? '已开启同步：EnsoCode 里的对话也会发到这里。' : '已关闭同步。');
      }
      case 'stop':
        return { kind: 'stop', chatId, sessionId: binding.sessionId };
      case 'steer':
        if (!command.arg) return reply('用法：/steer 补充内容');
        return inject(binding, chatId, command.arg, from, m.message_id, 'steer', fromId, fromName);
    }
  }

  if (isGroup) {
    if (!(mention?.test(text) || repliedToBot)) return { kind: 'ignore' };
    if (mention) text = text.replace(mention, '').trim();
  }
  const image = imageOf(m);
  if (image === 'too-large') return reply('图片超过 5MB，请压缩后再发。');
  if (image) {
    return {
      ...inject(binding, chatId, text || '（用户发来一张图片）', from, m.message_id, 'followUp', fromId, fromName),
      image,
    };
  }
  if (!text) {
    return MEDIA.some((k) => m[k] !== undefined)
      ? reply('暂只支持文字和图片，文件、语音等请附带文字说明或改用 EnsoCode。')
      : { kind: 'ignore' };
  }
  return inject(binding, chatId, text, from, m.message_id, 'followUp', fromId, fromName);
}

/** 照片取不超过上限的最大尺寸；以文件发送的图片按 mime 识别 */
function imageOf(m) {
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

const inject = (binding, chatId, text, from, messageId, deliverAs, fromId, fromName) => ({
  kind: 'inject',
  chatId,
  sessionId: binding.sessionId,
  text,
  from,
  messageId,
  deliverAs,
  ...(fromId ? { fromId } : {}),
  ...(fromName ? { fromName } : {}),
});

export function senderOf(action) {
  const chatId = boundedId(action?.chatId);
  const userId = boundedId(action?.fromId);
  const displayName = displayNameOf(action?.fromName ?? action?.from);
  return {
    channel: 'telegram',
    ...(chatId ? { chatId } : {}),
    ...(userId && userId !== String(ANONYMOUS_ADMIN) ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export const inboundText = ({ from, text, context }) => {
  const head = context?.length
    ? `[Telegram 群聊里此前的其他消息，仅供参考]\n${context.map((c) => `${c.from}：${c.text}`).join('\n')}\n\n`
    : '';
  return `${head}[Telegram 消息，来自 ${from}]\n\n${text}`;
};

/** 记下这个会话有一轮由 Telegram 发起，结束时回发；同一聊天只保留最新的占位消息 */
export function markPending(state, sessionId, target) {
  const key = rootSession(sessionId);
  state.pending[key] = [...(state.pending[key] ?? []).filter((t) => t.chatId !== target.chatId), target];
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

/** 开启同步的聊天，排除本轮已经回发过的 */
export const mirrorTargets = (state, sessionId, exclude = []) =>
  state.bindings
    .filter((b) => b.sync && b.sessionId === rootSession(sessionId) && !exclude.includes(b.chatId))
    .map((b) => b.chatId);
/** 会话按钮：callback_data 是 sess:<序号>，对应最近一次 /session 发出的列表 */
function routeCallback(state, q) {
  const chatId = q.message?.chat?.id;
  const binding = state.bindings.find((b) => b.chatId === chatId);
  const answer = (text = '') => ({ kind: 'answer', callbackId: q.id, text });
  const hit = /^sess:(\d+)$/.exec(q.data ?? '');
  if (!binding || !hit) return answer();
  if (isGroupChat(q.message.chat) && !isAllowed(binding, q.from?.id)) return answer('你不在本群白名单里');
  return { ...switchSession(state, binding, Number(hit[1])), callbackId: q.id, messageId: q.message.message_id };
}

function switchSession(state, binding, n) {
  const pick = state.menus?.[binding.chatId]?.[n - 1];
  if (!pick) return { kind: 'reply', chatId: binding.chatId, text: '列表已过期或序号不对，请重新发 /session。' };
  binding.sessionId = rootSession(pick.id);
  return { kind: 'switched', chatId: binding.chatId, sessionId: binding.sessionId, title: pick.title };
}

