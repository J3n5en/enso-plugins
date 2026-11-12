/** OpenSpec 变更看板的纯逻辑。不碰宿主 API，测试可以直接喂一份虚拟目录。 */

export const ARCHIVE = 'archive';
export const MAX_CHANGES = 100;
export const MAX_MD_FILES = 40;
export const MAX_DEPTH = 6;
export const MAX_TASKS = 80;
export const MAX_TASK_TEXT = 800;
export const MAX_RESUME = 400;
export const MAX_READ = 200_000;
export const DETAIL_CHARS = 12_000;
export const FINISH_FROM_PERCENT = 80;

export const STAGES = ['planning', 'ready', 'in-progress', 'in-review', 'merged', 'complete'];

export const STAGE_LABEL = {
  planning: '规划',
  ready: '就绪',
  'in-progress': '进行中',
  'in-review': '评审中',
  merged: '已合并未完成',
  complete: '完成',
};

export const DEFAULT_REQUIRED = ['proposal.md', 'design.md', 'tasks.md', 'specs'];
export const DEFAULT_APPLY = '/opsx:apply {change}';
export const DEFAULT_FINISH =
  '请检查 OpenSpec 变更 {change} 是否已经做完：对照 openspec/changes/{change}/tasks.md、代码、git 历史和相关 pull request，把真正完成的任务勾上。如果每一项都完成了，执行 /opsx:archive {change}。否则列出还没做的部分并停下来，不要开始新的实现。';
