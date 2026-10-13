# opencode-bg

An [OpenCode 2](https://opencode.ai) plugin for background jobs and services, the port of
[pi-bg](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-bg). The agent starts a
long command with `bg_run` and keeps working; a **job** (tests, builds, fits, exports) wakes the
agent with its outcome when it exits, and a **service** (a dev or notebook server, a tunnel, a
watcher) wakes it once when a `ready` pattern matches a log line, or if it exits. When nothing is
left but a job's result, the agent calls `bg_wait` instead of ending its turn, so the session stays
working until the job ends; a message from you, an interrupt, or the wait's timeout ends the wait
while the job keeps running and still wakes the agent.

OpenCode's own `shell` tool can already run a command in the background and tell the session when
it exits. This adds what it lacks: services with a readiness line, waiting inside a turn, logs,
kills, a count in the footer and a `/bg` panel.

## Tools

| tool | parameters |
|---|---|
| `bg_run` | `command`, `kind` (`job` or `service`, required), `name`, `ready` (service only: a regex matched case-insensitively, or `/src/flags`), `timeout` (job only: seconds before it is killed), `keep` (service only: outlive the session and the server), `cwd` |
| `bg_wait` | `id` (default: whichever running job of the session ends first), `timeout` (seconds, default 1800, max 3600) |
| `bg_logs` | `id` (omit to list the session's tasks), `lines` (default 60, max 400), `grep`, `head` |
| `bg_kill` | `id`: SIGTERM to the task's process group, SIGKILL after 3 seconds |

Ids also accept a task's name (the most recent task with it) or a unique id prefix. `bg_run` waits
1.5 seconds before returning, so a command that fails at once (a typo, a missing file) is reported
in its own result instead of as a wake-up. `bg_wait` returns at once, without waiting, when a
message from you is already queued for the agent. `bg_wait` on a service without a `ready`
pattern is an error: there is nothing to wait for until it exits. A `marimo edit` or `marimo run`
server started as a service is named after its notebook and is ready when marimo prints its URL.

**Wake-ups.** A job's end, or a service's readiness, is delivered to the session that started it
as a synthetic message queued for delivery (`session.synthetic`, `delivery: "queue"`), which
OpenCode hands to the agent once the session is idle and then runs a turn on; it shows as `bg` in
the transcript. One that comes due during a turn waits for the turn to end, and several that pile
up go out as one message. Whatever `bg_wait`, `bg_logs` or `bg_kill` has already shown the agent
is no longer owed. A task you stop from the panel does not report; the agent is told you stopped
it.

## Processes and files

Each task runs `bash -c <command>` (`/bin/sh` when `/bin/bash` is missing) in its own process
group, with `OPENCODE_BG_TASK_ID` set to its id and stdout and stderr appended to
`~/.local/share/opencode/bg/<session-id>/<id>.log` (under `$XDG_DATA_HOME` when set;
`OPENCODE_BG_DIR` moves the whole directory). Nothing is written into the project. A running
task's log is cut back to its last megabyte once it passes 64 MB; log directories older than a
week are deleted when the server starts.

Tasks belong to the session whose agent started them and live in OpenCode's shared server, so they
outlive the terminal: closing the TUI changes nothing. They end when they exit, when they are
killed, when their session is deleted (along with anything a task left running in its process
group), or when the server stops or the plugin reloads, except services started with `keep: true`,
which run on and are listed nowhere afterwards. A server that crashed leaves a state file; the next
server kills the tasks it lists, after checking that each pid still runs the task's command.

## Terminal

- **Footer.** Right after OpenCode's `dir:branch`: `2 shells`, plus `1 failed` in the error color
  while a failed or timed-out task you have not seen is there (until your next message, or until
  you clear it in the panel). Tasks started by the shown session and its subagents count.
- **`/bg`** (also `/tasks`, `/bashes`, `/ps`, and "Background tasks" in the command palette)
  opens a session panel: every task of the session family, running first (oldest first), then
  ended (newest first), each with its command and state (`waiting` while a `bg_wait` is on it;
  `starting`, `ready` or `service` for services), and the selected task's last log lines,
  refreshed every second.

  | key | action |
  |---|---|
  | `j`/`k`, arrows | select |
  | `x` | stop the selected running task (after a confirmation) |
  | `c` | hide ended tasks |
  | `f` | toggle full screen |
  | `q`, Esc | close |

## herdr

With [opencode-herdr](../opencode-herdr) loaded, the pane token `bg` of the owning session names
the jobs whose end will wake the agent (`tests`, `tests · build`, `3 jobs`) and clears when they
are delivered. The calls go through opencode-herdr's `herdr` RPC and are ignored when it is absent;
they are sent again when it comes up.

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-bg@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-bg"
]
```

Needs `bash` (or `/bin/sh`) and `ps`. No settings file; see the environment variables above.
Tested with OpenCode 2.0.24.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
