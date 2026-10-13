# opencode-cache-guard

An [OpenCode 2](https://opencode.ai) plugin that asks before a prompt that would re-cache a large
Anthropic conversation, shows the prompt cache's time left in the footer, and, with
[Jev](https://docs.typesafe.ai) (TypeSafe's judgment model), keeps the context lean: large tool
output is trimmed to what the agent needs, a cold cache can continue on a summary written in code
in about a second, and a compaction is told what to keep word for word. Everything but the Jev
parts works without Jev. The port of
[pi-cache-guard](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cache-guard);
`src/core.ts` (the clock, the cost of a miss, the settings) and `src/lean.ts` (the Jev trimming
and compaction) are the same files.

Anthropic keeps a cached prompt prefix for 5 minutes from the start of the last request that used
it. The first request after that writes the whole conversation to the cache again, at 1.25x the
input price instead of 0.1x for a read: on a 600k-token conversation about $3 on Opus, out of plan
usage on a subscription.

Keeping the cache warm is OpenCode's own job: `"warming": true` (or
`{ "prompt", "interval", "duration" }`) in `opencode.jsonc`. This plugin does not send refreshes.

## The clock (server and terminal)

The server half keeps one clock per session: the start of the last model request (the session's
`http.request` hook, primary requests only; titles and compactions do not count), the prompt size
the next request re-sends (`session.step.ended` tokens), the model and its catalog prices (the
`context` hook), and what each Anthropic response said about the cache (the usage block of a clone
of the `http.response`). Each change goes to the terminals as the `state` RPC event; a terminal
opening a session asks for it with the `state` RPC method, and for a session the server has not
served since it started, reads the same from the session's last assistant message.

The terminal half shows `cache 4:12` (time left), `cache cold`, or `cache cold?` (no TTL known,
idle past `warn.idleMinutes`) in the footer right after `dir:branch` (example):

```
~/code/app:main  cache 4:12  600.0K (60%) · $3.75
```

## The hold (terminal)

A keymap layer over Enter, above the prompt's own submit binding, checks the session's clock
before a prompt goes out. When the cache has expired, the selected model differs from the one the
conversation was cached for, or (providers without a TTL) the session has been idle for
`warn.idleMinutes`, and the re-cache would cost at least `warn.minCost` ($0.50 at API list prices;
`warn.minTokens` for models without prices), the prompt is stashed with OpenCode's own stash and
a dialog offers the ways through, in Pi's order: Enter sends, Esc keeps the prompt.

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).
  Send anyway (~$3.00)                        Write the 601k-token history to the cache again.
  Send, and stop asking in this session       Same as sending, and no more holds here.
  Compact with Jev, then send (~1s, ~$0)      Jev picks what the 601k-token history still needs; the summary is written in code.
  Compact first, then send (~$2.40)           Summarize the 601k-token history once, uncached, and continue on the summary.
  Start fresh with this prompt                A new session with the same agent and model; the history stays here.
  Keep the prompt                             Leave it in the box; nothing is sent.
