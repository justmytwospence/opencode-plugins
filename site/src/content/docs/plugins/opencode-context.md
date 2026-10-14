---
title: opencode-context
description: Shows where the OpenCode context window goes. /context opens a dialog with a usage bar, one row per part of the last model request, and a preview of each part as the model received it.
plugin: opencode-context
---
An OpenCode 2 plugin that shows where the context window goes. `/context` opens a dialog with a usage bar and one row per part of the last model request: system prompt, instruction files, skills, tool definitions, tool results, conversation, other, free space. Enter or a click on a row opens a scrollable preview of that part as the model received it. The port of pi-context.

OpenCode's own sidebar and footer show the total tokens and the percent of the window; this explains what they are made of.

Example of the dialog (illustration, not a screenshot; numbers are made up):

```
 Context usage  31.2k / 200k tokens (15.6%) · request 12s ago                 esc
 ████████▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 › ■ System prompt       2.1k    1.1%
   ■ Instructions        1.4k    0.7%
   ■ Skills              0.9k    0.4%
   ■ Tool definitions    6.3k    3.2%
   ■ Tool results       14.0k    7.0%
   ■ Conversation        5.8k    2.9%
   ■ Other               0.7k    0.3%
   ■ Free space          169k   84.4%
 build · anthropic/claude-opus-4-6 · 9 messages in the request · per-part counts are estimates (characters / 4)
 ↑↓ select · enter or click to preview · esc close
```

Source: [packages/opencode-context](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-context).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-context@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-context"
]
```

## Requirements and costs

Nothing external; no settings, no network calls, no model or Jev requests. The breakdown is computed from what the server half already saw. Tested with OpenCode 2.0.24.

## Keys

| Where | Keys |
| --- | --- |
| Dialog | `↑`/`↓` (or `k`/`j`) select a row; `Enter`, `→`, `Space` or a click opens its preview; `Esc` closes |
| Preview | `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` scroll; `Esc` or `←` returns to the rows |

`/context` is also in the command palette as "Context usage".

## How it counts

The server half records, for each session, what the last primary model request carried (the session's `context` hook: the system parts, the tool declarations and the messages), as token estimates at four characters per token plus previews, and serves it to the terminals over the `context` RPC. Compaction, title and generate requests are not counted.

- **System prompt**: the system parts, minus the blocks below. OpenCode 2 joins its ambient instruction blocks into one system part and sends later changes as system messages, so both are cut at the lines those blocks start with (`Instructions from: <path>`, `<available_skills>`, `# Code Mode`, the date, the environment).
- **Instructions**: the instruction files OpenCode loaded (AGENTS.md and friends), one item per file, and later instruction updates.
- **Skills**: the available skills list, its updates, and skills invoked into the conversation.
- **Tool definitions**: name, description and input schema of every declared tool, plus the Code Mode catalog.
- **Tool results**: every tool result in the request.
- **Conversation**: user text, assistant text, reasoning and tool calls. Media parts are listed but not counted; their tokens depend on the provider.

The total is the usage OpenCode reports for the session's last response (input, output, reasoning and cache tokens of the last assistant message since the last compaction, the same number as the sidebar), and the window is the model's context limit. The four fixed parts keep their estimates; tool results and conversation are scaled down proportionally when the reported total is smaller than the estimate. Other is the remainder; Free space is the window minus the total. When the report is far below what the content alone must cost (a mock provider, or a provider that reports no usage), the estimate stands in. The per-part numbers are estimates, not a tokenizer's output.

## What it remembers

The breakdown is kept in the server's memory for the session's last request: before the first request of a session, or after the shared server restarts, `/context` says so. The dialog refreshes itself when a new request goes out while it is open.

## Credits

MIT. The LICENSE keeps the copyright of minuque, whose pi-cc-extensions `/context` command pi-context was ported from. See the [context and cost recipe](/recipes/cache-cost/) for reading the numbers beside the cache clock.
