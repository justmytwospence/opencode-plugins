---
name: btw
description: Helps you use the /btw side-conversation workflow effectively. Use when the user wants to think in parallel, ask side questions without interrupting ongoing work, or inject a side thread back into the main session.
---

# BTW

Use this skill when the user wants to work in parallel with the main agent instead of derailing the current turn.

## When to use BTW

Prefer the BTW workflow when the user wants to:

- ask a side question while the main agent keeps working
- brainstorm or compare options without interrupting the current run
- prepare a plan or summary before handing it back to the main agent
- keep exploratory discussion out of the main transcript and context

## Commands

These are slash commands the user types in the OpenCode prompt (the agent cannot run them):

```text
/btw <question>
/side <question>
/btw:new [question]
/btw:tangent <question>
/btw:ask <question>
/btw:clear
/btw:model [<provider>/<model>[#variant] | clear]
/btw:thinking [<variant> | clear]
/btw:inject [instructions]
/btw:summarize [instructions]
```

`/side` is an alias for `/btw` and shares the same thread, panel and settings. `/btw` is canonical; the lifecycle commands stay in the `/btw:*` namespace.

## How to guide the user

### For a quick side question

Recommend:

```text
/btw <question>
```

The side thread runs in a session forked from the main one, so it knows the conversation so far, and answers in a side panel while the main run continues. Follow-ups go in the panel's own input.

### For a fresh side thread

Recommend `/btw:new` or `/btw:new <question>` when the previous side discussion is no longer relevant but the new one should still start from the current main-session context.

### For a contextless tangent thread

Recommend `/btw:tangent <question>` when the side conversation should not include the main conversation.

### For a side question with read-only tools

Recommend `/btw:ask <question>` when the side thread must only inspect: it runs on OpenCode's read-only agent, and edits, writes, shell commands and subagents are denied. It is a tool and permission selection, not a sandbox.

### To hand the thread back to the main agent

Recommend `/btw:inject <instructions>` when the exact discussion matters and the main agent should act on it, and `/btw:summarize <instructions>` when the thread is long and only the distilled outcome should go back. Both deliver a queued message to the main session (after its current turn, if it is busy) and then clear the thread.

### To make BTW cheaper or faster than the main thread

Recommend `/btw:model <provider>/<model>` and `/btw:thinking <variant>` when the main thread should keep its model but the side thread should run with a different cost or speed profile.

## Recommendation rules

- Prefer `/btw` over normal chat when the user explicitly wants a side conversation.
- Prefer `/btw:tangent` when that side conversation should be contextless.
- Prefer `/btw:ask` when it should only read.
- Prefer `/btw:summarize` over `/btw:inject` for long exploratory threads.
- Prefer `/btw:inject` when precise wording, detailed trade-offs, or a full plan matters.
- Suggest `/btw:new` before an unrelated side topic when the main-session context is still useful.
- Suggest `/btw:clear` to close the panel and drop the thread.

## Response style

When helping the user use BTW:

- give the exact slash command to run
- explain briefly why that command fits
- keep the guidance short and operational
