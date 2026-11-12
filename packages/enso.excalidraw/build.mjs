// 把 Excalidraw 打成查看器能内联的单个脚本和样式。
// 宿主读单个资源的上限是 8MB，沙箱只允许 data: 字体，并且没有 eval / worker。
//
//   EXCALIDRAW_MODULES=/path/to/node_modules node build.mjs
//
// 依赖装在插件目录外面。插件包里不能有 node_modules，也不能有 package-lock.json
// （仓库打包时会对带 lock 的插件执行 npm ci，把依赖塞进 zip）。
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = process.env.EXCALIDRAW_MODULES || '/tmp/enso-excalidraw-build/node_modules';
const require = createRequire(path.join(MODULES, 'package.json'));
const esbuild = require('esbuild');
const FONT_ROOT = path.join(MODULES, '@excalidraw/excalidraw/dist/prod/fonts');
const MAX_ASSET = 8 * 1024 * 1024;
const SKIP_FONTS = new Set(['Xiaolai', 'Liberation']);
const FONT_CDN = /(\w+)\.push\(new URL\(\w+,\w+\.ASSETS_FALLBACK_URL\)\),\1/g;

function fontReference(rel) {
  const parts = rel.replace(/^\.\/fonts\//, '').split('/');
  const family = parts[0];
  if (SKIP_FONTS.has(family)) return `local:${family}`;
  const file = path.join(FONT_ROOT, ...parts);
  const base64 = readFileSync(file).toString('base64');
  return `data:font/woff2;base64,${base64}`;
}

const adapt = {
  name: 'adapt-excalidraw',
  setup(build) {
    build.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, (args) => {
      let code = readFileSync(args.path, 'utf8');
      let fonts = 0;
      code = code.replace(/"\.\/fonts\/[^"]+\.woff2"/g, (match) => {
        fonts += 1;
        return JSON.stringify(fontReference(JSON.parse(match)));
      });
      const before = code;
      code = code.replace(FONT_CDN, '$1');
      code = code.replaceAll('import("./subset-worker.chunk.js")', 'Promise.resolve({WorkerUrl:""})');
      code = code.replaceAll(
        'import("./subset-shared.chunk.js")',
        'Promise.resolve({subsetToBase64(){throw new Error("subset disabled")},toBase64(){throw new Error("subset disabled")},Commands:{}})',
      );
      code = code.replaceAll('features:["js","wasm"]', 'features:["js"]');
      code = code.replace(
        /`https:\/\/esm\.sh\/\$\{M\.PKG_NAME\?`\$\{M\.PKG_NAME\}@\$\{M\.PKG_VERSION\}`:"@excalidraw\/excalidraw"\}\/dist\/prod\/`/,
        '""',
      );
      if (fonts || before !== code) {
        console.log(`adapt ${path.basename(args.path)}: ${fonts} fonts`);
      }
      return { contents: code, loader: 'js' };
    });
  },
};

if (!statSync(path.join(MODULES, '@excalidraw/excalidraw/package.json'), { throwIfNoEntry: false })) {
  console.error(`找不到 ${MODULES} 里的 @excalidraw/excalidraw`);
  process.exit(1);
}

const result = await esbuild.build({
  entryPoints: [path.join(HERE, 'src/editor.jsx')],
  outfile: path.join(HERE, 'editor.js'),
  absWorkingDir: HERE,
  nodePaths: [MODULES],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  conditions: ['production', 'style', 'import', 'browser', 'default'],
  target: 'chrome120',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.IS_PREACT': '"false"',
  },
  plugins: [adapt],
});

const jsPath = path.join(HERE, 'editor.js');
let js = readFileSync(jsPath, 'utf8');
js = js.replaceAll('new Worker(', '(function(){throw new Error("workers disabled")})(');
js = js.replace(
  'new Function("d","return {"+e.map(function(t,r){return JSON.stringify(t)+": d["+r+\'] || ""\'}).join(",")+"}")',
  '(function(d){const o={};for(let r=0;r<e.length;r++)o[e[r]]=d[r]||"";return o})',
);
writeFileSync(jsPath, js);
const cssPath = path.join(HERE, 'editor.css');
const cssStat = statSync(cssPath);
const jsStat = statSync(jsPath);
const problems = [];
if (jsStat.size > MAX_ASSET) problems.push(`editor.js ${jsStat.size} 超过 8MB`);
if (cssStat.size > MAX_ASSET) problems.push(`editor.css ${cssStat.size} 超过 8MB`);
if (js.includes('esm.sh')) problems.push('打包结果仍会请求 esm.sh');
if (/\bnew Function\s*\(/.test(js) || /\beval\s*\(/.test(js)) problems.push('打包结果含 eval 或 new Function');
if (js.includes('subset-worker')) problems.push('字体子集 worker 仍在包里');
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some((file) => file.endsWith('.node'))) problems.push('打包进了原生模块');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`editor.js ${jsStat.size} bytes, editor.css ${cssStat.size} bytes, ${inputs.length} inputs`);
