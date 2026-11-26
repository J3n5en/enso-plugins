/**
 * Host bridge for AGY's Swarm pane.
 *
 * The pane itself (index.html + app.js + hive.js + css) is AGY's own code,
 * unchanged. AGY serves it from a loopback HTTP server and hands it a
 * `window.sidecar` object from its Electron preload; Enso runs plugin pages in
 * a sandboxed iframe with no network, so this file supplies the same two
 * objects the pane expects and routes them over the plugin MessagePort:
 *
 *   window.sidecar.fetch(path)  -> enso.call('api', { url })        (GET only)
 *   window.sidecar.ui.*         -> the matching host action, or a no-op
 *   localStorage                -> enso.storage (opaque origin has no storage)
 */
(function () {
  const api = (window.enso && window.enso.call) || (() => Promise.reject(new Error('no host bridge')));

  class BridgeResponse {
    constructor(result) {
      this.status = Number(result && result.status) || 500;
      this.ok = this.status >= 200 && this.status < 300;
      this.statusText = '';
      this.headers = { get: (name) => (result && result.headers ? result.headers[String(name).toLowerCase()] : null) };
      this._result = result || {};
    }
    async text() {
      return typeof this._result.text === 'string' ? this._result.text : '';
    }
    async json() {
      const text = await this.text();
      if (!text) throw new Error(`empty response (${this.status})`);
      return JSON.parse(text);
    }
    async arrayBuffer() {
      const base64 = this._result.base64 || '';
      const bytes = atob(base64);
      const out = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
      return out.buffer;
    }
    async blob() {
      const type = (this._result.contentType || 'application/octet-stream').split(';')[0];
      return new Blob([await this.arrayBuffer()], { type });
    }
  }

  // The plugin page API has no notify(): a failure has to be said in the page,
  // or a click that cannot open anything looks like a dead button.
  function say(text) {
    const box = document.createElement('div');
    box.textContent = String(text);
    box.setAttribute('data-swarm-toast', '');
    Object.assign(box.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      maxWidth: '80%',
      padding: '8px 14px',
      borderRadius: '8px',
      background: 'var(--foreground, #1f2328)',
      color: 'var(--background, #fff)',
      font: '13px/1.4 var(--font-family, system-ui, sans-serif)',
      boxShadow: '0 6px 24px rgba(0,0,0,.28)',
      zIndex: 9999,
      opacity: '0',
      transition: 'opacity .15s ease',
      pointerEvents: 'none',
    });
    document.body.appendChild(box);
    requestAnimationFrame(() => {
      box.style.opacity = '1';
    });
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 200);
    }, 2600);
  }

  // The pane only reads through window.sidecar.fetch; a bare `fetch` would try
  // the (nonexistent) page origin, so it is routed through the same bridge.
  const bridgeFetch = async (path) => new BridgeResponse(await api('api', { url: String(path) }));
  window.sidecar = Object.assign(window.sidecar || {}, {
    fetch: bridgeFetch,
    ui: Object.assign(window.sidecar && window.sidecar.ui ? window.sidecar.ui : {}, {
      toggleConversation(convId) {
        // AGY switches to a member's conversation. Every upstream open path
        // (member card, graph node, Overview action, an alert's target) funnels
        // here, so this one call is what makes the whole pane clickable.
        return enso
          .call('openMember', { conv: String(convId || '') })
          .then((res) => {
            if (res && res.ok === false) say(res.message || 'cannot open that member');
          })
          .catch((error) => say(String((error && error.message) || error)));
      },
      toggleAuxPane() {
        return Promise.resolve();
      },
    }),
  });

  // Opaque-origin documents throw on localStorage; back it with the plugin's
  // own view storage so remembered toggles survive a reload.
  const store = (window.enso && window.enso.storage) || null;
  if (store) {
    const shim = {
      getItem: (key) => store.get(String(key)),
      setItem: (key, value) => store.set(String(key), String(value)),
      removeItem: (key) => store.remove(String(key)),
      clear: () => {},
      key: () => null,
      get length() {
        return 0;
      },
    };
    try {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim });
    } catch (error) {
      window.__ensoLS = shim;
    }
  }

  document.documentElement.dataset.theme =
    (window.enso && window.enso.theme) === 'dark' ? 'dark' : 'light';

  // Design tokens the pane's CSS expects from the host (it ships literal
  // fallbacks, so these only need to land once).
  const tokens = {
    light: ['#ffffff', '#1f2328', '#0969da', '#6e7781', '#d0d7de', '#f6f8fa'],
    dark: ['#1e1e20', '#e6edf3', '#4493f8', '#8b949e', '#30363d', '#26262a'],
  };
  const apply = (theme) => {
    const [bg, fg, primary, muted, border, surface] = tokens[theme === 'dark' ? 'dark' : 'light'];
    const root = document.documentElement.style;
    root.setProperty('--background', bg);
    root.setProperty('--foreground', fg);
    root.setProperty('--primary', primary);
    root.setProperty('--muted-foreground', muted);
    root.setProperty('--border', border);
    root.setProperty('--surface', surface);
    root.setProperty('--font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  };
  apply((window.enso && window.enso.theme) || 'light');
  if (window.enso && window.enso.onTheme) window.enso.onTheme(apply);
})();

// 界面汉化：i18n.js 只做外壳文字的运行时替换，不碰 AGY 的原版代码。
if (window.__swarmZh && window.__swarmZh.install) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.__swarmZh.install, { once: true });
  else window.__swarmZh.install();
}
