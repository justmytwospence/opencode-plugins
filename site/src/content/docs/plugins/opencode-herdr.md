---
title: opencode-herdr
description: OpenCode's herdr additions beside herdr's own integration, with the herdr_child tool for interactive children, pane metadata, and the herdr RPC other components report through.
plugin: opencode-herdr
---
OpenCode's own [herdr](https://herdr.dev) additions, beside the integration herdr installs (`herdr integration install opencode`, which reports the pane's state and session). The port of pi-herdr to the OpenCode 2 plugin API; `src/core` is shared with it.

OpenCode 2 runs every plugin's server half once, in one background service shared by all terminals and herdr panes, so the component has two halves that talk through plugin RPC: the server half (the `herdr_child` tool, the `herdr` RPC, the children bookkeeping) and the terminal half (everything about the pane it runs in).

Source: [packages/opencode-herdr](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-herdr).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-herdr@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-herdr"
]
```

## Requirements and costs

OpenCode running inside a herdr pane, with herdr's own OpenCode integration. Tested with OpenCode 2.0.24 and herdr 0.9.3. Worktree children need the `worktree` helper; the `$pr` token needs an authenticated `gh`. A child session makes model calls at your configured access. No Jev calls.

## Server: herdr_child

The `herdr_child` tool starts an interactive OpenCode in its own herdr pane and gives it a task:

| Action | |
| --- | --- |
| `spawn` | `task`, optional `name`, `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model` (`provider/model[#variant]`, default: this session's), `focus` |
| `send` | `name`, `message`: ask it something more |
| `read` | `name`: its last reply, or its screen while it works |
| `list` | This session's children and their state |
| `interrupt` | `name`: Escape, ending its current turn |
| `close` | `name`: close its pane (the session stays; a worktree's checkout and branch stay) |

The OpenCode 2 TUI takes no `--model`, so the child's session is created first by the server half, in the child's directory and with the model, and the child starts on it with `opencode --session <id>`. `where: "worktree"` runs `worktree new <branch> --no-open` (checkouts in `<project>/.worktrees/`) and opens the checkout through herdr as the repo's grouped child space, with the child in it.

The child is told it is a child and that its final reply goes back. Each reply to a message the parent sent arrives in the parent session as a new queued prompt (`Herdr child "x" replied: ...`), which starts a turn. Turns the user starts by typing in the child's pane are not sent back. While a reply is pending, the root session's pane token `$bg` names the child. Children are saved per parent session in the plugin's storage, so `list`, `send` and pending replies survive a restart.

The tool needs the session (or its root) open in OpenCode inside a herdr pane with this component's terminal half loaded; otherwise it fails with a clear message. A child of a session running with `--standalone` cannot be read by the shared service's server half.

## When to use a child

Use a subagent (OpenCode's `task` tool, or the suite's [delegate](/plugins/opencode-subagents/)) for delegated work that reports back to the parent, even when long, multi-step or parallel. Use a herdr child only for an explicit interactive-session request or a clear persistent, human-led handoff that the user will continue independently. Choose the layout only after deciding an interactive session is appropriate:

- `tab` (default): same checkout and branch, in the existing herdr space.
- `split`: deliberate side-by-side interaction, or a requested split.
- `worktree`: a user-requested independent branch and checkout, in that checkout's own space. Ask first unless the user requested a worktree or branch isolation.

Tabs and splits share files; they are not isolated parallel editors. Never create a new space or checkout merely because work is delegated, long or parallel. Preserve focus unless asked to switch.

## The herdr RPC

The `herdr` RPC (`src/herdr-rpc.ts`) is how other components report to herdr without herdr code of their own, the role pi-herdr's event bus plays for Pi: `token { sessionID, key, value?, ttlMs? }`, `notify { sessionID, title, body?, sound?, unlessFocused? }`, `zoom { sessionID, holder, active }`, `state { sessionID }`. Calls are per session; the server half stores the tokens and re-emits every call as an event, and the terminal half showing that session's family applies it to its pane. It emits `ready` once registered, so a component whose calls failed earlier can resend its state. [Background work](/plugins/opencode-bg/), [cache guard](/plugins/opencode-cache-guard/) and [marimo](/plugins/opencode-marimo/) report through it; they copy the contract file verbatim and import nothing else of opencode-herdr.

## Terminal: title, model, tokens and $pr

- **The pane's title** and the token `$task`: the title OpenCode writes for the session on screen.
- **The displayed agent name**: `opencode opus-4-6:high` (the prompt's model and variant), which the `agent` row token shows. Both apply only while herdr's OpenCode integration holds the pane.
- **Tokens, notifications and zoom** from the `herdr` RPC for the shown session's family, fetched with `state` when the pane starts showing a session.
- **`$pr` space token**: the branch's pull request from `gh pr view` (`#123 ✓ approved`, `#123 draft …`, `#123 merged`), checked at start, after each turn and every 3 minutes. A space shows it only while an OpenCode (or pi with pi-herdr) runs in it. `PI_HERDR_PR=0` turns it off.

Herdr's own OpenCode integration owns the pane's working, blocked and idle state, including pending permission requests and question forms, so this component reports no state.

## Development notes

Besides `npm run check`, the package has `test/live-chain.mts` (both halves against a fake herdr, a scratch OpenCode and the mock provider; needs tmux) and `test/live-child.mts tab` (inside herdr: a real child). See [development and testing](/development/).
