import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 抖音 40.9.0 的 iOS 请求头。推荐流不校验签名，带公共参数和游客 cookie 就够了。
const UA = 'Aweme 40.9.0 rv:409015 (iPhone; iOS 17.3.1; zh_CN) Cronet';
const API = 'https://aweme.snssdk.com';
const FEED = '/aweme/v2/feed/';

// ---------- protobuf 线格式 ----------
const big = (buf, i) => {
  let shift = 0n;
  let out = 0n;
  while (i < buf.length) {
    const b = buf[i++];
    out |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [out, i];
    shift += 7n;
  }
  return [out, i];
};

function* fields(buf) {
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = big(buf, i);
    i = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [v, next] = big(buf, i);
      i = next;
      yield [field, v];
    } else if (wire === 1) {
      yield [field, buf.subarray(i, i + 8)];
      i += 8;
    } else if (wire === 2) {
      const [len, next] = big(buf, i);
      i = next;
      const n = Number(len);
      yield [field, buf.subarray(i, i + n)];
      i += n;
    } else if (wire === 5) {
      yield [field, buf.subarray(i, i + 4)];
      i += 4;
    } else return;
  }
}

const first = (buf, want) => {
  for (const [f, v] of fields(buf)) if (f === want) return v;
  return undefined;
};
const all = (buf, want) => {
  const out = [];
  for (const [f, v] of fields(buf)) if (f === want) out.push(v);
  return out;
};
const text = (v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');
const count = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);
const digits = (v) => (typeof v === 'bigint' ? v.toString() : String(v ?? ''));

// UrlStruct: uri = 1, urls = 2
function pickUrl(buf) {
  const list = all(buf, 2).map(text).filter(Boolean);
  return list[0] || text(first(buf, 1));
}

// author: uid = 1, nickname = 3, avatar = 7, sec_uid = 191
function parseAuthor(buf) {
  return {
    uid: digits(first(buf, 1)),
    nickname: text(first(buf, 3)),
    avatar: text(first(buf, 7)),
    secUid: text(first(buf, 191)),
  };
}

// video: play_addr = 1, cover = 2, width = 3, height = 4, duration = 13,
//        bit_rate = 11 (repeated：gear_name = 1, bit_rate = 3, play_addr = 4)
function parseVideo(buf) {
  const play = first(buf, 1);
  const cover = first(buf, 2);
  const rates = [];
  for (const [f, v] of fields(buf)) {
    if (f !== 11) continue;
    const addr = first(v, 4);
    if (!addr) continue;
    const url = pickUrl(addr);
    if (!url) continue;
    rates.push({ br: count(first(v, 3)), url });
  }
  rates.sort((a, b) => a.br - b.br);
  // 推荐流默认走最低档：单条几十 MB 的 1080p 在侧栏里等不起，低码率能秒开
  const light = rates.find((r) => r.br >= 300000) ?? rates[0];
  return {
    url: light?.url || (play ? pickUrl(play) : ''),
    hdUrl: rates.length ? rates[rates.length - 1].url : '',
    rates: rates.slice(0, 6),
    cover: cover ? pickUrl(cover) : '',
    width: count(first(buf, 3)),
    height: count(first(buf, 4)),
    duration: count(first(buf, 13)),
  };
}

// statistics: comment = 2, digg = 3, share = 4, collect = 6
function parseStats(buf) {
  return {
    comment: count(first(buf, 2)),
    digg: count(first(buf, 3)),
    share: count(first(buf, 4)),
    collect: count(first(buf, 6)),
  };
}

// music: title = 3, author = 4
function parseMusic(buf) {
  return { title: text(first(buf, 3)), author: text(first(buf, 4)) };
}

// aweme: id = 1, desc = 2, create_time = 3, author = 4, music = 5, video = 7, statistics = 10
function parseAweme(buf) {
  const id = first(buf, 1);
  const desc = first(buf, 2);
  const created = first(buf, 3);
  const author = first(buf, 4);
  const music = first(buf, 5);
  const video = first(buf, 7);
  const stats = first(buf, 10);
  return {
    id: text(id),
    desc: text(desc),
    createTime: count(created),
    author: author ? parseAuthor(author) : { uid: '', nickname: '', avatar: '', secUid: '' },
    music: music ? parseMusic(music) : { title: '', author: '' },
    video: video ? parseVideo(video) : { url: '', cover: '', width: 0, height: 0, duration: 0 },
    stats: stats ? parseStats(stats) : { comment: 0, digg: 0, share: 0, collect: 0 },
    digest: '',
  };
}

