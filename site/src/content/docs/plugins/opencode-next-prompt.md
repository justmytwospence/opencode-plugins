---
title: opencode-next-prompt
description: Suggests the prompt you would most likely send next as ghost text in OpenCode's empty prompt. Tab fills it in; it is never sent; Jev vets it when a key is set.
plugin: opencode-next-prompt
---
An OpenCode 2 plugin that suggests the prompt you would most likely send next, like Claude Code's prompt suggestions: after a turn, the suggestion is the ghost text of the empty prompt, `Tab` (or `Right`) fills it in (it is never sent), and typing hides it. The port of pi-next-prompt.

Example (an illustration, not a screenshot):

```
┃
┃  Add a usage section to README.md  Tab to accept
┃
┃  Build · Claude Opus 4.6 Anthropic
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

It only appears when there is one obvious next step. Most turns show nothing.

Source: [packages/opencode-next-prompt](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-next-prompt).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-next-prompt@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-next-prompt"
]
```

## Requirements and costs

No extra model request: the suggestion rides on the answer the model writes anyway, at about 150 tokens of added system prompt per primary request. Optional: `TYPESAFE_API_KEY` in OpenCode's server environment for Jev vetting, a paid classifier call per candidate suggestion (none when the model gives no candidate); Jev receives the suggestion, up to 1,500 characters of the last user prompt and up to 2,000 characters from the end of the answer. Tested with OpenCode 2.0.24.

## How it works

**Server half.** The session's `context` hook adds one short system part (after OpenCode's own prompt so its cache prefix is unchanged) on every primary model request, asking the model to end its final message with a fenced code block whose info string is `next`, only when exactly one concrete next step is obvious. The same hook removes the `next` blocks of earlier answers from the request's assistant messages, so suggestions never go back to the model; it runs on every request, so prompt caches survive. Title, compaction and summary requests never get the instruction; subagent sessions (those with a parent) do not either.

The server half also vets a suggestion with Jev through the `vet` RPC method (one verdict serves every terminal showing the session): is the suggestion a concrete, non-generic next step that follows from the answer and is not done yet? Shown at probability >= 0.6; shown anyway when Jev is off, unavailable, times out or the key is unset, since the model already abstains on its own.

**Terminal half.** It reads the block from the finished answer, and once the run has succeeded (not failed or interrupted) asks the server to vet it, then shows it as the placeholder of OpenCode's prompt editor with a `Tab to accept` hint. A textarea draws its placeholder only while it is empty, so typing hides the suggestion and clearing the prompt brings it back. `Tab`/`Right` are taken only while a suggestion shows in an empty, focused prompt; otherwise they do what they always do. Accepting fills the prompt and moves the cursor to the end; it does not submit. Each session has its own suggestion, kept while you switch sessions; a new run, a failed or interrupted run, compaction or deleting the session drops it.

In the transcript the `next` block draws nothing: the terminal half registers a code block renderer for the `next` info string, so the answer ends where the model's prose ends.

## Commands

`/next-prompt` (also in the command palette as "Toggle next-prompt suggestions") toggles suggestions, kept across restarts, and shows the last suggestion with Jev's verdict in a toast.

## Settings

Shared, harness-neutral settings the pi port reads as well: `~/.config/agents/next-prompt.json` (under `$XDG_CONFIG_HOME` when set) and `<project>/.agents/next-prompt.json`; OpenCode-only overrides in the plugin's options in `opencode.jsonc` or `<project>/.opencode/next-prompt.json`. Later layers win, objects deep-merged, arrays and scalars replaced; files are re-read when they change. The defaults:

```json
{
  "enabled": true,
  "agents": [],
  "acceptKeys": ["tab", "right"],
  "maxChars": 110,
  "jev": { "enabled": true, "model": "jev-latest", "timeoutMs": 1500, "threshold": 0.6 }
}
```

- `agents`: agents whose sessions get the instruction (`[]` is every agent; subagent sessions never do).
- `acceptKeys`: OpenCode key names (`tab`, `right`, `ctrl+f`). Read when the terminal starts; the other settings are re-read at each request.
- `maxChars`: a longer suggestion is stripped from the request but not offered.

## Differences from pi-next-prompt

The suggestion is a fenced `next` code block, not a `<next>` line: OpenCode 2 has no hook that rewrites a finished text part, so the block stays in the stored message, and a code block is the one markdown node a terminal plugin can hide when the transcript is drawn. `opencode run` (no terminal) prints the block. Jev's verdict is cached per message on the server. `/next-prompt` toggles; there are no `on`/`off`/`status` arguments. Clearing on a model change or tree navigation has no OpenCode equivalent; a new run clears.
