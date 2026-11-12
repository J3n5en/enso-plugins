/** 把 Enso 的 pi session v3 jsonl 收成轨迹。只走当前叶子的 parentId 链，放弃的分叉不出现。 */

const TEXT_CAP = 12_000;
const PREVIEW = 160;
const DURATION_CAP = 6 * 60 * 60 * 1000;
const PLUGIN_MESSAGE = 'enso-plugin-message';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pos = (v) => {
  const n = num(v);
  return n > 0 && n <= DURATION_CAP ? n : null;
};

export function clip(value, max = TEXT_CAP) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断）`;
}

export function preview(value, max = PREVIEW) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** 展示用正文去掉系统提醒，详情里仍保留原文 */
export function visibleText(value) {
  return String(value ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<background-task-update>[\s\S]*?<\/background-task-update>/g, '')
    .trim();
}

export function cacheRatio(usage) {
  if (!usage) return null;
  const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
  if (prompt <= 0) return null;
  return num(usage.cacheRead) / prompt;
}

function usageOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheWrite: num(raw.cacheWrite),
  };
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return null;
  return usage;
}

function timeOf(entry, message) {
  if (message && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof entry?.timestamp === 'number' && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry?.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function partsOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && typeof part === 'object');
}

function textFrom(content) {
  return partsOf(content)
    .filter((part) => part.type === 'text' || (part.type == null && typeof part.text === 'string'))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function thinkingFrom(content) {
  return partsOf(content)
    .filter((part) => part.type === 'thinking')
    .map((part) => (typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function imageCount(content) {
  return partsOf(content).filter((part) => part.type === 'image').length;
}

function argsOf(part) {
  let args = part?.arguments ?? part?.args ?? part?.input;
  if (typeof args === 'string') {
    const raw = args;
    try {
      args = JSON.parse(raw);
    } catch {
      return { command: raw };
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

export function summarizeCall(name, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const str = (key) => (typeof a[key] === 'string' ? a[key].trim() : '');
  if (name === 'bash' || name === 'powershell') return str('command') || str('cmd');
  if (name === 'grep' || name === 'find' || name === 'glob' || name === 'web_search') {
    return str('pattern') || str('query') || str('path') || str('glob');
  }
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'ls' || name === 'apply_patch') {
    return str('path') || str('file_path') || str('file') || str('command');
  }
  if (name === 'subagent') {
    const op = str('operation') || 'spawn';
    const label = str('description') || str('name') || str('prompt');
    return [op, label].filter(Boolean).join(' · ');
  }
  const bits = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description']
    .map(str)
    .filter(Boolean);
  if (bits.length) return bits[0];
  try {
    const raw = JSON.stringify(a);
    return raw && raw !== '{}' ? raw : '';
  } catch {
    return '';
  }
}

export function subagentFields(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const str = (key) => (typeof a[key] === 'string' ? a[key].trim() : '');
  return {
    operation: str('operation') || 'spawn',
    name: str('name'),
    description: str('description'),
    prompt: str('prompt'),
    agentType: str('agent_type') || str('agentType'),
  };
}

function jsonOf(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function promptPreview(text, images) {
  const shown = visibleText(text);
  if (shown) return preview(shown);
  if (images > 0) return images > 1 ? `图片 × ${images}` : '图片';
  if (String(text ?? '').trim()) return '系统提醒';
  return '（空）';
}

/** 最后一条带 id 的记录是当前叶子，沿 parentId 走回会话头 */
export function activeBranch(entries) {
  const byId = new Map();
  let leaf = null;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  const chain = [];
  const seen = new Set();
  let cursor = leaf;
  while (cursor && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    const parent = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) : null;
    cursor = parent ?? null;
  }
  chain.reverse();
  const broken = Boolean(leaf && chain.length && chain[0].parentId && !seen.has(chain[0].parentId) && chain[0].parentId !== null);
  return { chain, broken };
}

function readEntries(text) {
  const entries = [];
  let header = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.type === 'session') {
      header = {
        sessionId: typeof entry.id === 'string' ? entry.id : header?.sessionId ?? '',
        cwd: typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : header?.cwd ?? '',
        version: typeof entry.version === 'number' ? entry.version : header?.version ?? null,
      };
      continue;
    }
    entries.push(entry);
  }
  return { entries, header };
}

function messageOf(entry) {
  if (entry.type === 'message' && entry.message && typeof entry.message === 'object') return entry.message;
  if (entry.type === 'custom_message' || (entry.type === 'custom' && entry.customType === PLUGIN_MESSAGE)) {
    return {
      role: 'custom',
      customType: entry.customType,
      content: entry.content,
      details: entry.details,
      timestamp: entry.timestamp,
    };
  }
  return null;
}

function stopLabel(reason) {
  if (reason === 'stop') return '完成';
  if (reason === 'toolUse' || reason === 'tool_use') return '调用工具';
  if (reason === 'length') return '长度上限';
  if (reason === 'error') return '出错';
  if (reason === 'aborted') return '已中止';
  return typeof reason === 'string' ? reason : '';
}

export function statsOf(turns) {
  const stats = {
    turns: 0,
    requests: 0,
    tools: 0,
    agents: 0,
    cacheHit: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    activeMs: 0,
  };
  for (const turn of turns) {
    stats.turns += 1;
    if (pos(turn.ms)) stats.activeMs += turn.ms;
    for (const item of turn.items) {
      if (item.kind === 'model') {
        stats.requests += 1;
        if (item.tokens) {
          stats.input += item.tokens.input;
          stats.output += item.tokens.output;
          stats.cacheRead += item.tokens.cacheRead;
          stats.cacheWrite += item.tokens.cacheWrite;
        }
      } else if (item.kind === 'agent') stats.agents += 1;
      else if (item.kind === 'tool') stats.tools += 1;
    }
  }
  const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
  stats.cacheHit = prompt > 0 ? stats.cacheRead / prompt : null;
  return stats;
}

export function lanesOf(turns) {
  const segs = { input: [], model: [], tools: [] };
  let start = null;
  let end = null;
  const touch = (at, ms) => {
    if (at == null) return;
    const from = ms ? at - ms : at;
    start = start == null ? from : Math.min(start, from);
    end = end == null ? at : Math.max(end, at);
  };
  for (const turn of turns) {
    touch(turn.at, 0);
    if (turn.at != null) segs.input.push({ t: turn.at, d: 0 });
    for (const item of turn.items) {
      touch(item.at, item.ms || 0);
      if (item.at == null) continue;
      if (item.kind === 'model') segs.model.push({ t: item.at, d: item.ms || 0 });
      else if (item.kind === 'tool' || item.kind === 'agent') segs.tools.push({ t: item.at, d: item.ms || 0, agent: item.kind === 'agent' });
    }
  }
  return { start, end, ...segs };
}

function closeTurn(turn) {
  if (!turn) return;
  let end = turn.at;
  for (const item of turn.items) if (item.at != null) end = end == null ? item.at : Math.max(end, item.at);
  turn.ms = turn.at != null && end != null && end > turn.at ? Math.min(end - turn.at, DURATION_CAP) : null;
}

function ensureTurn(turns, at) {
  let turn = turns.at(-1);
  if (turn) return turn;
  turn = {
    id: `t:anon:${turns.length}`,
    at,
    who: '用户',
    raw: '',
    preview: '（续）',
    ms: null,
    items: [],
  };
  turns.push(turn);
  return turn;
}

/**
 * @param {string} text jsonl 原文
 * @param {{ truncated?: boolean }} [opts] 调用方只读了文件尾部时设 truncated
 */
export function parseSessionText(text, opts = {}) {
  const { entries, header } = readEntries(text);
  const { chain, broken } = activeBranch(entries);
  const turns = [];
  const details = {};
  const pending = new Map();
  let model = '';

  const addDetail = (id, detail) => {
    details[id] = detail;
  };

  for (const entry of chain) {
    if (entry.type === 'compaction') {
      const at = timeOf(entry, null);
      const summary = clip(typeof entry.summary === 'string' ? entry.summary : '');
      const id = `k:${entry.id}`;
      const turn = ensureTurn(turns, at);
      const tokensBefore = num(entry.tokensBefore);
      turn.items.push({
        id,
        kind: 'compact',
        at,
        ms: null,
        title: '上下文压缩',
        preview: preview(summary || (tokensBefore ? `压缩前 ${tokensBefore} tokens` : '会话被压缩')),
        pending: false,
        error: false,
      });
      addDetail(id, {
        title: '上下文压缩',
        text: summary,
        input: '',
        output: '',
        thinking: '',
        error: '',
        extra: tokensBefore ? `压缩前 ${tokensBefore} tokens` : '',
      });
      continue;
    }

    const message = messageOf(entry);
    if (!message) continue;
    const at = timeOf(entry, message);
    const role = message.role;

    if (role === 'user' || role === 'custom') {
      closeTurn(turns.at(-1));
      const raw = clip(textFrom(message.content) || (typeof message.content === 'string' ? message.content : ''));
      const images = imageCount(message.content);
      const plugin = role === 'custom' || message.customType === PLUGIN_MESSAGE;
      const pluginName =
        message.details && typeof message.details.pluginName === 'string' ? message.details.pluginName : '';
      const id = `t:${entry.id}`;
      const turn = {
        id,
        at,
        who: plugin ? pluginName || '插件' : '用户',
        raw,
        preview: promptPreview(raw, images),
        ms: null,
        items: [],
      };
      turns.push(turn);
      addDetail(id, {
        title: turn.who,
        text: raw,
        input: '',
        output: '',
        thinking: '',
        error: '',
        extra: images ? `图片 ${images} 张` : '',
      });
      continue;
    }

    if (role === 'assistant') {
      const turn = ensureTurn(turns, at);
      if (typeof message.model === 'string' && message.model) model = message.model;
      const text = clip(textFrom(message.content));
      const thinking = clip(thinkingFrom(message.content));
      const tokens = usageOf(message.usage);
      let prevAt = turn.at;
      for (const item of turn.items) if (item.at != null) prevAt = item.at;
      const ms = pos(message.duration) ?? (prevAt != null && at != null && at > prevAt ? pos(at - prevAt) : null);
      const ttft = pos(message.ttft);
      const error = clip(typeof message.errorMessage === 'string' ? message.errorMessage : '');
      const id = `m:${entry.id}`;
      const stop = stopLabel(message.stopReason);
      const title = model || '模型';
      const shown = visibleText(text);
      turn.items.push({
        id,
        kind: 'model',
        at,
        ms,
        ttft,
        title,
        preview: preview(shown || error || (stop ? `停止：${stop}` : '模型请求')),
        pending: false,
        error: Boolean(error) || message.stopReason === 'error',
        model: model || '',
        stop,
        tokens,
        cacheHit: cacheRatio(tokens),
      });
      const tokenLine = tokens
        ? `输入 ${tokens.input} · 输出 ${tokens.output} · 缓存读 ${tokens.cacheRead} · 缓存写 ${tokens.cacheWrite}`
        : '';
      addDetail(id, { title, text, input: '', output: '', thinking, error, extra: [stop, tokenLine].filter(Boolean).join(' · ') });
      const calls = partsOf(message.content).filter((part) => part.type === 'toolCall');
      calls.forEach((part, index) => {
        const name = typeof part.name === 'string' && part.name ? part.name.slice(0, 80) : 'tool';
        const callId = typeof part.id === 'string' && part.id ? part.id : `${entry.id}:${index}`;
        const args = argsOf(part);
        const agent = name === 'subagent';
        const fields = agent ? subagentFields(args) : null;
        const summary = summarizeCall(name, args);
        const itemId = `c:${callId}`;
        const item = {
          id: itemId,
          kind: agent ? 'agent' : 'tool',
          at,
          ms: null,
          title: agent ? '子代理' : name,
          preview: preview(summary || (agent ? '子代理' : name)),
          pending: true,
          error: false,
          name,
          toolCallId: callId,
          ...(fields ? { agent: fields } : {}),
        };
        turn.items.push(item);
        pending.set(callId, item);
        addDetail(itemId, {
          title: item.title,
          text: '',
          input: clip(name === 'subagent' ? jsonOf(args) || summary : summary || jsonOf(args)),
          output: '',
          thinking: '',
          error: '',
          extra: fields ? [fields.operation, fields.agentType, fields.description].filter(Boolean).join(' · ') : name,
        });
      });
      continue;
    }

    if (role === 'toolResult') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      const name = typeof message.toolName === 'string' ? message.toolName : '';
      const output = clip(textFrom(message.content));
      const isError = message.isError === true;
      const ms = pos(message.toolDurationMs);
      let item = callId ? pending.get(callId) : null;
      const turn = item ? turns.find((candidate) => candidate.items.includes(item)) : ensureTurn(turns, at);
      if (!item) {
        const itemId = `c:${callId || entry.id}`;
        item = {
          id: itemId,
          kind: name === 'subagent' ? 'agent' : 'tool',
          at,
          ms,
          title: name === 'subagent' ? '子代理' : name || '工具',
          preview: preview(output || name || '工具结果'),
          pending: false,
          error: isError,
          name: name || 'tool',
          toolCallId: callId,
        };
        turn.items.push(item);
        addDetail(itemId, {
          title: item.title,
          text: '',
          input: '',
          output,
          thinking: '',
          error: isError ? output : '',
          extra: name,
        });
      } else {
        const issued = item.at;
        item.at = at ?? item.at;
        item.ms = ms ?? (issued != null && at != null && at >= issued ? pos(at - issued) : null);
        item.pending = false;
        item.error = isError;
        if (output) item.preview = preview(output);
        const detail = details[item.id];
        if (detail) {
          detail.output = output;
          detail.error = isError ? output || '工具失败' : '';
        }
      }
      if (callId) pending.delete(callId);
    }
  }
  closeTurn(turns.at(-1));

  return {
    sessionId: header?.sessionId ?? '',
    cwd: header?.cwd ?? '',
    version: header?.version ?? null,
    truncated: opts.truncated === true || broken,
    model,
    turns,
    details,
    stats: statsOf(turns),
    lanes: lanesOf(turns),
  };
}

function cloneTurn(turn) {
  return { ...turn, items: turn.items.map((item) => ({ ...item, ...(item.agent ? { agent: { ...item.agent } } : {}) })) };
}

function sameTurn(base, live) {
  if (!base || !live) return false;
  const left = visibleText(base.raw || '');
  const right = visibleText(live.raw || '');
  if (!left || !right || left !== right) return false;
  if (base.at == null || live.at == null) return true;
  return Math.abs(base.at - live.at) < 10_000;
}

/** 磁盘上的轨迹是准的；还没落盘的这一轮用事件补在后面 */
export function mergeLive(parsed, live) {
  const base = parsed ?? {
    sessionId: '',
    cwd: '',
    version: null,
    truncated: false,
    model: '',
    turns: [],
    details: {},
    stats: statsOf([]),
    lanes: lanesOf([]),
  };
  const turns = base.turns.map(cloneTurn);
  const details = { ...base.details };
  const liveTurns = Array.isArray(live?.turns) ? live.turns : [];
  for (const liveTurn of liveTurns) {
    const last = turns.at(-1);
    if (sameTurn(last, liveTurn)) {
      const haveTools = new Set(last.items.map((item) => item.toolCallId).filter(Boolean));
      const baseModels = last.items.filter((item) => item.kind === 'model').length;
      const liveModels = liveTurn.items.filter((item) => item.kind === 'model');
      for (const item of liveModels.slice(baseModels)) {
        last.items.push({ ...item });
        if (live.details?.[item.id]) details[item.id] = { ...live.details[item.id] };
      }
      if (liveModels.length && baseModels >= liveModels.length) {
        const target = [...last.items].reverse().find((item) => item.kind === 'model');
        const source = liveModels.at(-1);
        if (target && source?.tokens && !target.tokens) {
          target.tokens = source.tokens;
          target.cacheHit = source.cacheHit;
        }
      }
      for (const item of liveTurn.items) {
        if (item.kind !== 'tool' && item.kind !== 'agent') continue;
        if (!item.toolCallId || haveTools.has(item.toolCallId)) continue;
        last.items.push({ ...item });
        if (live.details?.[item.id]) details[item.id] = { ...live.details[item.id] };
      }
      const baseCompacts = last.items.filter((item) => item.kind === 'compact').length;
      const compacts = liveTurn.items.filter((item) => item.kind === 'compact');
      for (const item of compacts.slice(baseCompacts)) {
        last.items.push({ ...item });
        if (live.details?.[item.id]) details[item.id] = { ...live.details[item.id] };
      }
      closeTurn(last);
      continue;
    }
    const end = last ? Math.max(last.at || 0, ...last.items.map((item) => item.at || 0)) : 0;
    if (last && liveTurn.at != null && liveTurn.at + 1000 < end) continue;
    turns.push(cloneTurn(liveTurn));
    for (const [id, detail] of Object.entries(live.details ?? {})) {
      if (id === liveTurn.id || liveTurn.items.some((item) => item.id === id)) details[id] = { ...detail };
    }
  }
  return {
    ...base,
    model: live?.model || base.model,
    turns,
    details,
    stats: statsOf(turns),
    lanes: lanesOf(turns),
  };
}

export function toView(parsed, meta = {}) {
  const stats = parsed?.stats ?? statsOf([]);
  return {
    sessionId: meta.sessionId ?? '',
    title: meta.title ?? '',
    state: meta.state ?? null,
    pendingAsks: meta.pendingAsks ?? 0,
    pendingApprovals: meta.pendingApprovals ?? 0,
    model: parsed?.model || meta.model || '',
    cwd: parsed?.cwd || '',
    file: meta.file === true,
    truncated: parsed?.truncated === true,
    warning: meta.warning || '',
    context: meta.context ?? null,
    stats,
    lanes: parsed?.lanes ?? lanesOf([]),
    turns: (parsed?.turns ?? []).map((turn) => ({
      id: turn.id,
      at: turn.at,
      who: turn.who,
      preview: turn.preview,
      ms: turn.ms,
      items: turn.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        at: item.at,
        ms: item.ms,
        ttft: item.ttft ?? null,
        title: item.title,
        preview: item.preview,
        pending: item.pending === true,
        error: item.error === true,
        name: item.name || '',
        model: item.model || '',
        stop: item.stop || '',
        tokens: item.tokens ?? null,
        cacheHit: item.cacheHit ?? null,
        toolCallId: item.toolCallId || '',
        child: item.child ?? null,
      })),
    })),
    sessions: meta.sessions ?? [],
  };
}
