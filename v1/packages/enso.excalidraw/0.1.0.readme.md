# Excalidraw

在 Enso 里打开并编辑 Excalidraw 白板。匹配 `.excalidraw`、`.excalidraw.json` 和带嵌入场景的 `.excalidraw.svg`，并且是这些后缀的默认打开方式。

文件仍归 Enso 管：画布上的修改通过文件查看器交回编辑区，标签变成未保存，用原来的保存（⌘S / Ctrl+S）写入磁盘。查看器拿不到磁盘路径，也不会自己写文件。

## 使用

1. 在项目里打开上述后缀的文件，编辑器会直接进入 Excalidraw。
2. 画完后保存文件。空白文件在第一次落笔之后才会变成白板内容。
3. 别人或会话改了磁盘上的文件时，画布会跟上。如果这边还有没写回的修改，按元素合并：你改过的元素留在你这边，其余采用外面的版本。
4. `.excalidraw.svg` 保存时会按当前画面重画 SVG，并把场景嵌回去，所以文件既能当图片看，也能再打开接着画。
5. 形状库存在插件页面存储里，同一插件打开的白板共用，合计不超过 1MB。
6. 元素上的 http(s) 链接用系统浏览器打开。

界面跟随 Enso 的浅色或深色主题，语言跟随浏览器。中日韩文字使用系统字体。

`.excalidraw.png` 是二进制图片。文件查看器只接收文本，所以打不开这种文件。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 作为文件查看器打开白板 |
| `ui.openExternal` | 打开元素上的网页链接 |

编辑器打包了 [Excalidraw](https://github.com/excalidraw/excalidraw) 0.18（MIT），以及 React 与字体。重新打包：把依赖装到别处后执行 `EXCALIDRAW_MODULES=/path/to/node_modules node build.mjs`。不要把 `node_modules` 放进插件目录。
