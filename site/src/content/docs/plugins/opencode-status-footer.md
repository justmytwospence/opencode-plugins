---
title: opencode-status-footer
description: Adds what OpenCode's footer and sidebar lack, Git marks right after dir:branch and subscription windows in the session sidebar, without fetching or making account requests.
plugin: opencode-status-footer
---
An OpenCode 2 plugin that adds what OpenCode's own footer and sidebar lack, in the spirit of pi-status-footer. OpenCode already shows the directory, branch, context use and session cost, so this adds two things:

- **Git marks** right after the footer's `dir:branch`, on the home screen and in sessions (example):

  ```
  ~/code/app:feat/x  * ↑1 ↓3 !
  ```

- **Subscription windows** in the session sidebar, under OpenCode's context and cost (example):

  ```
  Claude 5h 42% 2h13m · week 81% 3d
  ```

It replaces the retired standalone opencode-git-status.

Source: [packages/opencode-status-footer](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-status-footer).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-status-footer@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-status-footer"
]
```

## Requirements and costs

Git marks need a Git checkout; nothing shows outside Git, and the plugin never fetches or modifies Git state. Subscription windows need subscription response headers from the `anthropic` or `chatgpt`/`openai` providers, or Claude Code's shared usage cache; API-key users see nothing. No Jev, no model requests, no account requests, no settings. Tested with OpenCode 2.0.24.

## Git marks

| Mark | Color | Meaning |
| --- | --- | --- |
| `*` | warning | Any staged, unstaged, untracked or conflicted work |
| `↑N` | success | Commits ahead of upstream |
| `↓N` | error | Commits behind upstream |
| `!` | error | Conflicts, a paused merge/rebase/cherry-pick, or unreadable Git |

The suffix uses single spaces in the order `* ↑N ↓N !`, with `!` always last. There are no file counts, worktree or tracking labels, separators or clean markers. A clean checkout shows nothing beyond OpenCode's own branch. Ignored files do not set `*`.

Missing or pruned upstream refs omit divergence arrows without implying in-sync. Failed Git commands or malformed status output show `!` rather than a misleading clean summary. Operation markers are read from the checkout's own administrative directory, so `!` remains after conflicts are resolved while a merge, rebase or cherry-pick is still paused.

The status is re-read every 3 seconds, after each completed tool call and when a turn ends. Git runs with `--no-optional-locks`, so it never takes `index.lock` from under the agent. Ahead/behind use local upstream information and are requested explicitly even when `status.aheadBehind` is disabled. Linked worktrees are identified by comparing the Git directory with the common Git directory, not by their path names.

The marks follow the format every prompt and footer of the maintainer's suites share (`branch * ↑N ↓N !`), without the branch, which OpenCode's footer already shows.

## Subscription windows

The server half reads the rate-limit headers of every response from the `anthropic` provider (Anthropic's unified `5h`/`7d` windows) and the `chatgpt`/`openai` providers (Codex's `x-codex-*`), headers only, never bodies. Until a response has said anything, Claude's windows come from Claude Code's shared usage cache, `oauth-usage.json` under `$CLAUDE_STATUSLINE_CACHE_DIR` (default `~/.cache/claude-statusline/`), which Claude Code's status line and pi-status-footer keep fresh; this plugin only reads it and never makes account requests. That cached account may differ from the one OpenCode bills.

Each window shows percent **used** and the time to its reset; warning color from 70%, error from 90%. A reading older than 10 minutes, or past its reset, is dropped rather than shown stale.

## Beside the other components

Several components write into the same footer slot after `dir:branch`: [background work](/plugins/opencode-bg/)'s counts, [cache guard](/plugins/opencode-cache-guard/)'s clock, [marimo](/plugins/opencode-marimo/)'s notebook line and the [tool gate](/plugins/opencode-tool-gate/)'s mode. They draw in load order and none takes keys. [Auto effort](/plugins/opencode-auto-effort/) reads the same subscription headers for its limits; the two components keep separate readings.

See the [context and cost recipe](/recipes/cache-cost/) for what the windows do and do not tell you.
