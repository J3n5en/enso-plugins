import { pickSavedAppState } from './scene.mjs';

function snapshot(scene) {
  const plain = {
    format: scene.format,
    elements: scene.elements ?? [],
    appState: pickSavedAppState(scene.appState),
    files: scene.files ?? {},
    source: scene.source,
    svg: scene.svg ?? null,
    error: scene.error,
    json: scene.json,
  };
  try {
    return structuredClone(plain);
  } catch {
    return JSON.parse(JSON.stringify(plain));
  }
}

/**
 * 把画布和 `enso.file` 对齐。
 * 自己 `update` 的内容宿主不会回调；外部改动（编辑器、磁盘重新加载）会进来。
 * 画布有未写出的修改时，和外部版本按元素合并，再交回编辑区。
 */
export function createBufferSync({ file, decode, encode, merge, apply, delay = 250 }) {
  let rel = file.rel;
  let lastSent = file.text;
  let base = null;
  let current = null;
  let dirty = false;
  let epoch = 0;
  let timer = null;
  const ready = decode(rel, file.text).then((scene) => {
    base = snapshot(scene);
    if (!dirty) current = base;
    return base;
  });

  const write = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !current || current.error) return;
    const mine = epoch;
    const scene = snapshot(current);
    let text;
    try {
      text = await encode(rel, scene);
    } catch {
      return;
    }
    if (mine !== epoch || !dirty) return;
    base = scene;
    dirty = false;
    if (text === lastSent) return;
    lastSent = text;
    file.update(text);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, delay);
  };

  const noteEdit = (scene) => {
    current = scene;
    dirty = true;
    epoch += 1;
    schedule();
  };

  const off = file.onChange((next) => {
    void (async () => {
      await ready;
      if (next.text === lastSent && next.rel === rel) return;
      rel = next.rel;
      epoch += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const outside = await decode(rel, next.text);
      if (!dirty) {
        base = snapshot(outside);
        current = base;
        lastSent = next.text;
        apply(outside, 'external');
        return;
      }
      const merged = merge(base, outside, current);
      current = snapshot(merged);
      base = current;
      dirty = false;
      const mine = epoch;
      apply(merged, 'merge');
      let text = next.text;
      if (!merged?.error) {
        try {
          text = await encode(rel, current);
        } catch {
          text = next.text;
        }
      }
      // 编码期间又有编辑或新的外部改动时，这次写回作废，交给后面的那次。
      if (mine !== epoch) return;
      if (text !== next.text) {
        lastSent = text;
        file.update(text);
      } else {
        lastSent = next.text;
      }
    })();
  });

  return {
    /** 首屏场景。打开期间文件若已变，以回调为准。 */
    ready,
    noteEdit,
    flush: write,
    dispose() {
      off();
      epoch += 1;
      if (timer) clearTimeout(timer);
    },
  };
}
