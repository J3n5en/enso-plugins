import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_BASE,
  acceptedWeixinBase,
  apiUrl,
  appHeaders,
  baseInfo,
  cdnUploadUrl,
  chunkText,
  encryptAesEcb,
  fileItem,
  imageItem,
  isRelogin,
  mediaMessageBody,
  nextCursor,
  postHeaders,
  qrStatusUrl,
  readInbound,
  rejectedHost,
  sendMessageBody,
  UPLOAD_MEDIA_TYPE,
  uploadUrlBody,
} from './lib/ilink.mjs';

const CHANNEL = 'wechat';
const STATE_FILE = 'state.json';
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
/** 连续失败超过这么多次才记 error，之前的退避重试只记 warn */
const POLL_ERROR_AFTER = 5;
const IDLE_MS = 5_000;
/** 服务端没按长轮询挂住时，避免空转打满 */
const MIN_GAP_MS = 1_000;
/** 失效刷新超过 3 次就停，让用户稍后再扫 */
const MAX_QR_REFRESH = 3;
const UNSUPPORTED = '暂不支持图片、文件和视频';
const UNSUPPORTED_WITH_TEXT = '暂不支持图片、文件和视频，只处理了文字';
const VOICE_NO_TEXT = '这条语音没能转成文字，麻烦再发一次或者打字';
/** CDN 上传：5xx 与网络错误重试，4xx 直接失败 */
const CDN_MAX_ATTEMPTS = 3;
/** sendmessage 的 context_token 失效或缺失 */
const RET_SESSION_EXPIRED = -2;
const SESSION_EXPIRED = '微信会话已过期，请在微信给机器人发任意一条消息后恢复';

let current = null;

/** message 对旧宿主可读；code / userMessage 给支持结构化错误的宿主 */
function sessionExpired() {
  return Object.assign(new Error(SESSION_EXPIRED), { code: 'SESSION_EXPIRED', userMessage: SESSION_EXPIRED });
}

function isCancelled(error) {
  return (
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ABORTED' ||
    /abort|cancel|取消/i.test(String(error?.message ?? ''))
  );
}

export function deactivate() {
  const prev = current;
  if (!prev) return;
  prev.stopped = true;
  if (prev.timer) clearTimeout(prev.timer);
  prev.timer = null;
  prev.wake?.();
  prev.wake = null;
  current = null;
  try {
    void Promise.resolve(prev.unregister?.()).catch((error) =>
      console.error('[微信 Clawbot] 注销联系方式失败', error?.message ?? error),
    );
  } catch (error) {
    console.error('[微信 Clawbot] 注销联系方式失败', error?.message ?? error);
  }
}

function emptyState() {
  return { botToken: '', ilinkBotId: '', baseUrl: DEFAULT_BASE, ilinkUserId: '', cursor: '', contexts: {} };
}

function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const contexts = {};
  if (raw.contexts && typeof raw.contexts === 'object' && !Array.isArray(raw.contexts)) {
    for (const [key, value] of Object.entries(raw.contexts)) {
      if (typeof value === 'string' && value) contexts[key] = value;
    }
  }
  return {
    botToken: typeof raw.botToken === 'string' ? raw.botToken : '',
    ilinkBotId: typeof raw.ilinkBotId === 'string' ? raw.ilinkBotId : '',
    baseUrl: acceptedWeixinBase(raw.baseUrl) || DEFAULT_BASE,
    ilinkUserId: typeof raw.ilinkUserId === 'string' ? raw.ilinkUserId : '',
    cursor: typeof raw.cursor === 'string' ? raw.cursor : '',
    contexts,
  };
}

function freshLogin() {
  return { qrcode: '', qrText: '', pollBase: DEFAULT_BASE, verifyCode: '', refreshCount: 0, needVerify: false };
}

