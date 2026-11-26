# Swarm

一个协调者把活拆给几个独立会话，通过共享消息板协作。侧栏是 AGY（Antigravity）原版
swarm 看板。

## 它是怎么来的

UI 直接取自 AGY 内置插件 `~/.gemini/antigravity/builtin/plugins/swarm`，**未改动**：
`app.js`（161 KB，四个 tab 的全部行为）、`hive.js`（113 KB，像素蜜蜂与 Overview/Members 渲染）、
`hive.css`、`styles.css`、`gif.js`、`narrator_bootstrap.js`、`index.html` 都是上游原文件。

只有四处必要差异：

| 文件 | 差异 | 原因 |
| --- | --- | --- |
| `swarm_board/main.mjs` | `from 'sidecar_sdk'` → `from './sidecar_sdk.mjs'`；`BOARD_ACTIVITY` 增加 `swarm_read` / `swarm_post` 两个键 | 上游把路由注册到 AGY 的 loopback HTTP 服务；Enso 页面没有网络，改为进程内路由 |
| `swarm_board/sidecar_sdk.mjs` | 新增 | 用 `handle(url)` 取代 listen，把同一个 handler 的返回值规整成 `{status, text|base64}` |
| `swarm_board/index.html` | 去掉 Google Fonts 与绝对路径斜杠 | 页面被内联进沙箱 iframe，不能外链、不能有根绝对路径 |
| `swarm_board/preload.js` | 新增 | 提供上游期望的 `window.sidecar.fetch`（转到 `enso.call('api')`）、`localStorage`（转到 `enso.storage`）与设计 token |

因此看板的板面、Graph replay、Raw tab、像素蜜蜂、GIF 导出全部是 AGY 的逻辑，一行未改。

## 数据面

插件只**追加**三种文件，其余全部由上游代码推导：

```
<dataDir>/state/brain/<coordinatorConv>/.system_generated/swarm/
  board.jsonl    {seq, agent, text, time[, channel]}
  members.json   {title, members: {name: {role, conversation_id, wake_mode, killed, killed_reason, model}}}
  view.json      narrator 的 Overview（走 swarm_view 工具写）
  <memberConv>/.system_generated/logs/transcript.jsonl   成员活动（决定状态与“正在做什么”）
```

`<coordinatorConv>` 是会话 id 的 sha256 前 32 位（上游 `ID_RE` 只接受十六进制）。

## 四个工具

- `swarm{action}` — `open` / `status` / `add` / `kill` / `title`
- `swarm_post{text, channel?}`
- `swarm_read{since?, limit?}`
- `swarm_wait{since, timeoutSec?, mentionsOnly?}`
- `swarm_view{view?, html?}` — 仅 narrator

`swarm{action:"add"}` 不会自己开会话（插件无权无手势新建会话），它把 brief 贴到板上并返回
应当调用的 `subagent(...)`，由协调者当回合派生 `swarm:worker`。

## 成员什么时候「不动了」

面板和 `swarm status` 里的状态都是从成员的 transcript **推**出来的（上游只有「追加、推导」，
不重算）。所以只追加、不停机的话，一个被 dismiss 的 worker 会永远停在它最后一次工具调用上，
看起来像还在干活。插件订阅了宿主的会话事件补上这一笔：

- `session_end`（`reason: dismissed` / `parent_ended`）→ 该成员 `killed: true`，
  同时记 `killed_reason`；`swarm status` 显示 `gone (dismissed)`，面板显示不再 Active。
- `session_start`（同一子会话 id，例如 `subagent send` 把 coworker 唤醒）→ 清掉这两个字段，
  成员重新可用。

`killed_reason` 也区分了「谁杀的」：协调者 `swarm{action:"kill"}` 没有 reason，**不可复活**；
宿主给的 `dismissed` / `parent_ended` 可以由同一个 key 重新 `bind` 回来。

## 点开一个成员

AGY 面板里点成员卡片 / 图上的节点 / Overview 的成员行，最后都走 `window.sidecar.ui.toggleConversation(conv)`
（`app.js:324` 起唯一入口）。`preload.js` 把它换成 `enso.call('openMember', {conv})`，`main.mjs` 的
`enso.renderer.handle('openMember')` 按 `conversation_id`（或名字）在会话所属 swarm 的名册里找到成员，
再试三个宿主接口。**按成员是否已经结束分两条路**，因为「返回成功」和「真的打开了」在宿主里不是一回事：

