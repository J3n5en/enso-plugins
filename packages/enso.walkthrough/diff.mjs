import { createHash } from 'node:crypto';

export const LIMITS = {
  maxPatchChars: 900_000,
  maxHunkLines: 80,
  maxHunksPerStep: 8,
  maxSteps: 40,
  maxKeptLines: 2800,
  maxTitle: 120,
  maxBody: 4000,
  maxSummary: 2000,
  maxUntrackedFileChars: 120_000,
};

const ROLE_ORDER = { type: 0, config: 1, code: 2, style: 3, test: 4, docs: 5, generated: 6 };

const LOCK_RE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|Podfile\.lock)$/i;
const GENERATED_DIR_RE = /(?:^|\/)(?:dist|build|coverage|generated|vendor|node_modules)\//;
const MIN_RE = /\.min\.(?:js|css)$/i;

export function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

/** git 默认 core.quotePath 会给空格和非 ASCII 路径加 C 风格引号。 */
export function unquoteGitPath(raw) {
  const s = String(raw ?? '').trim();
  if (s.length < 2 || s[0] !== '"' || s.at(-1) !== '"') return s;
  const body = s.slice(1, -1);
  const bytes = [];
  let plain = '';
  const flush = () => {
    if (bytes.length === 0) return;
    plain += Buffer.from(bytes).toString('utf8');
    bytes.length = 0;
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      flush();
      plain += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next >= '0' && next <= '7') {
      let oct = next;
      for (let k = 0; k < 2 && i + 1 < body.length && body[i + 1] >= '0' && body[i + 1] <= '7'; k += 1) {
        i += 1;
        oct += body[i];
      }
      bytes.push(Number.parseInt(oct, 8));
      continue;
    }
    flush();
    if (next === 'n') plain += '\n';
    else if (next === 't') plain += '\t';
    else if (next === '"' || next === '\\') plain += next;
    else plain += next;
  }
  flush();
  return plain;
}

function stripDiffPrefix(path) {
  if (path === '/dev/null') return path;
  return path.replace(/^[ab]\//, '');
}

export function parseDiffGitPaths(line) {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  const tokens = [];
  for (let i = 0; i < rest.length; ) {
    if (rest[i] === ' ') {
      i += 1;
      continue;
    }
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === '\\') {
          j += 2;
          continue;
        }
        if (rest[j] === '"') break;
        j += 1;
      }
      tokens.push(rest.slice(i, Math.min(rest.length, j + 1)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < rest.length && rest[j] !== ' ') j += 1;
    tokens.push(rest.slice(i, j));
    i = j;
  }
  if (tokens.length < 2) return null;
  return {
    fileA: stripDiffPrefix(unquoteGitPath(tokens[0])),
    fileB: stripDiffPrefix(unquoteGitPath(tokens[1])),
  };
}

function parseMinusPlusPath(raw) {
  let text = String(raw ?? '').trim().split('\t')[0];
  text = unquoteGitPath(text);
  if (text === '/dev/null') return '/dev/null';
  return stripDiffPrefix(text);
}

