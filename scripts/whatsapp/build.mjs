// 把 Baileys 打成单文件放进插件包：插件不允许带 node_modules 里的 .node 原生模块
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const result = await build({
  entryPoints: [here('entry.mjs')],
  outfile: here('../../packages/enso.whatsapp/vendor/baileys.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: true,
  legalComments: 'eof',
  metafile: true,
  // 缩略图、音频、链接预览都是可选依赖：Baileys 动态 import 失败时会跳过
  external: ['sharp', 'jimp', 'audio-decode', 'link-preview-js'],
  alias: {
    bufferutil: here('stub/bufferutil.cjs'),
    'utf-8-validate': here('stub/utf-8-validate.cjs'),
    pino: here('stub/pino.cjs'),
  },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// 打进包里的第三方依赖及许可证：libsignal 是 GPL-3.0，发布时要随包带上这份清单
const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) names.add(m[1]);
}
const rows = [...names].sort().map((name) => {
  const pkg = JSON.parse(readFileSync(here(`node_modules/${name}/package.json`), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '未声明';
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  return `| ${name} | ${pkg.version} | ${license} | ${repo.replace(/^git\+/, '')} |`;
});
writeFileSync(
  here('../../packages/enso.whatsapp/vendor/THIRD_PARTY.md'),
  [
    '# vendor/baileys.mjs 打包的第三方依赖',
    '',
    '由 `scripts/whatsapp/build.mjs` 生成，不要手改。各依赖按各自许可证分发；其中 `libsignal` 为 GPL-3.0，源码见其仓库。',
    '',
    '| 包 | 版本 | 许可证 | 源码 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'),
);
