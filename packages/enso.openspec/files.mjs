import { lstat, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { safeOpenspecRel } from './board.mjs';

const missing = (error) => {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 'NOT_FOUND' || code === 'ENOENT' || /不存在/.test(message);
};

/**
 * 宿主的 fs.readText 只能读文件。列目录限制在项目里的 openspec/，
 * 并且拒绝符号链接，避免读到授权范围以外的内容。
 */
export async function listOpenspec(projectRoot, rel) {
  const safe = safeOpenspecRel(rel);
  if (!safe) throw Object.assign(new Error('只列出 openspec/ 里的目录'), { code: 'INVALID_ARGS' });
  const root = await realpath(projectRoot);
  const abs = resolve(root, ...safe.split('/'));
  let stat;
  try {
    stat = await lstat(abs);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const real = await realpath(abs);
  const fromRoot = relative(root, real);
  if (!fromRoot || fromRoot.startsWith('..') || fromRoot.split(sep).includes('..')) {
    throw Object.assign(new Error('路径逃出了项目'), { code: 'PERMISSION_DENIED' });
  }
  const posix = fromRoot.split(sep).join('/');
  if (posix !== 'openspec' && !posix.startsWith('openspec/')) {
    throw Object.assign(new Error('路径逃出了 openspec'), { code: 'PERMISSION_DENIED' });
  }
  const entries = await readdir(real, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
}

export function createOpenspecFiles(projectRoot, readText) {
  return {
    list: (rel) => listOpenspec(projectRoot, rel),
    text: async (rel) => {
      const safe = safeOpenspecRel(rel);
      if (!safe || safe.endsWith('/')) return null;
      try {
        const text = await readText(safe);
        return typeof text === 'string' ? text : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}
