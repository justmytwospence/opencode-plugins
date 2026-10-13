# opencode-marimo

An [opencode](https://opencode.ai) plugin that follows the [marimo](https://marimo.io) notebooks open
under your project, so the agent knows what they look like and what they are doing without being
asked.
The port of [pi-marimo](https://github.com/justmytwospence/pi-marimo); `src/core` is shared with it
unchanged.

- **Prompt line (TUI):** the current notebook (the one used most recently), `marimo fit.py · 1 error
  · +2`, and while a cell runs `marimo ▸ Model fit 12s · 1 error · +2`: the markdown section the
  running cell sits under (the whole heading path when it is short, else the deepest heading), so
  you can tell roughly what is running; `+2` counts the other notebooks followed.
- **Sidebar (TUI):** every followed notebook by name, the current one first and marked, with what
  its kernel is doing.
- **Context (server):** when you send a prompt, the state of every followed notebook is taken once
  and placed right after that prompt for every model request of the turn. The current notebook comes
  first and in full: its outline (markdown headings), one line per code cell with what it defines,
  and what needs attention (running, queued, errors, stale, edited but not rerun, changed by you in
  the browser since the agent last went idle); the others follow as short outlines with only the
  cells that need attention. It is
  added in `experimental.chat.messages.transform` and never stored, so old copies never pile up.
  It does not change during the turn on purpose: Anthropic drops a thinking block when anything
  before it changes, so a block refreshed on every request would cost the model its reasoning from
  the previous step. At the next prompt the old copy goes, which drops that earlier turn's thinking
  once and re-reads the turn after it uncached once.

- **herdr (TUI):** when a turn ends while a cell the agent started is still running, the pane token
  `marimo` says what runs (`fit.py: Model fit`) until the kernel goes quiet, then a herdr
  notification says it finished, with the done sound unless the pane is focused. Add `$marimo` to a
  row in `[ui.sidebar.agents]` to show the token. The pane's state stays `idle`: herdr's opencode
  integration is the sole authority over it. See pi-marimo's README.

It pairs with the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill, which is how the
agent inspects and changes the notebook; this plugin only reads.

## How it works

Both halves subscribe to the notebook session's `/sse` stream as a marimo *kiosk* consumer: a
read-only viewer that cannot run or edit code and never takes the notebook over from your browser.
marimo replays the session on connect, then streams the cell document, each cell's status and errors,
and the dataflow graph. Outputs are dropped and nothing runs in the kernel. See pi-marimo's README for
the details (browser edits, sessions sharing a file).

It follows every notebook open under the project directory (up to eight, leaving out hidden
directories such as `.worktrees/`), found through marimo's server registry (servers started with
`--no-token` register themselves). The current one is the one the agent last worked in, read from
its marimo-pair calls (`--file`, `--session`, or `--url` when only one followed notebook is on that
server), so two opencode sessions in two notebooks each keep their own. Before the agent has
touched any, it is the one used most recently by anyone: a running cell first, then the latest cell
run or edit. Set `MARIMO_NOTEBOOK=/path/a.py,/path/b.py` to pin a set
instead (or `off` to disable the plugin).
Token-protected servers are reached with `MARIMO_TOKEN`.

## Install

The server and TUI halves are two exports of one package. Pin the same commit in both configs:

```jsonc
// opencode.jsonc
"plugin": ["opencode-marimo@github:justmytwospence/opencode-marimo#<commit>"]

// tui.jsonc
"plugin": ["opencode-marimo@github:justmytwospence/opencode-marimo#<commit>"]
```

There is no build step: `src/tui.ts` is plain TypeScript that takes Solid from opencode itself
(`src/host.ts`), since opencode does not compile JSX inside a git install. Tested with opencode
1.18.29.

## Development

```sh
npm ci
npm run check   # typecheck, unit tests, and an end-to-end test against a real marimo server
```
