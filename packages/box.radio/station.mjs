/** @typedef {'MP3' | 'AAC' | 'OTHER'} Codec */
import { decorateStation } from './aliases.mjs';

/**
 * @param {unknown} raw
 * @returns {Codec}
 */
export function normalizeCodec(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!s) return 'OTHER';
  if (s === 'MP3' || s === 'MPGA' || s === 'MPEG') return 'MP3';
  if (s === 'AAC' || s === 'AAC+' || s === 'AAC+' || s.startsWith('AAC')) return 'AAC';
  return 'OTHER';
}

function asBoolHls(value) {
  return value === true || value === 1 || value === '1';
}

function asOk(value) {
  return value === true || value === 1 || value === '1';
}

/**
 * @param {unknown} raw
 * @returns {null | {
 *   id: string,
 *   name: string,
 *   country: string,
 *   codec: Codec,
 *   bitrate: number,
 *   hls: boolean,
 *   playable: boolean,
 *   homepage?: string,
 *   hasFavicon: boolean,
 *   favicon: string,
 *   tags: string[],
 * }}
 */
export function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  if (!asOk(row.lastcheckok)) return null;
  const id = String(row.stationuuid ?? '').trim();
  const name = String(row.name ?? '').replace(/\s+/g, ' ').trim();
  if (!id || !name) return null;

  const codec = normalizeCodec(row.codec);
  const hls = asBoolHls(row.hls);
  const bitrate = Number(row.bitrate);
  const favicon = String(row.favicon ?? '').trim();
  const homepage = String(row.homepage ?? '').trim();
  const tags = String(row.tags ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);
  const votes = Number(row.votes);
  const streamUrl = String(row.url_resolved || row.url || '').trim();

  return {
    id,
    name,
    country: String(row.countrycode ?? '').trim().toUpperCase(),
    state: String(row.state ?? '').trim(),
    codec,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : 0,
    hls,
    playable: !hls && (codec === 'MP3' || codec === 'AAC'),
    homepage: homepage || undefined,
    hasFavicon: /^https?:\/\//i.test(favicon),
    favicon: /^https?:\/\//i.test(favicon) ? favicon : '',
    tags,
    votes: Number.isFinite(votes) && votes > 0 ? Math.round(votes) : 0,
    streamUrl,
  };
}

/** @param {unknown} raw */
export function mapStations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    const station = normalizeStation(row);
    if (station) out.push(decorateStation(station));
  }
  return out;
}

export function isPlayableCodec(codec) {
  return codec === 'MP3' || codec === 'AAC';
}

export function mimeForCodec(codec) {
  if (codec === 'AAC') return 'audio/aac';
  return 'audio/mpeg';
}
