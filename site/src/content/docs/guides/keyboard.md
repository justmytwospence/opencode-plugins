---
title: Keyboard & commands
description: Every slash command, palette entry, shortcut and panel key the OpenCode Plugins components add, and how they sit beside OpenCode's own keys.
---
OpenCode sends each key to the component that owns input: the prompt, a dialog, a panel. Suite components add slash commands (type `/` in the prompt), palette entries (`ctrl+p`), and keys that work only while their own dialog or panel has focus. The suite adds **one** global shortcut by default, the copy picker's `ctrl+shift+x`; everything else is a command you run or a key inside a view. OpenCode's own bindings (leader `ctrl+x`, Shift+Tab for the agent cycle, `ctrl+t` for the variant cycle) are left alone.

## Slash and palette commands

| Command | Palette entry | Component | Effect |
| --- | --- | --- | --- |
| `/bg` (also `/tasks`, `/bashes`, `/ps`) | Background tasks | [bg](/plugins/opencode-bg/) | Opens the session panel of background tasks |
| `/btw <question>` (also `/side`) | Side conversation | [btw](/plugins/opencode-btw/) | Asks in the side thread forked from this session, opening the panel |
| `/btw:new [question]` | New side thread | btw | Drops the thread and starts a fresh contextual one |
| `/btw:tangent <question>` | Side tangent | btw | A side thread without the main conversation |
| `/btw:ask <question>` | Side question, read-only | btw | A side thread on the read-only agent with editing denied |
| `/btw:clear` | Clear side thread | btw | Closes the panel and deletes the side session |
| `/btw:inject [instructions]` | Inject side thread | btw | Queues the thread into this session, then drops it |
| `/btw:summarize [instructions]` | Summarize side thread | btw | Queues a model-written summary of the thread, then drops it |
| `/btw:model [provider/model[#variant] \| clear]` | Side thread model | btw | Shows, sets or clears the thread's model |
| `/btw:thinking [variant \| clear]` | Side thread thinking | btw | Shows, sets or clears the thread's variant |
| `/cache-guard` | cache-guard: status | [cache guard](/plugins/opencode-cache-guard/) | The last request, TTL, time left, the warning's state, Jev |
| `/cache-guard-compact [focus]` | cache-guard: compact with Jev | cache guard | Jev's compaction, written in code against the focus |
| `/cache-guard-fresh` | cache-guard: start fresh with this prompt | cache guard | A new session with the same agent and model, with the prompt box's text |
| `/cache-guard-on`, `/cache-guard-off` | cache-guard: on for this session, off for this session | cache guard | Off hides the clock and holds nothing in this terminal; on also unmutes |
| `/cache-guard-jev` | cache-guard: Jev | cache guard | Probes Jev, explains the setup, toggles `jev.enabled` |
| `/context` | Context usage | [context](/plugins/opencode-context/) | The context window breakdown dialog |
| `/diff-review [scope]` | Review changes | [diff review](/plugins/opencode-diff-review/) | The review panel; scopes `unreviewed`, `turn [n]`, `session`, `head`, `branch` |
| `/marimo` | marimo: choose the notebooks followed | [marimo](/plugins/opencode-marimo/) | A checklist of open notebooks to pin |
| `/marimo auto`, `/marimo off`, `/marimo show` | | marimo | Follow every notebook under the project, stop following, print the state block |
| `/next-prompt` | Toggle next-prompt suggestions | [next prompt](/plugins/opencode-next-prompt/) | Toggles suggestions and shows the last one with Jev's verdict |
| `/prose-width` | Toggle prose width | [prose width](/plugins/opencode-prose-width/) | Toggles the measure for the session |
| `/tool-gate status` | Tool gate: status | [tool gate](/plugins/opencode-tool-gate/) | The mode, counts, Jev settings, rules and grants |
| `/tool-gate mode [name]` | Tool gate: permission mode | tool gate | Switches the mode; with no name, opens a picker |
| `/tool-gate cycle` | Tool gate: cycle permission mode | tool gate | Steps through `modes` (default manual, accept-edits, auto) |
| `/tool-gate on`, `/tool-gate off` | | tool gate | Auto mode; bypass mode |
| `/yank` | Copy from this session | [copy](/plugins/opencode-copy/) | The copy picker |

OpenCode has a built-in `/diff-review` that asks the agent for a review, and a built-in `/btw` that asks a quick question in a dialog. Both suite commands are listed beside them in the slash completion; the exact names shown in the table are unambiguous, and `/side` is the plugin's alias for its `/btw`.

