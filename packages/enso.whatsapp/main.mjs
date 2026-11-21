import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BIND_MAX_FAILURES,
  MAX_CHARS,
  MAX_GROUPS,
  backoffDelay,
  bindUsable,
  chunkText,
  classifyInbound,
  createBindCode,
  decryptMedia,
  disconnectAction,
  displayNumber,
  isGroupJid,
  markdownToWhatsApp,
  mediaDownloadUrl,
  mediaHostAllowed,
  normalizeJid,
  safeError,
  selfIds,
  silentLogger,
} from './lib/wa.mjs';

const CHANNEL = 'whatsapp';
const STATE_FILE = 'state.json';
const AUTH_DIR = 'auth';
const LOG = '[WhatsApp]';
const SENT_KEEP = 500;
const SEEN_KEEP = 500;
const RECENT_KEEP = 100;
const MAX_RESTARTS = 5;
const BOUND = '已绑定为主人。之后这个号只处理你发来的私聊消息。';
/** enso.net.fetch 的响应上限是 5MB，密文比原图多出填充和 MAC */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 - 32;
/** 宿主只认 too-large / not-image：没下载下来（超时、失败、过大）一律按 too-large 报 */
const NOT_DOWNLOADED = 'too-large';

const DEFAULTS = {
  connectTimeoutMs: 30_000,
  loginWaitMs: 15_000,
  qrStaleMs: 75_000,
  maxQrRounds: 3,
  sendTimeoutMs: 25_000,
  mediaTimeoutMs: 100_000,
  downloadTimeoutMs: 30_000,
  queryTimeoutMs: 15_000,
  logoutTimeoutMs: 8_000,
  typingIdleMs: 8_000,
  chunkGapMs: 400,
  backoff: {},
  random: Math.random,
  now: () => Date.now(),
};

let current = null;

/** 真协议层：打包好的 Baileys。测试注入假的 */
export async function loadProtocol() {
  const lib = await import('./vendor/baileys.mjs');
  return {
    browser: lib.Browsers.macOS('EnsoCode'),
    makeSocket: (config) => lib.makeWASocket(config),
    useAuth: async (dir) => {
      const { state, saveCreds } = await lib.useMultiFileAuthState(dir);
      return {
        creds: state.creds,
        keys: lib.makeCacheableSignalKeyStore(state.keys, silentLogger()),
        saveCreds,
      };
    },
    newMessageId: (meId) => lib.generateMessageIDV2(meId),
    mediaPath: (type) => lib.MEDIA_PATH_MAP[type],
    uploadToken: (b64) => lib.encodeBase64EncodedStringForUpload(b64),
  };
}

export function deactivate() {
  const prev = current;
  if (!prev) return;
  current = null;
  prev.stopped = true;
  try {
    prev.teardown?.();
  } catch (error) {
    console.error(LOG, '断开失败', safeError(error));
  }
  try {
    void Promise.resolve(prev.unregister?.()).catch((error) => console.error(LOG, '注销联系方式失败', safeError(error)));
  } catch (error) {
    console.error(LOG, '注销联系方式失败', safeError(error));
  }
}

function emptySession(mode = 'secondary') {
  return { mode, account: '', owner: null, groups: {}, sent: [] };
}

function normalizeSession(raw) {
  const s = emptySession(raw?.mode === 'self' ? 'self' : 'secondary');
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.account === 'string') s.account = raw.account;
  const o = raw.owner;
  if (o && typeof o.jid === 'string' && o.jid) {
    s.owner = { jid: o.jid, pn: typeof o.pn === 'string' ? o.pn : '', lid: typeof o.lid === 'string' ? o.lid : '', name: typeof o.name === 'string' ? o.name : '' };
  }
  if (raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)) {
    for (const [jid, g] of Object.entries(raw.groups)) {
      if (isGroupJid(jid)) s.groups[jid] = { title: typeof g?.title === 'string' ? g.title : '' };
    }
  }
  if (Array.isArray(raw.sent)) s.sent = raw.sent.filter((id) => typeof id === 'string' && id).slice(-SENT_KEEP);
  return s;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * options.protocol 注入协议层（测试用 mock socket），其余是可调的超时与退避。
 * 返回少量钩子给测试观察内部状态。
 */
