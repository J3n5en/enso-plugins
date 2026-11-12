import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import test from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { activate } from '../packages/enso.excalidraw/main.mjs';
import {
  decodeDocument,
  encodeDocument,
  embedSvgScene,
  formatOf,
  mergeScenes,
  readSvgScene,
  sceneSignature,
} from '../packages/enso.excalidraw/scene.mjs';
import { createBufferSync } from '../packages/enso.excalidraw/sync.mjs';

const FILE_SUFFIX = /^\.[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const MAX_ASSET = 8 * 1024 * 1024;

function element(id, version, extra = {}) {
  return { id, version, versionNonce: extra.nonce ?? version, isDeleted: false, ...extra };
}

function scene(elements, appState = {}, files = {}) {
  return { elements, appState, files, source: 'test', svg: null };
}

test('后缀决定文本格式', () => {
  assert.equal(formatOf('a/b.excalidraw'), 'json');
  assert.equal(formatOf('a/b.excalidraw.json'), 'json');
  assert.equal(formatOf('a/B.EXCALIDRAW.SVG'), 'svg');
});

test('空文件和合法 JSON 能打开，坏文件给出原因', async () => {
  const empty = await decodeDocument('draw.excalidraw', '');
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.elements, []);

  const ok = await decodeDocument('draw.excalidraw', JSON.stringify({ type: 'excalidraw', elements: [element('a', 1)], source: 'kept' }));
  assert.equal(ok.source, 'kept');
  assert.equal(ok.elements[0].id, 'a');

  const bad = await decodeDocument('draw.excalidraw', '{');
  assert.match(bad.error, /JSON/);
  const other = await decodeDocument('draw.excalidraw', '{"type":"not"}');
  assert.match(other.error, /excalidraw/);
});

test('SVG 嵌入的场景能来回读写，并兼容 zlib 压缩', async () => {
  const json = JSON.stringify({ type: 'excalidraw', elements: [element('box', 2)], source: 'svg' });
  const svg = await embedSvgScene('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', json);
  assert.match(svg, /payload-version:2/);
  assert.equal(await readSvgScene(svg), json);
  const decoded = await decodeDocument('diagram.excalidraw.svg', svg);
  assert.equal(decoded.elements[0].id, 'box');
  assert.equal(decoded.source, 'svg');
  const again = await encodeDocument('diagram.excalidraw.svg', { ...decoded, json });
  assert.equal(await readSvgScene(again), json);

  const payload = JSON.stringify({
    version: '1',
    encoding: 'bstring',
    compressed: true,
    encoded: Buffer.from(deflateSync(json)).toString('latin1'),
  });
  const foreign = `<svg xmlns="http://www.w3.org/2000/svg"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${Buffer.from(payload, 'latin1').toString('base64')}<!-- payload-end --></metadata></svg>`;
  assert.equal(await readSvgScene(foreign), json);
  const ours = await embedSvgScene('<svg xmlns="http://www.w3.org/2000/svg"></svg>', json);
  const encoded = /<!-- payload-start -->([^<]+)<!-- payload-end -->/.exec(ours)[1];
  const wrapped = JSON.parse(Buffer.from(encoded, 'base64').toString('latin1'));
  assert.equal(inflateSync(Buffer.from(wrapped.encoded, 'latin1')).toString(), json);
});

