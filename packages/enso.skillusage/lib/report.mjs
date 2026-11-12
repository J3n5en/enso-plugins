import { RARE_CALLS } from './builtin.mjs';
import { mcpNamespaceName, parsePluginPresetId } from './names.mjs';
import { baseName, clip, displayPath, normPath, samePath } from './paths.mjs';
import {
  AGENT_LIST_PREFIX_TOKENS,
  agentEntryTokens,
  deferredMcpTokens,
  skillEntryTokens,
  skillsPromptTokens,
} from './tokens.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeFilter(raw) {
  const days = raw?.days === 0 || raw?.days === 7 || raw?.days === 30 || raw?.days === 90 ? raw.days : 30;
  return {
    profile: typeof raw?.profile === 'string' && raw.profile ? raw.profile : 'all',
    project: typeof raw?.project === 'string' && raw.project ? raw.project : 'all',
    preset: typeof raw?.preset === 'string' && raw.preset ? raw.preset : 'default',
    days,
  };
}

/**
 * entries 是磁盘清单，events 是会话调用。
 * inPrompt 表示「按当前预设，这场会话的提示词里会有它」，不是历史会话当时的预设
 * （jsonl 不记录预设 id）。
 */
export function buildReport(input) {
  const filter = normalizeFilter(input.filter);
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const platform = input.platform || 'linux';
  const homedir = input.homedir || '';
  const profiles = Array.isArray(input.profiles) ? input.profiles : [];
  const presets = Array.isArray(input.presets) ? input.presets : [];
  const projects = projectCatalog(input.projects, input.entries, input.sessions, platform);
  const entries = (Array.isArray(input.entries) ? input.entries : []).map((entry) =>
    withNamespace(entry),
  );
  const visible = entries.filter((entry) => inView(entry, filter, platform));
  const marked = visible.map((entry) => ({
    ...entry,
    inPrompt: inPrompt(entry, filter, presets, profiles, platform),
  }));
  const folded = fold(marked);
  const events = resolveReads(input.events, entries, platform).filter((event) =>
    eventInScope(event, filter, now, platform),
  );
  const cards = folded.map((card) => attachUsage(card, events, projects, platform, homedir));
  const orphans = orphanCards(events, cards, projects, platform, homedir);
  const all = [...cards, ...orphans].sort(byName);
  const unused = all
    .filter((card) => card.inPrompt && card.calls === 0)
    .sort(byTokens);
  const rare = all
    .filter((card) => card.inPrompt && card.calls > 0 && card.calls <= RARE_CALLS)
    .sort(byTokens);
  const loaded = all.filter((card) => card.inPrompt);
  const overview = summarize(loaded, events, profiles, filter);
  return {
    filter,
    overview,
    cards: all,
    unused,
    rare,
    projects: projects.map((project) => ({ id: project.id, name: project.name })),
    presets: presetOptions(presets, filter),
    profiles: profiles.map((profile) => ({ id: profile.id, label: profile.label })),
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    sources: Array.isArray(input.sources) ? input.sources : [],
    generatedAt: now,
  };
}

function withNamespace(entry) {
  if (entry.kind !== 'mcp') return entry;
  return { ...entry, namespace: entry.namespace || mcpNamespaceName(entry.name) };
}

function inView(entry, filter, platform) {
  if (filter.profile !== 'all' && entry.profile !== filter.profile) return false;
  if (!entry.projectPath || filter.project === 'all') return true;
  return samePath(entry.projectPath, filter.project, platform);
}

function inPrompt(entry, filter, presets, profiles, platform) {
  if (entry.disabled) return false;
  if (entry.projectPath && filter.project === 'all') return false;
  if (entry.projectPath && filter.project !== 'all' && !samePath(entry.projectPath, filter.project, platform)) {
    return false;
  }
  const profile = profiles.find((item) => item.id === entry.profile) || {};
  const preset = resolvePreset(entry.profile, filter, presets);
  if (preset?.missing) return false;
  const userPreset = preset && !preset.plugin ? preset : null;
  const pluginPresetId = preset?.plugin ? preset.id : userPreset?.pluginPresetId || '';
  if (entry.kind === 'skill') {
    return skillInPrompt(entry, profile, userPreset, pluginPresetId) && entry.modelVisible !== false;
  }
  if (entry.kind === 'mcp') return mcpInPrompt(entry, userPreset, pluginPresetId);
  if (entry.kind === 'agent') return agentInPrompt(entry, pluginPresetId);
  return false;
}

