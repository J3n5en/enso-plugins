// 把侧栏看板渲染成一张可以离线打开的 HTML，用来肉眼检查中文界面。
//
// 它跑的是真插件：起一个临时 dataDir、开一个蜂群、加几个成员贴几条消息，
// 然后把 /api/swarm 与 /api/swarm/raw 的响应连同 AGY 原版页面一起写进一个
// 自包含文件（脚本和样式全部内联，和 Enso 宿主插件页的做法一致）。
//
//   node test/preview.mjs [输出路径]
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'enso-swarm-preview-'));
const tools = new Map();
const methods = new Map();
const handlers = new Map();
const enso = {
  pluginId: 'enso.swarm',
  dataDir,
  tools: { register: (name, fn) => tools.set(name, fn) },
  renderer: { handle: (name, fn) => methods.set(name, fn) },
  schedules: { register: () => {} },
  commands: { register: (id, fn) => methods.set(`command:${id}`, fn) },
  session: {
    inject: async () => {},
    list: async () => ({ sessions: [] }),
    status: async () => ({ state: 'idle' }),
    focus: async () => {},
    focusSubagent: async () => {},
    openChildRun: async () => {},
  },
  ui: { view: { emit() {}, open: async () => {}, close() {} }, notify() {} },
  fs: { readText: async () => '', writeText: async () => {} },
  config: { get: () => undefined },
  events: { on: (event, fn) => handlers.set(event, fn) },
};

const { activate } = await import('../main.mjs');
await activate(enso);

const coordinator = 'preview-coordinator-0001';
const ctx = { sessionId: coordinator };
const call = (name, args) => tools.get(name)(args, ctx);

await call('swarm', { action: 'open', title: 'IPC 通道盘点' });
await call('swarm', { action: 'add', name: 'channels', role: 'worker', brief: '数一遍 IPC 通道' });
await call('swarm', { action: 'add', name: 'verifier', role: 'verifier', brief: '复核数字' });
await call('swarm', { action: 'add', name: 'wiring', role: 'worker', brief: '看 preload 出口' });
bind('channels');
bind('verifier');
bind('wiring');

// 各成员用各自的子会话发言，看板才有多个作者（和真机一样）。
const post = (who, text) =>
  tools.get('swarm_post')({ text }, who === 'coordinator' ? ctx : { sessionId: `${coordinator}::cw-${who}` });
await post('coordinator', '#1 目标：把 IPC 通道常量数清楚，两边用同一条命令。');
await post('coordinator', '@channels @wiring 分头数：channels 数常量，wiring 数 preload 出口。');
await post('channels', '@coordinator 549 个常量，按前缀分组：bots 66、secretary 50、agent 46。');
await post('channels', '@verifier 请复算 549 这个数。');
await post('wiring', '@coordinator preload invoke 467 处，比常量少 82 个，差的都在主机侧注册。');
await post('verifier', '@coordinator 复核通过：549 与 467 不矛盾，口径不同。');
await post('coordinator', '@all 结论已写进 README，收工。');
await call('swarm_plan', {
  plan: {
    goal: { title: 'IPC 通道盘点', line: '用同一条命令把常量数和出口数对上' },
    tasks: { channels: '数通道常量', wiring: '数 preload 出口', verifier: '复算并指出口径差异' },
    threads: [
      { id: 'count', title: '计数', goal: '两边用同一条命令', tasks: ['channels', 'wiring'] },
      { id: 'verify', title: '复核', goal: '独立重算', tasks: ['verifier'] },
    ],
  },
});

/** 成员表（名字 → members.json 里的一行），bind 的 key 从这里取。 */
function members() {
  const brain = join(dataDir, 'state', 'brain');
  for (const entry of readdirSync(brain)) {
    const file = join(brain, entry, '.system_generated', 'swarm', 'members.json');
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      /* 不是蜂群目录 */
    }
  }
  throw new Error('no members.json');
}
/** 让 workers 用各自的子会话来 bind，和真机上 worker 的第一次调用一样。 */
function bind(name) {
  const key = members().members[name].key;
  return tools.get('swarm')({ action: 'bind', key }, { sessionId: `${coordinator}::cw-${name}` });
}

// --empty：没有蜂群的会话，用来看空状态。
const empty = process.argv.includes('--empty');
const target = process.argv[2];
const out = target && !target.startsWith('--') ? target : '/tmp/swarm-pane-preview.html';
const api = (url) => methods.get('api')({ url }, ctx);
const snap = empty
  ? { status: 200, contentType: 'application/json', text: JSON.stringify({ conversationId: coordinator, swarm: null, member: null }) }
  : await api('/api/swarm?etag=&omitRaw=1&tail=20');
const raw = await api('/api/swarm/raw');

const board = join(dirname(new URL(import.meta.url).pathname), '..', 'swarm_board');
const read = (file) => readFileSync(join(board, file), 'utf8');

const mock = {
  call: (method, args) => {
    if (method !== 'api') return Promise.resolve({ ok: true });
    const url = String((args && args.url) || '');
    const path = url.split('?')[0];
    const table = {
      '/api/swarm': snap,
      '/api/swarm/raw': raw,
      '/api/swarm/messages': { status: 200, contentType: 'application/json', text: '{"messages":[]}' },
    };
    return Promise.resolve(table[path] || { status: 404, contentType: 'application/json', text: '{"error":"not in preview"}' });
  },
  theme: 'light',
  onTheme: () => {},
  storage: { get: () => null, set: () => {}, remove: () => {} },
  session: { get: () => ({ id: coordinator, title: '预览' }), onChange: () => {} },
  on: () => {},
};

const mockScript = `
window.enso = {
  call: (method, args) => {
    if (method !== 'api') return Promise.resolve({ ok: true });
    const url = String((args && args.url) || '');
    const path = url.split('?')[0];
    const table = ${JSON.stringify({ '/api/swarm': snap, '/api/swarm/raw': raw })};
    const hit = table[path] || (path === '/api/swarm/messages'
      ? { status: 200, contentType: 'application/json', text: '{"messages":[]}' }
      : { status: 404, contentType: 'application/json', text: '{"error":"not in preview"}' });
    return Promise.resolve(hit);
  },
  theme: 'light',
  onTheme: () => {},
  storage: { get: () => null, set: () => {}, remove: () => {} },
  session: { get: () => ({ id: ${JSON.stringify(coordinator)}, title: '预览' }), onChange: () => {} },
  on: () => {},
};
`;

let html = read('index.html');
// 和宿主插件页一样：脚本、样式全部内联（插件页的 CSP 只允许内联脚本）。
// app.js 里有 "<\/script>" 字面量（narrator 的 srcdoc），内联时要转义，否则标签会被提前闭合。
html = html.replace(
  /<script src="([^"]+)"><\/script>/g,
  (m, file) => `<script>\n${read(file).replace(/<\/script/gi, '<\\/script')}\n</script>`,
);
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, file) => `<style>\n${read(file)}\n</style>`);
html = html.replace('</title>', `</title>\n<script>${mockScript}</script>`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const swarms = readdirSync(join(dataDir, 'state', 'brain')).length;
console.log(`preview: ${out} (${(html.length / 1024).toFixed(0)} KB, ${swarms} swarm dir)`);