export const DEFAULT_TASK = '/opsx:apply {change}，只做这一项：{task}';
export const DEFAULT_RESUME = '^(?:Next:|下一步[:：])';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TASK = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s?(.*)$/;
const LIST = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;
const FENCE = /^\s*(```|~~~)/;
const PARAGRAPH_BREAK = /^\s*($|[-*+]\s|\d+[.)]\s|#|>|```|~~~)/;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/g;
const SKIP_SPECS = /^skip_specs:\s*true\s*$/m;
const SCHEMA_NAME = /^schema:\s*['"]?([A-Za-z0-9][A-Za-z0-9-]{0,40})['"]?\s*$/m;
const GENERATES = /^[ \t]*(?:[-*+]\s+)?generates:[ \t]*['"]?([^'"#\n]+?)['"]?[ \t]*$/gm;
const SAFE_PART = /^[^/\\\0]+$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GENERIC_TITLE = /^(proposal|提案|spec|规格|design|设计|tasks|任务)$/i;

const STATE_RANK = { unknown: 0, open: 1, closed: 2, merged: 3 };

export function safeOpenspecRel(rel) {
  if (typeof rel !== 'string') return null;
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.startsWith('/') || norm.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  if (CONTROL.test(norm)) return null;
  if (norm !== 'openspec' && !norm.startsWith('openspec/')) return null;
  return norm;
}

export function safeChangeName(name) {
  if (typeof name !== 'string' || !name || name === ARCHIVE || name.startsWith('.')) return false;
  if (CONTROL.test(name) || name.length > 120) return false;
  return safeOpenspecRel(`openspec/changes/${name}`) === `openspec/changes/${name}`;
}

export function mentionsKey(text, key) {
  if (!text || !key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9A-Za-z])`, 'i').test(String(text));
}

export function explainHostError(error) {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (code === 'PERMISSION_DENIED' && /其他会话|任意运行中的会话|inject/i.test(message)) {
    return '未允许向其他会话发消息。到 设置 → 插件 → OpenSpec，打开「允许向任意运行中的会话发送消息」。';
  }
  if (code === 'PERMISSION_DENIED') return message || '没有权限读取项目文件';
  if (code === 'INJECT_FAILED') return `目标会话不可用（可能已关闭）：${message}`;
  if (code === 'GESTURE_REQUIRED') return '请从侧栏按钮发起这个操作。';
  if (code === 'NO_SESSION') return '请先打开一个会话。';
  if (code === 'NO_PROJECT') return '请先打开一个项目。';
  if (code === 'RATE_LIMITED') return '发送太频繁，稍后再试。';
  return message || '操作失败';
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function compile(source, field, problems) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 200) {
    problems.push(`${field} 必须是长度不超过 200 的正则`);
    return null;
  }
  try {
    return new RegExp(source, 'm');
  } catch {
    problems.push(`${field} 不是合法的正则`);
    return null;
  }
}

function parseTicket(raw, problems) {
  if (!isObject(raw)) {
    problems.push('ticket 必须是带 pattern 和 key 的对象');
    return null;
  }
  const pattern = compile(raw.pattern, 'ticket.pattern', problems);
  if (typeof raw.key !== 'string' || raw.key === '' || raw.key.length > 80) {
    problems.push('ticket.key 必须是非空字符串，例如 PROJ-$1');
    return null;
  }
  let url = null;
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !/^https?:\/\/\S+$/.test(raw.url) || !raw.url.includes('{ticket}')) {
      problems.push('ticket.url 必须是包含 {ticket} 的 http(s) 地址');
    } else url = raw.url;
  }
  return pattern ? { pattern, key: raw.key, url } : null;
}

function parsePullRequests(raw, problems) {
  if (!isObject(raw) || typeof raw.owner !== 'string' || !OWNER.test(raw.owner)) {
    problems.push('pullRequests.owner 必须是 GitHub 用户或组织名');
    return null;
  }
  const search = raw.search === undefined ? '{ticket}' : raw.search;
  if (typeof search !== 'string' || !search.includes('{ticket}')) {
    problems.push('pullRequests.search 必须包含 {ticket}');
    return null;
  }
  return { owner: raw.owner, search };
}

export function parseConfig(text) {
  const base = () => ({
    requiredArtifacts: [...DEFAULT_REQUIRED],
    requiredExplicit: false,
    resumeLine: new RegExp(DEFAULT_RESUME, 'm'),
    ticket: null,
    pullRequests: null,
    apply: DEFAULT_APPLY,
    finish: DEFAULT_FINISH,
    task: DEFAULT_TASK,
    applyAnywhere: false,
    exclude: [],
  });
  if (text == null) return { config: base(), problems: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: base(), problems: ['openspec/board.json 不是合法 JSON，已使用默认规则'] };
  }
  if (!isObject(raw)) return { config: base(), problems: ['openspec/board.json 必须是 JSON 对象，已使用默认规则'] };
  const problems = [];
  const config = base();
  if (raw.requiredArtifacts !== undefined) {
    if (
      isStringList(raw.requiredArtifacts) &&
      raw.requiredArtifacts.length <= 20 &&
      raw.requiredArtifacts.every((name) => SAFE_PART.test(name) && name !== '.' && name !== '..')
    ) {
      config.requiredArtifacts = raw.requiredArtifacts;
      config.requiredExplicit = true;
    } else problems.push('requiredArtifacts 必须是变更目录里的文件或文件夹名');
  }
  if (raw.complete !== undefined) {
    problems.push('complete 已不再读取：任务全部勾上且没有打开的 PR，变更就是完成');
  }
  if (raw.resumeLine !== undefined) {
    const resume = compile(raw.resumeLine, 'resumeLine', problems);
    if (resume) config.resumeLine = resume;
  }
  if (raw.ticket !== undefined) config.ticket = parseTicket(raw.ticket, problems);
  if (raw.pullRequests !== undefined) config.pullRequests = parsePullRequests(raw.pullRequests, problems);
  if (raw.apply !== undefined) {
    if (typeof raw.apply === 'string' && raw.apply.trim() && raw.apply.length <= 4000) config.apply = raw.apply;
    else problems.push('apply 必须是非空指令，例如 /opsx:apply {change}');
  }
  if (raw.finish !== undefined) {
    if (typeof raw.finish === 'string' && raw.finish.trim() && raw.finish.length <= 8000) config.finish = raw.finish;
    else problems.push('finish 必须是非空指令或提示，例如 /opsx:archive {change}');
  }
  if (raw.task !== undefined) {
    if (typeof raw.task === 'string' && raw.task.includes('{task}') && raw.task.length <= 4000) config.task = raw.task;
    else problems.push('task 必须是包含 {task} 的指令');
  }
  if (raw.applyAnywhere !== undefined) {
    if (typeof raw.applyAnywhere === 'boolean') config.applyAnywhere = raw.applyAnywhere;
    else problems.push('applyAnywhere 必须是 true 或 false');
  }
  if (raw.files !== undefined) {
    const exclude = isObject(raw.files) ? raw.files.exclude : undefined;
    if (isStringList(exclude) && exclude.length <= 20 && exclude.every((name) => SAFE_PART.test(name))) config.exclude = exclude;
    else problems.push('files.exclude 必须是文件夹名列表');
  }
  return { config, problems };
}

export function schemaName(text) {
  const match = typeof text === 'string' ? SCHEMA_NAME.exec(text) : null;
  return match ? match[1] : null;
}

export function skipsSpecs(meta) {
  return SKIP_SPECS.test(meta ?? '');
}

/** 从项目 schema.yaml 的 generates 取出变更目录下的顶层文件或文件夹。 */
export function requiredFromSchema(yaml) {
  if (typeof yaml !== 'string' || !yaml) return null;
  const found = [];
  for (const match of yaml.matchAll(new RegExp(GENERATES.source, 'gm'))) {
    const raw = match[1].trim();
    if (!raw || raw.includes('..') || raw.startsWith('/')) continue;
    const top = raw.split('/')[0];
    if (top && SAFE_PART.test(top) && !found.includes(top)) found.push(top);
  }
  return found.length ? found : null;
}

export function fillTemplate(template, values) {
  const change = values.change ?? '';
  const ticket = values.ticket ?? '';
  if (template.includes('{ticket}') && !ticket) return { refused: `这条指令需要工单号，但「${change}」对不上工单规则` };
  const map = { change, ticket, task: values.task ?? '' };
  for (const [name, value] of Object.entries(map)) {
    if (CONTROL.test(value)) return { refused: `${name} 里有控制字符，已拒绝发送` };
  }
  const text = template.replace(/\{(change|ticket|task)\}/g, (_, name) => map[name]);
  if (CONTROL.test(text)) return { refused: '指令里有控制字符，已拒绝发送' };
  if (text.length > 32_000) return { refused: '指令超过 32KB，已拒绝发送' };
  if (!text.trim()) return { refused: '指令是空的，已拒绝发送' };
  return { text };
}

export function ticketOf(change, config) {
  const rule = config.ticket;
  if (!rule) return null;
  rule.pattern.lastIndex = 0;
  const match = rule.pattern.exec(change);
  if (!match) return null;
  const key = rule.key.replace(/\$(\d+)/g, (_, index) => match[Number(index)] ?? '');
  if (!key || CONTROL.test(key)) return null;
  const url = rule.url ? rule.url.replaceAll('{ticket}', encodeURIComponent(key)) : null;
  return { key, url };
}

function toggleFence(fence, line) {
  const match = FENCE.exec(line);
  if (!match) return fence;
  return fence === match[1] ? null : match[1];
}

export function parseTaskDocument(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const sections = [{ title: '', tasks: [] }];
  const tasks = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fence = toggleFence(fence, line);
      continue;
    }
    if (fence) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      sections.push({ title: heading[2].trim(), tasks: [] });
      continue;
    }
    const task = TASK.exec(line);
    if (!task) continue;
    let text = task[3].trim();
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() === '' || FENCE.test(next) || HEADING.test(next) || LIST.test(next)) break;
      i += 1;
      text = `${text} ${next.trim()}`.trim();
    }
    if (!text) continue;
    const item = { text, done: task[2] !== ' ' };
    sections[sections.length - 1].tasks.push(item);
    tasks.push(item);
  }
  return { tasks, sections: sections.filter((section) => section.tasks.length > 0) };
}

export function resumeText(markdown, pattern) {
  if (!markdown || !pattern) return null;
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => {
    pattern.lastIndex = 0;
    return pattern.test(line);
  });
  if (start < 0) return null;
  const following = lines.slice(start + 1);
  const end = following.findIndex((line) => PARAGRAPH_BREAK.test(line));
  const paragraph = [lines[start], ...following.slice(0, end < 0 ? following.length : end)]
    .map((line) => line.trim())
    .join(' ');
  pattern.lastIndex = 0;
  const stripped = paragraph.replace(pattern, '').trim();
  const text = stripped || paragraph.trim();
  if (!text) return null;
  return text.length > MAX_RESUME ? `${text.slice(0, MAX_RESUME - 1)}…` : text;
}

export function changeTitle(proposal) {
  if (!proposal) return null;
  const headings = [...String(proposal).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => match[1].trim());
  return headings.find((title) => title && !GENERIC_TITLE.test(title)) ?? null;
}

function inferState(line) {
  if (/(已合并|\bmerged\b)/i.test(line)) return 'merged';
  if (/(已关闭|\bclosed\b)/i.test(line)) return 'closed';
  if (/(草稿|\bdraft\b|打开|\bopen\b|待评审)/i.test(line)) return 'open';
  return 'unknown';
}

export function pullRequestsIn(markdown) {
  const byUrl = new Map();
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const re = new RegExp(PR_URL.source, 'g');
    for (const match of line.matchAll(re)) {
      const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
      const pr = {
        repository: `${match[1]}/${match[2]}`,
        number: Number(match[3]),
        state: inferState(line),
        draft: /(草稿|\bdraft\b)/i.test(line),
        title: '',
        url,
      };
      const prev = byUrl.get(url);
      if (!prev || STATE_RANK[pr.state] > STATE_RANK[prev.state]) byUrl.set(url, pr);
      else if (pr.draft) prev.draft = true;
    }
  }
  return [...byUrl.values()].sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
}

export function stageOf({ missing, tasks, pullRequests }) {
  if (missing.length > 0) return 'planning';
  const prs = pullRequests ?? [];
  if (prs.some((pr) => pr.state === 'open')) return 'in-review';
  const allTicked = tasks.total > 0 && tasks.done === tasks.total;
  if (allTicked) return 'complete';
  if (prs.some((pr) => pr.state === 'merged')) return 'merged';
  return tasks.done > 0 ? 'in-progress' : 'ready';
}

export function commandNames(stage, tasks) {
  const percent = tasks.total > 0 ? (tasks.done / tasks.total) * 100 : 0;
  switch (stage) {
    case 'planning':
      return [];
    case 'ready':
    case 'in-progress':
      return ['apply'];
    case 'in-review':
      return percent >= FINISH_FROM_PERCENT ? ['apply', 'finish'] : ['apply'];
    case 'merged':
    case 'complete':
      return ['finish'];
    default:
      return [];
  }
}

export function commandsFor(stage, tasks, config, name, ticket) {
  const commands = [];
  let refused = null;
  for (const nameOfCommand of commandNames(stage, tasks)) {
    const built = fillTemplate(config[nameOfCommand], { change: name, ticket: ticket?.key ?? '', task: '' });
    if (built.refused) refused = built.refused;
    else if (!commands.some((known) => known.text === built.text)) commands.push({ name: nameOfCommand, text: built.text });
  }
  return { commands, refused: commands.length > 0 ? null : refused };
}

export function placeChange(change, { sessions, currentId, applyAnywhere }) {
  if (!change.commands.length) return { kind: 'none', reason: change.refused };
  const keys = [change.ticket?.key, change.name].filter(Boolean);
  const owns = (session) => keys.some((key) => mentionsKey(session?.title ?? '', key));
  const visible = (sessions ?? []).filter((session) => session && typeof session.id === 'string' && session.id && !session.archived);
  const current = visible.find((session) => session.id === currentId) ?? null;
  const describe = (session) => ({
    sessionId: session.id,
    title: session.title || session.id,
    state: session.state || (session.running ? 'running' : 'idle'),
  });
  if ((applyAnywhere && current) || (current && owns(current))) return { kind: 'current', ...describe(current) };
  const others = visible
    .filter((session) => session.id !== currentId && owns(session))
    .sort((a, b) => {
      const rank = (session) => (session.state === 'running' || session.running ? 0 : 1);
      return rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.title ?? '').localeCompare(String(b.title ?? ''));
    });
  if (others[0]) return { kind: 'elsewhere', ...describe(others[0]) };
  return { kind: 'new', sessionId: null, title: change.ticket?.key || change.name, state: null };
}

export function assignPlaces(changes, ctx) {
  const stageIndex = (stage) => {
    const index = STAGES.indexOf(stage);
    return index < 0 ? STAGES.length : index;
  };
  return changes
    .map((change) => {
      const place = placeChange(change, ctx);
      return { ...change, place, pinned: place.kind === 'current' };
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || stageIndex(a.stage) - stageIndex(b.stage) || a.name.localeCompare(b.name));
}

function asEntries(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((entry) => entry && typeof entry.name === 'string' && typeof entry.directory === 'boolean');
}

function clip(text) {
  if (typeof text !== 'string') return null;
  return text.length > MAX_READ ? text.slice(0, MAX_READ) : text;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function collectMarkdown(files, dir, exclude) {
  const found = [];
  let truncated = false;
  const walk = async (relative, depth) => {
    if (found.length >= MAX_MD_FILES) {
      truncated = true;
      return;
    }
    const entries = asEntries(await files.list(relative ? `${dir}/${relative}` : dir)) ?? [];
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || CONTROL.test(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.directory) {
        if (depth < MAX_DEPTH && !exclude.includes(entry.name)) await walk(path, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        if (found.length >= MAX_MD_FILES) {
          truncated = true;
          return;
        }
        found.push(path);
      }
    }
  };
  await walk('', 0);
  const first = ['proposal.md', 'design.md', 'tasks.md'];
  found.sort((a, b) => {
    const rank = (path) => {
      const index = first.indexOf(path);
      return index < 0 ? first.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return { paths: found, truncated };
}

function capTasks(sections, config, name, ticket, canRun) {
  const capped = [];
  let left = MAX_TASKS;
  let truncated = false;
  let index = 0;
  for (const section of sections) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const tasks = [];
    for (const task of section.tasks) {
      if (left <= 0) {
        truncated = true;
        break;
      }
      const text = task.text.length > MAX_TASK_TEXT ? `${task.text.slice(0, MAX_TASK_TEXT - 1)}…` : task.text;
      let runText = null;
      if (canRun && !task.done) {
        const built = fillTemplate(config.task, { change: name, ticket: ticket?.key ?? '', task: text });
        runText = built.text ?? null;
      }
      tasks.push({ index, text, done: task.done, runText });
      index += 1;
      left -= 1;
    }
    if (tasks.length) capped.push({ title: section.title, tasks });
  }
  return { sections: capped, tasksTruncated: truncated };
}

async function readChange(files, name, config, projectSchema, loadSchema) {
  const dir = `openspec/changes/${name}`;
  const entries = asEntries(await files.list(dir));
  if (!entries) return null;
  const present = new Map(entries.map((entry) => [entry.name, entry]));
  const [tasksRaw, proposalRaw, metaRaw] = await Promise.all([
    files.text(`${dir}/tasks.md`),
    files.text(`${dir}/proposal.md`),
    files.text(`${dir}/.openspec.yaml`),
  ]);
  const tasksText = clip(tasksRaw);
  const proposal = clip(proposalRaw);
  const meta = clip(metaRaw);
  const skip = skipsSpecs(meta);
  let required = config.requiredArtifacts;
  if (!config.requiredExplicit) {
    const fromSchema = await loadSchema(schemaName(meta) || projectSchema);
    if (fromSchema) required = fromSchema;
  }
  required = required.filter((artifact) => !(skip && (artifact === 'specs' || artifact.startsWith('specs/'))));
  const missing = [];
  for (const artifact of required) {
    if (!SAFE_PART.test(artifact)) continue;
    const entry = present.get(artifact);
    if (!entry) {
      missing.push(artifact);
      continue;
    }
    if (entry.directory) {
      const kids = asEntries(await files.list(`${dir}/${artifact}`)) ?? [];
      if (!kids.some((kid) => !kid.name.startsWith('.'))) missing.push(artifact);
    }
  }
  const parsed = parseTaskDocument(tasksText ?? '');
  const tasks = { done: parsed.tasks.filter((task) => task.done).length, total: parsed.tasks.length };
  const { paths, truncated } = await collectMarkdown(files, dir, config.exclude);
  const bodies = [];
  for (const path of paths) {
    const text = clip(await files.text(`${dir}/${path}`));
    if (text) bodies.push(text);
  }
  const pullRequests = pullRequestsIn(bodies.join('\n'));
  const stage = stageOf({ missing, tasks, pullRequests });
  const ticket = ticketOf(name, config);
  const { commands, refused } = commandsFor(stage, tasks, config, name, ticket);
  const canRun = commands.some((command) => command.name === 'apply');
  const capped = capTasks(parsed.sections, config, name, ticket, canRun);
  return {
    name,
    title: changeTitle(proposal) || name,
    stage,
    missing,
    tasks,
    resume: resumeText(tasksText, config.resumeLine),
    ticket,
    pullRequests,
    commands,
    refused,
    docs: paths.slice(0, 20),
    docsTruncated: truncated || paths.length > 20,
    sections: capped.sections,
    tasksTruncated: capped.tasksTruncated,
  };
}

export async function readBoard(files) {
  const root = asEntries(await files.list('openspec'));
  if (!root) return { status: 'no-openspec', hasChangesDir: false, problems: [], notes: [], changes: [], applyAnywhere: false };
  const { config, problems } = parseConfig(clip(await files.text('openspec/board.json')));
  const notes = [];
  if (config.pullRequests) {
    notes.push('未联网查询 GitHub。PR 只认变更文档里的链接；同一行写上 open / merged / closed（或打开 / 已合并 / 已关闭）才会影响阶段。');
  }
  const changesDir = asEntries(await files.list('openspec/changes'));
  if (!changesDir) {
    return { status: 'no-changes', hasChangesDir: false, problems, notes, changes: [], applyAnywhere: config.applyAnywhere };
  }
  const projectSchema = schemaName(clip(await files.text('openspec/config.yaml')));
  const schemaCache = new Map();
  const loadSchema = async (name) => {
    if (!name) return null;
    if (schemaCache.has(name)) return schemaCache.get(name);
    const required = requiredFromSchema(clip(await files.text(`openspec/schemas/${name}/schema.yaml`)));
    schemaCache.set(name, required);
    return required;
  };
  const unsafe = changesDir.filter((entry) => entry.directory && entry.name !== ARCHIVE && !entry.name.startsWith('.') && !safeChangeName(entry.name));
  if (unsafe.length) problems.push(`已跳过名称不安全的变更：${unsafe.slice(0, 5).map((entry) => entry.name).join('、')}`);
  const names = changesDir
    .filter((entry) => entry.directory && safeChangeName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_CHANGES);
  const directoryCount = changesDir.filter((entry) => entry.directory && safeChangeName(entry.name)).length;
  if (directoryCount > MAX_CHANGES) problems.push(`进行中的变更超过 ${MAX_CHANGES} 个，只显示按名称排序的前 ${MAX_CHANGES} 个。`);
  const changes = (await mapPool(names, 4, (name) => readChange(files, name, config, projectSchema, loadSchema))).filter(Boolean);
  return {
    status: changes.length ? 'ready' : 'no-changes',
    hasChangesDir: true,
    problems,
    notes,
    changes,
    applyAnywhere: config.applyAnywhere,
  };
}

export async function readDetail(files, name, file) {
  if (!safeChangeName(name)) throw Object.assign(new Error('变更名称不合法'), { code: 'INVALID_ARGS' });
  if (typeof file !== 'string' || !file.endsWith('.md') || file.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw Object.assign(new Error('只能打开这个变更里的 Markdown'), { code: 'INVALID_ARGS' });
  }
  const rel = safeOpenspecRel(`openspec/changes/${name}/${file}`);
  if (!rel) throw Object.assign(new Error('路径不合法'), { code: 'INVALID_ARGS' });
  const text = await files.text(rel);
  if (typeof text !== 'string') return { text: null, truncated: false };
  return { text: text.length > DETAIL_CHARS ? text.slice(0, DETAIL_CHARS) : text, truncated: text.length > DETAIL_CHARS };
}

export function commandText(change, op, taskIndex) {
  if (op === 'apply' || op === 'finish') {
    const command = change.commands.find((item) => item.name === op);
    return command ? { text: command.text } : { refused: '这个阶段没有这个操作' };
  }
  if (op !== 'task') return { refused: '未知操作' };
  const flat = change.sections.flatMap((section) => section.tasks);
  const task = flat.find((item) => item.index === taskIndex) ?? flat[taskIndex];
  if (!task?.runText || task.done) return { refused: '这项任务不能单独发送' };
  return { text: task.runText };
}
