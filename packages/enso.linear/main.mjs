import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  API_ORIGIN,
  BOOT_QUERY,
  BRIEF_QUERY,
  COMMENT_QUERY,
  CYCLE_QUERY,
  DETAIL_QUERY,
  MINE_DONE_QUERY,
  MINE_OPEN_QUERY,
  OAUTH_PORT,
  OAUTH_REDIRECT,
  SEARCH_QUERY,
  TEAM_QUERY,
  UPDATE_QUERY,
  apiUrl,
  assembleList,
  authHeader,
  brief,
  authorizationCodeFields,
  authorizeUrl,
  cleanClientId,
  cleanSecret,
  codeFromCallback,
  commentBody,
  completedSince,
  counts,
  detailOf,
  formBody,
  issueKeyFromBranch,
  matchQuery,
  normalizeBoot,
  normalizeView,
  parseIssueRef,
  pickTeam,
  pkcePair,
  readTokenPayload,
  redact,
  refreshFields,
  safeHttp,
  startWorkText,
  updateInput,
} from './logic.mjs';

const PAGE = 50;

const exec = (bin, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-400)));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || (signal ? '命令超时' : `退出码 ${code}`))),
    );
  });

function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  return JSON.stringify(body);
}

function isAuthError(data) {
  return (data?.errors ?? []).some((error) =>
    /authentication required|not authenticated|invalid api key|invalid token|access token expired|jwt expired/i.test(
      String(error?.message ?? ''),
    ),
  );
}

