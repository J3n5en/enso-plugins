import { randomBytes } from 'node:crypto';

/** 默认 iLink 根；redirect_host / baseurl 不合法时继续用它 */
export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
/** 前三位是 openclaw-weixin 这一代协议，后面才是本插件版本 */
export const CHANNEL_VERSION = '3.0.0/enso-clawbot-0.1.0';
export const BOT_AGENT = 'EnsoCode';
export const MAX_CHARS = 2000;
const WEIXIN_SUFFIX = '.weixin.qq.com';

/** 0.1.0 → 0x00000100 = 256。高 8 位固定 0，其余 major<<16 | minor<<8 | patch */
export function clientVersion(version = '0.1.0') {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

export const CLIENT_VERSION = clientVersion('0.1.0');

export function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN：随机 uint32 的十进制再 base64 */
export function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

export function appHeaders() {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': CLIENT_VERSION,
  };
}

/** 扫码 POST 不带 token；登录后的请求才加 Authorization */
export function postHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    ...appHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * redirect_host / baseurl 只接受 https，且主机名是 weixin.qq.com 的子域。
 * 通过则返回规范化的 origin，否则返回 null（调用方继续用 DEFAULT_BASE）。
 */
export function acceptedWeixinBase(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 300) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.endsWith(WEIXIN_SUFFIX) || host.length <= WEIXIN_SUFFIX.length) return null;
  if (host.split('.').some((label) => !label)) return null;
  return `https://${host}`;
}

/** 拒绝时写进 setStatus detail 的主机名 */
export function rejectedHost(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '');
    return host || trimmed.slice(0, 200);
  } catch {
    return trimmed.slice(0, 200);
  }
}

export function apiUrl(base, path) {
  const origin = acceptedWeixinBase(base) || DEFAULT_BASE;
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

export function qrStatusUrl(base, qrcode, verifyCode) {
  const params = new URLSearchParams({ qrcode: String(qrcode ?? '') });
  if (verifyCode) params.set('verify_code', String(verifyCode));
  return apiUrl(base, `/ilink/bot/get_qrcode_status?${params.toString()}`);
}

/** 游标只在服务端返回非空 get_updates_buf 时推进 */
export function nextCursor(current, buf) {
  if (typeof buf !== 'string' || buf.length === 0) return typeof current === 'string' ? current : '';
  return buf;
}

export function isRelogin(data) {
  return !!data && (data.ret === -14 || data.errcode === -14);
}

export function chunkText(text, max = MAX_CHARS) {
  const value = String(text ?? '');
  if (!value) return [];
  const size = Math.max(1, max);
  const parts = [];
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
  return parts;
}

export function sendMessageBody({ peerId, text, contextToken, clientId }) {
  const msg = {
    from_user_id: '',
    to_user_id: String(peerId),
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: String(text) } }],
  };
  if (contextToken) msg.context_token = contextToken;
  return { msg, base_info: baseInfo() };
}

/**
 * 只认扫码人自己的用户消息（message_type === 1）。
 * 文字（type 1）和语音转写（type 3）收进来；图片、文件、视频记为不支持。
 * 发送者 id 是协议的 from_user_id；回复也发回它（sendmessage 只有 to_user_id）。
 * group_id 在协议里只是类型面、没有群发目标：带了就不标私聊，也不猜成群。
 * 不是扫码人则返回 null。
 */
export function readInbound(msg, ownerId) {
  if (!msg || typeof msg !== 'object') return null;
  if (String(msg.from_user_id ?? '') !== String(ownerId ?? '') || msg.message_type !== 1) return null;
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const texts = [];
  let unsupported = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 1 && typeof item.text_item?.text === 'string' && item.text_item.text) texts.push(item.text_item.text);
    else if (item.type === 3 && typeof item.voice_item?.text === 'string' && item.voice_item.text) texts.push(item.voice_item.text);
    else if (item.type === 2 || item.type === 4 || item.type === 5) unsupported = true;
  }
  const senderId = String(msg.from_user_id);
  const grouped = typeof msg.group_id === 'string' && msg.group_id !== '';
  return {
    peerId: senderId,
    senderId,
    ...(grouped ? {} : { chatType: 'private' }),
    text: texts.join('\n').trim(),
    unsupported,
    contextToken: typeof msg.context_token === 'string' ? msg.context_token : '',
    at: typeof msg.create_time_ms === 'number' ? msg.create_time_ms : undefined,
  };
}
