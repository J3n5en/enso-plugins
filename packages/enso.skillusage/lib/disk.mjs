import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BUILTIN_AGENTS } from './builtin.mjs';
import { extensionMcpName, pluginPresetId } from './names.mjs';
import { baseName, claudePluginsDir, displayPath, normPath, userDataCandidates } from './paths.mjs';
import { buildReport, publicReport } from './report.mjs';
import { createScanner } from './sessions.mjs';
import { parseFrontmatter } from './skillfile.mjs';
import { charsToTokens } from './tokens.mjs';

export const SCAN_VERSION = 1;
const MAX_SETTINGS = 32 * 1024 * 1024;
const MAX_SKILL = 256 * 1024;
const MAX_SESSION = 64 * 1024 * 1024;
const MAX_JSONL_DEPTH = 4;

export async function loadReport(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const warnings = [];
  const sources = [];
  const profiles = discoverProfiles(env, platform, home);
  const entries = [];
  const events = [];
  const sessions = [];
  const presets = [];
  const projects = [];
  const profileMeta = [];

  for (const profile of profiles) {
    const read = readProfile(profile, home, platform, warnings, sources);
    profileMeta.push({
      id: profile.id,
      label: profile.label,
      loadLocalSkills: read.loadLocalSkills,
      loadHarnessAssets: read.loadHarnessAssets,
    });
    const scanned = await scanSessions(profile, home, options.cacheDir, warnings, sources);
    for (const event of scanned.events) events.push({ ...event, profile: profile.id });
    for (const session of scanned.sessions) {
      sessions.push(session);
      if (session.cwd) read.addProject(session.cwd, '');
    }
    entries.push(...read.entries);
    presets.push(...read.presets);
    projects.push(...read.projects);
  }

  if (!profiles.length) {
    const looked = userDataCandidates(env, platform, home).map((item) => displayPath(item.path, home));
    warnings.push(`没有找到 EnsoCode 数据目录。已查看：${looked.join('、')}`);
  }

  return publicReport(
    buildReport({
      filter: options.filter,
      now,
      platform,
      homedir: home,
      profiles: profileMeta,
      presets,
      projects,
      entries,
      events,
      sessions,
      warnings,
      sources,
    }),
  );
}

function discoverProfiles(env, platform, home) {
  const found = [];
  for (const candidate of userDataCandidates(env, platform, home)) {
    if (existsSync(join(candidate.path, 'settings.json')) || existsSync(join(candidate.path, 'agent', 'sessions'))) {
      found.push(candidate);
    }
  }
  return found;
}

