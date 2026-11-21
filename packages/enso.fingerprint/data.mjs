import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 与 lmfpd-sdk 的 DEFAULT_DATA_URLS 相同，但经 enso.net.fetch 下载 */
export const SOURCES = ['https://lm.ikale.io/data/', 'https://cdn.jsdmirror.com/npm/lmfpd-data@latest/']
export const DATA_SCHEMA = 'lmfpd-data-v1'
export const DETECTOR_SCHEMA = 'shared-detector-v2'
export const TTL_MS = 24 * 3600_000
const DETECTOR = 'shared_detector.bin'
const BUNDLE_TIMEOUT_MS = 15_000
const CHUNK_TIMEOUT_MS = 120_000

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} 超时`)), ms))),
  ]).finally(() => clearTimeout(timer))
}

async function get(fetch, url, binary, ms) {
  const res = await withTimeout(fetch(url, binary ? { responseType: 'base64' } : {}), ms, url)
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  return binary ? Buffer.from(res.body, 'base64') : res.body
}

export function parseBundle(text) {
  const bundle = JSON.parse(text)
  if (bundle?.schema !== DATA_SCHEMA || bundle?.detector_schema !== DETECTOR_SCHEMA)
    throw new Error(`数据格式 ${bundle?.schema}/${bundle?.detector_schema} 不受支持，需要升级插件`)
  const file = bundle.files?.[DETECTOR]
  if (!Array.isArray(file?.parts) || !file.parts.length || typeof file.sha256 !== 'string')
    throw new Error('bundle.json 缺少检测参数分块')
  return { bundle, file }
}

async function readMeta(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

async function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 依次尝试各来源：取 bundle.json，版本没变只刷新检查时间；变了就下载分块、zstd 解压、按 sha256 校验，
 * 写成 SDK 能直接读的本地目录（unified_bank.json 存 bundle.json 原文，SDK 自己的缓存也这样用）。
 */
async function refresh({ dir, fetch, sources, now, cached, onProgress }) {
  const failures = []
  for (const source of sources) {
    try {
      onProgress?.({ phase: 'check', source })
      const text = await get(fetch, `${source}bundle.json`, false, BUNDLE_TIMEOUT_MS)
      const { bundle, file } = parseBundle(text)
      if (cached && cached.sha256 === file.sha256) {
        const meta = { ...cached, checkedAt: now() }
        await writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta))
        return meta
      }
      const parts = []
      for (const [index, part] of file.parts.entries()) {
        onProgress?.({ phase: 'download', source, part: index + 1, parts: file.parts.length })
        parts.push(await get(fetch, `${source}chunks/${part}`, true, CHUNK_TIMEOUT_MS))
      }
      const raw = zstdDecompressSync(Buffer.concat(parts))
      if (sha256(raw) !== file.sha256) throw new Error('检测参数校验失败')
      await writeAtomic(join(dir, DETECTOR), raw)
      await writeAtomic(join(dir, 'unified_bank.json'), text)
      const meta = {
        sha256: file.sha256,
        builtAt: bundle.built_at ?? null,
        models: Array.isArray(bundle.models) ? bundle.models.length : 0,
        source,
        checkedAt: now(),
      }
      await writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta))
      return meta
    } catch (error) {
      failures.push(`${source}（${error?.message || error}）`)
    }
  }
  throw Object.assign(new Error(`参考数据下载失败：${failures.join('；')}`), { code: 'DATA_UNAVAILABLE' })
}

/**
 * 准备 SDK 读取的本地数据目录。已有数据时立即返回；超过 ttl 就在后台检查更新，下次加载才用上。
 * 返回 { dir, meta, fresh }，fresh 表示这次刚下载。
 */
export async function ensureData({ dir, fetch, sources = SOURCES, ttl = TTL_MS, now = Date.now, onProgress, background }) {
  await mkdir(dir, { recursive: true })
  const cached = await readMeta(dir)
  if (cached?.sha256) {
    if (now() - (cached.checkedAt ?? 0) >= ttl) background?.(refresh({ dir, fetch, sources, now, cached }).catch(() => null))
    return { dir, meta: cached, fresh: false }
  }
  const meta = await refresh({ dir, fetch, sources, now, cached: null, onProgress })
  return { dir, meta, fresh: true }
}

/** 本地数据读不出时清掉元数据，下次重新下载 */
export async function dropData(dir) {
  await rm(join(dir, 'meta.json'), { force: true })
}
