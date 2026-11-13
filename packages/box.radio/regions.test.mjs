import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REGION, filterRegion, findRegion, matchRegion } from './regions.mjs';

const gd = findRegion('gd');
const national = findRegion('national');
const jl = findRegion('jl');
const hl = findRegion('hl');
const hk = findRegion('hk');

test('default region is Guangdong', () => {
  assert.equal(DEFAULT_REGION, 'gd');
  assert.equal(gd.label, '广东');
});

test('matches Guangdong by state, tag, or city in the name', () => {
  assert.equal(matchRegion({ name: '深圳飞扬971', state: 'Guangdong', tags: [] }, gd), true);
  assert.equal(matchRegion({ name: '飞扬971', tags: ['shenzhen'] }, gd), true);
  assert.equal(matchRegion({ name: '广东新闻广播', tags: [] }, gd), true);
  assert.equal(matchRegion({ name: '北京新闻广播', tags: [] }, gd), false);
});

test('Zhongshan stations mislabeled as HK still match Guangdong', () => {
  const zs = { name: '中山綜合廣播', country: 'HK', tags: [] };
  assert.equal(matchRegion(zs, gd), true);
  assert.equal(findRegion('gd').extraCountrycodes.includes('HK'), true);
  const list = filterRegion(
    [
      { id: 'hk1', name: '中山綜合廣播', country: 'HK', votes: 81 },
      { id: 'hk2', name: '中山環保旅遊之聲', country: 'HK', votes: 70 },
      { id: 'hk3', name: '香港电台', country: 'HK', votes: 200 },
    ],
    gd,
    10,
  );
  assert.deepEqual(list.map((s) => s.id), ['hk1', 'hk2']);
});

test('HK-labeled Guangdong city stations belong to Guangdong not Hong Kong', () => {
  const taishan = { name: '台山電台', country: 'HK', tags: [] };
  const shenzhen = { name: '深圳新聞廣播', country: 'HK', tags: [] };
  const zhuhai = { name: '珠海綜合廣播', country: 'HK', tags: [] };
  const rthk = { name: 'RTHK Radio 1', country: 'HK', tags: [] };
  assert.equal(matchRegion(taishan, gd), true);
  assert.equal(matchRegion(shenzhen, gd), true);
  assert.equal(matchRegion(zhuhai, gd), true);
  assert.equal(matchRegion(taishan, hk), false);
  assert.equal(matchRegion(shenzhen, hk), false);
  assert.equal(matchRegion(zhuhai, hk), false);
  assert.equal(matchRegion(rthk, hk), true);
  assert.equal(matchRegion(rthk, gd), false);
});

test('national 音乐之声 does not steal 广东音乐之声', () => {
  assert.equal(matchRegion({ name: '音乐之声', tags: [] }, national), true);
  assert.equal(matchRegion({ name: '广东音乐之声', tags: [] }, national), false);
  assert.equal(matchRegion({ name: '广东音乐之声', tags: [] }, gd), true);
});

test('Jilin does not match Heilongjiang', () => {
  assert.equal(matchRegion({ name: '黑龙江新闻广播', tags: [] }, jl), false);
  assert.equal(matchRegion({ name: '黑龙江新闻广播', tags: [] }, hl), true);
  assert.equal(matchRegion({ name: '吉林新闻综合广播', tags: [] }, jl), true);
});

test('filterRegion sorts by votes descending and caps', () => {
  const list = filterRegion(
    [
      { id: 'a', name: '广州一台', votes: 1 },
      { id: 'b', name: '深圳一台', votes: 9 },
      { id: 'c', name: '北京一台', votes: 99 },
      { id: 'b', name: '深圳一台 dup', votes: 8 },
    ],
    gd,
    10,
  );
  assert.deepEqual(list.map((s) => s.id), ['b', 'a']);
});
