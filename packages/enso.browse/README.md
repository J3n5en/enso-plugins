# Browse

直接用你已经安装的 [OpenCode Browse](https://github.com/anomalyco/browse)：官方 Chrome 扩展，官方中继。插件不自带浏览器程序，也不再复制一份扩展。

代理用你自己的 Chrome，带着你的登录和你装的扩展。它在后台开标签，读页面、点击、输入、截图、录屏、抓包。轮到你的时候（登录、两步验证、付款），页面上出现卡片，你做完点 **Continue**。

## 需要先有

1. 原版 browse 二进制。两种方式任选：

   - 在侧栏点 **下载 browse**。插件从官方发布服务（`anoma.ly/release`）下载当前 stable 版本，核对大小和 sha256 后放进插件数据目录。不跑 `browse install`，所以不改 PATH，也不写其它 agent 的配置；卸载插件时一起删掉。这份不会自己更新，在侧栏点 **更新到最新版** 即可。
   - 自己运行官方安装脚本。它会装到 `~/.local/bin/browse`（Windows 是 `%USERPROFILE%\.local\bin\browse.exe`），然后运行 `browse install`，把 browse 加进 PATH，并接入你选的 agent：

   ```bash
   curl -fsSL https://opencode.ai/browse/install | bash
   ```

   Windows 用 PowerShell：

   ```powershell
   irm https://opencode.ai/browse/install.ps1 | iex
   ```

   两样都有的时候，用已经装好的那份。中继、配对数据和 `19988` 端口只有一套，两份共用。

2. Chrome 网上应用店里的 browse 扩展：<https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg>

装过 OpenCode 的 browse 的话，这两样通常已经有了，扩展也已经配过对。

## 配对

打开 Enso 右侧栏的 **Browse** 页。已经配过对的浏览器会直接显示已连接。

还没有的话，侧栏给出一次性码。在 Chrome 里点扩展菜单 → **browse** → **Options**，展开 advanced（或 Pair with a code），填入这个码，点 Connect。端口用官方默认的 `127.0.0.1:19988`，不用改。

## 代理能做的

工具就是 browse 给 Claude Code、Codex 这类客户端的那一套：

| 工具 | 作用 |
| --- | --- |
| `execute` | 在中继的沙箱里跑一段 JavaScript：有 `page`（Playwright 风格）、`snapshot()`、`ref()`、`handoff()`，以及 `browse.<工具>()` 调到 browse 的全部能力（截图、抓包、录屏等）。一段脚本可以做好几步 |
| `tabs` | 列出、打开、关闭标签，包括你借出的标签 |
| `status` | 中继和配对状态 |

给哪一套工具由中继决定：它看 MCP 客户端的名字，只有 OpenCode 拿到拆开的 `navigate`、`click` 等。中继是整台机器共用的，插件不去改它，免得其它 agent 拿到的工具也跟着变。

数据、配对和更新都归原版 browse：`~/.local/share/browse`，端口 `19988`，扩展自己更新，中继按 browse 自己的方式更新。
