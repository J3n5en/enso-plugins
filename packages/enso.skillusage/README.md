# Skill Usage

侧栏里看技能、MCP 和子代理：**放进上下文的**和**真正调用过的**差多少，以及它们大约占多少 token。按项目、预设和最近 7 / 30 / 90 天筛选；从未调用的条目按占用从高到低排。

这不是 Enso 自带的花费统计，也不是 `enso.context` 的上下文窗口。这里只关心技能、MCP 和子代理。

## 使用

打开侧栏「技能用量」。第一次会读本机已有的会话，不用先攒数据。

- **每次占用**：如果现在用所选预设开一场新会话，提示词里会带上的估算 token。
- **调用**：所选项目和时间里，历史会话实际用过的次数。
- **从未调用 / 很少调用**：会进提示词，但次数是 0，或只有 1–2 次。
- 选一个项目后，这个项目自己的技能才算进「每次占用」。选「全部项目」时它们只出现在列表里。

自定义预设会关掉 pi 的本机技能发现（和 Enso 开会话时一样）。「加载本机 skill」没打开时，`~/.agents/skills` 和项目里的 `.agents/skills`、`.pi/skills` 也不进提示词。

## 数据来源

只读 [EnsoCode](https://github.com/J3n5en/EnsoCode) 自己的目录，不把 `~/.claude` 的会话或 `~/.claude.json` 当成清单。实现对照的是仓库里的这些路径：

| 来源 | 路径 | 用它做什么 |
| --- | --- | --- |
| 数据目录 | 打包版 `{appData}/enso-code`，开发版 `{appData}/enso-code-dev` | `src/main/index.ts` 把 `userData` 指到这里。macOS 的 appData 是 `~/Library/Application Support`，Linux 是 `$XDG_CONFIG_HOME` 或 `~/.config`，Windows 是 `%APPDATA%` |
| 设置 | `userData/settings.json` 的 `enso-settings.state` | `skills`、`mcpServers`、`presets`、`agentTypes`、`disabledBuiltinAgentTypes`、`plugins`、`projects`、`loadLocalSkills`、`loadHarnessAssets` |
| 会话 | `userData/agent/sessions/**/*.jsonl` | pi session v3。`src/main/services/usage/usageService.ts` 用的就是这个目录 |
| 本机技能 | `~/.agents/skills`、`userData/agent/pi-agent/skills`、`userData/agent/pi-agent/settings.json` 的 `skills` | 仅当 `loadLocalSkills === true` 且没选自定义预设。发现规则和 `listProjectSkills` 一致，不含 `~/.pi/agent` |
| 项目技能 | `<cwd>/.agents/skills`、`<cwd>/.pi/skills` | 同上，cwd 来自设置里的项目和会话头 |
| 其它工具目录 | `<cwd>/.claude/skills`、`.codex/skills`、`.cursor/skills` | 仅当 `loadHarnessAssets === true`。这是 Enso 的「加载项目内其它工具目录」，不是去扫 Claude 的会话 |
| MCP 工具名 | `userData/mcp-tool-catalog.json` | 只有工具名和个数。没有 schema |
| Enso 插件 | `userData/extension-plugins/registry.json` 和 `packages/<id>/<dir>/` | 已启用插件的技能、MCP 名、子代理类型、插件预设。圈定方式和 `skillPathsForSpawn` 相同 |
| 已启用的 Claude 插件 | 设置里 `plugins[].enabled`，安装目录来自 `~/.claude/plugins/installed_plugins.json` | Enso 启动会话时会加载这些插件。未在设置里启用的不读 |

会话里算作一次调用的只有：

- 用户消息开头的 `/skill:名字`，以及 `<skill name="名字">`
- `read` 读到某个技能的 `SKILL.md`
- 工具名 `mcp__<服务>__<工具>`（服务名的折法和 `src/agent/mcpNames.ts` 一致）
- `subagent` 且 `operation` 为 `spawn`（没写 operation 时也按 spawn）。`list`、`wait`、`send` 不算

自定义预设对应 `enabledSkillPaths`：只加载预设点名的技能和 MCP，忽略条目自己的 enabled。默认预设才看 enabled。选了自定义预设时 `loadLocalSkills` 会被关掉。项目内其它工具目录的技能仍然跟 `loadHarnessAssets` 走，因为 Enso 把这些路径加在 `additionalSkillPaths` 上。

## 占用怎么估

和 Enso 的上下文占用一样，`ceil(字符数 / 4)`。

- 技能：pi 放进提示词的是名字、描述和路径（`<available_skills>` 里的一段），不是整篇 `SKILL.md`。卡片上的「占用」是这一段；「正文」是文件大小，模型真去读文件时才会进来。`disable-model-invocation: true` 的技能不进提示词。
- 子代理：只算 `subagent` 工具说明里的 `名字 (描述)`，不算子会话的系统提示。内置的 scout、worker、reviewer、tester 与 Enso 的 `BUILTIN_AGENT_TYPES` 一致。
- 按需 MCP（`loadMode: deferred`）：按名字和说明的一行估算。
- 直接加载的 MCP：工具 schema 不在本地缓存里，占用显示为未知，只统计调用。插件不会为了量 schema 去连接服务器。

同名技能同时能进提示词时，只保留优先级更高的一份：项目 `.agents`、项目 `.pi`、设置里登记的、`~/.agents`、pi-agent 目录、pi 设置里的额外路径、项目内其它工具目录、Claude 插件、Enso 插件。子代理是自定义优先于 Claude 插件，再优先于 Enso 插件，最后是内置。

## 它不做什么

- 不读提示词、回答、工具参数正文。
- MCP 只留服务名。不留 `env`、请求头、URL、命令参数。
- 不读 `~/.claude/projects`，也不读 `~/.claude.json`。
- 不联网，不启动 MCP，不改项目文件，不起子代理。
- 计数缓存写在插件自己的数据目录，卸载插件时由 Enso 删掉。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 打开侧栏 |

插件进程能读自己的文件。上面这些 Enso 数据目录不在「当前项目」里，所以没有申请 `fs.read`。清单里的权限仍然只放了侧栏。
