# opencode-git-status

An opencode TUI plugin that shows the checkout's git status to the right of the
prompt, on the home screen and in sessions:

```
feat/x * ↑1 ↓3 !
```

| Mark | Color | Meaning |
| --- | --- | --- |
| branch | text | or `detached:<sha7>` |
| `*` | warning | any staged, unstaged, untracked or conflicted work |
| `↑N` | success | commits ahead of upstream |
| `↓N` | error | commits behind upstream |
| `!` | error | conflicts, a paused merge/rebase/cherry-pick, or unreadable Git |

The suffix uses single spaces in the order `* ↑N ↓N !`, with `!` always last.
There are no file counts, worktree/tracking labels, separators or clean/zero
markers. A clean checkout shows only its branch identity, including linked
worktrees. Detached HEAD shows `detached:<sha7>`. Nothing shows outside Git.
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

## Install

TUI-only: list it in `~/.config/opencode/tui.jsonc`, pinned to a commit.

```jsonc
{
  "plugin": ["opencode-git-status@github:justmytwospence/opencode-git-status#<commit>"]
}
```

It renders before opencode-marimo and opencode-cache-guard in the same slot.

## Development

```sh
npm ci && npm run check
```
