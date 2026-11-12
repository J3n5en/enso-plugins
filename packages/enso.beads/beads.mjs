import { createHash, randomBytes } from 'node:crypto';

/** 看板列。就绪来自 bd ready，不是另写一套规则。 */
export const COLUMN_ORDER = ['ready', 'in_progress', 'blocked', 'deferred', 'closed', 'other'];
export const GROUP_LABEL = {
  ready: '就绪',
  in_progress: '进行中',
  blocked: '阻塞',
  deferred: '暂缓',
  closed: '已关闭',
  other: '其他',
};
export const STATUS_LABEL = {
  open: '未开始',
  in_progress: '进行中',
  blocked: '阻塞',
  deferred: '暂缓',
  closed: '已关闭',
  pinned: '置顶',
  hooked: '挂起',
};
export const TYPE_LABEL = {
  bug: '缺陷',
  feature: '功能',
  task: '任务',
  epic: '史诗',
  chore: '杂务',
  decision: '决策',
  spike: '探索',
  story: '故事',
  milestone: '里程碑',
  molecule: '流程',
  gate: '门禁',
};
export const PRIORITY_LABEL = ['P0 紧急', 'P1 高', 'P2 中', 'P3 低', 'P4 待定'];

const INFRA_TYPES = new Set(['agent', 'rig', 'role', 'message', 'event']);
const BLOCKING_TYPES = new Set(['blocks', 'conditional-blocks']);
const MAX_BOARD = 2000;

export function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

export function assertText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`请填写${label}`);
  if (text.length > max) throw new Error(`${label}太长`);
  return text;
}

export function assertId(id) {
  const value = String(id ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(value)) throw new Error('任务 id 不合法');
  return value;
}

export function parsePriority(value, fallback = 2) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim().replace(/^P/i, '');
  const number = Number(text);
  if (!Number.isInteger(number) || number < 0 || number > 4) throw new Error('优先级需要是 0 到 4');
  return number;
}

export function parseType(value) {
  const text = String(value ?? '').trim() || 'task';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(text)) throw new Error('类型不合法');
  return text;
}

export function prefixFromConfig(yaml) {
  const match = /^(?:issue-prefix|issue_prefix)\s*:\s*["']?([A-Za-z][A-Za-z0-9_-]{0,16})["']?\s*$/m.exec(String(yaml ?? ''));
  return match ? match[1] : 'bd';
}

export function jsonlRel(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/^\.\//, '');
  if (!trimmed || trimmed.includes('..') || trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  const rel = trimmed.startsWith('.beads/') ? trimmed : `.beads/${trimmed}`;
  return /^\.beads\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(rel) ? rel : null;
}

/** 解析 issues.jsonl。记忆、schema、墓碑行原样保留，坏行单独计数。 */
export function parseJsonl(text) {
  const passthrough = [];
  const issues = [];
  const bad = [];
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      bad.push(trimmed.slice(0, 80));
      passthrough.push(trimmed);
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      passthrough.push(trimmed);
      continue;
    }
    const keepAside = row._schema || row._type || row.status === 'tombstone' || row.id == null || !String(row.title ?? '').trim();
    if (keepAside) {
      passthrough.push(JSON.stringify(row));
      continue;
    }
    issues.push(row);
  }
  return { passthrough, issues, bad };
}

