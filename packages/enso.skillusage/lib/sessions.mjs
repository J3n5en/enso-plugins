import { parseMcpToolName } from './names.mjs';

const READ_TOOLS = new Set(['read', 'Read']);
const PATH_KEYS = ['path', 'file_path', 'target'];
const MAX_LINE = 1_500_000;
const MAX_FALLBACK = 65_536;

/**
 * 从一条 pi session v3 jsonl 抽出调用。不保留提示词、回答或工具参数正文。
 * 技能：句首 /skill:name、<skill name>、read 到 SKILL.md。
 * MCP：工具名 mcp__<server>__<tool>。
 * 子代理：subagent 且 operation 为 spawn（缺省也视为 spawn）。
 */
export function scanSessionText(text) {
  const scanner = createScanner();
  for (const line of String(text || '').split('\n')) scanner.push(line);
  return scanner.finish();
}

export function createScanner() {
  const state = {
    sessionId: '',
    cwd: '',
    model: '',
    provider: '',
    ts: null,
    pending: [],
  };
  const events = [];
  const sessions = [];
  let sawSession = false;

  const rememberSession = () => {
    if (!state.sessionId && !state.cwd) return;
    const known = sessions.find((item) => item.id === state.sessionId && item.cwd === state.cwd);
    if (known) {
      if (state.ts != null && (known.ts == null || state.ts > known.ts)) known.ts = state.ts;
      return;
    }
    sessions.push({ id: state.sessionId, cwd: state.cwd, ts: state.ts });
    sawSession = true;
  };

  return {
    push(line) {
      if (!line || !line.trim()) return;
      const interesting =
        line.includes('"session"') ||
        line.includes('skill') ||
        line.includes('mcp__') ||
        line.includes('subagent') ||
        line.includes('toolCall') ||
        line.includes('"read"') ||
        line.includes('"Read"') ||
        line.includes('"model"');
      if (!interesting) return;
      if (line.length > MAX_LINE) {
        consumeFallback(line.slice(0, MAX_FALLBACK), state, events, rememberSession);
        return;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        consumeFallback(line.slice(0, MAX_FALLBACK), state, events, rememberSession);
        return;
      }
      consumeEntry(entry, state, events, rememberSession);
    },
    finish() {
      flushPending(state, events, state.model, state.provider);
      if (sawSession || state.sessionId || state.cwd) rememberSession();
      return { events, sessions };
    },
  };
}

function consumeEntry(entry, state, events, rememberSession) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.type === 'session') {
    flushPending(state, events, state.model, state.provider);
    if (typeof entry.id === 'string' && entry.id) state.sessionId = entry.id;
    if (typeof entry.cwd === 'string' && entry.cwd) state.cwd = entry.cwd;
    const ts = timestampOf(entry, null);
    if (ts != null) state.ts = ts;
    rememberSession();
    return;
  }
  if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') return;
  const message = entry.message;
  const ts = timestampOf(entry, message);
  if (ts != null) state.ts = ts;
  if (message.role === 'assistant') {
    if (typeof message.model === 'string' && message.model) state.model = message.model;
    if (typeof message.provider === 'string' && message.provider) state.provider = message.provider;
    flushPending(state, events, state.model, state.provider);
    for (const part of partsOf(message.content)) {
      if (!part || part.type !== 'toolCall' || typeof part.name !== 'string') continue;
      const call = toolCall(part.name, argsOf(part));
      if (call) events.push(eventOf(call, state, ts));
    }
    return;
  }
  if (message.role === 'user') {
    const text = textOfContent(message.content);
    if (!text) return;
    for (const name of skillNamesInUserText(text)) {
      state.pending.push(eventOf({ kind: 'skill', name, via: 'user' }, state, ts));
    }
  }
}

