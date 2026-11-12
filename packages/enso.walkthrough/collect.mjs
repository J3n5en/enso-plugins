import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, cutPatch, filterDiffBlocks, isGeneratedPath, newFilePatch, rewriteNoIndexDiff } from './diff.mjs';

const ZEROS = '0'.repeat(40);
const REV_RE =
  /^(?:HEAD|ORIG_HEAD|[0-9a-fA-F]{4,64}|(?:refs\/(?:heads|tags|remotes)\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)(?:~\d+|\^[0-9]*)*$/;

export function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', '--no-pager', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      },
      (err, stdout, stderr) => {
        const tooBig = Boolean(err && (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(err.message ?? ''))));
        const code = tooBig ? -1 : err ? Number(err.code ?? 1) : 0;
        resolve({
          code: Number.isFinite(code) ? code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          tooBig,
        });
      },
    );
  });
}

function gitError(result, fallback) {
  const detail = String(result?.stderr || result?.stdout || '').trim();
  return detail || fallback;
}

export function assertRev(raw, label = '版本') {
  const rev = String(raw ?? '').trim();
  if (!rev || rev.startsWith('-') || rev.includes('..') || !REV_RE.test(rev)) {
    throw new Error(`${label}不合法`);
  }
  return rev;
}

export function parseRange(raw) {
  const text = String(raw ?? '').trim();
  const match = /^(\S+?)(\.{2,3})(\S+)$/.exec(text);
  if (!match) throw new Error('提交范围应为 base..head，例如 HEAD~5..HEAD');
  return {
    from: assertRev(match[1], '起点'),
    to: assertRev(match[3], '终点'),
    triple: match[2] === '...',
  };
}

export function normalizeSpec(input = {}) {
  const kind = input.kind || input.source || 'session';
  if (!['session', 'worktree', 'staged', 'branch', 'commits'].includes(kind)) throw new Error('未知的讲解范围');
  const spec = { kind };
  if (kind === 'commits') {
    if (input.range) {
      spec.range = typeof input.range === 'string'
        ? parseRange(input.range)
        : parseRange(`${input.range.from}${input.range.triple ? '...' : '..'}${input.range.to}`);
    }
    else {
      const count = Number(input.count);
      spec.count = Number.isInteger(count) ? Math.min(30, Math.max(1, count)) : 5;
    }
  }
  if (kind === 'branch' && input.base) spec.base = assertRev(input.base, '基准分支');
  return spec;
}

export function parseCheckpointMessage(message) {
  const get = (key) => String(message ?? '').match(new RegExp(`^${key} (.+)$`, 'm'))?.[1]?.trim() || '';
  const sessionId = get('sessionId');
  const headSha = get('head');
  const worktreeTreeSha = get('worktree-tree');
  if (!sessionId || !headSha || !worktreeTreeSha) return null;
  const created = get('created');
  return {
    sessionId,
    headSha,
    worktreeTreeSha,
    branch: get('branch'),
    timestamp: created ? Date.parse(created) || 0 : 0,
  };
}

export function parseCheckpointList(stdout) {
  const parts = String(stdout ?? '').split('\0');
  const list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const sha = parts[i].trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    const parsed = parseCheckpointMessage(parts[i + 1]);
    if (parsed) list.push({ ...parsed, sha });
  }
  return list;
}

export function parseLog(stdout) {
  return String(stdout ?? '')
    .split('\x1e')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [sha = '', subject = '', ...rest] = block.split('\x1f');
      return { sha: sha.trim(), subject: subject.trim(), body: rest.join('\x1f').trim() };
    })
    .filter((commit) => /^[0-9a-f]{7,40}$/i.test(commit.sha));
}

export function parseNumstat(stdout) {
  const files = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const renamed = splitRename(match[3]);
    files.push({
      path: renamed.path,
      oldPath: renamed.oldPath,
      status: renamed.oldPath ? 'renamed' : 'modified',
      binary,
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      hunks: [],
    });
  }
  return files;
}

function splitRename(raw) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (brace) {
    const oldPath = `${brace[1]}${brace[2]}${brace[4]}`.replaceAll('//', '/');
    const path = `${brace[1]}${brace[3]}${brace[4]}`.replaceAll('//', '/');
    return { oldPath, path };
  }
  const arrow = raw.split(' => ');
  if (arrow.length === 2) return { oldPath: arrow[0], path: arrow[1] };
  return { oldPath: null, path: raw };
}

async function ensureRepo(cwd) {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error('当前项目不是 Git 仓库');
}

