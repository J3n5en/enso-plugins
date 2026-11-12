import { quoteIdent } from './ident.mjs';
import { CHUNK_ROWS } from './limits.mjs';
import { killQuerySql, mysqlOptions, postgresOptions } from './target.mjs';

export function aborted() {
  const error = new Error('已取消');
  error.code = 'ABORTED';
  return error;
}

export function isCancel(error) {
  const code = String(error?.code ?? '');
  if (code === 'ABORTED' || code === '57014' || code === 'QUERY_CANCELLED') return true;
  if (code === 'ER_QUERY_INTERRUPTED' || code === '1317') return true;
  const message = String(error?.message ?? '');
  return /canceling statement due to user request|query execution was interrupted|已取消/i.test(message);
}

function listen(signal, stop) {
  if (!signal) return () => {};
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  return () => signal.removeEventListener('abort', stop);
}

export function createPostgres(postgres, conn, password) {
  const options = postgresOptions(conn, password);
  const sql = postgres(options);
  return new PostgresSession(sql, options);
}

class PostgresSession {
  constructor(sql, options) {
    this.sql = sql;
    this.options = options;
    this.reserved = null;
    this.query = null;
    this.iterator = null;
    this.columns = [];
    this.batch = [];
    this.closed = false;
  }

  async reserve() {
    if (!this.reserved) this.reserved = await this.sql.reserve();
    return this.reserved;
  }

  async simple(text, params = [], signal) {
    const reserved = await this.reserve();
    const query = reserved.unsafe(text, params);
    const stop = () => {
      void query.cancel?.().catch(() => {});
    };
    const unlisten = listen(signal, stop);
    try {
      return await query;
    } finally {
      unlisten();
    }
  }

  async configure(seconds, schema) {
    const reserved = await this.reserve();
    await reserved.unsafe(`SELECT set_config('statement_timeout', $1, false)`, [`${seconds}s`]);
    if (schema) await reserved.unsafe(`SELECT set_config('search_path', $1, false)`, [schema]);
  }

  async exec(text, signal) {
    const reserved = await this.reserve();
    const query = reserved.unsafe(text);
    const stop = () => {
      void query.cancel().catch(() => {});
    };
    const unlisten = listen(signal, stop);
    try {
      const result = await query;
      return Number(result?.count ?? 0);
    } finally {
      unlisten();
    }
  }

  async start(text, signal) {
    await this.finishCursor();
    const reserved = await this.reserve();
    const query = reserved.unsafe(text).raw();
    this.query = query;
    const stop = () => {
      void query.cancel().catch(() => {});
    };
    this.unlisten = listen(signal, stop);
    this.signal = signal;
    this.iterator = query.cursor(CHUNK_ROWS)[Symbol.asyncIterator]();
    this.batch = [];
    this.columns = [];
  }

  async pull(count) {
    const rows = [];
    while (rows.length < count) {
      if (this.signal?.aborted) throw aborted();
      if (!this.batch.length) {
        const step = await this.iterator.next();
        if (step.done) return { columns: this.columns, rows, done: true };
        const batch = step.value;
        if (batch.columns?.length) {
          this.columns = batch.columns.map((column) => ({ name: column.name, type: String(column.type ?? '') }));
        }
        this.batch = [...batch];
        if (!this.batch.length) return { columns: this.columns, rows, done: true };
      }
      rows.push(this.batch.shift());
    }
    return { columns: this.columns, rows, done: false };
  }

  async finishCursor() {
    this.unlisten?.();
    this.unlisten = null;
    const iterator = this.iterator;
    this.iterator = null;
    this.query = null;
    this.batch = [];
    try {
      await iterator?.return?.();
    } catch {
      // 门户已经关掉
    }
  }

  async cancel() {
    const query = this.query;
    try {
      await query?.cancel();
    } catch {
      // 取消请求本身失败时仍然关掉连接
    }
    await this.finishCursor();
    await this.end();
  }

  async end() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reserved?.release?.();
    } catch {
      // 连接已经不在池里
    }
    try {
      await this.sql.end({ timeout: 1 });
    } catch {
      // 正在退出
    }
  }
}

export async function createMysql(createConnection, conn, password) {
  const options = mysqlOptions(conn, password);
  const session = new MysqlSession(createConnection, options, conn.engine);
  await session.open();
  return session;
}