function readProfile(profile, home, platform, warnings, sources) {
  const entries = [];
  const presets = [];
  const projects = [];
  const seenProjects = new Set();
  const settingsFile = join(profile.path, 'settings.json');
  sources.push({
    label: `${profile.label} · 设置`,
    path: displayPath(settingsFile, home),
    detail: '技能、MCP、预设、子代理、项目和已启用的 Claude 插件。不读取 env、请求头、URL 和密钥',
  });
  const settings = readJson(settingsFile, MAX_SETTINGS);
  const state = settings.ok ? objectState(settings.value) : {};
  if (!settings.ok && existsSync(settingsFile)) warnings.push(`${profile.label} 的 settings.json 读不出来，已跳过设置项`);
  const loadLocalSkills = state.loadLocalSkills === true;
  const loadHarnessAssets = state.loadHarnessAssets === true;

  const add = (entry) => {
    if (!entry || !entry.kind || !entry.name) return;
    entries.push({ ...entry, profile: profile.id });
  };

  for (const raw of arrayOf(state.skills)) add(settingsSkill(raw, home));
  for (const raw of arrayOf(state.mcpServers)) {
    const server = settingsMcp(raw);
    if (server) add(server);
  }
  const catalog = readToolCatalog(join(profile.path, 'mcp-tool-catalog.json'));
  if (Object.keys(catalog).length) {
    sources.push({
      label: `${profile.label} · MCP 工具名缓存`,
      path: displayPath(join(profile.path, 'mcp-tool-catalog.json'), home),
      detail: '只有工具名，用来显示个数。schema 不在这份缓存里，所以直接加载的 MCP 不估算 token',
    });
  }
  for (const entry of entries) {
    if (entry.kind === 'mcp' && catalog[entry.settingsId]) entry.toolCount = catalog[entry.settingsId].length;
  }

  for (const raw of arrayOf(state.presets)) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    presets.push({
      profile: profile.id,
      id: raw.id,
      name: text(raw.name) || raw.id,
      skillIds: strings(raw.skillIds),
      mcpServerIds: strings(raw.mcpServerIds),
      pluginPresetId: text(raw.pluginPresetId),
    });
  }
  for (const entry of entries) {
    if (!entry.settingsId) continue;
    const names = presets
      .filter((preset) => (entry.kind === 'skill' ? preset.skillIds : preset.mcpServerIds).includes(entry.settingsId))
      .map((preset) => preset.name);
    if (entry.enabled !== false) names.unshift('默认');
    entry.presetNames = names;
  }

  const disabledAgents = new Set(strings(state.disabledBuiltinAgentTypes).map((name) => name.toLowerCase()));
  for (const agent of BUILTIN_AGENTS) {
    add({
      kind: 'agent',
      name: agent.name,
      description: agent.description,
      origin: 'builtin',
      priority: 40,
      source: '内置子代理',
      disabled: disabledAgents.has(agent.name.toLowerCase()),
    });
  }
  for (const raw of arrayOf(state.agentTypes)) {
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    add({
      kind: 'agent',
      name: raw.name.trim(),
      description: text(raw.description),
      origin: 'custom',
      priority: 10,
      source: '自定义子代理',
    });
  }

  walkSkillRoot(join(home, '.agents', 'skills'), {
    origin: 'local',
    priority: 40,
    source: '本机 ~/.agents/skills',
  }, add);
  walkSkillRoot(join(profile.path, 'agent', 'pi-agent', 'skills'), {
    origin: 'local',
    priority: 50,
    source: 'Enso 的 pi-agent/skills',
  }, add);
  for (const extra of piSkillPaths(join(profile.path, 'agent', 'pi-agent', 'settings.json'))) {
    walkSkillRoot(extra, { origin: 'local', priority: 60, source: 'pi-agent/settings.json 里的技能路径' }, add);
  }

  const addProject = (projectPath, projectName) => {
    const key = normPath(projectPath, platform);
    if (!key || seenProjects.has(key)) return;
    seenProjects.add(key);
    const name = projectName || baseName(projectPath);
    if (!projects.some((project) => normPath(project.path, platform) === key)) {
      projects.push({ path: projectPath, name });
    }
    const common = { projectPath, projectName: name };
    walkSkillRoot(join(projectPath, '.agents', 'skills'), { ...common, origin: 'local', priority: 10, source: '项目 .agents/skills' }, add);
    walkSkillRoot(join(projectPath, '.pi', 'skills'), { ...common, origin: 'local', priority: 20, source: '项目 .pi/skills' }, add);
    walkSkillRoot(join(projectPath, '.claude', 'skills'), { ...common, origin: 'harness', priority: 70, source: '项目 .claude/skills' }, add);
    walkSkillRoot(join(projectPath, '.codex', 'skills'), { ...common, origin: 'harness', priority: 71, source: '项目 .codex/skills' }, add);
    walkSkillRoot(join(projectPath, '.cursor', 'skills'), { ...common, origin: 'harness', priority: 72, source: '项目 .cursor/skills' }, add);
  };

  for (const raw of arrayOf(state.projects)) {
    if (!raw || typeof raw.path !== 'string' || !raw.path) continue;
    addProject(raw.path, text(raw.name) || text(raw.title));
  }

  const enabledPlugins = arrayOf(state.plugins).filter((plugin) => plugin && plugin.enabled !== false && typeof plugin.key === 'string');
  if (enabledPlugins.length) {
    sources.push({
      label: `${profile.label} · 已启用的 Claude 插件`,
      path: displayPath(claudePluginsDir(home), home),
      detail: '只解析设置里 enabled 的插件。安装位置来自 installed_plugins.json，不扫描 ~/.claude 的会话',
    });
    addClaudePlugins(enabledPlugins, home, add, warnings, profile);
  }
  addExtensionPlugins(profile, home, add, presets, sources, warnings);

  return { entries: entries.filter(Boolean), presets, projects, loadLocalSkills, loadHarnessAssets, addProject };
}

