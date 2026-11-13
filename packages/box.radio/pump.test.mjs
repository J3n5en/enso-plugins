import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_BYTES } from './pump.mjs';

test('chunk JSON stays under the 64KB UI payload cap', () => {
  const b64 = Buffer.alloc(CHUNK_BYTES, 1).toString('base64');
  const payload = JSON.stringify({ ok: true, empty: false, eof: false, b64 });
  assert.equal(payload.length < 64 * 1024, true);
});
