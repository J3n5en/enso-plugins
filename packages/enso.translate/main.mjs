const TRANSLATE_URL = 'https://index-translate.bilibili.com/v1/chat/completions';
const MODELS = ['Index-Translate-35B-A3B', 'Index-Translate-9B', 'Index-Translate-2B'];
const BODY_MODES = ['关闭', '手动', '自动'];
const LANGUAGES = ['中文', '英文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文'];
const RETRYABLE = new Set([429, 502, 503, 504]);
// net.fetch 不接受 signal / timeout，单次请求自己限时；总预算留在方法超时（120 秒）以内
const TIMING = { timeoutMs: 60_000, delays: [1_000, 2_000], deadlineMs: 110_000 };
const MAX_RETRY_AFTER_MS = 10_000;

export function normalizeSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    thinking: typeof source.thinking === 'boolean' ? source.thinking : true,
    bodyMode: BODY_MODES.includes(source.bodyMode) ? source.bodyMode : '手动',
    targetLanguage: LANGUAGES.includes(source.targetLanguage) ? source.targetLanguage : '中文',
    model: MODELS.includes(source.model) ? source.model : MODELS[0],
  };
}

function promptFor(language) {
  const target = LANGUAGES.includes(language) ? language : '中文';
  return `请将以下文本翻译为${target}，直接输出翻译结果，不要进行任何解释。\n\n`;
}

function requestBody(text, model, language) {
  return {
    model,
    messages: [{ role: 'user', content: `${promptFor(language)}${text}` }],
    temperature: 0,
    max_tokens: 2048,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

function stripThink(content) {
  const marker = '</think>';
  const at = content.indexOf(marker);
  return (at === -1 ? content : content.slice(at + marker.length)).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('翻译服务响应超时，请稍后再试')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function retryAfterMs(headers) {
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === 'retry-after');
  const value = key ? String(headers[key]).trim() : '';
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function statusError(status) {
  if (status === 401 || status === 403) return new Error(`API Key 无效或无权限，请检查插件设置（HTTP ${status}）`);
  if (status >= 400 && status < 500) return new Error(`翻译请求被拒绝（HTTP ${status}），可能是文本过长或格式不受支持`);
  if (status >= 500) return new Error(`翻译服务出错（HTTP ${status}），请稍后再试`);
  return new Error(`翻译失败（HTTP ${status}），服务返回了意外的响应`);
}

async function request(enso, init, { timeoutMs, delays, deadlineMs }) {
  const start = Date.now();
  const minAttemptMs = Math.min(5_000, timeoutMs);
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - start);
    const res = await withTimeout(enso.net.fetch(TRANSLATE_URL, init), Math.min(timeoutMs, remaining));
    if (res.status === 200) return res;
    if (!RETRYABLE.has(res.status)) throw statusError(res.status);
    const giveUp = () =>
      new Error(res.status === 429 ? '请求过于频繁，请稍后再试' : `翻译服务超时，已重试 ${attempt} 次，请稍后再试`);
    if (attempt >= delays.length) throw giveUp();
    const hinted = res.status === 429 ? retryAfterMs(res.headers) : null;
    if (hinted !== null && hinted > MAX_RETRY_AFTER_MS) throw giveUp();
    const wait = hinted ?? Math.round(delays[attempt] * (1 + Math.random() * 0.25));
    if (Date.now() - start + wait > deadlineMs - minAttemptMs) throw giveUp();
    await sleep(wait);
  }
}

export async function translate(enso, text, target, timing = TIMING) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('没有可翻译的文本');
  const settings = normalizeSettings(await enso.config.get());
  const language = LANGUAGES.includes(target) ? target : settings.targetLanguage;
  const res = await request(
    enso,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(text, settings.model, language)),
    },
    timing,
  );
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('翻译响应无法解析');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('翻译响应缺少内容');
  const translated = stripThink(content);
  if (!translated) throw new Error('翻译结果为空');
  return { text: translated };
}

export async function settings(enso) {
  return normalizeSettings(await enso.config.get());
}

export function activate(enso) {
  enso.renderer.handle('translate', (args) => translate(enso, args?.text, args?.target));
  enso.renderer.handle('settings', () => settings(enso));
}
