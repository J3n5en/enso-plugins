// 界面汉化只做运行时替换，所以最有价值的测试是两件事：
//   1. 字典里的每个键确实出现在原版页面里（写错的键 = 永远不生效的死条目）
//   2. 替换是幂等的，且带变量的句子（"3 posts"）也能翻出来
// 这两条都不需要浏览器。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const board = join(dirname(new URL(import.meta.url).pathname), '..', 'swarm_board');
// main.mjs 里有插件自己写进 transcript 的动作文案（'Posting to the board'），同样属于界面。
const sources = ['index.html', 'app.js', 'hive.js', 'main.mjs'].map((f) => readFileSync(join(board, f), 'utf8'));
// 源码里 ' 可能写成 \' ，长句还可能被拆成 '…' + '…' 两段，先还原成渲染后的样子再查。
const all = sources
  .join('\n')
  .replace(/\\'/g, "'")
  .replace(/\\"/g, '"')
  .replace(/' \+\s*'/g, '')
  .replace(/\u2019/g, "'");

const sandbox = { window: {}, document: {}, NodeFilter: {}, MutationObserver: function () {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(board, 'i18n.js'), 'utf8'), sandbox);
const zh = sandbox.window.__swarmZh;

test('every dictionary key exists in the bundled pane', () => {
  const dead = Object.keys(zh.TEXT).filter((key) => !all.includes(key)).sort();
  assert.deepEqual(dead, [], `死条目（原版页面里找不到）: ${dead.join(' | ')}`);
});

test('dictionary values are Chinese and carry no English sentence left', () => {
  for (const [key, value] of Object.entries(zh.TEXT)) {
    assert.match(value, /[\u4e00-\u9fff]/, `${key} 没有翻译成中文: ${value}`);
    assert.doesNotMatch(value, /[a-z]{4,}\s+[a-z]{4,}/, `${key} 还留着英文句子: ${value}`);
  }
});

test('exact text, attribute copy and interpolated sentences are translated', () => {
  assert.equal(zh.translateText('Board'), '看板');
  assert.equal(zh.translateText('  Board\n'), '  看板\n', '首尾空白要保留');
  assert.equal(zh.translateText('Untitled swarm'), '未命名蜂群');
  assert.equal(zh.translateText('Killed: removed from the swarm'), '已结束：已从蜂群移除');
  assert.equal(zh.translateText('12 posts'), '12 条消息');
  assert.equal(zh.translateText('1 earlier post'), '1 条更早的消息');
  assert.equal(zh.translateText('Show 20 earlier posts (137 older)'), '显示 20 条更早的消息（共 137 条更旧）');
  assert.equal(zh.translateText('8 posts · 3 members'), '8 条消息 · 3 名成员');
  assert.equal(zh.translateText('Working for @alpha'), '正在为 @alpha 干活');
  assert.equal(zh.translateText('Waiting on @coordinator'), '在等 @coordinator');
  assert.equal(zh.translateText('Runs on another machine'), '运行在 另一台机器');
  assert.equal(zh.translateText('Showing the last good view.json; the current file is over 64 KB.'), '显示的是上一次可用的 view.json，当前文件超过 64 KB。');
  assert.equal(zh.translateText('paused: quota'), '已暂停：额度用尽');
  assert.equal(zh.translateText('read #12 · updated 42s ago'), '读到 #12 · 42s 前更新');
  assert.equal(zh.translateText('alpha: no progress, and not waiting on the board'),
    'alpha：没有进展，也没有在板上等');
  assert.equal(zh.translateText('beta: last step failed (quota)'), 'beta：最后一步失败（额度用尽）');
  assert.equal(zh.translateText('#12 from @alpha: done'), '#12 来自 @alpha: done');
  assert.equal(zh.translateText('3 @all'), '3 条 @all');
  assert.equal(zh.translateText('Coordinator · Working'), '协调者 · 工作中');
  assert.equal(zh.translateText('Coordinator'), '协调者');
  assert.equal(zh.translateText('0 of 3 tasks done'), '0/3 个任务完成');
  assert.equal(zh.translateText('2 threads open'), '2 个线程进行中');
  assert.equal(zh.translateText('10 posts over 1m 20s'), '10 条消息，历时 1m 20s');
  assert.equal(zh.translateText('over 1m 20s'), '历时 1m 20s');
  assert.equal(zh.translateText('0 of 3 done'), '0/3 完成');
  assert.equal(zh.translateText('0 of 3'), '0 / 3');
  assert.equal(zh.translateText('3 bees'), '3 只蜂');
  assert.equal(zh.translateText('Posting to the board'), '正在发到看板');
  assert.equal(zh.translateText('Go to #7'), '跳到 #7');
  assert.equal(zh.translateText('Narrator’s page · AI-generated'), 'Narrator 的页面 · AI 生成');
});

test('replacing twice changes nothing, and prose is left alone', () => {
  for (const value of Object.values(zh.TEXT)) assert.equal(zh.translateText(value), value, `二次替换改动了: ${value}`);
  const prose = 'alpha: I counted 1429 *.test.ts files; see #12 for the caveat.';
  assert.equal(zh.translateText(prose), prose);
  assert.equal(zh.translateText('board.jsonl'), 'board.jsonl');
});