function settingsSkill(raw, home) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.path !== 'string') return null;
  const file = skillFileOf(raw.path);
  const meta = file ? readSkillMeta(file) : null;
  const description = meta?.description || text(raw.description);
  const name = meta?.name || text(raw.name) || baseName(raw.path);
  return {
    kind: 'skill',
    name,
    description,
    origin: 'settings',
    priority: 30,
    source: text(raw.source) || '设置里的技能',
    settingsId: raw.id,
    enabled: raw.enabled !== false,
    modelVisible: meta ? meta.modelVisible && !!description : !!description,
    filePath: file || '',
    location: displayPath(file || raw.path, home),
    bodyTokens: meta?.bodyTokens ?? null,
    bodyApproximate: meta?.bodyApproximate === true,
  };
}

function settingsMcp(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) return null;
  const transport = raw.transport === 'http' || raw.transport === 'sse' || raw.transport === 'stdio' ? raw.transport : '';
  return {
    kind: 'mcp',
    name: raw.name,
    description: text(raw.description),
    origin: 'settings',
    priority: raw.loadMode === 'deferred' ? 20 : 10,
    source: text(raw.source) || '设置里的 MCP',
    settingsId: raw.id,
    enabled: raw.enabled !== false,
    loadMode: raw.loadMode === 'deferred' ? 'deferred' : 'direct',
    transport,
  };
}

function addClaudePlugins(enabled, home, add, warnings, profile) {
  const installed = listInstalledPlugins(claudePluginsDir(home));
  for (const plugin of enabled) {
    const found = installed.find((item) => item.key === plugin.key);
    if (!found) {
      warnings.push(`${profile.label} 启用了 Claude 插件 ${plugin.key}，但 installed_plugins.json 里没有安装目录`);
      continue;
    }
    const manifest = readPluginManifest(found.root);
    const pluginName = text(manifest.name) || text(plugin.name) || found.key;
    for (const dir of claudeSkillDirs(found.root, manifest)) {
      walkSkillRoot(dir, {
        origin: 'claude-plugin',
        priority: 80,
        source: `Claude 插件 ${pluginName}`,
        enabled: true,
      }, add);
    }
    for (const name of claudeMcpNames(found.root, manifest)) {
      add({
        kind: 'mcp',
        name,
        description: '',
        origin: 'claude-plugin',
        priority: 30,
        source: `Claude 插件 ${pluginName}`,
        enabled: true,
        loadMode: 'direct',
      });
    }
    for (const agent of claudeAgents(found.root, manifest, pluginName)) {
      add({
        kind: 'agent',
        name: agent.name,
        description: agent.description,
        origin: 'claude-plugin',
        priority: 20,
        source: `Claude 插件 ${pluginName}`,
        enabled: true,
        pluginId: plugin.key,
      });
    }
  }
}

