import { createHash, randomBytes } from 'node:crypto';

/** Linear 官方 GraphQL、OAuth 令牌与撤销都在这个源站。 */
export const API_ORIGIN = 'https://api.linear.app';
export const API_PATHS = new Set(['/graphql', '/oauth/token', '/oauth/revoke']);
export const OAUTH_PORT = 47321;
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;
export const COMPLETED_DAYS = 14;
export const MAX_COMMENT = 16000;
export const MAX_PROMPT = 8000;

const BRANCH_PREFIX = new Set([
  'feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'docs', 'doc', 'refactor',
  'test', 'tests', 'ci', 'perf', 'style', 'build', 'revert', 'wip', 'cursor', 'codex',
  'release', 'releases', 'version', 'ver', 'dependabot', 'renovate',
]);

export const GROUP_ORDER = ['started', 'review', 'unstarted', 'backlog', 'triage', 'completed', 'canceled'];
export const GROUP_LABEL = {
  started: '进行中',
  review: '评审中',
  unstarted: '待处理',
  backlog: '待办',
  triage: '分拣',
  completed: '最近完成',
  canceled: '已取消',
};
export const PRIORITY_LABEL = { 0: '无', 1: '紧急', 2: '高', 3: '中', 4: '低' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function apiUrl(path) {
  if (!API_PATHS.has(path)) throw new Error('拒绝访问该 Linear 路径');
  return `${API_ORIGIN}${path}`;
}

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  const list = secrets.filter((item) => typeof item === 'string' && item.length >= 8);
  for (const secret of list.sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
  return out.replace(/lin_api_[A-Za-z0-9]+/g, '[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
}

export function cleanSecret(value, max = 500) {
  let text = String(value ?? '').trim().replace(/^bearer\s+/i, '').trim();
  if (!text || text.length > max || /\s/.test(text)) return '';
  return text;
}

/** Client ID 是公开标识。误粘贴的 API Key 直接丢掉，避免把它送去授权页。 */
export function cleanClientId(value) {
  const text = cleanSecret(value, 200);
  if (!text || text.startsWith('lin_api_')) return '';
  return text;
}

export function authHeader(cred) {
  if (!cred?.token) throw new Error('未连接 Linear');
  return cred.kind === 'oauth' ? `Bearer ${cred.token}` : cred.token;
}

export function pkcePair(bytes = randomBytes) {
  const verifier = bytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: bytes(16).toString('base64url') };
}

export function authorizeUrl({ clientId, redirect = OAUTH_REDIRECT, challenge, state, scope = 'read,write' }) {
  const url = new URL('https://linear.app/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('actor', 'user');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'client_secret') throw new Error('拒绝发送 client_secret');
    if (value == null || value === '') continue;
    body.set(key, String(value));
  }
  if (body.has('client_secret')) throw new Error('拒绝发送 client_secret');
  return body.toString();
}

export function authorizationCodeFields({ code, redirect = OAUTH_REDIRECT, clientId, verifier }) {
  return {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  };
}

export function refreshFields({ refreshToken, clientId }) {
  return { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId };
}

export function readTokenPayload(raw) {
  let json;
  try {
    json = JSON.parse(raw || '');
  } catch {
    throw new Error('Linear 登录返回的不是 JSON');
  }
  if (!json || typeof json !== 'object' || !json.access_token) {
    throw new Error(json?.error === 'access_denied' ? '已取消授权' : 'Linear 登录失败');
  }
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : '',
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
}

export function codeFromCallback(text, expectedState) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('请粘贴回调地址或授权码');
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('回调地址无效');
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('只接受本机回调地址');
    if (url.pathname !== '/callback') throw new Error('回调路径应为 /callback');
    if (expectedState && url.searchParams.get('state') !== expectedState) throw new Error('OAuth state 不匹配');
    if (url.searchParams.get('error') === 'access_denied') throw new Error('已取消授权');
    if (url.searchParams.get('error')) throw new Error('Linear 拒绝了这次授权');
    const code = url.searchParams.get('code') || '';
    if (!/^[\w.-]{8,512}$/.test(code)) throw new Error('回调地址里没有授权码');
    return code;
  }
  if (!/^[\w.-]{8,512}$/.test(raw)) throw new Error('授权码格式不正确');
  return raw;
}

