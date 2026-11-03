import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { knownOptions, repoRoot, validateRepo } from './lib.mjs';
import { staleUiCopies } from './sync-ui.mjs';

export async function main(argv = process.argv) {
  const options = knownOptions(argv, ['--root', '--base', '--summary-out']);
  const root = resolve(options.root ?? repoRoot);
  const result = await validateRepo(root, { base: options.base });
  if (existsSync(join(root, 'shared'))) {
    const stale = await staleUiCopies(root);
    if (stale.length) {
      result.errors.push(`共享 UI 副本与 shared/ 不一致，运行 node scripts/sync-ui.mjs：${stale.join('、')}`);
      result.ok = false;
    }
  }
  if (options['summary-out']) await writeFile(options['summary-out'], result.summary);
  process.stdout.write(result.summary);
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
