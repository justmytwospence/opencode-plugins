---
title: Background work & delegation
description: Keep long shell jobs and bounded delegated tasks visible in OpenCode, and wait for them without abandoning the turn.
---
**Use:** [opencode-bg](/plugins/opencode-bg/) and [opencode-subagents](/plugins/opencode-subagents/). Neither requires the other. [opencode-herdr](/plugins/opencode-herdr/) is optional, for interactive children.

## Choose the right unit of work

| Work | Use |
| --- | --- |
| Tests, a build, an export | A `bg_run` **job** |
| A dev server, a tunnel, a watcher | A `bg_run` **service** with a `ready` pattern |
| A bounded review, research question or independent change | The `delegate` tool, or OpenCode's own `subagent` |
| A session a person will take over | An interactive [herdr child](/plugins/opencode-herdr/) |

A longer task does not need an interactive pane: a delegated task reports back on its own. OpenCode's `shell` tool can already run a command with `background: true` and tell the session when it exits; the suite adds readiness, waiting inside the turn, logs, kills, a footer count and a panel.

## Start the shell job, then do useful work

Ask the agent:

> Run the project's tests in a background job. While they run, delegate a read-only review of the changed code for edge cases. Do not create a worktree. Wait for both results before concluding.

The `bg_run` call for a project whose test command is `npm test`:

```json
{
  "command": "npm test",
  "kind": "job",
  "name": "tests",
  "timeout": 600
}
```

`bg_run` waits 1.5 seconds before returning, so a command that fails at once is reported in its own result rather than as a wake-up. The `delegate` call for the review:

```json
{
  "task": "Review the current Git diff and the relevant tests for edge cases. Do not edit files. Return concrete findings with paths.",
  "agent": "explore",
  "async": true
}
```

These are **tool arguments**, not shell commands. A child starts fresh unless `context: "fork"` gives it the parent's conversation as background, so the task must carry its constraints and success criteria. Omitting `agent`, `model` or `variant` lets Jev choose them when `TYPESAFE_API_KEY` is set; implicit models stay on the parent's provider. Child sessions make model calls, and Jev calls are paid; see [requirements](/guides/requirements/).

This example uses the same checkout for a read-only review. Parallel writers share files unless you ask for `worktree: true`, which creates `<repo>/.worktrees/<name>` on a `subagent/<name>` branch; the tool's description tells the agent to ask first unless you requested isolation.

## Wait in the turn

When nothing else is left, the agent calls `bg_wait`:

```json
{ "id": "tests" }
```

Ids accept a task's name, a unique id prefix, or nothing (whichever running job of the session ends first). The wait returns when the job ends, when you send a message, on an interrupt, or after `timeout` seconds (default 1800); the job keeps running and still wakes the agent. `bg_wait` returns at once when a message from you is already queued, and it is an error on a service without a `ready` pattern.

A delegated task started with `async: true` delivers its result as a queued message that starts a turn once the parent is idle; meanwhile `delegate` with `action: "status"`, `"result"`, `"steer"` or `"stop"` and the run id inspects or changes it. There is no wait call for a delegated run: a synchronous `delegate` call blocks until the child is idle.

## Read what came back

A job's end or a service's readiness arrives as a synthetic message (`bg` in the transcript) once the session is idle; several that pile up go out as one message. Whatever `bg_wait`, `bg_logs` or `bg_kill` already showed the agent is not repeated. The agent should report failures rather than treat "the wait returned" as "the tests passed": the message carries the job's outcome.

Delegated results arrive as `Subagent single finished:` (or `parallel`, `chain`) with each child's last reply, cut to 2,000 lines or 50 KB, and the child session id for the rest.

## Inspect or intervene

- `/bg` (also `/tasks`, `/bashes`, `/ps`) opens the session panel: running tasks first, then ended ones, with the selected task's last log lines refreshed every second. `x` stops one after a confirmation; `c` hides ended tasks.
- `bg_logs` with an `id` reads a task's log (`lines`, `grep`, `head`); without one it lists the session's tasks.
- `bg_kill` sends SIGTERM to the task's process group, then SIGKILL after 3 seconds. It is not the way to stop a delegated run; that is `delegate` with `action: "stop"`.
- `delegate` with `action: "steer"`, an `id` and a `message` changes a running child's direction.
- The footer shows `2 shells` and `1 failed` for the shown session and its subagents until your next message.

A task you stop from the panel does not report; the agent is told you stopped it.

## Services have a different finish line

```json
{
  "command": "npm run dev",
  "kind": "service",
  "name": "dev",
  "ready": "Local:"
}
```

The `ready` regex is matched case-insensitively (or `/src/flags` for explicit flags) against log lines; a match means the service is up, not that it exited. Pick a real startup message, not a substring that also appears in a failure. A `marimo edit` or `marimo run` server started as a service is named after its notebook and is ready when marimo prints its URL.

Tasks live in the shared server and outlive the terminal. They end on exit, on a kill, when their session is deleted, or when the server stops or the plugin reloads, except services with `keep: true`, which run on and are listed nowhere afterwards. Logs go under `~/.local/share/opencode/bg/<session-id>/`; nothing is written into the project.

## Inside herdr

With [opencode-herdr](/plugins/opencode-herdr/) loaded, the owning session's pane token `bg` names the jobs whose end will wake the agent (`tests`, `tests · build`, `3 jobs`) and clears when they are delivered. Herdr's own OpenCode integration still owns the pane's working and idle state.
