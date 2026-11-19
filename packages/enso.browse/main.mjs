import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PORT = 19988;
export const STORE_ID = 'mfnicocicmmlkpjnaffgihfjhdgjkdjg';
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`;
export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const RELEASE = 'https://anoma.ly/release';
const PAIR_EVERY_MS = 8 * 60 * 1000;

/** macOS / Linux 用安装脚本；Windows 用官方的 PowerShell 安装脚本 */
export function installCommand(platform = process.platform) {
  return platform === 'win32'
    ? 'irm https://opencode.ai/browse/install.ps1 | iex'
    : 'curl -fsSL https://opencode.ai/browse/install | bash';
}

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => undefined);
const exists = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function homeDir(env, platform) {
  if (platform === 'win32') return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || homedir();
}

function namesFor(platform) {
  return platform === 'win32' ? ['browse.exe', 'browse'] : ['browse', 'browse.exe'];
}

/** 插件自己下载的那份放在插件数据目录，卸载插件时一起删掉。bin/run 按同一位置找它 */
export function ownBinary(env = process.env, platform = process.platform) {
  if (!env.ENSO_PLUGIN_DATA) return null;
  return join(env.ENSO_PLUGIN_DATA, 'bin', platform === 'win32' ? 'browse.exe' : 'browse');
}

/** 先用本机已装的原版 browse（显式路径、~/.local/bin、PATH），没有再用插件下载的那份。与 bin/run 同序 */
export function browseBinary(env = process.env, platform = process.platform) {
  const home = homeDir(env, platform);
  const pathKey = platform === 'win32' ? Object.keys(env).find((key) => key.toLowerCase() === 'path') : 'PATH';
  const pathDirs = (env[pathKey] || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const dirs = [env.XDG_BIN_HOME, join(home, '.local', 'bin'), ...pathDirs].filter(Boolean);
  const candidates = [env.ENSO_BROWSE].filter(Boolean);
  for (const dir of dirs) {
    for (const name of namesFor(platform)) candidates.push(join(dir, name));
  }
  candidates.push(ownBinary(env, platform));
  return candidates.find((path) => path && exists(path)) ?? null;
}

const sysctl = (name) =>
  new Promise((resolve) => execFile('sysctl', ['-n', name], (error, out) => resolve(error ? '' : String(out).trim())));

/** 发布服务上的包名，选法与官方安装脚本一致 */
export async function releaseTarget({ platform = process.platform, arch = process.arch, probe = sysctl } = {}) {
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform];
  if (!os || !['arm64', 'x64'].includes(arch)) throw new Error(`browse 不支持 ${platform}/${arch}`);
  let cpu = arch;
  if (os === 'macos' && cpu === 'x64' && (await probe('sysctl.proc_translated')) === '1') cpu = 'arm64';
  if (os === 'windows') cpu = 'x64';
  let target = `${os}-${cpu}`;
  if (cpu === 'x64' && os === 'macos' && (await probe('hw.optional.avx2_0')) !== '1') target += '-baseline';
  if (cpu === 'x64' && os === 'linux') {
    const flags = (() => {
      try {
        return readFileSync('/proc/cpuinfo', 'utf8');
      } catch {
        return '';
      }
    })();
    if (!/\bavx2\b/.test(flags)) target += '-baseline';
  }
  if (os === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime) target += '-musl';
  return target;
}

/** 从 npm 打的 tgz 里取出一个文件。认 ustar 前缀、GNU 长名和 pax path */
export function extractFile(tgz, wanted) {
  const tar = gunzipSync(tgz);
  const text = (start, length) => tar.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  let longName = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    if (tar.subarray(at, at + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[at + 156] || 48);
    const prefix = text(at + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(at, 100)}` : text(at, 100));
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    longName = null;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    else if ((type === '0' || type === '\0') && name === wanted) return Buffer.from(body);
  }
  return null;
}

/**
 * 官方安装脚本的第一步：从发布服务取当前 stable 版本，核对大小和 sha256，放进插件数据目录。
 * 不跑 `browse install`，所以不改 PATH，也不碰其它 agent 的配置。
 */