export function serializeJsonl(doc) {
  const lines = [...(doc.passthrough ?? []), ...[...doc.issues].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((issue) => JSON.stringify(issue))];
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function clampPriority(value) {
  const number = Number(String(value ?? '').replace(/^P/i, ''));
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : 2;
}

export function normalizeDeps(raw) {
  const list = Array.isArray(raw?.dependencies) ? raw.dependencies : [];
  const out = [];
  for (const dep of list) {
    if (!dep || typeof dep !== 'object') continue;
    const type = String(dep.type || dep.dependency_type || 'blocks');
    const dependsOnId = String(dep.depends_on_id || dep.dependsOnId || (dep.dependency_type && dep.id) || '');
    if (!dependsOnId) continue;
    const issueId = String(dep.issue_id || dep.issueId || raw.id || '');
    out.push({ issueId, dependsOnId, type });
  }
  return out;
}

function normalizeComments(raw) {
  const list = Array.isArray(raw?.comments) ? raw.comments : [];
  return list
    .map((comment, index) => ({
      id: String(comment?.id ?? index),
      author: String(comment?.author ?? ''),
      text: String(comment?.text ?? comment?.body ?? ''),
      createdAt: comment?.created_at || comment?.createdAt || '',
    }))
    .filter((comment) => comment.text);
}

export function normalizeIssue(raw) {
  const type = String(raw?.issue_type || raw?.type || 'task');
  const comments = normalizeComments(raw);
  return {
    id: String(raw.id),
    title: String(raw.title),
    description: String(raw.description ?? ''),
    design: String(raw.design ?? ''),
    acceptance: String(raw.acceptance_criteria ?? raw.acceptance ?? ''),
    notes: String(raw.notes ?? ''),
    status: String(raw.status || 'open'),
    priority: clampPriority(raw.priority),
    type,
    assignee: String(raw.assignee ?? ''),
    labels: Array.isArray(raw.labels) ? raw.labels.map((label) => String(label)).filter(Boolean).slice(0, 24) : [],
    createdAt: raw.created_at || raw.createdAt || '',
    updatedAt: raw.updated_at || raw.updatedAt || '',
    closedAt: raw.closed_at || raw.closedAt || '',
    closeReason: String(raw.close_reason ?? raw.closeReason ?? ''),
    deferUntil: raw.defer_until || raw.deferUntil || '',
    dependencies: normalizeDeps(raw),
    comments,
    commentCount: Number(raw.comment_count ?? raw.commentCount ?? comments.length) || comments.length,
    parent: raw.parent ? String(raw.parent) : '',
    ephemeral: Boolean(raw.ephemeral || raw.wisp),
    template: Boolean(raw.is_template || raw.isTemplate),
  };
}

export function isBoardIssue(issue) {
  if (!issue?.id || !issue.title) return false;
  if (issue.ephemeral || issue.template) return false;
  if (issue.status === 'tombstone') return false;
  if (INFRA_TYPES.has(issue.type)) return false;
  return true;
}

/** 没有 bd ready / bd blocked 时，用 blocks 边近似就绪和阻塞。 */
export function deriveMembership(issues, now = Date.now()) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const blocked = new Set();
  for (const issue of issues) {
    if (issue.status === 'closed' || issue.status === 'pinned') continue;
    const hit = issue.dependencies.some((dep) => {
      if (!BLOCKING_TYPES.has(dep.type)) return false;
      if (dep.issueId && dep.issueId !== issue.id) return false;
      const target = byId.get(dep.dependsOnId);
      if (!target) return false;
      return target.status !== 'closed' && target.status !== 'pinned';
    });
    if (issue.status === 'blocked' || hit) blocked.add(issue.id);
  }
  const ready = new Set();
  for (const issue of issues) {
    if (issue.status !== 'open' || blocked.has(issue.id)) continue;
    if (issue.deferUntil) {
      const at = Date.parse(issue.deferUntil);
      if (Number.isFinite(at) && at > now) continue;
    }
    ready.add(issue.id);
  }
  return { ready, blocked };
}

export function resolveMembership(issues, readyIds, blockedIds) {
  const derived = deriveMembership(issues);
  return {
    ready: readyIds ? new Set(readyIds) : derived.ready,
    blocked: blockedIds ? new Set(blockedIds) : derived.blocked,
    authoritative: readyIds != null && blockedIds != null,
  };
}

export function groupOf(issue, membership) {
  const status = issue.status || 'open';
  if (status === 'closed') return 'closed';
  if (status === 'blocked' || membership.blocked.has(issue.id)) return 'blocked';
  if (status === 'deferred') return 'deferred';
  if (status === 'in_progress' || status === 'hooked') return 'in_progress';
  if (membership.ready.has(issue.id)) return 'ready';
  if (status === 'open' && issue.deferUntil && !membership.authoritative) return 'deferred';
  return 'other';
}

export function visibleColumns(counts) {
  const columns = ['ready', 'in_progress', 'blocked'];
  if (counts.deferred) columns.push('deferred');
  columns.push('closed');
  if (counts.other) columns.push('other');
  return columns;
}

function brief(issues, id, type) {
  const hit = issues.get(id);
  return { id, title: hit?.title || '', status: hit?.status || '', type: type || '' };
}