function emptyFile(path) {
  return {
    path: path || 'unknown',
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

export function parsePatch(patch) {
  const text = String(patch ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const files = [];
  let file = null;
  let hunk = null;

  const flushHunk = () => {
    if (!hunk || !file) {
      hunk = null;
      return;
    }
    delete hunk._old;
    delete hunk._new;
    file.hunks.push(hunk);
    hunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (!file) return;
    if (file.hunks.length) {
      file.additions = file.hunks.reduce((sum, item) => sum + item.additions, 0);
      file.deletions = file.hunks.reduce((sum, item) => sum + item.deletions, 0);
    }
    if (!file.path || file.path === '/dev/null') file.path = file.oldPath || 'unknown';
    files.push(file);
    file = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flushFile();
      const paths = parseDiffGitPaths(line);
      file = emptyFile(paths?.fileB && paths.fileB !== '/dev/null' ? paths.fileB : paths?.fileA);
      if (paths?.fileA && paths.fileA !== '/dev/null' && paths.fileA !== file.path) file.oldPath = paths.fileA;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = unquoteGitPath(line.slice('rename from '.length).trim());
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = unquoteGitPath(line.slice('rename to '.length).trim());
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }
    if (!hunk && line.startsWith('--- ')) {
      const path = parseMinusPlusPath(line.slice(4));
      if (path === '/dev/null') {
        if (file.status !== 'renamed') file.status = 'added';
      } else if (!file.oldPath) file.oldPath = path;
      continue;
    }
    if (!hunk && line.startsWith('+++ ')) {
      const path = parseMinusPlusPath(line.slice(4));
      if (path === '/dev/null') file.status = 'deleted';
      else if (path) file.path = path;
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) continue;
      hunk = {
        path: file.path,
        oldStart: Number(match[1]),
        oldLines: match[2] == null ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] == null ? 1 : Number(match[4]),
        header: match[5].trim(),
        lines: [],
        additions: 0,
        deletions: 0,
        truncated: false,
        _old: Number(match[1]),
        _new: Number(match[3]),
      };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue;
    if (line === '') continue;
    const mark = line[0];
    if (mark !== '+' && mark !== '-' && mark !== ' ') continue;
    const kind = mark === '+' ? 'add' : mark === '-' ? 'del' : 'context';
    const entry = { kind, text: line.slice(1) };
    if (kind !== 'add') entry.oldNo = hunk._old++;
    if (kind !== 'del') entry.newNo = hunk._new++;
    if (kind === 'add') hunk.additions += 1;
    if (kind === 'del') hunk.deletions += 1;
    hunk.lines.push(entry);
  }
  flushFile();
  return files;
}

export function isGeneratedPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return LOCK_RE.test(normalized) || GENERATED_DIR_RE.test(normalized) || MIN_RE.test(normalized);
}

export function roleOf(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  const base = normalized.split('/').pop() || normalized;
  if (isGeneratedPath(normalized)) return 'generated';
  if (
    /(?:^|\/)(?:__tests__|tests?|spec)\//i.test(normalized) ||
    /\.(?:test|spec)\.[^.]+$/i.test(base) ||
    /_test\.[^.]+$/i.test(base)
  ) {
    return 'test';
  }
  if (/\.d\.ts$/i.test(base) || /(?:^|\/)(?:types?|interfaces?|schemas?|models?|contracts?)(?:\/|\.)/i.test(normalized)) {
    return 'type';
  }
  if (/\.(?:css|scss|less|sass)$/i.test(base)) return 'style';
  if (/\.(?:md|mdx|rst|adoc)$/i.test(base)) return 'docs';
  if (
    /(?:^|\/)(?:[^/]*\.config\.(?:js|mjs|cjs|ts|json|ya?ml)|package\.json|tsconfig[^/]*|enso-plugin\.json)$/i.test(
      normalized,
    )
  ) {
    return 'config';
  }
  return 'code';
}

export function implKey(path) {
  const parts = String(path || '').replaceAll('\\', '/').split('/');
  let base = parts.pop() || '';
  base = base.replace(/\.(?:test|spec)(?=\.[^.]+$)/i, '').replace(/_test(?=\.[^.]+$)/i, '');
  const parent = parts.at(-1);
  if (parent && /^(?:__tests__|tests?|spec)$/i.test(parent)) parts.pop();
  return [...parts, base].join('/');
}

function quoteGitPath(path) {
  if (/[^A-Za-z0-9._@~+/-]/.test(path)) return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return path;
}

