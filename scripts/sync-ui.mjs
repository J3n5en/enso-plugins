import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib.mjs';

/** 共享样式只在这些官方插件里使用；源文件在 shared/，插件目录里是副本（插件包必须自包含） */
export const UI_FILES = ['enso-ui.css', 'enso-ui.js'];
export const UI_PACKAGES = [
  'enso.bridge',
  'enso.context',
  'enso.bugbot',
  'enso.example.notes',
  'enso.fanqie',
  'enso.github',
  'enso.hongguo',
  'enso.kanban',
  'enso.openspec',
  'enso.scheduler',
  'enso.telegram',
  'enso.tgclient',
];

/** 返回与 shared/ 不一致的副本，供 validate 报错 */
export async function staleUiCopies(root = repoRoot) {
  const stale = [];
  for (const file of UI_FILES) {
    const source = await readFile(join(root, 'shared', file));
    for (const id of UI_PACKAGES) {
      const target = join(root, 'packages', id, file);
      if (!existsSync(join(root, 'packages', id))) continue;
      if (!existsSync(target) || !source.equals(await readFile(target))) stale.push(`packages/${id}/${file}`);
    }
  }
  return stale;
}

export async function main(root = repoRoot) {
  for (const file of UI_FILES) {
    for (const id of UI_PACKAGES) {
      if (!existsSync(join(root, 'packages', id))) continue;
      await copyFile(join(root, 'shared', file), join(root, 'packages', id, file));
    }
  }
  process.stdout.write(`已同步 ${UI_FILES.join('、')} 到 ${UI_PACKAGES.length} 个插件\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(resolve(repoRoot)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
