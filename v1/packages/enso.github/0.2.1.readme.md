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

`repo` 不填时使用当前项目的 `origin`。

## 权限

| 权限 | 用途 |
| --- | --- |
| `agent.tool` | 提供上面的 Agent 工具 |
| `net.fetch` | 访问 `github.com`（设备码登录）和 `api.github.com` |
| `ui.view` | 打开侧栏页面 |
| `ui.openExternal` | 打开授权页和 issue / PR 网页 |
