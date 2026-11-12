import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_ID = 'Ov23liudxhEHEczTvPcC';
const API = 'https://api.github.com';
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' };
const MAX_TEMPLATES = 20;
const MAX_TEMPLATE = 8000;
const MAX_NAME = 40;
/** session.create 的 text 上限是 32KB，留出余量 */
export const MAX_PROMPT_BYTES = 32000;
export const DEFAULT_TEMPLATE = [
  '请处理 {{issue_url}}。',
  '',
  '仓库：{{repo}}',
  '编号：#{{issue_number}}',
  '标题：{{issue_title}}',
  '分支：{{branch}}',
  '',
  '{{issue_body}}',
  '',
  '请遵循仓库里已有的约定。先阅读相关代码再修改；做完后说明改了什么、如何验证。不要切换到别的分支。',
].join('\n');

const exec = (bin, args, cwd, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 20000,
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

/** 支持 https / ssh / git@ 形式的 github.com 远程地址 */
export function parseRemote(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function num(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('number 必须是正整数');
  return n;
}

/** 只允许我们自己生成的、不会被 git 当成选项或路径的分支名 */
export function assertBranch(name) {
  const s = String(name ?? '');
  const parts = s.split('/');
  const ok =
    s.length > 0 &&
    s.length <= 80 &&
    parts.every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part) && !part.endsWith('.lock') && !part.endsWith('.')) &&
    !s.includes('..') &&
    !s.includes('@{') &&
    !s.includes('//');
  if (!ok) throw new Error(`分支名不合法：${s}`);
  return s;
}

export function suggestBranch(number, title) {
  const n = num(number);
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return assertBranch(slug ? `issue/${n}-${slug}` : `issue/${n}`);
}

export function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (raw, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : raw,
  );
}

export function fitPrompt(template, vars, limit = MAX_PROMPT_BYTES) {
  const chars = [...String(vars.issue_body ?? '')];
  const render = (issue_body) => renderTemplate(template, { ...vars, issue_body });
  const size = (text) => Buffer.byteLength(text);
  if (size(render(chars.join(''))) <= limit) return render(chars.join(''));
  const marker = '\n…（正文已截断）';
  let lo = 0;
  let hi = chars.length;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const text = render(chars.slice(0, mid).join('') + marker);
    if (size(text) <= limit) {
      best = text;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best != null) return best;
  return clipBytes(render(''), limit);
}

