# pstack in EnsoCode

pstack skills use Cursor names. In EnsoCode, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds `skills/`, `agents/` and `docs/`, two levels above the `SKILL.md` you were given. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

## Tools

| Cursor | EnsoCode |
| --- | --- |
| `Task` | `subagent` with `operation: "spawn"`. `description` and `prompt` are required. Use `operation: "wait"` only when the next step needs the result, `report` to read a finished Run, and `stop` to cancel one. |
| `AskQuestion` | `ask_user` with 2 to 4 `options`. In an unattended run, also pass `timeout_seconds` and `default_option`. |
| Open a todolist | `todo`. Pass the full list on every call. |
| Run another pstack skill (`/name` or "the **name** skill") | `read` `<pstack>/skills/<name>/SKILL.md` and follow it. Most pstack skills are hidden from the skill catalog, so a missing catalog entry does not mean the skill is absent. When you tell the user to type it, write `/skill:<name>`. |
| `Grep`, `Glob`, `Read` | `grep`, `find`, `read`. |
| A pstack fan-out the user asks to run as a workflow | `workflow` with `preset: "arena"` or `preset: "interrogate"` runs the same shape when the user asks for a workflow. Otherwise follow the skill. |

## Subagent fields

| Cursor | EnsoCode |
| --- | --- |
| `subagent_type: generalPurpose` | `agent_type: "worker"`. `worker` requires `model`; see Models. |
| `poteto-agent` | `agent_type: "pstack:poteto-agent"` with the role's `model` (see Models). Put `<pstack>/skills/poteto-mode/SKILL.md` in the brief with `<pstack>` written as an absolute path. If the `agent_type` list lacks `pstack:poteto-agent`, the session is not on the poteto-mode preset: use `agent_type: "worker"` and start the brief with "Read `<pstack>/agents/poteto-agent.md` and follow it." |
| `comment-sicko` | `agent_type: "pstack:comment-sicko"` with the role's `model` (see Models). If the `agent_type` list lacks it, use `agent_type: "worker"` and start the brief with "Read `<pstack>/agents/comment-sicko.md` and follow it." with `<pstack>` written as an absolute path. |
| `readonly: true` | `agent_type: "scout"` for recon or `"reviewer"` for review, with `model`. Both have only `read`, `grep`, `find`, `ls` and no shell. When the task must run commands, use `worker`, say "do not edit files" in the brief, and check `git status` afterward. |
| `readonly: false` | `agent_type: "worker"`. |
| `environment: "cloud"` | EnsoCode has no isolation field. Tell the worker to create its own copy with `git worktree add --detach /tmp/<unique-name> <ref>`, work only there, and report the path. Name the branch or commit it checks out. |
| `environment: "local"` | Omit. |
| `cloud_base_branch: <b>` | Use `<b>` as the `<ref>` of that worktree. |
| `run_in_background: true` | Omit. Spawn returns at once by default (`wait: false`) and you are notified when the Run finishes. |
| `resume` | Spawn with `mode: "coworker"` when you know you will resume, then `operation: "send"` with its `agentId`, and `dismiss` it when done. For a finished task agent, spawn a new one and paste the earlier result into its brief. |
| `file_attachments` | List the paths in the brief. |

## Models

The `subagent` tool schema lists the valid `model` values. Each is `<provider>/<model id>`. Reasoning effort is the separate `thinking` field, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

| Cursor | EnsoCode |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | `model`: the listed value whose part after the last `/` is `claude-<family>-<version>` or starts with it, such as `Max/claude-opus-5-5`, and `thinking: "<effort>"`. Drop `-fast`. |
| A `grok-*`, `gpt-*`, or other slug, such as `grok-4.7-xhigh-fast` | Same rule. Strip the effort and `-fast`, then pick the listed value whose part after the last `/` starts with the rest, such as `grok-4.7`. With no match, use the `inherit-parent` row and say so. |
| `auto` or `inherit-parent` | Pass the listed value whose part after the last `/` equals `$PI_MODEL`, else the first listed value, and say so. Alias entries in a panel list still count toward its fan-out. |
| The `subagent` tool lists no `model` values | Omit both `agent_type` and `model`; the subagent runs on the session model. Say so once. |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | `~/.agents/pstack-models.md`. EnsoCode does not load it into the session, so `read` it the first time a skill needs a role's model, once per session. A missing file is normal and means `/skill:setup-pstack` has not run, so do not retry or search for it. If the file or the role's line is missing, use the skill's default slug, and tell the user once that `/skill:setup-pstack` sets the models. |
| A role value `<model> <effort>`, such as `Max/claude-opus-5-5 xhigh` | `model: "Max/claude-opus-5-5"` and `thinking: "xhigh"`. The effort is the last token, and a model value may contain spaces. |

## setup-pstack

Follow its steps with these changes:

- Detect. The detected models are the `model` values the `subagent` tool schema lists, each with an effort from the `thinking` values. Write a real model as `<model> <effort>`, such as `Max/claude-opus-5-5 xhigh`. The effort is the last token, so the budget step works as written.
- Defaults. Map each default slug with the rows above, so `claude-opus-5-5-xhigh-fast` becomes the matching listed value with `xhigh`, and `gemini-4-neon-high` likewise. A default with no listed match becomes `inherit-parent`.
- Write. Write `~/.agents/pstack-models.md` with no frontmatter, then the comment lines, the `# defaults: 3` line, the `# budget` line, and one line per role from step 5. Overwrite the whole file. Never put the role lines in `AGENTS.md`.
- Confirm. Say the file applies to new sessions, which read it on demand.

## Paths

| Cursor | EnsoCode |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.agents/skills/`, `~/.agents/skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | EnsoCode installs this plugin under `extension-plugins/packages/` in its app data folder, such as `~/Library/Application Support/enso-code/extension-plugins/packages/` on macOS. Its manifest is `<pstack>/enso-plugin.json`. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md`, or `CLAUDE.md` when the project uses it. EnsoCode never reads `.mdc` files. The model rule is the exception. See Models. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. The plugin ships the skills, `agents/`, `docs/guide/`, and `README.md`. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | The current session is `$PI_SESSION_FILE`. Other sessions are the `.jsonl` files in the same folder, and the first line of each holds its `cwd`, so read only those whose `cwd` is this workspace. Subagent sessions are not linked to their parent, so read a delegate's result with `subagent` `report`. |

## Cursor-only features

EnsoCode has no Cursor Automations, Bugbot, Cursor cloud agents, or built-in PR tool. When a step needs one, put one line in your reply, `Skipped in EnsoCode: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | EnsoCode |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command that the step gives. Skip a step that starts, waits for, or configures Bugbot when the PR has no Bugbot check or comment. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagent fields. Skip a step that needs the cloud agent itself, such as its dashboard status or its own machine. |
| A built-in PR tool | Use the forge command that the step gives, such as `gh pr create`. That is not a skip, so write no line. |
