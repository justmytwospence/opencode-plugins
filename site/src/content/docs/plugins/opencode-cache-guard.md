---
title: opencode-cache-guard
description: Asks before a prompt that would re-cache a large Anthropic conversation, shows the prompt cache's time left in the footer, and with Jev trims tool output and compacts in code.
plugin: opencode-cache-guard
---
An OpenCode 2 plugin that asks before a prompt that would re-cache a large Anthropic conversation, shows the prompt cache's time left in the footer, and, with [Jev](https://docs.typesafe.ai), keeps the context lean: large tool output is trimmed to what the agent needs, a cold cache can continue on a summary written in code in about a second, and a compaction is told what to keep word for word. Everything but the Jev parts works without Jev. The port of pi-cache-guard; `src/core.ts` and `src/lean.ts` are the same files.

Anthropic keeps a cached prompt prefix for 5 minutes from the start of the last request that used it. The first request after that writes the whole conversation to the cache again, at 1.25x the input price instead of 0.1x for a read: on a 600k-token conversation about $3 on Opus, out of plan usage on a subscription. Keeping the cache warm is OpenCode's own job (`"warming"` in `opencode.jsonc`); this plugin does not send refreshes.

Source: [packages/opencode-cache-guard](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-cache-guard).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-cache-guard@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-cache-guard"
]
```

## Requirements and costs

The clock and the hold need nothing. Jev needs `TYPESAFE_API_KEY` in the environment of OpenCode's server (a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)); restart the server after setting it. `jev.provider` must be empty or `typesafe`. Each trim, Jev compaction and compaction filter is a paid classifier request; Jev receives the tool output's blocks with the agent's current step, or the history's items with the held prompt or guidance. The herdr token needs [opencode-herdr](/plugins/opencode-herdr/). Tested with OpenCode 2.0.24.

## The clock

The server half keeps one clock per session: the start of the last model request (the session's `http.request` hook, primary requests only), the prompt size the next request re-sends, the model and its catalog prices, and what each Anthropic response said about the cache. Each change goes to the terminals as the `state` RPC event; a terminal opening a session asks for it, and for a session the server has not served since it started, reads the same from the session's last assistant message.

The terminal half shows `cache 4:12` (time left), `cache cold`, or `cache cold?` (no TTL known, idle past `warn.idleMinutes`) in the footer right after `dir:branch` (example):

```
~/code/app:main  cache 4:12  600.0K (60%) · $3.75
```

## The hold

A keymap layer over Enter, above the prompt's own submit binding, checks the session's clock before a prompt goes out. When the cache has expired, the selected model differs from the one the conversation was cached for, or (providers without a TTL) the session has been idle for `warn.idleMinutes`, and the re-cache would cost at least `warn.minCost` ($0.50 at API list prices; `warn.minTokens` for models without prices), the prompt is stashed with OpenCode's own stash and a dialog offers the ways through. `Enter` sends, `Esc` keeps the prompt.

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).
  Send anyway (~$3.00)                        Write the 601k-token history to the cache again.
  Send, and stop asking in this session       Same as sending, and no more holds here.
  Compact with Jev, then send (~1s, ~$0)      Jev picks what the 601k-token history still needs; the summary is written in code.
  Compact first, then send (~$2.40)           Summarize the 601k-token history once, uncached, and continue on the summary.
  Start fresh with this prompt                A new session with the same agent and model; the history stays here.
  Keep the prompt                             Leave it in the box; nothing is sent.
```

- **Compact with Jev** (when Jev is set up): the terminal arms the server and runs OpenCode's compaction; the server's `compaction` hook sets the result to a summary written in code from Jev's choices (verbatim, summarize, drop, judged against the held prompt in batches of up to 120), so no model is called. If Jev fails the compaction fails, nothing is sent, and the prompt is back in the box with the reason toasted.
- **Compact first** asks what the summary should do: OpenCode's default, *Focus on this prompt*, or guidance you write. The prompt is sent once the compaction ends; if it fails, the prompt is back in the box.
- **Start fresh** creates a session with the same agent and model, shows it, and sends the prompt there.
- **Send anyway** sends; **Send, and stop asking** also mutes the hold for the session in this terminal (`cache-guard: on` unmutes).

