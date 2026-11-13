import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapStations, mimeForCodec, normalizeCodec, normalizeStation } from './station.mjs';

test('normalizeCodec maps mp3 and aac variants', () => {
  assert.equal(normalizeCodec('mp3'), 'MP3');
  assert.equal(normalizeCodec('AAC+'), 'AAC');
  assert.equal(normalizeCodec('aacp'), 'AAC');
  assert.equal(normalizeCodec('ogg'), 'OTHER');
});

test('normalizeStation drops broken or nameless rows', () => {
  assert.equal(normalizeStation({ stationuuid: 'a', name: 'X', lastcheckok: 0 }), null);
  assert.equal(normalizeStation({ stationuuid: 'a', name: '   ', lastcheckok: 1 }), null);
  assert.equal(normalizeStation(null), null);
});

test('normalizeStation marks HLS and unknown codec unplayable but keeps the row', () => {
  const hls = normalizeStation({
    stationuuid: '11111111-1111-1111-1111-111111111111',
    name: '  中国之声  ',
    countrycode: 'cn',
    codec: 'MP3',
    hls: 1,
    bitrate: 64,
    lastcheckok: 1,
    favicon: 'https://example.com/a.png',
    tags: 'News, Talk, extra, x, y, z',
  });
  assert.equal(hls?.playable, false);
  assert.equal(hls?.hls, true);
  assert.equal(hls?.name, '中国之声');
  assert.equal(hls?.country, 'CN');
  assert.equal(hls?.hasFavicon, true);
  assert.equal(hls?.tags.length, 5);

  const other = normalizeStation({
    stationuuid: '22222222-2222-2222-2222-222222222222',
    name: 'Ogg',
    codec: 'OGG',
    hls: 0,
    lastcheckok: 1,
  });
  assert.equal(other?.playable, false);
  assert.equal(other?.codec, 'OTHER');
});

test('mapStations keeps playable MP3', () => {
  const list = mapStations([
    { stationuuid: '1', name: '', lastcheckok: 1, codec: 'MP3' },
    {
      stationuuid: '33333333-3333-3333-3333-333333333333',
      name: 'CNR',
      codec: 'MP3',
      hls: 0,
      lastcheckok: 1,
      bitrate: 64,
    },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].playable, true);
  assert.equal(mimeForCodec(list[0].codec), 'audio/mpeg');
});