活着的成员：

1. `session.focus(session_id)` —— **首选，因为它是三者里唯一能把结果告诉插件的**：渲染层没有这个会话时
   宿主会以 `NOT_FOUND` 拒绝，而活着的 coworker 本身就是一个会话，所以它切到那个标签页并返回成功；
2. `session.openChildRun(parent, session_id)` —— 它只是把 id 交给渲染层，**永远返回成功**，所以只能当兜底；
3. `session.focusSubagent` —— 需要 TaskBar 里存在按短 id 匹配的行，匹配不上时静默失败，放最后。

已经结束（`killed` 或 `killed_reason`）的成员反过来：标签页已经没了，`session.focus` 反而会**假成功**
（渲染层退到 `focusSubagent`，没有对应行就静默什么都不做，却照样回 ok），所以这类成员先走
`session.openChildRun` 开历史弹窗。

每次尝试和它的失败码都写进插件日志（`extension-plugins/logs/enso.swarm.log` 里的 `[swarm] openMember …`），
所以「点了没反应」时先看日志：是 `focus: NOT_FOUND`（标签页没了）还是 `GESTURE_REQUIRED`（不是面板里点的）。
未绑定会话的成员直接回 `<name> has no session yet (unbound)`。

## 谁算「在干活」

- **协调者不算**：它对看板自己的调用（open/title/kill/swarm_post…）不再写 transcript 步骤，`swarm status`
  里它的那行固定按「在等板」渲染（`coordinator coordinator waiting`）。之前每条都会写一步，于是它的行永远是
  `working · Posted #31`。worker 的判定完全不变。
- **kill 与 dismiss 对称**：`swarm{action:"kill"}` 会同时写 `killed: true` 和 `killed_reason: "killed"`；
  `killed` 不在 `ENDED`（`dismissed/parent_ended/ended`）里，所以被 kill 的成员不会被 `session_start` 复活、
  `bind` 也会拒绝。kill 不再往板上补 `@x killed` 行——members.json 就是 kill 的记录。
- **kill 不停进程，所以状态要分三档**（`main.mjs` 的 `goneLabel`）：
  - `gone (killed · session open)` —— kill 了但那条会话还开着，仍占着一个 coworker 槽位；
  - `gone (killed)` —— kill 之后宿主也报了这个会话的结束（`endMemberSession` 会给已 kill 的成员记
    `session_ended: <reason>`，不动 `killed/killed_reason`）；
  - `gone (dismissed)` —— dismiss 路径，渲染未变。
  kill 的返回文案因此会明说：会话还在开，用 `subagent dismiss` 释放槽位。插件没有关闭子会话的出口，
  `session.abort` 只打断当前轮，所以 kill 里不会去 abort。

## 状态的最后一档：跑完但没 dismiss

`agent_end`（子会话也会收到，只有 `tool_call` 是拦截专属）才是「这一轮结束了」的真信号，插件用它把成员置为
parked：`members.json` 写 `wake_mode: mentions`，并在该成员的 transcript 末尾补一条**无 tool_calls 的
PLANNER_RESPONSE**——这正是 AGY 自己判断 idle 的形状（`turnEnded()`），所以面板显示 Waiting 而不只是 `swarm status`。
`agent_start` 反向清掉。没有这些事件的旧会话（事件计划在启动时快照）退回时间兜底：最后一步是 board 调用且已过
10 分钟，显示 `waiting · quiet for 11m`，不再谎称 Active。

## 安装与试用

```bash
# 从目录安装（开发模式自动重载）
enso-server plugin install /Users/j3n5en/project/enso-plugins/packages/enso.swarm
enso-server plugin enable enso.swarm
```

在输入框选预设「Swarm 协调者」，说一句需求；协调者 `open` 后侧栏出现 Swarm 面板（或输入
`/enso.swarm:board` 打开）。

## 已知差异（未对齐项）

- 频道（`#channel` 的 create/subscribe）工具未暴露；板上已有的 `control` 消息仍会被正确渲染。
- 成员换模型、配额耗尽暂停：Enso 侧没有对应原语。
- AGY 是服务端 park（被 `@` 唤醒才计费）；这里是 worker 自己 `swarm_wait` 长轮询，语义等价但
  会占用在岗 coworker 名额（默认 5，可调到 20）。
