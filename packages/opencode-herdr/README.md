# opencode-herdr

opencode's own [herdr](https://herdr.dev) additions, beside the integration herdr installs
(`herdr integration install opencode`, which reports the pane's state and session). The port of
[pi-herdr](https://github.com/justmytwospence/pi-herdr); `src/core` and `test/core` are shared
with it verbatim.

## Server: herdr children and `$bg`

The `herdr_child` tool starts an interactive opencode in its own herdr pane and gives it a task:

| action | |
|---|---|
| `spawn` | `task`, optional `name`, `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model` (default: this session's latest), `focus` |
| `send` | `name`, `message`: ask it something more |
| `read` | `name`: its last reply, or its screen while it works |
| `list` | this session's children and their state |
| `interrupt` | `name`: Escape, ending its current turn |
| `close` | `name`: close its pane (the session stays; a worktree's checkout and branch stay) |

`where: "worktree"` runs `worktree new <branch> --no-open` (checkouts in `<project>/.worktrees/`)
and opens the checkout through herdr as the repo's grouped child space, with the child in it.

The child is told it is a child and that its final reply goes back. Each reply to a message the
parent sent (the task, or `send`) arrives in the parent session as a new prompt (`Herdr child
"x" replied: ...`), which starts a turn. The reply is the last assistant text of the session herdr's
opencode integration reports for the child's pane, read through this server's client (sessions
share opencode's database), else through `opencode export`. Turns the user starts by typing in the
child's pane are not sent back. While a reply is pending the pane token `$bg` names the child
(`child auth-fix`). Children are saved per parent session in
`~/.local/share/opencode-herdr/children/<session>.json`, so pending replies survive a restart.

Use a subagent (opencode's `task` tool) for delegated work that reports back to the parent, even
when long, multi-step, or parallel. Use a Herdr child only for an explicit interactive-session
request or a clear persistent, human-led handoff that the user will continue independently.
Duration and a hypothetical desire to watch are not reasons to create an interactive session.

Choose layout only after deciding an interactive session is appropriate:

- `tab` (default): same checkout and branch, in the existing Herdr space.
- `split`: deliberate side-by-side interaction, or a requested split.
- `worktree`: user-requested independent branch/checkout, in that checkout's own space (or a tab
  there if already open). Ask first unless the user requested a worktree or branch isolation.

Tabs and splits share files and are not isolated parallel editors. Never create a new space or
checkout merely because work is delegated, long, or parallel. Preserve focus unless asked to
switch.

Only a server in a herdr pane does anything: opencode's TUI runs its server in-process, so it sees
`HERDR_PANE_ID`. A shared server (`opencode serve`, or the one behind `opencode attach`) cannot tell
which pane asked and registers nothing.

## TUI: title, model and `$pr`

- **The pane's title** and the token `$task`: the title opencode writes for the session on screen.
- **The displayed agent name**: `opencode opus-5-5:high` (model and variant of the latest message),
  which the `agent` row token shows. Both apply only while herdr's opencode integration holds the
  pane.
- **`$pr` space token**: the branch's pull request from `gh pr view` (`#123 ✓ approved`,
  `#123 draft …`, `#123 merged`), checked at start, after each turn and every 3 minutes. A space
  shows it only while an opencode (or pi with pi-herdr) runs in it. `PI_HERDR_PR=0` turns it off.

opencode has no event bus between plugins, so there is no counterpart to pi-herdr's bridge:
opencode-cache-guard and opencode-marimo keep their own herdr reporters.

## Install

The server and TUI halves are two exports of one package. Pin the same commit in both configs:

```jsonc
// opencode.jsonc
"plugin": ["opencode-herdr@github:justmytwospence/opencode-herdr#<commit>"]

// tui.jsonc
"plugin": ["opencode-herdr@github:justmytwospence/opencode-herdr#<commit>"]
```

Tested with opencode 1.18.29 and herdr 0.9.3.

## Development

```sh
npm ci
npm run check                                              # typecheck + unit tests
node --experimental-strip-types test/live-child.mts tab    # inside herdr: a real child, PONG
```

To try a checkout in a real opencode, point both configs at it:

```sh
printf '{"plugin":["opencode-herdr@file:%s"]}' "$PWD" > /tmp/oc-herdr.json
OPENCODE_CONFIG=/tmp/oc-herdr.json OPENCODE_TUI_CONFIG=/tmp/oc-herdr.json opencode
```

MIT licensed.
