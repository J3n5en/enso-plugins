// Excalidraw 场景的读写。SVG 里的嵌入格式与 Excalidraw 自己的 export 一致
// （payload-version 2、deflate、bstring），这样两边能互相打开。

export const SAVED_APP_STATE = ['viewBackgroundColor', 'gridModeEnabled', 'gridSize', 'gridStep'];

export const BLANK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="1" height="1" viewBox="0 0 1 1"></svg>';

const MIME = 'application/vnd.excalidraw+json';
const SVG_ROOT = /<svg\b[^>]*?(\/?)>/i;
const SVG_PAYLOAD = /<!--\s*payload-start\s*-->\s*([\s\S]+?)\s*<!--\s*payload-end\s*-->/;
const SVG_PAYLOAD_BLOCK =
  /<!--\s*payload-type:[\s\S]*?<!--\s*payload-end\s*-->/;
const SVG_EMPTY_METADATA = /<metadata\s*(?:\/>|>\s*<\/metadata>)/i;

export function formatOf(rel) {
  const name = String(rel ?? '').split('/').pop()?.toLowerCase() ?? '';
  return name.endsWith('.svg') ? 'svg' : 'json';
}

export function pickSavedAppState(appState = {}) {
  const out = {};
  for (const key of SAVED_APP_STATE) {
    if (key in appState) out[key] = appState[key];
  }
  return out;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toByteString(bytes) {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return text;
}

function fromByteString(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

async function deflateString(text) {
  const input = new TextEncoder().encode(text);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateToString(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function encodePayload(json) {
  const compressed = toByteString(await deflateString(json));
  return { version: '1', encoding: 'bstring', compressed: true, encoded: compressed };
}

async function decodePayload(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('嵌入的白板数据已损坏');
  }
  if (!data || typeof data !== 'object') throw new Error('嵌入的白板数据已损坏');
  if (!('encoded' in data)) {
    if (data.type === 'excalidraw') return json;
    throw new Error('嵌入的白板数据已损坏');
  }
  if (data.encoding !== 'bstring' || typeof data.encoded !== 'string') {
    throw new Error('嵌入的白板数据使用了无法识别的编码');
  }
  if (!data.compressed) return new TextDecoder().decode(fromByteString(data.encoded));
  try {
    return await inflateToString(fromByteString(data.encoded));
  } catch {
    throw new Error('嵌入的白板数据已损坏');
  }
}

/** 解析场景 JSON。空文件是空白白板。失败时抛出可读错误。 */
export function parseScene(text, subject = '这个文件') {
  const raw = stripBom(String(text ?? ''));
  let data;
  try {
    data = JSON.parse(raw.trim() === '' ? '{"type":"excalidraw"}' : raw);
  } catch (error) {
    throw new Error(`${subject}不是合法的 JSON（${error.message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== 'excalidraw') {
    throw new Error(`${subject}不是 Excalidraw 白板（需要 "type": "excalidraw"）`);
  }
  if (data.elements !== undefined && !Array.isArray(data.elements)) {
    throw new Error('"elements" 必须是数组');
  }
  return {
    elements: data.elements ?? [],
    appState: pickSavedAppState(data.appState),
    files: data.files && typeof data.files === 'object' ? data.files : {},
    source: typeof data.source === 'string' ? data.source : undefined,
  };
}

/** 把官方序列化结果里的 source 换回文件原来的值。 */
export function withSource(json, source) {
  if (typeof source !== 'string') return json;
  const data = JSON.parse(json);
  data.source = source;
  return JSON.stringify(data, null, 2);
}

function payloadComments(base64) {
  return (
    `<!-- payload-type:${MIME} -->` +
    `<!-- payload-version:2 -->` +
    `<!-- payload-start -->${base64}<!-- payload-end -->`
  );
}

/** 从一个 Excalidraw SVG 里取出场景 JSON。 */
export async function readSvgScene(svg) {
  if (!SVG_ROOT.test(svg)) throw new Error('这个文件不是 SVG');
  if (!svg.includes(`payload-type:${MIME}`)) {
    throw new Error('这个 SVG 没有嵌入白板。导出时需要打开 Embed scene');
  }
  const payload = SVG_PAYLOAD.exec(svg)?.[1]?.replace(/\s+/g, '');
  if (!payload) throw new Error('嵌入的白板数据已损坏');
  let json;
  try {
    json = atob(payload);
  } catch {
    throw new Error('嵌入的白板数据已损坏');
  }
  const version = /<!--\s*payload-version:(\d+)\s*-->/.exec(svg)?.[1] ?? '1';
  if (version === '1') json = new TextDecoder().decode(fromByteString(json));
  return decodePayload(json);
}

/** 用场景 JSON 替换 SVG 里已有的嵌入数据。 */
export async function embedSvgScene(svg, sceneJson) {
  const base64 = btoa(JSON.stringify(await encodePayload(sceneJson)));
  const block = payloadComments(base64);
  if (SVG_PAYLOAD_BLOCK.test(svg)) return svg.replace(SVG_PAYLOAD_BLOCK, () => block);
  if (SVG_EMPTY_METADATA.test(svg)) return svg.replace(SVG_EMPTY_METADATA, () => `<metadata>${block}</metadata>`);
  if (!SVG_ROOT.test(svg)) throw new Error('这个文件不是 SVG');
  return svg.replace(SVG_ROOT, (root, selfClosing) =>
    selfClosing ? `${root.slice(0, -2).trimEnd()}><metadata>${block}</metadata></svg>` : `${root}<metadata>${block}</metadata>`,
  );
}

function blank(format) {
  return {
    format,
    elements: [],
    appState: {},
    files: {},
    source: undefined,
    svg: null,
    error: undefined,
  };
}

function fromParts(format, parts, svg) {
  return { format, ...parts, svg: svg ?? null, error: undefined };
}

/**
 * 把查看器拿到的文本解成场景。`.svg` 读嵌入的白板；空文件是空白场景。
 * 打不开时返回 `{ error }`，不抛出。
 */
export async function decodeDocument(rel, text) {
  const format = formatOf(rel);
  const raw = stripBom(String(text ?? ''));
  try {
    if (format === 'svg') {
      if (raw.trim() === '') return blank('svg');
      if (/^\s*\{/.test(raw)) return fromParts('svg', parseScene(raw), null);
      const json = await readSvgScene(raw);
      return fromParts('svg', parseScene(json, '嵌入的白板'), raw);
    }
    return fromParts('json', parseScene(raw), null);
  } catch (error) {
    return { format, error: error instanceof Error ? error.message : String(error) };
  }
}

function plainJson(scene) {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: scene.source ?? 'https://excalidraw.com',
      elements: scene.elements ?? [],
      appState: pickSavedAppState(scene.appState),
      files: scene.files ?? {},
    },
    null,
    2,
  );
}

/** 把场景写回文件文本。`scene.json` 优先（官方序列化），否则用元素自己拼。 */
export async function encodeDocument(rel, scene) {
  const json = scene.json ?? plainJson(scene);
  if (formatOf(rel) !== 'svg') return json;
  const svg = typeof scene.svg === 'string' && SVG_ROOT.test(scene.svg) ? scene.svg : BLANK_SVG;
  return embedSvgScene(svg, json);
}

const live = (element) => (element && !element.isDeleted ? element : undefined);

function sameElement(left, right) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.version === right.version &&
      left.versionNonce === right.versionNonce)
  );
}

/**
 * 按元素 id 做三方合并：自上次同步以来画布改过的元素保留画布上的，其余用外部版本。
 * 背景色和网格同样按字段合并。任一侧打不开时采用外部版本。
 */
export function mergeScenes(base, outside, mine) {
  if (!base || base.error || !outside || outside.error || !mine || mine.error) return outside;
  const byId = (scene) => new Map((scene.elements ?? []).map((element) => [element.id, element]));
  const was = byId(base);
  const theirs = byId(outside);
  const ours = byId(mine);
  const elements = [];
  for (const id of new Set([...theirs.keys(), ...ours.keys()])) {
    const mineChanged = !sameElement(live(was.get(id)), live(ours.get(id)));
    const chosen = live(mineChanged ? ours.get(id) : theirs.get(id));
    if (chosen) elements.push(chosen);
  }
  const appState = { ...(outside.appState ?? {}) };
  for (const key of SAVED_APP_STATE) {
    if ((mine.appState ?? {})[key] !== (base.appState ?? {})[key]) appState[key] = mine.appState?.[key];
  }
  return {
    format: outside.format ?? mine.format,
    elements,
    appState,
    files: { ...(outside.files ?? {}), ...(mine.files ?? {}) },
    source: outside.source ?? mine.source,
    svg: outside.svg ?? null,
    error: undefined,
    json: undefined,
  };
}

/** 只有会进文件的内容变了才算一次编辑。选中、滚动和缩放不算。 */
export function sceneSignature(elements, appState, files) {
  const body = (elements ?? [])
    .filter((element) => element && !element.isDeleted)
    .map((element) => `${element.id}:${element.version}:${element.versionNonce}`)
    .join(',');
  const saved = SAVED_APP_STATE.map((key) => `${key}=${appState?.[key]}`).join(',');
  const ids = Object.keys(files ?? {}).sort().join(',');
  return `${body}|${saved}|${ids}`;
}
