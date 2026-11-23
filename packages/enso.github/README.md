# GitHub

在侧栏查看、回复、关闭和重开当前项目的 GitHub issue 与 PR，也可以查看 Actions 运行、失败原因和日志，并重跑或取消。会话里的 agent 也能通过工具做同样的操作。

需要 EnsoCode 0.2.14 及以上。

## 登录

插件按以下顺序找凭据，找到即用：

1. 侧栏里的设备码登录：点「登录」后自动打开 GitHub 授权页，输入页面上的代码即可。授权范围为 `repo`。
2. 设置 → 插件 → GitHub 填写的 Personal Access Token，需要 Issues、Pull requests 与 Actions 的读写权限；要看失败注解还需要 Checks 读权限。
3. 环境变量 `GH_TOKEN` 或 `GITHUB_TOKEN`。
4. 已登录的 gh CLI（`gh auth token`）。

设备码登录的 token 保存在插件数据目录（`auth.json`），可在侧栏退出登录。

## 使用

1. 打开侧栏「GitHub」。仓库默认取当前项目 git `origin` 指向的 GitHub 仓库，也可以手动填 `owner/name`。
2. 切换 Issues / PR，以及打开、已关闭、全部。列表按更新时间排序，最多 50 条。
3. 点开一条查看正文和评论；PR 还会显示分支、改动文件数和增删行数。
4. 在详情里可以回复（Markdown）、关闭（完成或不计划）、重新打开，或在浏览器中打开。
5. 切换到 Actions 查看最近 30 次运行。点开一次运行可看每个作业的步骤和失败注解。未完成的运行可以取消。已完成的运行可以重新运行，失败的还可以只重跑失败作业。

作业日志存在不固定子域名的 Azure Blob 上，插件网络权限只能声明固定域名，所以查看日志需要本机安装 gh CLI。没有 gh 时仍可看失败注解，或在浏览器中打开该次运行。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `github_list` | 列出 issue 或 PR |
| `github_view` | 查看一条 issue 或 PR 及其评论 |
| `github_comment` | 发表评论 |
| `github_set_state` | 关闭或重新打开，可先附一条评论 |
| `github_runs` | 列出最近的 Actions 运行，可按分支和状态过滤 |
| `github_run` | 查看一次运行的作业、步骤，以及失败作业的注解 |
| `github_job_log` | 读取一个作业的日志（需要 gh CLI）。有 `##[error]` 时返回其附近的行，否则返回末尾若干行 |
| `github_run_action` | 重新运行、只重跑失败作业，或取消一次运行 |
| `github_watch` | 监听仓库事件，有事件才投递进本会话 |
| `github_unwatch` | 停止本会话的监听 |
| `github_watch_status` | 查看本会话的监听配置、轮询状态与限流 |

`repo` 不填时使用当前项目的 `origin`。

## 监听

`github_watch` 让会话订阅一个或多个仓库。插件每分钟在后台轮询，过滤后真有事件才把精简的摘要投递进会话，并自动开始新一轮。没有变化时不唤醒模型。

先在 设置 → 插件 → GitHub 打开「允许向任意运行中的会话发送消息」，否则消息会暂存，并弹一次系统通知提醒。

一个会话只有一个监听，再次调用会替换旧的。多个会话监听同一仓库时共用一次轮询。

### 监听面板

在 GitHub 侧栏点 **监听**，或打开全局侧栏 **GitHub 监听**。面板列出所有会话的订阅、投递统计、各仓库的轮询状态和 GitHub 限流。

**停止** 要点两次。第一次变成 **确认停止**，3 秒内再点才停止。

会话删掉之后订阅还在，卡片上标 **会话已删除**。在这个面板里停掉它。

面板只读本机的 `watch.json`。打开和刷新都不请求 GitHub。

### 事件

| 事件 | 含义 |
| --- | --- |
| `pr_opened` | 新 PR、草稿转正、重新打开 |
| `pr_ready` | PR 最后一次推送后 `settleSec` 内没有新推送，可以看了 |
| `pr_merged_closed` | PR 合并或关闭 |
| `issue_opened` | 新 issue 或重新打开 |
| `mention` | 正文或评论里 @ 了你、你的 PR / issue 有新评论或 review、有人请你 review |
| `ci_failed` | Actions 运行以 failure、timed_out 或 startup_failure 结束 |
| `pr_commented` | PR 有新评论（含行内评论），默认不开 |
| `issue_commented` | issue 有新评论，默认不开 |

