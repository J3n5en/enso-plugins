# Telegram

用 Telegram Bot 远程使用 EnsoCode 会话。配对后在 Telegram 发消息就进入会话，执行进度原位更新，最终回复以富文本发回。

需要 EnsoCode 0.2.14 及以上。

## 准备

1. 在 Telegram 找 @BotFather，发 `/newbot` 创建机器人，拿到 Bot Token。
2. 在 设置 → 插件 → Telegram 填写「Bot Token」。
3. 同一页打开「允许向任意运行中的会话发送消息」。

侧栏「Telegram」会显示机器人的连接状态。同一个 token 只能有一个 EnsoCode 在运行，否则 Telegram 会报 `Conflict`。

## 绑定

1. 在要远程使用的会话里打开侧栏「Telegram」，点「绑定 Telegram 聊天」，得到 6 位配对码，10 分钟内有效。
2. 点「绑定私聊」或「绑定到群聊」链接，或者私聊机器人发 `/bind 配对码`。

绑定后直接发消息即可。群聊里要 @机器人 或回复机器人的消息。

## 使用

- 收到消息后机器人先回「已收到，处理中…」，执行中更新为当前步骤和工具名，完成后替换成最终回复。超长回复分段发送。
- 可以发图片（PNG、JPEG、WebP、GIF，5MB 以内），附文字说明更好。其他文件和语音不支持。
- 会话还没启动时消息先排队，最多 10 条，会话启动后自动处理（EnsoCode 窗口需要开着）。
- agent 可以用 `telegram_reply` 工具主动发中途进度。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看用法 |
| `/status` | 查看绑定状态 |
| `/steer 内容` | 向正在运行的任务插话 |
| `/stop` | 停止正在运行的任务 |
| `/sync on`、`/sync off` | 开关双向同步，把在 EnsoCode 里的对话也发到 Telegram |
| `/session` | 切换这个聊天绑定的会话，列出最近 10 个 |
| `/unbind` | 解除绑定 |
| `/allow`、`/deny` | 群聊：回复某人的消息把 TA 加入或移出白名单；单独发 `/allow` 查看名单 |
| `/context 0-50` | 群聊：触发时附带最近几条其他人的消息，0 关闭 |

### 群聊

- 绑定到群聊时默认开启白名单，并把绑定的人加入。不在名单里的人发消息会出现在侧栏的待批准列表，可以在侧栏批准。
- 机器人看不到普通群消息时，在 @BotFather 发 `/setprivacy` 选 Disable，然后把机器人移出群再重新拉进来。

### 侧栏

- 本会话的聊天：同步开关、白名单、上下文条数、新会话、解绑。
- 其他会话的聊天：可以移到本会话。

Telegram 里不支持 `/new`，要开新会话请在侧栏点「新会话」。`/session` 的会话列表需要先在 EnsoCode 里打开过一次侧栏。

## 权限

| 权限 | 用途 |
| --- | --- |
| `agent.tool` | 提供 `telegram_reply` 工具 |
| `agent.observe` | 观察会话事件，更新进度并发回回复 |
| `agent.inject` | 把 Telegram 消息发进会话 |
| `session.read` | 列出本项目的会话供 `/session` 切换 |
| `session.create` | 在侧栏新建会话 |
| `process.background` | 常驻后台轮询机器人消息 |
| `net.fetch` | 访问 `api.telegram.org` |
| `ui.view` | 打开侧栏页面 |
| `ui.openExternal` | 打开绑定链接 |
