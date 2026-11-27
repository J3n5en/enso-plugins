import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/** 只够 view.html 脚本跑起来的假 DOM：插槽元素记录 innerHTML 写入次数 */
async function mount(responder) {
  const html = await readFile(new URL('../packages/enso.telegram/view.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const listeners = {};
  const el = (id) => {
    const node = {
      id,
      writes: 0,
      html: '',
      listeners: {},
      set innerHTML(v) {
        this.html = v;
        this.writes += 1;
      },
      get innerHTML() {
        return this.html;
      },
      contains: (n) => n === node || n?.slot === node,
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      },
    };
    return node;
  };
  const nodes = Object.fromEntries(['app', 'conn', 'tabs', 'body', 'err'].map((id) => [id, el(id)]));
  const calls = [];
  const document = {
    activeElement: null,
    getElementById: (id) => nodes[id] ?? null,
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  };
  const ctx = {
    document,
    ensoUI: { tooltip() {} },
    setInterval: () => 0,
    setTimeout,
    console,
  };
  ctx.window = ctx;
  ctx.enso = {
    call: async (method, args) => {
      calls.push(JSON.parse(JSON.stringify({ method, args })));
      return responder(method, args);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await settle();
  const fire = (type, event = {}) => (listeners[type] ?? []).forEach((fn) => fn(event));
  const click = (dataset) => {
    let stopped = false;
    const btn = { dataset, hasAttribute: () => false };
    nodes.app.listeners.click.forEach((fn) => fn({ target: { closest: (sel) => (sel.includes('.rt-toggle') ? null : btn) }, stopPropagation: () => (stopped = true) }));
    return { stopped: () => stopped };
  };
  const writes = () => Object.fromEntries(['conn', 'tabs', 'body', 'err'].map((id) => [id, nodes[id].writes]));
  return { ctx, nodes, calls, document, fire, click, writes };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

const baseView = (patch = {}) => ({
  configured: true,
  bot: { username: 'enso_bot', name: 'Enso', readsAll: true },
  tokenHint: '12345…abcd',
  sessionId: 's1',
  routes: [
    {
      key: '-100',
      chatId: '-100',
      chatType: 'supergroup',
      title: '群',
      sessionId: 's1',
      session: '主线',
      whitelistMode: 'inherit',
      allow: [],
      requests: [{ id: 8, name: 'Bob' }],
      context: 0,
    },
  ],
  knownChats: [],
  sessions: [{ id: 's1', title: '主线', kind: 'normal' }],
  globalAllow: [],
  admins: [{ id: 7, name: '@al' }],
  adminCandidates: [{ id: 55, name: '@carol' }],
  ...patch,
});

test('run()：无变化的轮询不重绘任何插槽，也不清掉用户操作的错误', async () => {
  let current = baseView();
  const ui = await mount(async (method) => {
    if (method === 'pair') throw new Error('配对失败了');
    return current;
  });
  const first = ui.writes();
  assert.ok(first.conn >= 1 && first.tabs >= 1 && first.body >= 1);
  await ui.ctx.run('state');
  await ui.ctx.run('state');
  assert.deepEqual(ui.writes(), first, '每 1.5s 的相同轮询不碰 DOM');
  assert.doesNotMatch(ui.nodes.conn.html + ui.nodes.body.html, /ui-enter/, '不再有随重绘重放的入场动画');

  await ui.ctx.run('pair');
  assert.match(ui.nodes.err.html, /配对失败了/);
  const afterErr = ui.writes();
  await ui.ctx.run('state');
  assert.match(ui.nodes.err.html, /配对失败了/, '轮询不静默清除错误');
  assert.deepEqual(ui.writes(), afterErr);

  // 真实状态变化：只重写变化的插槽
  current = baseView({ routes: [{ ...current.routes[0], title: '改名的群' }] });
  await ui.ctx.run('state');
  const w = ui.writes();
  assert.equal(w.body, afterErr.body + 1);
  assert.equal(w.conn, afterErr.conn);
  assert.equal(w.tabs, afterErr.tabs);
  assert.match(ui.nodes.body.html, /改名的群/);
});

test('轮询失败的错误在下一次成功轮询后清掉', async () => {
  let fail = false;
  const ui = await mount(async () => {
    if (fail) throw new Error('宿主忙');
    return baseView();
  });
  fail = true;
  await ui.ctx.run('state');
  assert.match(ui.nodes.err.html, /宿主忙/);
  fail = false;
  await ui.ctx.run('state');
  assert.equal(ui.nodes.err.html, '');
});

test('正在输入时只推迟所在插槽；focusout 后只刷新 #body，tab 按钮不被重建', async () => {
  let current = baseView();
  const ui = await mount(async () => current);
  const before = ui.writes();
  ui.document.activeElement = { tagName: 'INPUT', slot: ui.nodes.body };
  current = baseView({ routes: [{ ...current.routes[0], title: '新名字' }] });
  await ui.ctx.run('state');
  assert.deepEqual(ui.writes(), before, '焦点所在的 #body 推迟重绘');
  // 用户去点 tab：mousedown 让输入框失焦，focusout 的延时刷新只能动 #body
  ui.fire('pointerdown', { target: { slot: ui.nodes.tabs } });
  ui.document.activeElement = null;
  ui.fire('focusout');
  await settle();
  const after = ui.writes();
  assert.equal(after.body, before.body + 1);
  assert.equal(after.tabs, before.tabs, '#tabs 没被重写，第一次点击不会被吞');
  assert.equal(after.conn, before.conn);
  ui.fire('pointerup');
  ui.click({ tab: 'whitelist' });
  assert.match(ui.nodes.tabs.html, /class="tab on" data-tab="whitelist"/);
  assert.match(ui.nodes.body.html, /管理员（可信）/);
});

test('按下中的插槽等松开后再重绘', async () => {
  let current = baseView();
  const ui = await mount(async () => current);
  const before = ui.writes();
  ui.fire('pointerdown', { target: { slot: ui.nodes.body } });
  current = baseView({ routes: [{ ...current.routes[0], title: 'X' }] });
  await ui.ctx.run('state');
  assert.equal(ui.writes().body, before.body);
  ui.fire('pointerup');
  await settle();
  assert.equal(ui.writes().body, before.body + 1);
});

test('路由卡片：头部会话标签可跳转且不触发折叠；展开态标签与下拉框分列不折行', async () => {
  const ui = await mount(async () => baseView());
  assert.match(ui.nodes.body.html, /class="sess-chip" data-focus="s1"[^>]*>主线 ↗/);
  const res = ui.click({ focus: 's1' });
  await settle();
  assert.equal(res.stopped(), true);
  assert.deepEqual(ui.calls.at(-1), { method: 'focus', args: { sessionId: 's1' } });
  assert.doesNotMatch(ui.nodes.body.html, /class="body"/, '没有误展开');
  ui.click({ toggle: '-100' });
  const body = ui.nodes.body.html;
  assert.match(body, /<div class="field-row"><span class="lbl">目标会话<\/span>/);
  assert.match(body, /<div class="field-row"><span class="lbl">白名单<\/span>/);
  assert.match(body, /data-focus="s1"[^>]*>跳转 ↗/);
  assert.match(body, /class="row wrap"/);
});

test('「绑定当前」三态：无当前会话禁用、已绑当前禁用、不同会话可点并发 bindCurrent', async () => {
  const button = (html) => html.match(/<span class="tip" data-tip="([^"]*)"><button [^>]*data-bind-current="-100"[^>]*>([^<]*)<\/button>/);
  const sessions = [{ id: 's1', title: '主线', kind: 'normal' }, { id: 's2', title: 'Greeting', kind: 'normal' }];
  let current = baseView({ sessionId: null });
  const ui = await mount(async (method) => current);
  ui.click({ toggle: '-100' });

  let b = button(ui.nodes.body.html);
  assert.ok(b, '目标会话行有「绑定当前」按钮');
  assert.equal(b[1], '先在主界面打开一个会话');
  assert.match(b[0], / disabled>/);

  current = baseView({ sessionId: 's1', sessions });
  await ui.ctx.run('state');
  b = button(ui.nodes.body.html);
  assert.equal(b[1], '已经绑定到当前会话');
  assert.equal(b[2], '已绑当前');
  assert.match(b[0], / disabled>/);

  current = baseView({ sessionId: 's2', sessions });
  await ui.ctx.run('state');
  b = button(ui.nodes.body.html);
  assert.equal(b[1], '改绑到当前会话：Greeting');
  assert.equal(b[2], '绑定当前');
  assert.doesNotMatch(b[0], /disabled/);
  ui.click({ bindCurrent: '-100' });
  await settle();
  assert.deepEqual(ui.calls.at(-1), { method: 'route', args: { key: '-100', patch: { bindCurrent: true } } });

  // 当前会话不在列表里（拿不到标题）也能改绑
  current = baseView({ sessionId: 's9', sessions });
  await ui.ctx.run('state');
  assert.equal(button(ui.nodes.body.html)[1], '改绑到当前会话');
});

test('跳转失败把中文提示显示出来', async () => {
  const ui = await mount(async (method) => {
    if (method === 'focus') throw new Error('跳转失败：这个会话不在当前窗口');
    return baseView();
  });
  ui.click({ focus: 's1' });
  await settle();
  assert.match(ui.nodes.err.html, /不在当前窗口/);
});

test('配对卡片有标题与取消按钮，取消后恢复「＋ 配对绑定」', async () => {
  let current = baseView({ pairing: { code: '969203', link: 'https://t.me/enso_bot?start=969203', groupLink: 'https://t.me/enso_bot?startgroup=969203' } });
  const ui = await mount(async (method) => {
    if (method === 'cancelPair') current = baseView();
    return current;
  });
  assert.match(ui.nodes.body.html, /<h3>配对绑定<\/h3>/);
  assert.match(ui.nodes.body.html, /data-cancel-pair="969203"/);
  ui.click({ cancelPair: '969203' });
  await settle();
  assert.deepEqual(ui.calls.at(-1), { method: 'cancelPair', args: { code: '969203' } });
  assert.doesNotMatch(ui.nodes.body.html, /969203/);
  assert.match(ui.nodes.body.html, /＋ 配对绑定/);
});

test('权限页：区分管理员与普通白名单，待批准可分别批准', async () => {
  const ui = await mount(async () => baseView());
  ui.click({ tab: 'whitelist' });
  const body = ui.nodes.body.html;
  assert.match(body, /管理员（可信）/);
  assert.match(body, /全局白名单（普通用户，不可信）/);
  assert.match(body, /data-approve="-100\|8">批准为普通用户/);
  assert.match(body, /data-approve-admin="-100\|8">批准为管理员/);
  assert.match(body, /data-mkadmin="55\|@carol"/);
  ui.click({ approveAdmin: '-100|8' });
  await settle();
  assert.deepEqual(ui.calls.at(-1), { method: 'approve', args: { key: '-100', userId: 8, on: true, asAdmin: true } });
  ui.click({ unadmin: '7' });
  await settle();
  assert.deepEqual(ui.calls.at(-1), { method: 'admin', args: { userId: 7, on: false } });
});

test('用户操作不会因为轮询在途而被吞掉', async () => {
  let release;
  const ui = await mount(async (method) => {
    if (method === 'state') await new Promise((r) => (release = r));
    return baseView();
  });
  void ui.ctx.run('state');
  ui.click({ approve: '-100|8' });
  await settle();
  assert.ok(ui.calls.some((c) => c.method === 'approve'));
  release();
});

test('头部路由开关：切换不误触折叠，发 route 补丁；静音时加 muted 与「已静音」', async () => {
  let current = baseView();
  const ui = await mount(async (method, args) => {
    if (method === 'route') current = baseView({ routes: [{ ...current.routes[0], enabled: args.patch.enabled }] });
    return current;
  });
  assert.match(ui.nodes.body.html, /<label class="rt-toggle" data-tip="开启\/暂停这条路由（关掉即暂时静音，停止收发消息）"><input type="checkbox" class="ui-switch" data-route="enabled" data-key="-100" checked\/>/);
  // 点开关：根监听排除 .rt-toggle，不会展开卡片
  let stopped = false;
  const label = { dataset: {} };
  ui.nodes.app.listeners.click.forEach((fn) =>
    fn({ target: { closest: (sel) => (sel.includes('.rt-toggle') ? label : { dataset: { toggle: '-100' }, hasAttribute: () => false }) }, stopPropagation: () => (stopped = true) })
  );
  assert.equal(stopped, true);
  assert.doesNotMatch(ui.nodes.body.html, /class="body"/, '没有被展开');
  // change 事件提交开关
  ui.document.activeElement = { tagName: 'INPUT', type: 'checkbox', slot: ui.nodes.body };
  ui.nodes.app.listeners.change.forEach((fn) => fn({ target: { dataset: { route: 'enabled', key: '-100' }, type: 'checkbox', checked: false } }));
  await settle();
  assert.deepEqual(ui.calls.at(-1), { method: 'route', args: { key: '-100', patch: { enabled: false } } });
  assert.match(ui.nodes.body.html, /class="rt muted"/, '复选框聚焦也立即重绘');
  assert.match(ui.nodes.body.html, /已静音/);
  assert.doesNotMatch(ui.nodes.body.html, /data-route="enabled" data-key="-100" checked/);
});