async function hasHead(cwd) {
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return head.code === 0 && Boolean(head.stdout.trim());
}

async function currentBranch(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : '';
}

async function resolveBase(cwd, explicit) {
  if (explicit) return assertRev(explicit, '基准分支');
  const origin = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim();
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const verify = await runGit(cwd, ['rev-parse', '--verify', '--quiet', candidate]);
    if (verify.code === 0 && verify.stdout.trim()) return candidate;
  }
  return null;
}

async function diffPatch(cwd, revs) {
  const result = await runGit(cwd, ['diff', '--no-color', '--find-renames', '--unified=3', '--relative', ...revs]);
  if (result.tooBig) {
    const stat = await runGit(cwd, ['diff', '--numstat', '--find-renames', '--relative', ...revs]);
    if (stat.code !== 0) throw new Error(gitError(stat, '无法读取 diff'));
    return { patch: '', files: parseNumstat(stat.stdout), truncated: true };
  }
  if (result.code !== 0) throw new Error(gitError(result, '无法读取 diff'));
  const cut = cutPatch(result.stdout);
  return { patch: cut.patch, files: null, truncated: cut.truncated };
}

async function showPatch(cwd, sha) {
  const safe = assertRev(sha, '提交');
  const result = await runGit(cwd, ['show', '--format=', '--first-parent', '-m', '--no-color', '--unified=3', '--find-renames', '--relative', safe]);
  if (result.tooBig) {
    const stat = await runGit(cwd, ['show', '--format=', '--first-parent', '-m', '--numstat', '--find-renames', '--relative', safe]);
    if (stat.code !== 0) throw new Error(gitError(stat, '无法读取提交'));
    return { patch: '', files: parseNumstat(stat.stdout), truncated: true };
  }
  if (result.code !== 0) throw new Error(gitError(result, '无法读取提交'));
  const cut = cutPatch(result.stdout);
  return { patch: cut.patch, files: null, truncated: cut.truncated };
}