function consumeFallback(slice, state, events, rememberSession) {
  if (slice.includes('"type":"session"') || slice.includes('"type": "session"')) {
    const id = /"id"\s*:\s*"([^"\\]+)"/.exec(slice);
    const cwd = /"cwd"\s*:\s*"([^"\\]*)"/.exec(slice);
    if (id) state.sessionId = id[1];
    if (cwd) state.cwd = cwd[1];
    rememberSession();
  }
  const model = /"model"\s*:\s*"([^"\\]+)"/.exec(slice);
  if (model && slice.includes('assistant')) state.model = model[1];
  const ts = Date.parse((/"timestamp"\s*:\s*"([^"]+)"/.exec(slice) || [])[1] || '');
  const when = Number.isFinite(ts) ? ts : state.ts;
  if (slice.includes('"role":"user"') || slice.includes('"role": "user"')) {
    for (const name of skillNamesInUserText(slice)) {
      state.pending.push(eventOf({ kind: 'skill', name, via: 'user' }, state, when));
    }
  }
  for (const match of slice.matchAll(/"name"\s*:\s*"(mcp__[^"\\]+|subagent|read|Read)"/g)) {
    if (match[1] === 'subagent') {
      const nearby = slice.slice(match.index, match.index + 800);
      if (/"operation"\s*:\s*"(?!spawn")[^"]+"/.test(nearby)) continue;
      const agent = /"agent_type"\s*:\s*"([^"\\]+)"/.exec(nearby);
      events.push(eventOf({ kind: 'agent', name: agent ? agent[1] : 'general', via: 'spawn' }, state, when));
      continue;
    }
    if (match[1] === 'read' || match[1] === 'Read') {
      const nearby = slice.slice(match.index, match.index + 800);
      const path = /"(?:path|file_path|target)"\s*:\s*"([^"\\]+)"/.exec(nearby);
      if (!path || !isSkillFile(path[1])) continue;
      events.push(eventOf({ kind: 'skill-read', path: path[1], via: 'read' }, state, when));
      continue;
    }
    const parsed = parseMcpToolName(match[1]);
    if (!parsed) continue;
    events.push(
      eventOf({ kind: 'mcp', name: parsed.namespace, tool: parsed.tool, via: 'tool' }, state, when),
    );
  }
}

function flushPending(state, events, model, provider) {
  for (const pending of state.pending) {
    pending.model = model || '';
    pending.provider = provider || '';
    events.push(pending);
  }
  state.pending = [];
}

function eventOf(call, state, ts) {
  return {
    ...call,
    ts: ts ?? null,
    model: state.model || '',
    provider: state.provider || '',
    sessionId: state.sessionId || '',
    cwd: state.cwd || '',
  };
}

function toolCall(name, args) {
  if (READ_TOOLS.has(name)) {
    const path = pathOf(args);
    if (!path || !isSkillFile(path)) return null;
    return { kind: 'skill-read', path, via: 'read' };
  }
  const mcp = parseMcpToolName(name);
  if (mcp) return { kind: 'mcp', name: mcp.namespace, tool: mcp.tool, via: 'tool' };
  if (name !== 'subagent') return null;
  const operation = typeof args.operation === 'string' ? args.operation : 'spawn';
  if (operation !== 'spawn') return null;
  const agent = args.agent_type || args.agentType;
  return { kind: 'agent', name: typeof agent === 'string' && agent.trim() ? agent.trim() : 'general', via: 'spawn' };
}

export function skillNamesInUserText(text) {
  const names = [];
  let rest = String(text || '').trimStart();
  for (let match = /^\/skill:(\S+)(?:\s+|$)/.exec(rest); match; match = /^\/skill:(\S+)(?:\s+|$)/.exec(rest)) {
    names.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  for (const match of String(text || '').matchAll(/<skill name="([^"]+)"/g)) {
    if (match[1].trim()) names.push(match[1].trim());
  }
  return names;
}

function isSkillFile(value) {
  return /(?:^|[/\\])SKILL\.md$/i.test(String(value || ''));
}

function pathOf(args) {
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key]) return args[key];
  }
  return '';
}

function argsOf(part) {
  let args = part.arguments ?? part.input ?? part.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function partsOf(content) {
  return Array.isArray(content) ? content : [];
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part && typeof part.text === 'string') text += part.text;
  }
  return text;
}

function timestampOf(entry, message) {
  if (message && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) return entry.timestamp;
  return null;
}
