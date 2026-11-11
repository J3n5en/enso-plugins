import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './zip.mjs';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
export const ENGINE_RE = /^>=(\d+)\.(\d+)\.(\d+)$/;
export const MAX_FILES = 5000;
export const MAX_BYTES = 200 * 1024 * 1024;
export const MAX_README = 256 * 1024;
const PATH_RE = /^[A-Za-z0-9._/-]+$/;

export function knownOptions(argv, names) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!names.includes(arg)) throw new Error(`未知参数 ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
    out[arg.slice(2)] = value;
  }
  return out;
}

export function isCommunity(env = process.env) {
  return /^(1|true|yes)$/i.test(env.ENSO_COMMUNITY_PR ?? '');
}

export function indexNow(env = process.env) {
  if (!env.ENSO_INDEX_TIME) return new Date().toISOString();
  const date = new Date(env.ENSO_INDEX_TIME);
  if (Number.isNaN(date.getTime())) throw new Error('ENSO_INDEX_TIME 不是合法时间');
  return date.toISOString();
}

/** 有 package-lock.json 的插件在打包前安装依赖。依赖进发布包，不进 Git。 */
export function installPackageDeps(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return;
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name);
    if (!existsSync(join(dir, 'package-lock.json'))) continue;
    const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
    if (npm.status !== 0) throw new Error(`${name}: npm ci 失败\n${npm.stderr || npm.stdout || ''}`);
  }
}

function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const p = left[i];
    const q = right[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function compareSemver(a, b) {
  const left = SEMVER_RE.exec(a);
  const right = SEMVER_RE.exec(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return comparePrerelease(left[4], right[4]);
}

export function checkPackageLimits(count, bytes) {
  const errors = [];
  if (count > MAX_FILES) errors.push(`文件数 ${count} 超过 ${MAX_FILES}`);
  if (bytes > MAX_BYTES) errors.push(`体积 ${bytes} 超过 200MB`);
  return errors;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').sort() : [];
}

export function capabilities(manifest) {
  const events = manifest?.contributes?.events;
  const intercept = Array.isArray(events)
    ? events
        .filter((event) => event && event.mode === 'intercept' && typeof event.event === 'string')
        .map((event) => event.event)
        .sort()
    : [];
  return {
    permissions: strings(manifest?.permissions),
    fsRead: strings(manifest?.fs?.read),
    fsWrite: strings(manifest?.fs?.write),
    domains: strings(manifest?.net?.domains),
    mcp: strings(manifest?.mcp?.tools),
    env: strings(manifest?.env),
    interop: strings(manifest?.interop?.call),
    resident: manifest?.resident === true,
    intercept,
  };
}

function quote(items) {
  return items.map((item) => `\`${item}\``).join('、');
}

function listDiff(label, before, after) {
  const lines = [];
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  if (added.length) lines.push(`- 新增${label}：${quote(added)}`);
  if (removed.length) lines.push(`- 移除${label}：${quote(removed)}`);
  return lines;
}

function diffCaps(before, after) {
  const lines = [
    ...listDiff('权限', before.permissions, after.permissions),
    ...listDiff('文件读范围', before.fsRead, after.fsRead),
    ...listDiff('文件写范围', before.fsWrite, after.fsWrite),
    ...listDiff('域名', before.domains, after.domains),
    ...listDiff('MCP 工具', before.mcp, after.mcp),
    ...listDiff('环境变量', before.env, after.env),
    ...listDiff('可调用插件', before.interop, after.interop),
    ...listDiff('拦截事件', before.intercept, after.intercept),
  ];
  if (before.resident !== after.resident) lines.push(after.resident ? '- 改为常驻' : '- 取消常驻');
  return lines;
}

const emptyCaps = () => capabilities({});

export function permissionSummary(current, base) {
  if (!base) return '## 权限变更\n\n未找到基线，跳过与 base 的对比。\n';
  const sections = [];
  for (const id of [...new Set([...Object.keys(current), ...Object.keys(base)])].sort()) {
    const next = current[id];
    const prev = base[id];
    if (!prev) {
      const lines = diffCaps(emptyCaps(), capabilities(next));
      sections.push([`### \`${id}\` 新插件 ${next.version}`, ...(lines.length ? lines : ['- 无权限声明'])].join('\n'));
      continue;
    }
    if (!next) {
      sections.push(`### \`${id}\` 已从仓库移除`);
      continue;
    }
    const changes = diffCaps(capabilities(prev), capabilities(next));
    if (!changes.length && prev.version === next.version) continue;
    const title =
      prev.version === next.version
        ? `### \`${id}\` ${next.version}`
        : `### \`${id}\` ${prev.version ?? '未知'} → ${next.version}`;
    sections.push([title, ...(changes.length ? changes : ['- 权限、文件范围、域名与拦截事件无变化'])].join('\n'));
  }
  return sections.length ? `## 权限变更\n\n${sections.join('\n\n')}\n` : '## 权限变更\n\n无权限变更。\n';
}

