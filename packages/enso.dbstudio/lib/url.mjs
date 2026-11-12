import { assertHost, assertPort, defaultPort, sslMode } from './target.mjs';

const SERVERS = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mariadb',
};

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('连接串里有非法的转义');
  }
}

/**
 * 只认 URL 权威部分里的主机。查询参数里的 host、port、socket 一律忽略，
 * 避免 `?host=其他机器` 把连接带到用户没写在主机栏里的地址。
 * `sslmode=verify-ca` 按 require 处理：加密，但不校验证书（没有 CA 文件入口）。
 */
export function parseServerUrl(input) {
  const text = String(input ?? '').trim();
  if (/[\r\n\0]/.test(text)) throw new Error('连接串不能换行');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('连接串无法解析');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const engine = SERVERS[scheme];
  if (!engine) throw new Error('只接受 postgres://、mysql:// 或 mariadb://');
  if (url.username === '' && text.includes('@') === false) {
    // 允许无用户名
  }
  const host = assertHost(url.hostname);
  const port = url.port ? assertPort(url.port) : defaultPort(engine);
  const user = decodePart(url.username);
  const password = decodePart(url.password);
  const database = decodePart(url.pathname.replace(/^\/+/, ''));
  if (database.includes('/') || database.includes('\0')) throw new Error('数据库名不合法');
  const rawSsl = (url.searchParams.get('sslmode') || url.searchParams.get('ssl') || '').toLowerCase();
  let mode = 'disable';
  if (rawSsl === '' || rawSsl === 'disable' || rawSsl === 'allow' || rawSsl === 'prefer') mode = 'disable';
  else if (rawSsl === 'require' || rawSsl === 'verify-ca') mode = 'require';
  else if (rawSsl === 'verify-full') mode = 'verify-full';
  else throw new Error('不认识的 sslmode');
  return { engine, host, port, user, password, database, sslmode: sslMode(mode) };
}

export function sqlitePathFromUrl(input) {
  const text = String(input ?? '').trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error('路径不合法');
  const match = /^(sqlite|file):/i.exec(text);
  if (!match) return text;
  const body = text.slice(match[0].length).split('?')[0].split('#')[0];
  let path = body;
  if (path.startsWith('///')) path = path.slice(2);
  else if (path.startsWith('//')) {
    const rest = path.slice(2);
    const slash = rest.indexOf('/');
    if (slash === -1) throw new Error('SQLite 路径不合法');
    const host = rest.slice(0, slash);
    if (host && host.toLowerCase() !== 'localhost') throw new Error('SQLite 只能打开本机文件');
    path = rest.slice(slash);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error('路径里有非法的转义');
  }
  if (!path || path.includes('\0')) throw new Error('路径不合法');
  return path;
}

export function parseConnectionInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('连接串是空的');
  if (/^(postgres|postgresql|mysql|mysql2|mariadb):\/\//i.test(text)) return parseServerUrl(text);
  if (/^(sqlite|file):/i.test(text)) return { engine: 'sqlite', path: sqlitePathFromUrl(text), password: '' };
  throw new Error('请粘贴 postgres://、mysql://、mariadb:// 或 sqlite: 路径');
}
