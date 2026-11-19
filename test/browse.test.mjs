import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const PKG = 'packages/enso.browse';

async function load(env = {}) {
  Object.assign(process.env, env);
  return import(`../${PKG}/main.mjs?${Date.now()}${Math.random()}`);
}

test('清单只接原版 browse 的 MCP，不再自带代理工具', async () => {
  const manifest = JSON.parse(await readFile(`${PKG}/enso-plugin.json`, 'utf8'));
  assert.equal(manifest.id, 'enso.browse');
  assert.equal(manifest.name, 'Browse');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.resident, true);
  assert.deepEqual(manifest.permissions.sort(), ['mcp.server', 'process.background', 'ui.clipboard', 'ui.openExternal', 'ui.view']);
  assert.equal(manifest.contributes.agentTools, undefined);
  assert.deepEqual(manifest.contributes.mcpServers, [{ name: 'browse', command: '${ENSO_PLUGIN_ROOT}/bin/run', args: ['mcp'] }]);
});

test('三个系统都在官方安装目录找 browse，Windows 用另一条安装命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-browse-'));
  const { browseBinary, installCommand, PORT, STORE_ID } = await load();
  assert.equal(PORT, 19988);
  assert.equal(STORE_ID, 'mfnicocicmmlkpjnaffgihfjhdgjkdjg');
  assert.match(installCommand('linux'), /install \| bash/);
  assert.match(installCommand('win32'), /install\.ps1/);
  await mkdir(join(root, '.local', 'bin'), { recursive: true });
  const unix = join(root, '.local', 'bin', 'browse');
  const win = join(root, '.local', 'bin', 'browse.exe');
  await writeFile(unix, '');
  await writeFile(win, '');
  assert.equal(browseBinary({ HOME: root, PATH: '' }, 'linux'), unix);
  assert.equal(browseBinary({ USERPROFILE: root, PATH: '' }, 'win32'), win);
  assert.equal(browseBinary({ HOME: root, PATH: '', ENSO_BROWSE: '/missing/browse' }, 'linux'), unix);
  await rm(root, { recursive: true, force: true });
});

function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000755\0', 100);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function fakeRelease(tgz, target, overrides = {}) {
  const files = {
    'https://x.test/release/browse/cli/stable.json': {
      app: 'browse', artifact: 'cli', channel: 'stable',
      release: { version: '9.9.9', targets: { [target]: { url: '/release/browse/files/a/browse.tgz', size: tgz.length, sha256: createHash('sha256').update(tgz).digest('hex'), ...overrides } } },
    },
    'https://x.test/release/browse/files/a/browse.tgz': tgz,
  };
  return async (url) => {
    const body = files[url];
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => body };
  };
}