/** 从分支名里取出 Linear 标识，例如 pat/eng-142-fix-sync → ENG-142。 */
export function issueKeyFromBranch(branch) {
  const text = String(branch ?? '').trim();
  if (!text || text === 'HEAD') return null;
  const re = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,8})(?!\d)/g;
  for (const match of text.matchAll(re)) {
    const key = match[1].toLowerCase();
    if (BRANCH_PREFIX.has(key)) continue;
    return `${match[1].toUpperCase()}-${match[2]}`;
  }
  return null;
}

export function parseIssueRef(value) {
  const text = String(value ?? '').trim();
  if (UUID.test(text)) return text.toLowerCase();
  const match = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(text);
  if (!match) throw new Error('议题应为 ENG-123 或 UUID');
  return `${match[1].toUpperCase()}-${match[2]}`;
}

export function normalizeView(value) {
  return ['mine', 'cycle', 'backlog', 'triage'].includes(value) ? value : 'mine';
}

export function pickTeam(teams, requested, view, strict = false) {
  const list = Array.isArray(teams) ? teams : [];
  const want = String(requested ?? '').trim();
  if (!want) return view === 'mine' ? null : (list[0] ?? null);
  const found = list.find((team) => team.id === want || String(team.key ?? '').toLowerCase() === want.toLowerCase());
  if (found) return found;
  if (strict) throw new Error(`找不到团队 ${want}`);
  return view === 'mine' ? null : (list[0] ?? null);
}

export function safeHttp(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function safeColor(value) {
  const text = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : null;
}

export function isOverdue(dueDate, stateType, now = new Date()) {
  if (!dueDate || stateType === 'completed' || stateType === 'canceled') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return dueDate < today;
}

export function person(user) {
  if (!user?.id) return null;
  return { id: user.id, name: user.displayName || user.name || '未命名' };
}

export function priorityRank(priority) {
  return priority >= 1 && priority <= 4 ? priority : 5;
}

export function compareIssues(a, b) {
  const diff = priorityRank(a.priority) - priorityRank(b.priority);
  if (diff) return diff;
  return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
}

export function groupOf(issue) {
  const type = issue.state?.type || 'unstarted';
  if (type === 'started' && /review|评审|审核/i.test(issue.state?.name || '')) return 'review';
  return GROUP_LABEL[type] ? type : 'unstarted';
}

export function groupIssues(issues, { collapseDone = false } = {}) {
  const buckets = new Map();
  for (const issue of issues) {
    const key = groupOf(issue);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(issue);
  }
  return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    label: GROUP_LABEL[key],
    collapsed: Boolean(collapseDone && (key === 'completed' || key === 'canceled')),
    items: buckets.get(key).sort(compareIssues),
  }));
}

export function counts(issues) {
  let started = 0;
  let urgent = 0;
  for (const issue of issues) {
    const type = issue.state?.type;
    if (type === 'completed' || type === 'canceled') continue;
    if (type === 'started') started += 1;
    if (issue.priority === 1) urgent += 1;
  }
  return { started, urgent };
}

export function countLabel(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.started) parts.push(`${summary.started} 进行中`);
  if (summary.urgent) parts.push(`${summary.urgent} 紧急`);
  return parts.join(' · ');
}

export function brief(issue, now = new Date()) {
  const priority = Number.isInteger(issue.priority) ? issue.priority : 0;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title || '',
    priority,
    priorityLabel: PRIORITY_LABEL[priority] ?? '无',
    url: safeHttp(issue.url),
    updatedAt: issue.updatedAt ?? null,
    dueDate: issue.dueDate ?? null,
    overdue: isOverdue(issue.dueDate, issue.state?.type, now),
    estimate: Number.isFinite(issue.estimate) ? issue.estimate : null,
    branchName: issue.branchName ?? null,
    state: issue.state
      ? { id: issue.state.id, name: issue.state.name, type: issue.state.type, color: safeColor(issue.state.color) }
      : null,
    assignee: person(issue.assignee),
    team: issue.team?.id ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
    project: issue.project?.name ? { name: issue.project.name } : null,
    cycle: issue.cycle ? { number: issue.cycle.number ?? null, name: issue.cycle.name || '' } : null,
    labels: (issue.labels?.nodes ?? []).map((label) => ({ name: label.name, color: safeColor(label.color) })).filter((label) => label.name),
  };
}

export function relationPhrase(type, incoming) {
  if (type === 'blocks') return incoming ? '被阻塞' : '阻塞';
  if (type === 'blockedBy' || type === 'blocked') return incoming ? '阻塞' : '被阻塞';
  if (type === 'duplicate') return '重复';
  if (type === 'related') return '相关';
  return '关联';
}

