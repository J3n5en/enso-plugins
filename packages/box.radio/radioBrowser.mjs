import './dns-ipv4.mjs';
import dns from 'node:dns/promises';
import { mapStations } from './station.mjs';
import { filterRegion, findRegion } from './regions.mjs';
import { expandSearchTerms } from './aliases.mjs';

export const USER_AGENT = 'BoxRadio/0.1.0';
const DISCOVERY_HOST = 'all.api.radio-browser.info';
const FALLBACK_HOST = 'de1.api.radio-browser.info';
const STATIC_HOSTS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'fi1.api.radio-browser.info',
];
const NODE_TIMEOUT_MS = 12_000;
const HTTPS_TIMEOUT_MS = 2_500;
const CATALOG_TIMEOUT_MS = 20_000;
const CN_LIMIT = 400;
const HOT_LIMIT = 100;
const REGION_LIMIT = 80;

export class DirectoryError extends Error {
  constructor(message = '电台目录暂时连不上，请稍后重试') {
    super(message);
    this.name = 'DirectoryError';
  }
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

async function discoverHosts(resolve4, reverse) {
  if (typeof resolve4 !== 'function') return [...STATIC_HOSTS];
  const run = async () => {
  /** @type {string[]} */
  const names = [];
  try {
    const ips = await resolve4(DISCOVERY_HOST);
    for (const ip of ips) {
      try {
        const hosts = await reverse(ip);
        for (const h of hosts) {
          if (h && !names.includes(h)) names.push(h);
        }
      } catch {
        // reverse 失败的 IP 跳过
      }
    }
  } catch (err) {
    console.warn('[box.radio] dns resolve failed', err?.message || err);
  }
  if (names.length === 0) {
    console.warn('[box.radio] dns empty, fallback', FALLBACK_HOST);
    return [...STATIC_HOSTS];
  }
  return shuffle(names);
  };
  return Promise.race([
    run(),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve([...STATIC_HOSTS]), 1_500);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * @param {{ fetchApi?: typeof fetch, resolve4?: Function, reverse?: Function }} [opts]
 */
export function createRadioBrowser(opts = {}) {
  const fetchApi = opts.fetchApi || fetch;
  let hostsPromise = null;
  let cnPromise = null;
  let preferredProto = null;
  const countryCache = new Map();
  let lastHot = [];

  const hosts = () => {
    if (!hostsPromise) {
      hostsPromise = discoverHosts(opts.resolve4, opts.reverse);
    }
    return hostsPromise;
  };

  const loadCn = () => {
    if (!cnPromise) {
      cnPromise = json(
        `/json/stations/search?countrycode=CN&hidebroken=true&order=votes&reverse=true&limit=${CN_LIMIT}`,
        CATALOG_TIMEOUT_MS,
      ).then((raw) => mapStations(raw));
      cnPromise = cnPromise.catch((err) => {
        cnPromise = null;
        throw err;
      });
    }
    return cnPromise;
  };

  const loadCountry = (cc) => {
    if (!countryCache.has(cc)) {
      const p = json(
        `/json/stations/search?countrycode=${encodeURIComponent(cc)}&hidebroken=true&order=votes&reverse=true&limit=200`,
      )
        .then((raw) => mapStations(raw))
        .catch((err) => {
          countryCache.delete(cc);
          throw err;
        });
      countryCache.set(cc, p);
    }
    return countryCache.get(cc);
  };

  /**
   * @param {string} path
   * @param {number} [timeoutMs]
   */
  const json = async (path, timeoutMs = NODE_TIMEOUT_MS) => {
    const seen = new Set();
    const list = [];
    for (const host of [...(await hosts()), ...STATIC_HOSTS]) {
      if (!host || seen.has(host)) continue;
      seen.add(host);
      list.push(host);
    }
    let lastErr = null;
    for (const host of list) {
      const protos = preferredProto
        ? [preferredProto, preferredProto === 'http' ? 'https' : 'http']
        : ['http', 'https'];
      for (const proto of protos) {
        const ac = new AbortController();
        const wait = proto === 'https' ? Math.min(HTTPS_TIMEOUT_MS, timeoutMs) : timeoutMs;
        const timer = setTimeout(() => ac.abort(), wait);
        try {
          const res = await fetchApi(`${proto}://${host}${path}`, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
            },
            signal: ac.signal,
          });
          if (res.status >= 500) {
            lastErr = new Error(`${proto} ${res.status}`);
            continue;
          }
          if (res.status === 404) return null;
          if (!res.ok) throw new DirectoryError();
          preferredProto = proto;
          return await res.json();
        } catch (err) {
          lastErr = err;
          if (err instanceof DirectoryError) throw err;
          continue;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    const cause = lastErr?.cause?.message || lastErr?.cause || '';
    console.warn('[box.radio] all nodes failed', lastErr?.message || lastErr, cause);
    throw new DirectoryError();
  };

  return {
    async discover() {
      const raw = await json(
        `/json/stations/search?countrycode=CN&hidebroken=true&order=votes&reverse=true&limit=${HOT_LIMIT}`,
      );
      const stations = mapStations(raw);
      lastHot = stations;
      return stations;
    },
    async search(q) {
      const terms = expandSearchTerms(q);
      const seen = new Set();
      /** @type {any[]} */
      const out = [];
      for (const term of terms) {
        const raw = await json(
          `/json/stations/search?name=${encodeURIComponent(term)}&hidebroken=true&order=votes&reverse=true&limit=50`,
        );
        for (const s of mapStations(raw)) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          out.push(s);
        }
      }
      out.sort((a, b) => (b.votes || 0) - (a.votes || 0));
      return out.slice(0, 50);
    },
    async byRegion(id) {
      const region = findRegion(id);
      const extras = [
        ...new Set([...(region.countrycodes || []), ...(region.extraCountrycodes || [])]),
      ].filter((cc) => cc && cc !== 'CN');
      const cnP = loadCn();
      const extraPs = extras.map((cc) => loadCountry(cc).catch(() => []));
      const extraLists = await Promise.all(extraPs);
      let cn = lastHot;
      try {
        cn = await Promise.race([
          cnP,
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('catalog-slow')), 6_000);
            if (typeof t.unref === 'function') t.unref();
          }),
        ]);
      } catch {
        cn = lastHot;
      }
      const pool = cn.concat(...extraLists);
      return filterRegion(pool, region, REGION_LIMIT);
    },
    prefetch() {
      loadCn().catch(() => {});
      loadCountry('HK').catch(() => {});
    },
    async click(id) {
      const raw = await json(`/json/url/${encodeURIComponent(id)}`);
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (!row || typeof row !== 'object') return { url: '', name: '', id };
      const url = String(row.url_resolved || row.url || '').trim();
      const name = String(row.name || '').trim();
      return { url, name, id: String(row.stationuuid || id) };
    },
  };
}