test('插件自己下载 browse：核对校验和，只写插件数据目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-browse-'));
  const { downloadBrowse, ownBinary, browseBinary, extractFile } = await load();
  const pax = Buffer.from('30 path=package/bin/browse.exe\n');
  const tgz = gzipSync(Buffer.concat([
    tarEntry('package/package.json', Buffer.from('{}')),
    tarEntry('PaxHeader', pax, 'x'),
    tarEntry('package/bin/ignored', Buffer.from('WIN')),
    tarEntry('package/bin/browse', Buffer.from('#!/bin/sh\necho browse\n')),
    Buffer.alloc(1024),
  ]));
  assert.equal(extractFile(tgz, 'package/bin/browse.exe').toString(), 'WIN');
  try {
    const env = { ENSO_PLUGIN_DATA: root, HOME: join(root, 'home'), PATH: '' };
    const dest = ownBinary(env, 'linux');
    assert.equal(dest, join(root, 'bin', 'browse'));
    assert.equal(browseBinary(env, 'linux'), null);
    const done = await downloadBrowse({ dest, platform: 'linux', target: 'linux-x64', service: 'https://x.test/release', fetch: fakeRelease(tgz, 'linux-x64') });
    assert.deepEqual(done, { version: '9.9.9', target: 'linux-x64', path: dest });
    assert.equal(await readFile(dest, 'utf8'), '#!/bin/sh\necho browse\n');
    assert.equal(browseBinary(env, 'linux'), dest);
    await assert.rejects(
      downloadBrowse({ dest, platform: 'linux', target: 'linux-x64', service: 'https://x.test/release', fetch: fakeRelease(tgz, 'linux-x64', { sha256: '0'.repeat(64) }) }),
      /校验不过/,
    );
    await assert.rejects(
      downloadBrowse({ dest, platform: 'linux', target: 'linux-arm64', service: 'https://x.test/release', fetch: fakeRelease(tgz, 'linux-x64') }),
      /没有 linux-arm64 的包/,
    );
    assert.equal(await readFile(dest, 'utf8'), '#!/bin/sh\necho browse\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('按官方安装脚本的规则选包', async () => {
  const { releaseTarget } = await load();
  const probe = (values) => async (name) => values[name] ?? '';
  assert.equal(await releaseTarget({ platform: 'darwin', arch: 'arm64', probe: probe({}) }), 'macos-arm64');
  assert.equal(await releaseTarget({ platform: 'darwin', arch: 'x64', probe: probe({ 'sysctl.proc_translated': '1' }) }), 'macos-arm64');
  assert.equal(await releaseTarget({ platform: 'darwin', arch: 'x64', probe: probe({ 'hw.optional.avx2_0': '1' }) }), 'macos-x64');
  assert.equal(await releaseTarget({ platform: 'darwin', arch: 'x64', probe: probe({}) }), 'macos-x64-baseline');
  assert.equal(await releaseTarget({ platform: 'win32', arch: 'arm64', probe: probe({}) }), 'windows-x64');
  await assert.rejects(releaseTarget({ platform: 'freebsd', arch: 'x64' }), /不支持/);
});

