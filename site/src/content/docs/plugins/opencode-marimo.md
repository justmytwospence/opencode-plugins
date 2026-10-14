---
title: opencode-marimo
description: Follows the marimo notebooks open under your project so the OpenCode agent knows what they look like and what they are doing, without taking over the kernel.
plugin: opencode-marimo
---
An OpenCode 2 plugin that follows the [marimo](https://marimo.io) notebooks open under your project, so the agent knows what they look like and what they are doing without being asked. The port of pi-marimo; `src/core` is shared with it verbatim. It pairs with the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill, which is how the agent inspects and changes the notebook; this plugin only reads.

Source: [packages/opencode-marimo](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-marimo).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-marimo@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-marimo"
]
```

## Requirements and costs

A running marimo server. Servers started with `--no-token` register themselves in marimo's server registry, which is how they are found; token-protected servers are reached with `MARIMO_TOKEN` from the server's environment. No model or Jev requests of its own; the state block adds to the system prompt of each request of a turn. The herdr token and notification need [opencode-herdr](/plugins/opencode-herdr/) and do nothing without it. Tested with OpenCode 2.0.24.

## What you see

- **Prompt line (terminal):** right after the footer's `dir:branch`, the current notebook (the one used most recently), `marimo fit.py · 1 error · +2`, and while a cell runs `marimo ▸ Model fit 12s · 1 error · +2`: the markdown section the running cell sits under (the whole heading path when it is short, else the deepest heading); `+2` counts the other notebooks followed.
- **Sidebar (terminal):** every followed notebook by name under OpenCode's context and cost, the current one first and marked, with what its kernel is doing.
- **`/marimo`:** a checklist of the notebooks open on your marimo servers to pin (also in the command palette as "marimo: choose the notebooks followed"); `/marimo auto` follows every notebook open under the project directory, `/marimo off` stops following, `/marimo show` displays the state block the next prompt would carry. The choice is kept per project directory across restarts.
- **herdr:** when a turn ends while a cell the agent started is still running, the pane token `marimo` says what runs (`fit.py: Model fit`) until the kernel goes quiet, then a herdr notification says it finished, with the done sound unless the pane is focused. Add `$marimo` to a row in `[ui.sidebar.agents]` to show the token. The pane's state stays `idle`: herdr's OpenCode integration is the sole authority over it.

## What the model sees

When you send a prompt, the state of every followed notebook is taken once and appended to the system prompt of every model request of the turn (the session's `context` hook; title, compaction and other auxiliary requests are left alone). The current notebook comes first and in full: its outline (markdown headings), one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited but not rerun, changed by you in the browser since the agent's last turn ended); the others follow as short outlines with only the cells that need attention. It is never stored, so old copies never pile up, and it does not change during the turn: a block refreshed on every request would invalidate what the model reasoned after it. At the next prompt a fresh copy replaces it.

## How it works

The server half subscribes to each notebook session's `/sse` stream as a marimo *kiosk* consumer: a read-only viewer that cannot run or edit code and never takes the notebook over from your browser. marimo replays the session on connect, then streams the cell document, each cell's status and errors, and the dataflow graph. Outputs are dropped and nothing runs in the kernel.

OpenCode 2 runs the server half once per project directory, in the background service shared by every terminal, so the watcher is the directory's and everything else is kept per session. It follows every notebook open under the directory (up to eight, leaving out hidden directories such as `.worktrees/`). The current one is the one the session's agent last worked in, read from its marimo-pair tool calls (`--file`, `--session`, or `--url` when only one followed notebook is on that server), so two sessions in two notebooks each keep their own. Before the agent has touched any, it is the one used most recently by anyone: a running cell first, then the latest cell run or edit.

The terminal half asks the server for the report of the session it shows over the plugin RPC and is told when it changes; the elapsed time of a running cell ticks locally.

## Settings

`MARIMO_NOTEBOOK=/path/a.py,/path/b.py` in the server's environment pins a set instead (or `off` disables the plugin), as does the plugin option `notebook` with the same syntax, which wins; a `/marimo` choice saved for the directory wins over both. There is no settings file.

See the [notebook sessions recipe](/recipes/notebooks/) for starting a server with [opencode-bg](/plugins/opencode-bg/) and the editing workflow.