function addExtensionPlugins(profile, home, add, presets, sources, warnings) {
  const root = join(profile.path, 'extension-plugins');
  const registryFile = join(root, 'registry.json');
  if (!existsSync(registryFile)) return;
  sources.push({
    label: `${profile.label} · Enso 插件`,
    path: displayPath(registryFile, home),
    detail: '已启用插件的技能、MCP 名、子代理类型和插件预设。不读取系统提示正文',
  });
  const registry = readJson(registryFile, 2 * 1024 * 1024);
  if (!registry.ok || !Array.isArray(registry.value?.plugins)) {
    warnings.push(`${profile.label} 的 extension-plugins/registry.json 读不出来`);
    return;
  }
  for (const record of registry.value.plugins) {
    if (!record || record.state !== 'enabled' || typeof record.id !== 'string' || typeof record.dir !== 'string') continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(record.dir)) continue;
    const pkg = join(root, 'packages', record.id, record.dir);
    const manifestFile = readJson(join(pkg, 'enso-plugin.json'), 256 * 1024);
    if (!manifestFile.ok || !manifestFile.value || typeof manifestFile.value !== 'object') continue;
    const manifest = manifestFile.value;
    const contributes = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {};
    const presetList = arrayOf(contributes.presets).filter((preset) => preset && typeof preset.id === 'string');
    const skillRels = strings(contributes.skills);
    const scopedSkills = new Set(presetList.flatMap((preset) => strings(preset.skills)));
    for (const rel of skillRels) {
      if (!safeRelative(rel)) continue;
      const selected = presetList
        .filter((preset) => strings(preset.skills).includes(rel))
        .map((preset) => pluginPresetId(record.id, preset.id));
      walkSkillRoot(join(pkg, rel), {
        origin: 'enso-plugin',
        priority: 90,
        source: `Enso 插件 ${text(manifest.name) || record.id}`,
        pluginId: record.id,
        pluginScoped: scopedSkills.has(rel),
        pluginPresetIds: selected,
        enabled: true,
      }, add);
    }
    const servers = arrayOf(contributes.mcpServers);
    const scopedMcp = new Set(presetList.flatMap((preset) => strings(preset.mcpServers)));
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || !server.name) continue;
      add({
        kind: 'mcp',
        name: extensionMcpName(record.id, server.name),
        description: text(manifest.name) ? `${text(manifest.name)} 插件` : '',
        origin: 'enso-plugin',
        priority: 40,
        source: `Enso 插件 ${text(manifest.name) || record.id}`,
        pluginId: record.id,
        pluginScoped: scopedMcp.has(server.name),
        pluginPresetIds: presetList
          .filter((preset) => strings(preset.mcpServers).includes(server.name))
          .map((preset) => pluginPresetId(record.id, preset.id)),
        enabled: true,
        loadMode: 'direct',
      });
    }
    const types = arrayOf(contributes.agentTypes);
    const scopedTypes = new Set(presetList.flatMap((preset) => strings(preset.agentTypes)));
    for (const type of types) {
      if (!type || typeof type.name !== 'string' || !type.name) continue;
      add({
        kind: 'agent',
        name: type.name,
        description: text(type.description),
        origin: 'enso-plugin',
        priority: 30,
        source: `Enso 插件 ${text(manifest.name) || record.id}`,
        pluginId: record.id,
        pluginScoped: scopedTypes.has(type.name),
        pluginPresetIds: presetList
          .filter((preset) => strings(preset.agentTypes).includes(type.name))
          .map((preset) => pluginPresetId(record.id, preset.id)),
        enabled: true,
      });
    }
    for (const preset of presetList) {
      presets.push({
        profile: profile.id,
        id: pluginPresetId(record.id, preset.id),
        name: `${text(manifest.name) || record.id} · ${text(preset.name) || preset.id}`,
        plugin: true,
        skillIds: [],
        mcpServerIds: [],
      });
    }
  }
}

function walkSkillRoot(root, base, add) {
  if (!root || !existsSync(root)) return;
  const files = [];
  collectSkillFiles(root, files, 0);
  for (const file of files) {
    const meta = readSkillMeta(file);
    if (!meta) continue;
    add({
      ...base,
      kind: 'skill',
      name: meta.name || baseName(dirname(file)),
      description: meta.description,
      modelVisible: meta.modelVisible && !!meta.description,
      filePath: file,
      location: file,
      bodyTokens: meta.bodyTokens,
      bodyApproximate: meta.bodyApproximate,
      enabled: base.enabled !== false,
    });
  }
}

function collectSkillFiles(dir, out, depth) {
  if (depth > 6) return;
  const skill = join(dir, 'SKILL.md');
  if (isFile(skill)) {
    out.push(skill);
    return;
  }
  let listed;
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of listed) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    const kind = fileKind(entry, full);
    if (kind === 'dir') collectSkillFiles(full, out, depth + 1);
    else if (kind === 'file' && depth === 0 && entry.name.endsWith('.md')) out.push(full);
  }
}

function readSkillMeta(file) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    if (info.size <= MAX_SKILL) {
      const text = readFileSync(file, 'utf8');
      const meta = parseFrontmatter(text);
      return finishMeta(meta, charsToTokens(text.length), false);
    }
    const meta = parseFrontmatter(readHead(file, 65_536));
    return finishMeta(meta, charsToTokens(info.size), true);
  } catch {
    return null;
  }
}