export function linksOf(issue) {
  const links = [];
  for (const attachment of issue.attachments?.nodes ?? []) {
    const url = safeHttp(attachment.url);
    if (!url) continue;
    links.push({ kind: 'link', title: attachment.title || url, url, subtitle: attachment.subtitle || '' });
  }
  for (const rel of issue.relations?.nodes ?? []) {
    const other = rel.relatedIssue;
    if (!other?.identifier) continue;
    links.push({
      kind: 'issue',
      title: `${relationPhrase(rel.type, false)} ${other.identifier}`,
      id: other.id,
      identifier: other.identifier,
      issueTitle: other.title || '',
      url: safeHttp(other.url),
    });
  }
  for (const rel of issue.inverseRelations?.nodes ?? []) {
    const other = rel.issue;
    if (!other?.identifier) continue;
    links.push({
      kind: 'issue',
      title: `${relationPhrase(rel.type, true)} ${other.identifier}`,
      id: other.id,
      identifier: other.identifier,
      issueTitle: other.title || '',
      url: safeHttp(other.url),
    });
  }
  return links;
}

export function detailOf(issue, now = new Date()) {
  const states = (issue.team?.states?.nodes ?? [])
    .map((state) => ({ id: state.id, name: state.name, type: state.type, color: safeColor(state.color), position: state.position ?? 0 }))
    .sort((a, b) => a.position - b.position);
  const members = (issue.team?.members?.nodes ?? [])
    .filter((user) => user.active !== false)
    .map(person)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const comments = (issue.comments?.nodes ?? [])
    .map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      createdAt: comment.createdAt ?? null,
      author: comment.user?.displayName || comment.user?.name || '未知',
    }))
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  return {
    ...brief(issue, now),
    description: issue.description ?? '',
    children: (issue.children?.nodes ?? []).map((child) => brief(child, now)),
    childrenTruncated: Boolean(issue.children?.pageInfo?.hasNextPage),
    links: linksOf(issue),
    comments,
    commentsTruncated: Boolean(issue.comments?.pageInfo?.hasNextPage),
    states,
    members,
  };
}

export function assembleList({ view, issues, branchKey, extra = null, cycle = null, truncated = false, now = new Date() }) {
  const key = branchKey ? String(branchKey).toUpperCase() : null;
  const marked = issues.map((issue) => {
    const item = brief(issue, now);
    return { ...item, branch: Boolean(key && String(item.identifier).toUpperCase() === key) };
  });
  let pinned = marked.find((item) => item.branch) ?? null;
  if (!pinned && extra) {
    const one = { ...brief(extra, now), branch: true };
    if (!key || String(one.identifier).toUpperCase() === key) pinned = one;
  }
  return {
    view,
    branchIssue: key,
    pinned,
    groups: groupIssues(marked, { collapseDone: view === 'mine' }),
    counts: counts(marked),
    cycle: cycle ? cycleMeta(cycle, now.getTime()) : null,
    truncated: Boolean(truncated),
  };
}

export function cycleMeta(cycle, now = Date.now()) {
  if (!cycle) return null;
  const ends = Date.parse(cycle.endsAt);
  const progress = Number(cycle.progress);
  return {
    id: cycle.id,
    number: cycle.number ?? null,
    name: cycle.name || (cycle.number != null ? `周期 ${cycle.number}` : '当前周期'),
    startsAt: cycle.startsAt ?? null,
    endsAt: cycle.endsAt ?? null,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
    daysLeft: Number.isFinite(ends) ? Math.ceil((ends - now) / 86_400_000) : null,
  };
}

export function daysLeftLabel(days) {
  if (days == null) return '';
  if (days > 1) return `还剩 ${days} 天`;
  if (days === 1) return '还剩 1 天';
  if (days === 0) return '今天结束';
  return '已结束';
}

export function completedSince(now = Date.now()) {
  return new Date(now - COMPLETED_DAYS * 86_400_000).toISOString();
}

