import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aliasLabelsFor, expandSearchTerms, foldZh } from './aliases.mjs';

test('快乐888 expands to 环保旅游之声 catalog names', () => {
  const terms = expandSearchTerms('快乐888');
  assert.equal(terms[0], '快乐888');
  assert.equal(
    terms.some((t) => t.includes('環保旅遊') || t.includes('环保旅游')),
    true,
  );
});

test('aliasLabelsFor attaches 快乐888 to 中山環保旅遊之聲', () => {
  assert.deepEqual(aliasLabelsFor('中山環保旅遊之聲'), ['快乐888']);
  assert.deepEqual(aliasLabelsFor('RTHK Radio 1'), []);
});

test('foldZh treats 廣播 as 广播', () => {
  assert.equal(foldZh('深圳新聞廣播'), foldZh('深圳新闻广播'));
});
