# OpenSpec

当前项目的 OpenSpec 变更看板。侧栏读取 `openspec/changes/`，按阶段列出每个变更的任务进度、下一步、工单，以及文档里能识别的 pull request。实现和收尾会把对应提示发到标题对得上的 Enso 会话。

这不是 EnsoCode 内置的 Workflow 预设。

## 使用

1. 打开一个已经有 `openspec/` 的项目，再打开侧栏「OpenSpec」。
2. 顶部的阶段按钮会统计每个阶段的数量，可以只看一个阶段。当前会话标题里带有变更名或工单号时，这张卡片会钉在最上面。
3. 点「任务」展开 `tasks.md` 的清单，以及提案、设计和规格等 Markdown。
4. 按阶段发送：
   - **实现**：就绪、进行中，以及评审中。发给会话的默认文字是 `/opsx:apply <变更名>`。
   - **收尾**：已合并但仍有未勾任务、已经完成，以及评审中且至少 80% 的任务已勾上。默认会请会话对照任务、代码和 PR，勾上真正做完的项，全部完成后再执行 `/opsx:archive`。
   - 未勾上的任务可以单独发送，默认是 `/opsx:apply <变更名>，只做这一项：…`。
5. 发送到哪里：
   - 当前会话的标题对得上：直接发进这个会话并开始一轮。
   - 另一个会话对得上：可以前往，或发送到那个会话。发到别的会话需要在设置里允许。
   - 没有对得上的会话：新建一个会话，把提示词放进输入框，由你确认后再发送。

`openspec/board.json` 里的 `applyAnywhere: true` 会让实现和收尾发到当前会话，即使标题对不上。

没有 `openspec/` 目录时，看板说明如何初始化，不会当成一份空的变更列表。

## 阶段

| 阶段 | 条件 |
| --- | --- |
| 规划 | 还缺要求的产物。默认是 `proposal.md`、`design.md`、`tasks.md` 和 `specs/` |
| 就绪 | 产物齐全，还没有勾上任何任务 |
| 进行中 | 勾上了一部分任务 |
| 评审中 | 文档里有状态为打开的 PR |
| 已合并未完成 | 有已合并的 PR，但任务还没勾完 |
| 完成 | 任务全部勾上，且没有打开的 PR |

变更目录的 `.openspec.yaml` 里 `skip_specs: true` 时，不再要求 `specs/`。`openspec/config.yaml` 或变更自己的 `schema` 若指向 `openspec/schemas/<名称>/schema.yaml`，且看板没有自己写 `requiredArtifacts`，则用 schema 里的 `generates` 作为产物。`openspec/changes/archive/` 不显示。

任务统计接受 `-`、`*`、`+` 和有序列表上的复选框，并忽略代码块里的例子。`tasks.md` 里以 `Next:` 或 `下一步：` 开头的那一段会显示为下一步；可用 `resumeLine` 换成别的正则。

## Pull request

看板不访问网络，也不运行 `gh`。它只在变更的 Markdown 里查找 `https://github.com/<owner>/<repo>/pull/<编号>`。同一行写了 `open` / `merged` / `closed`，或「打开 / 已合并 / 已关闭 / 草稿 / 待评审」，才会用来判断阶段。没写状态的链接仍会显示，但不会把变更算作评审中或已合并。

`board.json` 里的 `pullRequests` 不会触发在线搜索。配置了它时，看板会提示状态要写在链接那一行。

## 配置

`openspec/board.json` 可选。写错的字段会提示，并继续用该项的默认值。

```json
{
  "requiredArtifacts": ["proposal.md", "design.md", "tasks.md", "specs"],
  "resumeLine": "^Next:",
  "ticket": {
    "pattern": "^proj-(\\d+)",
    "key": "PROJ-$1",
    "url": "https://tracker.example.com/browse/{ticket}"
  },
  "apply": "/opsx:apply {change}",
  "finish": "/opsx:archive {change}",
  "task": "/opsx:apply {change}，只做这一项：{task}",
  "applyAnywhere": false,
  "files": { "exclude": ["research"] }
}
```

`{change}`、`{ticket}`、`{task}` 会替换成变更名、工单号和任务原文。名称里如果有控制字符，看板会拒绝发送。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 打开侧栏 |
| `fs.read` | 读取项目里的 `openspec/`。文件内容走宿主的 `fs.readText`；宿主不能列目录，所以只在项目内的 `openspec/` 下列出文件夹，并且不跟随符号链接 |
| `agent.inject` | 把实现、收尾或单项任务发进会话 |
| `session.read` | 按会话标题匹配变更名或工单号 |
| `session.focus` | 前往对得上的会话 |
| `session.create` | 没有对得上的会话时新建，并把提示词放进输入框 |

发到当前会话以外的会话时，需要在 设置 → 插件 → OpenSpec 打开「允许向任意运行中的会话发送消息」。
