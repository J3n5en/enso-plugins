/** 把宿主会话状态收成「在等你」条目。纯函数，不访问 Enso。 */

export const KIND_ORDER = { approval: 0, ask: 1, failure: 2 };
const STATES = new Set(['idle', 'running', 'waiting', 'error']);
const SEEN_LIMIT = 400;

export function rootId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '';
  const sep = sessionId.indexOf('::');
  return sep === -1 ? sessionId : sessionId.slice(0, sep);
}

export function clampCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 0;
  return value > 999 ? 999 : value;
}

/** 折叠空白并截断。工具错误正文只留一截，避免塞满侧栏。 */
export function snippet(value, max = 160) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeStatus(raw, fallbackId = '') {
  const sessionId = typeof raw?.sessionId === 'string' && raw.sessionId ? rootId(raw.sessionId) : fallbackId;
  const state = STATES.has(raw?.state) ? raw.state : 'idle';
  return {
    sessionId,
    state,
    pendingAsks: clampCount(raw?.pendingAsks),
    pendingApprovals: clampCount(raw?.pendingApprovals),
  };
}

/** 记下这个主会话最近一次失败的工具。成功的结果不覆盖。返回是否写入。 */
export function noteToolError(map, sessionId, data, now) {
  const id = rootId(sessionId);
  if (!id || !data || data.isError !== true) return false;
  const toolName = snippet(data.toolName, 80) || '工具';
  map.set(id, { toolName, content: snippet(data.content, 160), at: now });
  return true;
}

export function sameProject(viewer, target) {
  if (!viewer?.projectId || !target?.projectId) return false;
  return viewer.projectId === target.projectId;
}

function sessionLabel(session) {
  return {
    sessionId: session.id,
    projectId: typeof session.projectId === 'string' ? session.projectId : '',
    projectName: snippet(session.projectName, 120) || '未命名项目',
    sessionTitle: snippet(session.title, 200) || '未命名会话',
    archived: session.archived === true,
  };
}

function approvalTitle(count) {
  return count === 1 ? '1 项工具调用等待审批' : `${count} 项工具调用等待审批`;
}

function askTitle(count) {
  return count === 1 ? '1 个提问等待回答' : `${count} 个提问等待回答`;
}

function failureDetail(err) {
  if (!err?.toolName) return '主会话上一轮失败，或工作进程已退出。宿主没有附带原因。';
  return err.content ? `${err.toolName} 失败：${err.content}` : `${err.toolName} 失败`;
}

export function fingerprint(item) {
  return `${item.kind}:${item.count}:${item.detail}`;
}

function withUnread(base, seen) {
  const fp = fingerprint(base);
  return { ...base, unread: seen?.[base.id] !== fp };
}

/**
 * @param {{ sessions: object[], statuses: Map<string, object>, toolErrors: Map<string, object>, seen: Record<string, string>, now?: number }} input
 */
export function buildItems(input) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const statuses = input?.statuses instanceof Map ? input.statuses : new Map();
  const toolErrors = input?.toolErrors instanceof Map ? input.toolErrors : new Map();
  const seen = input?.seen && typeof input.seen === 'object' ? input.seen : {};
  const now = typeof input?.now === 'number' ? input.now : Date.now();
  const items = [];
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string' || !session.id) continue;
    const id = rootId(session.id);
    if (id !== session.id) continue;
    const status = statuses.get(id);
    const state = status?.state && STATES.has(status.state) ? status.state : session.state;
    const approvals = status ? clampCount(status.pendingApprovals) : 0;
    const asks = status ? clampCount(status.pendingAsks) : 0;
    const base = sessionLabel({ ...session, id });
    const at = typeof session.updatedAt === 'number' && session.updatedAt > 0 ? session.updatedAt : 0;
    if (approvals > 0) {
      items.push(withUnread({
        ...base,
        id: `${id}:approval`,
        kind: 'approval',
        count: approvals,
        title: approvalTitle(approvals),
        detail: '到会话里用审批条处理。这里没有工具名和参数。',
        at,
      }, seen));
    }
    if (asks > 0) {
      items.push(withUnread({
        ...base,
        id: `${id}:ask`,
        kind: 'ask',
        count: asks,
        title: askTitle(asks),
        detail: '到会话里回答。这里没有提问正文。',
        at,
      }, seen));
    }
    if (state === 'error') {
      const err = toolErrors.get(id);
      const when = err?.at > 0 ? err.at : at || now;
      items.push(withUnread({
        ...base,
        id: `${id}:failure`,
        kind: 'failure',
        count: 1,
        title: '上一轮失败',
        detail: failureDetail(err),
        at: when,
      }, seen));
    }
  }
  return rankItems(items);
}

