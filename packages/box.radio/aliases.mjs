/** 营销名 / 简繁体 → 目录里的站名片段 */

const CHAR_FOLD = [
  ['广', '廣'],
  ['东', '東'],
  ['乐', '樂'],
  ['声', '聲'],
  ['综', '綜'],
  ['合', '合'],
  ['闻', '聞'],
  ['讯', '訊'],
  ['经', '經'],
  ['济', '濟'],
  ['音', '音'],
  ['乐', '樂'],
  ['环', '環'],
  ['保', '保'],
  ['旅', '旅'],
  ['游', '遊'],
  ['台', '臺'],
  ['湾', '灣'],
  ['门', '門'],
  ['电', '電'],
  ['视', '視'],
  ['频', '頻'],
  ['龙', '龍'],
  ['庆', '慶'],
  ['县', '縣'],
  ['区', '區'],
  ['国', '國'],
  ['产', '產'],
  ['发', '發'],
  ['对', '對'],
  ['会', '會'],
  ['车', '車'],
  ['马', '馬'],
  ['宝', '寶'],
  ['书', '書'],
  ['体', '體'],
  ['爱', '愛'],
];

/** @type {{ keys: string[], needles: string[], label: string }[]} */
export const ALIASES = [
  {
    keys: ['快乐888', '快樂888', '快乐 888', 'fm88.8', 'fm888', '88.8'],
    needles: ['環保旅遊之聲', '环保旅游之声'],
    label: '快乐888',
  },
  {
    keys: ['飞扬971', '飛揚971', '飞扬 971'],
    needles: ['深圳音樂廣播', '深圳音乐广播', '深圳飞扬', '深圳飛揚'],
    label: '飞扬971',
  },
  {
    keys: ['先锋898', '先鋒898'],
    needles: ['深圳交通廣播', '深圳交通广播'],
    label: '先锋898',
  },
];

export function foldZh(text) {
  let s = String(text || '');
  for (const [a, b] of CHAR_FOLD) {
    s = s.split(b).join(a);
  }
  return s.toLowerCase();
}

export function zhVariants(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let trad = raw;
  for (const [a, b] of CHAR_FOLD) trad = trad.split(a).join(b);
  const simp = foldZh(raw);
  return [...new Set([raw, trad, simp].filter(Boolean))];
}

export function expandSearchTerms(q) {
  const raw = String(q || '').trim();
  if (!raw) return [];
  const folded = foldZh(raw);
  /** @type {string[]} */
  const out = [raw];
  for (const a of ALIASES) {
    const hit = a.keys.some((k) => {
      const fk = foldZh(k);
      if (folded === fk) return true;
      return fk.length >= 3 && folded.includes(fk);
    });
    if (hit) out.push(...a.needles);
  }
  out.push(...zhVariants(raw).filter((s) => s !== raw));
  return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))].slice(0, 3);
}

export function aliasLabelsFor(name) {
  const n = foldZh(name);
  const labels = [];
  for (const a of ALIASES) {
    const inName = a.needles.some((x) => n.includes(foldZh(x)));
    const inKey = a.keys.some((k) => n.includes(foldZh(k)));
    if (inName || inKey) labels.push(a.label);
  }
  return labels;
}

export function decorateStation(station) {
  if (!station) return station;
  const aliases = aliasLabelsFor(station.name);
  return aliases.length ? { ...station, aliases } : { ...station, aliases: [] };
}