export function relationsOf(issue, issues) {
  const byId = new Map(issues.map((item) => [item.id, item]));
  const blockedBy = [];
  const related = [];
  let parent = issue.parent ? brief(byId, issue.parent, 'parent-child') : null;
  for (const dep of issue.dependencies) {
    if (dep.issueId && dep.issueId !== issue.id) continue;
    if (BLOCKING_TYPES.has(dep.type)) blockedBy.push(brief(byId, dep.dependsOnId, dep.type));
    else if (dep.type === 'parent-child' && !parent) parent = brief(byId, dep.dependsOnId, dep.type);
    else if (dep.type === 'related' || dep.type === 'discovered-from') related.push(brief(byId, dep.dependsOnId, dep.type));
  }
  const blocks = [];
  const children = [];
  for (const other of issues) {
    if (other.id === issue.id) continue;
    for (const dep of other.dependencies) {
      if (dep.dependsOnId !== issue.id) continue;
      if (dep.issueId && dep.issueId !== other.id) continue;
      if (BLOCKING_TYPES.has(dep.type)) blocks.push(brief(byId, other.id, dep.type));
      else if (dep.type === 'parent-child') children.push(brief(byId, other.id, dep.type));
      else if ((dep.type === 'related' || dep.type === 'discovered-from') && !related.some((item) => item.id === other.id)) {
        related.push(brief(byId, other.id, dep.type));
      }
    }
    if (other.parent === issue.id && !children.some((item) => item.id === other.id)) children.push(brief(byId, other.id, 'parent-child'));
  }
  return { blockedBy, blocks, parent, children, related };
}

function summarize(issue, group, issues) {
  const relations = relationsOf(issue, issues);
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    group,
    priority: issue.priority,
    type: issue.type,
    assignee: issue.assignee,
    labels: issue.labels,
    commentCount: issue.commentCount,
    blockedBy: relations.blockedBy.map((item) => item.id),
    blocks: relations.blocks.map((item) => item.id),
    parent: relations.parent?.id || '',
    updatedAt: issue.updatedAt,
    description: clip(issue.description, 400),
  };
}

export function present(issues, membership) {
  const board = issues.filter(isBoardIssue);
  const grouped = [];
  for (const issue of board) {
    const group = groupOf(issue, membership);
    if (group) grouped.push({ issue, group });
  }
  const counts = { all: grouped.length, ready: 0, in_progress: 0, blocked: 0, deferred: 0, closed: 0, other: 0 };
  for (const row of grouped) counts[row.group] += 1;
  const ranked = [...grouped].sort((a, b) => a.issue.priority - b.issue.priority || a.issue.id.localeCompare(b.issue.id));
  const truncated = ranked.length > MAX_BOARD;
  const shown = truncated ? ranked.slice(0, MAX_BOARD) : ranked;
  const summaries = shown.map(({ issue, group }) => summarize(issue, group, board));
  return { counts, columns: visibleColumns(counts), issues: summaries, truncated, board };
}

export function stampOf(source, issues) {
  const body = issues.map((issue) => [issue.id, issue.group, issue.updatedAt, issue.commentCount, issue.assignee, issue.status].join('\t')).join('\n');
  return createHash('sha256').update(`${source}\n${body}`).digest('hex').slice(0, 16);
}

export function publicIssue(issue) {
  return {
    id: issue.id,
    title: issue.title,
    description: clip(issue.description, 20000),
    design: clip(issue.design, 8000),
    acceptance: clip(issue.acceptance, 8000),
    notes: clip(issue.notes, 8000),
    status: issue.status,
    priority: issue.priority,
    type: issue.type,
    assignee: issue.assignee,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    closeReason: issue.closeReason,
    commentCount: issue.commentCount,
    comments: issue.comments.slice(-100).map((comment) => ({
      id: comment.id,
      author: comment.author,
      text: clip(comment.text, 8000),
      createdAt: comment.createdAt,
    })),
  };
}

export function handoffPrompt(issue, relations) {
  const lines = [
    `请处理 Beads 任务 ${issue.id}「${issue.title}」。`,
    '',
    `状态：${STATUS_LABEL[issue.status] || issue.status}，优先级：P${issue.priority}，类型：${TYPE_LABEL[issue.type] || issue.type}`,
  ];
  if (issue.assignee) lines.push(`负责人：${issue.assignee}`);
  if (issue.description) lines.push('', '描述：', clip(issue.description, 4000));
  if (issue.acceptance) lines.push('', '验收：', clip(issue.acceptance, 2000));
  if (issue.design) lines.push('', '设计：', clip(issue.design, 2000));
  const deps = [];
  if (relations.blockedBy.length) deps.push(`阻塞于：${relations.blockedBy.map((item) => item.id).join('、')}`);
  if (relations.blocks.length) deps.push(`阻塞了：${relations.blocks.map((item) => item.id).join('、')}`);
  if (relations.parent) deps.push(`父任务：${relations.parent.id}`);
  if (deps.length) lines.push('', '依赖：', ...deps);
  lines.push(
    '',
    '这次交接只是把任务交给新会话，没有认领或关闭。',
    `开始做的时候再执行 bd update ${issue.id} --claim。`,
    `进展用 bd comments add ${issue.id} "..." 记下来。`,
    `做完再执行 bd close ${issue.id} --reason "..."。`,
    '只处理这条任务范围内的改动。',
  );
  return lines.join('\n');
}

