import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MAX_PASSWORD_CHARS, PASSWORD_SLOTS } from './limits.mjs';

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function vaultFileFromDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) return '';
  return join(dataDir, 'vault.json');
}

export function configFileFromDataDir(dataDir, pluginId) {
  if (typeof dataDir !== 'string' || !dataDir || typeof pluginId !== 'string' || !pluginId) return null;
  if (basename(dataDir) !== pluginId) return null;
  if (basename(dirname(dataDir)) !== 'data') return null;
  return join(dirname(dirname(dataDir)), 'config', `${pluginId}.json`);
}

export function unpackVault(config) {
  const map = new Map();
  if (!config || typeof config !== 'object') return map;
  for (const slot of PASSWORD_SLOTS) {
    const raw = config[slot];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('密钥配置不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('密钥配置必须是对象');
    for (const [id, password] of Object.entries(parsed)) {
      if (!ID_RE.test(id) || typeof password !== 'string') continue;
      map.set(id, password);
    }
  }
  return map;
}

export function readLegacyConfigFile(file) {
  if (!file) return new Map();
  try {
    return unpackVault(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return new Map();
  }
}

function mapFromObject(parsed) {
  const map = new Map();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
  for (const [id, password] of Object.entries(parsed)) {
    if (!ID_RE.test(id) || typeof password !== 'string' || !password) continue;
    map.set(id, password);
  }
  return map;
}

/** 读插件数据目录里的 vault.json。文件不存在时 missing=true。 */
export function readVaultFile(file) {
  if (!file) return { missing: true, map: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { missing: false, map: mapFromObject(parsed) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { missing: true, map: new Map() };
    throw new Error('密码文件无法读取');
  }
}

/** 写入插件数据目录的 vault.json（权限 600）。临时文件 + rename 原子替换。 */
export function writeVaultFile(file, map) {
  if (!file) return false;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const obj = {};
  for (const [id, password] of map) {
    if (!ID_RE.test(id) || typeof password !== 'string' || !password) continue;
    if (password.length > MAX_PASSWORD_CHARS) throw new Error('密码超过 1024 个字符');
    obj[id] = password;
  }
  writeFileSync(tmp, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return true;
}

/** 日志和错误信息里去掉密码，以及 URL 里的 userinfo。 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  const list = [...secrets].filter((item) => typeof item === 'string' && item.length >= 1);
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join('[redacted]');
  out = out.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^?#\s]+)@/gi, (match, scheme, userinfo) => {
    const colon = userinfo.indexOf(':');
    if (colon === -1) return match;
    return `${scheme}://${userinfo.slice(0, colon)}:[redacted]@`;
  });
  out = out.replace(/([?&](?:password|pwd)=)([^&\s]*)/gi, '$1[redacted]');
  return out;
}
