import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { activate } from '../packages/enso.linear/main.mjs';
import {
  OAUTH_REDIRECT,
  assembleList,
  authorizationCodeFields,
  codeFromCallback,
  countLabel,
  counts,
  formBody,
  groupIssues,
  issueKeyFromBranch,
  linksOf,
  parseIssueRef,
  redact,
  relationPhrase,
  startWorkText,
  brief,
} from '../packages/enso.linear/logic.mjs';

const run = promisify(execFile);
const TEAM = '11111111-1111-4111-8111-111111111111';
const STATE = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const ISSUE = '33333333-3333-4333-8333-333333333333';

const sample = {
  id: ISSUE,
  identifier: 'ENG-142',
  title: '修复同步',
  priority: 1,
  url: 'https://linear.app/acme/issue/ENG-142',
  dueDate: '2020-01-01',
  updatedAt: '2026-01-02T00:00:00.000Z',
  estimate: 2,
  branchName: 'ada/eng-142-fix-sync',
  state: { id: STATE, name: 'In Progress', type: 'started', color: '#f2c94c' },
  assignee: { id: USER, name: 'Ada', displayName: 'Ada' },
  team: { id: TEAM, key: 'ENG', name: 'Engineering' },
  project: { name: 'Sync' },
  cycle: { number: 12, name: 'Cycle 12' },
  labels: { nodes: [{ name: 'bug', color: '#ff0000' }] },
};

function detailIssue() {
  return {
    ...sample,
    description: '把同步修好',
    children: { nodes: [{ id: '55555555-5555-4555-8555-555555555555', identifier: 'ENG-143', title: '补测试', priority: 3, state: { name: 'Todo', type: 'unstarted', color: '#bec2c8' } }] },
    relations: { nodes: [{ type: 'blocks', relatedIssue: { id: '66666666-6666-4666-8666-666666666666', identifier: 'ENG-9', title: '上游', url: 'https://linear.app/acme/issue/ENG-9' } }] },
    inverseRelations: { nodes: [{ type: 'blocks', issue: { id: '77777777-7777-4777-8777-777777777777', identifier: 'ENG-8', title: '下游' } }] },
    attachments: { nodes: [{ title: '规格', url: 'https://example.com/spec', subtitle: '文档' }, { title: '坏链接', url: 'javascript:alert(1)' }] },
    comments: { nodes: [{ id: 'c1', body: '看过了', createdAt: '2026-01-01T00:00:00.000Z', user: { displayName: 'Ada' } }] },
    team: {
      ...sample.team,
      states: { nodes: [{ id: STATE, name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 }] },
      members: { nodes: [{ id: USER, name: 'Ada', displayName: 'Ada', active: true }] },
    },
  };
}

