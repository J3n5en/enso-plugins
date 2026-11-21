/** WhatsApp 协议无关的纯逻辑：jid、消息内容、入站过滤、媒体解密、markdown 转换、分条、退避 */

import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const MAX_CHARS = 4000;
export const BIND_CODE_TTL_MS = 10 * 60 * 1000;
export const BIND_MAX_FAILURES = 5;
export const MAX_GROUPS = 20;
const MAX_TEXT = 30_000;
const MAX_NAME = 64;
/** 离线攒下的消息（Baileys 标成 append）也处理，但超过一天的不再翻出来执行 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 宿主的只读命令和「确认 N」：群里只认主人发的，别的成员发了就当没看见 */
const CONTROL_RE = /^\s*\/[A-Za-z]/u;
const CONFIRM_RE = /^\s*(?:确认|confirm)\s*\d{1,2}\s*$/iu;

// ---------- jid ----------

export function jidUser(jid) {
  const s = typeof jid === 'string' ? jid : '';
  const at = s.indexOf('@');
  if (at <= 0) return '';
  return s.slice(0, at).split(':')[0].split('_')[0];
}

export function jidServer(jid) {
  const s = typeof jid === 'string' ? jid : '';
  const at = s.indexOf('@');
  return at < 0 ? '' : s.slice(at + 1);
}

/** 去掉设备号：123:4@s.whatsapp.net → 123@s.whatsapp.net */
export function normalizeJid(jid) {
  const user = jidUser(jid);
  let server = jidServer(jid);
  if (!user || !server) return '';
  if (server === 'c.us') server = 's.whatsapp.net';
  return `${user}@${server}`;
}

export const isGroupJid = (jid) => jidServer(jid) === 'g.us';
export const isPnJid = (jid) => jidServer(jid) === 's.whatsapp.net' || jidServer(jid) === 'c.us';
export const isLidJid = (jid) => jidServer(jid) === 'lid';
export const isUserJid = (jid) => isPnJid(jid) || isLidJid(jid);

/** 界面上显示的号码：电话号码加 +，LID 只能显示一串 id */
export function displayNumber(jid) {
  const user = jidUser(jid);
  if (!user) return '';
  return isLidJid(jid) ? `LID ${user}` : `+${user}`;
}

/** 自己的号：sock.user 里 id 是电话号码 jid，lid 是隐私 id */
export function selfIds(user) {
  const pn = normalizeJid(user?.id);
  const lid = normalizeJid(user?.lid);
  return { pn, lid, all: [pn, lid].filter(Boolean) };
}

function anySame(list, candidates) {
  const set = new Set(list.map(normalizeJid).filter(Boolean));
  return candidates.some((jid) => {
    const n = normalizeJid(jid);
    return Boolean(n) && set.has(n);
  });
}

export function ownerIds(owner) {
  return owner ? [owner.jid, owner.pn, owner.lid].filter(Boolean) : [];
}

// ---------- 消息内容 ----------

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
];

export function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 5 && m && typeof m === 'object'; i++) {
    const key = WRAPPERS.find((k) => m[k]?.message);
    if (!key) break;
    m = m[key].message;
  }
  return m && typeof m === 'object' ? m : null;
}

const MEDIA = {
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  contactMessage: 'other',
  contactsArrayMessage: 'other',
  locationMessage: 'other',
  liveLocationMessage: 'other',
  ptvMessage: 'video',
};

/** 会下载的附件：图片消息，以及宿主收得下的那几种图片格式发成的文件 */
const FILE_IMAGE_RE = /^image\/(?:png|jpeg|webp|gif)\b/i;
const KEY_INFO = { image: 'WhatsApp Image Keys', document: 'WhatsApp Document Keys' };

const toNumber = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : Number(v));

