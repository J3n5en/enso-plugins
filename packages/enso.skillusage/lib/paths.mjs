import { join } from 'node:path';

export function appDataDir(env, platform, homedir) {
  if (platform === 'darwin') return join(homedir, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || join(homedir, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || join(homedir, '.config');
}

/**
 * EnsoCode 的 userData。打包版是 appData/enso-code，开发版是 appData/enso-code-dev
 * （src/main/index.ts）。插件进程默认拿不到 ENSO_USER_DATA_DIR，只有环境里真有这份变量时才多看一眼。
 */
export function userDataCandidates(env, platform, homedir) {
  const base = appDataDir(env, platform, homedir);
  const list = [
    { id: 'packaged', label: '打包版', path: join(base, 'enso-code') },
    { id: 'dev', label: '开发版', path: join(base, 'enso-code-dev') },
  ];
  const override = typeof env.ENSO_USER_DATA_DIR === 'string' ? env.ENSO_USER_DATA_DIR.trim() : '';
  if (override) list.unshift({ id: 'override', label: '指定目录', path: override });
  return list;
}

export function claudePluginsDir(homedir) {
  return join(homedir, '.claude', 'plugins');
}

export function normPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return '';
  let text = value.replace(/\\/g, '/');
  if (platform === 'win32') text = text.toLowerCase();
  if (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

export function samePath(a, b, platform = process.platform) {
  const left = normPath(a, platform);
  const right = normPath(b, platform);
  return left !== '' && left === right;
}

export function baseName(value) {
  const text = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const cut = text.lastIndexOf('/');
  return cut >= 0 ? text.slice(cut + 1) : text;
}

export function displayPath(value, homedir) {
  const raw = String(value || '').replace(/\\/g, '/');
  const home = String(homedir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && (raw === home || raw.startsWith(`${home}/`))) return `~${raw.slice(home.length)}`;
  return raw;
}

export function clip(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
