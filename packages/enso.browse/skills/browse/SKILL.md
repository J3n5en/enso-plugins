---
name: browse
description: 在 Enso 里用原版 browse 操作用户自己的浏览器。扩展和中继都是官方的。
---

# 在 Enso 里用 browse

浏览器工具来自原版 `browse`：本机已经装好的那份，或者 Browse 插件下载到自己目录里的那份。它经插件的 MCP 服务接入，给出 `execute`、`tabs`、`status` 三个工具，用法以 MCP 服务自带的说明为准。

- 只用这几个 MCP 工具（名字带 `browse` 前缀）。不要在 bash 里跑 `browse` 命令行代替：命令行的参数写法不同，也不在会话的工具约束里。
- 会话里没有这些工具，说明这个会话启动时 browse 的 MCP 服务没有起来。告诉用户：打开 Enso 右侧栏的 Browse 页，按提示装好 browse，再开一个新会话。不要自己安装，也不要改用命令行。
- 扩展是 Chrome 网上应用店里的 browse，不是插件自带的。没连上时让用户打开 Enso 右侧栏的 Browse 页：那里有商店链接和配对码。不要另装一份扩展，也不要改中继端口。
