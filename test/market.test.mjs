import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRepo, checkPackageLimits, repoRoot, validateRepo } from '../scripts/lib.mjs';
import { createMarketKey } from '../scripts/keygen.mjs';
import { signIndex } from '../scripts/sign.mjs';
import { zipFiles } from '../scripts/zip.mjs';

const NOW = '2026-11-02T00:00:00.000Z';
const scripts = join(repoRoot, 'scripts');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'enso-plugins-'));
}

async function writePlugin(root, manifest, extra = {}) {
  const dir = join(root, 'packages', manifest.id);
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'registry/meta'), { recursive: true });
  await writeFile(
    join(dir, 'enso-plugin.json'),
    JSON.stringify({ schemaVersion: 1, name: 'Demo', description: 'demo', permissions: ['ui.view'], ...manifest }),
  );
  await writeFile(join(dir, 'main.mjs'), extra.main ?? 'export function activate() {}\n');
  if (extra.meta !== null) {
    await writeFile(
      join(root, 'registry/meta', `${manifest.id}.json`),
      JSON.stringify(extra.meta ?? { tier: 'official', tags: ['ui'] }),
    );
  }
  for (const [name, body] of Object.entries(extra.files ?? {})) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
}

function git(root, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

test('zip 排序且两次字节相同', () => {
  const files = [
    { name: 'b.txt', data: Buffer.from('b') },
    { name: 'a.txt', data: Buffer.from('a') },
  ];
  const first = zipFiles(files);
  const second = zipFiles([...files].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.subarray(30, 35).toString(), 'a.txt');
});

test('体积与文件数上限', () => {
  assert.deepEqual(checkPackageLimits(5000, 200 * 1024 * 1024), []);
  assert.equal(checkPackageLimits(5001, 1).length, 1);
  assert.equal(checkPackageLimits(1, 200 * 1024 * 1024 + 1).length, 1);
});

test('build 合并历史版本，同版本内容不同则失败', async () => {
  const root = await tempRoot();
  try {
    const id = 'enso.example.notes';
    await writePlugin(root, { id, version: '1.0.0', permissions: ['ui.view'], engines: { enso: '>=0.2.0' } });
    const env = { ...process.env, ENSO_INDEX_TIME: NOW };
    const first = await buildRepo(root, env);
    const version = first.index.plugins[0].versions[0];
    assert.equal(first.index.schemaVersion, 1);
    assert.equal(first.index.sequence, 1);
    assert.equal(version.path, `packages/${id}/1.0.0.zip`);
    assert.equal(version.engines.enso, '>=0.2.0');
    assert.match(version.sha256, /^[0-9a-f]{64}$/);
    const zip = await readFile(join(root, 'out/v1', version.path));
    assert.equal(createHash('sha256').update(zip).digest('hex'), version.sha256);
    assert.equal(zip.length, version.size);
    const unzip = spawnSync('unzip', ['-t', join(root, 'out/v1', version.path)], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stderr);

    const again = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-03T00:00:00.000Z' });
    assert.equal(again.index.sequence, 2);
    assert.equal(again.index.plugins[0].versions.length, 1);
    assert.equal(again.index.plugins[0].versions[0].sha256, version.sha256);
    assert.equal(again.index.plugins[0].versions[0].publishedAt, NOW);

    await writeFile(join(root, 'packages', id, 'main.mjs'), 'export function activate() { return 1; }\n');
    await assert.rejects(() => buildRepo(root, env), /不能覆盖/);
    const unchanged = JSON.parse(await readFile(join(root, 'out/v1/index.json'), 'utf8'));
    assert.equal(unchanged.sequence, 2);

    const manifest = JSON.parse(await readFile(join(root, 'packages', id, 'enso-plugin.json'), 'utf8'));
    manifest.version = '1.1.0';
    manifest.permissions = ['ui.view', 'net.fetch'];
    await writeFile(join(root, 'packages', id, 'enso-plugin.json'), JSON.stringify(manifest));
    const bumped = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-04T00:00:00.000Z' });
    assert.equal(bumped.index.sequence, 3);
    assert.deepEqual(
      bumped.index.plugins[0].versions.map((item) => item.version),
      ['1.0.0', '1.1.0'],
    );
    assert.equal(bumped.index.plugins[0].latest, '1.1.0');
    assert.equal(bumped.index.plugins[0].versions[0].sha256, version.sha256);
    assert.deepEqual(bumped.index.plugins[0].versions[1].permissions, ['ui.view', 'net.fetch']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('README 作为独立文件发布并登记在插件记录上', async () => {
  const root = await tempRoot();
  try {
    const readme = '# Notes\n\n用法说明\n';
    await writePlugin(root, { id: 'enso.example.notes', version: '1.0.0' }, { files: { 'README.md': readme } });
    await writePlugin(root, { id: 'enso.example.wordstats', version: '1.0.0' });
    const built = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: NOW });
    const [notes, wordstats] = built.index.plugins;
    assert.equal(notes.readme.path, 'packages/enso.example.notes/1.0.0.readme.md');
    const bytes = await readFile(join(root, 'out/v1', notes.readme.path));
    assert.equal(bytes.toString('utf8'), readme);
    assert.equal(notes.readme.size, Buffer.byteLength(readme));
    assert.equal(notes.readme.sha256, createHash('sha256').update(readme).digest('hex'));
    assert.equal('readme' in wordstats, false);
    assert.equal('readme' in notes.versions[0], false);

    await rm(join(root, 'packages/enso.example.notes'), { recursive: true });
    await rm(join(root, 'registry/meta/enso.example.notes.json'));
    const kept = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-03T00:00:00.000Z' });
    assert.deepEqual(kept.index.plugins[0].readme, notes.readme);

    await writePlugin(root, { id: 'enso.example.big', version: '1.0.0' }, { files: { 'README.md': 'x'.repeat(256 * 1024 + 1) } });
    await assert.rejects(() => buildRepo(root, { ...process.env, ENSO_INDEX_TIME: NOW }), /README\.md 超过 256KB/);
    const validated = await validateRepo(root, { catalog: false });
    assert.match(validated.errors.join('\n'), /enso\.example\.big: README\.md 超过 256KB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('元数据里的分类和截图写进索引，删包后沿用；未知分类或非 https 截图校验失败', async () => {
  const root = await tempRoot();
  try {
    const screenshots = [{ url: 'https://cdn.example/notes.png', alt: '便签面板' }];
    await writePlugin(
      root,
      { id: 'enso.example.notes', version: '1.0.0' },
      { meta: { tier: 'official', tags: ['ui'], category: 'productivity', screenshots } },
    );
    const built = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: NOW });
    assert.equal(built.index.plugins[0].category, 'productivity');
    assert.deepEqual(built.index.plugins[0].screenshots, screenshots);

    await rm(join(root, 'packages/enso.example.notes'), { recursive: true });
    await rm(join(root, 'registry/meta/enso.example.notes.json'));
    const kept = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-03T00:00:00.000Z' });
    assert.equal(kept.index.plugins[0].category, 'productivity');
    assert.deepEqual(kept.index.plugins[0].screenshots, screenshots);

    await writePlugin(root, { id: 'enso.example.games', version: '1.0.0' }, { meta: { tier: 'community', category: 'games' } });
    await writePlugin(
      root,
      { id: 'enso.example.shots', version: '1.0.0' },
      { meta: { tier: 'community', screenshots: [{ url: 'http://x/a.png', alt: 'a' }] } },
    );
    const validated = await validateRepo(root, { catalog: false });
    assert.match(validated.errors.join('\n'), /category 不合法/);
    assert.match(validated.errors.join('\n'), /screenshots 不合法/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同一内容的索引与 zip 可复现', async () => {
  const left = await tempRoot();
  const right = await tempRoot();
  try {
    const manifest = { id: 'enso.example.notes', version: '1.0.0' };
    await writePlugin(left, manifest, { main: 'same\n' });
    await writePlugin(right, manifest, { main: 'same\n' });
    const env = { ...process.env, ENSO_INDEX_TIME: NOW };
    const a = await buildRepo(left, env);
    const b = await buildRepo(right, env);
    assert.equal(a.bytes.toString(), b.bytes.toString());
    const zipA = await readFile(join(left, 'out/v1/packages/enso.example.notes/1.0.0.zip'));
    const zipB = await readFile(join(right, 'out/v1/packages/enso.example.notes/1.0.0.zip'));
    assert.deepEqual(zipA, zipB);
  } finally {
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
});

test('删掉目录后已发布插件仍留在索引', async () => {
  const root = await tempRoot();
  try {
    await writePlugin(root, { id: 'enso.example.notes', version: '1.0.0' });
    await writePlugin(root, { id: 'enso.example.wordstats', version: '1.0.0', name: 'Words' });
    await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: NOW });
    await rm(join(root, 'packages/enso.example.wordstats'), { recursive: true });
    await rm(join(root, 'registry/meta/enso.example.wordstats.json'));
    const next = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-03T00:00:00.000Z' });
    assert.deepEqual(
      next.index.plugins.map((plugin) => plugin.id),
      ['enso.example.notes', 'enso.example.wordstats'],
    );
    await writeFile(join(root, 'registry/delisted.json'), '["enso.example.wordstats"]');
    const delisted = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-04T00:00:00.000Z' });
    assert.deepEqual(
      delisted.index.plugins.map((plugin) => plugin.id),
      ['enso.example.notes'],
    );
    await writeFile(join(root, 'registry/delisted.json'), '["enso.example.notes"]');
    await assert.rejects(buildRepo(root, { ...process.env, ENSO_INDEX_TIME: '2026-11-05T00:00:00.000Z' }), /已下架/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keygen、build、sign 后可用公钥验签，改一字节失败', async () => {
  const root = await tempRoot();
  try {
    await writePlugin(root, { id: 'enso.example.notes', version: '1.2.0', description: '便签' });
    const keyPath = join(root, 'key.pem');
    const generated = run('keygen.mjs', ['--private-out', keyPath]);
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /BEGIN PUBLIC KEY/);
    const built = run('build.mjs', ['--root', root], { env: { ENSO_INDEX_TIME: NOW } });
    assert.equal(built.status, 0, built.stderr);
    const pem = await readFile(keyPath, 'utf8');
    const signed = run('sign.mjs', ['--root', root], { env: { ENSO_MARKET_PRIVATE_KEY: pem.replace(/\n/g, '\\n') } });
    assert.equal(signed.status, 0, signed.stderr);
    const bytes = await readFile(join(root, 'out/v1/index.json'));
    const signature = (await readFile(join(root, 'out/v1/index.json.sig'), 'utf8')).trim();
    assert.match(signature, /^[A-Za-z0-9+/]+={0,2}$/);
    const publicKey = createPublicKey(generated.stdout);
    assert.equal(verify(null, bytes, publicKey, Buffer.from(signature, 'base64')), true);
    const tampered = Buffer.from(bytes);
    tampered[20] ^= 1;
    assert.equal(verify(null, tampered, publicKey, Buffer.from(signature, 'base64')), false);
    const other = createMarketKey();
    assert.equal(verify(null, bytes, createPublicKey(other.publicPem), Buffer.from(signIndex(bytes, other.privatePem), 'base64')), true);
    assert.equal(verify(null, bytes, publicKey, Buffer.from(signIndex(bytes, other.privatePem), 'base64')), false);
    const index = JSON.parse(bytes.toString('utf8'));
    assert.equal(index.plugins[0].tier, 'official');
    assert.equal(index.plugins[0].latest, '1.2.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('示例插件可以校验、打包并验签', async () => {
  const root = await tempRoot();
  try {
    await cp(join(repoRoot, 'packages'), join(root, 'packages'), { recursive: true });
    await cp(join(repoRoot, 'registry'), join(root, 'registry'), { recursive: true });
    const validated = await validateRepo(root);
    assert.equal(validated.ok, true, validated.errors.join('\n'));
    const { privatePem, publicPem } = createMarketKey();
    const built = await buildRepo(root, { ...process.env, ENSO_INDEX_TIME: NOW });
    const ids = built.index.plugins.map((plugin) => plugin.id);
    for (const id of ['enso.example.notes', 'enso.example.wordstats']) assert.ok(ids.includes(id), id);
    const signature = signIndex(built.bytes, privatePem);
    assert.equal(verify(null, built.bytes, createPublicKey(publicPem), Buffer.from(signature, 'base64')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单、原生模块与社区 tier', async () => {
  const root = await tempRoot();
  try {
    await writePlugin(root, { id: 'enso.example.notes', version: '1.0.0', permissions: ['ui.view'] });
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);
    const clean = await validateRepo(root, { base: 'main', community: true });
    assert.equal(clean.ok, true, clean.errors.join('\n'));
    assert.match(clean.summary, /无权限变更/);

    const manifest = JSON.parse(await readFile(join(root, 'packages/enso.example.notes/enso-plugin.json'), 'utf8'));
    manifest.permissions = ['ui.view', 'net.fetch'];
    manifest.net = { domains: ['api.github.com'] };
    manifest.version = '1.1.0';
    await writeFile(join(root, 'packages/enso.example.notes/enso-plugin.json'), JSON.stringify(manifest));
    const diff = await validateRepo(root, { base: 'main' });
    assert.match(diff.summary, /新增权限：`net.fetch`/);
    assert.match(diff.summary, /新增域名：`api.github.com`/);
    assert.match(diff.summary, /1\.0\.0 → 1\.1\.0/);

    await writeFile(join(root, 'registry/meta/enso.example.notes.json'), JSON.stringify({ tier: 'community', tags: ['ui'] }));
    const community = await validateRepo(root, { base: 'main', community: true });
    assert.equal(community.ok, false);
    assert.match(community.errors.join('\n'), /不能修改 enso\.example\.notes 的 tier/);
    const maintainer = await validateRepo(root, { base: 'main', community: false });
    assert.equal(maintainer.ok, true, maintainer.errors.join('\n'));

    await writePlugin(root, { id: 'bad', version: '1.0.0' });
    await writePlugin(root, { id: 'enso.example.other', version: '01.0.0' });
    await writeFile(join(root, 'packages/enso.example.notes/native.node'), '');
    symlinkSync('main.mjs', join(root, 'packages/enso.example.notes/link.mjs'));
    const broken = await validateRepo(root, { base: 'main', community: false });
    const text = broken.errors.join('\n');
    assert.match(text, /bad: id 不合法/);
    assert.match(text, /version 必须是 semver/);
    assert.match(text, /禁止 \.node 文件/);
    assert.match(text, /不允许符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未改动的外部插件不出现在权限变更里', async () => {
  const root = await tempRoot();
  const commit = 'a'.repeat(40);
  const spec = (sha) => JSON.stringify({ repo: 'linqiu919/dsh-bce', commit: sha, path: '.' });
  try {
    await writePlugin(root, { id: 'enso.example.notes', version: '1.0.0', permissions: ['ui.view'] });
    await mkdir(join(root, 'registry/external'), { recursive: true });
    await writeFile(join(root, 'registry/external/dsh.bce.json'), spec(commit));
    await writeFile(join(root, 'registry/meta/dsh.bce.json'), JSON.stringify({ tier: 'community', tags: ['mcp'] }));
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'base']);

    await writePlugin(
      root,
      {
        id: 'dsh.bce',
        version: '0.1.5',
        permissions: ['composer.draft', 'mcp.call', 'ui.clipboard', 'ui.slot'],
        mcp: { tools: ['enhance_prompt', 'search_context'] },
      },
      { meta: { tier: 'community', tags: ['mcp'] }, files: { '.external': `${commit}\n` } },
    );
    let fetched = 0;
    const clean = await validateRepo(root, {
      base: 'main',
      catalog: false,
      community: false,
      fetch: async () => {
        fetched += 1;
        return { ok: false, text: async () => '' };
      },
    });
    assert.equal(clean.ok, true, clean.errors.join('\n'));
    assert.match(clean.summary, /无权限变更/);
    assert.equal(fetched, 0);

    await writeFile(join(root, 'registry/external/yce.enhance.json'), spec('c'.repeat(40)));
    await writePlugin(root, { id: 'yce.enhance', version: '0.1.1', permissions: ['ui.slot'] }, { meta: { tier: 'community', tags: [] } });
    const added = await validateRepo(root, { base: 'main', catalog: false, community: false });
    assert.match(added.summary, /yce\.enhance` 新插件 0\.1\.1/);
    assert.doesNotMatch(added.summary, /dsh\.bce/);
    await rm(join(root, 'packages/yce.enhance'), { recursive: true, force: true });
    await rm(join(root, 'registry/external/yce.enhance.json'));
    await rm(join(root, 'registry/meta/yce.enhance.json'));

    const manifest = JSON.parse(await readFile(join(root, 'packages/enso.example.notes/enso-plugin.json'), 'utf8'));
    manifest.permissions = ['ui.view', 'agent.tool'];
    manifest.version = '1.1.0';
    await writeFile(join(root, 'packages/enso.example.notes/enso-plugin.json'), JSON.stringify(manifest));
    const real = await validateRepo(root, { base: 'main', catalog: false, community: false });
    assert.match(real.summary, /enso\.example\.notes/);
    assert.match(real.summary, /新增权限：`agent\.tool`/);
    assert.doesNotMatch(real.summary, /dsh\.bce/);

    await writeFile(join(root, 'registry/external/dsh.bce.json'), spec('b'.repeat(40)));
    const bumped = await validateRepo(root, {
      base: 'main',
      catalog: false,
      community: false,
      fetch: async (url) => {
        assert.match(String(url), new RegExp(`${commit}/enso-plugin.json$`));
        return {
          ok: true,
          text: async () => JSON.stringify({ schemaVersion: 1, id: 'dsh.bce', version: '0.1.4', permissions: ['ui.slot'] }),
        };
      },
    });
    assert.match(bumped.summary, /dsh\.bce` 0\.1\.4 → 0\.1\.5/);
    assert.match(bumped.summary, /新增权限：`composer\.draft`/);
    assert.doesNotMatch(bumped.summary, /新插件 0\.1\.5/);

    await rm(join(root, 'registry/external/dsh.bce.json'));
    await rm(join(root, 'packages/dsh.bce'), { recursive: true, force: true });
    const removed = await validateRepo(root, { base: 'main', catalog: false, community: false });
    assert.match(removed.summary, /dsh\.bce` 已从仓库移除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