async function listUntracked(cwd) {
  const result = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.code !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

async function blobText(cwd, sha, path) {
  if (!sha || sha === ZEROS) return null;
  const result = await runGit(cwd, ['show', `${sha}:${path}`]);
  if (result.code !== 0 || result.stdout.includes('\0')) return null;
  return result.stdout;
}

async function textDiff(path, oldText, newText) {
  if (oldText === newText) return '';
  const dir = await mkdtemp(join(tmpdir(), 'enso-walkthrough-'));
  try {
    await writeFile(join(dir, 'old'), oldText);
    await writeFile(join(dir, 'new'), newText);
    const result = await runGit(dir, ['diff', '--no-index', '--no-color', '--unified=3', '--', 'old', 'new']);
    if (result.code === 0 || !result.stdout.trim()) return '';
    return rewriteNoIndexDiff(result.stdout, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function untrackedPatch(cwd, baselineSha, readText) {
  const prefixRes = await runGit(cwd, ['rev-parse', '--show-prefix']);
  const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : '';
  const paths = await listUntracked(cwd);
  const chunks = [];
  const omitted = [];
  for (const path of paths) {
    if (isGeneratedPath(path)) {
      omitted.push({ path, reason: '生成文件', additions: 0, deletions: 0 });
      continue;
    }
    let current = null;
    try {
      current = await readText(path);
    } catch {
      omitted.push({ path, reason: '无法读取', additions: 0, deletions: 0 });
      continue;
    }
    if (typeof current !== 'string' || current.includes('\0') || current.length > LIMITS.maxUntrackedFileChars) {
      omitted.push({ path, reason: current && current.length > LIMITS.maxUntrackedFileChars ? '文件过大' : '二进制', additions: 0, deletions: 0 });
      continue;
    }
    const old = baselineSha ? await blobText(cwd, baselineSha, `${prefix}${path}`) : null;
    if (old == null) chunks.push(newFilePatch(path, current));
    else if (old !== current) {
      const patch = await textDiff(path, old, current);
      if (patch) chunks.push(patch);
    }
  }
  return { patch: chunks.filter(Boolean).join('\n'), omitted };
}

async function readCommits(cwd, logArgs) {
  const result = await runGit(cwd, ['log', '--format=%H%x1f%s%x1f%b%x1e', ...logArgs]);
  if (result.code !== 0) throw new Error(gitError(result, '无法读取提交'));
  const ordered = parseLog(result.stdout).reverse();
  const limited = ordered.length > 30;
  const commits = limited ? ordered.slice(-30) : ordered;
  const detailed = [];
  let truncated = false;
  for (const commit of commits) {
    const shown = await showPatch(cwd, commit.sha);
    if (shown.truncated) truncated = true;
    detailed.push({ ...commit, patch: shown.patch, files: shown.files });
  }
  return { commits: detailed, truncated, limited };
}

function source(kind, label, detail) {
  return { kind, label, detail: detail || '' };
}

async function collectWorktree(cwd, readText) {
  if (!(await hasHead(cwd))) {
    const extra = await untrackedPatch(cwd, null, readText);
    return {
      source: source('worktree', '未提交的改动', 'HEAD'),
      notice: null,
      commits: null,
      patch: extra.patch,
      files: null,
      omitted: extra.omitted,
      truncated: false,
    };
  }
  const tracked = await diffPatch(cwd, ['HEAD']);
  const extra = await untrackedPatch(cwd, null, readText);
  return {
    source: source('worktree', '未提交的改动', 'HEAD'),
    notice: tracked.truncated ? 'Diff 太大，已截断后再讲解。' : null,
    commits: null,
    patch: [tracked.patch, extra.patch].filter(Boolean).join('\n'),
    files: tracked.files,
    omitted: extra.omitted,
    truncated: tracked.truncated,
  };
}

async function collectStaged(cwd) {
  if (!(await hasHead(cwd))) throw new Error('仓库还没有提交，暂存区是空的');
  const tracked = await diffPatch(cwd, ['--cached']);
  return {
    source: source('staged', '暂存区', '--cached'),
    notice: tracked.truncated ? 'Diff 太大，已截断后再讲解。' : null,
    commits: null,
    patch: tracked.patch,
    files: tracked.files,
    omitted: [],
    truncated: tracked.truncated,
  };
}

async function collectBranch(cwd, spec, readText) {
  if (!(await hasHead(cwd))) throw new Error('仓库还没有提交');
  const base = await resolveBase(cwd, spec.base);
  if (!base) throw new Error('找不到基准分支');
  const mergeBase = await runGit(cwd, ['merge-base', 'HEAD', base]);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) throw new Error(gitError(mergeBase, '无法计算和基准分支的分叉点'));
  const tracked = await diffPatch(cwd, [mergeBase.stdout.trim()]);
  const extra = await untrackedPatch(cwd, null, readText);
  return {
    source: source('branch', `相对 ${base} 的改动`, base),
    notice: tracked.truncated ? 'Diff 太大，已截断后再讲解。' : null,
    commits: null,
    patch: [tracked.patch, extra.patch].filter(Boolean).join('\n'),
    files: tracked.files,
    omitted: extra.omitted,
    truncated: tracked.truncated,
  };
}

async function collectCommits(cwd, spec) {
  if (!(await hasHead(cwd))) throw new Error('仓库还没有提交');
  let logArgs;
  let label;
  let detail;
  if (spec.range) {
    const dots = spec.range.triple ? '...' : '..';
    detail = `${spec.range.from}${dots}${spec.range.to}`;
    logArgs = [detail];
    label = `提交 ${detail}`;
  } else {
    detail = `HEAD~${spec.count}..HEAD`;
    logArgs = ['-n', String(spec.count), 'HEAD'];
    label = `最近 ${spec.count} 次提交`;
  }
  const { commits, truncated, limited } = await readCommits(cwd, logArgs);
  const notices = [];
  if (limited) notices.push('提交较多，只保留最近的 30 个。');
  if (truncated) notices.push('有的提交 diff 太大，已改成只保留文件和行数。');
  return {
    source: source('commits', label, detail),
    notice: notices.join('') || null,
    commits,
    patch: '',
    files: null,
    omitted: [],
    truncated,
  };
}

async function collectSession(cwd, sessionId, readText) {
  if (!sessionId) {
    const work = await collectWorktree(cwd, readText);
    return {
      ...work,
      source: source('session', '当前会话的改动', 'no-session'),
      notice: '没有当前会话，已改用未提交改动。',
    };
  }
  const branch = await currentBranch(cwd);
  const listed = await runGit(cwd, ['for-each-ref', '--format=%(objectname)%00%(contents)%00', 'refs/enso-checkpoints']);
  const checkpoints = listed.code === 0 ? parseCheckpointList(listed.stdout) : [];
  const mine = checkpoints.filter((item) => item.sessionId === sessionId);
  const sameBranch = mine.filter((item) => !branch || !item.branch || item.branch === branch);
  sameBranch.sort((a, b) => a.timestamp - b.timestamp);
  const checkpoint = sameBranch[0];
  if (!checkpoint) {
    const work = await collectWorktree(cwd, readText);
    return {
      ...work,
      source: source('session', '当前会话的改动', sessionId),
      notice: mine.length ? '当前会话的检查点在别的分支上，已改用未提交改动。' : '当前会话还没有检查点，已改用未提交改动。',
    };
  }

  const headOk = checkpoint.headSha && checkpoint.headSha !== ZEROS;
  let ancestor = false;
  if (headOk && (await hasHead(cwd))) {
    const check = await runGit(cwd, ['merge-base', '--is-ancestor', checkpoint.headSha, 'HEAD']);
    ancestor = check.code === 0;
  }
  if (ancestor) {
    const count = await runGit(cwd, ['rev-list', '--count', `${checkpoint.headSha}..HEAD`]);
    const total = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
    if (total > 0) {
      const { commits, truncated, limited } = await readCommits(cwd, [`${checkpoint.headSha}..HEAD`]);
      const residual = await diffPatch(cwd, ['HEAD']);
      const extra = await untrackedPatch(cwd, checkpoint.sha, readText);
      const notices = ['讲解包含会话开始后的提交，以及尚未提交的改动。'];
      if (limited) notices.push('提交较多，只保留最近的 30 个。');
      if (truncated || residual.truncated) notices.push('部分 diff 过大，已截断。');
      return {
        source: source('session', '当前会话的改动', sessionId),
        notice: notices.join(''),
        commits,
        patch: [residual.patch, extra.patch].filter(Boolean).join('\n'),
        files: residual.files,
        omitted: extra.omitted,
        truncated: truncated || residual.truncated,
      };
    }
  }

  const raw = await diffPatch(cwd, [checkpoint.sha]);
  const untracked = new Set(await listUntracked(cwd));
  const cleaned = raw.patch ? filterDiffBlocks(raw.patch, (path) => untracked.has(path)) : '';
  const extra = await untrackedPatch(cwd, checkpoint.sha, readText);
  return {
    source: source('session', '当前会话的改动', sessionId),
    notice: raw.truncated ? '从当前会话最早的检查点看到现在。Diff 太大，已截断。' : '从当前会话最早的检查点看到现在。',
    commits: null,
    patch: [cleaned, extra.patch].filter(Boolean).join('\n'),
    files: raw.files,
    omitted: extra.omitted,
    truncated: raw.truncated,
  };
}

export async function collectDiff(cwd, specInput, deps) {
  if (!cwd) throw new Error('请先打开一个项目');
  await ensureRepo(cwd);
  const spec = normalizeSpec(specInput);
  const readText = deps?.readText;
  if ((spec.kind === 'session' || spec.kind === 'worktree' || spec.kind === 'branch') && typeof readText !== 'function') {
    throw new Error('缺少读取项目文件的能力');
  }
  if (spec.kind === 'session') return collectSession(cwd, deps.sessionId || null, readText);
  if (spec.kind === 'worktree') return collectWorktree(cwd, readText);
  if (spec.kind === 'staged') return collectStaged(cwd);
  if (spec.kind === 'branch') return collectBranch(cwd, spec, readText);
  return collectCommits(cwd, spec);
}

export async function inspectRepo(cwd) {
  if (!cwd) return { git: false, reason: '请先打开一个项目' };
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { git: false, reason: '当前项目不是 Git 仓库' };
  const branch = await currentBranch(cwd);
  const base = await resolveBase(cwd, null);
  let ahead = 0;
  if (base && (await hasHead(cwd))) {
    const mergeBase = await runGit(cwd, ['merge-base', 'HEAD', base]);
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      const count = await runGit(cwd, ['rev-list', '--count', `${mergeBase.stdout.trim()}..HEAD`]);
      if (count.code === 0) ahead = Number(count.stdout.trim()) || 0;
    }
  }
  const log = await runGit(cwd, ['log', '-n', '12', '--format=%H%x1f%s']);
  const commits = log.code === 0
    ? log.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha, subject] = line.split('\x1f');
          return { sha, short: sha.slice(0, 7), subject: subject || sha.slice(0, 7) };
        })
        .filter((commit) => /^[0-9a-f]{7,40}$/i.test(commit.sha))
    : [];
  const dirty = await runGit(cwd, ['status', '--porcelain']);
  const dirtyCount = dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean).length : 0;
  let suggested = 'worktree';
  if (dirtyCount > 0) suggested = 'session';
  else if (commits.length) suggested = 'commits';
  else if (ahead > 0) suggested = 'branch';
  return { git: true, branch, base, ahead, commits, dirtyCount, suggested };
}