function parseManifest(raw, dirName) {
  if (Buffer.byteLength(raw) > 256 * 1024) return { errors: ['清单超过 256KB'] };
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { errors: ['清单不是 JSON'] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['清单必须是对象'] };
  const errors = [];
  if (json.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof json.id !== 'string' || json.id.length > 40 || !ID_RE.test(json.id)) errors.push('id 不合法');
  else if (json.id !== dirName) errors.push(`目录名 ${dirName} 与 id ${json.id} 不一致`);
  if (typeof json.name !== 'string' || json.name.trim() === '' || json.name.length > 60) errors.push('name 不合法');
  if (typeof json.version !== 'string' || json.version.length > 40 || !SEMVER_RE.test(json.version)) errors.push('version 必须是 semver');
  if (json.description != null && typeof json.description !== 'string') errors.push('description 不合法');
  if (json.permissions == null) json.permissions = [];
  else if (
    !Array.isArray(json.permissions) ||
    json.permissions.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > 64)
  ) {
    errors.push('permissions 不合法');
  }
  if (json.engines != null) {
    const enso = json.engines?.enso;
    if (typeof json.engines !== 'object' || Array.isArray(json.engines) || (enso != null && !ENGINE_RE.test(enso))) {
      errors.push('engines.enso 必须是 >=x.y.z');
    }
  }
  return { manifest: json, errors };
}

function optionalText(value, label, errors, check) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 500 || !check(value)) {
    errors.push(`${label} 不合法`);
    return undefined;
  }
  return value;
}

function parseMeta(raw) {
  if (raw == null) return { meta: { tier: 'community', tags: [] }, errors: [] };
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { errors: ['市场元数据不是 JSON'] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['市场元数据必须是对象'] };
  const errors = [];
  if (json.tier !== 'official' && json.tier !== 'community') errors.push('tier 必须是 official 或 community');
  const tags = json.tags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.length > 20 ||
    tags.some((tag) => typeof tag !== 'string' || tag.trim() === '' || tag.length > 32)
  ) {
    errors.push('tags 不合法');
  }
  const homepage = optionalText(json.homepage, 'homepage', errors, (value) => value.startsWith('https://'));
  const icon = optionalText(json.icon, 'icon', errors, (value) => {
    if (value.startsWith('https://')) return true;
    return PATH_RE.test(value) && !value.split('/').includes('..') && !value.startsWith('/');
  });
  if (json.category != null && !CATEGORIES.includes(json.category)) {
    errors.push(`category 不合法，只能是 ${CATEGORIES.join(' / ')}`);
  }
  const screenshots = json.screenshots ?? [];
  if (!validScreenshots(screenshots)) errors.push('screenshots 不合法：最多 6 张，每张 { url: https 地址, alt }');
  return {
    meta: {
      tier: json.tier === 'official' ? 'official' : 'community',
      tags: Array.isArray(tags) ? tags : [],
      homepage,
      icon,
      category: CATEGORIES.includes(json.category) ? json.category : undefined,
      screenshots: validScreenshots(screenshots) ? screenshots : [],
    },
    errors,
  };
}

/** 市场固定分类，与 EnsoCode 的 MARKET_CATEGORIES 一致 */
export const CATEGORIES = ['themes', 'agent', 'productivity', 'integrations', 'insights', 'writing', 'fun'];

function validScreenshots(value) {
  return (
    Array.isArray(value) &&
    value.length <= 6 &&
    value.every(
      (shot) =>
        shot &&
        typeof shot === 'object' &&
        typeof shot.url === 'string' &&
        shot.url.startsWith('https://') &&
        shot.url.length <= 1000 &&
        typeof shot.alt === 'string' &&
        shot.alt.length <= 200 &&
        Object.keys(shot).every((key) => key === 'url' || key === 'alt'),
    )
  );
}