export function activate(enso) {
  const authFile = join(enso.dataDir, 'auth.json');
  const prefsFile = join(enso.dataDir, 'prefs.json');
  let auth = null;
  let pending = null;
  let server = null;
  let oauthError = '';
  let bootCache = null;
  let summaryCache = null;
  let refreshing = null;
  let exchangeJob = null;
  const loaded = readFile(authFile, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      if (parsed?.accessToken) {
        auth = {
          accessToken: String(parsed.accessToken),
          refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : '',
          expiresAt: Number(parsed.expiresAt) || 0,
          clientId: cleanClientId(parsed.clientId),
          viewerName: parsed.viewerName ? String(parsed.viewerName).slice(0, 80) : null,
        };
      }
    })
    .catch(() => {});

  const saveAuth = async (next) => {
    const tokenChanged = next?.accessToken !== auth?.accessToken;
    auth = next;
    if (tokenChanged) bootCache = null;
    if (!next) {
      summaryCache = null;
      await rm(authFile, { force: true });
      return;
    }
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${authFile}.${process.pid}.tmp`;
    const payload = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken || '',
      expiresAt: next.expiresAt,
      clientId: next.clientId,
      viewerName: next.viewerName ?? null,
    };
    try {
      await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
      await rename(tmp, authFile);
      await chmod(authFile, 0o600);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  };

  const loadPrefs = async () => {
    try {
      const parsed = JSON.parse(await readFile(prefsFile, 'utf8'));
      return { teamId: typeof parsed?.teamId === 'string' ? parsed.teamId : null };
    } catch {
      return { teamId: null };
    }
  };
  const savePrefs = async (prefs) => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${prefsFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ teamId: prefs.teamId || null }));
    await rename(tmp, prefsFile);
  };

  const readConfig = async () => {
    try {
      const cfg = (await enso.config.get()) ?? {};
      return { apiKey: cleanSecret(cfg.apiKey), clientId: cleanClientId(cfg.oauthClientId) };
    } catch {
      return { apiKey: '', clientId: '' };
    }
  };

  async function apiFetch(path, init) {
    const url = apiUrl(path);
    if (!url.startsWith(`${API_ORIGIN}/`)) throw new Error('拒绝访问非 Linear API 的地址');
    const res = await enso.net.fetch(url, init);
    const body = bodyText(res?.body);
    if (body.length > 2_000_000) throw new Error('Linear 响应过大');
    return { status: Number(res?.status) || 0, body };
  }

  async function rawGql(cred, query, variables) {
    const res = await apiFetch('/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: authHeader(cred),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    let data;
    try {
      data = res.body ? JSON.parse(res.body) : {};
    } catch {
      throw new Error(`Linear HTTP ${res.status || '错误'}`);
    }
    const secrets = [cred.token, cred.refreshToken].filter(Boolean);
    if (res.status === 401 || isAuthError(data)) throw Object.assign(new Error('Linear 认证已失效'), { code: 'UNAUTHORIZED' });
    if (res.status >= 400 || data.errors?.length) {
      const msg = (data.errors ?? []).map((error) => error?.message).filter(Boolean).join('；') || `Linear HTTP ${res.status}`;
      throw new Error(redact(msg, secrets));
    }
    return data.data ?? {};
  }

  const needsRefresh = (record) => !record?.expiresAt || record.expiresAt - Date.now() < 60_000;

  async function refresh(current) {
    if (!current?.refreshToken || !current.clientId) throw new Error('登录已失效，请重新登录');
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const res = await apiFetch('/oauth/token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(refreshFields({ refreshToken: current.refreshToken, clientId: current.clientId })),
      });
      const token = readTokenPayload(res.body);
      await saveAuth({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || current.refreshToken,
        expiresAt: token.expiresAt,
        clientId: current.clientId,
        viewerName: current.viewerName ?? null,
      });
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function credential() {
    await loaded;
    if (auth?.accessToken) {
      if (needsRefresh(auth)) {
        try {
          await refresh(auth);
        } catch {
          await saveAuth(null);
          oauthError = '登录已失效，请重新登录';
        }
      }
      if (auth?.accessToken) {
        return { kind: 'oauth', token: auth.accessToken, refreshToken: auth.refreshToken || '', source: 'oauth' };
      }
    }
    const cfg = await readConfig();
    if (cfg.apiKey) return { kind: 'key', token: cfg.apiKey, source: 'config' };
    const env = cleanSecret(process.env.LINEAR_API_KEY);
    if (env) return { kind: 'key', token: env, source: 'env' };
    return null;
  }

  async function gql(query, variables, allowRefresh = true) {
    const cred = await credential();
    if (!cred) throw new Error('未连接 Linear：在插件设置填写 Personal API Key，或用 OAuth 登录');
    try {
      return await rawGql(cred, query, variables);
    } catch (error) {
      if (error.code === 'UNAUTHORIZED' && cred.kind === 'oauth' && allowRefresh && auth?.refreshToken) {
        try {
          await refresh(auth);
          return gql(query, variables, false);
        } catch {
          await saveAuth(null);
          const fallback = await credential();
          if (fallback?.kind === 'key') return rawGql(fallback, query, variables);
          throw new Error('登录已失效，请重新登录');
        }
      }
      if (error.code === 'UNAUTHORIZED' && cred.source === 'config') throw new Error('API Key 无效或已撤销，请到 设置 → 插件 → Linear 更换');
      if (error.code === 'UNAUTHORIZED' && cred.source === 'env') throw new Error('环境变量 LINEAR_API_KEY 无效或已撤销');
      if (error.code === 'UNAUTHORIZED') throw new Error('Linear 认证已失效，请重新登录');
      throw error;
    }
  }

  async function boot(force = false) {
    const cred = await credential();
    if (!cred) return null;
    const fp = fingerprint(cred.token);
    if (!force && bootCache && bootCache.fp === fp && Date.now() - bootCache.at < 60_000) return bootCache.data;
    const data = normalizeBoot(await gql(BOOT_QUERY, {}));
    const current = await credential();
    bootCache = { fp: fingerprint(current?.token || cred.token), at: Date.now(), data };
    if (data.viewer?.name && auth?.accessToken && auth.viewerName !== data.viewer.name) {
      await saveAuth({ ...auth, viewerName: data.viewer.name });
    }
    return data;
  }

  async function currentBranch(ctx) {
    if (!ctx?.projectRoot) return null;
    try {
      const name = await exec('git', ['symbolic-ref', '--short', 'HEAD'], ctx.projectRoot);
      return name && name !== 'HEAD' ? name : null;
    } catch {
      return null;
    }
  }

  async function mineSummary(nodes) {
    if (nodes) {
      summaryCache = { at: Date.now(), value: counts(nodes.map((issue) => ({ ...issue, state: issue.state }))) };
      return summaryCache.value;
    }
    if (summaryCache && Date.now() - summaryCache.at < 30_000) return summaryCache.value;
    const data = await gql(MINE_OPEN_QUERY, {
      first: PAGE,
      filter: { state: { type: { nin: ['completed', 'canceled'] } } },
    });
    const value = counts(data.viewer?.assignedIssues?.nodes ?? []);
    summaryCache = { at: Date.now(), value };
    return value;
  }

  const nodesOf = (connection) => ({
    nodes: connection?.nodes ?? [],
    truncated: Boolean(connection?.pageInfo?.hasNextPage),
  });

  async function loadIssues(view, team) {
    if (view === 'cycle') {
      const data = await gql(CYCLE_QUERY, { id: team.id, first: PAGE });
      const cycle = data.team?.activeCycle ?? null;
      const page = nodesOf(cycle?.issues);
      return { issues: page.nodes, cycle, truncated: page.truncated };
    }
    if (view === 'backlog' || view === 'triage') {
      const type = view === 'backlog' ? 'backlog' : 'triage';
      const data = await gql(TEAM_QUERY, { id: team.id, first: PAGE, filter: { state: { type: { eq: type } } } });
      const page = nodesOf(data.team?.issues);
      return { issues: page.nodes, cycle: null, truncated: page.truncated };
    }
    const teamFilter = team ? { team: { id: { eq: team.id } } } : {};
    const [open, done] = await Promise.all([
      gql(MINE_OPEN_QUERY, {
        first: PAGE,
        filter: { ...teamFilter, state: { type: { nin: ['completed', 'canceled'] } } },
      }),
      gql(MINE_DONE_QUERY, {
        first: 25,
        filter: {
          ...teamFilter,
          state: { type: { in: ['completed', 'canceled'] } },
          updatedAt: { gte: completedSince() },
        },
      }),
    ]);
    const openPage = nodesOf(open.viewer?.assignedIssues);
    const donePage = nodesOf(done.viewer?.assignedIssues);
    await mineSummary(openPage.nodes);
    return {
      issues: [...openPage.nodes, ...donePage.nodes],
      cycle: null,
      truncated: openPage.truncated || donePage.truncated,
    };
  }

  async function pinnedExtra(issues, branchKey) {
    if (!branchKey) return null;
    if (issues.some((issue) => String(issue.identifier).toUpperCase() === branchKey)) return null;
    try {
      const data = await gql(BRIEF_QUERY, { id: branchKey });
      return data.issue ?? null;
    } catch {
      return null;
    }
  }

  const list = async (args, ctx) => {
    const view = normalizeView(args?.view);
    const info = await boot();
    const prefs = await loadPrefs();
    const requested = args?.team != null ? args.team : prefs.teamId;
    const team = pickTeam(info?.teams ?? [], requested, view, Boolean(args?.strict));
    if ((view === 'cycle' || view === 'backlog' || view === 'triage') && !team) throw new Error('没有可用的 Linear 团队');
    const branch = await currentBranch(ctx);
    const branchKey = issueKeyFromBranch(branch);
    const loadedIssues = await loadIssues(view, team);
    const extra = await pinnedExtra(loadedIssues.issues, branchKey);
    let issues = loadedIssues.issues;
    if (args?.query) issues = issues.filter((issue) => matchQuery(issue, args.query));
    const summary = view === 'mine' ? summaryCache?.value ?? counts(issues) : await mineSummary().catch(() => summaryCache?.value ?? null);
    return {
      ...assembleList({ view, issues, branchKey, extra, cycle: loadedIssues.cycle, truncated: loadedIssues.truncated }),
      team: team ? { id: team.id, key: team.key, name: team.name } : null,
      summary,
      branch,
    };
  };

  const search = async (args) => {
    const term = String(args?.query ?? args?.term ?? '').trim().slice(0, 200);
    if (!term) throw new Error('请输入搜索词');
    const info = await boot();
    const team = args?.team ? pickTeam(info?.teams ?? [], args.team, 'mine', true) : null;
    const data = await gql(SEARCH_QUERY, { term, first: 20, filter: team ? { team: { id: { eq: team.id } } } : null });
    return { items: (data.searchIssues?.nodes ?? []).map((issue) => brief(issue)) };
  };

  const viewIssue = async (args) => {
    const id = parseIssueRef(args?.id ?? args?.identifier);
    const data = await gql(DETAIL_QUERY, { id });
    if (!data.issue) throw new Error(`找不到议题 ${id}`);
    return detailOf(data.issue);
  };

  const updateIssue = async (args) => {
    const id = parseIssueRef(args?.id ?? args?.identifier);
    const input = updateInput(args);
    const result = await gql(UPDATE_QUERY, { id, input });
    if (!result.issueUpdate || result.issueUpdate.success === false) throw new Error('Linear 没有接受这次修改');
    summaryCache = null;
    return viewIssue({ id });
  };

  const comment = async (args) => {
    const id = parseIssueRef(args?.id ?? args?.identifier);
    const body = commentBody(args?.body);
    const current = await viewIssue({ id });
    const result = await gql(COMMENT_QUERY, { input: { issueId: current.id, body } });
    if (!result.commentCreate || result.commentCreate.success === false) throw new Error('评论没有发出去');
    return viewIssue({ id: current.id });
  };

  const start = async (args, ctx) => {
    const issue = await viewIssue(args);
    const branch = await currentBranch(ctx);
    const text = startWorkText(issue, branch);
    if (args?.target === 'draft') {
      await enso.composer.insertText({ text });
      return { target: 'draft', identifier: issue.identifier, branch: issue.branchName || null };
    }
    const created = await enso.session.create({ text });
    return { target: 'new', sessionId: created?.sessionId ?? null, identifier: issue.identifier, branch: issue.branchName || null };
  };

  const closeServer = () => {
    if (!server) return;
    const current = server;
    server = null;
    current.close();
  };

  async function exchange(code, flow) {
    const res = await apiFetch('/oauth/token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody(authorizationCodeFields({ code, redirect: OAUTH_REDIRECT, clientId: flow.clientId, verifier: flow.verifier })),
    });
    const token = readTokenPayload(res.body);
    await saveAuth({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      clientId: flow.clientId,
      viewerName: null,
    });
    try {
      await boot(true);
    } catch {
      // 令牌已保存，名字等下次打开面板再取
    }
  }

  function takeCode(code) {
    if (!pending) throw new Error('没有进行中的登录');
    if (exchangeJob) return exchangeJob;
    const flow = pending;
    exchangeJob = exchange(code, flow)
      .then(() => {
        oauthError = '';
        pending = null;
        closeServer();
      })
      .catch((error) => {
        oauthError = redact(error.message || '登录失败', [flow.verifier, flow.clientId]);
        pending = null;
        closeServer();
        throw error;
      })
      .finally(() => {
        exchangeJob = null;
      });
    return exchangeJob;
  }

  function openCallback(flow) {
    const callback = createServer((req, res) => {
      const fail = () => {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>Linear</title><p>授权没有完成，请回到 EnsoCode 重试。</p>');
      };
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH_PORT}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const code = codeFromCallback(`${OAUTH_REDIRECT}${url.search}`, flow.state);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>Linear</title><p>授权完成，可以回到 EnsoCode。</p>');
        takeCode(code).catch(() => {});
      } catch {
        fail();
      }
    });
    callback.on('error', (error) => {
      if (pending === flow) {
        flow.listenError = error.code === 'EADDRINUSE' ? '本机 47321 端口被占用，请把浏览器地址栏里的回调地址粘贴到下方' : '无法监听本机回调，请粘贴浏览器地址栏里的回调地址';
      }
    });
    callback.listen(OAUTH_PORT, '127.0.0.1');
    callback.unref();
    const timer = setTimeout(() => {
      if (pending === flow) {
        oauthError = '授权超时，请重新登录';
        pending = null;
      }
      callback.close();
    }, 5 * 60 * 1000);
    timer.unref();
    callback.on('close', () => clearTimeout(timer));
    return callback;
  }

  const login = async () => {
    const cfg = await readConfig();
    if (!cfg.clientId) {
      throw new Error(`请先在插件设置填写 OAuth Client ID（公开标识，不要填写 Client Secret）。回调地址设为 ${OAUTH_REDIRECT}`);
    }
    closeServer();
    const flow = { ...pkcePair(), clientId: cfg.clientId, expiresAt: Date.now() + 5 * 60 * 1000, listenError: '' };
    pending = flow;
    oauthError = '';
    server = openCallback(flow);
    await enso.ui.openExternal(authorizeUrl({ clientId: cfg.clientId, challenge: flow.challenge, state: flow.state })).catch(() => {});
    return { redirect: OAUTH_REDIRECT, expiresAt: flow.expiresAt };
  };

  const publicState = async (_args, ctx) => {
    const cfg = await readConfig();
    const cred = await credential().catch(() => null);
    const branch = await currentBranch(ctx);
    let info = null;
    let error = oauthError;
    if (cred) {
      try {
        info = await boot();
      } catch (err) {
        error = err.message;
      }
    }
    const prefs = await loadPrefs();
    return {
      source: cred?.source ?? null,
      viewer: info?.viewer ?? (auth?.viewerName ? { name: auth.viewerName } : null),
      organization: info?.organization ?? null,
      teams: info?.teams ?? [],
      teamId: prefs.teamId,
      branch,
      branchIssue: issueKeyFromBranch(branch),
      pending: pending
        ? { redirect: OAUTH_REDIRECT, expiresAt: pending.expiresAt, listenError: pending.listenError || '' }
        : null,
      error: error || '',
      oauthReady: Boolean(cfg.clientId),
      redirectUri: OAUTH_REDIRECT,
      summary: summaryCache?.value ?? null,
    };
  };

  enso.tools.register('linear_list', (args, ctx) => list({ ...args, strict: Boolean(args?.team) }, ctx));
  enso.tools.register('linear_search', (args) => search({ ...args, team: args?.team }));
  enso.tools.register('linear_view', (args) => viewIssue(args));
  enso.tools.register('linear_comment', (args) => comment(args));
  enso.tools.register('linear_update', (args) => updateIssue(args));
  enso.tools.register('linear_start', (args, ctx) => start({ ...args, target: 'new' }, ctx));

  enso.renderer.handle('state', publicState);
  enso.renderer.handle('login', login);
  enso.renderer.handle('submitCode', async (args) => {
    if (!pending) throw new Error('没有进行中的登录');
    const code = codeFromCallback(args?.text ?? args?.callback ?? '', pending.state);
    await takeCode(code);
    return { ok: true };
  });
  enso.renderer.handle('cancelLogin', () => {
    pending = null;
    closeServer();
    return null;
  });
  enso.renderer.handle('logout', async () => {
    const token = auth?.accessToken;
    const refreshToken = auth?.refreshToken;
    pending = null;
    closeServer();
    if (token) {
      await apiFetch('/oauth/revoke', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody({ token, token_type_hint: 'access_token' }),
      }).catch(() => {});
      if (refreshToken && refreshToken !== token) {
        await apiFetch('/oauth/revoke', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: formBody({ token: refreshToken, token_type_hint: 'refresh_token' }),
        }).catch(() => {});
      }
    }
    await saveAuth(null);
    oauthError = '';
    return { ok: true };
  });
  enso.renderer.handle('setTeam', async (args) => {
    const teamId = String(args?.teamId ?? '').trim();
    if (teamId && !/^[0-9a-f-]{36}$/i.test(teamId)) throw new Error('团队 id 无效');
    await savePrefs({ teamId: teamId || null });
    return { teamId: teamId || null };
  });
  enso.renderer.handle('list', (args, ctx) => list(args, ctx));
  enso.renderer.handle('search', (args) => search(args));
  enso.renderer.handle('view', (args) => viewIssue(args));
  enso.renderer.handle('comment', (args) => comment(args));
  enso.renderer.handle('update', (args) => updateIssue(args));
  enso.renderer.handle('start', (args, ctx) => start(args, ctx));
  enso.renderer.handle('open', async (args) => {
    const url = safeHttp(args?.url);
    if (url) await enso.ui.openExternal(url);
    return null;
  });
}