export function newFilePatch(path, text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const quotedA = quoteGitPath(`a/${path}`);
  const quotedB = quoteGitPath(`b/${path}`);
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git ${quotedA} ${quotedB}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${quotedB}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    body,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function filterDiffBlocks(patch, dropPath) {
  const lines = String(patch ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let block = [];
  let drop = false;
  const flush = () => {
    if (block.length && !drop) kept.push(block.join('\n'));
    block = [];
    drop = false;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const paths = parseDiffGitPaths(line);
      const path = paths?.fileB && paths.fileB !== '/dev/null' ? paths.fileB : paths?.fileA || '';
      drop = dropPath(path);
    }
    block.push(line);
  }
  flush();
  return kept.join('\n').trim();
}

export function rewriteNoIndexDiff(patch, path) {
  const quotedA = quoteGitPath(`a/${path}`);
  const quotedB = quoteGitPath(`b/${path}`);
  let headers = 0;
  return String(patch ?? '')
    .split('\n')
    .map((line) => {
      if (headers >= 3 || line.startsWith('@@')) return line;
      if (line.startsWith('diff --git ')) {
        headers += 1;
        return `diff --git ${quotedA} ${quotedB}`;
      }
      if (line.startsWith('--- ')) {
        headers += 1;
        return `--- ${quotedA}`;
      }
      if (line.startsWith('+++ ')) {
        headers += 1;
        return `+++ ${quotedB}`;
      }
      return line;
    })
    .join('\n');
}

export function cutPatch(patch, max = LIMITS.maxPatchChars) {
  const text = String(patch ?? '');
  if (text.length <= max) return { patch: text, truncated: false };
  const slice = text.slice(0, max);
  const at = slice.lastIndexOf('\ndiff --git ');
  return { patch: (at > 0 ? slice.slice(0, at) : slice).trim(), truncated: true };
}

function baseName(path) {
  const parts = String(path || '').split('/');
  return parts.at(-1) || path;
}

function commonDir(paths) {
  const split = paths.map((path) => String(path).split('/').slice(0, -1));
  if (!split.length) return '';
  const first = split[0];
  let index = 0;
  while (index < first.length && split.every((parts) => parts[index] === first[index])) index += 1;
  return first.slice(0, index).join('/');
}

function changedCount(file) {
  return (file.additions || 0) + (file.deletions || 0);
}

function clusterHunks(hunks) {
  const clusters = [];
  let current = [];
  let lastEnd = null;
  let size = 0;
  for (const hunk of hunks) {
    const gap = lastEnd == null ? 0 : hunk.newStart - lastEnd;
    if (current.length && (gap > 50 || size > 80)) {
      clusters.push(current);
      current = [];
      size = 0;
    }
    current.push(hunk);
    size += hunk.additions + hunk.deletions;
    lastEnd = hunk.newStart + Math.max(hunk.newLines, 1);
  }
  if (current.length) clusters.push(current);
  return clusters;
}

function fileWithHunks(file, hunks) {
  const additions = hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
  return { ...file, hunks, additions, deletions };
}

export function groupFiles(files) {
  const omitted = [];
  const kept = [];
  for (const file of files) {
    if (file.binary || isGeneratedPath(file.path)) {
      omitted.push({
        path: file.path,
        reason: file.binary ? '二进制' : '生成文件',
        additions: file.additions || 0,
        deletions: file.deletions || 0,
      });
    } else kept.push(file);
  }

  const units = [];
  const byKey = new Map();
  for (const file of kept) {
    if (roleOf(file.path) === 'test') continue;
    const unit = { files: [file], role: roleOf(file.path), partial: false };
    units.push(unit);
    byKey.set(implKey(file.path), unit);
  }
  for (const file of kept) {
    if (roleOf(file.path) !== 'test') continue;
    const host = byKey.get(implKey(file.path));
    if (host) host.files.push(file);
    else units.push({ files: [file], role: 'test', partial: false });
  }

  const split = [];
  for (const unit of units) {
    const only = unit.files.length === 1 ? unit.files[0] : null;
    const big = only && only.hunks.length >= 3 && changedCount(only) > 120;
    if (!big) {
      split.push(unit);
      continue;
    }
    const clusters = clusterHunks(only.hunks);
    if (clusters.length < 2) {
      split.push(unit);
      continue;
    }
    for (const cluster of clusters) {
      split.push({ files: [fileWithHunks(only, cluster)], role: unit.role, partial: true });
    }
  }

  split.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.files[0].path.localeCompare(b.files[0].path));

  const merged = [];
  for (const unit of split) {
    const prev = merged.at(-1);
    const sameDir = prev && commonDir(prev.files.map((file) => file.path)) === commonDir(unit.files.map((file) => file.path));
    const prevLines = prev ? prev.files.reduce((sum, file) => sum + changedCount(file), 0) : 0;
    const nextLines = unit.files.reduce((sum, file) => sum + changedCount(file), 0);
    const prevCount = prev ? prev.files.length : 0;
    if (
      prev &&
      !prev.partial &&
      !unit.partial &&
      prev.role === unit.role &&
      sameDir &&
      prev.role !== 'docs' &&
      prevCount + unit.files.length <= 3 &&
      prevLines + nextLines <= 100 &&
      prevLines <= 60 &&
      nextLines <= 60
    ) {
      prev.files.push(...unit.files);
    } else merged.push({ ...unit, files: [...unit.files] });
  }
  return { units: merged, omitted };
}

