import './dns-ipv4.mjs';
import { resolveCover } from './cover.mjs';
import { createLivePump } from './pump.mjs';
import { createRadioBrowser, DirectoryError } from './radioBrowser.mjs';
import { DEFAULT_REGION, REGIONS } from './regions.mjs';
import { mimeForCodec } from './station.mjs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {null | ReturnType<typeof createLivePump>} */
let pump = null;

function destroyPump() {
  if (pump) {
    pump.destroy();
    pump = null;
  }
}

function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url);
}

function codecFromUrl(url) {
  if (/\.aac(\?|#|$)/i.test(url)) return 'AAC';
  return 'MP3';
}

export function activate(enso) {
  const api = createRadioBrowser();
  /** @type {Map<string, import('./station.mjs').normalizeStation extends Function ? any : never>} */
  const cache = new Map();
  const streamUrls = new Map();

  const remember = (stations) => {
    for (const s of stations) cache.set(s.id, s);
  };

  const asDirectory = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DirectoryError) return { ok: false, error: err.message };
      console.warn('[box.radio]', err);
      return { ok: false, error: '电台目录暂时连不上，请稍后重试' };
    }
  };

  const asPlay = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      console.warn('[box.radio]', err);
      return { ok: false, error: '无法播放此电台' };
    }
  };

  enso.renderer.handle('discover', () =>
    asDirectory(async () => {
      const stations = await api.discover();
      remember(stations);
      api.prefetch();
      return { ok: true, stations };
    }),
  );

  enso.renderer.handle('search', (args) =>
    asDirectory(async () => {
      const q = String(args?.q ?? '').trim();
      if (!q) {
        const stations = await api.discover();
        remember(stations);
        return { ok: true, stations };
      }
      if (q.length > 80) return { ok: false, error: '没有找到电台' };
      const stations = await api.search(q);
      remember(stations);
      return { ok: true, stations };
    }),
  );

  enso.renderer.handle('regions', () => ({
    ok: true,
    defaultId: DEFAULT_REGION,
    regions: REGIONS.map((r) => ({ id: r.id, label: r.label })),
  }));

  enso.renderer.handle('byRegion', (args) =>
    asDirectory(async () => {
      const id = String(args?.id ?? DEFAULT_REGION).trim() || DEFAULT_REGION;
      const stations = await api.byRegion(id);
      remember(stations);
      return { ok: true, stations };
    }),
  );

  enso.renderer.handle('open', (args) =>
    asPlay(async () => {
      const id = String(args?.id ?? '').trim();
      if (!UUID_RE.test(id)) return { ok: false, error: '无法播放此电台' };
      const cached = cache.get(id);
      if (cached && !cached.playable) return { ok: false, reason: 'unsupported' };

      destroyPump();
      let url = streamUrls.get(id) || '';
      let name = cached?.name || '';
      if (!url) {
        try {
          const clicked = await api.click(id);
          url = clicked.url;
          name = clicked.name || name;
          if (url) streamUrls.set(id, url);
        } catch {
          /* 点台接口失败时再用列表里的地址 */
        }
        if (!url) url = cached?.streamUrl || '';
      }
      if (!url) return { ok: false, error: '无法播放此电台' };
      if (isHlsUrl(url) || (cached && cached.hls)) {
        return { ok: false, reason: 'unsupported' };
      }

      const codec = cached?.codec && cached.codec !== 'OTHER' ? cached.codec : codecFromUrl(url);
      const mime = mimeForCodec(codec);
      const next = createLivePump({
        id,
        url,
        mime,
        refreshUrl: async () => {
          try {
            const clicked = await api.click(id);
            if (clicked.url) {
              streamUrls.set(id, clicked.url);
              return clicked.url;
            }
          } catch {
            /* ignore */
          }
          return '';
        },
      });
      pump = next;
      const ok = await next.waitOpen();
      if (!ok || pump !== next) {
        next.destroy();
        if (pump === next) pump = null;
        return { ok: false, error: '无法播放此电台' };
      }
      return { ok: true, id, name, mime };
    }),
  );

  enso.renderer.handle('chunk', (args) => {
    const id = String(args?.id ?? '').trim();
    if (!pump || pump.id !== id) return { ok: false, reason: 'stale' };
    const piece = pump.take();
    if (piece.empty) {
      return { ok: true, empty: true, eof: piece.eof, error: piece.error };
    }
    return {
      ok: true,
      empty: false,
      eof: false,
      mp3: piece.buf.toString('base64'),
    };
  });

  enso.renderer.handle('stop', () => {
    destroyPump();
    return { ok: true };
  });

  enso.renderer.handle('trace', (args) => {
    console.warn('[box.radio]', String(args?.msg ?? ''));
    return { ok: true };
  });

  enso.renderer.handle('cover', async (args) => {
    try {
      return await resolveCover(String(args?.id ?? ''), String(args?.url ?? ''));
    } catch {
      return { ok: false };
    }
  });
}

export function deactivate() {
  destroyPump();
}
