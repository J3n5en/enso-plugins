import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MAX_PASSWORD_CHARS, PASSWORD_SLOTS, SLOT_BUDGET } from './limits.mjs';

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

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

/** 把密码拆进若干个不超过 4000 字符的密钥字段。空地图会清空这些字段。 */
export function packVault(map) {
  const entries = [...map.entries()].filter(([id, password]) => ID_RE.test(id) && typeof password === 'string' && password.length > 0);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const slots = PASSWORD_SLOTS.map(() => ({}));
  let index = 0;
  for (const [id, password] of entries) {
    if (password.length > MAX_PASSWORD_CHARS) throw new Error('密码超过 1024 个字符，放不进 Enso 的密钥字段');
    let placed = false;
    for (let cursor = index; cursor < slots.length; cursor += 1) {
      const trial = { ...slots[cursor], [id]: password };
      if (JSON.stringify(trial).length <= SLOT_BUDGET) {
        slots[cursor] = trial;
        index = cursor;
        placed = true;
        break;
      }
      index = cursor + 1;
    }
    if (!placed) throw new Error('保存的密码太多，超过 4 个密钥字段的容量');
  }
  const patch = {};
  PASSWORD_SLOTS.forEach((key, slot) => {
    patch[key] = Object.keys(slots[slot]).length ? JSON.stringify(slots[slot]) : null;
  });
  return patch;
}

export function mergeConfigText(existingText, patch) {
  let json = {};
  if (existingText && String(existingText).trim()) {
    const parsed = JSON.parse(existingText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件不是对象');
    json = { ...parsed };
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete json[key];
    else json[key] = value;
  }
  return `${JSON.stringify(json)}\n`;
}

/** 写入宿主的插件配置文件（权限 600）。只改密码字段，保留行数上限等其它项。 */
export function writeVaultFile(file, patch) {
  if (!file) return false;
  mkdirSync(dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const next = mergeConfigText(existing, patch);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return true;
}

export function readVaultFile(file) {
  if (!file) return new Map();
  try {
    return unpackVault(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return new Map();
  }
}

/** 日志和错误信息里去掉密码，以及 URL 里的 userinfo。 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  const list = [...secrets].filter((item) => typeof item === 'string' && item.length >= 4);
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join('[redacted]');
  out = out.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/@]+):([^\s/@]+)@/gi, '$1://$2:[redacted]@');
  return out;
}
