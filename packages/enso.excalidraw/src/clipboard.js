// 沙箱里系统剪贴板经常写不进去。写失败时把文本留在这里，本页的粘贴仍然能用。
// 焦点离开或发生了别的复制，就丢掉，避免粘进过期内容。

let copiedText = null;

const clipboard = navigator.clipboard;
const writeText = clipboard?.writeText?.bind(clipboard);
if (writeText && clipboard) {
  try {
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        try {
          await writeText(text);
          copiedText = null;
        } catch (error) {
          copiedText = String(text);
          throw error;
        }
      },
    });
  } catch {
    /* 剪贴板对象不可改时，复制失败就只能靠系统剪贴板 */
  }
}

const forget = (event) => {
  if (event.type !== 'blur' || event.target === window) copiedText = null;
};
window.addEventListener('blur', forget);
window.addEventListener('copy', forget, true);
window.addEventListener('cut', forget, true);

window.addEventListener(
  'paste',
  (event) => {
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!event.isTrusted || copiedText === null || pasted === copiedText) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const data = new DataTransfer();
    data.setData('text/plain', copiedText);
    event.target?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  },
  true,
);