function clipBytes(text, limit) {
  const buf = Buffer.from(text);
  if (buf.length <= limit) return text;
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export function buildPrompt(template, fields, limit = MAX_PROMPT_BYTES) {
  return fitPrompt(
    template,
    {
      issue_url: fields.url ?? '',
      issue_number: String(fields.number ?? ''),
      issue_title: fields.title ?? '',
      issue_body: fields.body ?? '',
      repo: fields.repo ?? '',
      branch: fields.branch || '（游离 HEAD）',
    },
    limit,
  );
}

export function matchIssue(item, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    item.title,
    `#${item.number}`,
    String(item.number),
    item.author,
    ...(item.labels ?? []),
    ...(item.assignees ?? []),
  ]
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * 只描述当前检出上的分支操作。没有 worktree 动作：
 * session.create 不能把新会话指到另一个目录。
 */
export function checkoutPlan({ dirty, current, exists, branch }) {
  const cur = current || '';
  if (!branch) return { action: 'stay', branch: cur || null };
  if (cur === branch) return { action: 'stay', branch };
  if (dirty) {
    throw new Error('工作区有未提交的改动，已取消切换分支。请先提交或清理，或关闭「先创建并切换分支」。');
  }
  return { action: exists ? 'switch' : 'create', branch };
}

export async function applyCheckout(run, cwd, plan) {
  // 分支名以 issue/ 开头，不能带前导短横线，所以不必再加 `--`。
  // `git switch -c -- <name>` 会把名字当成起点提交，创建失败。
  if (plan.action === 'create') await run(['switch', '-c', plan.branch], cwd);
  else if (plan.action === 'switch') await run(['switch', plan.branch], cwd);
  return plan;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshStore() {
  return {
    templates: [{ id: 'default', name: '默认', body: DEFAULT_TEMPLATE }],
    selected: {},
    createBranch: false,
  };
}

export function normalizeStore(raw) {
  const templates = [];
  const seen = new Set();
  for (const item of Array.isArray(raw?.templates) ? raw.templates : []) {
    if (!item || typeof item.id !== 'string' || typeof item.body !== 'string' || !String(item.body).trim()) continue;
    const id = item.id.trim().slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    templates.push({
      id,
      name: String(item.name || '未命名').trim().slice(0, MAX_NAME) || '未命名',
      body: String(item.body).slice(0, MAX_TEMPLATE),
    });
    if (templates.length >= MAX_TEMPLATES) break;
  }
  if (!templates.length) return freshStore();
  const selected = {};
  if (raw.selected && typeof raw.selected === 'object' && !Array.isArray(raw.selected)) {
    for (const [key, value] of Object.entries(raw.selected)) {
      if (typeof value === 'string' && key.length <= 200 && !key.includes('\0')) selected[key] = value;
    }
  }
  return { templates, selected, createBranch: raw.createBranch === true };
}

function selectedId(store, repo) {
  const id = (repo && store.selected[repo]) || store.selected['*'] || store.templates[0].id;
  return store.templates.some((tpl) => tpl.id === id) ? id : store.templates[0].id;
}

function remember(store, repo, id) {
  store.selected['*'] = id;
  if (repo) store.selected[repo] = id;
}

function present(store, repo) {
  return {
    templates: store.templates.map(({ id, name, body }) => ({ id, name, body })),
    selectedId: selectedId(store, repo),
    createBranch: store.createBranch === true,
  };
}

function resolveTemplate(store, repo, args) {
  let id = selectedId(store, repo);
  if (typeof args?.templateId === 'string' && args.templateId) {
    if (!store.templates.some((tpl) => tpl.id === args.templateId)) throw new Error('模板不存在');
    id = args.templateId;
  }
  const tpl = store.templates.find((item) => item.id === id);
  const body = args?.body === undefined ? tpl.body : String(args.body);
  if (!body.trim()) throw new Error('提示词模板不能为空');
  if (body.length > MAX_TEMPLATE) throw new Error(`提示词模板最长 ${MAX_TEMPLATE} 字`);
  const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim().slice(0, MAX_NAME) : tpl.name;
  return { id, body, name };
}

function applyTemplate(store, repo, args) {
  const resolved = resolveTemplate(store, repo, args);
  const tpl = store.templates.find((item) => item.id === resolved.id);
  tpl.body = resolved.body;
  tpl.name = resolved.name;
  remember(store, repo, resolved.id);
  return resolved;
}

function newId(store) {
  let id = '';
  do id = `t${randomBytes(4).toString('hex')}`;
  while (store.templates.some((tpl) => tpl.id === id));
  return id;
}

function brief(issue) {
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
  return {
    number: issue.number,
    title: issue.title ?? '',
    state: issue.state,
    author: issue.user?.login ?? '',
    labels,
    assignees: (issue.assignees ?? []).map((user) => user.login).filter(Boolean),
    comments: issue.comments ?? 0,
    updatedAt: issue.updated_at ?? null,
    url: issue.html_url,
    suggestedBranch: suggestBranch(issue.number, issue.title ?? ''),
  };
}

/** `opts.run` 只在测试里替换 git。宿主调用 `activate(enso)`。 */
export function activate(enso, opts = {}) {
  const git = opts.run ?? ((args, cwd) => exec('git', args, cwd, { env: GIT_ENV }));
  const authFile = join(enso.dataDir, 'auth.json');
  const storeFile = join(enso.dataDir, 'templates.json');
  let auth = null;
  let ghToken;
  let pending = null;
  let loginError = '';
  let store = freshStore();

  const loaded = readFile(authFile, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      auth = parsed?.token ? parsed : null;
    })
    .catch(() => {});
  const storeReady = readFile(storeFile, 'utf8')
    .then((text) => {
      store = normalizeStore(JSON.parse(text));
    })
    .catch(() => {});

  const saveAuth = async (next) => {
    auth = next;
    if (!next) return rm(authFile, { force: true });
    await mkdir(enso.dataDir, { recursive: true });
    await writeFile(authFile, JSON.stringify(next), { mode: 0o600 });
  };
  const persist = async (next) => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${storeFile}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, storeFile);
    store = next;
  };

  let chain = Promise.resolve();
  const locked = (fn) => {
    const task = chain.then(fn);
    chain = task.catch(() => {});
    return task;
  };

  let ghBin;
  const findGh = async () => {
    if (ghBin !== undefined) return ghBin;
    for (const bin of GH_PATHS) {
      try {
        await exec(bin, ['--version']);
        return (ghBin = bin);
      } catch {
        /* 继续找 */
      }
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
    if (!cred) throw new Error('未登录 GitHub：在任务启动面板里登录，或安装 gh 并执行 gh auth login');
    return cred;
  };

  const call = async (method, path, body) => {
    const cred = await requireCred();
    const res = await enso.net.fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${cred.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'enso-tasklauncher',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* 非 JSON */
    }
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
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'enso-tasklauncher' },
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
        const result = await post('https://github.com/login/oauth/access_token', {
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (result.access_token) {
          await saveAuth({ token: result.access_token });
          pending = null;
          const me = await call('GET', '/user').catch(() => null);
          if (me?.login) await saveAuth({ token: result.access_token, login: me.login });
          return;
        }
        if (result.error === 'slow_down') interval = result.interval ?? interval + 5;
        else if (result.error !== 'authorization_pending') throw new Error(result.error_description ?? result.error);
      } catch (error) {
        loginError = error.message;
        pending = null;
        return;
      }
    }
    if (pending) loginError = '验证码已过期，请重新登录';
    pending = null;
  };

  const login = async () => {
    const result = await post('https://github.com/login/device/code', { scope: 'repo' });
    if (!result.device_code) throw new Error(result.error_description ?? result.error ?? '无法发起登录');
    const expiresAt = Date.now() + result.expires_in * 1000;
    pending = { userCode: result.user_code, uri: result.verification_uri, expiresAt };
    loginError = '';
    poll(result.device_code, Math.max(1, Number(result.interval) || 5), expiresAt);
    await enso.ui.openExternal(result.verification_uri).catch(() => {});
    return pending;
  };

  const repoOf = async (args, ctx) => {
    const given = String(args?.repo ?? '').trim();
    if (given) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(given)) throw new Error(`repo 格式应为 owner/name：${given}`);
      return given;
    }
    if (!ctx?.projectRoot) throw new Error('没有打开项目，请指定 repo（owner/name）');
    let url = '';
    try {
      url = await git(['remote', 'get-url', 'origin'], ctx.projectRoot);
    } catch {
      url = '';
    }
    const repo = parseRemote(url);
    if (!repo) throw new Error('当前项目的 origin 不是 GitHub 仓库，请指定 repo（owner/name）');
    return repo;
  };
  const quietRepo = async (args, ctx) => {
    if (String(args?.repo ?? '').trim()) return repoOf(args, ctx);
    try {
      return await repoOf(args, ctx);
    } catch {
      return null;
    }
  };

  const listIssues = async (args, ctx) => {
    const repo = await repoOf(args, ctx);
    const state = ['open', 'closed', 'all'].includes(args?.state) ? args.state : 'open';
    const data = await call('GET', `/repos/${repo}/issues?state=${state}&per_page=50&sort=updated&direction=desc`);
    if (!Array.isArray(data)) throw new Error('GitHub 没有返回 issue 列表');
    const items = data.filter((issue) => !issue.pull_request).map(brief).filter((issue) => matchIssue(issue, args?.query));
    return { repo, items };
  };

  const fetchIssue = async (repo, number) => {
    const issue = await call('GET', `/repos/${repo}/issues/${num(number)}`);
    if (issue?.pull_request) throw new Error('这是 Pull Request，任务启动只处理 issue');
    return { ...brief(issue), body: issue.body ?? '' };
  };

  const refExists = async (cwd, branch) => {
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
      return true;
    } catch {
      return false;
    }
  };

  const inspect = async (cwd, { createBranch, suggested }) => {
    let current = '';
    try {
      current = String(await git(['branch', '--show-current'], cwd)).trim();
    } catch (error) {
      if (createBranch) throw new Error(`无法读取当前分支：${error.message}`);
    }
    if (!createBranch) return { plan: checkoutPlan({ dirty: false, current, exists: false, branch: null }), blocked: false, reason: '' };
    let status = '';
    try {
      status = String(await git(['status', '--porcelain'], cwd));
    } catch (error) {
      throw new Error(`无法读取工作区状态：${error.message}`);
    }
    const exists = await refExists(cwd, suggested);
    try {
      return {
        plan: checkoutPlan({ dirty: Boolean(status.trim()), current, exists, branch: suggested }),
        blocked: false,
        reason: '',
      };
    } catch (error) {
      return { plan: { action: 'stay', branch: current || null }, blocked: true, reason: error.message };
    }
  };

  const shownBranch = (createBranch, info, suggested) =>
    !createBranch || info.blocked ? info.plan.branch || null : info.plan.branch || suggested;

  const preview = (args, ctx) =>
    locked(async () => {
      await storeReady;
      const repo = await repoOf(args, ctx);
      const resolved = resolveTemplate(store, repo, args);
      const issue = await fetchIssue(repo, args?.number);
      const createBranch = args?.createBranch === true;
      if (createBranch && !ctx?.projectRoot) throw new Error('没有打开项目，不能创建分支');
      const info = ctx?.projectRoot
        ? await inspect(ctx.projectRoot, { createBranch, suggested: issue.suggestedBranch })
        : { plan: { action: 'stay', branch: null }, blocked: false, reason: '' };
      const branch = shownBranch(createBranch, info, issue.suggestedBranch);
      return {
        repo,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        branch,
        action: info.plan.action,
        createBranch,
        blocked: info.blocked,
        reason: info.reason,
        suggestedBranch: issue.suggestedBranch,
        prompt: buildPrompt(resolved.body, { ...issue, repo, branch }),
      };
    });

  const launch = (args, ctx) =>
    locked(async () => {
      await storeReady;
      if (!ctx?.projectRoot) throw new Error('请先打开一个项目');
      const repo = await repoOf(args, ctx);
      const createBranch = args?.createBranch === true;
      const draft = structuredClone(store);
      draft.createBranch = createBranch;
      const resolved = applyTemplate(draft, repo, args);
      await persist(draft);

      const issue = await fetchIssue(repo, args?.number);
      let info = await inspect(ctx.projectRoot, { createBranch, suggested: issue.suggestedBranch });
      if (info.blocked) throw new Error(info.reason);
      info = await inspect(ctx.projectRoot, { createBranch, suggested: issue.suggestedBranch });
      if (info.blocked) throw new Error(info.reason);
      try {
        await applyCheckout(git, ctx.projectRoot, info.plan);
      } catch (error) {
        throw new Error(`无法切换到分支 ${info.plan.branch}：${error.message}`);
      }
      const branch = shownBranch(createBranch, info, issue.suggestedBranch);
      const prompt = buildPrompt(resolved.body, { ...issue, repo, branch });
      let created;
      try {
        created = await enso.session.create({ text: prompt });
      } catch (error) {
        const moved = info.plan.action === 'stay' ? '' : `分支已是 ${info.plan.branch}。`;
        throw new Error(`${moved}新建会话失败：${error.message}`);
      }
      const sessionId = created?.sessionId;
      if (!sessionId) throw new Error('新建会话没有返回 sessionId');
      try {
        await enso.session.focus(sessionId);
      } catch (error) {
        throw new Error(`会话已创建（${sessionId}），但无法聚焦：${error.message}`);
      }
      return { sessionId, repo, number: issue.number, branch, action: info.plan.action, createBranch, url: issue.url };
    });

  enso.tools.register('task_list', listIssues);
  enso.tools.register('task_preview', preview);

  enso.renderer.handle('state', async (_args, ctx) => {
    const cred = await credential();
    let repo = null;
    if (ctx?.projectRoot) {
      try {
        repo = parseRemote(await git(['remote', 'get-url', 'origin'], ctx.projectRoot));
      } catch {
        repo = null;
      }
    }
    return { source: cred?.source ?? null, login: auth?.login ?? null, pending, error: loginError, repo };
  });
  enso.renderer.handle('login', login);
  enso.renderer.handle('cancelLogin', () => {
    pending = null;
    return null;
  });
  enso.renderer.handle('logout', async () => {
    await saveAuth(null);
    return null;
  });
  enso.renderer.handle('list', listIssues);
  enso.renderer.handle('templates', (args, ctx) =>
    locked(async () => {
      await storeReady;
      return present(store, await quietRepo(args, ctx));
    }),
  );
  enso.renderer.handle('saveTemplate', (args, ctx) =>
    locked(async () => {
      await storeReady;
      const repo = await quietRepo(args, ctx);
      const draft = structuredClone(store);
      const name = String(args?.name ?? '').trim().slice(0, MAX_NAME) || '未命名';
      const body = String(args?.body ?? '');
      if (!body.trim()) throw new Error('提示词模板不能为空');
      if (body.length > MAX_TEMPLATE) throw new Error(`提示词模板最长 ${MAX_TEMPLATE} 字`);
      if (args?.id) {
        const tpl = draft.templates.find((item) => item.id === args.id);
        if (!tpl) throw new Error('模板不存在');
        tpl.name = name;
        tpl.body = body;
        remember(draft, repo, tpl.id);
      } else {
        if (draft.templates.length >= MAX_TEMPLATES) throw new Error(`最多 ${MAX_TEMPLATES} 个模板`);
        const id = newId(draft);
        draft.templates.push({ id, name, body });
        remember(draft, repo, id);
      }
      await persist(draft);
      return present(draft, repo);
    }),
  );
  enso.renderer.handle('deleteTemplate', (args, ctx) =>
    locked(async () => {
      await storeReady;
      const repo = await quietRepo(args, ctx);
      const draft = structuredClone(store);
      if (draft.templates.length <= 1) throw new Error('至少保留一个模板');
      const tpl = draft.templates.find((item) => item.id === args?.id);
      if (!tpl) throw new Error('模板不存在');
      draft.templates = draft.templates.filter((item) => item !== tpl);
      for (const key of Object.keys(draft.selected)) {
        if (draft.selected[key] === tpl.id) draft.selected[key] = draft.templates[0].id;
      }
      await persist(draft);
      return present(draft, repo);
    }),
  );
  enso.renderer.handle('selectTemplate', (args, ctx) =>
    locked(async () => {
      await storeReady;
      const repo = await quietRepo(args, ctx);
      const draft = structuredClone(store);
      if (!draft.templates.some((item) => item.id === args?.id)) throw new Error('模板不存在');
      remember(draft, repo, args.id);
      await persist(draft);
      return present(draft, repo);
    }),
  );
  enso.renderer.handle('prefs', (args, ctx) =>
    locked(async () => {
      await storeReady;
      const repo = await quietRepo(args, ctx);
      const draft = structuredClone(store);
      if (args?.createBranch !== undefined) draft.createBranch = args.createBranch === true;
      await persist(draft);
      return present(draft, repo);
    }),
  );
  enso.renderer.handle('preview', preview);
  enso.renderer.handle('launch', launch);
  enso.renderer.handle('open', async (args) => {
    const url = String(args?.url ?? '');
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error('只能打开 github.com 链接');
    await enso.ui.openExternal(url);
    return null;
  });
}
