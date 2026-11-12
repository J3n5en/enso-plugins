const ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'sqlite']);
const ENVS = new Set(['', 'local', 'dev', 'staging', 'prod']);
const PUBLIC_KEYS = ['id', 'name', 'engine', 'env', 'host', 'port', 'user', 'database', 'sslmode', 'path'];

export function newConnectionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `c_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** 落盘的连接没有密码、原始 URL 或其它凭据字段。 */
export function publicConnection(record) {
  const out = {};
  for (const key of PUBLIC_KEYS) {
    if (record[key] !== undefined && record[key] !== '') out[key] = record[key];
  }
  if (record.env === '') out.env = '';
  out.id = record.id;
  out.name = record.name;
  out.engine = record.engine;
  if (out.env === undefined) out.env = record.env || '';
  return out;
}

export function normalizeRecord(input, id) {
  if (!input || typeof input !== 'object') throw new Error('连接不合法');
  const engine = input.engine;
  if (!ENGINES.has(engine)) throw new Error('数据库类型不支持');
  const env = input.env == null || input.env === '' ? '' : String(input.env);
  if (!ENVS.has(env)) throw new Error('环境标签只能是 local、dev、staging、prod');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('请填写 80 字以内的名称');
  if (/[\r\n\0]/.test(name)) throw new Error('名称不合法');
  if (engine === 'sqlite') {
    const path = String(input.path ?? '').trim();
    if (!path || path.length > 4096 || path.includes('\0')) throw new Error('请填写 SQLite 文件路径');
    return { id, name, engine, env, path };
  }
  const host = String(input.host ?? '').trim();
  const port = Number(input.port);
  const user = String(input.user ?? '');
  const database = String(input.database ?? '').trim();
  const sslmode = input.sslmode === 'require' || input.sslmode === 'verify-full' ? input.sslmode : 'disable';
  if (user.length > 200 || database.length > 200) throw new Error('用户名或数据库名过长');
  if (/[\r\n\0]/.test(user) || /[\r\n\0]/.test(database)) throw new Error('用户名或数据库名不合法');
  return {
    id,
    name,
    engine,
    env,
    host,
    port,
    user,
    database,
    sslmode,
  };
}

export function stripSecrets(record) {
  return publicConnection(normalizeRecord(record, record.id));
}
