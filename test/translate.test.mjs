import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, normalizeSettings, translate } from '../packages/enso.translate/main.mjs';
import {
  createMessageVisibility,
  createQueue,
  isUnchanged,
  leafPlan,
  prepareSource,
  hasTranslatable,
  protect,
  restore,
  segment,
  translationKey,
} from '../packages/enso.translate/ui.js';

const PROMPT = '请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n';
const prompt = (language) => `请将以下文本翻译为${language}，直接输出翻译结果，不要进行任何解释。\n\n`;

test('空行分段；围栏含空行仍是一段且不参与前后分段', () => {
  const text = ['This is English.', '', '```js', 'const a = 1;', '', 'const b = 2;', '```', '', 'tail'].join('\n');
  assert.deepEqual(segment(text, false), [
    { source: 'This is English.', kind: 'prose', final: true },
    { source: '```js\nconst a = 1;\n\nconst b = 2;\n```', kind: 'code', final: true },
    { source: 'tail', kind: 'prose', final: true },
  ]);
});

test('汉字占比过半的段跳过，未闭合围栏整段视为代码', () => {
  assert.deepEqual(segment('这是中文段落，不要翻译它。\n\nOK, sounds 好', false), [
    { source: '这是中文段落，不要翻译它。', kind: 'skip', final: true },
    { source: 'OK, sounds 好', kind: 'prose', final: true },
  ]);
  assert.deepEqual(segment('done\n\n```py\nprint(1)', false), [
    { source: 'done', kind: 'prose', final: true },
    { source: '```py\nprint(1)', kind: 'code', final: true },
  ]);
  assert.deepEqual(segment('  ```\n  中文\n  ```', false), [
    { source: '  ```\n  中文\n  ```', kind: 'code', final: true },
  ]);
});

test('流式时只有最后一段不是 final，结束后才 final', () => {
  const text = 'first\n\nsecond';
  assert.deepEqual(segment(text, true), [
    { source: 'first', kind: 'prose', final: true },
    { source: 'second', kind: 'prose', final: false },
  ]);
  assert.equal(segment(text, false).at(-1).final, true);
  assert.deepEqual(segment('', true), []);
  assert.deepEqual(segment('\n\n', false), []);
  assert.deepEqual(segment('a\r\n\r\nb', true), [
    { source: 'a', kind: 'prose', final: true },
    { source: 'b', kind: 'prose', final: false },
  ]);
});

test('思考分段按目标语言跳过', () => {
  assert.equal(segment('OK 好', false, '英文')[0].kind, 'skip');
  assert.equal(segment('这是テスト', false, '中文')[0].kind, 'prose');
  assert.equal(segment('これはテスト', false, '日文')[0].kind, 'skip');
});

test('译文与原文只差空白时视为未变化', () => {
  assert.equal(isUnchanged('run ⟦0⟧  now\n', 'run ⟦0⟧ now'), true);
  assert.equal(isUnchanged('run ⟦0⟧ now', '运行 ⟦0⟧'), false);
});

test('中文句里夹英文词、命令、代码和路径时不翻译', () => {
  const zh = [
    '需要执行 ls 命令。',
    '先跑 git status 再看 npm install 输出',
    '用 TypeScript 重写 React 组件',
    '我来看看 packages/enso.translate/ui.js 的 isTargetLanguage 逻辑',
    '运行 `pnpm --filter @enso/web build:prod` 看结果',
  ];
  for (const text of zh) {
    assert.equal(prepareSource(text, '中文'), null, text);
    assert.equal(segment(text, false)[0].kind, 'skip', text);
  }
  assert.equal(segment('The user wants 中文 output.', false)[0].kind, 'prose');
  assert.equal(prepareSource('Let me check the ls output.', '中文')?.text, 'Let me check the ls output.');
});

function fakeEnso(fetch) {
  const handlers = {};
  const enso = {
    config: { get: async () => ({}) },
    net: { fetch },
    renderer: { handle: (name, fn) => (handlers[name] = fn) },
  };
  activate(enso);
  return { enso, handlers };
}

const okBody = (content) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ choices: [{ message: { content } }] }),
});

