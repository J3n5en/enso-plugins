const HOST_BLOCK = /[\s/\\@,?#]|\u0000/;

/** 只允许用户写下的那一个主机名。拒绝逗号（多主机）、路径和 URL。 */
export function assertHost(host) {
  if (typeof host !== 'string') throw new Error('主机不合法');
  const text = host.trim().replace(/^\[(.*)\]$/, '$1');
  if (!text || text.length > 253) throw new Error('主机不合法');
  if (HOST_BLOCK.test(text) || text.includes('://')) throw new Error('主机名不能包含空格、逗号或路径');
  if (text.includes(':') && !/^[0-9a-fA-F:]+$/.test(text)) throw new Error('主机不合法');
  if (text === '*') throw new Error('主机不合法');
  return text;
}

export function assertPort(port) {
  const number = typeof port === 'number' ? port : Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('端口不合法');
  return number;
}

export function defaultPort(engine) {
  return engine === 'postgres' ? 5432 : 3306;
}

export function sslMode(value) {
  if (value === 'require' || value === 'verify-full' || value === 'verify-ca' || value === 'prefer' || value === 'disable') return value;
  return 'disable';
}

/** 解析 URL / 表单里的 sslmode。空、disable、allow 为不加密；未知值报错。 */
export function parseSslMode(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '' || text === 'disable' || text === 'allow') return 'disable';
  if (text === 'prefer' || text === 'require' || text === 'verify-ca' || text === 'verify-full') return text;
  throw new Error('不认识的 sslmode');
}

export function sslNote(mode) {
  const value = sslMode(mode);
  if (value === 'prefer') return '优先尝试加密';
  if (value === 'require') return '加密但不校验证书';
  if (value === 'verify-ca') return '加密并校验 CA';
  if (value === 'verify-full') return '加密并校验主机名';
  return '不加密';
}

export function postgresSsl(mode) {
  const value = sslMode(mode);
  if (value === 'prefer') return 'prefer';
  if (value === 'require') return 'require';
  if (value === 'verify-full') return 'verify-full';
  if (value === 'verify-ca') return { rejectUnauthorized: true, checkServerIdentity() {} };
  return false;
}

export function mysqlSsl(mode) {
  const value = sslMode(mode);
  if (value === 'disable') return undefined;
  if (value === 'prefer' || value === 'require') return { rejectUnauthorized: false };
  if (value === 'verify-ca') return { rejectUnauthorized: true, verifyIdentity: false };
  if (value === 'verify-full') return { rejectUnauthorized: true, verifyIdentity: true };
  return undefined;
}

/**
 * postgres.js 会把字符串主机按逗号和冒号拆开，IPv6 会被拆坏。
 * 这里始终传单元素数组，并且不传 path，避免改走 Unix socket 或其它主机。
 */
export function postgresOptions(conn, password) {
  const host = assertHost(conn.host);
  const port = assertPort(conn.port);
  const user = String(conn.user ?? '');
  const database = String(conn.database || 'postgres');
  const secret = password == null ? '' : String(password);
  const mode = sslMode(conn.sslmode);
  return {
    host: [host],
    port: [port],
    user,
    username: user,
    password: secret,
    pass: secret,
    database,
    ssl: postgresSsl(mode),
    max: 2,
    idle_timeout: null,
    connect_timeout: 15,
    fetch_types: false,
    prepare: false,
    connection: { application_name: 'enso.dbstudio' },
    types: {
      timestamp: {
        to: 1114,
        from: [1114],
        parse: (value) => value,
        serialize: (value) => value,
      },
    },
  };
}

export function mysqlOptions(conn, password) {
  const host = assertHost(conn.host);
  const port = assertPort(conn.port);
  const mode = sslMode(conn.sslmode);
  const options = {
    host,
    port,
    user: String(conn.user ?? ''),
    password: password == null ? '' : String(password),
    connectTimeout: 15_000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    charset: 'utf8mb4',
    multipleStatements: false,
    enableKeepAlive: true,
  };
  if (conn.database) options.database = String(conn.database);
  const ssl = mysqlSsl(mode);
  if (ssl) options.ssl = ssl;
  return options;
}

export function killQuerySql(threadId) {
  const text = String(threadId ?? '');
  if (!/^[1-9]\d{0,19}$/.test(text)) throw new Error('无法取消：连接编号不合法');
  return `KILL QUERY ${text}`;
}
