import { loadReport } from './lib/disk.mjs';

/** @param {import('enso-plugin').EnsoMain} enso */
export function activate(enso) {
  enso.renderer.handle('report', (args) =>
    loadReport({
      filter: args && typeof args === 'object' ? args : {},
      cacheDir: enso.dataDir,
    }),
  );
}
