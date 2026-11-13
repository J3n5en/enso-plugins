import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRadioBrowser, DirectoryError } from './radioBrowser.mjs';

test('discover uses a live node and maps stations', async () => {
  const calls = [];
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async (url) => {
      calls.push(String(url));
      return {
        status: 200,
        ok: true,
        json: async () => [
          {
            stationuuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: '中国之声',
            countrycode: 'CN',
            codec: 'MP3',
            hls: 0,
            lastcheckok: 1,
            bitrate: 64,
          },
        ],
      };
    },
  });
  const list = await api.discover();
  assert.equal(list.length, 1);
  assert.equal(list[0].playable, true);
  assert.match(calls[0], /n1\.api\.radio-browser\.info\/json\/stations\/search/);
});

test('click reads url from the click endpoint', async () => {
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        stationuuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: '中国之声',
        url: 'https://example.com/live.mp3',
      }),
    }),
  });
  const clicked = await api.click('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(clicked.url, 'https://example.com/live.mp3');
  assert.equal(clicked.name, '中国之声');
});

test('all nodes down become DirectoryError', async () => {
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(() => api.discover(), DirectoryError);
});

test('byRegion filters the CN catalog to Guangdong and sorts votes', async () => {
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async () => ({
      status: 200,
      ok: true,
      json: async () => [
        {
          stationuuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: '北京新闻广播',
          countrycode: 'CN',
          codec: 'MP3',
          hls: 0,
          lastcheckok: 1,
          votes: 100,
        },
        {
          stationuuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          name: '广东新闻广播',
          countrycode: 'CN',
          codec: 'MP3',
          hls: 0,
          lastcheckok: 1,
          votes: 3,
        },
        {
          stationuuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          name: '深圳飞扬971',
          countrycode: 'CN',
          state: 'Guangdong',
          codec: 'MP3',
          hls: 0,
          lastcheckok: 1,
          votes: 20,
        },
      ],
    }),
  });
  const list = await api.byRegion('gd');
  assert.deepEqual(list.map((s) => s.id), [
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  ]);
});

test('byRegion Guangdong merges HK-labeled Zhongshan stations', async () => {
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async (url) => {
      const hk = String(url).includes('countrycode=HK');
      return {
        status: 200,
        ok: true,
        json: async () =>
          hk
            ? [
                {
                  stationuuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
                  name: '中山綜合廣播',
                  countrycode: 'HK',
                  codec: 'MP3',
                  hls: 0,
                  lastcheckok: 1,
                  votes: 81,
                },
              ]
            : [
                {
                  stationuuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                  name: '广东新闻广播',
                  countrycode: 'CN',
                  codec: 'MP3',
                  hls: 0,
                  lastcheckok: 1,
                  votes: 3,
                },
              ],
      };
    },
  });
  const list = await api.byRegion('gd');
  assert.equal(
    list.some((s) => s.name.includes('中山')),
    true,
  );
});

test('search 快乐888 also queries catalog name 環保旅遊', async () => {
  const names = [];
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async (url) => {
      const decoded = decodeURIComponent(String(url));
      names.push(decoded);
      const hit = decoded.includes('環保') || decoded.includes('环保');
      return {
        status: 200,
        ok: true,
        json: async () =>
          hit
            ? [
                {
                  stationuuid: 'aa91470c-89dc-48ba-b155-f6455fc2fa74',
                  name: '中山環保旅遊之聲',
                  countrycode: 'HK',
                  codec: 'MP3',
                  hls: 0,
                  lastcheckok: 1,
                  votes: 70,
                },
              ]
            : [],
      };
    },
  });
  const list = await api.search('快乐888');
  assert.equal(list.length, 1);
  assert.equal(list[0].aliases.includes('快乐888'), true);
});

test('json falls back to http when https fetch fails', async () => {
  const api = createRadioBrowser({
    resolve4: async () => ['1.2.3.4'],
    reverse: async () => ['n1.api.radio-browser.info'],
    fetchApi: async (url) => {
      if (String(url).startsWith('https://')) throw new Error('tls blocked');
      return {
        status: 200,
        ok: true,
        json: async () => [
          {
            stationuuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: '中国之声',
            countrycode: 'CN',
            codec: 'MP3',
            hls: 0,
            lastcheckok: 1,
          },
        ],
      };
    },
  });
  const list = await api.discover();
  assert.equal(list.length, 1);
});
