# opencode-copy

An [OpenCode 2](https://opencode.ai) plugin that adds `/yank`: a picker of things to copy from the
session, instead of the whole last reply. Whole messages, and inside replies the pieces found in
code: sections, fenced code blocks, shell commands (fenced, `bash` tool calls and commands you ran
with `!`), inline snippets, paths, URLs, tables, lists, quotes, commit messages and paragraphs.
[Jev](https://docs.typesafe.ai), TypeSafe's System One model, ranks what you most likely want to
copy now and leaves out prose that is only explanation. The port of
[pi-copy](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-copy), with the same
extraction, questions and ordering. OpenCode's own `/copy` (the last reply) is unchanged.

Example of the picker (illustration, not a screenshot):

```
 Copy from this session · suggested · 14                                      esc
 ┃ Filter
   git commit -m "fix: keep the cursor on the piece you moved to"   cmd · now
   npm run check                                                     cmd · now
   ts: export function fuzzyFilter<T>(items: readonly T[], query…   code · 1t ago
   https://opencode.ai/v2/docs/build/plugins/cli                     url · 2t ago
   The picker is OpenCode's select dialog: typing filters, …        text · 2t ago
 suggested/all ctrl+t   preview →                                   enter select
```

| Key | Does |
| --- | --- |
| typing | Filters the rows (fuzzy, every word must match) |
| `↑`/`↓`, `PgUp`/`PgDn` | Move |
| `ctrl+t` | Switch Suggested and All (also `Tab` to the action, then `Enter`) |
| `→` | Preview the highlighted piece in full; there, `Enter` copies, `Esc` or `←` returns |
| `Enter` | Copy and close |
| `Esc` | Close |

**Suggested** combines Jev's score (weight 0.6) with recency (0.4); prose Jev judges not worth
pasting (copyable probability under 0.3) is left out of it. **All** is everything, newest first.
The picker opens at once in recency order and reorders when the ranking arrives (the title says
`ranking…`, then `suggested`; `suggested (by recency)` when Jev is unavailable). A copy shows a
toast: `Copied ts code (12 lines, 340 chars)`.

The copy goes through OpenCode's own clipboard route (OpenTUI's host clipboard and OSC 52 to the
terminal, both), so it reaches the same places OpenCode's `/copy` does, remote sessions included.
OSC 52 delivery cannot be verified: the toast confirms the write was made, not that the clipboard
changed.

## How it works

The terminal half reads the session's messages (the last `maxTurns` user turns, 30 by default),
extracts the pieces, and opens OpenCode's select dialog. The server half, which runs in OpenCode's
background service with `TYPESAFE_API_KEY`, answers the `copy` RPC's `rank` call: for each piece a
0-3 score of how likely it is what you want to copy right after your last messages, and for prose a
probability that it is a self-contained thing to paste elsewhere. Judgments are cached by content
in the terminal for as long as it runs; closing the picker cancels an outstanding request.

Opening the picker sends candidate text to Jev: each candidate clipped to `rank.pieceChars` (600)
characters, the last three nonempty user messages clipped to 500 each, at most `rank.maxPieces`
(120) of the newest pieces within `rank.stateBudgetChars` (60000). Set `jev.enabled` to `false`
to keep sessions local; the picker then orders by recency.

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-copy@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-copy"
]
```

Ranking needs `TYPESAFE_API_KEY` in OpenCode's environment; without it the picker works in
recency order. Tested with OpenCode 2.0.24.

## Settings

Settings live in a shared, harness-neutral place the pi port reads as well:
`~/.config/agents/copy.json` (under `$XDG_CONFIG_HOME` when set) for you, and
`<project>/.agents/copy.json` for a project. Keys a harness does not know are ignored. All keys
are optional; the defaults:

```jsonc
{
  "jev": { "enabled": true, "model": "jev-latest", "timeoutMs": 3000 },
  "rank": { "maxPieces": 120, "pieceChars": 600, "stateBudgetChars": 60000, "copyableThreshold": 0.3, "wantWeight": 0.6 },
  "maxTurns": 30,
  "shortcut": "ctrl+shift+x"
}
```

OpenCode-only overrides go in the plugin's options in `opencode.jsonc` (`{ "package":
"opencode-copy@...", "options": { "jev": { "enabled": false } } }`) or in
`<project>/.opencode/copy.json`. The layers merge in this order, later winning, objects
deep-merged and arrays and scalars replaced: built-in defaults, `~/.config/agents/copy.json`,
the `opencode.jsonc` options, `<project>/.agents/copy.json`, `<project>/.opencode/copy.json`.
Settings are re-read when the picker opens; `shortcut` is read when the terminal starts, from the
directory it starts in. `"shortcut": false` leaves the command without a key; the command id is
`copy.yank`, so OpenCode's own `keybinds` can bind it too. Terminals without the kitty keyboard
protocol send `ctrl+shift+x` as `ctrl+x` (OpenCode's leader), so the shortcut does nothing there;
use `/yank` or the palette.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
