// 把 Baileys 打成单文件放进插件包：插件不允许带 node_modules 里的 .node 原生模块
import { build } from 'esbuild';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// 打进包里的第三方依赖及许可证全文：libsignal 是 GPL-3.0，插件整体随之按 GPL-3.0 分发
const pkgDir = here('../../packages/enso.whatsapp/');
const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) names.add(m[1]);
}
const deps = [...names].sort().map((name) => {
  const dir = here(`node_modules/${name}/`);
  const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  return {
    name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '未声明',
    repo: (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '').replace(/^git\+/, ''),
    text: file ? readFileSync(`${dir}${file}`, 'utf8').trim() : '',
  };
});
copyFileSync(here('node_modules/libsignal/LICENSE'), `${pkgDir}LICENSE`);
writeFileSync(
  `${pkgDir}vendor/THIRD_PARTY.md`,
  [
    '# vendor/baileys.mjs 打包的第三方依赖',
    '',
    '由 `scripts/whatsapp/build.mjs` 生成，不要手改。',
    '',
    'Baileys（MIT）依赖 Signal 协议实现 `libsignal`（GPL-3.0），两者一起打进了 `vendor/baileys.mjs`，因此本插件整体按 GPL-3.0 分发，全文见包根目录的 `LICENSE`。其余依赖按各自许可证分发，许可证全文附在下面；源码见各自仓库，打包方式见 enso-plugins 仓库的 `scripts/whatsapp/`。',
    '',
    '| 包 | 版本 | 许可证 | 源码 |',
    '| --- | --- | --- | --- |',
    ...deps.map((d) => `| ${d.name} | ${d.version} | ${d.license} | ${d.repo} |`),
    '',
    '## 许可证全文',
    '',
    ...deps.flatMap((d) => [
      `### ${d.name} ${d.version}（${d.license}）`,
      '',
      d.text ? ['```text', d.text, '```'].join('\n') : `包内没有许可证文件，按 package.json 声明的 ${d.license} 分发，见 ${d.repo || '其 npm 包'}。`,
      '',
    ]),
  ].join('\n'),
);