async function inspectDir(dir) {
  const files = [];
  const errors = [];
  let bytes = 0;
  async function walk(rel) {
    const abs = join(dir, rel);
    for (const ent of await readdir(abs, { withFileTypes: true })) {
      if (ent.name === '.DS_Store') continue;
      const name = rel ? `${rel}/${ent.name}` : ent.name;
      const child = join(abs, ent.name);
      if (ent.isSymbolicLink()) {
        errors.push(`不允许符号链接 ${name}`);
        continue;
      }
      if (ent.isDirectory()) {
        await walk(name);
        continue;
      }
      if (!ent.isFile()) {
        errors.push(`不支持的文件 ${name}`);
        continue;
      }
      if (ent.name.toLowerCase().endsWith('.node')) errors.push(`禁止 .node 文件 ${name}`);
      const stat = await lstat(child);
      bytes += stat.size;
      files.push({ name, abs: child, size: stat.size });
    }
  }
  await walk('');
  errors.push(...checkPackageLimits(files.length, bytes));
  return { files, bytes, errors };
}

export async function readPackages(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return { packages: [], errors: ['缺少 packages 目录'] };
  const packages = [];
  const errors = [];
  const names = (await readdir(packagesDir, { withFileTypes: true }))
    .filter((ent) => ent.name !== '.DS_Store')
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of names) {
    if (!ent.isDirectory()) {
      errors.push(`packages/${ent.name} 不是目录`);
      continue;
    }
    const id = ent.name;
    const dir = join(packagesDir, id);
    const manifestPath = join(dir, 'enso-plugin.json');
    if (!existsSync(manifestPath)) {
      errors.push(`${id}: 缺少 enso-plugin.json`);
      continue;
    }
    const parsed = parseManifest(await readFile(manifestPath, 'utf8'), id);
    const metaPath = join(root, 'registry/meta', `${id}.json`);
    const metaParsed = parseMeta(existsSync(metaPath) ? await readFile(metaPath, 'utf8') : null);
    const inspected = await inspectDir(dir);
    if (inspected.files.some((file) => file.name === 'README.md' && file.size > MAX_README)) inspected.errors.push('README.md 超过 256KB');
    const pluginErrors = [...parsed.errors, ...metaParsed.errors, ...inspected.errors].map((error) => `${id}: ${error}`);
    errors.push(...pluginErrors);
    if (parsed.manifest && pluginErrors.length === 0) {
      packages.push({ id, dir, manifest: parsed.manifest, meta: metaParsed.meta, files: inspected.files, bytes: inspected.bytes });
    }
  }
  const metaDir = join(root, 'registry/meta');
  if (existsSync(metaDir)) {
    const known = new Set(names.filter((ent) => ent.isDirectory()).map((ent) => ent.name));
    for (const name of await readdir(metaDir)) {
      if (name.endsWith('.json') && !known.has(name.slice(0, -5))) errors.push(`多余的市场元数据 ${name}`);
    }
  }
  return { packages, errors };
}

function git(root, args) {
  return spawnSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
}

function resolveBase(root, explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.BASE_REF, process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '', 'origin/main', 'main'].filter(Boolean);
  if (!existsSync(join(root, '.git'))) return null;
  for (const ref of candidates) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0) return ref;
  }
  return null;
}

function gitText(root, ref, spec) {
  const result = git(root, ['show', `${ref}:${spec}`]);
  return result.status === 0 ? result.stdout : null;
}

function tierOf(meta) {
  return meta?.tier === 'official' ? 'official' : 'community';
}

/** registry/delisted.json：从索引移除的插件 id；已发布的 zip 保留，已安装的用户不受影响 */
function readDelisted(root) {
  const path = join(root, 'registry', 'delisted.json');
  if (!existsSync(path)) return new Set();
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !ID_RE.test(id))) {
    throw new Error('registry/delisted.json 必须是插件 id 数组');
  }
  return new Set(list);
}

