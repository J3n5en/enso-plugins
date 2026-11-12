import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const code = readFileSync(fileURLToPath(new URL('../game.js', import.meta.url)), 'utf8');
const sandbox = { console, Math, Number, Object, Array, String, performance: { now: () => 0 } };
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(code, sandbox, { filename: 'game.js' });
const { createMatch, update, planWave, spawnFoe, draw, layout, mulberry32 } = sandbox.Skyfighter;

function frames(state, count, input) {
  for (let i = 0; i < count; i += 1) update(state, input, 1 / 60);
}

function playing(options) {
  const state = createMatch({ autoFire: false, seed: 1, ...options });
  update(state, { start: true }, 0);
  return state;
}

function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy(
    { canvas: { width: 400, height: 720 } },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
        if (prop === 'measureText') return () => ({ width: 8 });
        return () => {};
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

test('键盘把战机推向边界并停住', () => {
  const state = playing();
  frames(state, 180, { ax: -1 });
  assert.ok(state.player.x >= 12 && state.player.x <= 13);
  frames(state, 180, { ay: -1 });
  assert.ok(state.player.y >= 16 && state.player.y <= 17);
});

test('指针把战机拉到手指上方', () => {
  const state = playing();
  frames(state, 45, { pointer: { x: 36, y: 140 } });
  assert.ok(Math.abs(state.player.x - 36) < 1);
  assert.ok(Math.abs(state.player.y - 106) < 1);
});

test('自动射击与手动射击', () => {
  const quiet = playing({ autoFire: false });
  frames(quiet, 40, {});
  assert.equal(quiet.shots, 0);
  frames(quiet, 40, { fire: true });
  assert.ok(quiet.shots > 0);
  assert.ok(quiet.bullets.filter((bullet) => bullet.friendly).every((bullet) => bullet.vy < 0));

  const auto = playing({ autoFire: true });
  frames(auto, 40, {});
  assert.ok(auto.shots > 0);
});

test('射速道具让同样时间内打出更多子弹', () => {
  const count = (rapid) => {
    const state = playing({ autoFire: true, seed: 2 });
    state.queue = [];
    state.foes = [];
    state.shots = 0;
    for (let i = 0; i < 60; i += 1) {
      state.queue = [];
      state.foes = [];
      state.invuln = 5;
      if (rapid) state.rapid = 10;
      update(state, {}, 1 / 60);
    }
    return state.shots;
  };
  assert.ok(count(true) > count(false));
});

test('玩家子弹击落侦察机并记 100 分', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.bullets = [];
  state.score = 0;
  const foe = spawnFoe(state, 'scout', state.player.x, state.player.y - 40);
  state.bullets.push({ x: foe.x, y: foe.y, vx: 0, vy: 0, r: 3, friendly: true, dmg: 1, dead: false });
  update(state, {}, 1 / 60);
  assert.equal(state.score, 100);
  assert.equal(state.killed, 1);
  assert.equal(state.foes.length, 0);
});

test('连续击落提高倍率', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.bullets = [];
  state.score = 0;
  for (let i = 0; i < 3; i += 1) {
    const foe = spawnFoe(state, 'scout', 40 + i * 30, 80);
    foe.hp = 1;
    state.bullets.push({ x: foe.x, y: foe.y, vx: 0, vy: 0, r: 3, friendly: true, dmg: 1, dead: false });
    update(state, {}, 1 / 60);
  }
  assert.equal(state.score, 100 + 200 + 300);
  assert.equal(state.combo, 3);
});

test('受击掉命并降低火力，最后一命结束对局', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.weapon = 3;
  state.lives = 2;
  state.invuln = 0;
  state.bullets = [{ x: state.player.x, y: state.player.y, vx: 0, vy: 0, r: 4, friendly: false, dmg: 1, dead: false }];
  update(state, {}, 1 / 60);
  assert.equal(state.mode, 'playing');
  assert.equal(state.lives, 1);
  assert.equal(state.weapon, 2);
  assert.ok(state.invuln > 0);

  state.invuln = 0;
  state.lives = 1;
  state.bullets = [{ x: state.player.x, y: state.player.y, vx: 0, vy: 0, r: 4, friendly: false, dmg: 1, dead: false }];
  update(state, {}, 1 / 60);
  assert.equal(state.mode, 'over');
  assert.equal(state.lives, 0);
});

test('护盾抵消一次命中', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.shield = true;
  state.lives = 3;
  state.invuln = 0;
  state.bullets = [{ x: state.player.x, y: state.player.y, vx: 0, vy: 0, r: 4, friendly: false, dmg: 1, dead: false }];
  update(state, {}, 1 / 60);
  assert.equal(state.lives, 3);
  assert.equal(state.shield, false);
  assert.equal(state.mode, 'playing');
  assert.ok(state.invuln > 0);
});

test('炸弹清掉敌机和敌弹', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.bullets = [];
  state.bombs = 1;
  state.score = 0;
  spawnFoe(state, 'scout', 40, 40);
  spawnFoe(state, 'dart', 80, 50);
  state.bullets.push({ x: 20, y: 20, vx: 0, vy: 20, r: 3, friendly: false, dmg: 1, dead: false });
  update(state, { bomb: true }, 1 / 60);
  assert.equal(state.bombs, 0);
  assert.equal(state.foes.length, 0);
  assert.equal(state.bullets.filter((bullet) => !bullet.friendly).length, 0);
  assert.ok(state.score >= 100);
});

