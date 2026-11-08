import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_ID = 'Ov23liudxhEHEczTvPcC';
const API = 'https://api.github.com';
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
const MAX_BODY = 65536;
const LOG_CHARS = 60000;
const ERROR_CONTEXT = 40;
const LOG_STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const RUN_ACTIONS = { rerun: 'rerun', rerun_failed: 'rerun-failed-jobs', cancel: 'cancel' };
const ANNO_LEVELS = new Set(['failure', 'warning']);

const exec = (bin, args, cwd, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 10000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || (signal ? `超时（${signal}）` : `退出码 ${code}`))),
    );
  });

export function trimLog(text, lines = 150) {
  const cap = Math.min(1000, Math.max(1, Number.isInteger(lines) && lines > 0 ? lines : 150));
  const all = String(text ?? '')
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replace(LOG_STAMP, '').replace(/\r$/, ''));
  const hits = [];
  all.forEach((l, i) => {
    if (l.includes('##[error]')) hits.push(i);
  });
  let truncated = false;
  let log;
  if (hits.length) {
    const ranges = [];
    for (const i of hits) {
      const start = Math.max(0, i - ERROR_CONTEXT);
      const last = ranges.at(-1);
      if (last && start <= last[1] + 1) last[1] = i;
      else ranges.push([start, i]);
    }
    log = ranges.map(([a, b]) => all.slice(a, b + 1).join('\n')).join('\n…\n');
    truncated = ranges[0][0] > 0 || ranges.at(-1)[1] < all.length - 1;
  } else {
    truncated = all.length > cap;
    log = all.slice(-cap).join('\n');
  }
  if (log.length > LOG_CHARS) {
    log = log.slice(-LOG_CHARS);
    truncated = true;
  }
  return { truncated, log };
}

