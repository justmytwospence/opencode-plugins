---
title: Context & cost
description: Use the cache hold and clock, the context breakdown, automatic reasoning effort and subscription windows without mistaking estimates for guarantees.
---
**Use:** [opencode-cache-guard](/plugins/opencode-cache-guard/) and [opencode-context](/plugins/opencode-context/); optionally [opencode-auto-effort](/plugins/opencode-auto-effort/) and [opencode-status-footer](/plugins/opencode-status-footer/).

## Start with observation

```text
/cache-guard
/context
```

The first reports the last request, the TTL, the time left or why the next prompt misses, the hold's state and Jev. The second opens a dialog with a usage bar and one row per part of the last model request: system prompt, instruction files, skills, tool definitions, tool results, conversation, other, free space; `Enter` on a row previews that part as the model received it.

Keep the distinctions clear:

- **Context usage** is the usage OpenCode reported for the session's last response, split into parts by character counts (four characters per token) and scaled to the report. The per-part numbers are estimates, not a tokenizer's output.
- **Cache time left** is the API's guaranteed minimum from the start of the last primary request, not a look into the provider's cache. Tool or system prompt changes also miss, and the clock cannot see them.
- **The cost of a miss** uses the model's catalog prices and Anthropic's cache multipliers; on a subscription it is plan usage, not dollars.
- **Subscription windows** are percent used and time to reset from provider response headers, dropped when older than ten minutes.

## Decide when the cache is cold

Anthropic keeps a cached prompt prefix for five minutes from the start of the last request that used it. The first request after that writes the whole conversation to the cache again, at 1.25x the input price instead of 0.1x for a read. Cache guard's terminal half holds a prompt when the cache has expired, the selected model differs from the one the conversation was cached for, or (providers without a TTL) the session has been idle for `warn.idleMinutes`, and the re-cache would cost at least `warn.minCost` ($0.50 at API list prices; `warn.minTokens` for models without prices).

The hold stashes the prompt with OpenCode's own stash and offers, in this order: send anyway; send and stop asking in this session; compact with Jev, then send; compact first, then send; start fresh with this prompt; keep the prompt. `Enter` sends, `Esc` keeps the prompt in the box. Choose by the work:

- **Send anyway** when the detailed history is still useful.
- **Compact with Jev** when a summary assembled from the exact items Jev keeps (verbatim, summarized or dropped, judged against the held prompt) is enough. It is written in code in about a second, with no model call. If Jev fails, nothing is sent and the prompt is back in the box.
- **Compact first** when a model-written summary is worth its uncached cost. You choose OpenCode's default summary, *Focus on this prompt*, or guidance you write.
- **Start fresh** when the next request is independent: a new session with the same agent and model.

Slash commands, shell mode and an empty box are never held. Only text travels through the stash; check attachments before resending. `opencode run` and other clients send without asking.

## Keep the context lean

With Jev, cache guard trims text results over 12k characters (50k from `read`) before the model sees them: the blocks that hold errors, failures, requested values and results stay, plus the first 5 and last 20 lines, and a footer points at the full output under `~/.local/share/opencode/cache-guard/tool-output/`. Asking for the same output again in the turn returns everything. Every other compaction (`/compact`, automatic ones, *Compact first*) also asks Jev which messages and tool calls must survive word for word and adds them to the summarizer's instructions.

To keep those off while keeping the hold and the clock:

```json
{
  "jev": { "enabled": false }
}
```

in `~/.config/agents/cache-guard.json` (shared with the other ports) or `~/.config/opencode/cache-guard.json`. `/cache-guard-jev` sends one **live** probe question; it is not an offline status command.

## Let effort move inside a ceiling

Auto effort rates each prompt you send with Jev (0 to 3) and sets the model variant for the turn: low, medium, high or xhigh. The variant the prompt would have used, your pick with OpenCode's variant cycle or the agent's, is the ceiling; `low` is the floor; a running average with a dwell time keeps the level from flapping, and a go-ahead ("yes", "continue") keeps it. Only the `agents` listed (default `build`) are touched, so planners and subagents keep their own. The variant you picked stays selected and shown; a toast says `effort: low (auto)` when the level changes.

When an Anthropic or Codex subscription window (5h, weekly) is on track to run out before it resets, the level is lowered one or two steps below what the request would get, from response headers only, and the baseline returns at the next prompt once the pressure clears. `"limits": { "enabled": false }` in the shared `auto-effort.json` turns that off. Without `TYPESAFE_API_KEY`, or when Jev fails or takes over 1.5 s, the level holds.

## Warming belongs to OpenCode

Cache guard does not send keep-warm requests. OpenCode's own `"warming": true` (or `{ "prompt", "interval", "duration" }`) in `opencode.jsonc` does; a warming request costs tokens. Whether those requests pass the session's `http.request` hook and restart cache guard's clock has not been verified.

## Know where quota data came from

The status footer's subscription windows read the rate-limit headers of every `anthropic` and `chatgpt`/`openai` response, headers only. Until a response has said anything, Claude's windows come from Claude Code's shared `oauth-usage.json` cache, which Claude Code's status line keeps fresh and which may belong to a different account from the one OpenCode bills. Warning color from 70%, error from 90%. Auto effort reads the same headers for its limits but keeps its readings to itself; quota data never reaches Jev or the model.