Slash commands, shell mode and an empty box are never held. Only text travels through the stash; check attachments before resending.

## Commands

| Command | Slash | Effect |
| --- | --- | --- |
| cache-guard: status | `/cache-guard` | The last request, TTL, time left or why the next prompt misses, the warning's state, Jev. |
| cache-guard: compact with Jev | `/cache-guard-compact [focus]` | Jev's compaction, written in code against the focus (else the last two requests). Without Jev, offers OpenCode's summary or the setup. |
| cache-guard: start fresh with this prompt | `/cache-guard-fresh` | A new session with the same agent and model, with the prompt box's text sent there. |
| cache-guard: on / off for this session | `/cache-guard-on`, `/cache-guard-off` | Off hides the clock and holds nothing in this terminal; on also unmutes. Trimming and compaction follow the settings. |
| cache-guard: Jev | `/cache-guard-jev` | Whether the server reaches Jev (one probe question, its latency), how to set it up, and turning it off or on. |

## Trimming and compaction context

Text results over 12k characters from `shell`, `execute`, `grep`, `glob`, `webfetch`, `websearch`, MCP and other plugin tools (over 50k from `read`) are trimmed in the tool hook `execute.after`, before the model sees them. Jev reads the agent's current step and the output split into at most 150 blocks, and says which blocks hold what the agent needs; the kept blocks plus the first 5 and last 20 lines stay, with `[… N lines omitted …]` markers and a footer pointing at the full output under `~/.local/share/opencode/cache-guard/tool-output/<session>/<call>.txt`. The plugin reads OpenCode's own full-output file back (up to 8 MB) so Jev picks from all of it. Nothing is trimmed when Jev thinks the agent wants the whole output, when more than 70% would be kept, when the same call was already trimmed this turn, or when Jev is unavailable, fails or takes over `jev.timeoutMs`. `edit`, `write`, `subagent`, `skill`, `question` and the like are never trimmed. Each trim is logged with a `[cache-guard]` prefix and toasted.

With `compact.filter` on, every compaction that is not Jev's also asks Jev which messages and tool calls must survive word for word and adds them to the summarizer's instructions. On any Jev failure nothing is added; dropped items still reach the summarizer.

## herdr

Inside a herdr pane the terminal half reports the pane token `cache` for the session on screen: `cold 601k` (or `cold? 180k` from idle time alone) while the next prompt would re-cache at least the warning threshold, cleared while warm or small. Without opencode-herdr the calls fail silently. Show it with a custom `$cache` token in a `[ui.sidebar.agents]` row of `~/.config/herdr/config.toml`.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.config/opencode/cache-guard.json`, then the plugin's options in `opencode.jsonc`, then the project's `.agents/cache-guard.json` and `.opencode/cache-guard.json`. Later layers win; objects merge; files are read again on each use. The defaults of the keys this port reads:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "idleMinutes": 180 },
  "herdr": { "enabled": true },
  "jev": { "enabled": true, "provider": "", "model": "", "timeoutMs": 2500 },
  "trim": { "enabled": true, "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
            "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20 },
  "compact": { "filter": true, "timeoutMs": 10000, "concurrency": 4 }
}
```

`"enabled": false` turns everything off; `"jev": { "enabled": false }` only the Jev parts; `"trim": { "enabled": false }` only the trimming; `"compact": { "filter": false }` only the compaction context. `"trim": { "toast": false }` silences the trim toast. `warm.*` and `warn.confirmSeconds` are read for the other ports and unused here.

## Limits

- The clock is the API's guaranteed minimum from each request's start. Tool or system prompt changes and the date rolling over in the system prompt also miss, and the clock cannot see them. Whether OpenCode's own warming requests pass the session's `http.request` hook has not been verified.
- The hold runs in the terminal: `opencode run` and other clients send without asking. The mute and the off switch are per terminal.
- A Jev summary is assembled, not written. It is recorded as the session's compaction, under OpenCode's template headings. Jev's answers are not recorded in the session; the server log has them.

See the [context and cost recipe](/recipes/cache-cost/).