```

- **Compact with Jev** (when Jev is set up): the terminal arms the server (`arm` RPC, kind
  `jev`) and runs OpenCode's compaction; the server's `compaction` hook sets the hook's `result`
  to a summary written in code from Jev's choices (verbatim, summarize, drop, judged against the
  held prompt in batches of up to 120 with `compact.concurrency` in flight), so no model is
  called. If Jev fails the hook throws, the compaction fails, nothing is sent, and the prompt is
  back in the box with the reason toasted.
- **Compact first** asks what the summary should do: OpenCode's default, *Focus on this prompt*,
  or guidance you write (`arm` kind `guidance`); the `compaction` hook adds it to the summarizer's
  instructions. The prompt is sent once the compaction ends; if it fails, the prompt is back in
  the box.
- **Start fresh** creates a session with the same agent and model, shows it, and sends the prompt
  there.
- **Send anyway** sends; **Send, and stop asking** also mutes the hold for the session in this
  terminal (`cache-guard: on` unmutes).

Slash commands, shell mode and an empty box are never held. Only text travels through the
stash the way OpenCode stashes it; check attachments before resending.

## Commands

Pi's `/cache-guard <sub>` as palette and slash commands:

| Command | Slash | Effect |
| --- | --- | --- |
| cache-guard: status | `/cache-guard` | The last request, TTL, time left or why the next prompt misses, the warning's state, Jev. |
| cache-guard: compact with Jev | `/cache-guard-compact [focus]` | Jev's compaction, written in code against the focus (else the last two requests); nothing is compacted if Jev fails. Without Jev, offers OpenCode's summary (the focus as its guidance) or the setup. |
| cache-guard: start fresh with this prompt | `/cache-guard-fresh` | A new session with the same agent and model, with the prompt box's text sent there. |
| cache-guard: on / off for this session | `/cache-guard-on`, `/cache-guard-off` | Off hides the clock and holds nothing in this terminal; on also unmutes. Trimming and compaction follow the settings. |
| cache-guard: Jev | `/cache-guard-jev` | Whether the server reaches Jev (one probe question, its latency), how to set it up, and turning it off or on (`jev.enabled` in `~/.config/opencode/cache-guard.json`). |

## Trimming tool output (server, Jev)

Text results over 12k characters from `shell`, `execute`, `grep`, `glob`, `webfetch`,
`websearch`, MCP and other plugin tools (over 50k from `read`) are trimmed in the tool hook
`execute.after`, before the model sees them. Jev reads the agent's current step (the latest
request and what the assistant said since, from `ctx.session.context`) and the output split into
at most 150 blocks, and says which blocks hold what the agent needs: errors, failures, requested
values, results. The kept blocks plus the first 5 and last 20 lines stay, in order, with
`[… N lines omitted …]` markers, and a footer points at the full output saved under
`~/.local/share/opencode/cache-guard/tool-output/<session>/<call>.txt`.

OpenCode itself cuts long output and keeps a preview that names the full file; the plugin reads
that file back (up to 8 MB) so Jev picks from all of it, and an error in the cut middle still
reaches the agent. Nothing is trimmed when Jev thinks the agent wants the whole output, when more
than 70% would be kept, when the same call was already trimmed this turn (asking again returns
everything), or when Jev is unavailable, fails or takes over `jev.timeoutMs` (2.5 s). `edit`,
`write`, `subagent`, `skill`, `question` and the like are never trimmed. Each trim is logged to
the server log with a `[cache-guard]` prefix and toasted (`"trim": { "toast": false }` turns the
toast off).

## Compaction context (server, Jev)

With `compact.filter` on, every compaction that is not Jev's (`/compact`, automatic ones, *Compact
first*) also asks Jev which messages and tool calls must survive word for word, judged against the
guidance when there is one and the last two requests otherwise, and adds them to the summarizer's
instructions after one sentence telling it to carry them over. On any Jev failure nothing is added.
Plugins cannot filter what the summarizer reads, so dropped items still reach it.

## herdr

Inside a herdr pane the terminal half reports the pane token `cache` for the session on screen
through opencode-herdr's `herdr` RPC: `cold 601k` (or `cold? 180k` from idle time alone) while the
next prompt would re-cache at least the warning threshold, cleared while warm or small. Without
opencode-herdr the calls fail silently. `"herdr": { "enabled": false }` turns it off. Show it in
herdr's agents sidebar with a custom token in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$cache", fg = "#5f87d7", rules = [{ starts_with = "cold?", dim = true }] }]]
```

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-cache-guard@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-cache-guard"
]
```

Jev needs `TYPESAFE_API_KEY` in the environment of OpenCode's server (a key from
[console.typesafe.ai/keys](https://console.typesafe.ai/keys)); restart the server after setting
it. `jev.provider` must be empty or `typesafe`. Tested with OpenCode 2.0.24.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then
`~/.config/opencode/cache-guard.json`, then the plugin's options in `opencode.jsonc`
(`["opencode-cache-guard@...", { "trim": { "toast": false } }]`), then the project's
`.agents/cache-guard.json` and `.opencode/cache-guard.json`. Later layers win; objects merge. The
files are read again on each use, so edits apply without a restart. The defaults of the keys this
port reads:

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

`"enabled": false` turns everything off; `"jev": { "enabled": false }` only the Jev parts;
`"trim": { "enabled": false }` only the trimming; `"compact": { "filter": false }` only the
compaction context. `warm.*` and `warn.confirmSeconds` are read for the other ports and unused
here: OpenCode warms the cache itself, and the hold is a dialog. `OPENCODE_CACHE_GUARD_TTL_MS`
overrides the Anthropic TTL (for testing).

## Limits

- The clock is the API's guaranteed minimum from each request's start. Tool or system prompt
  changes and the date rolling over in the system prompt also miss, and the clock cannot see
  them. Whether OpenCode's own warming requests pass the session's `http.request` hook, and so
  restart this clock, has not been verified.
- The hold runs in the terminal: `opencode run` and other clients send without asking. A session
  can be shown in several terminals; the mute and the off switch are per terminal.
- A Jev summary is assembled, not written. It is recorded as the session's compaction, under
  OpenCode's template headings.
- Jev's answers are not recorded in the session; the server log has them.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