export async function downloadBrowse({
  dest = ownBinary(),
  platform = process.platform,
  target,
  fetch: get = globalThis.fetch,
  service = RELEASE,
} = {}) {
  if (!dest) throw new Error('没有插件数据目录，无法下载');
  target ??= await releaseTarget({ platform });
  const manifest = await get(`${service}/browse/cli/stable.json`, { headers: { 'user-agent': 'browse/stable (enso)' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`发布清单 HTTP ${r.status}`))));
  if (manifest?.app !== 'browse' || manifest?.artifact !== 'cli' || manifest?.channel !== 'stable') {
    throw new Error('发布清单不是 browse 的 stable CLI');
  }
  const version = manifest.release?.version;
  const entry = manifest.release?.targets?.[target];
  if (!version || !entry) throw new Error(`browse ${version ?? ''} 没有 ${target} 的包`);
  if (typeof entry.url !== 'string' || !entry.url.startsWith('/')) throw new Error(`下载地址不对：${entry.url}`);
  const response = await get(service.replace(/\/release$/, '') + entry.url, { headers: { 'user-agent': `browse/${version} (enso)` } });
  if (!response.ok) throw new Error(`下载 browse HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (entry.size && archive.length !== entry.size) throw new Error(`大小不对：应为 ${entry.size}，实际 ${archive.length}`);
  const sha = createHash('sha256').update(archive).digest('hex');
  if (!entry.sha256 || sha !== String(entry.sha256).toLowerCase()) throw new Error(`校验不过：应为 ${entry.sha256}，实际 ${sha}`);
  const name = platform === 'win32' ? 'browse.exe' : 'browse';
  const binary = extractFile(archive, `package/bin/${name}`);
  if (!binary) throw new Error(`包里没有 package/bin/${name}`);
  await mkdir(join(dest, '..'), { recursive: true });
  // 先写新文件再改名；正在跑的中继还拿着旧文件
  await writeFile(`${dest}.new`, binary);
  await chmod(`${dest}.new`, 0o755);
  await rename(dest, `${dest}.old`).catch(() => {});
  await rename(`${dest}.new`, dest);
  await rm(`${dest}.old`, { force: true }).catch(() => {});
  return { version, target, path: dest };
}

/** 压缩包安装可能丢掉可执行位；git 与目录安装本来就有 */
export async function ensureExecutable(file = join(ROOT, 'bin', 'run')) {
  if (process.platform === 'win32') return;
  const { mode } = await stat(file);
  if ((mode & 0o111) !== 0o111) await chmod(file, mode | 0o755);
}

/** 原版数据目录：OPENCODE_BROWSER_HOME，否则 $XDG_DATA_HOME/browse */
export function dataDir() {
  if (process.env.OPENCODE_BROWSER_HOME) return process.env.OPENCODE_BROWSER_HOME;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg?.startsWith('/') ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'browse');
}

export function listenPort() {
  const port = Number(process.env.OPENCODE_BROWSER_PORT || PORT);
  return Number.isInteger(port) && port > 0 ? port : PORT;
}

/** 跑原版 browse。非零退出码也返回，调用方自己看输出 */
export function browse(args, { timeout = 30000 } = {}) {
  const exe = browseBinary();
  if (!exe) return Promise.reject(new Error(`没有找到原版 browse。安装：${installCommand()}`));
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(new Error(stderr.trim() || error.message));
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

export function parseCode(stdout) {
  return /Pairing code:\s*([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(stdout)?.[1];
}

/** 已配对的浏览器；不带密钥 */
export async function pairedBrowsers(home = dataDir()) {
  const tokens = (await readJson(join(home, 'browser-tokens.json'))) ?? {};
  return Object.entries(tokens).map(([key, value]) => ({
    key,
    id: value?.id ?? null,
    name: value?.name ?? null,
    pairedAt: value?.pairedAt ?? null,
    lastSeen: value?.lastSeen ?? null,
  }));
}

async function relay(home, path, init = {}) {
  const token = (await readFile(join(home, 'relay-token'), 'utf8').catch(() => '')).trim();
  if (!token) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${listenPort()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/** 向原版中继要一张一次性码。扩展在自己的设置页里填 */
export async function issueCode() {
  const { stdout, stderr } = await browse(['pair', '--wait-seconds', '0']);
  const code = parseCode(stdout);
  if (!code) throw new Error(stdout.trim() || stderr.trim() || '没有拿到配对码');
  return { code, expiresAt: Date.now() + 10 * 60 * 1000 };
}

export async function state(home = dataDir(), issued = null) {
  const status = await relay(home, '/extension/status');
  const binary = browseBinary();
  return {
    port: listenPort(),
    storeUrl: STORE_URL,
    install: installCommand(),
    binary,
    own: Boolean(binary) && binary === ownBinary(),
    relay: Boolean(status),
    connected: Boolean(status?.connected),
    version: status?.version ?? null,
    pairingState: status?.pairingState ?? null,
    browsers: status?.browsers ?? [],
    paired: await pairedBrowsers(home),
    tabs: status?.targets ?? [],
    code: issued && issued.expiresAt > Date.now() ? issued : null,
  };
}

let timer = null;

/** @param {import('enso-plugin').EnsoMain} enso */
export async function activate(enso) {
  let issued = null;
  let installing = null;
  const home = () => dataDir();
  process.env.ENSO_PLUGIN_DATA ||= enso.dataDir;

  const pairIfNeeded = async () => {
    if (!browseBinary()) return;
    if ((await pairedBrowsers(home())).length) return;
    issued = await issueCode();
  };

  enso.renderer.handle('state', () => state(home(), issued));
  enso.renderer.handle('pair', async () => {
    issued = await issueCode();
    return state(home(), issued);
  });
  enso.renderer.handle('revoke', async (args) => {
    const key = String(args?.key ?? '');
    if (!key) throw new Error('缺少浏览器');
    const { code, stdout } = await browse(['pair', '--revoke', key]);
    if (code !== 0) throw new Error(stdout.trim() || '取消配对失败');
    await pairIfNeeded();
    return state(home(), issued);
  });
  enso.renderer.handle('install', async () => {
    installing ??= downloadBrowse().finally(() => (installing = null));
    await installing;
    await pairIfNeeded().catch(() => {});
    return state(home(), issued);
  });
  enso.renderer.handle('reveal', async () => {
    await enso.ui.openExternal(STORE_URL);
    return true;
  });
  enso.renderer.handle('copy', async (args) => {
    const text = { store: STORE_URL, install: installCommand(), code: issued?.code }[args?.what];
    if (!text) throw new Error('不支持');
    await enso.ui.clipboard.writeText(text);
    return true;
  });

  await ensureExecutable().catch((error) => console.error('bin/run 不可执行', error.message));
  const tick = () => pairIfNeeded().catch((error) => console.error('配对码失败', error.message));
  await tick();
  timer = setInterval(tick, PAIR_EVERY_MS);
  timer.unref?.();
}

export function deactivate() {
  clearInterval(timer);
  timer = null;
}