export function matchQuery(issue, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const labels = Array.isArray(issue.labels) ? issue.labels : (issue.labels?.nodes ?? []);
  const hay = [issue.identifier, issue.title, issue.assignee?.displayName, issue.assignee?.name, issue.project?.name, issue.state?.name, labels.map((label) => label.name).join(' ')]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

export function startWorkText(issue, currentBranch) {
  const identifier = issue.identifier || '议题';
  const branch = issue.branchName || String(identifier).toLowerCase();
  const onIt = Boolean(currentBranch && issueKeyFromBranch(currentBranch) === String(identifier).toUpperCase());
  const description = String(issue.description || '').trim().slice(0, MAX_PROMPT);
  const children = (issue.children ?? []).map((child) => child.identifier).filter(Boolean);
  return [
    `请在当前项目开始处理 Linear 议题 ${identifier}：${issue.title || ''}`.trim(),
    issue.url || '',
    issue.state?.name ? `状态：${issue.state.name}` : '',
    description ? `描述：\n${description}` : '',
    children.length ? `子议题：${children.join('、')}` : '',
    onIt
      ? `当前 git 分支 ${currentBranch} 已经对应该议题，请在这个分支上继续。`
      : `建议分支：${branch}\n如果仓库里还没有这个分支，请从默认分支创建并切换过去，然后实现这个议题。`,
    '做完后说明改了什么。需要的话可以用 Linear 工具更新状态或补充评论。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function updateInput(args) {
  const input = {};
  if (args?.stateId != null && args.stateId !== '') {
    if (!UUID.test(String(args.stateId))) throw new Error('状态 id 无效');
    input.stateId = String(args.stateId).toLowerCase();
  }
  if (args?.priority != null && args.priority !== '') {
    const priority = Number(args.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new Error('优先级必须是 0 到 4');
    input.priority = priority;
  }
  if (args && Object.prototype.hasOwnProperty.call(args, 'assigneeId')) {
    if (args.assigneeId && !UUID.test(String(args.assigneeId))) throw new Error('负责人 id 无效');
    input.assigneeId = args.assigneeId ? String(args.assigneeId).toLowerCase() : null;
  }
  if (!Object.keys(input).length) throw new Error('没有要更新的字段');
  return input;
}

export function commentBody(value) {
  const body = String(value ?? '').trim().slice(0, MAX_COMMENT);
  if (!body) throw new Error('评论不能为空');
  return body;
}

export function normalizeBoot(data) {
  return {
    viewer: data?.viewer ? { name: data.viewer.displayName || data.viewer.name || '我' } : null,
    organization: data?.organization?.name ? { name: data.organization.name } : null,
    teams: (data?.teams?.nodes ?? [])
      .map((team) => ({ id: team.id, key: team.key, name: team.name }))
      .filter((team) => team.id && team.key),
  };
}

const ISSUE_FIELDS = `
id identifier title priority url dueDate updatedAt estimate branchName
state { id name type color }
assignee { id name displayName }
team { id key name }
project { name }
cycle { number name }
labels { nodes { name color } }`;

export const BOOT_QUERY = `query Boot {
  viewer { id name displayName }
  organization { name }
  teams(first: 100) { nodes { id key name } }
}`;

export const MINE_OPEN_QUERY = `query MineOpen($filter: IssueFilter, $first: Int!) {
  viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }
  } }
}`;

export const MINE_DONE_QUERY = `query MineDone($filter: IssueFilter, $first: Int!) {
  viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }
  } }
}`;

export const TEAM_QUERY = `query TeamIssues($id: String!, $filter: IssueFilter, $first: Int!) {
  team(id: $id) { issues(first: $first, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }
  } }
}`;

export const CYCLE_QUERY = `query CycleIssues($id: String!, $first: Int!) {
  team(id: $id) { activeCycle {
    id number name startsAt endsAt progress
    issues(first: $first) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage } }
  } }
}`;

export const BRIEF_QUERY = `query IssueBrief($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

export const DETAIL_QUERY = `query IssueDetail($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    description
    children(first: 50) { nodes { id identifier title priority url state { id name type color } } pageInfo { hasNextPage } }
    relations(first: 20) { nodes { type relatedIssue { id identifier title url } } }
    inverseRelations(first: 20) { nodes { type issue { id identifier title url } } }
    attachments(first: 20) { nodes { title url subtitle } }
    comments(first: 50) { nodes { id body createdAt user { name displayName } } pageInfo { hasNextPage } }
    team {
      id key name
      states { nodes { id name type color position } }
      members(first: 100) { nodes { id name displayName active } }
    }
  }
}`;

export const SEARCH_QUERY = `query SearchIssues($term: String!, $first: Int!, $filter: IssueFilter) {
  searchIssues(term: $term, first: $first, filter: $filter) { nodes { ${ISSUE_FIELDS} } }
}`;

export const UPDATE_QUERY = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const COMMENT_QUERY = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
