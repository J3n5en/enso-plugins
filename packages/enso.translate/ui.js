const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;
const LATIN_LANGS = new Set(['英文', '法文', '德文', '西班牙文']);

function scriptOf(ch) {
  if (HAN.test(ch)) return 'han';
  if (KANA.test(ch)) return 'kana';
  if (HANGUL.test(ch)) return 'hangul';
  if (CYRILLIC.test(ch)) return 'cyrillic';
  if (LATIN.test(ch)) return 'latin';
  return /\p{L}/u.test(ch) ? 'other' : null;
}

/** 拉丁、西里尔字母按词计，其余按字计，免得中文句里夹几个英文词就被判成外文。 */
export function isTargetLanguage(text, target) {
  const n = { han: 0, kana: 0, hangul: 0, cyrillic: 0, latin: 0, other: 0 };
  let total = 0;
  let prev = null;
  for (const ch of String(text ?? '')) {
    const script = scriptOf(ch);
    if (script && !(script === prev && (script === 'latin' || script === 'cyrillic'))) {
      n[script] += 1;
      total += 1;
    }
    prev = script;
  }
  if (total === 0) return false;
  if (target === '中文') return n.han / total >= 0.5 && n.kana === 0;
  if (target === '日文') return n.kana > 0;
  if (target === '韩文') return n.hangul / total >= 0.5;
  if (target === '俄文') return n.cyrillic / total >= 0.5;
  if (LATIN_LANGS.has(target)) return n.latin / total >= 0.5;
  return false;
}

function isFenceOpen(line) {
  return /^```/.test(line.trimStart());
}

function isFenceClose(line) {
  return /^```+\s*$/.test(line.trim());
}

export function segment(text, streaming, targetLanguage = '中文') {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const blocks = [];
  let buf = [];
  let inCode = false;

  const flush = (kind) => {
    const source = kind === 'code' ? buf.join('\n').trimEnd() : buf.join('\n').trim();
    buf = [];
    if (!source) return;
    blocks.push({
      source,
      kind: kind === 'code' ? 'code' : prepareSource(source, targetLanguage) ? 'prose' : 'skip',
    });
  };

  for (const line of lines) {
    if (inCode) {
      buf.push(line);
      if (isFenceClose(line)) {
        inCode = false;
        flush('code');
      }
      continue;
    }
    if (isFenceOpen(line)) {
      flush('prose');
      inCode = true;
      buf.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush('prose');
      continue;
    }
    buf.push(line);
  }
  flush(inCode ? 'code' : 'prose');

  const last = blocks.length - 1;
  return blocks.map((block, index) => ({ ...block, final: index < last || !streaming }));
}

export function createQueue(limit) {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (active < limit && pending.length > 0) {
      const item = pending.shift();
      active += 1;
      Promise.resolve()
        .then(item.job)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  return (job) =>
    new Promise((resolve, reject) => {
      pending.push({ job, resolve, reject });
      drain();
    });
}

function matchInlineCode(src, i) {
  if (src[i] !== '`') return null;
  let n = 0;
  while (src[i + n] === '`') n += 1;
  let j = i + n;
  while (j < src.length) {
    if (src[j] !== '`') {
      j += 1;
      continue;
    }
    let k = j;
    while (src[k] === '`') k += 1;
    if (k - j === n) return { start: i, end: k };
    j = k;
  }
  return null;
}

function findClose(src, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function matchLink(src, i) {
  const start = i;
  if (src[i] === '!') {
    if (src[i + 1] !== '[') return null;
    i += 1;
  }
  if (src[i] !== '[') return null;
  const bracket = findClose(src, i, '[', ']');
  if (bracket == null || src[bracket + 1] !== '(') return null;
  const paren = findClose(src, bracket + 1, '(', ')');
  if (paren == null) return null;
  return { start, end: paren + 1 };
}

function matchAutolink(src, i) {
  if (src[i] !== '<') return null;
  const matched = /^<https?:\/\/[^\s<>]+>/i.exec(src.slice(i));
  if (!matched) return null;
  return { start: i, end: i + matched[0].length };
}

function matchHtml(src, i) {
  if (src[i] !== '<') return null;
  let j = i + 1;
  if (src[j] === '/') j += 1;
  if (!/[A-Za-z]/.test(src[j] || '')) return null;
  while (j < src.length && /[A-Za-z0-9:-]/.test(src[j])) j += 1;
  let quote = '';
  for (; j < src.length; j += 1) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return { start: i, end: j + 1 };
    if (ch === '<') return null;
  }
  return null;
}

function matchMath(src, i) {
  if (src[i] !== '$' || src[i + 1] === '$') return null;
  if (i > 0 && src[i - 1] === '\\') return null;
  if (src[i + 1] == null || /\s/u.test(src[i + 1])) return null;
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\n') return null;
    if (src[j] === '\\') {
      j += 1;
      continue;
    }
    if (src[j] === '$') {
      if (j === i + 1 || /\s/u.test(src[j - 1])) return null;
      return { start: i, end: j + 1 };
    }
  }
  return null;
}