function resolvePreset(profile, filter, presets) {
  if (filter.preset === 'default') return null;
  const found = presets.find((preset) => preset.profile === profile && preset.id === filter.preset);
  return found || { missing: true, id: filter.preset };
}

function skillInPrompt(entry, profile, userPreset, pluginPresetId) {
  if (entry.origin === 'settings') {
    if (userPreset) return userPreset.skillIds.includes(entry.settingsId);
    return entry.enabled !== false;
  }
  if (entry.origin === 'local') return !userPreset && profile.loadLocalSkills === true;
  if (entry.origin === 'harness') return profile.loadHarnessAssets === true;
  if (entry.origin === 'claude-plugin') return entry.enabled !== false;
  if (entry.origin === 'enso-plugin') {
    if (!entry.pluginScoped) return true;
    return pluginPresetId !== '' && (entry.pluginPresetIds || []).includes(pluginPresetId);
  }
  return false;
}

function mcpInPrompt(entry, userPreset, pluginPresetId) {
  if (entry.origin === 'settings') {
    if (userPreset) return userPreset.mcpServerIds.includes(entry.settingsId);
    return entry.enabled !== false;
  }
  if (entry.origin === 'claude-plugin') return entry.enabled !== false;
  if (entry.origin === 'enso-plugin') {
    if (!entry.pluginScoped) return true;
    return pluginPresetId !== '' && (entry.pluginPresetIds || []).includes(pluginPresetId);
  }
  return false;
}

function agentInPrompt(entry, pluginPresetId) {
  if (entry.origin === 'builtin' || entry.origin === 'custom') return true;
  if (entry.origin === 'claude-plugin') return entry.enabled !== false;
  if (entry.origin === 'enso-plugin') {
    if (!entry.pluginScoped) return true;
    return pluginPresetId !== '' && (entry.pluginPresetIds || []).includes(pluginPresetId);
  }
  return false;
}

function fold(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const cards = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) => a.priority - b.priority || String(a.pluginId || '').localeCompare(String(b.pluginId || '')),
    );
    const active = group.filter((entry) => entry.inPrompt);
    const winner = active[0] || group[0];
    const shadowed = group.filter((entry) => entry !== winner);
    cards.push(toCard(winner, shadowed, active.includes(winner)));
  }
  return cards;
}

function groupKey(entry) {
  if (entry.kind === 'agent') return `agent\0${entry.name.trim().toLowerCase()}`;
  if (entry.kind === 'mcp') return `mcp\0${entry.namespace}`;
  return `skill\0${entry.name}`;
}

function toCard(entry, shadowed, inPromptFlag) {
  const modelVisible = entry.kind !== 'skill' || entry.modelVisible !== false;
  const prompt =
    entry.kind === 'skill'
      ? {
          name: entry.name,
          description: entry.description || '',
          location: entry.filePath || entry.location || '',
        }
      : null;
  let loadedTokens = null;
  if (inPromptFlag) {
    if (entry.kind === 'skill') loadedTokens = skillEntryTokens(prompt);
    else if (entry.kind === 'agent') loadedTokens = agentEntryTokens(entry.name, entry.description);
    else if (entry.loadMode === 'deferred') loadedTokens = deferredMcpTokens(entry.name, entry.description);
  }
  const notes = [];
  if (entry.note) notes.push(entry.note);
  if (entry.kind === 'skill' && entry.modelVisible === false) notes.push('设了 disable-model-invocation，不进提示词，只能 /skill: 调用');
  if (entry.projectPath && !inPromptFlag) notes.push('只在这个项目的会话里出现');
  if (shadowed.length) {
    notes.push(`同名还有 ${shadowed.map((item) => item.source || item.origin).join('、')}，提示词里只用优先级更高的一份`);
  }
  return {
    key: groupKey(entry),
    profile: entry.profile || '',
    kind: entry.kind,
    name: entry.name,
    description: clip(entry.description, 240),
    origin: entry.origin,
    existence: existenceOf(entry),
    source: entry.source || '',
    project: entry.projectName || (entry.projectPath ? baseName(entry.projectPath) : ''),
    projectPath: entry.projectPath || '',
    location: entry.location || '',
    inPrompt: inPromptFlag,
    loadedTokens,
    bodyTokens: entry.kind === 'skill' ? entry.bodyTokens ?? null : null,
    bodyApproximate: entry.bodyApproximate === true,
    enabled: entry.enabled !== false && entry.disabled !== true,
    loadMode: entry.loadMode || '',
    toolCount: Number.isInteger(entry.toolCount) ? entry.toolCount : null,
    presets: entry.presetNames || [],
    note: notes.filter(Boolean).join('。'),
    modelVisible,
    prompt,
    calls: 0,
    projects: [],
    models: [],
    tools: [],
  };
}

