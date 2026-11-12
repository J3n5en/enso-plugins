/*
 * 雷霆战机：固定步长的竖版射击。
 * 模拟和绘制都在这个文件里，侧栏页面用普通脚本引入，不依赖网络和宿主进程。
 */
(function (root) {
  'use strict';

  const STEP = 1 / 60;
  const PATTERNS = {
    1: [{ a: 0, ox: 0 }],
    2: [
      { a: 0, ox: -5 },
      { a: 0, ox: 5 },
    ],
    3: [
      { a: -0.2, ox: 0 },
      { a: 0, ox: 0 },
      { a: 0.2, ox: 0 },
    ],
    4: [
      { a: -0.36, ox: -1 },
      { a: -0.14, ox: 0 },
      { a: 0, ox: 0 },
      { a: 0.14, ox: 0 },
      { a: 0.36, ox: 1 },
    ],
  };
  const KIND = {
    scout: { hp: 1, r: 8, score: 100, vy: 1, shoot: 2.05, scale: 0.78, color: '#fb7185', accent: '#ffe4e6' },
    dart: { hp: 2, r: 10, score: 180, vy: 0.92, shoot: 1.6, scale: 0.96, color: '#fb923c', accent: '#ffedd5' },
    gunner: { hp: 3, r: 13, score: 420, vy: 0.5, shoot: 1.28, scale: 1.16, color: '#c084fc', accent: '#f3e8ff' },
    boss: { hp: 24, r: 20, score: 2400, vy: 1, shoot: 0.9, scale: 1.62, color: '#f43f5e', accent: '#fde68a' },
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeStars(width, height, rng) {
    const stars = [];
    for (let layer = 0; layer < 3; layer += 1) {
      const count = 16 + layer * 8;
      for (let i = 0; i < count; i += 1) {
        stars.push({
          x: rng() * width,
          y: rng() * height,
          z: layer,
          s: 0.6 + layer * 0.45,
        });
      }
    }
    return stars;
  }

  function makeClouds(width, height, rng) {
    const clouds = [];
    for (let i = 0; i < 5; i += 1) {
      clouds.push({
        x: rng() * width,
        y: rng() * height,
        w: 26 + rng() * 40,
        h: 7 + rng() * 6,
        v: 8 + rng() * 12,
        a: 0.035 + rng() * 0.04,
      });
    }
    return clouds;
  }

  function createMatch(options) {
    const opts = options || {};
    const width = Math.max(140, opts.width || 200);
    const height = Math.max(220, opts.height || 360);
    const seed = (opts.seed ?? 1) >>> 0;
    const rng = mulberry32(seed);
    const best = Math.max(0, Math.floor(Number(opts.best) || 0));
    return {
      width,
      height,
      seed,
      rng,
      mode: 'ready',
      time: 0,
      score: 0,
      best,
      bestAtStart: best,
      lives: 3,
      wave: 1,
      combo: 0,
      comboLeft: 0,
      weapon: 1,
      rapid: 0,
      shield: false,
      bombs: 1,
      cooldown: 0,
      invuln: 0,
      shake: 0,
      flash: 0,
      muzzle: 0,
      shots: 0,
      killed: 0,
      between: 0,
      banner: '',
      bannerT: 0,
      autoFire: opts.autoFire !== false,
      acc: 0,
      nextId: 1,
      player: { x: width / 2, y: height - 42, r: 6.5 },
      bullets: [],
      foes: [],
      drops: [],
      fx: [],
      pops: [],
      queue: [],
      stars: makeStars(width, height, rng),
      clouds: makeClouds(width, height, rng),
    };
  }

  function specFor(type, wave) {
    const base = KIND[type] || KIND.scout;
    const cruise = Math.min(132, 54 + (wave - 1) * 4);
    let hp = base.hp;
    if (type === 'gunner') hp += Math.floor((wave - 1) / 3);
    if (type === 'boss') hp += wave * 3;
    return {
      hp,
      r: base.r,
      score: base.score,
      vy: type === 'boss' ? 34 : cruise * base.vy,
      shoot: base.shoot / (1 + (wave - 1) * 0.055),
      scale: base.scale,
      color: base.color,
      accent: base.accent,
    };
  }

  function planWave(wave, width, rng) {
    const entries = [];
    if (wave % 5 === 0) {
      entries.push({ type: 'boss', x: width / 2, delay: 0.45 });
      entries.push({ type: 'scout', x: width * 0.26, delay: 0.15 });
      entries.push({ type: 'scout', x: width * 0.74, delay: 0.15 });
      return entries;
    }
    const count = Math.min(12, 4 + wave);
    const pattern = (wave - 1) % 4;
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      let x;
      if (pattern === 0) x = width * (0.16 + 0.68 * t);
      else if (pattern === 1) x = width * (0.5 + Math.sin(i * 1.15) * 0.3);
      else if (pattern === 2) x = width * (i % 2 ? 0.76 : 0.24);
      else x = width * (0.18 + ((i * 0.618) % 1) * 0.64);
      x = clamp(x + (rng() - 0.5) * 8, 18, width - 18);
      let type = 'scout';
      const roll = rng();
      if (wave >= 3 && roll > 0.82) type = 'gunner';
      else if (wave >= 2 && roll > 0.48) type = 'dart';
      entries.push({ type, x, delay: 0.22 + 0.32 * i });
    }
    return entries;
  }

  function beginWave(state) {
    state.queue = planWave(state.wave, state.width, state.rng);
    state.banner = state.wave % 5 === 0 ? '首领 · 第 ' + state.wave + ' 波' : '第 ' + state.wave + ' 波';
    state.bannerT = 1.6;
  }

function verticalUnit(state) {
  return state.height / 360;
}

function layout(state, cssW, cssH) {
  if (!(cssW > 2) || !(cssH > 2)) return;
  const height = clamp(Math.round(200 * (cssH / cssW)), 280, 640);
  if (Math.abs(height - state.height) < 4) return;
  const sy = height / state.height;
  const scaleY = (obj) => {
    if (!obj) return;
    obj.y *= sy;
    if (typeof obj.vy === 'number') obj.vy *= sy;
  };
  scaleY(state.player);
  for (const list of [state.bullets, state.foes, state.drops, state.fx, state.pops, state.stars, state.clouds]) {
    for (const item of list) scaleY(item);
  }
  for (const bullet of state.bullets) if (typeof bullet.vx === 'number') bullet.vx *= sy;
  for (const cloud of state.clouds) cloud.v *= sy;
  state.height = height;
  state.player.y = clamp(state.player.y, 16, height - 32);
}

function spawnFoe(state, type, x, y) {
  const spec = specFor(type, state.wave);
  const foe = {
    id: state.nextId,
    type,
    x: clamp(x, spec.r, state.width - spec.r),
    y,
    r: spec.r,
    hp: spec.hp,
    maxHp: spec.hp,
    score: spec.score,
    vy: spec.vy * verticalUnit(state),
      vx: type === 'scout' ? (state.rng() - 0.5) * 28 : 0,
      phase: state.rng() * Math.PI * 2,
      shoot: spec.shoot * (0.55 + state.rng() * 0.35),
      shootEvery: spec.shoot,
      scale: spec.scale,
      color: spec.color,
      accent: spec.accent,
      t: 0,
      hit: 0,
      spin: state.rng() * Math.PI * 2,
      aim: 1.1,
      dead: false,
    };
    state.nextId += 1;
    state.foes.push(foe);
    return foe;
  }

  function reset(state, mode) {
    const next = createMatch({
      width: state.width,
      height: state.height,
      best: Math.max(state.best, state.score),
      autoFire: state.autoFire,
      seed: (state.seed + 997) >>> 0,
    });
    if (mode === 'playing') {
      next.mode = 'playing';
      beginWave(next);
    }
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  }

  function gain(state, amount, x, y) {
    state.score += amount;
    if (state.score > state.best) state.best = state.score;
    popText(state, x, y, '+' + amount);
  }

  function popText(state, x, y, text) {
    state.pops.push({ x, y, text: String(text), life: 0.7, max: 0.7 });
    if (state.pops.length > 10) state.pops.shift();
  }

  function burst(state, x, y, color, count) {
    for (let i = 0; i < count; i += 1) {
      const angle = state.rng() * Math.PI * 2;
      const speed = 26 + state.rng() * 100;
      state.fx.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.28 + state.rng() * 0.32,
        max: 0.6,
        color,
        r: 1.1 + state.rng() * 1.5,
      });
    }
    if (state.fx.length > 120) state.fx.splice(0, state.fx.length - 120);
  }

  function pickKind(rng) {
    const roll = rng();
    if (roll < 0.4) return 'weapon';
    if (roll < 0.65) return 'rapid';
    if (roll < 0.83) return 'shield';
    if (roll < 0.95) return 'bomb';
    return 'life';
  }

  function dropFor(state, foe) {
    const chance = { scout: 0.12, dart: 0.2, gunner: 0.34, boss: 1 };
    const rolls = foe.type === 'boss' ? 2 : 1;
    for (let i = 0; i < rolls; i += 1) {
      if (state.rng() > (chance[foe.type] ?? 0.1)) continue;
      state.drops.push({
        x: foe.x + (i ? 14 : 0),
        y: foe.y,
        vy: 46 * verticalUnit(state),
        r: 9,
        kind: pickKind(state.rng),
        t: 0,
        phase: state.rng() * 6,
        dead: false,
      });
    }
  }

  function killFoe(state, foe) {
    if (foe.dead) return;
    foe.dead = true;
    state.killed += 1;
    state.combo += 1;
    state.comboLeft = 2.3;
    const gained = foe.score * Math.min(6, state.combo);
    state.score += gained;
    if (state.score > state.best) state.best = state.score;
    popText(state, foe.x, foe.y, '+' + gained);
    burst(state, foe.x, foe.y, foe.color, foe.type === 'boss' ? 24 : 11);
    dropFor(state, foe);
  }

  function grant(state, kind) {
    const x = state.player.x;
    const y = state.player.y - 18;
    if (kind === 'weapon') {
      if (state.weapon < 4) {
        state.weapon += 1;
        popText(state, x, y, 'W' + state.weapon);
      } else gain(state, 500, x, y);
      return;
    }
    if (kind === 'rapid') {
      state.rapid = Math.min(12, state.rapid + 8);
      popText(state, x, y, 'R');
      return;
    }
    if (kind === 'shield') {
      if (!state.shield) {
        state.shield = true;
        popText(state, x, y, 'S');
      } else gain(state, 300, x, y);
      return;
    }
    if (kind === 'bomb') {
      if (state.bombs < 3) {
        state.bombs += 1;
        popText(state, x, y, 'B');
      } else gain(state, 400, x, y);
      return;
    }
    if (kind === 'life') {
      if (state.lives < 5) {
        state.lives += 1;
        popText(state, x, y, '+1');
      } else gain(state, 800, x, y);
    }
  }

  function hurt(state) {
    if (state.invuln > 0 || state.mode !== 'playing') return;
    burst(state, state.player.x, state.player.y, '#7dd3fc', 16);
    state.shake = 7;
    state.combo = 0;
    state.comboLeft = 0;
    for (const bullet of state.bullets) if (!bullet.friendly) bullet.dead = true;
    if (state.shield) {
      state.shield = false;
      state.invuln = 0.75;
      popText(state, state.player.x, state.player.y - 16, 'S');
      return;
    }
    state.lives -= 1;
    state.weapon = Math.max(1, state.weapon - 1);
    state.rapid = 0;
    if (state.lives <= 0) {
      state.lives = 0;
      state.mode = 'over';
      state.bannerT = 0;
      return;
    }
    state.invuln = 1.7;
    state.player.x = state.width / 2;
    state.player.y = state.height - 42;
  }

  function detonate(state) {
    if (state.mode !== 'playing' || state.bombs <= 0) return;
    state.bombs -= 1;
    state.flash = 0.28;
    state.shake = 8;
    for (const foe of state.foes) {
      if (foe.dead) continue;
      foe.hp -= foe.type === 'boss' ? 8 : foe.hp;
      foe.hit = 0.12;
      if (foe.hp <= 0) killFoe(state, foe);
    }
    for (const bullet of state.bullets) if (!bullet.friendly) bullet.dead = true;
    burst(state, state.player.x, state.player.y, '#fde68a', 18);
  }

  function enemyBullet(state, foe, angle, speed, color) {
    let hostile = 0;
    for (const bullet of state.bullets) if (!bullet.friendly) hostile += 1;
    if (hostile >= 36) return;
    const scaled = speed * verticalUnit(state);
    state.bullets.push({
      x: foe.x + Math.sin(angle) * foe.r * 0.35,
      y: foe.y + Math.cos(angle) * foe.r * 0.45,
      vx: Math.sin(angle) * scaled,
      vy: Math.cos(angle) * scaled,
      r: foe.type === 'boss' ? 3.3 : 2.9,
      friendly: false,
      dmg: 1,
      color,
      dead: false,
    });
  }

  function aimAt(from, to) {
    return Math.atan2(to.x - from.x, to.y - from.y);
  }

  function fireBoss(state, foe) {
    const ratio = foe.hp / foe.maxHp;
    if (ratio > 0.62) {
      foe.shoot = foe.shootEvery;
      const angle = aimAt(foe, state.player);
      for (const offset of [-0.24, 0, 0.24]) enemyBullet(state, foe, angle + offset, 148, '#fb7185');
      return;
    }
    if (ratio > 0.3) {
      foe.shoot = 1.1;
      const spin = foe.t * 0.7;
      for (let i = 0; i < 11; i += 1) {
        enemyBullet(state, foe, spin + (i / 11) * Math.PI * 2, 92, '#fb7185');
      }
      return;
    }
    foe.shoot = 0.12;
    foe.spin += 0.42;
    enemyBullet(state, foe, foe.spin, 126, '#fda4af');
    enemyBullet(state, foe, foe.spin + Math.PI, 126, '#fda4af');
    foe.aim -= 0.12;
    if (foe.aim <= 0) {
      foe.aim = 1.05;
      const angle = aimAt(foe, state.player);
      for (const offset of [-0.16, 0, 0.16]) enemyBullet(state, foe, angle + offset, 166, '#fecdd3');
    }
  }

  function fireFoe(state, foe) {
    if (foe.type === 'boss') {
      fireBoss(state, foe);
      return;
    }
    foe.shoot = foe.shootEvery;
    if (foe.type === 'dart') {
      enemyBullet(state, foe, -0.36, 136, '#fdba74');
      enemyBullet(state, foe, 0.36, 136, '#fdba74');
      return;
    }
    if (foe.type === 'gunner') {
      const angle = aimAt(foe, state.player);
      for (const offset of [-0.18, 0, 0.18]) enemyBullet(state, foe, angle + offset, 146, '#e9d5ff');
      return;
    }
    enemyBullet(state, foe, 0, 124, '#fda4af');
  }

  function moveFoe(state, foe, dt) {
    foe.t += dt;
    foe.hit = Math.max(0, foe.hit - dt);
    foe.shoot -= dt;
    const hover = state.height * (foe.type === 'boss' ? 0.2 : 0.24);
    if (foe.type === 'boss' || foe.type === 'gunner') {
      if (foe.y < hover) foe.y += foe.vy * dt;
      else {
        foe.y = hover + Math.sin(foe.t * 1.5 + foe.phase) * (foe.type === 'boss' ? 8 : 5);
        foe.x += Math.cos(foe.t * (foe.type === 'boss' ? 0.7 : 1.15) + foe.phase) * (foe.type === 'boss' ? 28 : 18) * dt;
      }
    } else if (foe.type === 'dart') {
      foe.y += foe.vy * dt;
      foe.x += Math.sin(foe.t * 2.5 + foe.phase) * 62 * dt;
    } else {
      foe.y += foe.vy * dt;
      foe.x += foe.vx * dt;
    }
    if (foe.x < foe.r) {
      foe.x = foe.r;
      foe.vx = Math.abs(foe.vx);
    } else if (foe.x > state.width - foe.r) {
      foe.x = state.width - foe.r;
      foe.vx = -Math.abs(foe.vx);
    }
    if (foe.type !== 'boss' && foe.type !== 'gunner' && foe.y > state.height + 26) foe.dead = true;
    if (foe.shoot <= 0 && foe.t > 0.4 && foe.y > 8 && foe.y < state.height * 0.8) fireFoe(state, foe);
  }

  function movePlayer(state, input, dt) {
    const player = state.player;
    const minX = 12;
    const maxX = state.width - 12;
    const minY = 16;
    const maxY = state.height - 32;
    const pointer = input.pointer;
    if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      const targetX = clamp(pointer.x, minX, maxX);
      const targetY = clamp(pointer.y - 34 * verticalUnit(state), minY, maxY);
      const k = 1 - Math.exp(-16 * dt);
      player.x += (targetX - player.x) * k;
      player.y += (targetY - player.y) * k;
    } else {
      let ax = clamp(Number(input.ax) || 0, -1, 1);
      let ay = clamp(Number(input.ay) || 0, -1, 1);
      const mag = Math.hypot(ax, ay);
      if (mag > 1) {
        ax /= mag;
        ay /= mag;
      }
      player.x += ax * 170 * dt;
      player.y += ay * 170 * verticalUnit(state) * dt;
    }
    player.x = clamp(player.x, minX, maxX);
    player.y = clamp(player.y, minY, maxY);
  }

  function tryFire(state, input, dt) {
    state.cooldown -= dt;
    if (!(state.autoFire || input.fire) || state.cooldown > 0) return;
    const pattern = PATTERNS[state.weapon] || PATTERNS[1];
    let friendly = 0;
    for (const bullet of state.bullets) if (bullet.friendly) friendly += 1;
    if (friendly >= 46) {
      state.cooldown = 0.05;
      return;
    }
    const speed = 440 * verticalUnit(state);
    for (const shot of pattern) {
      state.bullets.push({
        x: state.player.x + shot.ox,
        y: state.player.y - 14,
        vx: Math.sin(shot.a) * speed,
        vy: -Math.cos(shot.a) * speed,
        r: 2.6,
        friendly: true,
        dmg: 1,
        dead: false,
      });
    }
    state.shots += pattern.length;
    state.cooldown = state.rapid > 0 ? 0.08 : 0.15;
    state.muzzle = 0.05;
  }

  function overlaps(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const reach = a.r + b.r;
    return dx * dx + dy * dy <= reach * reach;
  }

  function moveDrops(state, dt) {
    for (const drop of state.drops) {
      drop.t += dt;
      drop.y += drop.vy * dt;
      drop.x += Math.sin(drop.t * 2 + drop.phase) * 10 * dt;
      drop.x = clamp(drop.x, 10, state.width - 10);
      if (overlaps(drop, state.player)) {
        drop.dead = true;
        grant(state, drop.kind);
      }
    }
  }

  function collide(state) {
    const player = state.player;
    for (const bullet of state.bullets) {
      if (bullet.dead || !bullet.friendly) continue;
      for (const foe of state.foes) {
        if (foe.dead || foe.hp <= 0) continue;
        if (!overlaps(bullet, foe)) continue;
        bullet.dead = true;
        foe.hp -= bullet.dmg;
        foe.hit = 0.08;
        if (foe.hp <= 0) killFoe(state, foe);
        break;
      }
    }
    if (state.invuln > 0) return;
    for (const bullet of state.bullets) {
      if (bullet.dead || bullet.friendly) continue;
      if (!overlaps(bullet, player)) continue;
      bullet.dead = true;
      hurt(state);
      return;
    }
    for (const foe of state.foes) {
      if (foe.dead) continue;
      if (!overlaps(foe, player)) continue;
      foe.hp -= 2;
      foe.hit = 0.1;
      if (foe.hp <= 0) killFoe(state, foe);
      hurt(state);
      return;
    }
  }

  function driftScenery(state, dt) {
    for (const star of state.stars) {
      star.y += (14 + star.z * 24) * dt;
      if (star.y > state.height) {
        star.y = 0;
        star.x = state.rng() * state.width;
      }
    }
    for (const cloud of state.clouds) {
      cloud.y += cloud.v * dt;
      if (cloud.y - cloud.h > state.height) {
        cloud.y = -cloud.h;
        cloud.x = state.rng() * state.width;
      }
    }
  }

  function spawnQueued(state, dt) {
    const keep = [];
    for (const item of state.queue) {
      item.delay -= dt;
      if (item.delay > 0 || state.foes.length >= 12) {
        if (item.delay <= 0) item.delay = 0.3;
        keep.push(item);
        continue;
      }
      spawnFoe(state, item.type, item.x, -22);
    }
    state.queue = keep;
  }

  function stepFx(state, dt) {
    for (const spark of state.fx) {
      spark.life -= dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vy += 18 * dt;
    }
    for (const pop of state.pops) {
      pop.life -= dt;
      pop.y -= 18 * dt;
    }
  }

  function cleanup(state) {
    const width = state.width;
    const height = state.height;
    state.foes = state.foes.filter((foe) => !foe.dead && foe.y <= height + 40);
    state.bullets = state.bullets.filter(
      (bullet) => !bullet.dead && bullet.x > -24 && bullet.x < width + 24 && bullet.y > -36 && bullet.y < height + 30,
    );
    state.drops = state.drops.filter((drop) => !drop.dead && drop.y < height + 16);
    state.fx = state.fx.filter((spark) => spark.life > 0);
    state.pops = state.pops.filter((pop) => pop.life > 0);
  }

  function simulate(state, input, dt) {
    state.time += dt;
    state.bannerT = Math.max(0, state.bannerT - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.muzzle = Math.max(0, state.muzzle - dt);
    state.shake = Math.max(0, state.shake - dt * 22);
    state.invuln = Math.max(0, state.invuln - dt);
    state.rapid = Math.max(0, state.rapid - dt);
    if (state.comboLeft > 0) {
      state.comboLeft -= dt;
      if (state.comboLeft <= 0) {
        state.comboLeft = 0;
        state.combo = 0;
      }
    }
    driftScenery(state, dt);
    spawnQueued(state, dt);
    movePlayer(state, input, dt);
    tryFire(state, input, dt);
    for (const bullet of state.bullets) {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
    }
    for (const foe of state.foes) moveFoe(state, foe, dt);
    moveDrops(state, dt);
    stepFx(state, dt);
    collide(state);
    cleanup(state);
    if (state.mode === 'playing' && state.queue.length === 0 && state.foes.length === 0) {
      state.between += dt;
      if (state.between >= 1.15) {
        const bonus = 120 * state.wave;
        gain(state, bonus, state.width / 2, state.height * 0.38);
        state.wave += 1;
        state.between = 0;
        beginWave(state);
      }
    } else state.between = 0;
  }

  function applyEdges(state, input) {
    if (typeof input.auto === 'boolean') state.autoFire = input.auto;
    if (input.restart) {
      reset(state, 'playing');
      return;
    }
    if (input.start) {
      if (state.mode === 'over') reset(state, 'playing');
      else if (state.mode === 'ready') {
        state.mode = 'playing';
        beginWave(state);
      } else if (state.mode === 'paused') state.mode = 'playing';
    }
    if (input.pause) {
      if (state.mode === 'playing') state.mode = 'paused';
      else if (state.mode === 'paused') state.mode = 'playing';
    }
    if (input.bomb) detonate(state);
  }

  function update(state, input, dt) {
    applyEdges(state, input || {});
    const clamped = Math.max(0, Math.min(Number(dt) || 0, 0.1));
    state.acc += clamped;
    let steps = 0;
    while (state.acc >= STEP && steps < 6) {
      state.acc -= STEP;
      steps += 1;
      if (state.mode === 'playing') simulate(state, input || {}, STEP);
      else driftScenery(state, STEP * 0.4);
    }
    if (steps === 6 && state.acc > STEP) state.acc = 0;
    return state;
  }

  function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function traceJet(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.quadraticCurveTo(3.2, -6, 2.6, 0);
    ctx.lineTo(13, 7);
    ctx.lineTo(13, 10);
    ctx.lineTo(3, 6.5);
    ctx.lineTo(2.4, 12);
    ctx.lineTo(6.5, 15);
    ctx.lineTo(0, 11);
    ctx.lineTo(-6.5, 15);
    ctx.lineTo(-2.4, 12);
    ctx.lineTo(-3, 6.5);
    ctx.lineTo(-13, 10);
    ctx.lineTo(-13, 7);
    ctx.lineTo(-2.6, 0);
    ctx.quadraticCurveTo(-3.2, -6, 0, -15);
    ctx.closePath();
  }

  function drawJet(ctx, x, y, rot, scale, fill, accent, flame) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    if (flame > 0.2) {
      ctx.fillStyle = '#fdba74';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(-2.3, 11);
      ctx.lineTo(0, 11 + flame);
      ctx.lineTo(2.3, 11);
      ctx.fill();
      ctx.fillStyle = '#fff7ed';
      ctx.beginPath();
      ctx.moveTo(-1.2, 11);
      ctx.lineTo(0, 11 + flame * 0.55);
      ctx.lineTo(1.2, 11);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = fill;
    traceJet(ctx);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(2.1, -2);
    ctx.lineTo(-2.1, -2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(0, -4, 1.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw(ctx, state) {
    const canvas = ctx.canvas;
    if (!canvas || canvas.width < 1 || canvas.height < 1 || !state) return;
    const viewW = canvas.width;
    const viewH = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    const backdrop = ctx.createLinearGradient(0, 0, 0, viewH);
    backdrop.addColorStop(0, '#090e1c');
    backdrop.addColorStop(0.55, '#121836');
    backdrop.addColorStop(1, '#1c1230');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, viewW, viewH);

    const scale = Math.min(viewW / state.width, viewH / state.height);
    const ox = (viewW - state.width * scale) / 2;
    const oy = (viewH - state.height * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    if (state.shake > 0.4 && !reducedMotion()) {
      ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
    }

    for (const cloud of state.clouds) {
      ctx.fillStyle = 'rgba(186, 210, 255,' + cloud.a + ')';
      ctx.beginPath();
      ctx.ellipse(cloud.x, cloud.y, cloud.w, cloud.h, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const star of state.stars) {
      const alpha = 0.35 + star.z * 0.22;
      ctx.fillStyle = 'rgba(226, 232, 240,' + alpha + ')';
      ctx.fillRect(star.x, star.y, star.s, star.s);
    }
    for (const drop of state.drops) drawDrop(ctx, state, drop);
    for (const bullet of state.bullets) drawBullet(ctx, state, bullet);
    for (const foe of state.foes) drawFoe(ctx, state, foe);
    drawPlayer(ctx, state);
    for (const spark of state.fx) {
      const alpha = Math.max(0, spark.life / spark.max);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = spark.color;
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, spark.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pop of state.pops) {
      ctx.globalAlpha = Math.max(0, pop.life / pop.max);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 8px sans-serif';
      ctx.fillText(pop.text, pop.x, pop.y);
      ctx.globalAlpha = 1;
    }
    if (state.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (state.flash / 0.28) * 0.38 + ')';
      ctx.fillRect(-8, -8, state.width + 16, state.height + 16);
    }
    if (state.mode === 'playing' && state.lives === 1) {
      ctx.strokeStyle = 'rgba(244,63,94,' + (0.28 + 0.22 * Math.sin(state.time * 6)) + ')';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, state.width - 2, state.height - 2);
    }
  }

  function drawBullet(ctx, state, bullet) {
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    if (bullet.friendly) {
      ctx.rotate(Math.atan2(bullet.vx, -bullet.vy));
      ctx.fillStyle = state.rapid > 0 ? '#fde68a' : '#e0f2fe';
      ctx.beginPath();
      ctx.ellipse(0, 0, 2.1, 5.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = bullet.color || '#fb7185';
      ctx.beginPath();
      ctx.arc(0, 0, bullet.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(0, 0, bullet.r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDrop(ctx, state, drop) {
    const colors = { weapon: '#38bdf8', rapid: '#fbbf24', shield: '#4ade80', bomb: '#f87171', life: '#fb7185' };
    const letters = { weapon: 'W', rapid: 'R', shield: 'S', bomb: 'B', life: '+' };
    const pulse = 8.2 + Math.sin(state.time * 5 + drop.phase) * 0.8;
    ctx.save();
    ctx.translate(drop.x, drop.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = colors[drop.kind] || '#e2e8f0';
    ctx.fillRect(-pulse / 2, -pulse / 2, pulse, pulse);
    ctx.restore();
    ctx.fillStyle = '#0f172a';
    ctx.font = '700 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letters[drop.kind] || '?', drop.x, drop.y);
  }

  function drawFoe(ctx, state, foe) {
    const flame = 6 + Math.sin(state.time * 32 + foe.phase) * 2;
    const fill = foe.hit > 0 ? '#fff' : foe.color;
    drawJet(ctx, foe.x, foe.y, Math.PI, foe.scale, fill, foe.accent, flame);
    if (foe.type === 'boss' || foe.type === 'gunner') {
      const width = foe.type === 'boss' ? 28 : 16;
      const ratio = clamp(foe.hp / foe.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(15,23,42,0.7)';
      ctx.fillRect(foe.x - width / 2, foe.y - foe.r - 7, width, 2.4);
      ctx.fillStyle = foe.color;
      ctx.fillRect(foe.x - width / 2, foe.y - foe.r - 7, width * ratio, 2.4);
    }
  }

  function drawPlayer(ctx, state) {
    const player = state.player;
    if (state.invuln > 0 && Math.floor(state.time * 14) % 2 === 0) return;
    const flame = 7 + state.muzzle * 30 + Math.sin(state.time * 36) * 1.6;
    drawJet(ctx, player.x, player.y, 0, 1, '#7dd3fc', '#e0f2fe', Math.max(4, flame));
    if (state.shield) {
      ctx.save();
      ctx.strokeStyle = '#86efac';
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(state.time * 6);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function boot() {
    const canvas = document.getElementById('cv');
    const stage = document.getElementById('stage');
    if (!canvas || !stage) return;
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const bestEl = document.getElementById('best');
    const waveEl = document.getElementById('wave');
    const livesEl = document.getElementById('lives');
    const pipsEl = document.getElementById('pips');
    const rapidEl = document.getElementById('rapid');
    const shieldEl = document.getElementById('shield');
    const comboEl = document.getElementById('combo');
    const bannerEl = document.getElementById('banner');
    const overlay = document.getElementById('overlay');
    const ovTitle = document.getElementById('ov-title');
    const ovText = document.getElementById('ov-text');
    const ovHelp = document.getElementById('ov-help');
    const ovGo = document.getElementById('ov-go');
    const btnFire = document.getElementById('btn-fire');
    const btnBomb = document.getElementById('btn-bomb');
    const btnPause = document.getElementById('btn-pause');
    const btnRestart = document.getElementById('btn-restart');
    const autoEl = document.getElementById('auto');

    const storageGet = (key) => {
      try {
        return window.enso?.storage?.get(key) ?? null;
      } catch {
        return null;
      }
    };
    const storageSet = (key, value) => {
      try {
        window.enso?.storage?.set(key, value);
      } catch {
        /* 页面存储写失败时这局仍然能玩 */
      }
    };
    const savedBest = Number(storageGet('best'));
    const best = Number.isFinite(savedBest) && savedBest > 0 ? Math.floor(savedBest) : 0;
    const savedAuto = storageGet('auto');
    const autoFire = savedAuto == null ? true : savedAuto === '1';
    autoEl.checked = autoFire;

    const state = createMatch({
      best,
      autoFire,
      seed: (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0,
    });
    let storedBest = state.best;
    const held = new Set();
    const edges = { pause: false, bomb: false, start: false, restart: false };
    let fireHold = false;
    let pointing = false;
    let pointer = null;
    let overlayMode = '';

    const applyTheme = (theme) => {
      document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    };
    applyTheme(window.enso?.theme || document.documentElement.dataset.theme || 'light');
    try {
      window.enso?.onTheme?.(applyTheme);
    } catch {
      /* 主题订阅失败时沿用当前颜色 */
    }

    const fmt = (value) => Math.max(0, Math.floor(value)).toLocaleString('zh-CN');
    const keyOf = (event) => (event.code === 'Space' || event.key === ' ' ? 'space' : String(event.key || '').toLowerCase());
    const GAME_KEYS = new Set([
      'arrowup',
      'arrowdown',
      'arrowleft',
      'arrowright',
      'w',
      'a',
      's',
      'd',
      'space',
      'p',
      'b',
      'enter',
    ]);

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      layout(state, rect.width, rect.height);
    }

    function toWorld(event) {
      const rect = canvas.getBoundingClientRect();
      const px = ((event.clientX - rect.left) * canvas.width) / Math.max(1, rect.width);
      const py = ((event.clientY - rect.top) * canvas.height) / Math.max(1, rect.height);
      const scale = Math.min(canvas.width / state.width, canvas.height / state.height);
      const ox = (canvas.width - state.width * scale) / 2;
      const oy = (canvas.height - state.height * scale) / 2;
      return {
        x: clamp((px - ox) / scale, 0, state.width),
        y: clamp((py - oy) / scale, 0, state.height),
      };
    }

    function readInput() {
      const left = held.has('arrowleft') || held.has('a');
      const right = held.has('arrowright') || held.has('d');
      const up = held.has('arrowup') || held.has('w');
      const down = held.has('arrowdown') || held.has('s');
      const input = {
        ax: (right ? 1 : 0) - (left ? 1 : 0),
        ay: (down ? 1 : 0) - (up ? 1 : 0),
        fire: state.mode === 'playing' && (held.has('space') || fireHold),
        auto: autoEl.checked,
        pause: edges.pause,
        bomb: edges.bomb,
        start: edges.start,
        restart: edges.restart,
      };
      if (pointing && pointer) input.pointer = pointer;
      edges.pause = false;
      edges.bomb = false;
      edges.start = false;
      edges.restart = false;
      return input;
    }

    function setText(el, text) {
      if (el.textContent !== text) el.textContent = text;
    }

    function syncHud() {
      const score = fmt(state.score);
      if (scoreEl.dataset.raw !== score) {
        scoreEl.dataset.raw = score;
        if (window.ensoUI && window.ensoUI.swap) window.ensoUI.swap(scoreEl, score);
        else scoreEl.textContent = score;
      }
      setText(bestEl, '最高 ' + fmt(state.best));
      setText(waveEl, state.wave % 5 === 0 ? '首领 ' + state.wave : '第 ' + state.wave + ' 波');
      const hearts = '♥'.repeat(Math.max(0, state.lives));
      setText(livesEl, hearts);
      livesEl.setAttribute('aria-label', '生命 ' + state.lives);
      if (pipsEl.children.length !== 4) {
        pipsEl.replaceChildren();
        for (let i = 0; i < 4; i += 1) pipsEl.append(document.createElement('i'));
      }
      for (let i = 0; i < 4; i += 1) pipsEl.children[i].className = i < state.weapon ? 'on' : '';
      rapidEl.hidden = state.rapid <= 0;
      shieldEl.hidden = !state.shield;
      setText(comboEl, state.combo >= 2 ? '连击 ' + state.combo : '');
      if (state.bannerT > 0 && state.mode === 'playing') {
        bannerEl.hidden = false;
        setText(bannerEl, state.banner);
        const fade = Math.min(1, state.bannerT < 0.35 ? state.bannerT / 0.35 : 1);
        bannerEl.style.opacity = String(fade);
      } else bannerEl.hidden = true;
      btnFire.disabled = state.mode !== 'playing';
      btnBomb.disabled = state.mode !== 'playing' || state.bombs <= 0;
      setText(btnBomb, '炸弹 ' + state.bombs);
      btnPause.disabled = state.mode === 'ready' || state.mode === 'over';
      setText(btnPause, state.mode === 'paused' ? '继续' : '暂停');
      if (state.best > storedBest) {
        storedBest = state.best;
        storageSet('best', String(state.best));
      }
      syncOverlay();
    }

    function syncOverlay() {
      const show = state.mode !== 'playing';
      if (!show) {
        overlay.hidden = true;
        overlayMode = 'playing';
        return;
      }
      if (overlayMode === state.mode && !overlay.hidden) return;
      overlayMode = state.mode;
      overlay.hidden = false;
      ovHelp.hidden = state.mode !== 'ready';
      if (state.mode === 'ready') {
        setText(ovTitle, '雷霆战机');
        setText(ovText, '从下往上打。躲开弹幕，接住掉落的道具，每五波有一架首领。');
        setText(ovGo, '开始');
      } else if (state.mode === 'paused') {
        setText(ovTitle, '已暂停');
        setText(ovText, '画面停住了。准备好了再继续。');
        setText(ovGo, '继续');
      } else {
        setText(ovTitle, state.score > state.bestAtStart ? '新纪录' : '游戏结束');
        setText(
          ovText,
          '本局 ' + fmt(state.score) + ' · 最高 ' + fmt(state.best) + ' · 第 ' + state.wave + ' 波 · 击落 ' + state.killed,
        );
        setText(ovGo, '再来一局');
      }
    }

    window.addEventListener('keydown', (event) => {
      const key = keyOf(event);
      if (!GAME_KEYS.has(key)) return;
      event.preventDefault();
      if (event.repeat) {
        held.add(key);
        return;
      }
      held.add(key);
      if (key === 'p') edges.pause = true;
      if (key === 'b') edges.bomb = true;
      if (key === 'enter' || (key === 'space' && state.mode !== 'playing')) edges.start = true;
    });
    window.addEventListener('keyup', (event) => held.delete(keyOf(event)));
    window.addEventListener('blur', () => {
      held.clear();
      pointing = false;
      pointer = null;
      fireHold = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.mode === 'playing') edges.pause = true;
    });

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture?.(event.pointerId);
      pointing = true;
      pointer = toWorld(event);
      canvas.focus({ preventScroll: true });
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!pointing) return;
      pointer = toWorld(event);
    });
    const endPoint = () => {
      pointing = false;
      pointer = null;
    };
    canvas.addEventListener('pointerup', endPoint);
    canvas.addEventListener('pointercancel', endPoint);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    const hold = (el, down, up) => {
      el.addEventListener('pointerdown', (event) => {
        if (el.disabled) return;
        event.preventDefault();
        el.setPointerCapture?.(event.pointerId);
        down();
      });
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold(
      btnFire,
      () => {
        fireHold = true;
      },
      () => {
        fireHold = false;
      },
    );
    btnBomb.addEventListener('click', () => {
      edges.bomb = true;
    });
    btnPause.addEventListener('click', () => {
      edges.pause = true;
    });
    btnRestart.addEventListener('click', () => {
      edges.restart = true;
    });
    ovGo.addEventListener('click', () => {
      edges.start = true;
      canvas.focus({ preventScroll: true });
    });
    autoEl.addEventListener('change', () => {
      storageSet('auto', autoEl.checked ? '1' : '0');
    });

    if (window.ensoUI && window.ensoUI.tooltip) window.ensoUI.tooltip();
    new ResizeObserver(() => resizeCanvas()).observe(stage);
    resizeCanvas();
    canvas.focus({ preventScroll: true });

    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      resizeCanvas();
      update(state, readInput(), dt);
      resizeCanvas();
      draw(ctx, state);
      syncHud();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  root.Skyfighter = { createMatch, update, planWave, spawnFoe, draw, layout, mulberry32 };

  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('cv')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