function matchUrl(src, i) {
  const matched = /^https?:\/\/[^\s<>\]]+/i.exec(src.slice(i));
  if (!matched) return null;
  let end = matched[0].length;
  const raw = matched[0];
  while (end > 0 && /[.,;:!?，。、；：！？]/.test(raw[end - 1])) end -= 1;
  while (end > 0 && /[)）\]】]/.test(raw[end - 1])) {
    const slice = raw.slice(0, end);
    const opens = (slice.match(/[(（\[【]/g) ?? []).length;
    const closes = (slice.match(/[)）\]】]/g) ?? []).length;
    if (closes > opens) end -= 1;
    else break;
  }
  if (end <= 'https://'.length) return null;
  return { start: i, end: i + end };
}

function atTokenStart(src, i) {
  if (i === 0) return true;
  return /[\s([{"'“‘「『（【]/.test(src[i - 1]);
}

function isPath(token) {
  if (/^(?:\.\/|\.\.\/|~\/|\/)/.test(token) || /^[A-Za-z]:[\\/]/.test(token)) return true;
  if (!token.includes('/') && !token.includes('\\')) return false;
  const last = token.split(/[/\\]/).pop() ?? '';
  return /\.[A-Za-z0-9]{1,16}$/.test(last);
}

function matchPath(src, i) {
  if (!atTokenStart(src, i) || /\s/u.test(src[i])) return null;
  let end = i;
  while (end < src.length && !/\s/u.test(src[end])) end += 1;
  while (end > i && /[.,;:!?，。、；：！？)）\]】}"'”’]/.test(src[end - 1])) end -= 1;
  if (end === i || !isPath(src.slice(i, end))) return null;
  return { start: i, end };
}

function matchPlaceholder(src, i) {
  if (src[i] !== '⟦') return null;
  const matched = /^⟦\d+⟧/.exec(src.slice(i));
  if (!matched) return null;
  return { start: i, end: i + matched[0].length };
}

function matchAt(src, i) {
  return (
    matchPlaceholder(src, i) ||
    matchInlineCode(src, i) ||
    matchLink(src, i) ||
    matchAutolink(src, i) ||
    matchHtml(src, i) ||
    matchMath(src, i) ||
    matchUrl(src, i) ||
    matchPath(src, i)
  );
}

export function protect(text) {
  const src = String(text ?? '');
  const slots = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const span = matchAt(src, i);
    if (span && span.end > i) {
      slots.push(src.slice(i, span.end));
      out += `⟦${slots.length - 1}⟧`;
      i = span.end;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return { text: out, slots };
}

export function restore(translated, slots) {
  const text = String(translated ?? '');
  const ids = [];
  for (const matched of text.matchAll(/⟦(\d+)⟧/g)) ids.push(Number(matched[1]));
  const stripped = text.replace(/⟦\d+⟧/g, '');
  if (stripped.includes('⟦') || stripped.includes('⟧')) return null;
  const expected = slots?.length ?? 0;
  if (ids.length !== expected) return null;
  const seen = new Set(ids);
  if (seen.size !== expected) return null;
  for (let i = 0; i < expected; i += 1) if (!seen.has(i)) return null;
  return text.replace(/⟦(\d+)⟧/g, (_all, n) => slots[Number(n)]);
}

function isStructuralOnly(text) {
  const rest = String(text ?? '').replace(/⟦\d+⟧/g, '');
  return rest.trim() === '' || !/[^\s\p{P}\p{S}]/u.test(rest);
}

export function prepareSource(source, targetLanguage) {
  const raw = String(source ?? '');
  if (raw.trim() === '') return null;
  const guarded = protect(raw);
  if (isStructuralOnly(guarded.text)) return null;
  if (isTargetLanguage(guarded.text.replace(/⟦\d+⟧/g, ''), targetLanguage)) return null;
  return guarded;
}

export function leafPlan({ final, bodyMode, shown, source, targetLanguage }) {
  if (!final || bodyMode === '关闭' || !shown) return null;
  return prepareSource(source, targetLanguage);
}

/** 与思考分段相同：没有任何可译正文时不显示翻译按钮。缺正文时保持原样。 */
export function hasTranslatable(text, targetLanguage) {
  if (typeof text !== 'string') return true;
  return segment(text, false, targetLanguage).some((block) => block.kind === 'prose');
}

export function translationKey(model, target, text) {
  return `${model}\0${target}\0${text}`;
}

export function isUnchanged(source, translated) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return norm(source) === norm(translated);
}

export function createMessageVisibility() {
  const overrides = new Map();
  const listeners = new Map();
  const keyOf = (sessionId, messageIndex) => `${sessionId}:${messageIndex}`;
  function shown(sessionId, messageIndex, bodyMode) {
    if (bodyMode === '关闭') return false;
    const key = keyOf(sessionId, messageIndex);
    if (overrides.has(key)) return overrides.get(key);
    return bodyMode === '自动';
  }
  return {
    key: keyOf,
    shown,
    label(sessionId, messageIndex, bodyMode) {
      return shown(sessionId, messageIndex, bodyMode) ? '显示原文' : '翻译';
    },
    toggle(sessionId, messageIndex, bodyMode) {
      if (bodyMode === '关闭') return false;
      const key = keyOf(sessionId, messageIndex);
      const next = !shown(sessionId, messageIndex, bodyMode);
      overrides.set(key, next);
      for (const fn of listeners.get(key) ?? []) fn(next);
      return next;
    },
    subscribe(sessionId, messageIndex, fn) {
      const key = keyOf(sessionId, messageIndex);
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}

const visibility = createMessageVisibility();
const cache = new Map();
const listeners = new Map();
const queue = createQueue(3);
let settingsCache = null;
let settingsAt = 0;
let settingsFlight = null;
const settingsListeners = new Set();
const SETTINGS_TTL = 5000;
const DEFAULT_SETTINGS = {
  thinking: true,
  bodyMode: '手动',
  targetLanguage: '中文',
  model: 'Index-Translate-35B-A3B',
};
const BODY_MODES = ['关闭', '手动', '自动'];
const LANGUAGES = ['中文', '英文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文'];
const MODELS = ['Index-Translate-35B-A3B', 'Index-Translate-9B', 'Index-Translate-2B'];

function coerceSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    thinking: typeof source.thinking === 'boolean' ? source.thinking : DEFAULT_SETTINGS.thinking,
    bodyMode: BODY_MODES.includes(source.bodyMode) ? source.bodyMode : DEFAULT_SETTINGS.bodyMode,
    targetLanguage: LANGUAGES.includes(source.targetLanguage) ? source.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    model: MODELS.includes(source.model) ? source.model : DEFAULT_SETTINGS.model,
  };
}

function publishSettings(value) {
  settingsCache = value;
  settingsAt = Date.now();
  for (const fn of settingsListeners) fn(value);
}

function ensureSettings(dispatch) {
  if (settingsCache && Date.now() - settingsAt < SETTINGS_TTL) return Promise.resolve(settingsCache);
  if (!settingsFlight) {
    settingsFlight = Promise.resolve()
      .then(() => dispatch('plugin.call', { method: 'settings', args: {} }))
      .then((res) => {
        const next = coerceSettings(res);
        publishSettings(next);
        return next;
      })
      .catch(() => {
        const next = settingsCache ?? DEFAULT_SETTINGS;
        publishSettings(next);
        return next;
      })
      .finally(() => {
        settingsFlight = null;
      });
  }
  return settingsFlight;
}

function subscribe(key, fn) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}

function publish(key) {
  const entry = cache.get(key) ?? null;
  for (const fn of listeners.get(key) ?? []) fn(entry);
}

function load(key, text, target, dispatch) {
  if (cache.has(key)) return;
  cache.set(key, { status: 'pending' });
  publish(key);
  queue(() =>
    dispatch('plugin.call', { method: 'translate', args: { text, target } })
      .then((res) => {
        const translated = res && typeof res.text === 'string' ? res.text.trim() : '';
        if (!translated) throw new Error('翻译结果为空');
        cache.set(key, { status: 'done', text: translated });
      })
      .catch(() => {
        cache.set(key, { status: 'error' });
      })
      .finally(() => publish(key)),
  );
}

const blockStyle = { marginBottom: 8 };
const translatedStyle = {
  color: 'var(--foreground)',
  borderLeft: '2px solid var(--border)',
  display: 'block',
  marginTop: 4,
  paddingLeft: 8,
  maxWidth: '100%',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
};
const pendingStyle = {
  color: 'var(--muted-foreground)',
  display: 'block',
  opacity: 0.6,
  marginTop: 4,
  paddingLeft: 8,
};
const retryStyle = {
  background: 'transparent',
  border: 'none',
  padding: '4px 0 0 8px',
  margin: 0,
  color: 'var(--muted-foreground)',
  cursor: 'pointer',
  font: 'inherit',
  textDecoration: 'underline',
};
const actionStyle = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  lineHeight: 'inherit',
};
const plainStyle = { whiteSpace: 'pre-wrap' };

export function onLoad(enso) {
  const { createElement: h, useEffect, useState } = enso.React;

  function useSettings() {
    const [value, setValue] = useState(settingsCache);
    useEffect(() => {
      let alive = true;
      const onValue = (next) => {
        if (alive) setValue(next);
      };
      settingsListeners.add(onValue);
      ensureSettings(enso.dispatch).then(onValue);
      return () => {
        alive = false;
        settingsListeners.delete(onValue);
      };
    }, []);
    return value;
  }

  function useShown(sessionId, messageIndex, bodyMode) {
    const [, bump] = useState(0);
    useEffect(() => {
      if (!bodyMode || bodyMode === '关闭') return undefined;
      return visibility.subscribe(sessionId, messageIndex, () => bump((n) => n + 1));
    }, [sessionId, messageIndex, bodyMode]);
    if (!bodyMode || bodyMode === '关闭') return false;
    return visibility.shown(sessionId, messageIndex, bodyMode);
  }

  function Translation({ cacheText, slots, model, target, Markdown }) {
    const key = translationKey(model, target, cacheText);
    const [entry, setEntry] = useState(null);
    useEffect(() => {
      const unsub = subscribe(key, setEntry);
      if (cache.has(key)) setEntry(cache.get(key));
      else load(key, cacheText, target, enso.dispatch);
      return unsub;
    }, [key, cacheText, target]);

    if (entry?.status === 'done') {
      if (isUnchanged(cacheText, entry.text)) return null;
      const restored = slots ? restore(entry.text, slots) : entry.text;
      if (restored == null) {
        if (!entry.warned) {
          entry.warned = true;
          console.warn('[enso.translate] 占位符校验失败，已隐藏译文');
        }
        return null;
      }
      const body = Markdown ? h(Markdown, { text: restored }) : restored;
      return h('div', { style: translatedStyle }, body);
    }
    if (entry?.status === 'error') {
      return h(
        'button',
        {
          type: 'button',
          style: retryStyle,
          onClick: () => {
            cache.delete(key);
            load(key, cacheText, target, enso.dispatch);
          },
        },
        '重试',
      );
    }
    if (entry?.status === 'pending') return h('div', { style: pendingStyle }, '翻译中…');
    return null;
  }

  function Block({ source, kind, final, model, target }) {
    const show = kind === 'prose' && final;
    return h(
      'div',
      { style: blockStyle },
      h('div', null, source),
      show ? h(Translation, { cacheText: source, model, target }) : null,
    );
  }

  function ThinkingBody({ text, streaming, itemKey }) {
    const settings = useSettings();
    const raw = String(text ?? '');
    if (!settings || !settings.thinking) return h('div', { style: plainStyle }, raw);
    const parts = segment(raw, streaming, settings.targetLanguage);
    if (parts.length === 0) return null;
    return h(
      'div',
      null,
      parts.map((part, index) =>
        h(Block, {
          key: `${itemKey}:${index}`,
          source: part.source,
          kind: part.kind,
          final: part.final,
          model: settings.model,
          target: settings.targetLanguage,
        }),
      ),
    );
  }

  function Leaf({ source, final, messageIndex, sessionId, Markdown }) {
    const settings = useSettings();
    const shown = useShown(sessionId, messageIndex, settings?.bodyMode);
    if (!final || !settings) return null;
    const plan = leafPlan({
      final,
      bodyMode: settings.bodyMode,
      shown,
      source,
      targetLanguage: settings.targetLanguage,
    });
    if (!plan) return null;
    return h(Translation, {
      cacheText: plan.text,
      slots: plan.slots,
      model: settings.model,
      target: settings.targetLanguage,
      Markdown,
    });
  }

  function Action({ messageIndex, sessionId, text }) {
    const settings = useSettings();
    const shown = useShown(sessionId, messageIndex, settings?.bodyMode);
    if (!settings || settings.bodyMode === '关闭') return null;
    if (!hasTranslatable(text, settings.targetLanguage)) return null;
    const label = shown ? '显示原文' : '翻译';
    return h(
      'button',
      {
        type: 'button',
        style: actionStyle,
        title: label,
        onClick: () => visibility.toggle(sessionId, messageIndex, settings.bodyMode),
      },
      label,
    );
  }

  enso.slots.register({ slot: 'thinking.body', component: ThinkingBody });
  try {
    enso.slots.register({ slot: 'message.leaf', component: Leaf });
  } catch (error) {
    console.warn('[enso.translate] 当前宿主没有 message.leaf', error);
    return;
  }
  enso.slots.register({ slot: 'message.action', position: 'left', component: Action });
}
