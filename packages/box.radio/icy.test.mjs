import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ByteChunker, IcyStripper, SyncSkipper, findAudioSync } from './icy.mjs';

test('IcyStripper passes through when metaint is 0', () => {
  const s = new IcyStripper(0);
  const out = [];
  s.push(Buffer.from('abc'), (p) => out.push(Buffer.from(p).toString()));
  assert.deepEqual(out, ['abc']);
});

test('IcyStripper drops zero-length meta and keeps audio', () => {
  const s = new IcyStripper(4);
  const out = [];
  const buf = Buffer.concat([
    Buffer.from('AAAA'),
    Buffer.from([0]),
    Buffer.from('BBBB'),
    Buffer.from([0]),
  ]);
  s.push(buf, (p) => out.push(Buffer.from(p)));
  assert.equal(Buffer.concat(out).toString(), 'AAAABBBB');
});

test('IcyStripper skips metadata block of length*16', () => {
  const s = new IcyStripper(3);
  const meta = Buffer.alloc(16, 0x53);
  const buf = Buffer.concat([Buffer.from('xyz'), Buffer.from([1]), meta, Buffer.from('QRS')]);
  const out = [];
  s.push(buf, (p) => out.push(Buffer.from(p)));
  assert.equal(Buffer.concat(out).toString(), 'xyzQRS');
});

test('ByteChunker splits on size and flush remainder', () => {
  const c = new ByteChunker(4);
  const chunks = [];
  c.push(Buffer.from('abcdefghij'), (x) => chunks.push(x.toString()));
  assert.deepEqual(chunks, ['abcd', 'efgh']);
  c.flush((x) => chunks.push(x.toString()));
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
});

test('ByteChunker emits a smaller first chunk then full size', () => {
  const c = new ByteChunker(8, 3);
  const chunks = [];
  c.push(Buffer.from('abcdefghijkl'), (x) => chunks.push(x.toString()));
  assert.deepEqual(chunks, ['abc', 'defghijk']);
  c.flush((x) => chunks.push(x.toString()));
  assert.deepEqual(chunks, ['abc', 'defghijk', 'l']);
});

test('findAudioSync locates MP3 frame header', () => {
  const buf = Buffer.from([0x00, 0x11, 0xff, 0xfb, 0x90, 0x00]);
  assert.equal(findAudioSync(buf), 2);
});

test('SyncSkipper drops bytes before the first sync', () => {
  const s = new SyncSkipper();
  const out = [];
  s.push(Buffer.from([0x00, 0x00, 0xff, 0xfb, 0x90]), (p) => out.push(Buffer.from(p)));
  assert.equal(Buffer.concat(out).equals(Buffer.from([0xff, 0xfb, 0x90])), true);
});