/** options.loop=false 时不起常驻轮询，返回 tick() 供测试一步步驱动；其余选项只给测试缩短等待 */
export async function activate(
  enso,
  {
    loop = true,
    backoffStartMs = BACKOFF_START_MS,
    backoffMaxMs = BACKOFF_MAX_MS,
    minGapMs = MIN_GAP_MS,
    pollErrorAfter = POLL_ERROR_AFTER,
  } = {},
) {
  deactivate();
  const self = { stopped: false, timer: null, wake: null, unregister: null, looping: false };
  current = self;
  try {
    const file = join(enso.dataDir, STATE_FILE);
    let session = emptyState();
    let login = null;
    let epoch = 0;
    let phase = 'unconfigured';
    let detail = '';
    let lastStatus = '';
    let lastView = '';
    const typingTickets = new Map();
    let saving = Promise.resolve();

    const loggedIn = () => Boolean(session.botToken && session.ilinkUserId);
    const peers = () => (loggedIn() ? [session.ilinkUserId] : []);
    const snapshot = () => ({
      status: phase,
      detail,
      peerId: session.ilinkUserId || '',
      qrText: login?.qrText || '',
      needVerify: login?.needVerify === true,
    });

    const save = () => {
      const body = JSON.stringify(session, null, 2);
      saving = saving.catch(() => {}).then(async () => {
        await mkdir(enso.dataDir, { recursive: true });
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, body);
        await rename(tmp, file);
      });
      return saving;
    };

    const load = async () => {
      try {
        session = normalize(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        session = emptyState();
      }
    };

    const sleep = (ms) =>
      new Promise((resolve) => {
        if (self.stopped) return resolve();
        self.wake = resolve;
        self.timer = setTimeout(() => {
          self.timer = null;
          self.wake = null;
          resolve();
        }, ms);
      });
    const wake = () => {
      if (!self.timer) return;
      clearTimeout(self.timer);
      self.timer = null;
      self.wake?.();
      self.wake = null;
    };

    const publish = async (status, nextDetail) => {
      phase = status;
      detail = nextDetail ?? '';
      const body = { status, detail, peers: peers() };
      const statusKey = JSON.stringify(body);
      if (statusKey !== lastStatus) {
        lastStatus = statusKey;
        try {
          await enso.contact.setStatus(CHANNEL, body);
        } catch (error) {
          console.error('[微信 Clawbot] setStatus', error?.message ?? error);
        }
      }
      const view = snapshot();
      const viewKey = JSON.stringify(view);
      if (viewKey !== lastView) {
        lastView = viewKey;
        try {
          enso.ui.view.emit('status', view);
        } catch (error) {
          console.error('[微信 Clawbot] 推送页面失败', error?.message ?? error);
        }
      }
      return view;
    };

    const request = async (url, init) => {
      const res = await enso.net.fetch(url, init);
      const status = res?.status;
      if (typeof status === 'number' && status !== 0 && (status < 200 || status >= 300)) {
        throw new Error(`微信 HTTP ${status}`);
      }
      if (!res?.body) return {};
      try {
        return JSON.parse(res.body);
      } catch {
        throw new Error(`微信返回的不是 JSON（HTTP ${status ?? '?'}）`);
      }
    };
    const post = (base, path, body, token) =>
      request(apiUrl(base, path), { method: 'POST', headers: postHeaders(token), body: JSON.stringify(body) });
    const get = (url) => request(url, { method: 'GET', headers: appHeaders() });

    const clearSession = () => {
      session = emptyState();
      typingTickets.clear();
    };

    const relogin = async (why) => {
      epoch += 1;
      login = null;
      clearSession();
      await save();
      await publish('error', why);
    };

    const applyQr = (data) => {
      if (typeof data?.qrcode !== 'string' || !data.qrcode || typeof data?.qrcode_img_content !== 'string') {
        throw new Error('二维码响应不完整');
      }
      login.qrcode = data.qrcode;
      login.qrText = data.qrcode_img_content;
    };

    const fetchQr = async (gen) => {
      const data = await post(DEFAULT_BASE, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] });
      if (gen !== epoch || self.stopped || !login) return false;
      applyQr(data);
      return true;
    };

    const onConfirmed = async (gen, data) => {
      const token = typeof data?.bot_token === 'string' ? data.bot_token : '';
      const userId = typeof data?.ilink_user_id === 'string' ? data.ilink_user_id : '';
      if (!token || !userId) {
        login = null;
        await publish('error', '登录返回缺少凭证');
        return;
      }
      if (gen !== epoch) return;
      const accepted = data.baseurl ? acceptedWeixinBase(data.baseurl) : DEFAULT_BASE;
      session = {
        ...emptyState(),
        botToken: token,
        ilinkBotId: typeof data.ilink_bot_id === 'string' ? data.ilink_bot_id : '',
        baseUrl: accepted || DEFAULT_BASE,
        ilinkUserId: userId,
      };
      typingTickets.clear();
      login = null;
      await save();
      if (!accepted) {
        await publish('error', `拒绝主机 ${rejectedHost(data.baseurl) || '（空）'}`);
        return;
      }
      await publish('connected', '已连接');
    };

    const pollQrOnce = async () => {
      if (!login?.qrcode) return;
      const gen = epoch;
      const url = qrStatusUrl(login.pollBase, login.qrcode, login.verifyCode);
      let data;
      try {
        data = await get(url);
      } catch (error) {
        if (gen !== epoch || !login) return;
        console.error('[微信 Clawbot] 扫码状态失败，按等待处理：', error?.message ?? error);
        if (phase !== 'error') await publish('pending', '等待扫码');
        return;
      }
      if (gen !== epoch || !login) return;
      const status = String(data?.status ?? '').trim();
      if (status.includes('need_verifycode')) {
        login.verifyCode = '';
        login.needVerify = true;
        await publish('pending', '请输入手机上的数字');
        return;
      }
      if (status === 'scaned') {
        login.verifyCode = '';
        login.needVerify = false;
        await publish('pending', '已扫码，请在手机上确认');
        return;
      }
      if (status === 'wait' || status === '') {
        // 拒绝过的跳转要留在 error，不能被下一轮空等刷掉
        if (phase !== 'error') await publish('pending', '等待扫码');
        return;
      }
      if (status === 'scaned_but_redirect') {
        const next = acceptedWeixinBase(data.redirect_host);
        if (!next) {
          login.pollBase = DEFAULT_BASE;
          await publish('error', `拒绝主机 ${rejectedHost(data.redirect_host) || '（空）'}`);
          return;
        }
        login.pollBase = next;
        await publish('pending', '已扫码，正在确认');
        return;
      }
      if (status === 'expired' || status === 'verify_code_blocked') {
        login.refreshCount += 1;
        login.verifyCode = '';
        login.needVerify = false;
        if (login.refreshCount > MAX_QR_REFRESH) {
          login = null;
          await publish('error', '二维码刷新超过 3 次，请稍后再试');
          return;
        }
        login.pollBase = DEFAULT_BASE;
        const ok = await fetchQr(gen);
        if (!ok) return;
        await publish('pending', '二维码已刷新，请重新扫描');
        return;
      }
      if (status === 'binded_redirect') {
        await publish('pending', '已经绑定过，没有新的登录凭证');
        return;
      }
      if (status === 'confirmed') {
        await onConfirmed(gen, data);
        return;
      }
      await publish('pending', `扫码状态：${status}`);
    };

    const handleMessage = async (msg) => {
      const inbound = readInbound(msg, session.ilinkUserId);
      if (!inbound) return;
      if (inbound.contextToken) {
        session.contexts[inbound.peerId] = inbound.contextToken;
        await save();
      }
      if (inbound.text) {
        const payload = { peerId: inbound.peerId, senderId: inbound.senderId };
        if (inbound.chatType) payload.chatType = inbound.chatType;
        payload.text = inbound.text;
        if (inbound.at != null) payload.at = inbound.at;
        await enso.contact.inbound(CHANNEL, payload);
        if (inbound.unsupported) await sendText(inbound.peerId, { text: UNSUPPORTED_WITH_TEXT });
        return;
      }
      const voice = Array.isArray(msg.item_list) && msg.item_list.some((item) => item?.type === 3);
      if (voice) await sendText(inbound.peerId, { text: VOICE_NO_TEXT });
      else if (inbound.unsupported) await sendText(inbound.peerId, { text: UNSUPPORTED });
    };

    const pollUpdatesOnce = async () => {
      const gen = epoch;
      const token = session.botToken;
      const base = session.baseUrl;
      const cursor = session.cursor;
      const data = await post(base, '/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: baseInfo() }, token);
      if (gen !== epoch || self.stopped) return;
      if (isRelogin(data)) {
        await relogin('relogin：登录已失效，请重新扫码');
        return;
      }
      const ret = data?.ret;
      const errcode = data?.errcode;
      if ((typeof ret === 'number' && ret !== 0) || (typeof errcode === 'number' && errcode !== 0)) {
        throw new Error(`getupdates ret=${ret ?? ''} errcode=${errcode ?? ''} ${data?.errmsg ?? ''}`.trim());
      }
      const cursorNext = nextCursor(cursor, data?.get_updates_buf);
      if (cursorNext !== session.cursor && gen === epoch) {
        session.cursor = cursorNext;
        await save();
      }
      if (gen !== epoch) return;
      const msgs = Array.isArray(data?.msgs) ? data.msgs : [];
      for (const msg of msgs) {
        if (gen !== epoch) return;
        try {
          await handleMessage(msg);
        } catch (error) {
          console.error('[微信 Clawbot] 处理消息失败', error?.message ?? error);
        }
      }
    };

    async function sendText(peerId, input) {
      const parts = chunkText(input?.text, 2000);
      if (!parts.length) return;
      if (!loggedIn()) throw new Error('微信未登录');
      const id = String(peerId);
      const gen = epoch;
      let ref;
      for (const part of parts) {
        const clientId = randomUUID();
        await sendMessage(gen, id, (contextToken) => sendMessageBody({ peerId: id, text: part, contextToken, clientId }));
        ref = clientId;
      }
      return { messageId: ref };
    }

    /** 没有 token 直接失败；ret=-2 时丢掉这个 token，等下一条入站消息带来新的 */
    async function sendMessage(gen, id, build) {
      const token = session.contexts[id];
      if (!token) throw sessionExpired();
      const res = await post(session.baseUrl, '/ilink/bot/sendmessage', build(token), session.botToken);
      if (gen !== epoch) throw new Error('微信登录状态已变，消息未发送');
      if (res?.ret === RET_SESSION_EXPIRED) {
        if (session.contexts[id] === token) {
          delete session.contexts[id];
          await save();
        }
        throw sessionExpired();
      }
      if (typeof res?.ret === 'number' && res.ret !== 0) {
        throw new Error(`sendmessage ret=${res.ret} ${res.errmsg ?? ''}`.trim());
      }
    }

    /**
     * 媒体出站（iLink 协议）：getuploadurl 拿上传地址 → AES-128-ECB 加密后 POST 到 CDN，
     * 从响应头 x-encrypted-param 拿下载参数 → sendmessage 带 image_item / file_item。
     * 说明文字按协议先单独发一条 TEXT。
     */
    async function uploadToCdn(peerId, plaintext, mediaType) {
      const filekey = randomBytes(16).toString('hex');
      const aeskey = randomBytes(16);
      const aeskeyHex = aeskey.toString('hex');
      const res = await post(
        session.baseUrl,
        '/ilink/bot/getuploadurl',
        uploadUrlBody({ filekey, mediaType, toUserId: peerId, plaintext, aeskeyHex }),
        session.botToken,
      );
      if (typeof res?.ret === 'number' && res.ret !== 0) {
        throw new Error(`getuploadurl ret=${res.ret} ${res.errmsg ?? ''}`.trim());
      }
      const full = typeof res?.upload_full_url === 'string' ? res.upload_full_url.trim() : '';
      const param = typeof res?.upload_param === 'string' ? res.upload_param : '';
      if (!full && !param) throw new Error('getuploadurl 没有返回上传地址');
      const url = full || cdnUploadUrl(param, filekey);
      const ciphertext = encryptAesEcb(plaintext, aeskey);
      let lastError;
      for (let attempt = 1; attempt <= CDN_MAX_ATTEMPTS; attempt += 1) {
        let out;
        try {
          out = await enso.net.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: ciphertext.toString('base64'),
            bodyEncoding: 'base64',
          });
        } catch (error) {
          lastError = error;
          continue;
        }
        const status = out?.status;
        const headers = out?.headers ?? {};
        if (status >= 400 && status < 500) {
          throw new Error(`CDN 上传被拒 HTTP ${status} ${headers['x-error-message'] ?? ''}`.trim());
        }
        if (status !== 200) {
          lastError = new Error(`CDN 上传失败 HTTP ${status} ${headers['x-error-message'] ?? ''}`.trim());
          continue;
        }
        const downloadParam = headers['x-encrypted-param'];
        if (typeof downloadParam !== 'string' || !downloadParam) {
          lastError = new Error('CDN 响应缺少 x-encrypted-param');
          continue;
        }
        return { downloadParam, aeskeyHex, rawSize: plaintext.length, cipherSize: ciphertext.length };
      }
      throw lastError ?? new Error('CDN 上传失败');
    }

    async function sendMedia(kind, peerId, media) {
      if (!loggedIn()) throw new Error('微信未登录');
      const id = String(peerId ?? '');
      const data = media?.data;
      if (!id || !data?.length) throw new Error('没有要发送的内容');
      if (!session.contexts[id]) throw sessionExpired();
      const gen = epoch;
      const plaintext = Buffer.from(data);
      const fileName = String(media?.fileName || 'file');
      const caption = typeof media?.caption === 'string' ? media.caption.trim() : '';
      if (caption) await sendText(id, { text: caption });
      const uploaded = await uploadToCdn(
        id,
        plaintext,
        kind === 'image' ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE,
      );
      if (gen !== epoch) throw new Error('微信登录状态已变，消息未发送');
      const clientId = randomUUID();
      const item = kind === 'image' ? imageItem(uploaded) : fileItem(uploaded, fileName);
      await sendMessage(gen, id, (contextToken) => mediaMessageBody({ peerId: id, item, contextToken, clientId }));
      return { messageId: clientId };
    }

    async function typing(peerId, input) {
      try {
        if (!loggedIn()) return;
        const id = String(peerId ?? '');
        if (!id) return;
        const on = input?.on === true;
        let ticket = typingTickets.get(id);
        if (!ticket) {
          const body = { ilink_user_id: id, base_info: baseInfo() };
          if (session.contexts[id]) body.context_token = session.contexts[id];
          const res = await post(session.baseUrl, '/ilink/bot/getconfig', body, session.botToken);
          if (res?.ret != null && res.ret !== 0) return;
          if (typeof res?.typing_ticket !== 'string' || !res.typing_ticket) return;
          ticket = res.typing_ticket;
          typingTickets.set(id, ticket);
        }
        await post(
          session.baseUrl,
          '/ilink/bot/sendtyping',
          { ilink_user_id: id, typing_ticket: ticket, status: on ? 1 : 2, base_info: baseInfo() },
          session.botToken,
        );
      } catch (error) {
        if (isCancelled(error)) console.debug('[微信 Clawbot] typing 已取消');
        else console.error('[微信 Clawbot] typing', error?.message ?? error);
      }
    }

    const tick = async () => {
      if (self.stopped) return 'stopped';
      if (login) {
        await pollQrOnce();
        return 'qr';
      }
      if (loggedIn()) {
        await pollUpdatesOnce();
        return 'updates';
      }
      return 'idle';
    };

    const startLoop = () => {
      if (!loop || self.looping || self.stopped) return;
      self.looping = true;
      void (async () => {
        let backoff = backoffStartMs;
        let failures = 0;
        while (!self.stopped) {
          const started = Date.now();
          try {
            const kind = await tick();
            if (self.stopped) break;
            if (kind === 'idle') await sleep(IDLE_MS);
            else {
              backoff = backoffStartMs;
              failures = 0;
              const gap = minGapMs - (Date.now() - started);
              if (gap > 0) await sleep(gap);
            }
          } catch (error) {
            if (self.stopped) break;
            failures += 1;
            const log = failures > pollErrorAfter ? console.error : console.warn;
            log(`[微信 Clawbot] 轮询连续失败 ${failures} 次，${Math.round(backoff / 1000)} 秒后重试：`, error?.message ?? error);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, backoffMaxMs);
          }
        }
        self.looping = false;
      })();
    };

    enso.renderer.handle('state', () => snapshot());
    enso.renderer.handle('login', async () => {
      epoch += 1;
      const gen = epoch;
      login = freshLogin();
      typingTickets.clear();
      try {
        const ok = await fetchQr(gen);
        if (!ok) return snapshot();
      } catch (error) {
        if (gen === epoch) {
          login = null;
          if (loggedIn()) await publish('connected', '已连接');
          else await publish('error', `获取二维码失败：${error?.message ?? error}`);
        }
        throw error;
      }
      const view = await publish('pending', '请用微信扫描二维码');
      wake();
      return view;
    });
    enso.renderer.handle('verify', async (args) => {
      if (!login) throw new Error('当前没有在扫码');
      const code = String(args?.code ?? '').replace(/\s+/g, '');
      if (!/^\d{1,12}$/.test(code)) throw new Error('请输入手机上的数字');
      login.verifyCode = code;
      login.needVerify = true;
      wake();
      return snapshot();
    });
    enso.renderer.handle('logout', async () => {
      epoch += 1;
      login = null;
      clearSession();
      await save();
      const view = await publish('unconfigured', '已退出');
      wake();
      return view;
    });

    await load();
    self.unregister = await enso.contact.register(CHANNEL, {
      caps: {
        buttons: false,
        urlButtons: false,
        edit: false,
        typing: true,
        format: 'plain',
        maxChars: 2000,
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
      return { tick };
    }
    if (loggedIn()) await publish('connected', '已连接');
    else await publish('unconfigured', '');
    startLoop();
    return { tick };
  } catch (error) {
    if (current === self) deactivate();
    throw error;
  }
}