test('bin/run 随包提交，会话启动时不依赖插件进程；先用本机的 browse，再用插件下载的', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { chmod, copyFile, stat } = await import('node:fs/promises');
  assert.ok((await stat(`${PKG}/bin/run`)).mode & 0o100, 'bin/run 要可执行');
  assert.match(await readFile(`${PKG}/bin/run.cmd`, 'utf8'), /data\\enso\.browse\\bin\\browse\.exe/);
  const root = await mkdtemp(join(tmpdir(), 'enso-browse-'));
  try {
    // Enso 的布局：<root>/packages/<id>/<安装目录>，数据在 <root>/data/<id>
    const plugin = join(root, 'packages', 'enso.browse', 'abc');
    await mkdir(join(plugin, 'bin'), { recursive: true });
    await copyFile(`${PKG}/bin/run`, join(plugin, 'bin', 'run'));
    const fake = async (file, label) => {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `#!/bin/sh\necho ${label} "$@"\n`);
      await chmod(file, 0o755);
    };
    const home = join(root, 'home');
    await mkdir(home);
    const run = () => spawnSync(join(plugin, 'bin', 'run'), ['mcp'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

    let out = run();
    assert.equal(out.status, 127);
    assert.match(out.stderr, /下载 browse/);
    await fake(join(root, 'data', 'enso.browse', 'bin', 'browse'), 'own');
    assert.equal(run().stdout.trim(), 'own mcp');
    await fake(join(home, '.local', 'bin', 'browse'), 'home');
    assert.equal(run().stdout.trim(), 'home mcp');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('配对码从 browse 的输出里取', async () => {
  const { parseCode } = await load();
  assert.equal(parseCode('Pairing code: 62NR-PR9Y\nOpen the Extensions menu'), '62NR-PR9Y');
  assert.equal(parseCode('nothing here'), undefined);
});

test('已配对浏览器从原版数据目录读，列表不带密钥', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-chrome-'));
  try {
    const { pairedBrowsers } = await load({ OPENCODE_BROWSER_HOME: root });
    await writeFile(join(root, 'browser-tokens.json'), JSON.stringify({ p1: { token: 'x'.repeat(43), pairedAt: 1, id: 'chrome-mac', name: 'Chrome' } }));
    const list = await pairedBrowsers(root);
    assert.deepEqual(list, [{ key: 'p1', id: 'chrome-mac', name: 'Chrome', pairedAt: 1, lastSeen: null }]);
    assert.ok(!JSON.stringify(list).includes('xxxx'));
  } finally {
    delete process.env.OPENCODE_BROWSER_HOME;
    await rm(root, { recursive: true, force: true });
  }
});

test('没装原版 browse 时直接说明怎么装', async () => {
  const savedPath = process.env.PATH;
  const { browse, browseBinary } = await load({
    ENSO_BROWSE: '/no/such/browse',
    XDG_BIN_HOME: '/no/such/bin',
    HOME: '/no/such/home',
    USERPROFILE: '/no/such/home',
    PATH: '/no/such/path',
  });
  const savedData = process.env.ENSO_PLUGIN_DATA;
  delete process.env.ENSO_PLUGIN_DATA;
  assert.equal(browseBinary(), null);
  await assert.rejects(browse(['--version']), /opencode\.ai\/browse\/install/);
  if (savedData) process.env.ENSO_PLUGIN_DATA = savedData;
  process.env.PATH = savedPath;
  delete process.env.ENSO_BROWSE;
  delete process.env.XDG_BIN_HOME;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
});

test('原版 browse 能在隔离目录里发出配对码并拉起中继', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enso-chrome-'));
  const port = String(47920 + Math.floor(Math.random() * 70));
  const home = join(root, 'browse');
  await mkdir(home);
  const { browseBinary, issueCode, state } = await load({ OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: port });
  if (!browseBinary()) {
    delete process.env.OPENCODE_BROWSER_HOME;
    delete process.env.OPENCODE_BROWSER_PORT;
    await rm(root, { recursive: true, force: true });
    return;
  }
  try {
    const issued = await issueCode();
    assert.match(issued.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const view = await state(home, issued);
    assert.equal(view.port, Number(port));
    assert.equal(view.relay, true);
    assert.equal(view.connected, false);
    assert.equal(view.code.code, issued.code);
    assert.match(view.storeUrl, /chromewebstore\.google\.com/);
  } finally {
    const token = await readFile(join(home, 'relay-token'), 'utf8').catch(() => '');
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token.trim()}` } }).catch(() => {});
    delete process.env.OPENCODE_BROWSER_HOME;
    delete process.env.OPENCODE_BROWSER_PORT;
    await rm(root, { recursive: true, force: true });
  }
});

test('侧栏脚本在宿主不可配置的 window.enso 下能跑起来', async () => {
  const { runInContext, createContext } = await import('node:vm');
  const html = await readFile(`${PKG}/view.html`, 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const calls = [];
  const element = () => {
    const node = { children: [], textContent: '', className: '', attrs: {}, listeners: {} };
    node.append = (...kids) => node.children.push(...kids);
    node.replaceChildren = (...kids) => { node.children = kids; };
    node.addEventListener = (name, fn) => { node.listeners[name] = fn; };
    node.setAttribute = (key, value) => { node.attrs[key] = value; };
    return node;
  };
  const app = element();
  const context = createContext({
    document: { getElementById: () => app, createElement: element },
    setInterval() {},
  });
  context.__call = async (method) => (calls.push(method), {
    port: 19988, relay: true, connected: false, pairingState: 'not-seen', paired: [], browsers: [], tabs: [],
    binary: '/Users/x/.local/bin/browse',
    storeUrl: 'https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg',
    install: 'curl -fsSL https://opencode.ai/browse/install | bash',
    code: { code: 'AAAA-BBBB', expiresAt: Date.now() + 1000 },
  });
  runInContext(
    "Object.defineProperty(globalThis, 'enso', { configurable: false, writable: false, value: { call: __call } }); globalThis.window = globalThis;",
    context,
  );
  runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['state']);
  const text = (node) => (typeof node === 'string' ? node : [node.textContent, ...(node.children ?? []).map(text)].join(''));
  assert.match(text(app), /等待扩展/);
  assert.match(text(app), /AAAA-BBBB/);
  assert.match(text(app), /网上应用店/);
  assert.match(text(app), /\/Users\/x\/\.local\/bin\/browse/);
});