test('吃到火力道具升档', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.weapon = 1;
  state.drops.push({ x: state.player.x, y: state.player.y, vy: 0, r: 10, kind: 'weapon', t: 0, phase: 0, dead: false });
  update(state, {}, 1 / 60);
  assert.equal(state.weapon, 2);
});

test('暂停冻结敌机，继续后恢复', () => {
  const state = playing();
  state.queue = [];
  const foe = spawnFoe(state, 'scout', 100, 80);
  const y = foe.y;
  update(state, { pause: true }, 1 / 60);
  assert.equal(state.mode, 'paused');
  frames(state, 20, {});
  assert.equal(state.foes[0].y, y);
  update(state, { pause: true }, 1 / 60);
  assert.equal(state.mode, 'playing');
  frames(state, 10, {});
  assert.ok(state.foes[0].y > y);
});

test('清空战场后进入下一波并发放波次奖励', () => {
  const state = playing();
  state.queue = [];
  state.foes = [];
  state.score = 0;
  state.between = 0;
  frames(state, 80, {});
  assert.equal(state.wave, 2);
  assert.ok(state.score >= 120);
  assert.ok(state.queue.length > 0);
});

test('重开保留最高分并回到满状态', () => {
  const state = playing({ best: 400 });
  state.score = 500;
  state.lives = 1;
  update(state, { restart: true }, 0);
  assert.equal(state.mode, 'playing');
  assert.equal(state.score, 0);
  assert.equal(state.best, 500);
  assert.equal(state.lives, 3);
  assert.equal(state.weapon, 1);
});

test('同一随机种子走出同一局', () => {
  const play = () => {
    const state = playing({ seed: 11, autoFire: true });
    frames(state, 180, { ax: 1 });
    return { score: state.score, x: state.player.x, wave: state.wave, killed: state.killed, shots: state.shots };
  };
  assert.deepEqual(play(), play());
});

test('波次计划落在画面内，第 5 波才有首领', () => {
  const first = planWave(1, 200, mulberry32(1));
  const again = planWave(1, 200, mulberry32(1));
  assert.deepEqual(first, again);
  assert.ok(first.length >= 4);
  assert.ok(first.every((entry) => entry.type !== 'boss' && entry.x >= 16 && entry.x <= 184));
  assert.ok(planWave(5, 200, mulberry32(2)).some((entry) => entry.type === 'boss'));
  for (const wave of [2, 3, 4, 6, 8]) {
    for (const entry of planWave(wave, 200, mulberry32(wave + 3))) {
      assert.ok(entry.x >= 16 && entry.x <= 184);
      assert.ok(entry.delay >= 0);
    }
  }
});

test('长时间自动战斗实体数量有上限', () => {
  const state = playing({ seed: 7, autoFire: true });
  for (let i = 0; i < 20 * 60; i += 1) {
    const ax = Math.sin(i / 18) > 0 ? 1 : -1;
    const ay = Math.cos(i / 27) > 0 ? -1 : 1;
    update(state, { ax, ay }, 1 / 60);
    assert.ok(Number.isFinite(state.player.x) && Number.isFinite(state.player.y));
    assert.ok(state.bullets.length < 90);
    assert.ok(state.foes.length <= 12);
    assert.ok(state.fx.length <= 120);
    assert.ok(state.mode === 'playing' || state.mode === 'over');
  }
});

test('无敌时能打出分数', () => {
  const state = playing({ seed: 3, autoFire: true });
  for (let i = 0; i < 8 * 60; i += 1) {
    state.invuln = 30;
    update(state, {}, 1 / 60);
  }
  assert.ok(state.killed > 0);
  assert.ok(state.score > 0);
});

test('战场高度跟着侧栏比例变，战机仍贴在底部', () => {
  const state = playing();
  const before = state.player.y / state.height;
  layout(state, 200, 480);
  assert.equal(state.height, 480);
  assert.ok(Math.abs(state.player.y / state.height - before) < 0.02);
  layout(state, 0, 0);
  assert.equal(state.height, 480);
});

test('绘制开局、战斗、首领和结束画面不抛错', () => {
  const ctx = mockCtx();
  const state = playing({ seed: 4, autoFire: true });
  draw(ctx, state);
  frames(state, 90, {});
  spawnFoe(state, 'boss', 100, 70);
  state.drops.push({ x: 40, y: 80, vy: 10, r: 9, kind: 'shield', t: 0, phase: 1, dead: false });
  state.fx.push({ x: 10, y: 10, vx: 1, vy: 1, life: 0.2, max: 0.4, color: '#fff', r: 2 });
  state.pops.push({ x: 10, y: 10, text: '+100', life: 0.4, max: 0.7 });
  state.flash = 0.2;
  state.shield = true;
  draw(ctx, state);
  state.mode = 'over';
  state.lives = 1;
  draw(ctx, state);
});