export function parseFeed(buf) {
  const items = [];
  for (const [f, v] of fields(buf)) if (f === 5 && v?.length) items.push(parseAweme(v));
  return items;
}

// ---------- 游客身份 ----------
const randomId = () => String(7_000000000000000000n + BigInt(Math.floor(Math.random() * 2_000000000000000000)));

async function guestIdentity(dataDir) {
  const file = join(dataDir, 'guest.json');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved?.deviceId && saved?.iid) return saved;
  } catch {}
  const identity = { deviceId: randomId(), iid: randomId() };
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(identity));
  return identity;
}

function commonParams(id, extra) {
  return new URLSearchParams({
    device_id: id.deviceId,
    iid: id.iid,
    aid: '1128',
    app_id: '1128',
    version_code: '400900',
    version_name: '40.9.0',
    os_version: '17.3.1',
    device_platform: 'iphone',
    channel: 'App Store',
    ac: 'wifi',
    ...extra,
  });
}

async function request(path, id, extra) {
  const url = `${API}${path}?${commonParams(id, extra)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: `install_id=${id.iid}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- 视频下载 ----------
// 插件页面被 CSP 限制成 media-src data: blob:，远程地址播不了。
// 所以视频先落到磁盘，页面按块取回拼成 Blob 再播。
// 宿主把 renderer 返回值限制在 1 MB 内，512 KB 数据转 base64 约 699 KB，留足余量
const CHUNK = 512 * 1024;
const CACHE_LIMIT = 800 * 1024 * 1024;
const CACHE_AGE = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mediaJobs = new Map();

function mediaPath(dataDir, url) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 20);
  return { key, path: join(dataDir, 'media', `${key}.mp4`) };
}

function download(job, url) {
  job.ready = (async () => {
    const head = await fetch(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15000),
    });
    const range = head.headers.get('content-range');
    job.total = range ? Number(range.split('/')[1]) : Number(head.headers.get('content-length')) || 0;
    await head.body?.cancel().catch(() => {});
    if (!head.ok && head.status !== 206) throw new Error(`视频请求失败 HTTP ${head.status}`);

    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`视频下载失败 HTTP ${res.status}`);
    await mkdir(join(job.path, '..'), { recursive: true });
    const out = createWriteStream(job.path);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
    job.done = true;
  })().catch((e) => {
    job.error = e?.message || String(e);
  });
  return job;
}

async function mediaJob(dataDir, url) {
  const { key, path } = mediaPath(dataDir, url);
  const hit = mediaJobs.get(key);
  if (hit) return hit;
  const job = { key, path, total: 0, done: false, error: null };
  mediaJobs.set(key, job);
  download(job, url);
  return job;
}

async function prune(dataDir) {
  const dir = join(dataDir, 'media');
  const names = await readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info) files.push({ name, size: info.size, at: info.mtimeMs });
  }
  const now = Date.now();
  let total = 0;
  files.sort((a, b) => b.at - a.at);
  for (const [i, file] of files.entries()) {
    total += file.size;
    const playing = mediaJobs.get(file.name.replace(/\.mp4$/, '')) && !mediaJobs.get(file.name.replace(/\.mp4$/, '')).done;
    if (playing) continue;
    if (i < 3) continue;
    if (total > CACHE_LIMIT || now - file.at > CACHE_AGE) await rm(join(dir, file.name), { force: true }).catch(() => {});
  }
}

// ---------- mp4 头解析：给 MSE 提供准确的 codec ----------
const MOOV_HEAD = 1 << 20; // moov 紧跟 ftyp，1 MB 内必到

function moovOf(buf) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (size < 8) return null;
    if (type === 'moov') return buf.subarray(i, Math.min(i + size, buf.length));
    i += size;
  }
  return null;
}

function hevcCodec(moov) {
  const i = moov.indexOf('hvcC');
  if (i < 0) return '';
  const p = moov.subarray(i + 4);
  if (p.length < 13) return '';
  const b1 = p[1];
  const space = (b1 >> 6) & 3;
  const tier = (b1 >> 5) & 1;
  const profile = b1 & 0x1f;
  // general_profile_compatibility_flags 按反转字节序写成十六进制
  const compat = Buffer.from([p[5], p[4], p[3], p[2]]).toString('hex').replace(/^0+/, '') || '0';
  const level = p[12];
  const cs = p.subarray(6, 12);
  let n = cs.length;
  while (n > 0 && cs[n - 1] === 0) n--;
  const constraints = n ? cs.subarray(0, n).toString('hex').toUpperCase() : '';
  return `hvc1.${['', 'A', 'B', 'C'][space]}${profile}.${compat}.${tier ? 'H' : 'L'}${level}${constraints ? '.' + constraints : ''}`;
}