export function rankItems(items) {
  return [...items].sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    const ka = KIND_ORDER[a.kind] ?? 9;
    const kb = KIND_ORDER[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return (b.at || 0) - (a.at || 0) || a.sessionTitle.localeCompare(b.sessionTitle, 'zh');
  });
}

export function summarize(items) {
  const summary = { approvals: 0, asks: 0, failures: 0, unread: 0, total: 0, cards: 0 };
  for (const item of items) {
    if (item.kind === 'approval') summary.approvals += item.count;
    else if (item.kind === 'ask') summary.asks += item.count;
    else if (item.kind === 'failure') summary.failures += item.count;
    if (item.unread) summary.unread += 1;
  }
  summary.total = summary.approvals + summary.asks + summary.failures;
  summary.cards = items.length;
  return summary;
}

export function filterItems(items, args) {
  const kind = args?.kind;
  const unreadOnly = args?.unreadOnly === true;
  return items.filter((item) => {
    if (typeof kind === 'string' && kind !== 'all' && item.kind !== kind) return false;
    if (unreadOnly && !item.unread) return false;
    return true;
  });
}

export function groupItems(items, viewerProjectId) {
  const groups = new Map();
  for (const item of items) {
    const key = item.projectId || `name:${item.projectName}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId: item.projectId,
        projectName: item.projectName,
        items: [],
        latest: 0,
        unread: 0,
        waits: 0,
        focusable: Boolean(viewerProjectId) && item.projectId === viewerProjectId,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    if ((item.at || 0) > group.latest) group.latest = item.at || 0;
    if (item.unread) group.unread += 1;
    group.waits += item.count;
  }
  const list = [...groups.values()];
  list.sort((a, b) => {
    const aHere = a.focusable ? 0 : 1;
    const bHere = b.focusable ? 0 : 1;
    if (aHere !== bHere) return aHere - bHere;
    return (b.latest || 0) - (a.latest || 0) || a.projectName.localeCompare(b.projectName, 'zh');
  });
  return list;
}

export function pruneSeen(seen, items, limit = SEEN_LIMIT) {
  const live = new Set(items.map((item) => item.id));
  const next = {};
  for (const [key, value] of Object.entries(seen || {})) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 2000) next[key] = value;
  }
  const extras = Object.keys(next).filter((key) => !live.has(key));
  while (Object.keys(next).length > limit && extras.length) delete next[extras.pop()];
  return next;
}

/** 输入框底栏状态项。没有等待时藏起来。text 不超过宿主的 24 字。 */
export function statusPatch(summary) {
  const total = summary?.total || 0;
  if (total < 1) {
    return { visible: false, text: '收件箱', tone: 'neutral', tooltip: '没有在等你的事项' };
  }
  const n = total > 99 ? '99+' : String(total);
  const unread = summary.unread || 0;
  const parts = [];
  if (summary.approvals) parts.push(`${summary.approvals} 项审批`);
  if (summary.asks) parts.push(`${summary.asks} 个提问`);
  if (summary.failures) parts.push(`${summary.failures} 个失败`);
  const tooltip = unread > 0 ? `${parts.join('，')}，${unread} 条未读` : parts.join('，');
  return {
    visible: true,
    text: `${n} 在等你`,
    tone: summary.approvals || summary.asks ? 'warning' : 'danger',
    tooltip: tooltip.slice(0, 200),
  };
}
