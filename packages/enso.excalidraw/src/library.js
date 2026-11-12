// 形状库存在插件页面的 localStorage 里。宿主把它同步到插件存储，所有白板共用，合计不超过 1MB。

const KEY = 'enso.excalidraw.library';

function read() {
  let saved;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!saved) return null;
  try {
    const data = JSON.parse(saved);
    if (Array.isArray(data?.libraryItems)) return data;
  } catch {
    /* 读不出来就挪走，避免下一次保存把它盖掉 */
  }
  try {
    localStorage.setItem(`${KEY}.unreadable`, saved);
    localStorage.removeItem(KEY);
  } catch {
    /* 配额不够时保留原值 */
  }
  return null;
}

export const libraryAdapter = {
  load() {
    return read();
  },
  save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (error) {
      const quota = error?.name === 'QuotaExceededError';
      throw new Error(quota ? '形状库太大，存不下了。请删掉一些图元，尤其是带图片的。' : '形状库没有保存成功');
    }
  },
};