test('translate 提交指定请求体，并去掉 think 标记', async () => {
  const calls = [];
  const { enso, handlers } = fakeEnso(async (url, init) => {
    calls.push({ url, init });
    return okBody('<think>\n内部\n</think>\n\n译文结果');
  });
  enso.config.get = async () => ({ model: 'Index-Translate-9B' });
  const result = await handlers.translate({ text: 'Hello `code`' });
  assert.deepEqual(result, { text: '译文结果' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://index-translate.bilibili.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'Index-Translate-9B',
    messages: [{ role: 'user', content: `${PROMPT}Hello \`code\`` }],
    temperature: 0,
    max_tokens: 2048,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  });

  const plain = await translate(enso, 'Hi');
  assert.equal(plain.text, '译文结果');
  assert.equal(JSON.parse(calls[1].init.body).model, 'Index-Translate-9B');
});

test('translate 请求体包含目标语言提示词', async () => {
  const calls = [];
  const { enso, handlers } = fakeEnso(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return okBody('ok');
  });
  await handlers.translate({ text: '你好', target: '英文' });
  await handlers.translate({ text: 'hello', target: '日文' });
  enso.config.get = async () => ({ targetLanguage: '韩文', model: 'Index-Translate-2B' });
  await handlers.translate({ text: 'hello' });
  assert.equal(calls[0].messages[0].content, `${prompt('英文')}你好`);
  assert.equal(calls[1].messages[0].content, `${prompt('日文')}hello`);
  assert.equal(calls[2].model, 'Index-Translate-2B');
  assert.equal(calls[2].messages[0].content, `${prompt('韩文')}hello`);
  assert.equal(calls[0].chat_template_kwargs.enable_thinking, false);
});

test('未配置或未知模型时用 35B，没有 think 标记则原样 trim', async () => {
  const calls = [];
  const { enso, handlers } = fakeEnso(async (_url, init) => {
    calls.push(JSON.parse(init.body).model);
    return okBody('  直接译文  ');
  });
  assert.equal((await handlers.translate({ text: 'A' })).text, '直接译文');
  enso.config.get = async () => ({ model: 'not-a-model' });
  assert.equal((await handlers.translate({ text: 'B' })).text, '直接译文');
  assert.deepEqual(calls, ['Index-Translate-35B-A3B', 'Index-Translate-35B-A3B']);
});

test('非 200 视为失败', async () => {
  const { handlers } = fakeEnso(async () => ({ status: 503, headers: {}, body: 'nope' }));
  await assert.rejects(handlers.translate({ text: 'Hello' }), /503/);
});

const DEFAULTS = {
  thinking: true,
  bodyMode: '手动',
  targetLanguage: '中文',
  model: 'Index-Translate-35B-A3B',
};

test('设置规范化：非法值回到默认', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULTS);
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  assert.deepEqual(
    normalizeSettings({
      thinking: false,
      bodyMode: '自动',
      targetLanguage: '俄文',
      model: 'Index-Translate-9B',
    }),
    { thinking: false, bodyMode: '自动', targetLanguage: '俄文', model: 'Index-Translate-9B' },
  );
  assert.deepEqual(
    normalizeSettings({ thinking: 'yes', bodyMode: '开', targetLanguage: '意大利文', model: 'gpt' }),
    DEFAULTS,
  );
  assert.equal(normalizeSettings({ thinking: false }).thinking, false);
  assert.equal(normalizeSettings({ bodyMode: '关闭' }).bodyMode, '关闭');
});

test('settings 返回规范化配置', async () => {
  const { enso, handlers } = fakeEnso(async () => okBody('x'));
  assert.deepEqual(await handlers.settings(), DEFAULTS);
  enso.config.get = async () => ({
    thinking: false,
    bodyMode: 'nope',
    targetLanguage: '韩文',
    model: 'Index-Translate-9B',
  });
  assert.deepEqual(await handlers.settings(), {
    thinking: false,
    bodyMode: '手动',
    targetLanguage: '韩文',
    model: 'Index-Translate-9B',
  });
});

test('队列并发不超过上限', async () => {
  let started = 0;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const queue = createQueue(3);
  const job = async () => {
    started += 1;
    await hold;
    return '好';
  };
  const pending = [1, 2, 3, 4].map(() => queue(job));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 3);
  release();
  const results = await Promise.all(pending);
  assert.equal(started, 4);
  assert.deepEqual(results, ['好', '好', '好', '好']);
});

