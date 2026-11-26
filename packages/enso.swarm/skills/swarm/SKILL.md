---
name: swarm
description: >-
  Run a swarm: several agents working in parallel on one task, each in its own
  conversation, collaborating through a shared message board. Use when the work
  splits into pieces that can run at the same time, or when a second pair of
  eyes should check the first pair's work.
disable-model-invocation: true
---

# Running a swarm

A swarm is one coordinator (you), some workers, and a board. The board is the
only channel: there is no direct worker-to-worker messaging, and a worker that
is asleep costs nothing. Everything below is about keeping that loop moving
without spending turns on polling.

## The four tools

-   `swarm{action}` — `open`, `status`, `add`, `kill`, `title`.
-   `swarm_post{text, channel?}` — speak on the board. Assigning work is a post.
-   `swarm_read{since?, limit?}` — read the board.
-   `swarm_wait{since, timeoutSec?, mentionsOnly?}` — sleep until someone posts.

`swarm{action:"add"}` does **not** spawn the worker; it posts the brief and
returns the exact `subagent(...)` call to make, spawn it in the same turn.

Every worker is its own session, so the brief carries a one-time key and the
worker's first call is `swarm{action:"bind", key:"…"}`. Until it does, `status`
shows it as `unbound` — that is normal for a few seconds, and a worker that
stays unbound never saw its brief.

## Members

| role | what it is |
| --- | --- |
| `coordinator` | you. Decides, assigns, reports. Does not do the work. |
| `worker` | one slice of the job, in its own conversation. |
| `verifier` | a worker that reports instead of fixing. |
| `narrator` | writes the pane's Overview (`view.json`). Never posts. |
| `monitor` | wakes on a timer, breaks stalls by calling on one member. |

A member's state in `status`:

-   `waiting` — asleep in `swarm_wait`, zero cost.
-   `working` — inside a turn right now.
-   `killed` — permanently gone. Not a pause.

## Writing a brief

A brief is a task, not a topic. It must say:

1.  **The outcome** — what exists when this is done.
2.  **The boundary** — which files, directories, or modules it may touch. This
    is what keeps two workers from editing the same file.
3.  **How to check it** — the test, command, or comparison that decides done.
4.  **What to report back** — the shape of the post you want.
5.  **The instrument** — when the answer is a count or a list, name the exact
    command and say whether it respects `.gitignore`. `find docs -name '*.md'`
    and `rg --files docs | wc -l` disagree on ignored directories, so two
    workers measuring "all the docs" with different tools will report
    different numbers and neither is wrong. Pin the command, or ask for the
    command alongside the number.

Do not paste the user's request. Workers cannot see it.

## Keeping the loop alive

```
status → assign by name → swarm_wait{since:head} → swarm_read → decide → …
```

-   Use `swarm_wait`, not a `swarm_read` loop. Reading costs a turn; waiting
    does not.
-   `since` must be the highest seq you have actually read. If you pass the head
    you skip the very posts you were waiting for.
-   After `swarm_wait` returns, `swarm_read` once and act. Do not narrate the
    board to the user post by post; they have the pane.

## Addressing

-   `@name` wakes exactly that member for exactly one turn.
-   `@all` wakes everyone. Reserve it for "the plan changed for all of you".
-   `@#channel` calls everyone subscribed to that channel.
-   A post with no `@` wakes nobody. It is still the record of what happened, so
    write the closing `[done]` post without an `@`.

## When it stalls

Symptom: every worker `waiting`, nothing `working`, job unfinished.

1.  `swarm_read{since:lastSeen}` — is there an unanswered `[blocked]`?
2.  If a worker asked a question, answer it: `@name <decision>`.
3.  If work is unassigned, assign it.
4.  If a worker died or its model is out of quota, `kill` it and split its slice
    among the survivors.
5.  If nothing is left to do, write the `[done]` post, `kill` the workers, and
    tell the user.

A monitor that posts `@coordinator [stall]` is telling you step 1 already.

## Reporting to the user

-   One short paragraph, not a transcript. The pane has the details.
-   Name what finished, what is blocked, and what you decided.
-   End with the `open_board` value the tools returned, verbatim.

## Pitfalls

-   **Guessing filesystem paths.** The board lives in the plugin's data
    directory. Use `swarm_plan` for the Overview and stop there; a path you
    invent is written somewhere the pane never reads.
-   **Reading instead of waiting.** Ten `swarm_read` calls cost ten turns.
-   **Assigning by topic.** "Look at the parser" produces exploration, not a
    result. Give an outcome and a boundary.
-   **Fan-out without a verifier.** Parallel work drifts; someone must check it
    against the original requirement.
-   **Killing to pause.** `kill` deletes the worker's conversation; nothing it
    learned survives.
-   **Forgetting the pane.** The user watches the board. If the Overview is
    stale, tell the narrator what changed instead of rewriting the board.
