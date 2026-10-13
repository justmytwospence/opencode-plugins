# opencode-status-footer

An [OpenCode 2](https://opencode.ai) plugin that adds what OpenCode's own footer and sidebar lack,
in the spirit of [pi-status-footer](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-status-footer).
OpenCode already shows the directory, branch, context use and session cost, so this adds two
things:

- **Git marks** right after the footer's `dir:branch`, on the home screen and in sessions:

  ```
  ~/code/app:feat/x  * ↑1 ↓3 !
  ```

- **Subscription windows** in the session sidebar, under OpenCode's context and cost (example):

  ```
  Claude 5h 42% 2h13m · week 81% 3d
  ```

## Git marks

| Mark | Color | Meaning |
| --- | --- | --- |
| `*` | warning | any staged, unstaged, untracked or conflicted work |
| `↑N` | success | commits ahead of upstream |
| `↓N` | error | commits behind upstream |
| `!` | error | conflicts, a paused merge/rebase/cherry-pick, or unreadable Git |

The suffix uses single spaces in the order `* ↑N ↓N !`, with `!` always last.
There are no file counts, worktree/tracking labels, separators or clean/zero
markers. A clean checkout shows nothing beyond OpenCode's own branch. Nothing shows outside Git.
Ignored files do not set `*`.

Missing or pruned upstream refs omit divergence arrows without implying in-sync.
Failed Git commands or malformed/truncated status output show `!` rather than a
misleading clean summary (alone if branch identity is unavailable). Operation
markers are read from the checkout's own administrative directory, so `!`
remains after conflicts are resolved while a merge, rebase or cherry-pick is
still paused. This check never modifies Git state.

The status is re-read every 3 seconds, after each completed tool call and when a
turn ends. Git runs with `--no-optional-locks`, so it never takes
`index.lock` from under the agent. Ahead/behind use local upstream information;
the plugin never fetches. Ahead/behind are requested explicitly even when
`status.aheadBehind` is disabled. Linked worktrees are identified by comparing
the Git directory with the common Git directory, not by their path names.

The marks follow the format every prompt and footer of these suites share (`branch * ↑N ↓N !`),
without the branch, which OpenCode's footer already shows.

## Subscription windows

The server half reads the rate-limit headers of every response from the `anthropic` provider
(Anthropic's unified `5h`/`7d` windows) and the `chatgpt`/`openai` providers (Codex's
`x-codex-*`), headers only, never bodies. Until a response has said anything, Claude's windows
come from Claude Code's shared usage cache, `oauth-usage.json` under `$CLAUDE_STATUSLINE_CACHE_DIR`
(default `~/.cache/claude-statusline/`), which Claude Code's status line and pi-status-footer
keep fresh; this plugin only reads it and never makes account requests. Each window shows percent
**used** and the time to its reset; warning color from 70%, error from 90%. A reading older than
10 minutes, or past its reset, is dropped rather than shown stale. API-key users get no
subscription headers and see nothing.

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-status-footer@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-status-footer"
]
```

Replaces the retired opencode-git-status. Tested with OpenCode 2.0.24.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