test('占位符保护行内代码、链接、图片、URL、路径、公式和 HTML，并能还原', () => {
  const source = [
    'use `const a = 1` and ``keep `tick` `` now',
    'see [docs](https://example.com/a?q=1) and ![pic](./a.png)',
    'go <https://example.com/auto> or https://example.com/bare.',
    'edit src/main.ts, ./README, ~/bin and /etc/hosts plus C:\\foo\\bar.ts',
    'energy $E = mc^2$ and <span class="x">word</span>',
    'plain README.md stays',
  ].join(' ');
  const { text, slots } = protect(source);
  assert.equal(text.includes('`'), false);
  assert.equal(text.includes('https://'), false);
  assert.equal(text.includes('src/main.ts'), false);
  assert.equal(text.includes('$E'), false);
  assert.equal(text.includes('<span'), false);
  assert.equal(text.includes('README.md'), true);
  assert.deepEqual(slots, [
    '`const a = 1`',
    '``keep `tick` ``',
    '[docs](https://example.com/a?q=1)',
    '![pic](./a.png)',
    '<https://example.com/auto>',
    'https://example.com/bare',
    'src/main.ts',
    './README',
    '~/bin',
    '/etc/hosts',
    'C:\\foo\\bar.ts',
    '$E = mc^2$',
    '<span class="x">',
    '</span>',
  ]);
  for (let i = 0; i < slots.length; i += 1) assert.equal(text.split(`⟦${i}⟧`).length - 1, 1);
  const translated = text.replace('use', '用').replace('see', '看').replace('word', '词').replace('plain', '普通');
  assert.equal(
    restore(translated, slots),
    source.replace('use', '用').replace('see', '看').replace('word', '词').replace('plain', '普通'),
  );
});

test('无扩展名的斜杠词不保护，已有占位符本身被保护', () => {
  const { text, slots } = protect('see not/a/path and ⟦0⟧ end');
  assert.equal(text.includes('not/a/path'), true);
  assert.deepEqual(slots, ['⟦0⟧']);
  assert.equal(restore('看 ⟦0⟧ 结束', slots), '看 ⟦0⟧ 结束');
});

test('占位符缺失、重复或多余时不还原', () => {
  const { slots } = protect('A `x` and `y`');
  assert.equal(slots.length, 2);
  assert.equal(restore('甲 ⟦0⟧ 乙', slots), null);
  assert.equal(restore('⟦0⟧ ⟦0⟧', slots), null);
  assert.equal(restore('⟦0⟧ ⟦1⟧ ⟦2⟧', slots), null);
  assert.equal(restore('⟦0⟧ ⟦1⟧ ⟦', slots), null);
  assert.equal(restore('甲 ⟦1⟧ 乙 ⟦0⟧', slots), '甲 `y` 乙 `x`');
});

test('只剩占位符和标点，或已经是目标语言时跳过', () => {
  assert.equal(prepareSource('`only code`.', '中文'), null);
  assert.equal(prepareSource('你好，世界', '中文'), null);
  assert.equal(prepareSource('Hello `code`', '英文'), null);
  assert.equal(prepareSource('これはテスト', '日文'), null);
  assert.equal(prepareSource('안녕하세요', '韩文'), null);
  assert.equal(prepareSource('Привет мир', '俄文'), null);
  assert.equal(prepareSource('Bonjour le monde', '法文'), null);
  assert.equal(prepareSource('Guten Tag', '德文'), null);
  assert.equal(prepareSource('Hola mundo', '西班牙文'), null);
  assert.equal(prepareSource('', '中文'), null);
  assert.equal(prepareSource('   ', '中文'), null);

  assert.equal(prepareSource('Say hello to the 世界', '中文')?.text, 'Say hello to the 世界');
  assert.equal(prepareSource('这是テスト', '中文')?.text, '这是テスト');
  assert.equal(prepareSource('ab cd 你好', '中文'), null);
  assert.equal(prepareSource('ab cd 你好', '英文'), null);
  assert.equal(prepareSource('東京都', '日文')?.text, '東京都');
  assert.equal(prepareSource('see `code` please', '中文')?.text, 'see ⟦0⟧ please');
});