test('没有嵌入场景的 SVG 打不开，改名过来的 JSON 可以', async () => {
  const missing = await decodeDocument('a.excalidraw.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.match(missing.error, /嵌入/);
  const renamed = await decodeDocument('a.excalidraw.svg', '{"type":"excalidraw","elements":[{"id":"z","version":1,"versionNonce":1}]}');
  assert.equal(renamed.elements[0].id, 'z');
  assert.equal(renamed.svg, null);
});

test('三方合并保留各自改过的元素和背景色', () => {
  const base = scene([element('a', 1), element('b', 1)], { viewBackgroundColor: '#fff' });
  const outside = scene([element('a', 2, { nonce: 9 }), element('b', 1)], { viewBackgroundColor: '#fff' });
  const mine = scene([element('a', 1), element('b', 3, { nonce: 4 })], { viewBackgroundColor: '#111' });
  const merged = mergeScenes(base, outside, mine);
  const byId = Object.fromEntries(merged.elements.map((item) => [item.id, item]));
  assert.equal(byId.a.version, 2);
  assert.equal(byId.b.version, 3);
  assert.equal(merged.appState.viewBackgroundColor, '#111');
});

test('删除只在改过的一侧生效', () => {
  const base = scene([element('a', 1), element('b', 1)]);
  const outside = scene([element('b', 1)]);
  const mine = scene([element('a', 1), element('b', 1)]);
  const merged = mergeScenes(base, outside, mine);
  assert.deepEqual(merged.elements.map((item) => item.id), ['b']);

  const mineDeleted = scene([element('a', 1, { isDeleted: true }), element('b', 1)]);
  const kept = mergeScenes(base, scene([element('a', 1), element('b', 1)]), mineDeleted);
  assert.deepEqual(kept.elements.map((item) => item.id), ['b']);
});

test('选中和缩放不进签名，元素版本会进', () => {
  const app = { viewBackgroundColor: '#fff', scrollX: 1, zoom: 2 };
  const left = sceneSignature([element('a', 1)], app, {});
  const moved = sceneSignature([element('a', 1)], { ...app, scrollX: 9 }, {});
  const edited = sceneSignature([element('a', 2)], app, {});
  assert.equal(left, moved);
  assert.notEqual(left, edited);
});

function fakeFile(text, rel = 'draw.excalidraw') {
  const listeners = new Set();
  const file = {
    rel,
    text,
    updates: [],
    update(next) {
      file.text = next;
      file.updates.push(next);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(nextRel, nextText) {
      file.rel = nextRel;
      file.text = nextText;
      for (const listener of listeners) listener({ rel: nextRel, text: nextText });
    },
  };
  return file;
}

const encodePlain = async (rel, value) => encodeDocument(rel, value);

test('编辑写回 enso.file，自己的更新不会被当成外部改动', async () => {
  const file = fakeFile('');
  const applied = [];
  const sync = createBufferSync({
    file,
    decode: decodeDocument,
    encode: encodePlain,
    merge: mergeScenes,
    apply: (next) => applied.push(next),
    delay: 10_000,
  });
  await sync.ready;
  sync.noteEdit(scene([element('a', 1)]));
  await sync.flush();
  assert.equal(file.updates.length, 1);
  assert.equal(JSON.parse(file.updates[0]).elements[0].id, 'a');
  assert.equal(applied.length, 0);
  sync.dispose();
});

test('没有本地修改时，外部内容直接换上画布', async () => {
  const file = fakeFile('{"type":"excalidraw","elements":[]}');
  const applied = [];
  const sync = createBufferSync({
    file,
    decode: decodeDocument,
    encode: encodePlain,
    merge: mergeScenes,
    apply: (next, reason) => applied.push([reason, next.elements.map((item) => item.id)]),
  });
  await sync.ready;
  file.emit('draw.excalidraw', JSON.stringify({ type: 'excalidraw', elements: [element('b', 1)] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(applied, [['external', ['b']]]);
  assert.equal(file.updates.length, 0);
  sync.dispose();
});

test('合并编码期间的新编辑不会被这次写回盖掉', async () => {
  const file = fakeFile(JSON.stringify({ type: 'excalidraw', elements: [element('a', 1)] }));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let encodes = 0;
  const sync = createBufferSync({
    file,
    decode: decodeDocument,
    encode: async (rel, value) => {
      encodes += 1;
      if (encodes === 1) await gate;
      return encodePlain(rel, value);
    },
    merge: mergeScenes,
    apply: () => {},
    delay: 10_000,
  });
  await sync.ready;
  sync.noteEdit(scene([element('a', 2, { nonce: 2 })]));
  file.emit('draw.excalidraw', JSON.stringify({ type: 'excalidraw', elements: [element('a', 1), element('b', 1)] }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  sync.noteEdit(scene([element('a', 5, { nonce: 5 }), element('b', 1)]));
  release();
  await sync.flush();
  const written = JSON.parse(file.updates.at(-1));
  assert.equal(written.elements.find((item) => item.id === 'a').version, 5);
  sync.dispose();
});

test('有未写出的修改时和外部版本合并后再交回', async () => {
  const file = fakeFile(JSON.stringify({ type: 'excalidraw', elements: [element('a', 1), element('b', 1)] }));
  const applied = [];
  const sync = createBufferSync({
    file,
    decode: decodeDocument,
    encode: encodePlain,
    merge: mergeScenes,
    apply: (next, reason) => applied.push([reason, next.elements.map((item) => item.id)]),
    delay: 10_000,
  });
  await sync.ready;
  sync.noteEdit(scene([element('a', 1), element('b', 4, { nonce: 8 })]));
  file.emit('draw.excalidraw', JSON.stringify({ type: 'excalidraw', elements: [element('a', 3, { nonce: 7 }), element('b', 1)] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], 'merge');
  const written = JSON.parse(file.updates.at(-1));
  const byId = Object.fromEntries(written.elements.map((item) => [item.id, item.version]));
  assert.equal(byId.a, 3);
  assert.equal(byId.b, 4);
  sync.dispose();
});

test('只打开 http 链接', async () => {
  const calls = [];
  const enso = {
    ui: { openExternal: async (url) => calls.push(url) },
    renderer: { handle(name, fn) { enso.handlers[name] = fn; } },
    handlers: {},
  };
  activate(enso);
  assert.deepEqual(await enso.handlers['open-link']({ url: 'javascript:alert(1)' }), { opened: false });
  assert.deepEqual(await enso.handlers['open-link']({ url: 'https://excalidraw.com' }), { opened: true });
  assert.deepEqual(calls, ['https://excalidraw.com']);
});

test('清单、资源和打包结果符合查看器限制', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/enso.excalidraw/enso-plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'enso.excalidraw');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.permissions, ['ui.view', 'ui.openExternal']);
  const viewer = manifest.contributes.fileViewers[0];
  assert.equal(viewer.default, true);
  assert.equal(viewer.entry, 'editor.html');
  assert.deepEqual(viewer.extensions, ['.excalidraw', '.excalidraw.json', '.excalidraw.svg']);
  for (const ext of viewer.extensions) assert.match(ext, FILE_SUFFIX);
  const root = new URL('../packages/enso.excalidraw/', import.meta.url);
  const js = readFileSync(new URL('editor.js', root), 'utf8');
  const css = statSync(new URL('editor.css', root));
  assert.ok(statSync(new URL('editor.js', root)).size < MAX_ASSET);
  assert.ok(css.size < MAX_ASSET);
  assert.equal(js.includes('esm.sh'), false);
  assert.equal(/\bnew Function\s*\(/.test(js), false);
  assert.equal(/\beval\s*\(/.test(js), false);
  assert.equal(js.includes('new Worker('), false);
  const html = readFileSync(new URL('editor.html', root), 'utf8');
  assert.match(html, /src="editor\.js"/);
  assert.match(html, /href="editor\.css"/);
  const meta = JSON.parse(readFileSync(new URL('../registry/meta/enso.excalidraw.json', import.meta.url), 'utf8'));
  assert.equal(meta.tier, 'official');
  assert.equal(meta.category, 'productivity');
});