function existenceOf(entry) {
  if (entry.origin === 'builtin') return '内置';
  if (entry.origin === 'custom') return '自定义';
  if (entry.origin === 'claude-plugin' || entry.origin === 'enso-plugin') return '插件';
  if (entry.projectPath) return '项目';
  if (entry.origin === 'settings') return '已登记';
  return '本机';
}

function resolveReads(events, entries, platform) {
  const byPath = new Map();
  for (const entry of entries) {
    if (entry.kind === 'skill' && entry.filePath) byPath.set(normPath(entry.filePath, platform), entry.name);
  }
  return (Array.isArray(events) ? events : []).map((event) => {
    if (event.kind !== 'skill-read') return event;
    const name = byPath.get(normPath(event.path, platform)) || baseName(String(event.path || '').replace(/[/\\]SKILL\.md$/i, ''));
    return {
      kind: 'skill',
      name,
      via: 'read',
      ts: event.ts ?? null,
      model: event.model || '',
      provider: event.provider || '',
      sessionId: event.sessionId || '',
      cwd: event.cwd || '',
      profile: event.profile || '',
    };
  });
}

function eventInScope(event, filter, now, platform) {
  if (filter.profile !== 'all' && event.profile && event.profile !== filter.profile) return false;
  if (filter.project !== 'all' && !samePath(event.cwd, filter.project, platform)) return false;
  if (filter.days === 0) return true;
  if (typeof event.ts !== 'number') return false;
  return event.ts >= now - filter.days * DAY_MS;
}

function attachUsage(card, events, projects, platform, homedir) {
  const matched = events.filter((event) => eventKey(event) === card.key);
  const projectCounts = new Map();
  const modelCounts = new Map();
  const toolCounts = new Map();
  for (const event of matched) {
    const project = projectLabel(event.cwd, projects, platform);
    if (project) projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
    const model = modelLabel(event);
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    if (event.tool) toolCounts.set(event.tool, (toolCounts.get(event.tool) || 0) + 1);
  }
  return {
    ...card,
    location: card.location ? displayPath(card.location, homedir) : '',
    calls: matched.length,
    projects: topCounts(projectCounts, 12),
    models: [...modelCounts.keys()].slice(0, 8),
    tools: topCounts(toolCounts, 12),
  };
}

function eventKey(event) {
  if (event.kind === 'agent') return `agent\0${String(event.name || '').trim().toLowerCase()}`;
  if (event.kind === 'mcp') return `mcp\0${event.name}`;
  return `skill\0${event.name}`;
}

