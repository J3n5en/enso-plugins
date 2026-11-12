const HTTP = /^https?:\/\//i;

export function activate(enso) {
  enso.renderer.handle('open-link', async (args) => {
    const url = args && typeof args === 'object' ? args.url : '';
    if (typeof url !== 'string' || !HTTP.test(url)) return { opened: false };
    await enso.ui.openExternal(url);
    return { opened: true };
  });
}
