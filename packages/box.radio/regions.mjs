/** 蜻蜓 FM 风格：国家台 / 网络台 + 省级行政区。默认广东。 */

/** @typedef {{ id: string, label: string, states?: string[], tags?: string[], names?: string[], exclusiveNames?: string[], countrycodes?: string[], extraCountrycodes?: string[] }} Region */

/** @type {Region[]} */
export const REGIONS = [
  {
    id: 'national',
    label: '国家台',
    tags: ['cnr', 'cri'],
    names: ['中国之声', '央广', 'CNR', 'CRI', '环球资讯', '中华之声', '神州之声', '大湾区之声', '国际电台', '中国交通'],
    exclusiveNames: ['经济之声', '音乐之声', '文艺之声', '老年之声'],
  },
  {
    id: 'network',
    label: '网络台',
    tags: ['internet', 'webradio', 'web radio', 'online'],
    names: ['网络台', '网络广播', '在线广播'],
  },
  { id: 'bj', label: '北京', states: ['Beijing', '北京'], tags: ['beijing'], names: ['北京'] },
  { id: 'tj', label: '天津', states: ['Tianjin', '天津'], tags: ['tianjin'], names: ['天津'] },
  { id: 'he', label: '河北', states: ['Hebei', '河北'], tags: ['hebei'], names: ['河北', '石家庄', '保定', '唐山'] },
  { id: 'sx', label: '山西', states: ['Shanxi', '山西'], tags: ['shanxi'], names: ['山西', '太原'] },
  { id: 'nm', label: '内蒙古', states: ['Inner Mongolia', 'Nei Mongol', '内蒙古'], tags: ['mongolia'], names: ['内蒙古', '呼和浩特'] },
  { id: 'ln', label: '辽宁', states: ['Liaoning', '辽宁'], tags: ['liaoning'], names: ['辽宁', '沈阳', '大连'] },
  { id: 'jl', label: '吉林', states: ['Jilin', '吉林'], tags: ['jilin'], names: ['吉林', '长春'] },
  { id: 'hl', label: '黑龙江', states: ['Heilongjiang', '黑龙江'], tags: ['heilongjiang'], names: ['黑龙江', '哈尔滨'] },
  { id: 'sh', label: '上海', states: ['Shanghai', '上海'], tags: ['shanghai'], names: ['上海'] },
  { id: 'js', label: '江苏', states: ['Jiangsu', 'Kiangsu', '江苏'], tags: ['jiangsu'], names: ['江苏', '南京', '苏州', '无锡'] },
  { id: 'zj', label: '浙江', states: ['Zhejiang', '浙江'], tags: ['zhejiang'], names: ['浙江', '杭州', '宁波', '温州'] },
  { id: 'ah', label: '安徽', states: ['Anhui', '安徽'], tags: ['anhui'], names: ['安徽', '合肥'] },
  { id: 'fj', label: '福建', states: ['Fujian', 'Fukien', '福建'], tags: ['fujian'], names: ['福建', '福州', '厦门', '泉州'] },
  { id: 'jx', label: '江西', states: ['Jiangxi', '江西'], tags: ['jiangxi'], names: ['江西', '南昌'] },
  { id: 'sd', label: '山东', states: ['Shandong', '山东'], tags: ['shandong'], names: ['山东', '济南', '青岛', '烟台'] },
  { id: 'ha', label: '河南', states: ['Henan', '河南'], tags: ['henan'], names: ['河南', '郑州'] },
  { id: 'hb', label: '湖北', states: ['Hubei', '湖北'], tags: ['hubei'], names: ['湖北', '武汉'] },
  { id: 'hn', label: '湖南', states: ['Hunan', '湖南'], tags: ['hunan'], names: ['湖南', '长沙'] },
  {
    id: 'gd',
    label: '广东',
    states: ['Guangdong', 'Kwangtung', '广东'],
    tags: ['guangdong', 'canton', 'guangzhou', 'shenzhen'],
    extraCountrycodes: ['HK'],
    names: [
      '广东', '广州', '深圳', '佛山', '东莞', '珠海', '中山', '汕头', '惠州', '江门',
      '湛江', '韶关', '揭阳', '梅州', '清远', '潮州', '汕尾', '河源', '阳江', '茂名',
      '肇庆', '云浮', '顺德', '台山', '开平', '鹤山', '恩平', '南海', '番禺',
    ],
  },
  { id: 'gx', label: '广西', states: ['Guangxi', 'Kwangsi', '广西'], tags: ['guangxi'], names: ['广西', '南宁', '桂林', '柳州'] },
  { id: 'hi', label: '海南', states: ['Hainan', '海南'], tags: ['hainan'], names: ['海南', '海口', '三亚'] },
  { id: 'cq', label: '重庆', states: ['Chongqing', '重庆'], tags: ['chongqing'], names: ['重庆'] },
  { id: 'sc', label: '四川', states: ['Sichuan', 'Szechuan', '四川'], tags: ['sichuan'], names: ['四川', '成都'] },
  { id: 'gz', label: '贵州', states: ['Guizhou', 'Kweichow', '贵州'], tags: ['guizhou'], names: ['贵州', '贵阳'] },
  { id: 'yn', label: '云南', states: ['Yunnan', '云南'], tags: ['yunnan'], names: ['云南', '昆明'] },
  { id: 'xz', label: '西藏', states: ['Tibet', 'Xizang', '西藏'], tags: ['tibet'], names: ['西藏', '拉萨'] },
  { id: 'sn', label: '陕西', states: ['Shaanxi', '陕西'], tags: ['shaanxi'], names: ['陕西', '西安'] },
  { id: 'gs', label: '甘肃', states: ['Gansu', '甘肃'], tags: ['gansu'], names: ['甘肃', '兰州'] },
  { id: 'qh', label: '青海', states: ['Qinghai', '青海'], tags: ['qinghai'], names: ['青海', '西宁'] },
  { id: 'nx', label: '宁夏', states: ['Ningxia', '宁夏'], tags: ['ningxia'], names: ['宁夏', '银川'] },
  { id: 'xj', label: '新疆', states: ['Xinjiang', '新疆'], tags: ['xinjiang'], names: ['新疆', '乌鲁木齐'] },
  { id: 'hk', label: '香港', countrycodes: ['HK'], states: ['Hong Kong', '香港'], tags: ['hongkong', 'hong kong'], names: ['香港'] },
  { id: 'mo', label: '澳门', countrycodes: ['MO'], states: ['Macao', 'Macau', '澳门'], tags: ['macao', 'macau'], names: ['澳门'] },
  { id: 'tw', label: '台湾', countrycodes: ['TW'], states: ['Taiwan', '台湾'], tags: ['taiwan'], names: ['台湾', '台北'] },
];

