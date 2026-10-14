# opencode-btw

An [OpenCode 2](https://opencode.ai) plugin for side conversations, the port of
[pi-btw](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-btw) (itself adapted
from [pi-btw](https://github.com/dbachelder/pi-btw) by Dan Bachelder, MIT). `/btw <question>` asks
in a side thread: a real OpenCode session forked from the one you are in, so it knows the
conversation so far, that answers in a session panel with its own input while the main run keeps
going. The thread stays out of the main session's context until you hand it over with
`/btw:inject` or `/btw:summarize`.

OpenCode 2.0.24 has its own `/btw`: a one-shot answer in a dialog, without tools, follow-ups or a
handoff. This plugin keeps the name for the Pi workflow, but while both are enabled which one a
typed `/btw` runs depends on registration order, so a notice says so once. `/side` always opens the
side thread, and the `/btw:*` commands are unambiguous. Disable the internal `opencode.btw` plugin
in `/plugins` (`ctrl+a` shows internal plugins) to make `/btw` unambiguous.

## Commands

| Command | What it does |
| --- | --- |
| `/btw [question]`, `/side [question]` | Ask in the current thread, which inherits the main conversation; without a question, opens the panel. |
| `/btw:new [question]` | Drop the thread and start a fresh contextual one. |
| `/btw:tangent [question]` | A thread without the main conversation. |
| `/btw:ask [question]` | A read-only thread: the fork runs on OpenCode's `plan` agent, and edits, writes, patches, shell commands and subagents are denied. |
| `/btw:clear` | Close the panel and delete the side session. |
| `/btw:inject [instructions]` | Send the whole thread to the main session, then drop it. |
| `/btw:summarize [instructions]` | Have the thread's model summarize it (no tools), send the summary, then drop it. |
| `/btw:model [provider/model[#variant] \| clear]` | Show, set or clear the thread's model; the main session's selection otherwise. |
| `/btw:thinking [variant \| clear]` | Show, set or clear the thread's variant (OpenCode's thinking levels). |

All of them are in the command palette too. Switching between the contextual, tangent and
read-only modes drops the previous thread. Pi's `--save` flag is accepted and ignored: OpenCode has
no visible-but-not-in-context note.

**The panel.** The header names the mode, agent, model and whether the thread is answering; the
transcript shows your questions, the replies and one line per tool call; the input at the bottom
sends with Enter (Shift+Enter or Alt+Enter for a newline). Esc interrupts a reply in progress, or
closes the panel when idle (the thread stays); Ctrl+F toggles full screen; PageUp/PageDown scroll.
OpenCode's `<leader>left` and `<leader>right` move focus between the prompt and the panel.

**Handoff.** `/btw:inject` sends `User: ... / Assistant: ...` exchanges (failed or interrupted ones
dropped), `/btw:summarize` a summary written by the thread's model through `session.generate`.
Both arrive as a synthetic message queued for delivery (`delivery: "queue"`), so a busy main
session gets it after its current turn; it shows as `btw: side thread (n exchanges)` in the
transcript and runs a turn.

## How the side session works

- **Contextual and read-only threads** are a fork kept out of the way: the main session is
  exported (`session.export`) and imported (`session.import`) as a child session of the main one
  under a new id, with the complete messages copied, as `session.fork` copies them. A child session
  is not listed in `/sessions`, not opened as a tab, and not picked by `--continue`. Should the
  import be refused, the plugin falls back to `session.fork` (a listed session titled `btw: ...`)
  and says so. The first reply costs the main conversation's tokens again, as any fork does.
- **Tangent threads** are a fresh child session.
- The side session carries `metadata.btw` (`main`, `mode`, `title`). The server half acts on it,
  whatever terminal the session came from: the aside system prompt (the thread is a separate
  conversation; the main session's messages are context only) is added to every model request of a
  side session; a read-only thread also loses `edit`, `write`, `patch`, `shell`, `subagent` from
  the request and has those permission actions denied; the summary request runs without tools;
  and the title request is answered from the metadata, with no model call.
- Threads are remembered per main session in the terminal's durable storage
  (`plugin.btw.tui.threads.json`), so they survive a TUI restart. A side session that was deleted
  elsewhere is forgotten; deleting the main session takes its children with it.
- `/btw:ask` is a tool and permission selection, not a sandbox: `read`, `grep`, `glob`,
  `webfetch`, `websearch`, `question` and `skill` remain. Contextual and tangent threads run on the
  main session's agent with its tools, in the same checkout: a side question can change files
  while the main run is editing them.

## Skill

The `btw` skill (`skills/btw/SKILL.md`) is registered through `ctx.skill.transform`, so the agent
can tell you when a side thread fits and which command to use. It describes what you can type;
the agent cannot run these commands itself.

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-btw@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-btw"
]
```

Options, in the plugin entry (`{ "package": "opencode-btw@...", "options": { ... } }`):

| Option | Default | Meaning |
| --- | --- | --- |
| `askAgent` | `"plan"` | The agent of `/btw:ask` threads. |

Tested with OpenCode 2.0.24.

## Differences from pi-btw

- No overlay: the thread lives in OpenCode's session panel, with OpenCode's own focus keys.
- No `--save` notes, no `PI_BTW_FOCUS_KEYS`, no embedded editor provider.
- The thread is a real session rather than an in-memory one: it keeps the main session's agent and
  tools (Pi gave every thread `read`, `bash`, `edit`, `write`), and `/btw:ask` uses an agent plus
  denied actions rather than Pi's four read-only tools.
- `/btw:model` takes `provider/model[#variant]`; `/btw:thinking` takes a variant name.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
