import './dns-ipv4.mjs';
import { ByteChunker, IcyStripper, SyncSkipper } from './icy.mjs';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 8KB：64kbps 约 1s，避免首包播完后缓冲空掉 */
export const CHUNK_BYTES = 8 * 1024;
export const FIRST_CHUNK_BYTES = 8 * 1024;
const MAX_CHUNKS = 32;
const OPEN_WAIT_MS = 12_000;
const MAX_RECONNECT = 12;
const SHORT_BYTES = 24 * 1024;
const SHORT_MS = 2_500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function altUrl(url) {
  if (url.startsWith('https://')) return `http://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
  return '';
}

async function openStream(url, ac, fetchApi) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Icy-MetaData': '0',
    Accept: '*/*',
  };
  const candidates = [url, altUrl(url)].filter(Boolean);
  let lastErr = null;
  for (const u of candidates) {
    try {
      const res = await fetchApi(u, {
        headers,
        redirect: 'follow',
        signal: ac.signal,
      });
      if (res.ok && res.body) return { res, url: u };
      lastErr = new Error(`http ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (ac.signal.aborted) throw err;
    }
  }
  throw lastErr || new Error('stream failed');
}

export function createLivePump({ id, url, mime, fetchApi = fetch, refreshUrl }) {
  const ac = new AbortController();
  /** @type {Buffer[]} */
  const queue = [];
  let eof = false;
  let error = '';
  let gotAudio = false;

  const run = async () => {
    const chunker = new ByteChunker(CHUNK_BYTES, FIRST_CHUNK_BYTES);
    const enqueue = (buf) => {
      queue.push(buf);
      while (queue.length > MAX_CHUNKS) queue.shift();
    };
    let currentUrl = url;
    let shortStreak = 0;
    for (let attempt = 1; attempt <= MAX_RECONNECT && !ac.signal.aborted; attempt++) {
      const t0 = Date.now();
      let bytes = 0;
      let reason = 'done';
      let usedUrl = currentUrl;
      let contentLength = null;
      try {
        const opened = await openStream(currentUrl, ac, fetchApi);
        const res = opened.res;
        usedUrl = opened.url;
        contentLength = res.headers.get('content-length');
        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        if (
          !/audio\/mpeg|audio\/mp3|audio\/aac|audio\/aacp|application\/octet-stream/.test(ctype)
        ) {
          console.warn('[box.radio] unexpected content-type', ctype);
        }
        const metaint = Number(res.headers.get('icy-metaint') || 0);
        const stripper = new IcyStripper(metaint);
        const syncer = new SyncSkipper();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            reason = 'done';
            break;
          }
          if (ac.signal.aborted) {
            reason = 'abort';
            break;
          }
          if (!value?.length) continue;
          bytes += value.length;
          stripper.push(value, (audio) => {
            syncer.push(audio, (aligned) => {
              if (aligned.length) gotAudio = true;
              chunker.push(aligned, enqueue);
            });
          });
        }
        if (!ac.signal.aborted) chunker.flush(enqueue);
      } catch (err) {
        reason = ac.signal.aborted
          ? 'abort'
          : `throw:${err?.cause?.message || err?.message || err}`;
        if (!ac.signal.aborted) {
          console.warn('[box.radio] pump', err?.message || err, err?.cause?.message || '');
        }
      }
      const ms = Date.now() - t0;
      console.warn(
        '[box.radio] stream end',
        JSON.stringify({ attempt, url: usedUrl, bytes, ms, reason, contentLength }),
      );
      if (ac.signal.aborted || reason === 'abort') break;
      const short = bytes < SHORT_BYTES || ms < SHORT_MS;
      if (short) {
        shortStreak += 1;
        if (typeof refreshUrl === 'function') {
          try {
            const next = await refreshUrl();
            if (next) currentUrl = next;
          } catch {
            /* keep currentUrl */
          }
        }
        if (shortStreak >= 3) {
          error = '无法播放此电台';
          break;
        }
        await sleep(400);
        continue;
      }
      shortStreak = 0;
      await sleep(200);
    }
    eof = true;
  };

  const running = run();

  return {
    id,
    mime,
    take() {
      const buf = queue.shift();
      if (buf) return { empty: false, eof: false, buf };
      if (eof) return { empty: true, eof: true, error: error || undefined };
      return { empty: true, eof: false };
    },
    async waitOpen() {
      const start = Date.now();
      while (!queue.length && !eof && Date.now() - start < OPEN_WAIT_MS) {
        await sleep(40);
      }
      if (!queue.length) {
        ac.abort();
        await running.catch(() => {});
        return false;
      }
      return true;
    },
    destroy() {
      ac.abort();
      queue.length = 0;
      eof = true;
    },
  };
}