const CATALOG_START = '<!-- plugins:start -->';
const CATALOG_END = '<!-- plugins:end -->';

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function catalogMarkdown(packages, externals = {}) {
  const rows = packages
    .filter((plugin) => !plugin.id.startsWith('local.'))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines = ['| 插件 | id | 版本 | 来源 | 介绍 |', '| --- | --- | --- | --- | --- |'];
  for (const plugin of rows) {
    const manifest = plugin.manifest;
    const tier = tierOf(plugin.meta) === 'official' ? '官方' : '社区';
    const external = externals[plugin.id];
    const href = plugin.meta?.homepage || (external ? `https://github.com/${external.repo}` : '');
    const name = href ? `[${manifest.name}](${href})` : manifest.name;
    const source = external ? `${tier} · [\`${external.repo}\`](https://github.com/${external.repo})` : tier;
    lines.push(`| ${cell(name)} | \`${plugin.id}\` | ${cell(manifest.version)} | ${source} | ${cell(manifest.description || '')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function readExternals(root) {
  const dir = join(root, 'registry', 'external');
  const map = {};
  if (!existsSync(dir)) return map;
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      map[name.slice(0, -5)] = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      map[name.slice(0, -5)] = {};
    }
  }
  return map;
}

export function readmeWithCatalog(readme, catalog) {
  const block = `${CATALOG_START}\n${catalog}${CATALOG_END}`;
  if (readme.includes(CATALOG_START) && readme.includes(CATALOG_END)) {
    return readme.replace(new RegExp(`${CATALOG_START}[\\s\\S]*?${CATALOG_END}`), block);
  }
  return `${readme.trimEnd()}\n\n## 插件\n\n${block}\n`;
}

function readBasePackages(root, ref, errors) {
  const listed = git(root, ['ls-tree', '-d', '--name-only', `${ref}:packages`]);
  if (listed.status !== 0) return {};
  const map = {};
  for (const line of listed.stdout.split('\n').map((item) => item.trim()).filter(Boolean)) {
    const id = line.split('/').pop();
    const text = gitText(root, ref, `packages/${id}/enso-plugin.json`);
    if (text == null) continue;
    try {
      map[id] = JSON.parse(text);
    } catch {
      errors.push(`无法解析基线清单 packages/${id}/enso-plugin.json`);
    }
  }
  return map;
}

function readBaseTier(root, ref, id) {
  const text = gitText(root, ref, `registry/meta/${id}.json`);
  if (text == null) return 'community';
  try {
    return tierOf(JSON.parse(text));
  } catch {
    return null;
  }
}

function externalPin(raw) {
  if (!raw || typeof raw.repo !== 'string' || typeof raw.commit !== 'string') return null;
  const path = raw.path == null || raw.path === '' ? '.' : raw.path;
  if (typeof path !== 'string') return null;
  return `${raw.repo}@${raw.commit}:${path}`;
}

function readBaseExternals(root, ref) {
  const listed = git(root, ['ls-tree', '-r', '--name-only', `${ref}:registry/external`]);
  if (listed.status !== 0) return {};
  const map = {};
  for (const name of listed.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.endsWith('.json'))) {
    const id = name.split('/').pop().slice(0, -5);
    const text = gitText(root, ref, `registry/external/${name}`);
    if (text == null) continue;
    try {
      map[id] = JSON.parse(text);
    } catch {
      // 基线声明损坏时不当成「pin 没变」
    }
  }
  return map;
}

async function pinnedManifest(spec, fetchImpl) {
  const path = spec.path == null || spec.path === '' ? '.' : spec.path;
  const prefix = path === '.' ? '' : `${path.split('/').map((part) => encodeURIComponent(part)).join('/')}/`;
  const url = `https://raw.githubusercontent.com/${spec.repo}/${spec.commit}/${prefix}enso-plugin.json`;
  try {
    const res = await fetchImpl(url);
    if (!res?.ok) return null;
    const json = JSON.parse(await res.text());
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/** 外部插件不进 Git。pin 没变就不是这个 PR 的变更；pin 变了再读旧清单，避免每次都显示成新插件。 */
async function alignExternalBaseline(root, ref, current, base, fetchImpl) {
  const currentSpecs = await readExternals(root);
  const baseSpecs = readBaseExternals(root, ref);
  for (const [id, spec] of Object.entries(currentSpecs)) {
    const cur = externalPin(spec);
    const prev = externalPin(baseSpecs[id]);
    if (!cur || !prev) continue;
    if (cur === prev) {
      if (!base[id]) delete current[id];
      continue;
    }
    if (!current[id] || base[id]) continue;
    const manifest = await pinnedManifest(baseSpecs[id], fetchImpl);
    if (manifest) base[id] = manifest;
  }
  for (const [id, spec] of Object.entries(baseSpecs)) {
    if (!externalPin(spec) || currentSpecs[id] || current[id] || base[id]) continue;
    base[id] = { version: '未知' };
  }
}

export async function validateRepo(root, options = {}) {
  installPackageDeps(root);
  const { packages, errors } = await readPackages(root);
  const readmePath = join(root, 'README.md');
  if (existsSync(readmePath) && packages.length && options.catalog !== false) {
    const readme = await readFile(readmePath, 'utf8');
    const next = readmeWithCatalog(readme, catalogMarkdown(packages, await readExternals(root)));
    if (next !== readme) errors.push('README 插件索引过期，运行 node scripts/catalog.mjs');
  }
  const community = options.community ?? isCommunity();
  const explicit = options.base ?? process.env.BASE_REF ?? '';
  const baseRef = resolveBase(root, options.base);
  if ((options.base || process.env.BASE_REF) && !baseRef) errors.push(`找不到基线 ${explicit || options.base}`);
  let summary = permissionSummary(null, null);
  if (baseRef) {
    const baseErrors = [];
    const base = readBasePackages(root, baseRef, baseErrors);
    errors.push(...baseErrors);
    const current = Object.fromEntries(packages.map((plugin) => [plugin.id, plugin.manifest]));
    await alignExternalBaseline(root, baseRef, current, base, options.fetch ?? fetch);
    summary = permissionSummary(current, base);
    if (community) {
      const ids = new Set([...Object.keys(base), ...packages.map((plugin) => plugin.id)]);
      for (const id of ids) {
        const before = readBaseTier(root, baseRef, id);
        if (before == null) {
          errors.push(`无法解析基线 tier registry/meta/${id}.json`);
          continue;
        }
        const plugin = packages.find((item) => item.id === id);
        if (!plugin) continue;
        const after = plugin.meta.tier;
        if (before !== after) errors.push(`社区 PR 不能修改 ${id} 的 tier（${before} → ${after}）`);
      }
    }
  } else if (community) {
    errors.push('找不到基线，无法审核社区 PR 的 tier');
  }
  return { ok: errors.length === 0, errors, summary };
}

function normalizeVersion(raw) {
  if (!raw || typeof raw.version !== 'string' || typeof raw.path !== 'string' || typeof raw.sha256 !== 'string' || !Number.isSafeInteger(raw.size) || raw.size <= 0) {
    throw new Error('已发布的 index.json 含无法识别的版本');
  }
  const version = { version: raw.version };
  if (typeof raw.engines?.enso === 'string') version.engines = { enso: raw.engines.enso };
  version.permissions = Array.isArray(raw.permissions) ? raw.permissions.filter((item) => typeof item === 'string') : [];
  version.path = raw.path;
  version.sha256 = raw.sha256;
  version.size = raw.size;
  if (typeof raw.publishedAt === 'string' && raw.publishedAt) version.publishedAt = raw.publishedAt;
  return version;
}

function latestOf(versions) {
  return versions.reduce((best, item) => (compareSemver(item.version, best.version) > 0 ? item : best)).version;
}

function sortVersions(versions) {
  return [...versions].sort((a, b) => compareSemver(a.version, b.version));
}

function validReadme(raw) {
  return (
    typeof raw?.path === 'string' &&
    PATH_RE.test(raw.path) &&
    !raw.path.split('/').includes('..') &&
    /^[0-9a-f]{64}$/.test(raw.sha256) &&
    Number.isSafeInteger(raw.size) &&
    raw.size > 0 &&
    raw.size <= MAX_README
  );
}

function pluginRecord({ id, name, description, tier, tags, homepage, icon, category, screenshots, readme, versions }) {
  const record = {
    id,
    name: String(name).slice(0, 60),
    description: typeof description === 'string' ? description.slice(0, 1000) : '',
    tier: tier === 'official' ? 'official' : 'community',
    tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag.trim() && tag.length <= 32).slice(0, 20) : [],
  };
  if (typeof homepage === 'string' && homepage.trim()) record.homepage = homepage;
  if (typeof icon === 'string' && icon.trim()) record.icon = icon;
  if (CATEGORIES.includes(category)) record.category = category;
  if (validScreenshots(screenshots) && screenshots.length > 0)
    record.screenshots = screenshots.map(({ url, alt }) => ({ url, alt }));
  if (validReadme(readme)) record.readme = { path: readme.path, sha256: readme.sha256, size: readme.size };
  record.latest = latestOf(versions);
  record.versions = sortVersions(versions);
  return record;
}

function assertPrevious(index) {
  if (!index) return;
  if (index.schemaVersion !== 1 || !Number.isSafeInteger(index.sequence) || index.sequence < 0 || !Array.isArray(index.plugins)) {
    throw new Error('已发布的 index.json 不合法');
  }
  for (const plugin of index.plugins) {
    if (!plugin || typeof plugin.id !== 'string') throw new Error('已发布的 index.json 不合法');
    for (const version of plugin.versions ?? []) normalizeVersion(version);
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) throw new Error(`已发布插件 ${plugin.id} 没有版本`);
  }
}

function readPrevious(root) {
  const local = join(root, 'out/v1/index.json');
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  if (!existsSync(join(root, '.git'))) return null;
  for (const ref of ['dist', 'origin/dist']) {
    const shown = git(root, ['show', `${ref}:v1/index.json`]);
    if (shown.status === 0 && shown.stdout.trim()) return JSON.parse(shown.stdout);
  }
  return null;
}

export async function buildRepo(root, env = process.env) {
  installPackageDeps(root);
  const { packages, errors } = await readPackages(root);
  if (errors.length) throw new Error(errors.join('\n'));
  const previous = readPrevious(root);
  assertPrevious(previous);
  const now = indexNow(env);
  const delisted = readDelisted(root);
  for (const plugin of packages) if (delisted.has(plugin.id)) throw new Error(`${plugin.id} 已下架，不能同时在 packages/ 里`);
  const previousPlugins = new Map(
    (previous?.plugins ?? []).filter((plugin) => !delisted.has(plugin.id)).map((plugin) => [plugin.id, plugin]),
  );
  const staged = [];
  for (const plugin of packages) {
    const files = [];
    for (const file of plugin.files) files.push({ name: file.name, data: await readFile(file.abs) });
    const zip = zipFiles(files);
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const version = plugin.manifest.version;
    const path = `packages/${plugin.id}/${version}.zip`;
    if (!PATH_RE.test(path) || path.split('/').includes('..')) throw new Error(`${plugin.id}: 包路径不合法`);
    const readmeData = files.find((file) => file.name === 'README.md')?.data;
    const readme = readmeData?.length
      ? {
          path: `packages/${plugin.id}/${version}.readme.md`,
          sha256: createHash('sha256').update(readmeData).digest('hex'),
          size: readmeData.length,
          data: readmeData,
        }
      : undefined;
    const oldVersions = (previousPlugins.get(plugin.id)?.versions ?? []).map(normalizeVersion);
    const existing = oldVersions.find((item) => item.version === version);
    if (existing && (existing.sha256 !== sha256 || existing.size !== zip.length || existing.path !== path)) {
      throw new Error(`${plugin.id}@${version} 已发布且内容不同，不能覆盖`);
    }
    const versions = existing
      ? oldVersions
      : [
          ...oldVersions,
          {
            version,
            ...(plugin.manifest.engines?.enso ? { engines: { enso: plugin.manifest.engines.enso } } : {}),
            permissions: plugin.manifest.permissions,
            path,
            sha256,
            size: zip.length,
            publishedAt: now,
          },
        ];
    staged.push({ plugin, zip, path, readme, versions });
  }
  for (const item of staged) {
    const dest = join(root, 'out/v1', item.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, item.zip);
    if (item.readme) await writeFile(join(root, 'out/v1', item.readme.path), item.readme.data);
  }
  const seen = new Set(staged.map((item) => item.plugin.id));
  const plugins = staged.map((item) =>
    pluginRecord({
      id: item.plugin.id,
      name: item.plugin.manifest.name,
      description: item.plugin.manifest.description,
      tier: item.plugin.meta.tier,
      tags: item.plugin.meta.tags,
      homepage: item.plugin.meta.homepage,
      icon: item.plugin.meta.icon,
      category: item.plugin.meta.category,
      screenshots: item.plugin.meta.screenshots,
      readme: item.readme,
      versions: item.versions,
    }),
  );
  for (const [id, plugin] of previousPlugins) {
    if (seen.has(id)) continue;
    const versions = (plugin.versions ?? []).map(normalizeVersion);
    plugins.push(
      pluginRecord({
        id,
        name: plugin.name ?? id,
        description: plugin.description,
        tier: plugin.tier,
        tags: plugin.tags,
        homepage: plugin.homepage,
        icon: plugin.icon,
        category: plugin.category,
        screenshots: plugin.screenshots,
        readme: plugin.readme,
        versions,
      }),
    );
  }
  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sequence = (previous?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('sequence 溢出');
  const index = { schemaVersion: 1, generatedAt: now, sequence, plugins };
  const text = `${JSON.stringify(index, null, 2)}\n`;
  const indexPath = join(root, 'out/v1/index.json');
  await mkdir(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, indexPath);
  await rm(join(root, 'out/v1/index.json.sig'), { force: true });
  return { index, indexPath, bytes: Buffer.from(text) };
}