function orphanCards(events, cards, projects, platform, homedir) {
  const known = new Set(cards.map((card) => card.key));
  const groups = new Map();
  for (const event of events) {
    const key = eventKey(event);
    if (!key || known.has(key) || event.kind === 'skill-read') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const cardsOut = [];
  for (const [key, group] of groups) {
    const sample = group[0];
    const kind = sample.kind === 'mcp' ? 'mcp' : sample.kind === 'agent' ? 'agent' : 'skill';
    const name = kind === 'mcp' ? sample.name.replace(/^mcp__/, '') : sample.name;
    if (!name) continue;
    cardsOut.push(
      attachUsage(
        {
          key,
          kind,
          name,
          description: '',
          origin: 'session',
          existence: '仅会话',
          source: '会话记录',
          project: '',
          projectPath: '',
          location: '',
          inPrompt: false,
          loadedTokens: null,
          bodyTokens: null,
          bodyApproximate: false,
          enabled: true,
          loadMode: '',
          toolCount: null,
          presets: [],
          note: '会话里调用过，当前 Enso 的技能、MCP 或子代理清单里没有同名项',
          modelVisible: true,
          calls: 0,
          projects: [],
          models: [],
          tools: [],
        },
        group,
        projects,
        platform,
        homedir,
      ),
    );
  }
  return cardsOut;
}

function summarize(loaded, events, profiles, filter) {
  const ids =
    filter.profile === 'all' ? (profiles.length ? profiles.map((profile) => profile.id) : ['']) : [filter.profile];
  let loadedTokens = 0;
  for (const id of ids) {
    const cards = loaded.filter((card) => card.profile === id);
    const skills = cards.filter((card) => card.kind === 'skill' && card.prompt);
    if (skills.length) loadedTokens += skillsPromptTokens(skills.map((card) => card.prompt));
    const agents = cards.filter((card) => card.kind === 'agent');
    if (agents.length) {
      loadedTokens += AGENT_LIST_PREFIX_TOKENS;
      loadedTokens += agents.reduce((sum, card) => sum + (card.loadedTokens || 0), 0);
    }
    for (const card of cards) {
      if (card.kind === 'mcp' && card.loadedTokens != null) loadedTokens += card.loadedTokens;
    }
  }
  const count = (kind) => loaded.filter((card) => card.kind === kind && card.calls === 0).length;
  return {
    loadedTokens,
    tokensPartial: loaded.some((card) => card.kind === 'mcp' && card.loadedTokens == null),
    loadedCount: loaded.length,
    unusedCount: loaded.filter((card) => card.calls === 0).length,
    rareCount: loaded.filter((card) => card.calls > 0 && card.calls <= RARE_CALLS).length,
    unusedSkills: count('skill'),
    unusedMcp: count('mcp'),
    unusedAgents: count('agent'),
    calls: events.length,
    sessions: new Set(events.map((event) => event.sessionId).filter(Boolean)).size,
    profileNote:
      filter.profile === 'all' && profiles.length > 1
        ? '多个数据目录的占用加在一起，不代表同一次会话。'
        : filter.project === 'all'
          ? '未选项目时，占用不含各项目自己的技能。选一个项目后会计入。'
          : '',
  };
}

function projectCatalog(projects, entries, sessions, platform) {
  const map = new Map();
  const add = (id, name) => {
    const key = normPath(id, platform);
    if (!key) return;
    if (!map.has(key)) map.set(key, { id: key, name: name || baseName(key) });
    else if (name && map.get(key).name === baseName(key)) map.get(key).name = name;
  };
  for (const project of projects || []) add(project.path || project.id, project.name);
  for (const entry of entries || []) if (entry.projectPath) add(entry.projectPath, entry.projectName);
  for (const session of sessions || []) if (session.cwd) add(session.cwd, '');
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function projectLabel(cwd, projects, platform) {
  if (!cwd) return '';
  const key = normPath(cwd, platform);
  const known = projects.find((project) => project.id === key);
  return known?.name || baseName(cwd);
}

function modelLabel(event) {
  if (!event.model) return '';
  return event.provider ? `${event.provider}/${event.model}` : event.model;
}

function topCounts(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, limit)
    .map(([name, calls]) => ({ name, calls }));
}

function presetOptions(presets, filter) {
  const list = [{ id: 'default', name: '默认（跟随开关）' }];
  const seen = new Set(['default']);
  for (const preset of presets) {
    if (filter.profile !== 'all' && preset.profile !== filter.profile) continue;
    if (!preset.id || seen.has(preset.id)) continue;
    seen.add(preset.id);
    list.push({ id: preset.id, name: preset.name || preset.id });
  }
  return list;
}

function byName(a, b) {
  return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh');
}

function byTokens(a, b) {
  const left = a.loadedTokens == null ? -1 : a.loadedTokens;
  const right = b.loadedTokens == null ? -1 : b.loadedTokens;
  return right - left || a.name.localeCompare(b.name, 'zh');
}

export function publicReport(report) {
  const hide = (card) => {
    const next = { ...card };
    delete next.projectPath;
    delete next.key;
    delete next.modelVisible;
    delete next.prompt;
    delete next.profile;
    return next;
  };
  return {
    ...report,
    cards: report.cards.map(hide),
    unused: report.unused.map(hide),
    rare: report.rare.map(hide),
  };
}
