<div align="center">

# Enso 插件市场

EnsoCode 官方插件市场的源仓库 · [浏览插件](https://enso-plugins.j3.do/) · [提交插件](#贡献插件)

</div>

社区通过 Pull Request 提交插件。合并到 `main` 后，CI 打包、签名，并把产物发布到 `dist` 分支；Cloudflare Worker（`enso-plugins.j3.do`）回源 `dist` 并缓存到 R2。

客户端不信任任何一个分发节点，只校验 **Ed25519 签名**和 zip 的 **sha256**。

## 目录

- [插件列表](#插件列表)
- [仓库结构](#仓库结构)
- [贡献插件](#贡献插件)
- [审核规则](#审核规则)
- [界面与设计规范](#界面与设计规范)
- [发布](#发布)
- [Worker](#worker)
- [外部插件](#外部插件)
- [下架](#下架)
- [友链](#友链)

## 插件列表

在 EnsoCode 中打开 **设置 → 插件 → 市场** 安装，或访问网页目录 <https://enso-plugins.j3.do/>。

<!-- plugins:start -->
| 插件 | id | 版本 | 来源 | 介绍 |
| --- | --- | --- | --- | --- |
| 爱丽丝的茶会 | `aierlanta.alicetheme` | 0.3.1 | 社区 | 爱丽丝的茶会主题：蓝白格纹配蕾丝，Alice 趴在输入框上，侧栏、待办和代码块各有茶会小摆件，随会话状态换表情。另有奶油黄配色的「爱丽丝的茶会 · 蜂蜜」，和带花园壁纸的「爱丽丝的茶会 · 花园」（深浅色和运行中、等待、出错各一张）。作者 Alice Aierlanta。 |
| [BCE Prompt Enhance](https://github.com/linqiu919/dsh-bce) | `dsh.bce` | 0.1.5 | 社区 · [`linqiu919/dsh-bce`](https://github.com/linqiu919/dsh-bce) | Better Context Engine 提示词增强：增量索引项目，精准补全代码上下文，让提问更清楚、回答更准确。 |
| Session Bridge | `enso.bridge` | 1.0.0 | 官方 | 跨会话桥：同项目的多个会话可在侧栏群聊室中互相提问、委托与回传结论。 |
| Bugbot Review | `enso.bugbot` | 0.1.0 | 官方 | 移植自 Cursor review-bugbot 与 Agent Review：本地 Git diff 组装（自动识别默认基准分支、剔除 linguist-generated 文件、合并 .cursor/BUGBOT.md 规则与最小改动行数门禁）、只读 bugbot 审查子代理、/review-bugbot 技能以及侧栏 Findings 面板与一键 Fix in Chat。 |
| Context Window | `enso.context` | 0.1.3 | 官方 | 侧栏里看当前会话的上下文窗口：各部分占多少、还剩多少、提示词缓存命中率。 |
| Notes | `enso.example.notes` | 1.0.3 | 官方 | 侧栏里的便签：存在插件自己的数据目录，可一键插入输入框。 |
| Sage Focus · 鼠尾草·专注（仅深色模式） | `enso.example.sagefocus` | 1.0.3 | 社区 | 仅在深色模式下生效，浅色模式沿用 Enso 默认配色。低饱和暖灰绿主题，不修改编辑器语法高亮或终端配色。 |
| Word Stats | `enso.example.wordstats` | 1.0.3 | 官方 | 统计项目里文本文件的字数、行数与高频词，结果以卡片展示；提供条形图代码块。 |
| 番茄小说 | `enso.fanqie` | 0.1.2 | 社区 | 在侧栏里浏览、搜索并阅读番茄免费小说（基于 openfanqie 匿名 SDK）。仅供学习研究。 |
| GitHub | `enso.github` | 0.2.0 | 官方 | 在侧栏查看、回复、关闭和重开当前项目的 GitHub issue 与 PR，也可查看 Actions 运行、失败原因与日志，并重跑或取消。会话里的 agent 也能调用。支持设备码登录，已登录的 gh CLI 可直接复用。 |
| 红果短剧 | `enso.hongguo` | 0.2.11 | 社区 | 在侧栏里浏览、搜索并播放红果短剧（基于 openhongguo 匿名 SDK）。仅供学习研究。 |
| Kanban | `enso.kanban` | 1.0.3 | 官方 | 项目看板：同一项目的所有会话共享，人和会话都能创建、编辑、拖动卡片。 |
| 噜噜和噜妹 | `enso.lulu` | 0.1.0 | 官方 | 噜噜和噜妹主题：奶油橘底配焦糖棕，两人在侧栏并排，噜噜在输入框后探头，思考时托腮。 |
| Monokai Pro | `enso.monokaipro` | 1.0.0 | 社区 | Monokai Pro 风格深浅双色主题：炭黑/暖白画布，粉强调色，偏精致专业。 |
| 奶龙 | `enso.nailong` | 0.1.5 | 官方 | 奶龙主题：奶油黄配巧克力棕，奶龙在输入框后面探头、在侧栏躺平、思考时「在忙」。 |
| 奶蛙 | `enso.naiwa` | 0.1.2 | 官方 | 奶蛙主题：荷叶绿配奶黄，奶蛙在输入框后面探头、在侧栏爬行、思考时托腮，干完活就捧腹大笑。 |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) | `enso.pstack` | 0.3.3 | 官方 | Lauren Tan 的 pstack 0.15.36（MIT）：poteto-mode 按任务挑选 playbook，配套 arena、interrogate、architect 等 58 个 skill 和工程原则，先深挖再并行。只在输入框选了「pstack」预设的会话里加载。在输入框按钮里为某个会话打开后，该会话的每条消息自动展开 poteto-mode。 |
| Scheduler | `enso.scheduler` | 1.0.3 | 官方 | 定时任务：按 cron 到点向会话发送提示词或弹出系统通知，侧栏显示下次运行时间与倒计时。 |
| Telegram | `enso.telegram` | 0.3.1 | 官方 | 用 Telegram Bot 远程使用 EnsoCode 会话：配对后发消息即进入会话，执行进度原位更新，回复以富文本发回；支持图片、群聊绑定、成员白名单与群聊上下文、插话、远程停止和双向同步。 |
| Telegram 客户端 | `enso.tgclient` | 0.1.1 | 官方 | 在侧栏里用手机号登录自己的 Telegram 账号，像官方客户端一样聊天：会话列表与聊天分组、论坛话题、实时收发、相册、边下边播视频、表情与贴纸面板、编辑、回复、表情回应、已读详情、切换发言身份、机器人按钮与键盘、新消息系统通知；附带 Agent 工具，可查聊天、读写消息、订阅新消息。支持 socks5 与 MTProxy 代理。 |
| 双语对照翻译 | `enso.translate` | 0.1.1 | 官方 | 把思考过程和回复正文译成目标语言，原文下面紧跟译文。代码、链接、路径和公式保持原样。 |
| [深海女仆工坊](https://github.com/Small-tailqwq/dsh-deep-whale) | `enso.whalemaid` | 0.1.1 | 官方 | 鲸鱼娘女仆主题：深海蓝配金色描边，水晶宫殿作背景，两位女仆站在对话两侧，输入框系着蝴蝶结。美术 CC BY-NC-SA 4.0，禁止商用。 |
| [Astronaut 宇航员](https://github.com/mediocrebaby/Astronauts) | `space.astronaut` | 1.4.0 | 社区 · [`mediocrebaby/Astronauts`](https://github.com/mediocrebaby/Astronauts) | Lunar 月白：黑白宇航员与中性灰阶主题。 |
| [YCE Prompt Enhance](https://github.com/xiamuwnagwang/enso-yce) | `yce.enhance` | 0.1.1 | 社区 · [`xiamuwnagwang/enso-yce`](https://github.com/xiamuwnagwang/enso-yce) | YCE 提示词增强：复用宿主已配置的 yce-mcp，在输入框一键将模糊草稿改写为清晰、结构化的提示词。 |
<!-- plugins:end -->

## 仓库结构

```text
packages/<id>/            插件本体（enso-plugin.json），目录名必须等于清单 id
registry/meta/<id>.json   市场元数据：tier、tags、homepage、icon（不进清单）
registry/icons/           官方插件的市场图标
registry/external/        外部插件声明
shared/                   插件面板共享的 enso-ui.css / enso-ui.js
scripts/                  校验、打包、签名、同步共享 UI
web/                      市场首页（Vite + React + shadcn/ui）
worker/                   只读分发 Worker
out/v1/                   本地构建产物，不提交
```

`enso.example.notes` 和 `enso.example.wordstats` 是示例插件，来自 EnsoCode 的 `examples/plugins`，`tier` 为 `official`。

索引由客户端解析（`schemaVersion: 1`）：

- `path` 相对于 `v1/`，例如 `packages/<id>/<version>.zip`。
- 插件目录里有 `README.md` 时，插件记录带 `readme: { path, sha256, size }`，`path` 为 `packages/<id>/<version>.readme.md`，最大 256KB。README 同时在 zip 里，改 README 要升版本。
- `sequence` 每次发布加 1，用来拒绝回滚。

## 贡献插件

1. **放入插件**：在 `packages/<id>/` 放入带 `enso-plugin.json` 的目录。
   - 有 `package-lock.json` 时打包前会执行 `npm ci`；否则依赖要直接放在目录里。安装时不会执行 `npm install`。
   - CI 会运行 `node scripts/catalog.mjs`，把插件索引写回 README；本地也可以先跑一次。
2. **市场元数据（可选）**：添加 `registry/meta/<id>.json`。

   ```json
   { "tier": "community", "tags": ["ui"], "homepage": "https://example.com", "icon": "icon.png" }
   ```

   | 字段 | 说明 |
   | --- | --- |
   | `tier` | `official` 或 `community`，不写元数据时按 `community` |
   | `tags` | 标签，用于搜索 |
   | `homepage` | `https` 链接 |
   | `icon` | 相对路径，或 `https` 图片（客户端经 Worker `/v1/icon` 拉取） |

3. **本地检查**：

   ```bash
   node scripts/validate.mjs
   node --test
   ```

4. **开 PR 到 `main`**：CI 会校验，并把权限变更摘要写到 PR 评论。

## 审核规则

- `id` 匹配 `^[a-z][a-z0-9]*(\.[a-z0-9]+)+$`，不超过 40 字符，且等于目录名。
- `version` 是不带 `v` 前缀、不带构建元数据的 semver。已发布的 `<id>@<version>` 内容不能改，要改就升版本。
- 插件不超过 5000 个文件、合计 200 MB；禁止 `.node` 文件和符号链接。
- 清单 `schemaVersion` 为 1。声明了 `engines.enso` 时只能写成 `>=x.y.z`。
- 权限、文件范围、域名、MCP 工具、环境变量、可调用插件、拦截事件、是否常驻有变化时，会出现在 PR 评论里供维护者确认。安装时仍以包内清单为准。
- `tier` 只有维护者能改。CI 用 `ENSO_COMMUNITY_PR=true` 标记社区 PR（作者不是 `OWNER` / `MEMBER`）。社区 PR 修改 `tier`，或把新插件标成 `official`，都会失败。

## 界面与设计规范

视觉沿用 [shadcn/ui](https://ui.shadcn.com/)（zinc 中性色、细边框加极浅阴影、ring 焦点环）。动效参考 [设计垂点](https://wxad.design/abc/) 的 Functional Motion：

- 时长分三档：120 / 200 / 320 ms。
- 只用 ease-out 和弹簧曲线，不用 ease-in-out。
- 添加和删除时，透明度与位移错开。
- 同组元素共享 hover 背景和指示器（“跳跃”）。
- 弹层从触发点放大出现（“发芽”）。
- 遵循 `prefers-reduced-motion`。

### 插件面板

官方插件的侧栏面板共用 `shared/enso-ui.css`（设计 token 与组件类 `.ui-*`）和 `shared/enso-ui.js`（`window.ensoUI` 动效工具）。

插件包必须自包含，因此插件目录里放的是副本。改了 `shared/` 后同步：

```bash
node scripts/sync-ui.mjs
```

`validate` 会检查副本是否与 `shared/` 一致。改动副本意味着包内容变化，对应插件要升版本。

### 市场首页

`web/` 是首页源码，使用 Vite、React、Tailwind CSS v4、shadcn/ui 和 motion，构建结果作为 Worker 静态资源发布。

```bash
cd web
npm install
npm run dev     # http://localhost:5173，/v1 代理到线上 Worker
npm run build   # 输出 web/dist
```

### 主题工坊

`/studio/` 是浏览器里的主题生成器（`web/studio/index.html` → `web/src/studio/`）。调色板、九个素材槽位和可选 CSS 组成一份草稿，存在浏览器的 IndexedDB 里；预览和导出都从草稿派生。导出的 zip 结构与 `packages/enso.nailong` 相同，在 EnsoCode 设置 → 插件 → 从压缩包安装。

它依赖宿主的主题纯模块，副本在 `web/src/enso-theme/`，**不要手改**。EnsoCode 改了 `src/shared/theme/` 或 `src/shared/accentColor.ts` 后，在本仓库同步并检查：

```bash
ENSO_CODE_DIR=../enso-code node scripts/sync-theme.mjs          # 拷贝并写入来源 commit
ENSO_CODE_DIR=../enso-code node scripts/sync-theme.mjs --check  # 只比对，有漂移时失败
```

CI 里没有 enso-code 仓库，所以这一步只在本地运行。

## 发布

PR 合并到 `main` 后，`.github/workflows/publish.yml` 依次执行：

1. 若已有 `dist` 分支，先取出其中的 `v1/`，保留历史 zip 和索引。
2. `build` + `sign`。带 `package-lock.json` 的插件会先执行 `npm ci --omit=dev`，依赖打进 zip，不提交 `node_modules`。
3. 把 `out/v1` 提交并推到 `dist`：`v1/index.json`、`v1/index.json.sig`、`v1/packages/<id>/<version>.zip` 与 `<version>.readme.md`。

客户端内置公钥，源可以是 Worker、jsDelivr 或 GitHub raw，但内容必须对得上同一份签名。

### 本地演练

```bash
node scripts/keygen.mjs --private-out market-key.pem   # 公钥打到 stdout，私钥写入文件
node scripts/build.mjs                                 # 生成 out/v1/index.json 与 zip
ENSO_MARKET_PRIVATE_KEY="$(cat market-key.pem)" node scripts/sign.mjs
```

- 已有 `out/v1/index.json`（或 git 的 `dist` / `origin/dist` 上的 `v1/index.json`）时，build 会合并历史版本，`sequence` 取旧值加 1。同一版本的 sha256、大小或路径不同时构建失败。
- 可用 `ENSO_INDEX_TIME` 固定 `generatedAt`（ISO 时间）。
- 签名是对 `index.json` 原始字节做 Ed25519，base64 写入 `index.json.sig`。私钥为 PKCS8 PEM，GitHub secret 里可以把换行写成 `\n`。

### Secrets

| 名称 | 用途 |
| --- | --- |
| `ENSO_MARKET_PRIVATE_KEY` | Ed25519 PKCS8 PEM，只放在 GitHub Actions |
| `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | 部署 Worker |

推送 `dist` 用工作流自带的 `GITHUB_TOKEN`（`contents: write`）。

**密钥轮换**：用 `keygen` 生成新密钥对；先让客户端同时信任新旧公钥，再换成新的 `ENSO_MARKET_PRIVATE_KEY` 发一版索引；确认客户端都已更新后，移除旧公钥。不要把私钥提交进仓库。

## Worker

`worker/` 只读：

- 索引与签名成对回源 `ORIGIN`（`dist` 分支的 raw，边缘缓存 5 分钟）并写回 R2；源站不可用时用 R2 里的上一份。
- 包先读 R2，缺失时回源一次再写入 R2。

`worker/` 或 `web/` 有改动并合并到 `main` 时，`.github/workflows/worker.yml` 依次运行 Worker 测试、构建首页，然后部署。也可以手动部署：

```bash
(cd web && npm install && npm run build)
cd worker && npx wrangler deploy
```

| 路由 | 行为 |
| --- | --- |
| `GET /` | 首页静态资源（`web/dist`），响应头见 `web/public/_headers` |
| `GET /v1/index.json`、`/v1/index.json.sig` | `cache-control: public, max-age=300` |
| `GET /v1/packages/<id>/<version>.zip`、`<version>.readme.md` | 一年 immutable，带 ETag；路径按 id 与 semver 校验；README 为 `text/markdown; charset=utf-8` |
| `GET /v1/icon?url=` | 只代理 `https` 图片，不转发请求头，最大 1 MB；200 缓存一天，404 缓存五分钟，5xx 不缓存 |
| 其他 `/v1/*` | 404 |

## 外部插件

插件源码在其他仓库时不复制进来，而是在 `registry/external/<id>.json` 中声明：

```json
{ "repo": "owner/name", "commit": "<完整 40 位 sha>", "path": "插件所在子目录" }
```

- CI 在校验和打包前运行 `node scripts/external.mjs`，按固定 commit 下载到 `packages/<id>/`。这个目录已加入 `.gitignore`，不提交。
- 更新插件就是提 PR 修改 `commit`，审核对象是该 commit 的代码；作者改了 `version` 才会发新版。
- 市场元数据照常放在 `registry/meta/<id>.json`。

## 下架

把插件 id 加入 `registry/delisted.json`（数组），并删除 `packages/<id>/`。

下一次发布时插件会从索引中消失；已发布的 zip 仍留在 `dist`，已安装的用户不受影响。

## 友链

- [Linux.Do](https://linux.do/) — 与社区一起分享、讨论、关注开发进展。
