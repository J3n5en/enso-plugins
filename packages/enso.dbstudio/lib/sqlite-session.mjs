import { Worker } from 'node:worker_threads';
import { CHUNK_ROWS } from './limits.mjs';

const workerUrl = new URL('../db-worker.mjs', import.meta.url);

function aborted() {
  const error = new Error('已取消');
  error.code = 'ABORTED';
  return error;
}

export class SqliteSession {
  constructor(file) {
    this.file = file;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.kind = null;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dropWorker() {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(aborted());
    if (worker) void worker.terminate();
  }

  ensure() {
    if (this.worker) return;
    const worker = new Worker(workerUrl);
    this.worker = worker;
    worker.on('message', (message) => {
      if (!message || this.worker !== worker) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error || '查询失败'), { code: message.code }));
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) this.rejectAll(new Error('查询线程已退出'));
    });
  }

  call(op, payload) {
    this.ensure();
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...payload });
    });
  }

  async open() {
    const result = await this.call('open', { path: this.file.real, size: this.file.size });
    this.kind = result.kind;
    return result;
  }

  async ready() {
    if (!this.kind) await this.open();
  }

  async all(sql) {
    await this.ready();
    return this.call('all', { sql });
  }

  async exec(sql) {
    await this.ready();
    return this.call('exec', { sql });
  }

  async query(sql) {
    await this.ready();
    return this.call('query', { sql, count: CHUNK_ROWS });
  }

  async more() {
    await this.ready();
    return this.call('more', { count: CHUNK_ROWS });
  }

  cancel() {
    this.kind = null;
    this.dropWorker();
  }

  close() {
    this.cancel();
  }
}
