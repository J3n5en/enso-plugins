import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLocalCover, resolveCover } from './cover.mjs';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('readLocalCover serves a packaged jpeg under 40KB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'box-radio-cover-'));
  await mkdir(join(root, 'covers'));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);
  await writeFile(join(root, 'covers', `${ID}.jpg`), jpeg);
  await writeFile(
    join(root, 'covers', 'manifest.json'),
    JSON.stringify({ byId: { [ID]: `${ID}.jpg` } }),
  );
  const res = readLocalCover(ID, { root });
  assert.equal(res.ok, true);
  assert.match(res.dataUrl, /^data:image\/jpeg;base64,/);
});

test('readLocalCover rejects path traversal in manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'box-radio-cover-'));
  await mkdir(join(root, 'covers'));
  await writeFile(
    join(root, 'covers', 'manifest.json'),
    JSON.stringify({ byId: { [ID]: '../secret.jpg' } }),
  );
  assert.equal(readLocalCover(ID, { root }).ok, false);
});

test('resolveCover falls back to url when local missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'box-radio-cover-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const res = await resolveCover(ID, 'https://example.test/a.png', {
    root,
    fetchApi: async () =>
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
  });
  assert.equal(res.ok, true);
  assert.match(res.dataUrl, /^data:image\/png;base64,/);
});
