---
title: Notebook sessions
description: Follow marimo notebook state from OpenCode, distinguish server readiness from kernel completion, and keep editing in the marimo-pair workflow.
---
**Use:** [opencode-marimo](/plugins/opencode-marimo/). Add [opencode-bg](/plugins/opencode-bg/) to start and wait on the server, and the separate [marimo-pair](https://github.com/marimo-team/marimo-pair) skill to inspect and change notebooks.

opencode-marimo only reads. It subscribes to each notebook session's SSE stream as a marimo *kiosk* consumer, a read-only viewer that cannot run or edit code and never takes the notebook over from your browser. Outputs are dropped; the outline, the cells, their status, errors and the dataflow graph are what it keeps.

## Start a local notebook server

If marimo is installed in your project's environment, ask the agent to start a service with `bg_run`:

```json
{
  "command": "marimo edit --no-token notebooks/fit.py",
  "kind": "service",
  "name": "fit notebook"
}
```

Use the command that selects your environment, such as `uv run marimo edit`, if needed. opencode-bg names a `marimo edit` or `marimo run` service after its notebook and reports it ready when marimo prints its URL.

:::caution[Local example, not a public server recipe]
`--no-token` makes the server register itself in marimo's server registry, which is how opencode-marimo discovers it, but disables marimo's token authentication. Do not expose an unauthenticated notebook server publicly. Token-protected servers need `MARIMO_TOKEN` in the environment of OpenCode's server.
:::

## Confirm what the agent is following

```text
/marimo
/marimo show
```

The first opens a checklist of the notebooks open on your marimo servers, to pin some; the second displays the state block the next prompt would carry. Automatic discovery follows every notebook open under the project directory, up to eight, leaving out hidden directories such as `.worktrees/`. The choice is kept per project directory across restarts.

- `/marimo auto` returns to following every notebook open under the directory.
- `/marimo off` stops following.
- The footer shows the current notebook right after `dir:branch`: `marimo fit.py · 1 error · +2`, and while a cell runs `marimo ▸ Model fit 12s · 1 error · +2`, where the heading is the markdown section the running cell sits under and `+2` counts the other notebooks followed.
- The session sidebar lists every followed notebook under OpenCode's context and cost, the current one first.

The current notebook is the one the session's agent last worked in, read from its marimo-pair tool calls; before it has touched any, it is the one used most recently by anyone. Two sessions in two notebooks each keep their own.

## Make a change through the editing workflow

Ask the agent to use marimo-pair, not to treat opencode-marimo as an editing tool:

> Use marimo-pair to inspect the notebook. Add one small section, run it, and wait for its cells to finish. Tell me about errors before doing more.

When you send a prompt, the state of every followed notebook is taken **once** and appended to the system prompt of every model request of that turn (title, compaction and other auxiliary requests are left alone). The current notebook comes first and in full: its outline, one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited but not rerun, changed by you in the browser since the agent's last turn). The others follow as short outlines with only the cells that need attention. The block is never stored, so old copies never pile up, and it does not change during the turn; at the next prompt a fresh copy replaces it.

For the latest output during a turn, the agent should use marimo-pair's results. The observation block has no outputs by design.

## Wait for cells, not just the server

A running cell outlives a turn when the agent started it and moved on. Inside herdr, the pane token `marimo` says what runs (`fit.py: Model fit`) until the kernel goes quiet, then a herdr notification says it finished, with the done sound unless the pane is focused. The pane's state stays `idle`: herdr's own OpenCode integration is the sole authority over it. This needs [opencode-herdr](/plugins/opencode-herdr/) loaded and does nothing without it.

Long marimo-pair execute calls can themselves run as background jobs through `bg_run`; those calls block until their cells finish. Do not launch concurrent edits as a way around a running cell.

## Stop the right thing

- Stopping a marimo-pair **client job** stops that command, not the cells it already requested.
- Killing the **server service** (`bg_kill`, or `x` in `/bg`) stops the server's process group.
- Esc from `bg_wait` only stops waiting.
- `/marimo off` stops observation; it does not touch the server or the kernel.

## Pin from the environment

`MARIMO_NOTEBOOK=/path/a.py,/path/b.py` in the server's environment pins a set instead of discovery (or `off` disables the plugin), as does the plugin option `notebook` with the same syntax, which wins; a `/marimo` choice saved for the directory wins over both. See the [reference](/plugins/opencode-marimo/) for the server and terminal halves and [requirements](/guides/requirements/) for what the server needs.