function mediaFile(key, part) {
  if (key !== 'imageMessage' && !(key === 'documentMessage' && FILE_IMAGE_RE.test(part.mimetype ?? ''))) return null;
  if (!part.mediaKey || (!part.directPath && !part.url)) return null;
  const size = toNumber(part.fileLength);
  return {
    keyType: key === 'imageMessage' ? 'image' : 'document',
    mediaKey: part.mediaKey,
    url: typeof part.url === 'string' ? part.url : '',
    directPath: typeof part.directPath === 'string' ? part.directPath : '',
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/** 只认文字和常见媒体；回应、撤回、编辑、投票更新之类的协议消息返回 null */
export function readContent(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  if (typeof m.conversation === 'string' && m.conversation) return { text: m.conversation, media: null, file: null, context: null };
  if (m.extendedTextMessage) {
    const text = typeof m.extendedTextMessage.text === 'string' ? m.extendedTextMessage.text : '';
    return { text, media: null, file: null, context: m.extendedTextMessage.contextInfo ?? null };
  }
  for (const [key, media] of Object.entries(MEDIA)) {
    const part = m[key];
    if (!part) continue;
    const text = typeof part.caption === 'string' ? part.caption : '';
    return { text, media, file: mediaFile(key, part), context: part.contextInfo ?? null };
  }
  return null;
}

function mentionsMe(context, me) {
  const list = Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
  return list.length > 0 && anySame(me.all, list);
}

function stripMentions(text, me) {
  let out = text;
  for (const jid of me.all) {
    const user = jidUser(jid);
    if (user) out = out.split(`@${user}`).join(' ');
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/**
 * 入站过滤：决定一条 messages.upsert 里的消息交不交给秘书。
 * 副号模式：只认主人的私聊（还没主人时只认私聊里的 6 位绑定码）；自己号码模式：只认「给自己发消息」。
 * 离线消息（append）照常处理；秘书自己发的靠发送前记下的 id 认出来。
 * 结果里的 file 是要下载的图片，只有放行的消息才带；群里收不下的附件不带出去。
 * 两种模式下群都要先在设置页绑定，且只认 @ 这个号或回复秘书发过的消息。秘书自己发的一律跳过。
 */
export function classifyInbound({ msg, type, mode, me, owner, groups, sentIds, bindActive, now = Date.now() }) {
  const ignore = (reason) => ({ kind: 'ignore', reason });
  if (type !== 'notify' && type !== 'append') return ignore('not-notify');
  const key = msg?.key;
  const remote = typeof key?.remoteJid === 'string' ? key.remoteJid : '';
  if (!remote || !msg.message) return ignore('empty');
  if (key.id && sentIds.has(key.id)) return ignore('own-echo');
  const server = jidServer(remote);
  if (server === 'broadcast' || server === 'newsletter' || server === 'call') return ignore('broadcast');
  const content = readContent(msg.message);
  if (!content) return ignore('no-content');
  const fromMe = key.fromMe === true;
  const ts = typeof msg.messageTimestamp?.toNumber === 'function' ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);
  const at = ts > 0 ? ts * 1000 : undefined;
  if (at && now - at > MAX_AGE_MS) return ignore('too-old');
  const name = clip(msg.pushName, MAX_NAME);

  if (isGroupJid(remote)) {
    const group = groups?.[remote];
    if (!group) return ignore('group-not-bound');
    if (fromMe && mode !== 'self') return ignore('from-me');
    const quoted = typeof content.context?.stanzaId === 'string' ? content.context.stanzaId : '';
    const addressed = mentionsMe(content.context, me) || (quoted && sentIds.has(quoted));
    if (!addressed) return ignore('group-not-addressed');
    const text = clip(stripMentions(content.text, me), MAX_TEXT) || clip(content.text, MAX_TEXT);
    if (!text && !content.file) return ignore('group-no-text');
    const sender = key.participant || '';
    const isOwner = mode === 'self' ? fromMe : anySame(ownerIds(owner), [sender, key.participantAlt].filter(Boolean));
    if (!isOwner && (CONTROL_RE.test(text) || CONFIRM_RE.test(text))) return ignore('group-control-from-member');
    return {
      kind: 'deliver',
      peerId: remote,
      chatType: 'group',
      chatTitle: clip(group.title, MAX_NAME),
      senderId: normalizeJid(sender) || sender,
      name,
      text,
      at,
      media: null,
      file: content.file,
      quote: true,
    };
  }

  if (!isUserJid(remote)) return ignore('unknown-chat');
  const chatIds = [remote, key.remoteJidAlt].filter(Boolean);
  const text = clip(content.text, MAX_TEXT);

  if (mode === 'self') {
    if (!fromMe || !anySame(me.all, chatIds)) return ignore('not-self-chat');
    return { kind: 'deliver', peerId: me.pn || normalizeJid(remote), chatType: 'private', senderId: me.pn, name, text, at, media: content.media, file: content.file, quote: false };
  }

  if (fromMe) return ignore('from-me');
  if (!owner) {
    if (!bindActive) return ignore('no-owner');
    if (!/^\d{6}$/.test(text)) return ignore('awaiting-bind');
    const pn = chatIds.map(normalizeJid).find(isPnJid) || '';
    const lid = chatIds.map(normalizeJid).find(isLidJid) || '';
    return { kind: 'bind', code: text, owner: { jid: normalizeJid(remote), pn, lid, name } };
  }
  if (!anySame(ownerIds(owner), chatIds)) return ignore('stranger');
  return { kind: 'deliver', peerId: owner.jid, chatType: 'private', senderId: owner.jid, name, text, at, media: content.media, file: content.file, quote: false };
}

// ---------- 媒体 ----------

/** 和清单 net.domains 一致：媒体只在这些主机上传、下载 */
export const MEDIA_HOST = 'mmg.whatsapp.net';
const MEDIA_HOSTS = [/^mmg\.whatsapp\.net$/i, /\.cdn\.whatsapp\.net$/i];
export const mediaHostAllowed = (host) => typeof host === 'string' && MEDIA_HOSTS.some((re) => re.test(host));

/** 下载地址：directPath 拼到消息自带的媒体主机（不在清单里就用默认主机）；拼不出合规地址返回空串 */
export function mediaDownloadUrl(file) {
  let parsed = null;
  try {
    parsed = file?.url ? new URL(file.url) : null;
  } catch {}
  const ok = parsed?.protocol === 'https:' && !parsed.username && !parsed.password && mediaHostAllowed(parsed.hostname);
  const path = typeof file?.directPath === 'string' ? file.directPath : '';
  if (path.startsWith('/') && !path.startsWith('//')) return `https://${ok ? parsed.hostname : MEDIA_HOST}${path}`;
  return ok ? parsed.href : '';
}

const toBytes = (v) => (typeof v === 'string' ? Buffer.from(v, 'base64') : v instanceof Uint8Array ? Buffer.from(v) : Buffer.alloc(0));

/** WhatsApp 媒体：HKDF 展开 mediaKey 得 iv/密钥/MAC 密钥，密文是 AES-256-CBC 加 10 字节 HMAC */
export function decryptMedia(enc, mediaKey, keyType) {
  const key = toBytes(mediaKey);
  const info = KEY_INFO[keyType];
  if (!info || key.length !== 32) throw new Error('媒体密钥不对');
  const data = toBytes(enc);
  if (data.length < 26 || (data.length - 10) % 16) throw new Error('媒体数据不完整');
  const keys = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 112));
  const iv = keys.subarray(0, 16);
  const body = data.subarray(0, -10);
  const mac = createHmac('sha256', keys.subarray(48, 80)).update(iv).update(body).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, data.subarray(-10))) throw new Error('媒体校验失败');
  const decipher = createDecipheriv('aes-256-cbc', keys.subarray(16, 48), iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ---------- 绑定码 ----------

export function createBindCode(random = Math.random, now = Date.now()) {
  const value = Math.floor(Math.abs(random()) * 1_000_000) % 1_000_000;
  return { code: String(value).padStart(6, '0'), expiresAt: now + BIND_CODE_TTL_MS, failures: 0 };
}

export const bindUsable = (bind, now) => Boolean(bind && bind.expiresAt > now && bind.failures < BIND_MAX_FAILURES);

// ---------- markdown → WhatsApp ----------

function inlineToWhatsApp(segment) {
  const codes = [];
  let s = segment.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .split('\n')
    .map((line) => {
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────';
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const inner = heading[1].replace(/\*\*|__/g, '').trim();
        return inner ? `\u0001${inner}\u0001` : '';
      }
      return line.replace(/^(\s*)[*+]\s+/, '$1- ');
    })
    .join('\n');
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => (alt ? `${alt} (${url})` : url))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '\u0001$1\u0001')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '\u0001$1\u0001')
    .replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1_$2_')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '~$1~')
    .replace(/\u0001/g, '*');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `\`${codes[Number(i)]}\``);
}

