---
title: opencode-btw
description: Side conversations in OpenCode 2. /btw asks a question in a separate session shown in a side panel while the main agent keeps working, then hands the thread back.
plugin: opencode-btw
---
An OpenCode 2 plugin for side conversations: `/btw <question>` opens a session panel with a side thread, a real OpenCode session forked from the shown session (so it knows the conversation so far) that answers while the main run keeps going. The panel has the thread's transcript and its own input. When the side thread has reached something useful, `/btw:inject` or `/btw:summarize` hands it to the main session as a queued message. Adapted from pi-btw (MIT, Dan Bachelder); the prompts and handoff formats are upstream's.

This component is still being finished; this page describes the source in the repository at the time of writing, which has no README yet.

Source: [packages/opencode-btw](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-btw).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-btw@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-btw"
]
```

## Requirements and costs

A side thread is a second session: each question is a model call at your configured access, and `/btw:summarize` makes one more to write the summary. The thread's title is set without a model call. `/btw:ask` runs on a read-only agent, OpenCode's `plan` by default (the plugin option `askAgent` changes it). No Jev calls, no external tools. Tested with OpenCode 2.0.24.

## Commands

All are slash commands and palette entries in the "BTW" group. `/side` is an alias for `/btw`.

| Command | Effect |
| --- | --- |
| `/btw <question>` | Asks in the current side thread (or starts a contextual one) and opens the panel |
| `/btw:new [question]` | Drops the thread and starts a fresh contextual one |
| `/btw:tangent <question>` | A side thread without the main conversation: a fresh session, not a fork |
| `/btw:ask <question>` | A fork on the read-only agent, with editing denied |
| `/btw:clear` | Closes the panel and deletes the side session |
| `/btw:inject [instructions]` | Sends the thread's completed exchanges to the main session as a queued message, then drops the thread |
| `/btw:summarize [instructions]` | Sends a model-written summary instead, then drops the thread |
| `/btw:model [provider/model[#variant] \| clear]` | Shows, sets or clears the thread's model; without an override, the main session's |
| `/btw:thinking [variant \| clear]` | Shows, sets or clears the thread's variant |

A thread has one mode. Asking with a command of another mode (`/btw:tangent` after `/btw`) drops the current thread and starts one in the new mode. The handoff refuses while the side thread is still answering or has no completed exchange; an exchange whose reply errored is left out. The injected message is a synthetic message queued after the main session's current turn, so a busy main agent gets it when its run ends.

OpenCode 2 has its own `/btw`, which answers a quick question in a dialog without a side session. Both appear in the slash completion; `/side` is the plugin's unambiguous name.

## The panel

The panel is a `session.panel` contribution: the thread's header (`btw · contextual · <agent> · <model> · running`), its transcript (your messages, the assistant's text, one line per tool call, errors), and a textarea.

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `shift+Enter` | New line |
| `Esc` | Interrupt the thread while it answers; close the panel when idle |
| `alt+w` | Toggle full screen |
| `PageUp`, `PageDown` | Scroll |

Threads are remembered per main session in the terminal's durable storage, so a panel reopens on the same thread after a restart; a thread whose session is gone is forgotten.

## Server half

The side sessions carry `metadata.btw` (the main session, the mode, the title), which the server half acts on, so nothing depends on a terminal or on a "current session":

- The `context` hook adds the aside system prompt to every model request of a side session; the thread is told the main session's messages are context only and that it should not continue the main work unless asked to prepare something for injection.
- For a read-only thread it also drops the editing tools (`edit`, `write`, `patch`, `shell`, `bash`, `subagent`, `worktree`) from the request, and the `permission` hook denies those actions whatever the agent. It is a tool and permission selection, not a sandbox.
- The `title` hook answers the title request with the thread's own title (`btw: <question>`, `btw tangent: …`, `btw ask: …`), so no model call.
- A `btw` skill is registered, so the agent can tell you when a side thread fits and which command to use.

## Differences from pi-btw

OpenCode's session API does the forking, prompting and queuing (`session.fork`, `session.prompt`, `session.generate`, `session.synthetic`), and the thread lives in a session panel rather than an overlay with its own composer. Pi's `/btw --save` flag is accepted and ignored: there are no visible notes in OpenCode.