test('未完成、关闭或未显示时叶子不翻译', () => {
  assert.equal(leafPlan({ final: false, bodyMode: '自动', shown: true, source: 'Hello', targetLanguage: '中文' }), null);
  assert.equal(leafPlan({ final: true, bodyMode: '关闭', shown: true, source: 'Hello', targetLanguage: '中文' }), null);
  assert.equal(leafPlan({ final: true, bodyMode: '手动', shown: false, source: 'Hello', targetLanguage: '中文' }), null);
  assert.equal(
    leafPlan({ final: true, bodyMode: '自动', shown: true, source: 'Hello', targetLanguage: '中文' })?.text,
    'Hello',
  );
});

test('整段无需翻译时不显示按钮，判断与思考分段相同', () => {
  const zh = [
    '「已工作 1m40s · ...」这一行在本轮还没结束时会呼吸，结束后恢复静止。',
    '',
    '尾段折进过程组、这一轮仍在跑时，标题和后面的摘要一起用 animate-pulse 呼吸，效果与 Orca 进行中的工具摘要一致。',
    '',
    '回合结束，或后面已经出现正文、这段过程算完成时，不再呼吸。',
  ].join('\n');
  assert.equal(hasTranslatable(zh, '中文'), false);
  assert.equal(hasTranslatable('这是中文。\n\n```js\nconst a = 1;\n```', '中文'), false);
  assert.equal(hasTranslatable('这是中文。\n\nHello, this still needs translation.', '中文'), true);
  assert.equal(hasTranslatable('Hello', '中文'), true);
  assert.equal(hasTranslatable('Hello', '英文'), false);
  assert.equal(hasTranslatable('这是中文', '英文'), true);
  assert.equal(hasTranslatable('', '中文'), false);
  assert.equal(hasTranslatable(undefined, '中文'), true);
});

test('message.action 切换后 message.leaf 的订阅者收到更新', () => {
  const vis = createMessageVisibility();
  const events = [];
  const unsub = vis.subscribe('sess', 2, (value) => events.push(value));
  assert.equal(vis.key('sess', 2), 'sess:2');
  assert.equal(vis.key(null, 0), 'null:0');
  assert.equal(vis.shown('sess', 2, '手动'), false);
  assert.equal(vis.label('sess', 2, '手动'), '翻译');
  assert.equal(vis.shown('sess', 2, '自动'), true);
  assert.equal(vis.label('sess', 2, '自动'), '显示原文');
  assert.equal(vis.shown('sess', 2, '关闭'), false);
  assert.equal(vis.label('sess', 2, '关闭'), '翻译');
  vis.toggle('sess', 2, '手动');
  assert.deepEqual(events, [true]);
  assert.equal(vis.shown('sess', 2, '手动'), true);
  assert.equal(vis.shown('sess', 2, '自动'), true);
  assert.equal(vis.label('sess', 2, '手动'), '显示原文');
  assert.equal(vis.toggle('sess', 2, '关闭'), false);
  assert.deepEqual(events, [true]);
  assert.equal(vis.shown('sess', 3, '手动'), false);
  unsub();
  vis.toggle('sess', 2, '手动');
  assert.deepEqual(events, [true]);
  assert.equal(vis.shown('sess', 2, '手动'), false);

  const auto = createMessageVisibility();
  const hidden = [];
  auto.subscribe('a', 0, (value) => hidden.push(value));
  assert.equal(auto.shown('a', 0, '自动'), true);
  auto.toggle('a', 0, '自动');
  assert.deepEqual(hidden, [false]);
  assert.equal(auto.label('a', 0, '自动'), '翻译');
});

test('翻译缓存键包含模型、目标语言和文本', () => {
  assert.equal(translationKey('Index-Translate-9B', '英文', 'Hello'), 'Index-Translate-9B\0英文\0Hello');
  assert.notEqual(
    translationKey('Index-Translate-9B', '英文', 'Hello'),
    translationKey('Index-Translate-2B', '英文', 'Hello'),
  );
  assert.notEqual(
    translationKey('Index-Translate-9B', '英文', 'Hello'),
    translationKey('Index-Translate-9B', '日文', 'Hello'),
  );
});