function avcCodec(moov) {
  const i = moov.indexOf('avcC');
  if (i < 0) return '';
  const p = moov.subarray(i + 4);
  if (p.length < 4) return '';
  const hex = [p[1], p[2], p[3]].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `avc1.${hex}`;
}

function mimeOf(buf) {
  const moov = moovOf(buf);
  if (!moov) return '';
  const video = hevcCodec(moov) || avcCodec(moov);
  if (!video) return '';
  const audio = moov.indexOf('mp4a') >= 0 ? 'mp4a.40.2' : '';
  return `video/mp4; codecs="${[video, audio].filter(Boolean).join(',')}"`;
}

async function readHead(job, want) {
  for (let i = 0; i < 200; i++) {
    const size = (await stat(job.path).catch(() => null))?.size ?? 0;
    if (size >= want || job.done || job.error) break;
    await sleep(30);
  }
  const size = (await stat(job.path).catch(() => null))?.size ?? 0;
  const n = Math.min(want, size);
  if (!n) return null;
  const fh = await open(job.path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function activate(enso) {
  let identityP;
  const identity = () =>
    (identityP ??= guestIdentity(enso.dataDir).catch((e) => {
      identityP = undefined;
      throw e;
    }));

  // 推荐流没有游标：每次请求都返回一批新内容。
  enso.renderer.handle('feed', async (a) => {
    const id = await identity();
    const want = Math.min(Math.max(Number(a?.count) || 10, 1), 20);
    const items = parseFeed(await request(FEED, id, { count: String(want) }));
    // 没有播放地址的条目在侧栏里放不了，直接丢掉
    const playable = items.filter((item) => item.video?.url);
    return { items: playable, hasMore: playable.length > 0 };
  });

  // 视频落盘后在页面侧拼 Blob：media 先探总长度，chunk 按偏移取一段
  const activeJobs = () => [...mediaJobs.values()].filter((j) => !j.done && !j.error).length;

  enso.renderer.handle('media', async (a) => {
    const url = String(a?.url ?? '');
    if (!/^https:\/\//.test(url)) throw new Error('播放地址无效');
    const { key } = mediaPath(enso.dataDir, url);
    // 预取让路：已经有下载在跑就先不抢带宽，等用户真滑到这一条再取
    if (a?.prefetch && !mediaJobs.has(key) && activeJobs() >= 1) return { skipped: true, size: 0 };
    const job = await mediaJob(enso.dataDir, url);
    for (let i = 0; i < 120 && !job.total && !job.error; i++) await sleep(50);
    if (job.error) throw new Error(job.error);
    const head = await readHead(job, MOOV_HEAD).catch(() => null);
    const moov = head ? moovOf(head) : null;
    // Chromium 只接受分片 mp4（moov 里要有 mvex）；抖音给的是整段 mp4，
    // 这条路走不通，前端据此直接走整段下载，不再白试一次。
    const fragmented = !!moov && moov.indexOf('mvex') >= 0;
    const hasAudio = !!moov && moov.indexOf('mp4a') >= 0;
    return { size: job.total, cached: job.done, mime: head ? mimeOf(head) : '', fragmented, hasAudio };
  });

  enso.renderer.handle('chunk', async (a) => {
    const url = String(a?.url ?? '');
    const start = Math.max(0, Number(a?.offset) || 0);
    const job = await mediaJob(enso.dataDir, url);
    for (let waited = 0; waited < 30000; waited += 50) {
      if (job.error) throw new Error(job.error);
      const size = (await stat(job.path).catch(() => null))?.size ?? 0;
      if (start < size || (job.done && start >= size)) {
        const fh = await open(job.path, 'r').catch(() => null);
        if (!fh) {
          await sleep(30);
          continue;
        }
        try {
          const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, size - start)));
          const { bytesRead } = await fh.read(buf, 0, buf.length, start);
          const next = start + bytesRead;
          return { data: buf.subarray(0, bytesRead).toString('base64'), next, size: job.total, done: job.done && next >= size };
        } finally {
          await fh.close();
        }
      }
      if (job.done) return { data: '', next: start, size: job.total, done: true };
      await sleep(50);
    }
    return { data: '', next: start, size: job.total, done: false };
  });

  prune(enso.dataDir).catch(() => {});

  // 换一组游客身份：设备被限流时用得上
  enso.renderer.handle('reset', async () => {
    identityP = undefined;
    await rm(join(enso.dataDir, 'guest.json'), { force: true });
    await identity();
    return { ok: true };
  });
}
