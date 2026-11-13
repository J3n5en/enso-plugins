import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DOWNLOAD = 256 * 1024;
/** data URL 经 JSON 返回必须 < 64KB */
export const MAX_RAW = 40 * 1024;
const ALLOWED = /^(image\/jpeg|image\/jpg|image\/png|image\/gif|image\/webp|image\/x-icon|image\/vnd\.microsoft\.icon)(;.*)?$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
};

function coversDir(root) {
  return join(root, 'covers');
}

function loadManifest(root) {
  try {
    const raw = JSON.parse(readFileSync(join(coversDir(root), 'manifest.json'), 'utf8'));
    const byId = raw && typeof raw === 'object' ? raw.byId : null;
    return byId && typeof byId === 'object' ? byId : {};
  } catch {
    return {};
  }
}

function safeCoverFile(root, rel) {
  const name = String(rel || '').replace(/\\/g, '/');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\0')) return null;
  if (!/^[0-9a-f.-]+\.(jpg|jpeg|png|gif|webp|ico)$/i.test(name)) return null;
  const full = join(coversDir(root), name);
  const dir = coversDir(root);
  if (!full.startsWith(dir)) return null;
  return existsSync(full) ? full : null;
}

export function readLocalCover(id, { root = PLUGIN_ROOT } = {}) {
  if (!UUID_RE.test(String(id || ''))) return { ok: false };
  const rel = loadManifest(root)[id];
  const file = safeCoverFile(root, rel);
  if (!file) return { ok: false };
  try {
    const buf = readFileSync(file);
    if (!buf.length || buf.length > MAX_RAW) return { ok: false };
    const ext = file.split('.').pop().toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/png';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false };
  }
}

export async function resolveCover(id, url, opts = {}) {
  const local = readLocalCover(id, opts);
  if (local.ok) return local;
  return fetchCover(url, opts);
}

export async function fetchCover(url, { fetchApi = fetch, timeoutMs = 8_000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchApi(url, {
      headers: { 'User-Agent': 'BoxRadio/0.1.0', Accept: 'image/*' },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false };
    const ctype = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (ctype && !ALLOWED.test(ctype)) return { ok: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_DOWNLOAD || buf.length > MAX_RAW) return { ok: false };
    const mime = ctype && ALLOWED.test(ctype) ? ctype.split(';')[0] : 'image/png';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