export function parseBdPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  let raw = trimmed;
  try {
    JSON.parse(raw);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) throw new SyntaxError('bd 没有返回 JSON');
    raw = trimmed.slice(start);
  }
  const parsed = JSON.parse(raw);
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.schema_version != null &&
    Object.prototype.hasOwnProperty.call(parsed, 'data') &&
    parsed.id == null
  ) {
    return parsed.data;
  }
  return parsed;
}

export function payloadError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.error === 'string' && payload.error && payload.id == null && payload.title == null) return payload.error;
  return null;
}

export function coerceIssues(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.issues)) return payload.issues;
  if (payload && typeof payload === 'object' && payload.id && payload.title) return [payload];
  return null;
}

export function looksUninitialized(message) {
  return /no beads database|not initialized|not a beads|no \.beads|database not found|failed to find|bd init|workspace not initialized|issues database/i.test(
    String(message ?? ''),
  );
}

function mintId(prefix, ids) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `${prefix}-${randomBytes(3).toString('hex')}`;
    if (!ids.has(id)) return id;
  }
  throw new Error('无法生成任务 id');
}

/** 在 JSONL 文档上认领、关闭、重开、评论或新建。不改动记忆行和墓碑。 */
export function applyFileChange(doc, action, options = {}) {
  const now = options.now || new Date().toISOString();
  const issues = doc.issues.map((issue) => ({
    ...issue,
    labels: issue.labels ? [...issue.labels] : issue.labels,
    comments: issue.comments ? issue.comments.map((comment) => ({ ...comment })) : issue.comments,
    dependencies: issue.dependencies ? issue.dependencies.map((dep) => ({ ...dep })) : issue.dependencies,
  }));
  if (action.op === 'create') {
    const title = assertText(action.title, '标题', 200);
    const prefix = options.prefix || 'bd';
    const ids = new Set(issues.map((issue) => issue.id));
    const id = options.idFactory ? options.idFactory(prefix, ids) : mintId(prefix, ids);
    assertId(id);
    if (ids.has(id)) throw new Error(`任务已存在：${id}`);
    issues.push({
      id,
      title,
      description: clip(String(action.description ?? '').trim(), 16000),
      status: 'open',
      priority: parsePriority(action.priority, 2),
      issue_type: parseType(action.type),
      created_at: now,
      updated_at: now,
      created_by: 'enso',
      labels: [],
      dependencies: [],
      comments: [],
    });
    return { passthrough: doc.passthrough, issues, id };
  }
  const id = assertId(action.id);
  const row = issues.find((issue) => issue.id === id);
  if (!row) throw new Error(`任务不存在：${id}`);
  if (action.op === 'claim') {
    if (row.status === 'closed') throw new Error('任务已关闭，要先重新打开');
    const assignee = String(row.assignee ?? '');
    if (assignee && assignee !== 'enso') throw new Error(`任务已指派给 ${assignee}`);
    row.status = 'in_progress';
    row.assignee = assignee || 'enso';
    row.updated_at = now;
  } else if (action.op === 'close') {
    const reason = String(action.reason ?? '').trim();
    if (reason.length > 2000) throw new Error('关闭原因太长');
    row.status = 'closed';
    row.closed_at = row.closed_at || now;
    if (reason) row.close_reason = reason;
    row.updated_at = now;
  } else if (action.op === 'reopen') {
    if (row.status !== 'closed') throw new Error('任务不是关闭状态');
    row.status = 'open';
    delete row.closed_at;
    delete row.close_reason;
    row.updated_at = now;
  } else if (action.op === 'comment') {
    const text = assertText(action.text, '评论', 8000);
    if (!Array.isArray(row.comments)) row.comments = [];
    row.comments.push({
      id: options.commentId || Date.parse(now) || Date.now(),
      issue_id: row.id,
      author: 'enso',
      text,
      created_at: now,
    });
    row.updated_at = now;
  } else throw new Error('未知操作');
  return { passthrough: doc.passthrough, issues, id };
}
