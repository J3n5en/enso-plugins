import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

function matchSimple(el, sel) {
  if (sel.startsWith('.')) {
    const end = sel.indexOf('[');
    const cls = sel.slice(1, end === -1 ? undefined : end);
    if (!el.className.split(/\s+/).includes(cls)) return false;
    sel = end === -1 ? '' : sel.slice(end);
  } else if (/^[a-z]+/i.test(sel)) {
    const tag = /^[a-z]+/i.exec(sel)[0];
    if (el.tagName !== tag.toUpperCase()) return false;
    sel = sel.slice(tag.length);
  }
  while (sel.startsWith('[')) {
    const found = /^\[([^\]=~|^$*]+)(?:([~|^$*]?=)"([^"]*)")?\]/.exec(sel);
    if (!found) return false;
    const [, name, op, value] = found;
    if (op == null) {
      if (!el.attributes.has(name)) return false;
    } else if (op !== '=' || el.attributes.get(name) !== value) return false;
    sel = sel.slice(found[0].length);
  }
  return sel === '';
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.textContent = '';
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.id = '';
    this.offsetWidth = 0;
    this.offsetLeft = 0;
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        this.className = [...set].join(' ');
      },
      remove() {},
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null || typeof node !== 'object') continue;
      node.parentElement = this;
      this.children.push(node);
    }
    this.relayout();
  }

  prepend(node) {
    node.parentElement = this;
    this.children.unshift(node);
    this.relayout();
  }

  replaceChildren(...nodes) {
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }

  relayout() {
    if (!this.className.split(/\s+/).includes('ui-seg')) return;
    let x = 2;
    for (const child of this.children) {
      if (child.tagName !== 'BUTTON') continue;
      child.offsetWidth = 28 + [...(child.textContent || '')].length * 12;
      child.offsetLeft = x;
      x += child.offsetWidth;
    }
  }

  querySelectorAll(selector) {
    const out = [];
    for (const part of selector.split(',').map((item) => item.trim()).filter(Boolean)) {
      if (part.startsWith(':scope > ')) {
        const simple = part.slice(':scope > '.length);
        for (const child of this.children) if (matchSimple(child, simple)) out.push(child);
      } else {
        const all = [];
        visitInto(this, all);
        for (const node of all) if (matchSimple(node, part)) out.push(node);
      }
    }
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  click() {
    this.onclick?.();
  }
}

function visitInto(node, all) {
  for (const child of node.children) {
    all.push(child);
    visitInto(child, all);
  }
}

function mount() {
  const frames = [];
  const listeners = {};
  const observers = [];
  const documentElement = new El('html');
  const body = new El('body');
  const root = new El('div');
  root.id = 'root';
  documentElement.append(body);
  body.append(root);
  const document = {
    documentElement,
    getElementById(id) {
      const all = [];
      visitInto(documentElement, all);
      return all.find((node) => node.id === id) ?? null;
    },
    createElement(tag) {
      return new El(tag);
    },
  };
  const sandbox = {
    document,
    listeners,
    observers,
    frames,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(join(pkg, 'enso-ui.js'), 'utf8'), context, { filename: 'enso-ui.js' });
  runInContext(readFileSync(join(pkg, 'trajectory.js'), 'utf8'), context, { filename: 'trajectory.js' });
  while (frames.length) frames.shift()();
  const seg = root.querySelector('.ui-seg');
  const buttons = seg.querySelectorAll(':scope > button');
  const indicator = () => seg.querySelector(':scope > .ui-seg-indicator');
  return { sandbox, seg, buttons, indicator, listeners, observers };
}

function at(button) {
  return { transform: `translateX(${button.offsetLeft}px)`, width: `${button.offsetWidth}px` };
}

test('切换五个筛选标签时白块跟到当前按钮', () => {
  const { buttons, indicator } = mount();
  const labels = buttons.map((button) => button.textContent);
  assert.deepEqual(labels, ['全部', '用户', '模型', '工具', '子代理']);
  assert.equal(indicator().style.transform, at(buttons[0]).transform);
  assert.equal(indicator().style.width, at(buttons[0]).width);

  const order = [2, 4, 1, 3, 0, 4, 2, 2];
  for (const index of order) {
    buttons[index].click();
    const pill = indicator();
    assert.equal(pill.style.transform, at(buttons[index]).transform, labels[index]);
    assert.equal(pill.style.width, at(buttons[index]).width, labels[index]);
    assert.equal(pill.getAttribute('aria-pressed'), null);
    for (const [i, button] of buttons.entries()) {
      assert.equal(button.getAttribute('aria-pressed'), i === index ? 'true' : 'false');
    }
  }
});

test('侧栏缩放和尺寸观察都会按当前按钮重算白块', () => {
  const { buttons, indicator, listeners, observers } = mount();
  buttons[3].click();
  const button = buttons[3];
  button.offsetLeft = 140;
  button.offsetWidth = 72;
  for (const listener of listeners.resize) listener();
  assert.equal(indicator().style.transform, 'translateX(140px)');
  assert.equal(indicator().style.width, '72px');

  button.offsetLeft = 96;
  button.offsetWidth = 48;
  assert.equal(observers.length, 1);
  observers[0].callback();
  assert.equal(indicator().style.transform, 'translateX(96px)');
  assert.equal(indicator().style.width, '48px');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});