Auto effort, delegation, herdr, the status footer, markdown extras and the sticky prompt add no commands. Herdr's `herdr_child` and delegation's `delegate` are tools the agent calls, not commands you type.

## Shortcuts

| Keys | Component | Where it acts |
| --- | --- | --- |
| `ctrl+shift+x` | copy | Opens `/yank`. Set `shortcut` in `copy.json`, or `false` for none; the command id `copy.yank` can be bound through OpenCode's `keybinds`. Terminals without the kitty keyboard protocol send it as `ctrl+x` (the leader), so it does nothing there. |
| `Tab`, `Right` | next prompt | Fill the suggestion into the empty, focused prompt; otherwise they do what they always do. Configurable with `acceptKeys`. |
| `Enter` | cache guard | A keymap layer above the prompt's submit checks the cache clock first and may open the hold dialog. Slash commands, shell mode and an empty box are never held. |
| none by default | tool gate | Bind the command id `tool-gate.cycle` through `keybinds` for a mode cycle; Shift+Tab stays OpenCode's agent switch. |

The hold dialog: `Enter` sends, `Esc` keeps the prompt in the box.

## Panels and dialogs

Keys below work only while the named view has focus.

### Background panel (`/bg`)

| Key | Action |
| --- | --- |
| `j`/`k`, arrows | Select a task |
| `x` | Stop the selected running task, after a confirmation |
| `c` | Hide ended tasks |
| `f` | Toggle full screen |
| `q`, `Esc` | Close |

### Side conversation panel (`/btw`)

| Key | Action |
| --- | --- |
| `Enter` | Send the input to the side thread |
| `shift+Enter` | New line |
| `Esc` | Interrupt the thread while it answers; close the panel when idle |
| `alt+w` | Toggle full screen |
| `PageUp`, `PageDown` | Scroll the transcript |

### Review panel (`/diff-review`)

| Key | Action |
| --- | --- |
| `j`/`k`, arrows, `ctrl+d`/`ctrl+u`, `g`/`G` | Move |
| `]`/`[`, `}`/`{` | Next or previous hunk, file |
| `Enter` | Fold or unfold the file (also shows a file over 1500 diff lines) |
| `v` | Start or end a line selection |
| `c` | Comment on the line, selection, hunk header (the hunk) or file header (the file) |
| `s` | Suggest a replacement for the line or selection |
| `e`, `x` | Edit or delete the comment under the cursor |
| `l` | List the comments: `Enter` jumps, `e` edits, `x` deletes, `w` sends |
| `w`, `W` | Send the drafts to the agent (`W` also closes) |
| `S` | Pick the scope |
| `m` | Mark the shown turns reviewed |
| `r`, `f`, `?` | Reload, toggle full screen, show the keys |
| `q`, `Esc` | Close; drafts are kept |

The comment and suggestion editors follow OpenCode's input keys: `Enter` submits, `shift+Enter` (or `ctrl+j`) adds a line, `Esc` cancels.

### Context dialog (`/context`)

| Where | Keys |
| --- | --- |
| Rows | `↑`/`↓` (or `k`/`j`) select; `Enter`, `→`, `Space` or a click opens the preview; `Esc` closes |
| Preview | `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` scroll; `Esc` or `←` returns to the rows |

### Copy picker (`/yank`)

| Key | Action |
| --- | --- |
| typing | Filters the rows (fuzzy; every word must match) |
| `↑`/`↓`, `PgUp`/`PgDn` | Move |
| `ctrl+t` | Switch Suggested and All (also `Tab` to the action, then `Enter`) |
| `→` | Preview the highlighted piece; there `Enter` copies, `Esc` or `←` returns |
| `Enter` | Copy and close |
| `Esc` | Close |

### Mouse

The [sticky prompt](/plugins/opencode-sticky-last-prompt/) bar answers a left click by scrolling the transcript back to the pinned prompt; the wheel over it scrolls the transcript beneath. The context dialog's rows accept clicks. Mouse capture is OpenCode's `mouse` setting in `cli.json`.

## Footer and sidebar text

Several components write into OpenCode's footer right after `dir:branch`, in load order: background counts (`2 shells`, `1 failed`), the cache clock (`cache 4:12`), the Git marks (`* ↑1 ↓3 !`), the current notebook (`marimo fit.py · 1 error`) and the gate mode (`auto mode on · 3 auto · 1 pushed back · 0 asked`). Subscription windows and followed notebooks go in the session sidebar under OpenCode's context and cost. None of these take keys.