function finishMeta(meta, bodyTokens, bodyApproximate) {
  return {
    name: meta.name,
    description: meta.description,
    modelVisible: !meta.disableModelInvocation,
    bodyTokens,
    bodyApproximate,
  };
}

function skillFileOf(target) {
  if (!target) return '';
  try {
    const info = statSync(target);
    if (info.isFile()) return target;
    if (info.isDirectory() && isFile(join(target, 'SKILL.md'))) return join(target, 'SKILL.md');
  } catch {
    return '';
  }
  return '';
}

function piSkillPaths(file) {
  const parsed = readJson(file, 2 * 1024 * 1024);
  if (!parsed.ok || !Array.isArray(parsed.value?.skills)) return [];
  return parsed.value.skills.filter((item) => typeof item === 'string' && item && !item.includes('\0'));
}

function readToolCatalog(file) {
  const parsed = readJson(file, 5 * 1024 * 1024);
  const servers = parsed.ok && parsed.value && typeof parsed.value.servers === 'object' ? parsed.value.servers : null;
  const out = {};
  if (!servers) return out;
  for (const [id, row] of Object.entries(servers)) {
    if (!row || !Array.isArray(row.tools)) continue;
    const tools = row.tools.filter((tool) => typeof tool === 'string');
    if (tools.length) out[id] = tools;
  }
  return out;
}

function listInstalledPlugins(dir) {
  const parsed = readJson(join(dir, 'installed_plugins.json'), 2 * 1024 * 1024);
  const plugins = parsed.ok && parsed.value && typeof parsed.value.plugins === 'object' ? parsed.value.plugins : null;
  if (!plugins) return [];
  const result = [];
  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const chosen =
      installs.find((item) => item && item.scope === 'user' && typeof item.installPath === 'string') ||
      installs.find((item) => item && typeof item.installPath === 'string');
    if (!chosen) continue;
    result.push({ key, root: chosen.installPath });
  }
  return result;
}

function readPluginManifest(root) {
  const own = readJson(join(root, '.claude-plugin', 'plugin.json'), 256 * 1024);
  if (own.ok && own.value && typeof own.value === 'object') return own.value;
  const codex = readJson(join(root, '.codex-plugin', 'plugin.json'), 256 * 1024);
  if (codex.ok && codex.value && typeof codex.value === 'object') return codex.value;
  return {};
}

function claudeSkillDirs(root, manifest) {
  if (manifest.skills == null) {
    if (existsSync(join(root, 'skills'))) return [join(root, 'skills')];
    if (isFile(join(root, 'SKILL.md'))) return [root];
    return [];
  }
  const listed = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
  return listed.filter((item) => typeof item === 'string' && safeRelative(item)).map((item) => resolve(root, item));
}

function claudeMcpNames(root, manifest) {
  const names = [];
  const declared = manifest.mcpServers;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    const map = declared.mcpServers && typeof declared.mcpServers === 'object' ? declared.mcpServers : declared;
    names.push(...objectKeys(map));
  }
  const files = [];
  if (declared == null || (declared && typeof declared === 'object' && !Array.isArray(declared))) {
    files.push(join(root, '.mcp.json'));
  } else if (typeof declared === 'string' && safeRelative(declared)) files.push(resolve(root, declared));
  else if (Array.isArray(declared)) {
    for (const item of declared) if (typeof item === 'string' && safeRelative(item)) files.push(resolve(root, item));
  }
  for (const file of files) {
    const parsed = readJson(file, 256 * 1024);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') continue;
    const map =
      parsed.value.mcpServers && typeof parsed.value.mcpServers === 'object'
        ? parsed.value.mcpServers
        : parsed.value;
    names.push(...objectKeys(map));
  }
  return [...new Set(names)];
}