function uniqueHeaders(files) {
  const seen = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (!hunk.header || seen.includes(hunk.header)) continue;
      seen.push(hunk.header);
      if (seen.length >= 5) return seen;
    }
  }
  return seen;
}

function verb(status) {
  if (status === 'added') return '新增';
  if (status === 'deleted') return '删除';
  if (status === 'renamed') return '重命名';
  return '修改';
}

export function explainFiles(files) {
  if (!files.length) return '这一步没有可展示的代码。';
  const parts = files.map((file) => {
    const name = file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    return `${verb(file.status)} \`${name}\`（+${file.additions || 0} −${file.deletions || 0}）`;
  });
  const lines = [`${parts.join('，')}。`];
  const headers = uniqueHeaders(files);
  if (headers.length) lines.push(`代码落在 ${headers.map((header) => `「${header}」`).join('、')}。`);
  const roles = new Set(files.map((file) => roleOf(file.path)));
  if (roles.has('test') && [...roles].some((role) => role !== 'test')) lines.push('测试和对应实现放在同一步。');
  if (files.every((file) => file.hunks.length === 0) && files.some((file) => changedCount(file) > 0)) {
    lines.push('改动较大，这里只保留文件和行数，没有展开代码。');
  }
  return lines.join('\n');
}

function titleFor(unit) {
  const file = unit.files[0];
  if (unit.partial) {
    const header = file.hunks.find((hunk) => hunk.header)?.header;
    return header ? `${baseName(file.path)} · ${clip(header, 42)}` : `${baseName(file.path)} 的一段改动`;
  }
  if (unit.files.length === 1) {
    const name = baseName(file.path);
    if (file.status === 'added') return `新增 ${name}`;
    if (file.status === 'deleted') return `删除 ${name}`;
    if (file.status === 'renamed') return `重命名为 ${name}`;
    const header = file.hunks.find((hunk) => hunk.header)?.header;
    return header ? `${name} · ${clip(header, 42)}` : `调整 ${name}`;
  }
  const dir = commonDir(unit.files.map((item) => item.path));
  return `${dir || '多处'} 的相关改动`;
}

function trimHunk(hunk) {
  if (hunk.lines.length <= LIMITS.maxHunkLines) return { ...hunk, truncated: false };
  return { ...hunk, lines: hunk.lines.slice(0, LIMITS.maxHunkLines), truncated: true };
}

function hunkIdentity(hunk) {
  const body = hunk.lines
    .filter((line) => line.kind !== 'context')
    .map((line) => `${line.kind}:${line.text}`)
    .join('\n');
  return `${hunk.path}|${hunk.header}|${shortHash(body)}`;
}

function stepId(files, salt = '') {
  const ids = files.flatMap((file) => (file.hunks.length ? file.hunks.map(hunkIdentity) : [`${file.status}:${file.path}:${file.additions}:${file.deletions}`]));
  return shortHash(`${salt}\n${ids.sort().join('\n')}`);
}

function publicFile(file) {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    additions: file.additions || 0,
    deletions: file.deletions || 0,
  };
}

function draftStep(unit, commit) {
  const hunks = [];
  let hiddenHunks = 0;
  for (const file of unit.files) {
    const visible = file.hunks.slice(0, LIMITS.maxHunksPerStep - hunks.length);
    hiddenHunks += Math.max(0, file.hunks.length - visible.length);
    hunks.push(...visible.map(trimHunk));
    if (hunks.length >= LIMITS.maxHunksPerStep) break;
  }
  const body = explainFiles(unit.files);
  const step = {
    id: stepId(unit.files, commit?.sha || ''),
    title: titleFor(unit),
    body,
    edited: false,
    role: unit.role,
    partial: unit.partial,
    files: unit.files.map(publicFile),
    hunks,
    hiddenHunks,
    commit: commit ? { sha: commit.sha, subject: commit.subject } : null,
  };
  return step;
}

function materialFiles(patch, files) {
  const parsed = patch ? parsePatch(patch) : [];
  if (Array.isArray(files) && files.length) return [...files, ...parsed];
  return parsed;
}

