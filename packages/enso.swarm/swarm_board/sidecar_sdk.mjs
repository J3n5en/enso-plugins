/**
 * In-process replacement for AGY's `sidecar_sdk`.
 *
 * Upstream swarm_board/main.mjs registers its routes on a SidecarApp and calls
 * `app.run()` to listen on a loopback port. Inside an Enso plugin there is no
 * port and no CORS: the pane reaches the same handlers through the MessagePort
 * bridge (`enso.call('api', { url })`), so this shim records the routes and
 * exposes `handle(url)` instead of listening. The upstream file therefore only
 * needs its import specifier changed (one line); everything else, including the
 * request handling and payload shapes, stays byte-identical.
 */

export class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = Number(init.status) || 200;
    this.contentType = init.contentType || 'text/plain; charset=utf-8';
    this.headers = init.headers && typeof init.headers === 'object' ? init.headers : {};
  }
}

export class SidecarApp {
  constructor() {
    this.config = {};
    this.routes = new Map();
    // Upstream builds its routes at import time; the host picks the instance up here.
    globalThis.__sidecarApp = this;
  }

  page(path, handler) {
    this.routes.set(`GET ${path}`, handler);
  }

  api(path, handler, method = 'POST') {
    this.routes.set(`${String(method || 'POST').toUpperCase()} ${path}`, handler);
  }

  /** No-op: the host drives handle() instead of a loopback listener. */
  run() {}

  /**
   * Dispatches one URL to the registered handler and normalizes the result to
   * `{ status, contentType, text?, base64? }`, the shape the pane's fetch shim
   * turns back into a Response.
   */
  async handle(url) {
    const raw = String(url || '');
    const at = raw.indexOf('?');
    const path = at < 0 ? raw : raw.slice(0, at);
    const query = at < 0 ? '' : raw.slice(at + 1);
    const handler = this.routes.get(`GET ${path}`);
    if (!handler) return { status: 404, contentType: 'text/plain; charset=utf-8', text: 'not found' };
    const data = Object.fromEntries(new URLSearchParams(query));
    let out;
    try {
      out = await handler(data);
    } catch (error) {
      return {
        status: 500,
        contentType: 'text/plain; charset=utf-8',
        text: String(error && error.message ? error.message : error),
      };
    }
    if (out instanceof Response) {
      const body = out.body;
      if (typeof body === 'string') {
        return { status: out.status, contentType: out.contentType, text: body, headers: out.headers };
      }
      return {
        status: out.status,
        contentType: out.contentType,
        base64: Buffer.from(body ?? '').toString('base64'),
        headers: out.headers,
      };
    }
    return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      text: JSON.stringify(out ?? null),
    };
  }
}

export default { SidecarApp, Response };
