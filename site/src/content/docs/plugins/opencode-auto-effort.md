---
title: opencode-auto-effort
description: Sets the model variant (effort) for each prompt you send to OpenCode, rated by Jev in about 200 ms, bounded by the variant you chose, and lowered when a subscription window is running out.
plugin: opencode-auto-effort
---
An OpenCode 2 plugin that sets the effort (OpenCode's model variant) for each prompt you send. [Jev](https://docs.typesafe.ai), TypeSafe's System One model, rates how much careful reasoning the request needs, in about 200 ms before the turn starts. The port of pi-auto-effort and claude-auto-effort, with the same questions and policy.

| Score | Request | Level |
| --- | --- | --- |
| 0 | A lookup, trivial answer, or mechanical change | low |
| 1 | A routine single-file change or clear question | medium |
| 2 | A multi-step change, debugging with clear symptoms, design in a known pattern | high |
| 3 | Subtle design, cross-cutting refactor, hard debugging, correctness-critical work | xhigh |

Source: [packages/opencode-auto-effort](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-auto-effort).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-auto-effort@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-auto-effort"
]
```

## Requirements and costs

Needs `TYPESAFE_API_KEY` in OpenCode's server environment. One Jev request per prompt to an `agents` session, billed by TypeSafe; Jev sees the request, the two before it, the last answer, and what the last run did (tool errors, files edited, tool calls). Without the key, or when Jev fails or takes over 1.5 s, the level holds. Subscription limits read response headers only and make no requests. Tested with OpenCode 2.0.24.

## The policy

**Smoothing.** A running average `e = 0.5·score + 0.5·e_prev` moves the level up when it is at least 0.6 above it, and down when at least 0.6 below and the level has held for 2 prompts. A confident (>= 0.6) score 1.5 or more above the level jumps straight to it. A go-ahead ("yes", "continue", "do it") keeps the level.

**Bounds.** The variant the prompt would have used (your pick with the variant cycle, or the agent's `variant`) is the ceiling; `low` is the floor. A level the model has no variant for falls to the next one down. Prompts without a variant, or to agents not in `agents` (default `build`, so planners and scouts keep their own), are left alone.

**Cache-safe.** The session's `prompt` hook notes each new prompt; the first model request of the turn (the `context` hook) asks Jev and fixes the level, and every model request of that turn, tool follow-ups included, runs at it. The level is applied by overlaying that variant's settings on the request (and its headers on `model.request`), so the variant you picked stays selected and shown.

A toast shows `effort: low (auto)` when the level changes (the server half emits an RPC event, the terminal half shows it); each decision is logged to the server log with an `[auto-effort]` prefix.

## Subscription limits

When an Anthropic or Codex subscription window (5h, weekly) is on track to run out before it resets, auto-effort lowers the variant one or two steps below what the request would otherwise get.

**Sources.** The session's `http.response` hook reads the response headers of `api.anthropic.com` (Anthropic's unified `5h`/`7d` headers) and `chatgpt.com` (Codex's `x-codex-*`). It never reads bodies or request headers. Models of provider `anthropic` use the Anthropic readings, `chatgpt`/`openai`/`openai-codex`/`codex` the Codex ones; other providers are never limited, nor are API keys. There is no polling: a new process has no reading until its first response. Only response headers are used, no auth files are read, the readings stay in memory, and quota data never reaches Jev or the model. The toast says when a limit is in force: `effort: medium (auto, limited: 5h 84%)`.

**Tiers.** `caution` (1 level down) at 75% used at once, or when a second assessment 5 minutes later forecasts running out before 90% of the time to reset; `critical` (2 levels down) at 90% used, when the provider reports it exceeded, or when the forecast runs out within 30 minutes, or at a projected 150% at reset after a second assessment. The worst window wins, there is one cut in total, and it never goes below `policy.floor`. A tier lifts after two assessments 5 minutes apart with the projection at most 95% at reset (for critical, under 145%) and use 5 points under the threshold. A window that resets clears its tier at once. Assessments happen at your prompts, so an idle session changes nothing.

**The forecast.** Two rates from the window's history of readings: a recent one (the last hour, half-life 15 minutes) and a sustained one (the last 24 hours, half-life 6 hours). The recent burst decays toward the sustained rate over `tau = min(1 h, window / 5)`, and the forecast integrates that up to the reset. Until a window has 3 readings spanning `min(1 h, window / 10)`, the linear pace stands in, from 10% elapsed and 20% used. A spend limit has no length, so only its absolute thresholds apply.

**Not feeding back.** The policy's own pick (the baseline) is kept apart from the level applied, so a limited stretch never drags the running average down, and the baseline returns at the next prompt once the pressure clears. `"limits": { "enabled": false }` in the shared `auto-effort.json` turns the limits off for every port; the README lists every threshold key.

## Settings

Shared, harness-neutral settings that the pi and Claude Code ports read as well: `~/.config/agents/auto-effort.json` (under `$XDG_CONFIG_HOME` when set) for you, and `<project>/.agents/auto-effort.json` for a project. Keys a harness does not know are ignored. All keys are optional; the defaults:

```jsonc
{
  "enabled": true,
  "agents": ["build"],
  "toast": true,
  "jev": { "model": "jev-latest", "timeoutMs": 1500 },
  "policy": { "floor": "low", "alpha": 0.5, "margin": 0.6, "jump": 1.5, "jumpConfidence": 0.6, "minDwell": 2, "ackThreshold": 0.7 }
}
```

OpenCode-only overrides go in the plugin's options in `opencode.jsonc` (`{ "package": "opencode-auto-effort@...", "options": { "toast": false } }`) or in `<project>/.opencode/auto-effort.json`. The layers merge in this order, later winning, objects deep-merged and arrays and scalars replaced: built-in defaults, the shared user file, the `opencode.jsonc` options, the shared project file, the project's `.opencode` file. The files are re-read when they change, so edits apply to the next prompt without a restart; a missing or invalid file is ignored.

See the [context and cost recipe](/recipes/cache-cost/) for effort beside the cache clock and subscription windows.