function stepsFromFiles(files, commit) {
  const grouped = groupFiles(files);
  const steps = grouped.units.map((unit) => draftStep(unit, commit));
  if (!steps.length && grouped.omitted.length) {
    const listed = grouped.omitted.map((item) => `\`${item.path}\``).join('、');
    steps.push({
      id: stepId(
        grouped.omitted.map((item) => ({ path: item.path, status: 'modified', additions: item.additions, deletions: item.deletions, hunks: [] })),
        commit?.sha || 'omitted',
      ),
      title: commit?.subject ? clip(commit.subject, 80) : '生成文件与二进制',
      body: `这一步只碰到未展开的文件：${listed}。`,
      edited: false,
      role: 'generated',
      partial: false,
      files: grouped.omitted.map((item) => ({
        path: item.path,
        oldPath: null,
        status: 'modified',
        additions: item.additions,
        deletions: item.deletions,
      })),
      hunks: [],
      hiddenHunks: 0,
      commit: commit ? { sha: commit.sha, subject: commit.subject } : null,
    });
  }
  return { steps, omitted: grouped.omitted };
}

function applyCommitNarrative(steps, commit) {
  if (!commit || !steps.length) return steps;
  if (steps.length === 1) steps[0].title = clip(commit.subject || steps[0].title, 80);
  if (commit.body?.trim()) {
    steps[0].body = `${commit.body.trim()}\n\n${steps[0].body}`;
    steps[0].body = clip(steps[0].body, LIMITS.maxBody);
  }
  return steps;
}

function collapseOverflow(steps) {
  const linesOf = (step) => step.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let total = steps.reduce((sum, step) => sum + linesOf(step), 0);
  const ranked = steps
    .map((step, index) => ({ index, lines: linesOf(step) }))
    .sort((a, b) => b.lines - a.lines);
  for (const item of ranked) {
    if (total <= LIMITS.maxKeptLines) break;
    const step = steps[item.index];
    if (!step.hunks.length) continue;
    total -= item.lines;
    step.hunks = [];
    step.hiddenHunks += 1;
    if (!step.body.includes('没有展开代码')) {
      step.body = clip(`${step.body}\n改动较大，这里只保留文件和行数，没有展开代码。`, LIMITS.maxBody);
    }
  }
  return steps;
}

export function buildWalkthrough(collected) {
  const source = collected?.source || { kind: 'worktree', label: '未提交的改动', detail: '' };
  const omitted = [...(collected?.omitted || [])];
  let steps = [];

  if (Array.isArray(collected?.commits) && collected.commits.length) {
    for (const commit of collected.commits) {
      const files = materialFiles(commit.patch, commit.files);
      const built = stepsFromFiles(files, commit);
      omitted.push(...built.omitted);
      steps.push(...applyCommitNarrative(built.steps, commit));
    }
    if (collected.patch?.trim() || collected.files?.length) {
      const extra = stepsFromFiles(materialFiles(collected.patch, collected.files), null);
      omitted.push(...extra.omitted);
      steps.push(...extra.steps);
    }
  } else {
    const built = stepsFromFiles(materialFiles(collected?.patch, collected?.files), null);
    omitted.push(...built.omitted);
    steps = built.steps;
  }

  if (steps.length > LIMITS.maxSteps) {
    for (const step of steps.slice(LIMITS.maxSteps)) {
      for (const file of step.files) omitted.push({ path: file.path, reason: '步骤过多，未展开', additions: file.additions, deletions: file.deletions });
    }
    steps = steps.slice(0, LIMITS.maxSteps);
  }
  collapseOverflow(steps);

  const seenOmit = new Set();
  const uniqueOmitted = [];
  for (const item of omitted) {
    if (!item?.path || seenOmit.has(item.path)) continue;
    seenOmit.add(item.path);
    uniqueOmitted.push(item);
  }

  const fileSet = new Set();
  let additions = 0;
  let deletions = 0;
  steps.forEach((step, index) => {
    step.index = index;
    for (const file of step.files) {
      fileSet.add(file.path);
      additions += file.additions || 0;
      deletions += file.deletions || 0;
    }
  });

  const summary = steps.length
    ? `按阅读顺序分成 ${steps.length} 步，涉及 ${fileSet.size} 个文件，+${additions} −${deletions}。`
    : '这个范围里没有需要讲解的代码改动。';
  const walk = {
    source,
    notice: collected?.notice || null,
    truncated: Boolean(collected?.truncated),
    title: source.label || '变更讲解',
    summary: uniqueOmitted.length ? `${summary}另有 ${uniqueOmitted.length} 个文件未展开。` : summary,
    stats: {
      steps: steps.length,
      files: fileSet.size,
      additions,
      deletions,
      omitted: uniqueOmitted.length,
    },
    steps,
    omitted: uniqueOmitted,
  };
  walk.id = shortHash(
    JSON.stringify({
      kind: source.kind,
      detail: source.detail,
      steps: walk.steps.map((step) => step.id),
    }),
  );
  return walk;
}