class MysqlSession {
  constructor(createConnection, options, engine) {
    this.createConnection = createConnection;
    this.options = options;
    this.engine = engine;
    this.connection = null;
    this.threadId = null;
    this.stream = null;
    this.signal = null;
    this.closed = false;
  }

  async open() {
    this.connection = await this.createConnection(this.options);
    const [rows] = await this.connection.query('SELECT CONNECTION_ID() AS id');
    const id = rows?.[0]?.id ?? rows?.[0]?.ID;
    this.threadId = String(id);
    if (!/^[1-9]\d{0,19}$/.test(this.threadId)) throw new Error('没有拿到连接编号，无法在需要时取消查询');
  }

  async simple(text, params = [], signal) {
    const stop = () => {
      void this.kill();
    };
    const unlisten = listen(signal, stop);
    try {
      const [rows, fields] = await this.connection.query(text, params);
      return { rows, fields };
    } finally {
      unlisten();
    }
  }

  async configure(seconds, database) {
    const ms = seconds * 1000;
    try {
      if (this.engine === 'mariadb') await this.connection.query(`SET SESSION max_statement_time = ${seconds}`);
      else await this.connection.query(`SET SESSION MAX_EXECUTION_TIME = ${ms}`);
    } catch {
      // 老版本没有会话级超时，取消仍走 KILL QUERY。
    }
    if (database) await this.connection.query(`USE ${quoteIdent('mysql', database)}`);
  }

  async exec(text, signal) {
    const stop = () => {
      void this.kill();
    };
    const unlisten = listen(signal, stop);
    try {
      const [result] = await this.connection.query(text);
      return Number(result?.affectedRows ?? 0);
    } finally {
      unlisten();
    }
  }

  start(text, signal) {
    this.finishStream();
    const query = this.connection.connection.query(text);
    const stream = query.stream({ highWaterMark: 16 });
    const state = { buffer: [], fields: [], ended: false, failed: null, notify: () => {} };
    stream.on('fields', (fields) => {
      state.fields = fields || [];
    });
    stream.on('data', (row) => {
      state.buffer.push(row);
      if (state.buffer.length >= CHUNK_ROWS) stream.pause();
      state.notify();
    });
    stream.on('end', () => {
      state.ended = true;
      state.notify();
    });
    stream.on('error', (error) => {
      state.failed = error;
      state.ended = true;
      state.notify();
    });
    this.stream = stream;
    this.streamState = state;
    this.signal = signal;
    this.unlisten = listen(signal, () => {
      void this.kill();
    });
  }

  columns() {
    const fields = this.streamState?.fields || [];
    return fields.map((field) => ({ name: field.name, type: String(field.type ?? '') }));
  }

  async pull(count) {
    const state = this.streamState;
    const stream = this.stream;
    if (!state || !stream) return { columns: [], rows: [], done: true };
    while (state.buffer.length < count && !state.ended) {
      if (this.signal?.aborted) throw aborted();
      stream.resume();
      await new Promise((resolve) => {
        state.notify = resolve;
      });
    }
    if (state.failed && !state.buffer.length) throw state.failed;
    const fields = state.fields;
    const slice = state.buffer.splice(0, count);
    const rows = slice.map((row) => (Array.isArray(row) ? row : fields.map((field) => row[field.name])));
    return { columns: this.columns(), rows, done: state.ended && state.buffer.length === 0 };
  }

  finishCursor() {
    this.finishStream();
  }

  finishStream() {
    this.unlisten?.();
    this.unlisten = null;
    const stream = this.stream;
    this.stream = null;
    this.streamState = null;
    if (stream && !stream.destroyed) stream.destroy();
  }

  async kill() {
    try {
      const side = await this.createConnection(this.options);
      try {
        await side.query(killQuerySql(this.threadId));
      } finally {
        await side.end().catch(() => {});
      }
    } catch {
      // 查询可能已经结束
    }
    this.finishStream();
  }

  async cancel() {
    await this.kill();
    try {
      this.connection?.destroy();
    } catch {
      // 连接已经断了
    }
    this.connection = null;
    this.closed = true;
  }

  async end() {
    if (this.closed) return;
    this.closed = true;
    this.finishStream();
    try {
      await this.connection?.end();
    } catch {
      this.connection?.destroy();
    }
  }
}