export async function activate(enso, options = {}) {
  deactivate();
  const cfg = { ...DEFAULTS, ...options };
  const self = { stopped: false, teardown: null, unregister: null };
  current = self;
  try {
    const proto = options.protocol ?? (await loadProtocol());
    const stateFile = join(enso.dataDir, STATE_FILE);
    const authDir = join(enso.dataDir, AUTH_DIR);

    let session = emptySession();
    let sentIds = new Set();
    let sock = null;
    let gen = 0;
    let opened = false;
    let loggingIn = false;
    let login = null;
    let attempt = 0;
    let restarts = 0;
    let me = selfIds(null);
    let bind = null;
    let phase = 'unconfigured';
    let detail = '';
    let lastStatus = '';
    let lastView = '';
    let saving = Promise.resolve();
    let credsSaving = Promise.resolve();
    let upserting = Promise.resolve();
    let knownGroups = new Map();
    const timers = new Map();
    const quotes = new Map();
    const typingTimers = new Map();
    const recent = new Map();
    const seen = new Set();
    const loginWaiters = new Set();

    const save = () => {
      const body = JSON.stringify(session, null, 2);
      saving = saving.catch(() => {}).then(async () => {
        await mkdir(enso.dataDir, { recursive: true });
        const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, body);
        await rename(tmp, stateFile);
      });
      return saving.catch((error) => console.error(LOG, '保存状态失败', safeError(error)));
    };

    const load = async () => {
      try {
        session = normalizeSession(JSON.parse(await readFile(stateFile, 'utf8')));
      } catch {
        session = emptySession();
      }
      sentIds = new Set(session.sent);
    };

    const wipeAuth = async () => {
      await credsSaving.catch(() => {});
      await rm(authDir, { recursive: true, force: true });
    };

    const owner = () => (session.mode === 'self' ? (me.pn ? { jid: me.pn, pn: me.pn, lid: me.lid, name: '' } : null) : session.owner);
    const peers = () => {
      if (!opened) return [];
      const o = owner();
      return o ? [o.jid] : [];
    };
    const allowedPeer = (jid) => Boolean(jid) && (peers().includes(jid) || Boolean(session.groups[jid]));

    const snapshot = () => {
      const o = session.owner;
      const showBind = opened && session.mode === 'secondary' && !o;
      return {
        status: phase,
        detail,
        mode: session.mode,
        connected: opened,
        account: displayNumber(me.pn || session.account),
        qrText: login?.qrText || '',
        owner: o ? { number: displayNumber(o.pn || o.jid), name: o.name || '' } : null,
        bindCode: showBind && bindUsable(bind, cfg.now()) ? { code: bind.code, expiresAt: bind.expiresAt } : null,
        bindExpired: showBind && !bindUsable(bind, cfg.now()),
        groups: Object.entries(session.groups).map(([jid, g]) => ({ jid, title: g.title || jid })),
      };
    };

    const publish = async (status, nextDetail = '') => {
      phase = status;
      detail = nextDetail;
      if (self.stopped) return snapshot();
      const body = { status, detail: detail.slice(0, 200), peers: peers() };
      const key = JSON.stringify(body);
      if (key !== lastStatus) {
        lastStatus = key;
        try {
          await enso.contact.setStatus(CHANNEL, body);
        } catch (error) {
          console.error(LOG, 'setStatus', safeError(error));
        }
      }
      const view = snapshot();
      const viewKey = JSON.stringify(view);
      if (viewKey !== lastView) {
        lastView = viewKey;
        try {
          enso.ui.view.emit('status', view);
        } catch (error) {
          console.error(LOG, '推送页面失败', safeError(error));
        }
      }
      return view;
    };

    /** 连上之后的状态：副号没主人时等绑定码，其余算已连接 */
    const publishOpen = () => {
      if (session.mode === 'self') return publish('connected', `已连接 ${displayNumber(me.pn)}（自己号码模式）`);
      if (session.owner) return publish('connected', `已连接，主人 ${displayNumber(session.owner.pn || session.owner.jid)}`);
      if (bindUsable(bind, cfg.now())) return publish('pending', '已连接，等待主号发送绑定码');
      return publish('pending', '已连接，绑定码已失效，请在设置页换一个');
    };

    const clearTimer = (name) => {
      const t = timers.get(name);
      if (t) clearTimeout(t);
      timers.delete(name);
    };
    const armTimer = (name, ms, fn) => {
      clearTimer(name);
      timers.set(
        name,
        setTimeout(() => {
          timers.delete(name);
          if (!self.stopped) void Promise.resolve(fn()).catch((error) => console.error(LOG, name, safeError(error)));
        }, ms),
      );
    };

    const settleLogin = () => {
      for (const resolve of loginWaiters) resolve();
      loginWaiters.clear();
    };

    const stopTypingAll = () => {
      for (const t of typingTimers.values()) clearTimeout(t);
      typingTimers.clear();
    };

    const teardown = () => {
      for (const name of [...timers.keys()]) clearTimer(name);
      stopTypingAll();
      const s = sock;
      sock = null;
      opened = false;
      if (!s) return;
      try {
        s.ev?.removeAllListeners?.();
      } catch {}
      try {
        void Promise.resolve(s.end?.(undefined)).catch(() => {});
      } catch {}
    };
    self.teardown = () => {
      gen += 1;
      teardown();
      settleLogin();
    };

    const rememberSent = (id) => {
      if (!id || sentIds.has(id)) return;
      sentIds.add(id);
      session.sent.push(id);
      if (session.sent.length > SENT_KEEP) {
        for (const old of session.sent.splice(0, session.sent.length - SENT_KEEP)) sentIds.delete(old);
      }
      void save();
    };

    const markSeen = (id) => {
      if (!id) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      if (seen.size > SEEN_KEEP) seen.delete(seen.values().next().value);
      return false;
    };

    const ensureBind = () => {
      if (session.mode === 'secondary' && !session.owner && !bindUsable(bind, cfg.now())) bind = createBindCode(cfg.random, cfg.now());
    };

    // ---------- 连接 ----------

    const scheduleRetry = async (why) => {
      attempt += 1;
      const delay = backoffDelay(attempt, { ...cfg.backoff, random: cfg.random });
      armTimer('retry', delay, () => connect());
      await publish('pending', `${why}，${Math.max(1, Math.round(delay / 1000))} 秒后第 ${attempt} 次重连`);
    };

    const onClosed = async (g, code, error) => {
      if (g !== gen || self.stopped) return;
      const wasLoggingIn = loggingIn;
      teardown();
      const action = disconnectAction(code, { loggingIn: wasLoggingIn });
      if (action === 'restart') {
        restarts += 1;
        if (login) login.qrText = '';
        if (restarts <= MAX_RESTARTS) {
          armTimer('retry', 0, () => connect());
          await publish('pending', wasLoggingIn ? '已扫码，正在登录…' : '正在重新连接…');
          return;
        }
        restarts = 0;
        await scheduleRetry('连接反复重启');
        return;
      }
      if (action === 'logged-out') {
        login = null;
        bind = null;
        await wipeAuth();
        await publish('error', '已在手机上移除这台设备或登录失效，需要重新扫码');
        return;
      }
      if (action === 'forbidden') {
        await publish('error', 'WhatsApp 拒绝了这个号（403），可能已被限制，已停止重连');
        return;
      }
      if (action === 'replaced') {
        await publish('error', '这个号在别处又连上了一个同样的会话，这边已停止；点「重新连接」恢复');
        return;
      }
      const hadQr = Boolean(login?.qrText);
      if (action === 'qr-expired' && hadQr && login.rounds + 1 < cfg.maxQrRounds) {
        login.rounds += 1;
        login.qrText = '';
        armTimer('retry', 0, () => connect());
        await publish('pending', '二维码过期，正在刷新…');
        return;
      }
      if (wasLoggingIn) {
        login = null;
        await wipeAuth();
        await publish(
          'error',
          action === 'qr-expired' && hadQr ? '二维码已过期，点「扫码登录」重新获取' : `获取二维码失败：${safeError(error ?? '连接失败')}`,
        );
        return;
      }
      await scheduleRetry(code ? `连接断开（${code}）` : '连接断开');
    };

    const onUpdate = async (g, s, update) => {
      if (g !== gen || self.stopped) return;
      if (typeof update?.qr === 'string' && update.qr) {
        login ??= { rounds: 0, qrText: '', shown: 0 };
        login.qrText = update.qr;
        login.shown += 1;
        clearTimer('connect');
        armTimer('qr', cfg.qrStaleMs, () => onClosed(g, 408, new Error('二维码超时')));
        await publish('pending', login.shown > 1 || login.rounds > 0 ? '二维码已刷新，请重新扫描' : '请用 WhatsApp 扫描二维码');
        settleLogin();
      }
      if (update?.connection === 'open') {
        clearTimer('connect');
        clearTimer('qr');
        loggingIn = false;
        attempt = 0;
        restarts = 0;
        login = null;
        me = selfIds(s.user);
        if (session.account && me.pn && session.account !== me.pn) {
          // 换了号：旧号上的主人和群都不作数
          session = emptySession(session.mode);
          sentIds = new Set();
          quotes.clear();
          bind = null;
        }
        const changed = Boolean(me.pn) && session.account !== me.pn;
        if (changed) session.account = me.pn;
        ensureBind();
        if (changed) await save();
        if (g !== gen || self.stopped) return;
        opened = true;
        await publishOpen();
        settleLogin();
      } else if (update?.connection === 'close') {
        const err = update.lastDisconnect?.error;
        const code = err?.output?.statusCode ?? err?.statusCode;
        await onClosed(g, typeof code === 'number' ? code : undefined, err);
        settleLogin();
      }
    };

    async function connect() {
      if (self.stopped) return;
      const g = ++gen;
      teardown();
      await credsSaving.catch(() => {});
      let auth;
      try {
        auth = await proto.useAuth(authDir);
      } catch (error) {
        if (g !== gen) return;
        await publish('error', `读取登录状态失败：${safeError(error)}`);
        settleLogin();
        return;
      }
      if (g !== gen || self.stopped) return;
      loggingIn = !auth.creds?.me?.id;
      let s;
      try {
        s = proto.makeSocket({
          auth: { creds: auth.creds, keys: auth.keys },
          logger: silentLogger(),
          browser: proto.browser,
          markOnlineOnConnect: false,
          syncFullHistory: false,
          shouldSyncHistoryMessage: () => false,
          generateHighQualityLinkPreview: false,
          emitOwnEvents: true,
          connectTimeoutMs: 20_000,
          getMessage: async (key) => recent.get(key?.id),
        });
      } catch (error) {
        await onClosed(g, undefined, error);
        return;
      }
      sock = s;
      s.ev.on('creds.update', () => {
        credsSaving = credsSaving
          .catch(() => {})
          .then(() => auth.saveCreds())
          .catch((error) => console.error(LOG, '保存登录状态失败', safeError(error)));
      });
      s.ev.on('connection.update', (update) => {
        void onUpdate(g, s, update).catch((error) => console.error(LOG, '连接状态处理失败', safeError(error)));
      });
      s.ev.on('messages.upsert', (upsert) => {
        if (g !== gen) return;
        // 一条一条来：绑定码计数、引用目标不会被并发打乱
        upserting = upserting
          .then(() => onUpsert(upsert))
          .catch((error) => console.error(LOG, '处理消息失败', safeError(error)));
      });
      s.ev.on('groups.update', (list) => {
        let changed = false;
        for (const g2 of Array.isArray(list) ? list : []) {
          if (g2?.id && session.groups[g2.id] && typeof g2.subject === 'string') {
            session.groups[g2.id].title = g2.subject;
            changed = true;
          }
        }
        if (changed) void save();
      });
      // 连接 Promise 必须有尽头：既没出二维码也没连上，就按断线收尾
      armTimer('connect', cfg.connectTimeoutMs, () => onClosed(g, undefined, new Error('连接超时')));
      if (phase !== 'pending' || !detail) await publish('pending', loggingIn ? '正在获取二维码…' : '正在连接 WhatsApp…');
    }

    // ---------- 入站 ----------

    /** 经 enso.net.fetch 下载（只到清单里的媒体域名）、本地解密；格式、大小上限和落盘交给宿主 */
    const fetchImage = async (file) => {
      if (file.size > MAX_DOWNLOAD_BYTES) return { rejected: NOT_DOWNLOADED };
      const url = mediaDownloadUrl(file);
      if (!url) return { rejected: NOT_DOWNLOADED };
      try {
        const res = await withTimeout(
          enso.net.fetch(url, { headers: { Origin: 'https://web.whatsapp.com' }, responseType: 'base64' }),
          cfg.downloadTimeoutMs,
          '下载超时',
        );
        if (typeof res?.status === 'number' && (res.status < 200 || res.status >= 300)) throw new Error(`HTTP ${res.status}`);
        return { data: decryptMedia(res?.body ?? '', file.mediaKey, file.keyType).toString('base64') };
      } catch (error) {
        console.error(LOG, '下载图片失败', safeError(error));
        return { rejected: NOT_DOWNLOADED };
      }
    };

    const deliver = async (msg, res) => {
      const group = res.chatType === 'group';
      let images = res.file ? [await fetchImage(res.file)] : res.media ? [{ rejected: 'not-image' }] : [];
      // 宿主对每个 rejected 都回对方一句，群里不回提示，所以群里收不下的不带
      if (group) images = images.filter((image) => image.data);
      if (!res.text && !images.length) return;
      if (group) quotes.set(res.peerId, { key: msg.key, message: msg.message });
      const payload = { peerId: res.peerId, senderId: res.senderId, chatType: res.chatType, text: res.text };
      if (res.chatTitle) payload.chatTitle = res.chatTitle;
      if (res.name) payload.name = res.name;
      if (res.at != null) payload.at = res.at;
      if (images.length) payload.images = images;
      await enso.contact.inbound(CHANNEL, payload);
      try {
        if (session.mode !== 'self') await sock?.readMessages?.([msg.key]);
      } catch {}
    };

    const tryBind = async (res) => {
      if (!bindUsable(bind, cfg.now())) return;
      if (res.code !== bind.code) {
        bind.failures += 1;
        if (bind.failures >= BIND_MAX_FAILURES) {
          bind = null;
          await publish('pending', '绑定码错误次数太多，已作废，请在设置页换一个');
        }
        return;
      }
      bind = null;
      session.owner = res.owner;
      await save();
      await publishOpen();
      try {
        await sendText(res.owner.jid, { text: BOUND });
      } catch (error) {
        console.error(LOG, '发送绑定确认失败', safeError(error));
      }
    };

    async function onUpsert(upsert) {
      const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
      for (const msg of messages) {
        if (self.stopped) return;
        try {
          if (!me.pn && sock?.user) me = selfIds(sock.user);
          const res = classifyInbound({
            msg,
            type: upsert.type,
            mode: session.mode,
            me,
            owner: session.owner,
            groups: session.groups,
            sentIds,
            bindActive: bindUsable(bind, cfg.now()),
            now: cfg.now(),
          });
          if (res.kind === 'ignore') continue;
          if (markSeen(msg.key?.id)) continue;
          if (res.kind === 'bind') await tryBind(res);
          else await deliver(msg, res);
        } catch (error) {
          console.error(LOG, '处理消息失败', safeError(error));
        }
      }
    }

    // ---------- 出站 ----------

    const live = (peerId) => {
      const jid = String(peerId ?? '');
      if (!sock || !opened) throw new Error('WhatsApp 未连接');
      if (!allowedPeer(jid)) throw new Error('只能发给主人或已绑定的群');
      return jid;
    };

    const stopTyping = (jid) => {
      const t = typingTimers.get(jid);
      if (t) clearTimeout(t);
      typingTimers.delete(jid);
    };

    /** 先记下 id 再发：秘书自己的消息回到 messages.upsert 时一定认得出 */
    const sendOne = async (jid, content, extra, timeoutMs) => {
      const s = sock;
      const g = gen;
      const id = proto.newMessageId(s.user?.id);
      rememberSent(id);
      const sent = await withTimeout(s.sendMessage(jid, content, { ...extra, messageId: id }), timeoutMs, '发送超时');
      if (g !== gen) throw new Error('WhatsApp 连接已变，消息可能未发送');
      const real = sent?.key?.id;
      if (real && real !== id) rememberSent(real);
      if (sent?.message) {
        recent.set(real || id, sent.message);
        if (recent.size > RECENT_KEEP) recent.delete(recent.keys().next().value);
      }
      return real || id;
    };

    const takeQuote = (jid) => {
      const quoted = quotes.get(jid);
      quotes.delete(jid);
      return quoted ? { quoted } : {};
    };

    async function sendText(peerId, input) {
      const parts = chunkText(markdownToWhatsApp(input?.text), MAX_CHARS);
      if (!parts.length) return {};
      const jid = live(peerId);
      stopTyping(jid);
      let extra = takeQuote(jid);
      let messageId;
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) await pause(cfg.chunkGapMs);
        messageId = await sendOne(jid, { text: parts[i] }, extra, cfg.sendTimeoutMs);
        extra = {};
      }
      return { messageId };
    }

    /** 替换 Baileys 的上传：走 enso.net.fetch，域名受清单约束 */
    const upload = async (filePath, { mediaType, fileEncSha256B64 }) => {
      const s = sock;
      if (!s) throw new Error('WhatsApp 未连接');
      const info = await s.refreshMediaConn(false);
      const path = proto.mediaPath(mediaType);
      if (!path) throw new Error(`不支持的媒体类型 ${mediaType}`);
      const token = proto.uploadToken(fileEncSha256B64);
      const body = (await readFile(filePath)).toString('base64');
      let last = null;
      for (const host of Array.isArray(info?.hosts) ? info.hosts : []) {
        if (!mediaHostAllowed(host?.hostname)) continue;
        const url = `https://${host.hostname}${path}/${token}?auth=${encodeURIComponent(info.auth)}&token=${token}`;
        try {
          const res = await enso.net.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' },
            body,
            bodyEncoding: 'base64',
          });
          if (typeof res?.status === 'number' && (res.status < 200 || res.status >= 300)) {
            last = `HTTP ${res.status}`;
            continue;
          }
          const json = JSON.parse(res?.body || '{}');
          if (json.url || json.direct_path) {
            return { mediaUrl: json.url, directPath: json.direct_path, meta_hmac: json.meta_hmac, fbid: json.fbid, ts: json.ts };
          }
          last = '没有返回地址';
        } catch (error) {
          last = safeError(error);
        }
      }
      throw new Error(last ? `媒体上传失败：${last}` : '没有可用的媒体上传主机');
    };

    async function sendMedia(kind, peerId, media) {
      const jid = live(peerId);
      const data = media?.data;
      if (!data?.length) throw new Error('没有要发送的内容');
      const buffer = Buffer.from(data);
      const caption = markdownToWhatsApp(typeof media?.caption === 'string' ? media.caption.trim() : '').slice(0, 1024);
      const content =
        kind === 'image'
          ? { image: buffer, mimetype: media?.mimeType || 'image/jpeg' }
          : { document: buffer, fileName: String(media?.fileName || 'file'), mimetype: media?.mimeType || 'application/octet-stream' };
      if (caption) content.caption = caption;
      stopTyping(jid);
      const messageId = await sendOne(jid, content, { ...takeQuote(jid), upload }, cfg.mediaTimeoutMs);
      return { messageId };
    }

    /** 宿主每 4 秒续一次 on:true、从不发 off：一段时间没续就自己收掉 */
    async function typing(peerId, input) {
      try {
        const jid = String(peerId ?? '');
        if (!sock || !opened || !allowedPeer(jid)) return;
        if (input?.on === false) {
          stopTyping(jid);
          await sock.sendPresenceUpdate('paused', jid);
          return;
        }
        await sock.sendPresenceUpdate('composing', jid);
        stopTyping(jid);
        typingTimers.set(
          jid,
          setTimeout(() => {
            typingTimers.delete(jid);
            void Promise.resolve(sock?.sendPresenceUpdate('paused', jid)).catch(() => {});
          }, cfg.typingIdleMs),
        );
      } catch (error) {
        console.error(LOG, 'typing', safeError(error));
      }
    }

    // ---------- 设置页 ----------

    const registered = async () => {
      try {
        const auth = await proto.useAuth(authDir);
        return Boolean(auth.creds?.me?.id);
      } catch {
        return false;
      }
    };

    const waitLogin = (ms) =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          loginWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        loginWaiters.add(done);
      });

    enso.renderer.handle('state', () => snapshot());
    enso.renderer.handle('login', async () => {
      if (opened) return snapshot();
      attempt = 0;
      restarts = 0;
      if (await registered()) {
        login = null;
        await publish('pending', '正在连接 WhatsApp…');
      } else {
        gen += 1;
        teardown();
        await wipeAuth();
        login = { rounds: 0, qrText: '', shown: 0 };
        await publish('pending', '正在获取二维码…');
      }
      const waiting = waitLogin(cfg.loginWaitMs);
      await connect();
      await waiting;
      return snapshot();
    });
    enso.renderer.handle('logout', async () => {
      const s = sock;
      gen += 1;
      if (s && opened) {
        try {
          await withTimeout(s.logout(), cfg.logoutTimeoutMs, '退出超时');
        } catch (error) {
          console.error(LOG, '退出登录时出错，已清掉本机状态', safeError(error));
        }
      }
      teardown();
      settleLogin();
      await wipeAuth();
      session = emptySession(session.mode);
      sentIds = new Set();
      quotes.clear();
      knownGroups = new Map();
      bind = null;
      login = null;
      me = selfIds(null);
      await save();
      return publish('unconfigured', '已退出');
    });
    enso.renderer.handle('setMode', async (args) => {
      const mode = args?.mode === 'self' ? 'self' : args?.mode === 'secondary' ? 'secondary' : null;
      if (!mode) throw new Error('模式只能是 secondary 或 self');
      if (session.mode !== mode) {
        session.mode = mode;
        quotes.clear();
        await save();
      }
      if (opened) {
        ensureBind();
        return publishOpen();
      }
      return publish(phase, detail);
    });
    enso.renderer.handle('newBindCode', async () => {
      if (!opened || session.mode !== 'secondary') throw new Error('副号模式连上之后才能生成绑定码');
      if (session.owner) throw new Error('已经绑定了主人，先解除再换');
      bind = createBindCode(cfg.random, cfg.now());
      return publishOpen();
    });
    enso.renderer.handle('unbindOwner', async () => {
      session.owner = null;
      bind = null;
      await save();
      if (opened) {
        ensureBind();
        return publishOpen();
      }
      return publish(phase, detail);
    });
    enso.renderer.handle('groups', async () => {
      if (!sock || !opened) throw new Error('WhatsApp 未连接');
      const all = await withTimeout(sock.groupFetchAllParticipating(), cfg.queryTimeoutMs, '获取群列表超时');
      knownGroups = new Map();
      for (const [jid, meta] of Object.entries(all ?? {})) {
        if (!isGroupJid(jid)) continue;
        const title = typeof meta?.subject === 'string' ? meta.subject : '';
        knownGroups.set(jid, { title, size: Array.isArray(meta?.participants) ? meta.participants.length : 0 });
        if (session.groups[jid] && title) session.groups[jid].title = title;
      }
      await save();
      const list = [...knownGroups].map(([jid, g]) => ({ jid, title: g.title || jid, size: g.size, enabled: Boolean(session.groups[jid]) }));
      for (const [jid, g] of Object.entries(session.groups)) {
        if (!knownGroups.has(jid)) list.push({ jid, title: g.title || jid, size: 0, enabled: true, missing: true });
      }
      list.sort((a, b) => a.title.localeCompare(b.title));
      return { groups: list };
    });
    enso.renderer.handle('setGroup', async (args) => {
      const jid = String(args?.jid ?? '');
      if (!isGroupJid(jid)) throw new Error('群 id 不合法');
      if (args?.enabled === true) {
        const known = knownGroups.get(jid);
        if (!known) throw new Error('这个号不在这个群里，先刷新群列表');
        if (!session.groups[jid] && Object.keys(session.groups).length >= MAX_GROUPS) throw new Error(`最多绑定 ${MAX_GROUPS} 个群`);
        session.groups[jid] = { title: known.title };
      } else {
        delete session.groups[jid];
        quotes.delete(jid);
      }
      await save();
      return publish(phase, detail);
    });

    await load();
    self.unregister = await enso.contact.register(CHANNEL, {
      caps: {
        buttons: false,
        urlButtons: false,
        edit: false,
        typing: true,
        format: 'plain',
        maxChars: MAX_CHARS,
        commandMenu: false,
        images: true,
        files: true,
      },
      sendText,
      typing,
      sendImage: (peerId, media) => sendMedia('image', peerId, media),
      sendFile: (peerId, media) => sendMedia('file', peerId, media),
    });
    if (self.stopped) {
      const unregister = self.unregister;
      self.unregister = null;
      await unregister?.();
      return {};
    }
    if (await registered()) await connect();
    else await publish('unconfigured', '');
    return {
      session: () => session,
      socket: () => sock,
      flush: async () => {
        await saving.catch(() => {});
        await credsSaving.catch(() => {});
      },
    };
  } catch (error) {
    if (current === self) deactivate();
    throw error;
  }
}