同一 PR 或 issue 的多条事件合成一条，例如 `pr_opened, pr_commented×2`。投递只含仓库、编号、标题、作者、分支、head 和链接，不含正文。标题等外部内容包在 `<untrusted-content>` 里。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `repos` | 当前项目的 `origin` | 最多 20 个 `owner/name` |
| `events` | 前六种 | 见上表 |
| `authors` | 不限 | 只要这些人开的 PR / issue，或触发的 CI |
| `excludeAuthors` | 不排除 | 作者或评论者、reviewer 是这些人时跳过，如 `dependabot[bot]` |
| `labels` | 不限 | 带任一标签才要，不管 CI |
| `excludeNumbers` | 无 | 跳过这些编号 |
| `includeDrafts` | `false` | 不开时草稿 PR 只报 `mention` |
| `branches` | 仓库默认分支 | `ci_failed` 看哪些分支，最多 10 个 |
| `settleSec` | 900 | `pr_ready` 的静默时间，60 到 86400 秒 |
| `debounceSec` | 3 | 最后一个事件后等这么久再投递，1 到 3600 秒 |
| `minIntervalSec` | 0 | 两次投递的最小间隔，0 到 86400 秒 |
| `note` | 无 | 每次投递都附上的要求，最多 500 字 |

### 数据来源与限流

每个仓库按需轮询这几个列表，都按更新时间倒序：PR、issue、issue 评论、PR 行内评论、各分支最近 30 次 Actions 运行，以及仓库信息（取默认分支）。不用仓库的 events 接口：它延迟 30 秒到 6 小时，只保留最近 300 条，也没有 Actions 运行。请求带 `If-None-Match`，没变化时 GitHub 返回 304，不占限流额度。只有变化的列表才计数。一个仓库通常 6 个列表，`branches` 每多一个分支多一个。6 个列表一直有变化时每小时约 360 次，GitHub 每小时给 5000 次。

剩余额度低于 50 或被限流时，暂停到额度重置。一个仓库连续失败时按 1、2、4 分钟退避，最长 30 分钟。连续失败 3 次会投递一条提醒，恢复后自动继续。

订阅时只记下现状，不回放历史。状态存在插件数据目录的 `watch.json`。插件重启后接着上次的位置比对，停机期间的变化照常投递。停机超过 30 分钟且变化超过 10 条时，合成一条摘要。

投递失败的事件留在队列里重试，送达后一次补发。补发前按 PR 现状刷新标题和状态，已关闭或又有新推送的 PR 不再报 `pr_ready`。积压超过 30 分钟且多于 10 条时，合成一条摘要。

### 可能漏掉的情况

- 一轮里某个列表变化超过 300 条时只看前 300 条，投递会注明可能有遗漏。
- 订阅前就有、且当时不在最近 100 条里的旧 PR，第一次出现时只识别关闭。
- 评论编辑、删除，以及 issue 关闭不提醒。
- 你的 PR 的 review 每轮最多查 5 个 PR。
- 只看 `branches` 里分支的 CI，PR 分支的 CI 要写进 `branches` 才看。
- 两次轮询之间同一分支完成超过 30 次运行时，更早的那些不报。
- 提及按正文里的 `@用户名` 识别，`@组织/团队` 不算。
- 会话删除后监听不会自动停止。打开 **GitHub 监听** 面板，停掉标成 **会话已删除** 的订阅。

## 权限

| 权限 | 用途 |
| --- | --- |
| `agent.tool` | 提供上面的 Agent 工具 |
| `net.fetch` | 访问 `github.com`（设备码登录）和 `api.github.com` |
| `ui.view` | 打开 GitHub 侧栏和监听面板 |
| `session.readAll` | 列出所有项目会话的标题，识别已删除的会话 |
| `session.focus` | 点标题跳到同项目的会话 |
| `ui.openExternal` | 打开授权页和 issue / PR 网页 |
| `agent.inject` | 把监听到的事件投递进会话 |
| `process.background` | 每分钟运行一次轮询任务 |
| `ui.notify` | 投递被拒时提醒你打开授权 |