export function mergeEdits(walk, edits) {
  if (!walk) return walk;
  if (!edits) return structuredClone(walk);
  const next = structuredClone(walk);
  const walkEdit = edits.walks?.[walk.id] || {};
  if (typeof walkEdit.title === 'string' && walkEdit.title.trim()) {
    next.title = clip(walkEdit.title.trim(), LIMITS.maxTitle);
    next.titleEdited = true;
  }
  if (typeof walkEdit.summary === 'string' && walkEdit.summary.trim()) {
    next.summary = clip(walkEdit.summary.trim(), LIMITS.maxSummary);
    next.summaryEdited = true;
  }
  for (const step of next.steps) {
    const edit = edits.steps?.[step.id];
    if (!edit) continue;
    if (typeof edit.title === 'string' && edit.title.trim()) step.title = clip(edit.title.trim(), LIMITS.maxTitle);
    if (typeof edit.body === 'string') step.body = clip(edit.body, LIMITS.maxBody);
    step.edited = true;
  }
  return next;
}

export function recordEdit(edits, patch) {
  const next = structuredClone(edits || { walks: {}, steps: {} });
  next.walks ||= {};
  next.steps ||= {};
  if (!patch?.stepId) {
    if (!patch?.walkId) throw new Error('缺少讲解');
    const current = next.walks[patch.walkId] || {};
    if (patch.title != null) {
      const title = String(patch.title).trim();
      if (!title) throw new Error('标题不能为空');
      current.title = clip(title, LIMITS.maxTitle);
    }
    if (patch.summary != null) {
      const summary = String(patch.summary).trim();
      if (!summary) throw new Error('摘要不能为空');
      current.summary = clip(summary, LIMITS.maxSummary);
    }
    next.walks[patch.walkId] = current;
    return next;
  }
  const title = patch.title == null ? null : String(patch.title).trim();
  if (patch.title != null && !title) throw new Error('标题不能为空');
  const current = next.steps[patch.stepId] || {};
  if (title != null) current.title = clip(title, LIMITS.maxTitle);
  if (patch.body != null) current.body = clip(String(patch.body), LIMITS.maxBody);
  next.steps[patch.stepId] = current;
  return next;
}

function hunkRange(hunk) {
  if (!hunk.newLines) return '';
  const end = hunk.newStart + Math.max(hunk.newLines - 1, 0);
  return hunk.newStart === end ? `L${hunk.newStart}` : `L${hunk.newStart}–${end}`;
}

export function toMarkdown(walk, options = {}) {
  if (!walk) return '';
  const steps = options.stepId ? walk.steps.filter((step) => step.id === options.stepId) : walk.steps;
  const lines = [`# ${walk.title}`, '', walk.summary, ''];
  if (walk.notice) lines.push(`> ${walk.notice}`, '');
  if (walk.truncated) lines.push('> Diff 过大，讲解只覆盖前面的一部分。', '');
  for (const step of steps) {
    lines.push(`## ${step.index + 1}. ${step.title}`, '', step.body || '', '');
    for (const file of step.files) {
      lines.push(`- \`${file.path}\` +${file.additions} −${file.deletions}`);
    }
    if (step.files.length) lines.push('');
    for (const hunk of step.hunks) {
      const range = hunkRange(hunk);
      lines.push(`### \`${hunk.path}\` +${hunk.additions} −${hunk.deletions}${range ? ` ${range}` : ''}`, '', '```diff');
      if (hunk.header) lines.push(`@@ ${hunk.header}`);
      for (const line of hunk.lines) {
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        lines.push(`${sign}${line.text}`);
      }
      if (hunk.truncated) lines.push('…（片段已截断）');
      lines.push('```', '');
    }
  }
  if (!options.stepId && walk.omitted?.length) {
    lines.push('## 未展开', '');
    for (const item of walk.omitted) lines.push(`- \`${item.path}\`（${item.reason}）`);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}
