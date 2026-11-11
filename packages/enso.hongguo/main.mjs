import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createClient } from 'openhongguo';
import { Remuxer } from './remux.mjs';

// base64 of 46KB stays under the 64KB UI payload cap
const CHUNK = 46 * 1024;
const HEAD = 512 * 1024;
const KEEP_VIDEOS = 6;
const QUALITIES = ['360p', '480p', '540p', '720p', '1080p'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function activate(enso) {
  const videoDir = join(enso.dataDir, 'video');
  const coverDir = join(enso.dataDir, 'covers');
  const jobs = new Map();
  let clientP;
  const KEEP_COVERS = 300;

  // leftover .part files belong to downloads killed by process exit; nothing is playing yet
  readdir(videoDir)
    .then((files) => Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => rm(join(videoDir, f), { force: true }))))
    .catch(() => {});

  const client = () =>
    (clientP ??= createClient({ profile: join(enso.dataDir, 'anonymous.json') }).catch((e) => {
      clientP = undefined;
      throw e;
    }));

  const which = (name) => {
    const win = process.platform === 'win32';
    const file = win ? `${name}.exe` : name;
    const winget = win && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '';
    const dirs = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), ...(win ? [winget] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
    for (const dir of dirs) if (dir && existsSync(join(dir, file))) return join(dir, file);
    return null;
  };

  const friendly = (e) => {
    const map = {
      RATE_LIMITED: '请求太频繁，稍后再试',
      TRANSPORT: '网络请求失败',
      CONTENT_UNAVAILABLE: '内容已下架或不可访问',
      ANONYMOUS_LIMITED: '匿名设备被限制，稍后再试',
      AUTHENTICATION_REQUIRED: '该内容需要登录',
      CHALLENGE_REQUIRED: '服务端要求验证，匿名无法继续',
    };
    return new Error(map[e?.code] ?? e?.message ?? String(e));
  };

  // 设备受限时换新设备并退避重试；并发失败只重置一次
  let gen = 0;
  let resetting;
  const reset = (c, seen) => {
    if (seen !== gen) return resetting ?? Promise.resolve();
    gen++;
    return (resetting = c.resetDevice().finally(() => (resetting = undefined)));
  };
  const sdk = async (fn) => {
    const c = await client();
    for (let i = 0; ; i++) {
      const seen = gen;
      try {
        return await fn(c);
      } catch (e) {
        if (!['ANONYMOUS_LIMITED', 'DEVICE_REJECTED'].includes(e?.code) || i >= 3) throw friendly(e);
        await reset(c, seen).catch((err) => console.warn('resetDevice failed', err?.message));
        await sleep(500 * 2 ** i);
      }
    }
  };

  const summary = (s) => ({
    id: s.id,
    title: s.title,
    description: s.description?.slice(0, 300),
    cover: s.cover_url,
    count: s.episode_count,
  });
  const page = (p) => ({
    items: (p.items ?? []).map(summary),
    cursor: p.cursor,
    hasMore: Boolean(p.has_more),
  });
  const empty = (e) => e?.code === 'ANONYMOUS_LIMITED' || e?.code === 'END_OF_LIST';
  const list = (fn) =>
    client().then((c) =>
      fn(c).then(page, (e) => {
        if (empty(e)) return { items: [], hasMore: false };
        throw friendly(e);
      })
    );

  enso.renderer.handle('discover', (a) => list((c) => c.discover({ cursor: a?.cursor || undefined })));

  // 侧栏按会话各开一个页面实例：记住唯一在播的实例和进度，其余实例据此接力
  let now = null;
  let recent = null;
  enso.renderer.handle('sync', (a) => {
    const inst = String(a?.inst ?? '');
    const own = Boolean(inst) && now?.owner === inst;
    const state = a?.state && typeof a.state === 'object' && a.state.series?.id ? a.state : null;
    if (state && (a.claim || own)) now = { ...state, owner: inst };
    else if (a?.state === null && own) now = null;
    if (Array.isArray(a?.recent)) recent = a.recent;
    const res = { own: Boolean(inst) && now?.owner === inst };
    if (a?.pull) Object.assign(res, { now, recent });
    return res;
  });

  enso.renderer.handle('search', (a) => {
    const q = String(a?.q ?? '').trim().slice(0, 100);
    if (!q) return { items: [], hasMore: false };
    // 综合搜索不返回 cover_url；getSeries 只带回封面，不带分集列表
    return list((c) => c.search(q, { cursor: a?.cursor || undefined })).then(async (result) => {
      const missing = result.items.filter((s) => s.id && !s.cover);
      if (!missing.length) return result;
      const c = await client();
      await Promise.all(
        missing.map((s) =>
          c
            .getSeries(s.id)
            .then((full) => {
              if (full?.cover_url) s.cover = full.cover_url;
            })
            .catch(() => {})
        )
      );
      return result;
    });
  });

  // compact tuples [id, number, playable, title?] keep 1000+ episode series under 64KB
  enso.renderer.handle('episodes', (a) =>
    sdk((c) => c.listEpisodes(String(a?.seriesId ?? ''))).then((p) =>
      (p.items ?? []).map((e) => {
        const row = [e.id, e.number, e.playable !== false ? 1 : 0];
        if (e.title && e.title !== `第${e.number}集`) row.push(e.title.slice(0, 40));
        return row;
      })
    )
  );

  const run = (bin, args, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
      const out = [];
      let err = '';
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || `退出码 ${code}`))));
    });

  // Covers are HEIC, which Chromium cannot decode: prefer the unsigned CDN's webp variant, else sips / ffmpeg.
  const webp = (url) => {
    const m = url.match(/^https?:\/\/[^/]+\/novel-pic\/([0-9a-f]+)~/);
    return m && `https://p6-novel.byteimg.com/novel-pic/${m[1]}~tplv-resize:240:0.webp`;
  };
  const toJpeg = async (url, signal) => {
    const get = (u) => fetch(u, { signal }).catch(() => null);
    const alt = webp(url);
    const candidates = alt ? [alt, url] : [url];
    let res;
    for (let i = 0; i < 2 && !res?.ok; i++) for (const u of candidates) if ((res = await get(u))?.ok) break;
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'fail'}`);
    const src = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    if (/image\/(jpeg|png|webp|gif)/.test(type)) return { mime: type.split(';')[0], data: src };
    const dir = await mkdtemp(join(tmpdir(), 'hg-cover-'));
    try {
      const input = join(dir, 'in');
      const output = join(dir, 'out.jpg');
      await writeFile(input, src);
      const ffmpeg = which('ffmpeg');
      if (process.platform === 'darwin') await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '60', '-Z', '240', input, '--out', output], signal);
      else if (ffmpeg) await run(ffmpeg, ['-loglevel', 'error', '-i', input, '-frames:v', '1', '-vf', 'scale=200:-2', '-q:v', '6', output], signal);
      else return null;
      return { mime: 'image/jpeg', data: await readFile(output) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // never throws: failing covers must not trip the UI circuit breaker
  enso.renderer.handle('cover', async (a, ctx) => {
    const url = String(a?.url ?? '');
    if (!/^https?:\/\//.test(url)) return null;
    const file = join(coverDir, createHash('sha1').update(url.split('?')[0]).digest('hex'));
    try {
      return (await readFile(file, 'utf8')) || null;
    } catch {}
    try {
      const img = await toJpeg(url, ctx?.signal);
      if (!img?.data.length || img.data.length > 46 * 1024) return null;
      const uri = `data:${img.mime};base64,${img.data.toString('base64')}`;
      await mkdir(coverDir, { recursive: true });
      await writeFile(file, uri);
      prune().catch(() => {});
      return uri;
    } catch (e) {
      console.warn('cover failed', e.message);
      return null;
    }
  });

  const resolve = (episodeId) => sdk((c) => c.resolvePlayback(episodeId));

  const pick = (streams, quality) => {
    const rank = (s) => QUALITIES.indexOf(s.definition);
    const sorted = [...streams].filter((s) => s.url).sort((x, y) => rank(x) - rank(y) || x.bitrate - y.bitrate);
    const want = QUALITIES.indexOf(quality);
    return sorted.filter((s) => rank(s) <= want).pop() ?? sorted[0];
  };

  const finalPath = (episodeId, definition) => join(videoDir, `${episodeId.replace(/\W/g, '')}-${definition}.mp4`);

  const prune = async () => {
    const active = new Set([...jobs.values()].map((j) => j.final));
    const files = await readdir(videoDir).catch(() => []);
    const stats = await Promise.all(
      files.map(async (f) => ({ path: join(videoDir, f), at: (await stat(join(videoDir, f)).catch(() => null))?.mtimeMs ?? 0 }))
    );
    const done = stats.filter((s) => s.path.endsWith('.mp4') && !active.has(s.path)).sort((a, b) => b.at - a.at);
    await Promise.all(done.slice(KEEP_VIDEOS).flatMap((s) => [rm(s.path, { force: true }), rm(`${s.path}.json`, { force: true })]));
    const covers = await Promise.all(
      (await readdir(coverDir).catch(() => [])).map(async (f) => ({
        path: join(coverDir, f),
        at: (await stat(join(coverDir, f)).catch(() => null))?.mtimeMs ?? 0,
      }))
    );
    await Promise.all(covers.sort((a, b) => b.at - a.at).slice(KEEP_COVERS).map((s) => rm(s.path, { force: true })));
  };

  const ranged = async (url, from, to, signal) => {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to ?? ''}` }, signal });
    if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`视频请求失败 HTTP ${res.status}`);
    const total = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'));
    return { res, total };
  };

  // fetch ftyp+moov, build the remuxer and write the init segment
  const prepare = async (job, url, key) => {
    const signal = job.abort.signal;
    const first = await ranged(url, 0, HEAD - 1, signal);
    let head = Buffer.from(await first.res.arrayBuffer());
    const total = first.total || head.length;
    // expects ftyp then moov (faststart); fetch more if moov exceeds the first range
    const ftypSize = head.readUInt32BE(0);
    const need = ftypSize + head.readUInt32BE(ftypSize);
    if (need > head.length && need <= total && need < 64 * 1024 * 1024)
      head = Buffer.from(await (await ranged(url, 0, need - 1, signal)).res.arrayBuffer());
    const rx = new Remuxer(head, key);
    const file = Buffer.alloc(total);
    head.copy(file);
    await writeFile(job.part, rx.init);
    return { rx, file, have: Math.min(head.length, total), total };
  };

  const pump = async (job, url, st) => {
    const fh = await open(job.part, 'a');
    try {
      const flush = async () => {
        const segs = st.rx.drain(st.file, st.have);
        if (segs.length) await fh.write(Buffer.concat(segs));
      };
      await flush();
      if (st.have < st.total) {
        const { res } = await ranged(url, st.have, null, job.abort.signal);
        for await (const piece of res.body) {
          const n = Math.min(piece.length, st.total - st.have);
          Buffer.from(piece.buffer, piece.byteOffset, n).copy(st.file, st.have);
          st.have += n;
          await flush();
        }
      }
      if (!st.rx.done) throw new Error('视频数据不完整');
    } finally {
      await fh.close();
    }
  };

  const download = async (job, urls, key) => {
    let last;
    for (const url of urls) {
      try {
        const st = await prepare(job, url, key);
        job.info.codec = st.rx.video.format;
        job.ready();
        await pump(job, url, st);
        await writeFile(`${job.final}.json`, JSON.stringify(job.info));
        await rename(job.part, job.final);
        job.done = true;
        prune().catch(() => {});
        return;
      } catch (e) {
        last = e;
        console.warn('download failed', e.message);
        // once bytes were handed to the page, switching source would corrupt the stream
        if (job.abort.signal.aborted || job.info.codec) break;
      }
    }
    await rm(job.part, { force: true });
    job.error = last?.message ?? '下载失败';
    job.ready();
  };

  enso.renderer.handle('open', async (a) => {
    const episodeId = String(a?.episodeId ?? '');
    const quality = QUALITIES.includes(a?.quality) ? a.quality : '720p';
    if (!episodeId) throw new Error('缺少分集');
    for (const j of jobs.values()) {
      if (j.episodeId !== episodeId || j.quality !== quality || j.error) continue;
      await j.readyP;
      if (!j.error) return j.info;
    }
    const { playback, contentKey, contentKeyError } = await resolve(episodeId);
    if (playback.protected && !contentKey) throw new Error(contentKeyError?.message ?? '无法取得内容密钥');
    const stream = pick(playback.streams ?? [], quality);
    if (!stream) throw new Error('没有可用的播放地址');
    const final = finalPath(episodeId, stream.definition);
    const cached = await readFile(`${final}.json`, 'utf8').then(JSON.parse, () => null);
    if (cached && existsSync(final)) {
      jobs.set(final, { episodeId, quality, info: cached, final, done: true });
      return cached;
    }
    const info = { episodeId, definition: stream.definition, codec: '', duration: playback.duration_seconds };
    const job = { episodeId, quality, info, final, part: `${final}.part`, done: false, abort: new AbortController() };
    job.readyP = new Promise((r) => (job.ready = r));
    jobs.set(final, job);
    await mkdir(videoDir, { recursive: true });
    download(job, [stream.url, stream.backup_url].filter(Boolean), contentKey?.key);
    await job.readyP;
    if (job.error) throw new Error(job.error);
    return info;
  });

  const usageOf = async (dir) => {
    const files = await readdir(dir).catch(() => []);
    const sizes = await Promise.all(files.map((f) => stat(join(dir, f)).then((s) => s.size, () => 0)));
    return { files: files.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  };

  enso.renderer.handle('cache', async (a) => {
    if (a?.clear) {
      const playing = new Set([...jobs.values()].filter((j) => !j.done && !j.error).map((j) => j.final));
      const files = await readdir(videoDir).catch(() => []);
      await Promise.all(
        files.filter((f) => !playing.has(join(videoDir, f.replace(/\.json$/, '')))).map((f) => rm(join(videoDir, f), { force: true }))
      );
      await rm(coverDir, { recursive: true, force: true });
    }
    const [video, covers] = await Promise.all([usageOf(videoDir), usageOf(coverDir)]);
    return { bytes: video.bytes + covers.bytes, videos: video.files, covers: covers.files };
  });

  enso.renderer.handle('chunk', async (a) => {
    const final = finalPath(String(a?.episodeId ?? ''), String(a?.definition ?? ''));
    const offset = Math.max(0, Number(a?.offset) || 0);
    const job = jobs.get(final) ?? (existsSync(final) ? { final, done: true } : null);
    if (!job) throw new Error('播放任务已失效，请重新打开');
    for (let waited = 0; ; waited += 100) {
      if (job.error) throw new Error(job.error);
      const path = job.done ? final : job.part;
      const size = (await stat(path).catch(() => null))?.size ?? 0;
      if (offset < size) {
        const fh = await open(path, 'r').catch(() => null);
        if (!fh) {
          await sleep(50);
          continue;
        }
        try {
          const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          const next = offset + bytesRead;
          return { data: buf.subarray(0, bytesRead).toString('base64'), next, done: job.done && next >= size };
        } finally {
          await fh.close();
        }
      }
      if (job.done) return { data: '', next: offset, done: true };
      if (waited >= 5000) return { data: '', next: offset, done: false };
      await sleep(100);
    }
  });
}