function claudeAgents(root, manifest, pluginName) {
  const dirs = [];
  if (manifest.agents == null) dirs.push(join(root, 'agents'));
  else {
    const listed = Array.isArray(manifest.agents) ? manifest.agents : [manifest.agents];
    for (const item of listed) if (typeof item === 'string' && safeRelative(item)) dirs.push(resolve(root, item));
  }
  const agents = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = isFile(dir) ? [dir] : markdownFiles(dir);
    for (const file of files) {
      const meta = readSkillMeta(file);
      if (!meta) continue;
      const name = meta.name || baseName(file).replace(/\.md$/i, '');
      agents.push({ name: `${pluginName}:${name}`, description: meta.description });
    }
  }
  return agents;
}

function markdownFiles(dir) {
  let listed;
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of listed) {
    if (!entry.name.endsWith('.md')) continue;
    const full = join(dir, entry.name);
    if (fileKind(entry, full) === 'file') files.push(full);
  }
  return files;
}

async function scanSessions(profile, home, cacheDir, warnings, sources) {
  const dir = join(profile.path, 'agent', 'sessions');
  sources.push({
    label: `${profile.label} · 会话`,
    path: displayPath(dir, home),
    detail: 'userData/agent/sessions 下的 jsonl。不读 ~/.claude/projects',
  });
  const files = [];
  collectJsonl(dir, files, 0);
  const cacheFile = cacheDir ? join(cacheDir, `sessions-${profile.id}.json`) : '';
  const cache = cacheFile ? readCache(cacheFile) : { version: SCAN_VERSION, files: {} };
  const events = [];
  const sessions = [];
  let skipped = 0;
  const live = new Set(files);
  for (const file of files) {
    let info;
    try {
      info = statSync(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_SESSION) {
      skipped += 1;
      continue;
    }
    const cached = cache.files[file];
    if (
      cached &&
      cached.version === SCAN_VERSION &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size &&
      Array.isArray(cached.events)
    ) {
      events.push(...cached.events);
      if (Array.isArray(cached.sessions)) sessions.push(...cached.sessions);
      continue;
    }
    const scanned = await scanFile(file);
    events.push(...scanned.events);
    sessions.push(...scanned.sessions);
    cache.files[file] = {
      version: SCAN_VERSION,
      mtimeMs: info.mtimeMs,
      size: info.size,
      events: scanned.events,
      sessions: scanned.sessions,
    };
  }
  for (const file of Object.keys(cache.files)) if (!live.has(file)) delete cache.files[file];
  if (cacheFile) writeCache(cacheFile, cache);
  if (skipped) warnings.push(`${profile.label} 有 ${skipped} 个超过 64MB 的会话文件，已跳过`);
  return { events, sessions };
}

function scanFile(file) {
  return new Promise((resolve, reject) => {
    const scanner = createScanner();
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on('line', (line) => scanner.push(line));
    lines.on('close', () => resolve(scanner.finish()));
    lines.on('error', reject);
    stream.on('error', reject);
  });
}

function collectJsonl(dir, out, depth) {
  if (depth > MAX_JSONL_DEPTH || !existsSync(dir)) return;
  let listed;
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of listed) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const kind = fileKind(entry, full);
    if (kind === 'dir') collectJsonl(full, out, depth + 1);
    else if (kind === 'file' && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

function readCache(file) {
  const parsed = readJson(file, 32 * 1024 * 1024);
  if (!parsed.ok || !parsed.value || parsed.value.version !== SCAN_VERSION || typeof parsed.value.files !== 'object') {
    return { version: SCAN_VERSION, files: {} };
  }
  return parsed.value;
}

function writeCache(file, cache) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, file);
  } catch {
    // 缓存写失败不影响这次结果
  }
}

function readJson(file, max) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return { ok: false };
    if (info.size > max) return { ok: false, reason: 'too-big' };
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

function readHead(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function objectState(settings) {
  const block = settings && typeof settings === 'object' ? settings['enso-settings'] : null;
  const state = block && typeof block === 'object' ? block.state : null;
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function objectKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, item]) => item && typeof item === 'object')
    .map(([key]) => key);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '..' && part !== '.');
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function fileKind(entry, full) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) {
    try {
      const info = statSync(full);
      if (info.isDirectory()) return 'dir';
      if (info.isFile()) return 'file';
    } catch {
      return '';
    }
  }
  return '';
}
