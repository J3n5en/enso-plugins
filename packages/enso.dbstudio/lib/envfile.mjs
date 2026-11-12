import { parseConnectionInput } from './url.mjs';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 只解析需要的那一个变量。不展开其它变量，也不保留整份文件。 */
export function parseEnv(text) {
  const out = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * `.env.local` 覆盖 `.env`。返回给界面的对象没有密码和原始 URL。
 * secret 只留在调用方的内存里，用来当次连接。
 */
export function connectionFromEnv(envText, localText, varName) {
  const name = KEY.test(varName) ? varName : '';
  if (!name) return null;
  const merged = { ...parseEnv(envText), ...parseEnv(localText) };
  const raw = merged[name];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = parseConnectionInput(raw.trim());
  } catch {
    return { error: `${name} 不是 postgres://、mysql://、mariadb:// 或 sqlite: 连接` };
  }
  const pub = {
    id: 'env',
    source: 'env',
    name,
    engine: parsed.engine,
    env: '',
    hasPassword: Boolean(parsed.password),
  };
  if (parsed.engine === 'sqlite') pub.path = parsed.path;
  else {
    pub.host = parsed.host;
    pub.port = parsed.port;
    pub.user = parsed.user;
    pub.database = parsed.database;
    pub.sslmode = parsed.sslmode;
  }
  return { public: pub, secret: parsed };
}
