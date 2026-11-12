/*
 * enso-ui.js —— 插件面板共享的交互动效，配合 enso-ui.css 使用。
 * 源文件在仓库 shared/enso-ui.js，用 node scripts/sync-ui.mjs 复制进各插件目录。
 *
 * window.ensoUI：
 *   fill(host)              HoverFill：host 下带 [data-fill] 的子元素共享一块跟随平移的 hover 背景
 *   tooltip()               全局 Tooltip：带 [data-tip] 的元素，首个延迟 300ms，之后在相邻元素间立即切换
 *   seg(el)                 Segmented：el 下 [aria-pressed|aria-selected=true] 的按钮由同一个 indicator 平移指示
 *   swap(el, text)          TextSwap：值变化时旧值上移淡出、新值自下而上
 *   leave(el)               删除动画：先淡出后收起，结束后移除节点，返回 Promise
 *   pop(el, trigger)        让 .ui-pop 从 trigger 的位置放大出现
 *   close(el, kind)         让 .ui-pop / .ui-overlay 收起（kind = 'confirm' 时向下离开），结束后移除，返回 Promise
 *   stagger(container)      给子元素写入 --i，配合 .ui-stagger 错落入场
 */
(() => {
  if (window.ensoUI) return;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function done(el) {
    return new Promise((resolve) => {
      if (reduced() || !el.getAnimations) return resolve();
      const anims = el.getAnimations();
      if (!anims.length) return resolve();
      Promise.allSettled(anims.map((a) => a.finished)).then(() => resolve());
    });
  }

  function fill(host) {
    if (!host || host._ensoFill) return;
    host._ensoFill = true;
    host.classList.add('ui-fill-host');
    const bg = document.createElement('span');
    bg.className = 'ui-fill-bg';
    bg.setAttribute('aria-hidden', 'true');
    host.prepend(bg);
    let current = null;
    let hideTimer = 0;
    const place = (target, event) => {
      // host 被 innerHTML 重绘后背景层会丢失，重新挂回去
      if (bg.parentElement !== host) {
        host.prepend(bg);
        current = null;
      }
      const hr = host.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const moving = current !== null;
      bg.toggleAttribute('data-moving', moving);
      if (!moving && event) {
        // 从鼠标进入的方位轻微放大
        bg.style.setProperty('--fill-ox', `${((event.clientX - r.left) / r.width) * 100}%`);
        bg.style.setProperty('--fill-oy', `${((event.clientY - r.top) / r.height) * 100}%`);
      }
      bg.style.width = `${r.width}px`;
      bg.style.height = `${r.height}px`;
      bg.style.translate = `${r.left - hr.left + host.scrollLeft}px ${r.top - hr.top + host.scrollTop}px`;
      bg.style.borderRadius = getComputedStyle(target).borderRadius;
      bg.setAttribute('data-on', '');
      current = target;
    };
    host.addEventListener('pointerover', (event) => {
      const target = event.target.closest?.('[data-fill]');
      if (!target || !host.contains(target) || target.parentElement?.closest('.ui-fill-host') !== host) return;
      clearTimeout(hideTimer);
      if (target !== current) place(target, event);
    });
    host.addEventListener('pointerleave', () => {
      bg.removeAttribute('data-on');
      hideTimer = setTimeout(() => {
        current = null;
        bg.removeAttribute('data-moving');
      }, 200);
    });
  }

  let tipEl = null;
  function tooltip() {
    if (tipEl) return;
    tipEl = document.createElement('div');
    tipEl.className = 'ui-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
    let showTimer = 0;
    let hideTimer = 0;
    let warm = false;
    let anchor = null;
    const show = (el) => {
      tipEl.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      const t = tipEl.getBoundingClientRect();
      let x = r.left + r.width / 2 - t.width / 2;
      x = Math.max(4, Math.min(x, innerWidth - t.width - 4));
      let y = r.top - t.height - 6;
      if (y < 4) y = r.bottom + 6;
      tipEl.toggleAttribute('data-moving', warm);
      tipEl.style.translate = `${x}px ${y}px`;
      tipEl.setAttribute('data-on', '');
      warm = true;
    };
    document.addEventListener('pointerover', (event) => {
      const el = event.target.closest?.('[data-tip]');
      if (!el || el === anchor) return;
      anchor = el;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (warm) show(el);
      else showTimer = setTimeout(() => show(el), 300);
    });
    document.addEventListener('pointerout', (event) => {
      const el = event.target.closest?.('[data-tip]');
      if (!el || el.contains(event.relatedTarget)) return;
      anchor = null;
      clearTimeout(showTimer);
      // 200ms 内移入相邻元素会复用同一个 tooltip
      hideTimer = setTimeout(() => {
        tipEl.removeAttribute('data-on');
        warm = false;
      }, 200);
    });
    document.addEventListener('pointerdown', () => {
      clearTimeout(showTimer);
      tipEl.removeAttribute('data-on');
      warm = false;
    });
  }

  function seg(el) {
    if (!el) return;
    let ind = el.querySelector(':scope > .ui-seg-indicator');
    const first = !ind;
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'ui-seg-indicator';
      ind.setAttribute('aria-hidden', 'true');
      el.prepend(ind);
    }
    const active = el.querySelector(':scope > button[aria-pressed="true"], :scope > button[aria-selected="true"]');
    if (!active) {
      ind.style.opacity = '0';
      return;
    }
    if (first) ind.style.transition = 'none';
    ind.style.opacity = '1';
    ind.style.width = `${active.offsetWidth}px`;
    ind.style.transform = `translateX(${active.offsetLeft}px)`;
    if (first) requestAnimationFrame(() => (ind.style.transition = ''));
  }

  function swap(el, text) {
    if (!el) return;
    text = String(text);
    if (el.dataset.value === text) return;
    const first = el.dataset.value === undefined;
    el.dataset.value = text;
    el.classList.add('ui-swap');
    if (first || reduced()) {
      el.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
      return;
    }
    for (const old of el.querySelectorAll(':scope > span[data-out]')) old.remove();
    const prev = el.querySelector(':scope > span:not([data-out])');
    if (prev) {
      prev.removeAttribute('data-in');
      prev.setAttribute('data-out', '');
      prev.addEventListener('animationend', () => prev.remove(), { once: true });
    }
    const next = document.createElement('span');
    next.textContent = text;
    next.setAttribute('data-in', '');
    el.append(next);
  }

  async function leave(el) {
    if (!el || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    el.style.setProperty('--h', `${el.offsetHeight}px`);
    el.classList.add('ui-leave');
    await done(el);
    el.remove();
  }

  function pop(el, trigger) {
    if (!el) return;
    if (trigger) {
      const t = trigger.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      el.style.setProperty('--origin-x', `${t.left + t.width / 2 - r.left}px`);
      el.style.setProperty('--origin-y', `${t.top + t.height / 2 - r.top}px`);
    }
  }

  async function close(el, kind) {
    if (!el || el.hasAttribute('data-leaving')) return;
    el.setAttribute('data-leaving', kind || '');
    await done(el);
    el.remove();
  }

  function stagger(container) {
    if (!container) return;
    [...container.children].forEach((child, i) => child.style.setProperty('--i', i));
  }

  window.ensoUI = { fill, tooltip, seg, swap, leave, pop, close, stagger };
})();