/** 支持 https / ssh / git@ 形式的 github.com 远程地址 */
export function parseRemote(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function activate(enso) {
  const file = join(enso.dataDir, 'auth.json');
  let auth = null; // { token, login }
  let ghToken; // undefined 未探测；null 没有
  let pending = null; // { userCode, uri, expiresAt }
  let loginError = '';

  const loaded = readFile(file, 'utf8')
    .then((s) => {
      const a = JSON.parse(s);
      auth = a?.token ? a : null;
    })
    .catch(() => {});
  const saveAuth = async (next) => {
    auth = next;
    if (!next) return rm(file, { force: true });
    await mkdir(enso.dataDir, { recursive: true });
    await writeFile(file, JSON.stringify(next), { mode: 0o600 });
  };

  let ghBin;
  const findGh = async () => {
    if (ghBin !== undefined) return ghBin;
    for (const bin of GH_PATHS) {
      try {
        await exec(bin, ['--version']);
        return (ghBin = bin);
      } catch {}
    }
    return (ghBin = null);
  };

  const ghAuthToken = async () => {
    if (ghToken !== undefined) return ghToken;
    const bin = await findGh();
    if (!bin) return (ghToken = null);
    try {
      return (ghToken = (await exec(bin, ['auth', 'token', '--hostname', 'github.com'])) || null);
    } catch {
      return (ghToken = null);
    }
  };

  /** 优先级：设备登录 → 设置里的 PAT → 环境变量 → gh auth token */
  const credential = async () => {
    await loaded;
    if (auth?.token) return { token: auth.token, source: 'device' };
    const { token } = (await enso.config.get()) ?? {};
    if (token) return { token, source: 'config' };
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (env) return { token: env, source: 'env' };
    const gh = await ghAuthToken();
    return gh ? { token: gh, source: 'gh' } : null;
  };

  const requireCred = async () => {
    const cred = await credential();
    if (!cred) throw new Error('未登录 GitHub：在 GitHub 面板里登录，或安装 gh 并执行 gh auth login');
    return cred;
  };

  const call = async (method, path, body, accept = 'application/vnd.github+json') => {
    const cred = await requireCred();
    const res = await enso.net.fetch(`${API}${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${cred.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'enso-github',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = res.body ? JSON.parse(res.body) : null;
    } catch {}
    if (res.status === 401) {
      if (cred.source === 'device') await saveAuth(null);
      if (cred.source === 'gh') ghToken = undefined;
    }
    if (res.status >= 400) throw new Error(`GitHub ${res.status}：${data?.message ?? '请求失败'}`);
    return data;
  };

  const post = async (url, params) => {
    const res = await enso.net.fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'enso-github' },
      body: JSON.stringify({ client_id: CLIENT_ID, ...params }),
    });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`GitHub 返回 HTTP ${res.status}`);
    }
  };

  const poll = async (deviceCode, interval, expiresAt) => {
    while (pending && Date.now() < expiresAt) {
      await sleep(interval * 1000);
      if (!pending) return;
      try {
        const r = await post('https://github.com/login/oauth/access_token', {
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (r.access_token) {
          await saveAuth({ token: r.access_token });
          pending = null;
          const me = await call('GET', '/user').catch(() => null);
          if (me?.login) await saveAuth({ token: r.access_token, login: me.login });
          return;
        }
        if (r.error === 'slow_down') interval = r.interval ?? interval + 5;
        else if (r.error !== 'authorization_pending') throw new Error(r.error_description ?? r.error);
      } catch (e) {
        loginError = e.message;
        pending = null;
        return;
      }
    }
    if (pending) loginError = '验证码已过期，请重新登录';
    pending = null;
  };

  const login = async () => {
    const r = await post('https://github.com/login/device/code', { scope: 'repo' });
    if (!r.device_code) throw new Error(r.error_description ?? r.error ?? '无法发起登录');
    const expiresAt = Date.now() + r.expires_in * 1000;
    pending = { userCode: r.user_code, uri: r.verification_uri, expiresAt };
    loginError = '';
    poll(r.device_code, r.interval ?? 5, expiresAt);
    await enso.ui.openExternal(r.verification_uri).catch(() => {});
    return pending;
  };

  const repoOf = async (args, ctx) => {
    const given = String(args?.repo ?? '').trim();
    if (given) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(given)) throw new Error(`repo 格式应为 owner/name：${given}`);
      return given;
    }
    if (!ctx?.projectRoot) throw new Error('没有打开项目，请指定 repo（owner/name）');
    const url = await exec('git', ['remote', 'get-url', 'origin'], ctx.projectRoot).catch(() => '');
    const repo = parseRemote(url);
    if (!repo) throw new Error('当前项目的 origin 不是 GitHub 仓库，请指定 repo（owner/name）');
    return repo;
  };
  const num = (v, name = 'number') => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 必须是正整数`);
    return n;
  };

  const brief = (i, pr) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    pr: Boolean(pr || i.pull_request),
    draft: Boolean(i.draft),
    author: i.user?.login,
    labels: (i.labels ?? []).map((l) => l.name),
    comments: i.comments,
    updatedAt: i.updated_at,
    url: i.html_url,
  });

  const list = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const state = ['open', 'closed', 'all'].includes(args?.state) ? args.state : 'open';
    const pr = args?.kind === 'pr';
    const items = await call('GET', `/repos/${repo}/${pr ? 'pulls' : 'issues'}?state=${state}&per_page=50&sort=updated&direction=desc`);
    return { repo, items: items.filter((i) => pr || !i.pull_request).map((i) => brief(i, pr)) };
  };

  /** html 为 true 时附带 GitHub 渲染好的 body_html，供面板显示 */
  const view = async (args, ctx, html = false) => {
    const repo = await repoOf(args, ctx);
    const n = num(args?.number);
    const accept = html ? 'application/vnd.github.full+json' : undefined;
    const [issue, comments] = await Promise.all([
      call('GET', `/repos/${repo}/issues/${n}`, null, accept),
      call('GET', `/repos/${repo}/issues/${n}/comments?per_page=100`, null, accept),
    ]);
    const out = { repo, ...brief(issue), body: issue.body ?? '', stateReason: issue.state_reason ?? null };
    if (html) out.bodyHtml = issue.body_html ?? '';
    if (issue.pull_request) {
      const p = await call('GET', `/repos/${repo}/pulls/${n}`);
      Object.assign(out, {
        draft: p.draft,
        merged: p.merged,
        head: p.head?.label,
        base: p.base?.ref,
        changes: { files: p.changed_files, additions: p.additions, deletions: p.deletions },
      });
    }
    out.commentList = comments.map((c) => ({
      author: c.user?.login,
      createdAt: c.created_at,
      body: c.body ?? '',
      ...(html ? { bodyHtml: c.body_html ?? '' } : {}),
    }));
    return out;
  };

  const comment = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const body = String(args?.body ?? '').trim().slice(0, MAX_BODY);
    if (!body) throw new Error('body 不能为空');
    const c = await call('POST', `/repos/${repo}/issues/${num(args?.number)}/comments`, { body });
    return { url: c.html_url };
  };

  const setState = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const n = num(args?.number);
    const state = args?.state === 'open' ? 'open' : 'closed';
    if (String(args?.comment ?? '').trim()) await comment({ repo, number: n, body: args.comment });
    const issue = await call('GET', `/repos/${repo}/issues/${n}`);
    if (issue.pull_request) await call('PATCH', `/repos/${repo}/pulls/${n}`, { state });
    else {
      const reason = state === 'open' ? 'reopened' : args?.reason === 'not_planned' ? 'not_planned' : 'completed';
      await call('PATCH', `/repos/${repo}/issues/${n}`, { state, state_reason: reason });
    }
    return { repo, number: n, state, pr: Boolean(issue.pull_request) };
  };

  const runBrief = (r) => ({
    id: r.id,
    name: r.name,
    title: r.display_title,
    number: r.run_number,
    attempt: r.run_attempt,
    event: r.event,
    branch: r.head_branch,
    sha: String(r.head_sha ?? '').slice(0, 7),
    status: r.status,
    conclusion: r.conclusion,
    actor: r.actor?.login,
    updatedAt: r.updated_at,
    url: r.html_url,
  });

  const runs = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const q = ['per_page=30'];
    if (args?.branch) q.push(`branch=${encodeURIComponent(args.branch)}`);
    if (args?.status) q.push(`status=${encodeURIComponent(args.status)}`);
    const data = await call('GET', `/repos/${repo}/actions/runs?${q.join('&')}`);
    return { repo, items: (data.workflow_runs ?? []).map(runBrief) };
  };

  const run = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const id = num(args?.id, 'id');
    const [raw, jobs] = await Promise.all([
      call('GET', `/repos/${repo}/actions/runs/${id}`),
      call('GET', `/repos/${repo}/actions/runs/${id}/jobs?per_page=100`),
    ]);
    const list = (jobs.jobs ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      url: j.html_url,
      steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
    }));
    await Promise.all(
      list
        .filter((j) => j.conclusion === 'failure')
        .map(async (j) => {
          // fine-grained PAT 没有 Checks 读权限时 403，不影响作业和步骤
          const ann = await call('GET', `/repos/${repo}/check-runs/${j.id}/annotations?per_page=100`).catch(() => []);
          const kept = (Array.isArray(ann) ? ann : []).filter((a) => ANNO_LEVELS.has(a.annotation_level));
          if (kept.length) {
            j.annotations = kept.map((a) => ({ level: a.annotation_level, message: a.message, path: a.path, line: a.start_line }));
          }
        }),
    );
    return { ...runBrief(raw), jobs: list };
  };

  const jobLog = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const job = num(args?.job, 'job');
    const cred = await requireCred();
    const bin = await findGh();
    if (!bin) throw new Error('读取日志需要安装 gh CLI；可先看 annotations 或在浏览器打开');
    const text = await exec(bin, ['api', `repos/${repo}/actions/jobs/${job}/logs`], undefined, {
      env: { GH_TOKEN: cred.token },
      timeout: 20000,
    });
    return { repo, job, ...trimLog(text, args?.lines) };
  };

  const runAction = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const id = num(args?.id, 'id');
    const path = RUN_ACTIONS[args?.action];
    if (!path) throw new Error(`action 必须是 ${Object.keys(RUN_ACTIONS).join('、')}`);
    await call('POST', `/repos/${repo}/actions/runs/${id}/${path}`);
    return { repo, id, action: args.action };
  };

  enso.tools.register('github_list', list);
  enso.tools.register('github_view', (args, ctx) => view(args, ctx));
  enso.tools.register('github_comment', comment);
  enso.tools.register('github_set_state', setState);
  enso.tools.register('github_runs', runs);
  enso.tools.register('github_run', run);
  enso.tools.register('github_job_log', jobLog);
  enso.tools.register('github_run_action', runAction);

  enso.renderer.handle('state', async (_args, ctx) => {
    const cred = await credential();
    let repo = null;
    if (ctx?.projectRoot) repo = parseRemote(await exec('git', ['remote', 'get-url', 'origin'], ctx.projectRoot).catch(() => ''));
    return { source: cred?.source ?? null, login: auth?.login ?? null, pending, error: loginError, repo };
  });
  enso.renderer.handle('login', login);
  enso.renderer.handle('cancelLogin', () => ((pending = null), null));
  enso.renderer.handle('logout', async () => {
    await saveAuth(null);
    return null;
  });
  enso.renderer.handle('list', list);
  enso.renderer.handle('view', (args, ctx) => view(args, ctx, true));
  enso.renderer.handle('comment', comment);
  enso.renderer.handle('setState', setState);
  enso.renderer.handle('runs', runs);
  enso.renderer.handle('run', run);
  enso.renderer.handle('jobLog', jobLog);
  enso.renderer.handle('runAction', runAction);
  enso.renderer.handle('open', async (args) => {
    const url = String(args?.url ?? '');
    if (/^https?:\/\//.test(url)) await enso.ui.openExternal(url);
    return null;
  });
}
