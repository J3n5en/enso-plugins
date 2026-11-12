import { Worker } from 'node:worker_threads';

const workerUrl = new URL('../db-worker.mjs', import.meta.url);

export class DatabaseSession {
  constructor() {
    this.worker = null;
    this.bytes = null;
    this.pending = new Map();
    this.seq = 0;
    this.meta = null;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dropWorker() {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(new Error('已取消'));
    if (worker) void worker.terminate();
  }

  ensureWorker() {
    if (this.worker) return;
    const worker = new Worker(workerUrl);
    this.worker = worker;
    worker.on('message', (message) => {
      if (!message || this.worker !== worker) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || '查询失败'));
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) this.rejectAll(new Error('查询进程已退出'));
    });
  }

  call(op, payload, transfer) {
    this.ensureWorker();
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...payload }, transfer ?? []);
    });
  }

  async open(bytes, meta) {
    this.dropWorker();
    this.bytes = bytes;
    this.meta = meta;
    const objects = await this.call('open', { bytes });
    return objects;
  }

  async request(op, payload) {
    if (!this.bytes) throw new Error('数据库还没有打开');
    if (!this.worker) await this.call('open', { bytes: this.bytes });
    return this.call(op, payload);
  }

  cancel() {
    this.dropWorker();
  }

  dispose() {
    this.bytes = null;
    this.meta = null;
    this.dropWorker();
  }
}

const sessions = new Map();
const MAX_SESSIONS = 6;

function touch(key, session) {
  sessions.delete(key);
  sessions.set(key, session);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.get(oldest)?.dispose();
    sessions.delete(oldest);
  }
}

export function sessionKey(sessionId, rel) {
  return `${sessionId ?? 'none'}\0${rel}`;
}

export function takeSession(sessionId, rel) {
  const key = sessionKey(sessionId, rel);
  let session = sessions.get(key);
  if (!session) {
    session = new DatabaseSession();
    touch(key, session);
  } else {
    touch(key, session);
  }
  return session;
}

export function disposeSessions() {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}
