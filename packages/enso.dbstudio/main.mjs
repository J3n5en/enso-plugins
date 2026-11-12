import { createApp } from './lib/app.mjs';

let app = null;

export async function activate(enso) {
  app = createApp(enso);
  await app.ready;
  for (const [name, handler] of Object.entries(app.handlers)) enso.renderer.handle(name, handler);
}

export function deactivate() {
  app?.dispose();
  app = null;
}