/** 秘书写的是 markdown；WhatsApp 认 *粗体* _斜体_ ~删除线~ `代码` 和 ``` 代码块 */
export function markdownToWhatsApp(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n');
  const fence = /```[^\n`]*\n([\s\S]*?)\n?```/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = fence.exec(text))) {
    out += inlineToWhatsApp(text.slice(last, m.index));
    out += `\`\`\`\n${m[1]}\n\`\`\``;
    last = fence.lastIndex;
  }
  return out + inlineToWhatsApp(text.slice(last));
}

/** 超长分条：优先在换行、其次空格处切；代码块被切开时本条补上结尾、下一条重新打开 */
export function chunkText(input, max = MAX_CHARS) {
  let rest = String(input ?? '').trim();
  if (!rest) return [];
  const raw = [];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
    }
    raw.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) raw.push(rest);
  let open = false;
  return raw.map((chunk) => {
    let part = open ? `\`\`\`\n${chunk}` : chunk;
    const fences = (part.match(/```/g) ?? []).length;
    open = fences % 2 === 1;
    if (open) part += '\n```';
    return part;
  });
}

// ---------- 连接 ----------

export const BACKOFF_START_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;

/** 第 attempt 次重连前等多久：指数增长，封顶，带 ±20% 抖动避免一起撞 */
export function backoffDelay(attempt, { start = BACKOFF_START_MS, max = BACKOFF_MAX_MS, random = Math.random } = {}) {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(max, start * 2 ** Math.min(n - 1, 30));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Baileys DisconnectReason → 该怎么办。只有可恢复的断线才自动重连 */
export function disconnectAction(statusCode, { loggingIn = false } = {}) {
  switch (statusCode) {
    case 401:
    case 411:
      return 'logged-out';
    case 403:
      return 'forbidden';
    case 440:
      return 'replaced';
    case 515:
      return 'restart';
    case 408:
      return loggingIn ? 'qr-expired' : 'retry';
    default:
      return loggingIn ? 'qr-failed' : 'retry';
  }
}

/** 给 Baileys 的 logger：什么都不打。协议层的日志里会有密钥和消息内容 */
export function silentLogger() {
  const logger = { level: 'silent', child: () => silentLogger() };
  for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[k] = () => {};
  return logger;
}

/** 报错文案只留一行短消息，不带堆栈、对象和长串（避免把协议数据带出去） */
export function safeError(error) {
  const raw = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '未知错误';
  return raw.split('\n')[0].replace(/[A-Za-z0-9+/=_-]{32,}/g, '…').slice(0, 120);
}