export const DEFAULT_REGION = 'gd';

const PROVINCE_TOKENS = REGIONS.filter((r) => r.id !== 'national' && r.id !== 'network')
  .flatMap((r) => r.names || []);

export function findRegion(id) {
  return REGIONS.find((r) => r.id === id) || REGIONS.find((r) => r.id === DEFAULT_REGION);
}

function haystack(station) {
  return {
    name: String(station.name || ''),
    state: String(station.state || '').toLowerCase(),
    country: String(station.country || '').toUpperCase(),
    tags: Array.isArray(station.tags) ? station.tags.map((t) => String(t).toLowerCase()) : [],
  };
}

function hasToken(text, token) {
  if (!token) return false;
  return text.toLowerCase().includes(String(token).toLowerCase());
}

/**
 * @param {{ name?: string, state?: string, country?: string, tags?: string[] }} station
 * @param {Region} region
 */
export function matchRegion(station, region) {
  if (!station || !region) return false;
  const h = haystack(station);
  const tokenHit = matchTokens(station, region);
  if (region.countrycodes?.length && region.countrycodes.includes(h.country)) {
    if (claimedByMainland(station) && !tokenHit) return false;
    return true;
  }
  return tokenHit;
}

function matchTokens(station, region) {
  const h = haystack(station);
  for (const s of region.states || []) {
    if (h.state && (h.state === s.toLowerCase() || h.state.includes(s.toLowerCase()))) return true;
  }
  for (const t of region.tags || []) {
    if (h.tags.includes(t.toLowerCase())) return true;
  }
  const provinceHit = PROVINCE_TOKENS.some((p) => h.name.includes(p));
  for (const n of region.exclusiveNames || []) {
    if (h.name.includes(n) && !provinceHit) return true;
  }
  for (const n of region.names || []) {
    if (hasToken(h.name, n)) return true;
  }
  return false;
}

function claimedByMainland(station) {
  return REGIONS.some(
    (r) =>
      r.id !== 'national' &&
      r.id !== 'network' &&
      !r.countrycodes &&
      matchTokens(station, r),
  );
}
/**
 * @param {Array<{ id: string, votes?: number }>} stations
 * @param {Region} region
 * @param {number} [limit]
 */
export function filterRegion(stations, region, limit = 80) {
  const seen = new Set();
  const out = [];
  for (const s of stations) {
    if (!s?.id || seen.has(s.id)) continue;
    if (!matchRegion(s, region)) continue;
    seen.add(s.id);
    out.push(s);
  }
  out.sort((a, b) => (b.votes || 0) - (a.votes || 0));
  return out.slice(0, limit);
}