function graphqlData(query, variables) {
  if (query.includes('query Boot')) {
    return { viewer: { id: 'u', name: 'Ada', displayName: 'Ada Lovelace' }, organization: { name: 'Acme' }, teams: { nodes: [{ id: TEAM, key: 'ENG', name: 'Engineering' }] } };
  }
  if (query.includes('MineOpen')) return { viewer: { assignedIssues: { nodes: [sample], pageInfo: { hasNextPage: false } } } };
  if (query.includes('MineDone')) return { viewer: { assignedIssues: { nodes: [], pageInfo: { hasNextPage: false } } } };
  if (query.includes('CycleIssues')) {
    return { team: { activeCycle: { id: 'cyc', number: 3, name: 'Cycle 3', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z', progress: 0.4, issues: { nodes: [sample], pageInfo: { hasNextPage: false } } } } };
  }
  if (query.includes('TeamIssues')) {
    const type = variables?.filter?.state?.type?.eq;
    return { team: { issues: { nodes: type === 'triage' ? [] : [sample], pageInfo: { hasNextPage: false } } } };
  }
  if (query.includes('IssueDetail')) return { issue: detailIssue() };
  if (query.includes('IssueUpdate')) return { issueUpdate: { success: true } };
  if (query.includes('CommentCreate')) return { commentCreate: { success: true } };
  if (query.includes('SearchIssues')) return { searchIssues: { nodes: [sample] } };
  if (query.includes('IssueBrief')) return { issue: { ...sample, identifier: 'ENG-999', title: '分支上的议题', priority: 2, state: { ...sample.state, name: 'Todo', type: 'unstarted' } } };
  return null;
}

async function setup(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lin-'));
  if (options.auth) await writeFile(join(dataDir, 'auth.json'), JSON.stringify(options.auth), { mode: 0o600 });
  const calls = [];
  const tools = {};
  const handlers = {};
  const opened = [];
  const sessions = [];
  const drafts = [];
  activate({
    dataDir,
    config: { get: async () => options.config ?? { apiKey: 'lin_api_testkey123456' } },
    net: {
      fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
        if (options.fetch) return options.fetch(url, init);
        if (String(url).endsWith('/oauth/token')) {
          return { status: 200, body: JSON.stringify(options.token ?? { access_token: 'oauth-access-token-xyz', refresh_token: 'oauth-refresh-token-xyz', expires_in: 3600, token_type: 'Bearer' }) };
        }
        if (String(url).endsWith('/oauth/revoke')) return { status: 200, body: '{}' };
        const payload = JSON.parse(init.body || '{}');
        if (options.graphqlError) return { status: 200, body: JSON.stringify({ errors: [{ message: options.graphqlError }] }) };
        const data = graphqlData(payload.query || '', payload.variables);
        if (!data) return { status: 200, body: JSON.stringify({ errors: [{ message: 'unmocked' }] }) };
        return { status: 200, body: JSON.stringify({ data }) };
      },
    },
    ui: { openExternal: async (url) => opened.push(String(url)) },
    tools: { register: (name, fn) => (tools[name] = fn) },
    renderer: { handle: (name, fn) => (handlers[name] = fn) },
    session: { create: async (input) => { sessions.push(input); return { sessionId: 'sess-1' }; } },
    composer: { insertText: async (input) => { drafts.push(input); } },
  });
  return { calls, tools, handlers, opened, sessions, drafts, dataDir };
}

test('分支名能还原 Linear 标识，并跳过常见 git 前缀', () => {
  assert.equal(issueKeyFromBranch('pat/eng-142-fix-sync'), 'ENG-142');
  assert.equal(issueKeyFromBranch('feat/eng-142-step-2'), 'ENG-142');
  assert.equal(issueKeyFromBranch('fix-1-eng-142-title'), 'ENG-142');
  assert.equal(issueKeyFromBranch('ENG-7'), 'ENG-7');
  assert.equal(issueKeyFromBranch('feat-12-add-button'), null);
  assert.equal(issueKeyFromBranch('release-2024'), null);
  assert.equal(issueKeyFromBranch('main'), null);
  assert.equal(issueKeyFromBranch('HEAD'), null);
});

test('分组把评审从进行中拆开，紧急优先，完成的默认折叠', () => {
  const issues = [
    { identifier: 'A-2', title: 'later', priority: 4, updatedAt: '2026-01-03T00:00:00Z', state: { type: 'unstarted', name: 'Todo' } },
    { identifier: 'A-1', title: 'now', priority: 1, updatedAt: '2026-01-01T00:00:00Z', state: { type: 'started', name: 'In Progress' } },
    { identifier: 'A-5', title: 'also', priority: 3, updatedAt: '2026-01-05T00:00:00Z', state: { type: 'started', name: 'In Progress' } },
    { identifier: 'A-3', title: 'review', priority: 2, updatedAt: '2026-01-02T00:00:00Z', state: { type: 'started', name: 'In Review' } },
    { identifier: 'A-4', title: 'done', priority: 1, updatedAt: '2026-01-04T00:00:00Z', state: { type: 'completed', name: 'Done' } },
  ];
  const groups = groupIssues(issues, { collapseDone: true });
  assert.deepEqual(groups.map((group) => group.key), ['started', 'review', 'unstarted', 'completed']);
  assert.deepEqual(groups[0].items.map((issue) => issue.identifier), ['A-1', 'A-5']);
  assert.equal(groups.at(-1).collapsed, true);
  assert.deepEqual(counts(issues), { started: 3, urgent: 1 });
  assert.equal(countLabel({ started: 3, urgent: 1 }), '3 进行中 · 1 紧急');
});

test('链接只保留 http(s)，关系用阻塞方向区分', () => {
  assert.equal(relationPhrase('blocks', false), '阻塞');
  assert.equal(relationPhrase('blocks', true), '被阻塞');
  const links = linksOf(detailIssue());
  assert.deepEqual(links.map((link) => link.title), ['规格', '阻塞 ENG-9', '被阻塞 ENG-8']);
  assert.equal(links.some((link) => String(link.url).startsWith('javascript:')), false);
});

test('OAuth 请求体不含 client_secret，回调只接受本机地址', () => {
  const body = formBody(authorizationCodeFields({ code: 'authcode1', clientId: 'public-client', verifier: 'verifier-value' }));
  const params = new URLSearchParams(body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code_verifier'), 'verifier-value');
  assert.equal(params.has('client_secret'), false);
  assert.throws(() => formBody({ client_secret: 'nope' }), /client_secret/);
  assert.equal(codeFromCallback(`${OAUTH_REDIRECT}?code=authcode1&state=abc`, 'abc'), 'authcode1');
  assert.throws(() => codeFromCallback('https://evil.example/callback?code=authcode1&state=abc', 'abc'), /本机/);
  assert.throws(() => codeFromCallback(`${OAUTH_REDIRECT}?code=authcode1&state=nope`, 'abc'), /state/);
});

test('开始处理的提示带上议题和分支，已在对应分支时不再要求新建', () => {
  const onBranch = startWorkText({ identifier: 'ENG-142', title: '修复', url: 'https://linear.app/x', branchName: 'ada/eng-142-fix-sync', description: '正文', state: { name: 'In Progress' }, children: [{ identifier: 'ENG-143' }] }, 'ada/eng-142-fix-sync');
  assert.match(onBranch, /ENG-142/);
  assert.match(onBranch, /ENG-143/);
  assert.match(onBranch, /已经对应/);
  assert.equal(onBranch.includes('请从默认分支创建'), false);
  const other = startWorkText({ identifier: 'ENG-142', title: '修复', branchName: 'ada/eng-142-fix-sync' }, 'main');
  assert.match(other, /建议分支：ada\/eng-142-fix-sync/);
});

test('API Key 原样放进 Authorization，只请求 api.linear.app，并且不落盘', async () => {
  const { calls, tools, dataDir } = await setup({ config: { apiKey: 'Bearer lin_api_testkey123456' } });
  const listed = await tools.linear_list({ view: 'mine' });
  assert.equal(listed.groups[0].items[0].identifier, 'ENG-142');
  assert.equal(listed.groups[0].items[0].priorityLabel, '紧急');
  assert.equal(listed.groups[0].items[0].overdue, true);
  assert.equal(listed.summary.urgent, 1);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.url.startsWith('https://api.linear.app/')));
  assert.ok(calls.every((call) => ['/graphql', '/oauth/token', '/oauth/revoke'].includes(new URL(call.url).pathname)));
  assert.ok(calls.filter((call) => call.url.endsWith('/graphql')).every((call) => call.headers.authorization === 'lin_api_testkey123456'));
  assert.equal(existsSync(join(dataDir, 'auth.json')), false);
});

test('错误信息里的 API Key 会被抹掉', async () => {
  const { tools } = await setup({ graphqlError: 'nope lin_api_testkey123456 leaked' });
  await assert.rejects(tools.linear_list({}), (error) => {
    assert.equal(error.message.includes('lin_api_'), false);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test('待办按团队过滤，分拣为空，周期带上进度', async () => {
  const { calls, tools } = await setup();
  const backlog = await tools.linear_list({ view: 'backlog', team: 'ENG' });
  assert.equal(backlog.team.key, 'ENG');
  assert.equal(backlog.groups[0].items[0].identifier, 'ENG-142');
  const teamCall = calls.find((call) => call.body.includes('TeamIssues'));
  assert.equal(JSON.parse(teamCall.body).variables.filter.state.type.eq, 'backlog');
  const triage = await tools.linear_list({ view: 'triage', team: TEAM });
  assert.equal(triage.groups.length, 0);
  const cycle = await tools.linear_list({ view: 'cycle', team: 'eng' });
  assert.equal(cycle.cycle.name, 'Cycle 3');
  assert.equal(cycle.cycle.progress, 0.4);
  assert.equal(typeof cycle.cycle.daysLeft, 'number');
});

test('当前分支的议题会钉住；列表里没有时再单独查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lin-repo-'));
  await run('git', ['init', '-b', 'ada/eng-142-fix-sync'], { cwd: root });
  const { tools } = await setup();
  const listed = await tools.linear_list({ view: 'mine' }, { projectRoot: root });
  assert.equal(listed.branchIssue, 'ENG-142');
  assert.equal(listed.pinned.identifier, 'ENG-142');
  assert.equal(listed.groups[0].items[0].branch, true);

  const other = await mkdtemp(join(tmpdir(), 'lin-repo-'));
  await run('git', ['init', '-b', 'ada/eng-999-missing'], { cwd: other });
  const missed = await tools.linear_list({ view: 'mine' }, { projectRoot: other });
  assert.equal(missed.branchIssue, 'ENG-999');
  assert.equal(missed.pinned.identifier, 'ENG-999');
  assert.equal(missed.groups.some((group) => group.items.some((issue) => issue.branch)), false);
});

test('更新状态、空评论不发请求，开始处理会新建会话且提示不含钥匙', async () => {
  const { calls, tools, sessions, drafts, handlers } = await setup();
  const before = calls.length;
  await assert.rejects(tools.linear_view({ id: 'not an issue' }), /ENG-123/);
  await assert.rejects(tools.linear_comment({ id: 'ENG-142', body: '  ' }), /评论/);
  await assert.rejects(tools.linear_update({ id: 'ENG-142', priority: 9 }), /优先级/);
  assert.equal(calls.length, before);

  const updated = await tools.linear_update({ id: 'ENG-142', stateId: STATE, priority: 2 });
  assert.equal(updated.identifier, 'ENG-142');
  assert.equal(updated.links[0].title, '规格');
  const updateCall = calls.find((call) => call.body.includes('IssueUpdate'));
  assert.deepEqual(JSON.parse(updateCall.body).variables.input, { stateId: STATE, priority: 2 });
  assert.equal(updateCall.headers.authorization.startsWith('Bearer '), false);

  const started = await tools.linear_start({ id: 'eng-142' });
  assert.equal(started.sessionId, 'sess-1');
  assert.match(sessions[0].text, /ENG-142/);
  assert.match(sessions[0].text, /ada\/eng-142-fix-sync/);
  assert.equal(sessions[0].text.includes('lin_api_'), false);
  assert.equal(parseIssueRef('eng-142'), 'ENG-142');

  await handlers.start({ id: 'ENG-142', target: 'draft' });
  assert.match(drafts.at(-1).text, /ENG-142/);
  assert.equal(drafts.at(-1).text.includes('lin_api_'), false);
});

test('过期的 OAuth 令牌会刷新且不发送 client_secret，state 不回传令牌', async () => {
  const { calls, handlers, tools, dataDir } = await setup({
    config: {},
    auth: {
      accessToken: 'old-access-token-xyz',
      refreshToken: 'old-refresh-token-xyz',
      expiresAt: 1,
      clientId: 'public-client-id',
      viewerName: 'Ada',
    },
  });
  const listed = await tools.linear_list({});
  assert.equal(listed.groups[0].items[0].identifier, 'ENG-142');
  const refresh = calls.find((call) => call.url === 'https://api.linear.app/oauth/token');
  const params = new URLSearchParams(refresh.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('client_id'), 'public-client-id');
  assert.equal(params.has('client_secret'), false);
  assert.ok(calls.some((call) => call.headers?.authorization === 'Bearer oauth-access-token-xyz'));
  const saved = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(saved.accessToken, 'oauth-access-token-xyz');
  assert.equal((await stat(join(dataDir, 'auth.json'))).mode & 0o777, 0o600);
  const state = await handlers.state();
  const encoded = JSON.stringify(state);
  assert.equal(encoded.includes('access-token'), false);
  assert.equal(encoded.includes('refresh-token'), false);
  assert.equal(state.source, 'oauth');
  assert.equal(state.viewer.name, 'Ada Lovelace');
  await handlers.logout();
  assert.equal(existsSync(join(dataDir, 'auth.json')), false);
  assert.ok(calls.some((call) => call.url === 'https://api.linear.app/oauth/revoke' && call.body.includes('token_type_hint=access_token')));
});

test('PKCE 登录打开授权页，用回调换令牌时不带 client_secret', async () => {
  const env = await setup({ config: { oauthClientId: 'public-client-id' } });
  try {
    await env.handlers.login();
    const url = new URL(env.opened[0]);
    assert.equal(url.origin, 'https://linear.app');
    assert.equal(url.pathname, '/oauth/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('client_id'), 'public-client-id');
    assert.equal(url.searchParams.has('client_secret'), false);
    await env.handlers.submitCode({ text: `${OAUTH_REDIRECT}?code=authcode1&state=${url.searchParams.get('state')}` });
    const tokenCall = env.calls.find((call) => call.url.endsWith('/oauth/token'));
    const params = new URLSearchParams(tokenCall.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), 'authcode1');
    assert.equal(params.has('client_secret'), false);
    assert.equal(params.get('redirect_uri'), OAUTH_REDIRECT);
    const state = await env.handlers.state();
    assert.equal(state.source, 'oauth');
    assert.equal(JSON.stringify(state).includes('oauth-access-token'), false);
    assert.ok(env.calls.every((call) => call.url.startsWith('https://api.linear.app/')));
  } finally {
    await env.handlers.cancelLogin();
  }
});

test('清单只声明 Linear API 域名，钥匙字段是密钥', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/enso.linear/enso-plugin.json', import.meta.url), 'utf8'));
  const meta = JSON.parse(await readFile(new URL('../registry/meta/enso.linear.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.net.domains, ['api.linear.app']);
  assert.equal(manifest.permissions.includes('net.fetch'), true);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.contributes.configuration.find((item) => item.key === 'apiKey').secret, true);
  assert.equal(meta.tier, 'official');
  assert.equal(meta.category, 'integrations');
  const source = await readFile(new URL('../packages/enso.linear/main.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('TODO'), false);
  assert.equal(source.includes('console.'), false);
  const pinned = assembleList({ view: 'mine', issues: [sample], branchKey: 'ENG-142' });
  assert.equal(pinned.pinned.branch, true);
  assert.equal(brief(sample).url.startsWith('https://'), true);
  assert.equal(redact('see lin_api_abcdefghijklmnopqrstuv and Bearer abcdefghijk', []), 'see [redacted] and Bearer [redacted]');
});
