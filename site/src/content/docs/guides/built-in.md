---
title: Built into OpenCode 2
description: The ten Pi Plugins components that were not ported, and the OpenCode 2 feature that covers each one or the reason it cannot be done.
---
[Pi Plugins](https://github.com/justmytwospence/pi-plugins) has 26 components; this suite ports 16 of them. The other ten either duplicate something OpenCode 2 already does, or need a hook that OpenCode's plugin API does not expose. This page maps each one, so that you know what to reach for instead. OpenCode's own behavior is described as of its 2.0 documentation; its [TUI](https://opencode.ai/v2/docs/cli/tui), [keybinds](https://opencode.ai/v2/docs/cli/keybinds) and [agents](https://opencode.ai/v2/docs/agents) pages are the authority.

## Covered by OpenCode

| Pi component | What it did | In OpenCode 2 |
| --- | --- | --- |
| pi-ask-user-question | An `ask_user_question` tool: up to four multiple-choice questions in a dialog | The built-in `question` tool: one or more questions with a header, prompt and choices, a free-form answer always available, `multiple` for several choices. The [tool gate](/plugins/opencode-tool-gate/) lists it in `allowTools`. |
| pi-plan-mode | Plan mode in your conversation (read-only research, a plan file, approval), and a two-planner screen | The built-in **Plan** agent (`plan`): it explores without editing project files and may write OpenCode plan files when asked; Shift+Tab cycles agents. The [tool gate](/plugins/opencode-tool-gate/)'s `plan` mode denies edits while judging commands as in auto mode, with no plan file. The two-planner screen has no equivalent. |
| pi-rewind | Restored files alongside `/tree` and `/fork` conversation rewinds | `/undo` reverts the latest user message and the work that followed it and returns the prompt to the composer; `/redo` restores it. Sending a new prompt accepts the revert. |
| pi-stash | Stashing the main editor's draft | The `prompt.stash`, `prompt.stash.pop` and `prompt.stash.list` commands (no default keys; bind them in `cli.json` `keybinds`). [Cache guard](/plugins/opencode-cache-guard/) uses this stash to hold a prompt. |
| pi-appearance-resync | Kept a light/dark theme in step with the terminal inside a multiplexer | `theme.mode: "system"` in `cli.json` follows the terminal appearance; `theme.switch_mode` and `theme.mode.lock` are commands. |

## Covered differently

| Pi component | What it did | In OpenCode 2 |
| --- | --- | --- |
| pi-select-nav | Rewrote `ctrl+j`/`ctrl+k` and `j`/`k` into arrow keys in every list and picker, since Pi's list keybindings did not reach plugin components | OpenCode's dialogs and autocomplete read the global `keybinds` in `cli.json` (`prompt.autocomplete.prev` and `next` default to `up,ctrl+p` and `down,ctrl+n`), and suite dialogs accept `j`/`k` where there is no text field: the [background panel](/plugins/opencode-bg/), [diff review](/plugins/opencode-diff-review/) and the [context breakdown](/plugins/opencode-context/). There is no raw-input rewrite to install. |
| pi-clear-screen | `ctrl+l` pushed Pi's transcript out of view in fullscreen mode | The `app.clear` command (`ctrl+l`) exists only in `opencode mini`. The full TUI's transcript is a scroll box, not terminal output: there is nothing to push away, and `/new` (`ctrl+x n`) starts a blank session. |
| pi-cc-render | Claude Code-style transcript rendering: one-line tool rows that expand, grouped tool cards, rich diffs, compact thinking, a per-turn summary | OpenCode's transcript already groups related tool calls (`session.grouping`), hides or shows thinking (`session.thinking`), and renders diffs with `diffs.view`. A plugin can register a code-block renderer and a few slots, not replace the message renderer, so a port is not possible; [markdown extras](/plugins/opencode-markdown-extras/) carries the text transforms that were worth keeping. |

## Cannot be done, or does not arise

| Pi component | What it did | Why there is no port |
| --- | --- | --- |
| pi-vim | Vim editing (modes, motions, operators) for the main prompt and embedded editors | OpenCode 2 has no modal editing in the prompt, and the plugin API has no way to replace the prompt editor or intercept its keys ahead of it. The native route is `/editor` (`ctrl+x e`), which opens the prompt in `$VISUAL` or `$EDITOR`. |
| pi-herdr-scrollbar-width | Kept Pi's exit transcript from wrapping inside herdr panes with scrollbars, at the moment fullscreen Pi left the alternate screen | OpenCode's TUI is always full screen and the plugin API has no hook for leaving it; the wrapping the plugin corrected was Pi's own exit transcript. `session.scrollbar` in `cli.json` controls OpenCode's own transcript scrollbar. |

## What the ports changed

Several ported components are smaller than their Pi originals because OpenCode owns the part:

- [Diff review](/plugins/opencode-diff-review/) uses OpenCode's turn snapshots and `vcs.diff` instead of its own Git plumbing, so there is no `staged` scope, split view or search.
- [Tool gate](/plugins/opencode-tool-gate/) approves through OpenCode's own permission prompt and leaves Shift+Tab to the agent cycle.
- [Status footer](/plugins/opencode-status-footer/) adds only Git marks and subscription windows: OpenCode already shows the directory, branch, context use and cost.
- [Background work](/plugins/opencode-bg/) adds services, waiting, logs and a panel on top of the `shell` tool's own `background: true`.
- [Next prompt](/plugins/opencode-next-prompt/) carries the suggestion as a fenced `next` block that the terminal hides, since no hook rewrites a finished message.

Each reference page has a "Differences from the Pi version" note where the README documents one.
