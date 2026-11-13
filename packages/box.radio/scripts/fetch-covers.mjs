import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RAW } from '../cover.mjs';
import '../dns-ipv4.mjs';
import { mapStations } from '../station.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'covers');
const UA = 'BoxRadio/0.3.2 (cover fetch)';
const QINGTING_LIVE = /qingting\.fm\/live\/(\d+)/i;

function extFor(mime, buf) {
  if (mime.includes('jpeg') || mime.includes('jpg') || (buf[0] === 0xff && buf[1] === 0xd8))
    return 'jpg';
  if (mime.includes('png') || buf[0] === 0x89) return 'png';
  if (mime.includes('gif') || buf[0] === 0x47) return 'gif';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('icon') || mime.includes('ico')) return 'ico';
  return '';
}

async function downloadImage(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*,text/html;q=0.1' },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const ctype = String(res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_RAW) return null;
    const ext = extFor(ctype, buf);
    if (!ext) return null;
    return { buf, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ogImage(html) {
  const m =
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(html);
  return m ? m[1].trim() : '';
}

async function qingtingCover(channelId) {
  const pages = [
    `https://www.qingting.fm/radios/${channelId}/`,
    `https://www.qingting.fm/channels/${channelId}/`,
  ];
  for (const page of pages) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(page, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: ac.signal,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const img = ogImage(html);
      if (img) {
        const file = await downloadImage(img);
        if (file) return file;
      }
    } catch {
      /* next */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const cur = items[i++];
      await fn(cur);
    }
  });
  await Promise.all(workers);
}

const HOSTS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'fi1.api.radio-browser.info',
];

async function loadCn() {
  for (const host of HOSTS) {
    for (const proto of ['http', 'https']) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      try {
        const res = await fetch(
          `${proto}://${host}/json/stations/search?countrycode=CN&hidebroken=true&order=votes&reverse=true&limit=400`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac.signal },
        );
        if (!res.ok) continue;
        return mapStations(await res.json());
      } catch {
        /* next */
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return [];
}

const stations = await loadCn();
if (!stations.length) {
  console.error('no stations');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

const manifest = { byId: {} };
let ok = 0;
let fail = 0;

await pool(stations, 4, async (s) => {
  let file = s.favicon ? await downloadImage(s.favicon) : null;
  if (!file) {
    const m = QINGTING_LIVE.exec(s.streamUrl || '');
    if (m) file = await qingtingCover(m[1]);
  }
  if (!file) {
    fail += 1;
    return;
  }
  const name = `${s.id}.${file.ext}`;
  await writeFile(join(OUT, name), file.buf);
  manifest.byId[s.id] = name;
  ok += 1;
  console.log('ok', ok, s.name);
});

await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`done ok=${ok} fail=${fail} total=${stations.length}`);
