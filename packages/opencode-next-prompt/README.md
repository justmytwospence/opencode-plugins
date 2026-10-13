# opencode-next-prompt

An [opencode](https://opencode.ai) plugin that suggests the prompt you would most likely send next,
like Claude Code's prompt suggestions: after a turn, the suggestion is the ghost text of the empty
prompt, `Tab` (or `Right`) fills it in (it is not sent), and typing hides it.

```
┃  Ask anything… "Do step 2: add an assert for third in test.js"
┃
┃  Build · Claude Sonnet 5.5 Anthropic · medium
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   Tab to accept the suggestion
```

It only appears when there is one obvious next step. Most turns show nothing.

## How it works

- **Server half.** `experimental.chat.system.transform` adds one short system block (about 150
  tokens, after the main prompt so its cache prefix is unchanged) asking the model to end its final
  message with a `<next>…</next>` line only when exactly one concrete next step is obvious.
  Hidden agents (title, summary, compaction) and subagent sessions do not get it.
  `experimental.text.complete` removes the line from every finished text part, so it is never
  stored and never sent back to the model. No extra model request.
- **TUI half.** It reads the line from the streamed text (`message.part.delta`), and when the
  session goes idle after a turn that did not fail or get aborted, asks
  [Jev](https://docs.typesafe.ai) whether the suggestion is a concrete, non-generic next step that
  follows from the answer and is not done yet (shown at probability >= 0.6; shown anyway when Jev
  is unavailable or `TYPESAFE_API_KEY` is unset). It renders the session prompt itself (the
  `session_prompt` slot) with the host's props, adding only the placeholder and the hint; the
  `session_prompt_right` slot is kept for other plugins. Each session has its own suggestion; a
  new prompt, a busy session or compaction drops it.
- `Tab`/`Right` are taken only while a suggestion shows in an empty, focused prompt (a
  high-priority keymap layer); otherwise they do what they always do.
- While the answer streams, the `<next>` line is visible for a moment before the finished text
  replaces it.

Owning `session_prompt` means another plugin that also replaces that slot would conflict with it.

## Install

Both halves, at the same commit: the server in `opencode.jsonc`, the TUI in `tui.jsonc`.

```jsonc
// opencode.jsonc and tui.jsonc
"plugin": ["opencode-next-prompt@github:justmytwospence/opencode-next-prompt#<commit>"]
```

## Commands

- `/next-prompt`: toggles suggestions (kept across restarts) and shows the last suggestion with
  Jev's verdict.

## Settings

Later layers win: the shared `~/.config/agents/next-prompt.json` (`$XDG_CONFIG_HOME` honored, shared
with the pi port), the plugin's options in `opencode.jsonc`/`tui.jsonc`,
`<project>/.agents/next-prompt.json`, then `<project>/.opencode/next-prompt.json`.

```json
{
  "enabled": true,
  "acceptKeys": ["tab", "right"],
  "maxChars": 110,
  "jev": { "enabled": true, "model": "jev-latest", "timeoutMs": 1500, "threshold": 0.6 }
}
```

`acceptKeys` are read when opencode starts.

## Development

```sh
npm run check   # typecheck and unit tests
```
