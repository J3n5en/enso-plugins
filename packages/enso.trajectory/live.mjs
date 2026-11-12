import { clip, preview, subagentFields, summarizeCall, visibleText } from './parse.mjs';

/** 进程内的进行中轮次。jsonl 还没写下这一轮时，侧栏靠这些事件补上。 */

let seq = 0;
const nextId = (prefix) => `${prefix}${++seq}`;

function blank(sessionId) {
  return {
    sessionId,
    model: '',
    state: null,
    pendingAsks: 0,
    pendingApprovals: 0,
    context: null,
    turns: [],
    details: {},
  };
}

function lastWhere(items, pred) {
  for (let i = items.length - 1; i >= 0; i -= 1) if (pred(items[i])) return items[i];
  return null;
}

function openTurn(session) {
  return session.turns.at(-1) ?? null;
}

function detail(session, id, fields) {
  session.details[id] = {
    title: fields.title || '',
    text: clip(fields.text || ''),
    input: clip(fields.input || ''),
    output: clip(fields.output || ''),
    thinking: '',
    error: clip(fields.error || ''),
    extra: fields.extra || '',
  };
}

export function createLive(now = () => Date.now()) {
  const sessions = new Map();
  const get = (sessionId) => {
    if (!sessionId) return null;
    let row = sessions.get(sessionId);
    if (!row) {
      row = blank(sessionId);
      sessions.set(sessionId, row);
    }
    return row;
  };

  const note = (event, data, ctx) => {
    if (ctx?.agent) return;
    const sessionId = event === 'session_status' ? data?.sessionId || ctx?.sessionId : ctx?.sessionId;
    if (!sessionId) return;
    const session = get(sessionId);
    const at = now();
    if (event === 'session_status' && data) {
      session.state = data.state || session.state;
      session.pendingAsks = num(data.pendingAsks);
      session.pendingApprovals = num(data.pendingApprovals);
      return;
    }
    if (event === 'model_select' && data) {
      if (typeof data.modelId === 'string' && data.modelId) session.model = data.modelId;
      return;
    }
    if (event === 'context_usage' && data) {
      const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
      session.context = {
        used: num(data.used),
        window: num(data.contextWindow),
        estimated: data.estimated === true,
        percent: typeof data.percent === 'number' ? data.percent : null,
        usage: usage
          ? {
              input: num(usage.input),
              output: num(usage.output),
              cacheRead: num(usage.cacheRead),
              cacheWrite: num(usage.cacheWrite),
            }
          : null,
      };
      const turn = openTurn(session);
      const modelItem = turn ? lastWhere(turn.items, (item) => item.kind === 'model' && item.pending) : null;
      if (modelItem && session.context.usage && !modelItem.tokens) {
        modelItem.tokens = session.context.usage;
        const prompt = modelItem.tokens.input + modelItem.tokens.cacheRead + modelItem.tokens.cacheWrite;
        modelItem.cacheHit = prompt > 0 ? modelItem.tokens.cacheRead / prompt : null;
      }
      return;
    }
    if (event === 'input') {
      const text = typeof data?.text === 'string' ? data.text : '';
      const id = nextId('live:t:');
      const who = data?.source === 'plugin' ? '插件' : '用户';
      session.turns.push({
        id,
        at,
        who,
        raw: clip(text),
        preview: preview(visibleText(text) || text || '（空）'),
        ms: null,
        items: [],
      });
      if (session.turns.length > 8) {
        session.turns.splice(0, session.turns.length - 8);
        const keep = new Set(session.turns.flatMap((turn) => [turn.id, ...turn.items.map((item) => item.id)]));
        for (const key of Object.keys(session.details)) if (!keep.has(key)) delete session.details[key];
      }
      detail(session, id, { title: who, text });
      return;
    }
    if (event === 'agent_start') {
      const turn = openTurn(session);
      if (!turn) return;
      const id = nextId('live:m:');
      turn.items.push({
        id,
        kind: 'model',
        at,
        ms: null,
        msStart: at,
        title: session.model || '模型',
        preview: '正在请求…',
        pending: true,
        error: false,
        model: session.model || '',
        tokens: null,
        cacheHit: null,
      });
      detail(session, id, { title: session.model || '模型', text: '' });
      return;
    }
    if (event === 'agent_end') {
      const turn = openTurn(session);
      if (!turn) return;
      const text = typeof data?.text === 'string' ? data.text : '';
      let item = lastWhere(turn.items, (row) => row.kind === 'model' && row.pending);
      if (!item) {
        const id = nextId('live:m:');
        item = {
          id,
          kind: 'model',
          at,
          ms: null,
          msStart: at,
          title: session.model || '模型',
          preview: '',
          pending: true,
          error: false,
          model: session.model || '',
          tokens: null,
          cacheHit: null,
        };
        turn.items.push(item);
      }
      item.pending = false;
      item.ms = item.msStart ? pos(at - item.msStart) : null;
      item.at = at;
      item.preview = preview(visibleText(text) || '模型请求');
      const existing = session.details[item.id] ?? { title: item.title, text: '', input: '', output: '', thinking: '', error: '', extra: '' };
      existing.text = clip(text);
      session.details[item.id] = existing;
      return;
    }
    if (event === 'tool_call') {
      const turn = openTurn(session);
      if (!turn || !data) return;
      const name = typeof data.toolName === 'string' ? data.toolName.slice(0, 80) : 'tool';
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : nextId('call:');
      let args = data.input;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { command: args };
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      const agent = name === 'subagent';
      const fields = agent ? subagentFields(args) : null;
      const summary = summarizeCall(name, args);
      const id = `live:c:${callId}`;
      if (turn.items.some((item) => item.toolCallId === callId)) return;
      turn.items.push({
        id,
        kind: agent ? 'agent' : 'tool',
        at,
        ms: null,
        msStart: at,
        title: agent ? '子代理' : name,
        preview: preview(summary || name),
        pending: true,
        error: false,
        name,
        toolCallId: callId,
        ...(fields ? { agent: fields } : {}),
      });
      detail(session, id, {
        title: agent ? '子代理' : name,
        input: summary || safeJson(args),
        extra: fields ? [fields.operation, fields.description].filter(Boolean).join(' · ') : name,
      });
      return;
    }
    if (event === 'tool_result') {
      const turn = openTurn(session);
      if (!turn || !data) return;
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const item = lastWhere(turn.items, (row) => row.toolCallId && row.toolCallId === callId);
      const output = typeof data.content === 'string' ? data.content : '';
      const isError = data.isError === true;
      if (!item) return;
      item.pending = false;
      item.at = at;
      item.error = isError;
      item.ms = item.msStart ? pos(at - item.msStart) : null;
      if (output) item.preview = preview(output);
      const existing = session.details[item.id] ?? { title: item.title, text: '', input: '', output: '', thinking: '', error: '', extra: '' };
      existing.output = clip(output);
      existing.error = isError ? clip(output) || '工具失败' : '';
      session.details[item.id] = existing;
      return;
    }
    if (event === 'before_compact') {
      const turn = openTurn(session);
      if (!turn) return;
      turn.compacting = true;
      return;
    }
    if (event === 'after_compact') {
      const turn = openTurn(session);
      if (!turn) return;
      turn.compacting = false;
      const reason = typeof data?.reason === 'string' ? data.reason : '';
      const id = nextId('live:k:');
      turn.items.push({
        id,
        kind: 'compact',
        at,
        ms: null,
        title: '上下文压缩',
        preview: preview(reason || '会话已压缩'),
        pending: false,
        error: false,
      });
      detail(session, id, { title: '上下文压缩', text: reason });
    }
  };

  return {
    note,
    snapshot(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return {
        model: session.model,
        state: session.state,
        pendingAsks: session.pendingAsks,
        pendingApprovals: session.pendingApprovals,
        context: session.context,
        turns: session.turns,
        details: session.details,
      };
    },
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pos(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 6 * 60 * 60 * 1000 ? v : null;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
