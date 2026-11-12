import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const files = ['data.js', 'airframes.js', 'engine.js', 'audio.js', 'render.js', 'app.js'];
const source = files.map(name => readFileSync(new URL(name, root), 'utf8')).join('\n');
const stamp = createHash('sha256').update(source).digest('hex');
const bootUrl = new URL('../boot.js', import.meta.url);
const boot = readFileSync(bootUrl, 'utf8');

test('侧栏入口由原模块生成，且不超过宿主单文件上限', () => {
  assert.match(boot, new RegExp(`source-sha256: ${stamp}`));
  assert.ok(Buffer.byteLength(boot) < 8 * 1024 * 1024);
  assert.doesNotMatch(boot, /^\s*import\s/m);
  assert.doesNotMatch(boot, /^\s*export\s/m);
  assert.match(boot, /TF\.Game=Game/);
  assert.match(boot, /drawFrame\(ctx, game/);
  const checked = spawnSync(process.execPath, ['--check', fileURLToPath(bootUrl)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});
