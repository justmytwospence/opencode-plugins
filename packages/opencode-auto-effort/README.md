# opencode-auto-effort

An [OpenCode 2](https://opencode.ai) plugin that sets the effort (OpenCode's model variant) for each
prompt you send. [Jev](https://docs.typesafe.ai), TypeSafe's System One model, rates how much
careful reasoning the request needs, in about 200 ms before the turn starts. The port of
[pi-auto-effort](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-auto-effort) and
[claude-auto-effort](https://github.com/justmytwospence/claude-auto-effort), with the same questions
and policy.

| Score | Request | Level |
|---|---|---|
| 0 | a lookup, trivial answer, or mechanical change | low |
| 1 | a routine single-file change or clear question | medium |
| 2 | a multi-step change, debugging with clear symptoms, design in a known pattern | high |
| 3 | subtle design, cross-cutting refactor, hard debugging, correctness-critical work | xhigh |

Jev sees the request, the two before it, the last answer, and what the last run did (tool errors,
files edited, tool calls).

**Smoothing.** A running average `e = 0.5·score + 0.5·e_prev` moves the level up when it is at least
0.6 above it, and down when at least 0.6 below and the level has held for 2 prompts. A confident
(>= 0.6) score 1.5 or more above the level jumps straight to it. A go-ahead ("yes", "continue", "do
it") keeps the level.

**Bounds.** The variant the prompt would have used (your pick with the variant cycle, or the
agent's `variant`) is the ceiling; `low` is the floor. A level the model has no variant for falls to
the next one down. Prompts without a variant, or to agents not in `agents` (default `build`, so
planners and scouts keep their own), are left alone.

**Cache-safe.** The session's `prompt` hook notes each new prompt; the first model request of the
turn (the `context` hook) asks Jev and fixes the level, and every model request of that turn,
tool follow-ups included, runs at it. The level is applied by overlaying that variant's settings
on the request (and its headers on `model.request`), so the variant you picked stays selected and
shown. Without `TYPESAFE_API_KEY`, or when Jev fails or takes over 1.5 s, the level holds.

A toast shows `effort: low (auto)` when the level changes (the server half emits an RPC event,
the terminal half shows it); each decision is logged to the server log with an `[auto-effort]`
prefix.

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-auto-effort@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-auto-effort"
]
```

Needs `TYPESAFE_API_KEY` in OpenCode's environment. Tested with OpenCode 2.0.24.

## Limits

When an Anthropic or Codex subscription window (5h, weekly) is on track to run out before it resets, auto-effort lowers the variant one or two steps below what the request would otherwise get.

**Sources.** The session's `http.response` hook reads the response headers of `api.anthropic.com`
(Anthropic's unified `5h`/`7d` subscription headers) and `chatgpt.com` (Codex's `x-codex-*`, when
they appear). It never reads bodies or request headers. Models of provider `anthropic` use the
Anthropic readings, `chatgpt`/`openai`/`openai-codex`/`codex` the Codex ones; other providers are
never limited, nor are API keys (no subscription headers). There is no polling: a
new process has no reading until its first response.

**Privacy.** Only response headers are used; no auth files are read, and the readings stay in
memory. Quota data never reaches Jev or the model. The log line and toast say when a limit is in
force: `effort: medium (auto, limited: 5h 84%)`.

**When it lowers the effort.** Each window gets a tier:

| Tier | Effort | At once when | After a second assessment 5 minutes later when |
|---|---|---|---|
| caution | 1 level down | 75% used | the forecast runs out before 90% of the time to reset (warming up: projected 100% at reset) |
| critical | 2 levels down | 90% used, the provider reports it exceeded, or the forecast runs out within 30 minutes | projected 150% at reset |

The worst window wins, and there is one cut in total. The cut never goes below `policy.floor`. A
tier lifts after two assessments 5 minutes apart with the projection at most 95% at reset (for
critical, under 145%) and use 5 points under the tier's threshold. A window that resets clears its
tier at once. Assessments happen at your prompts, so an idle session changes nothing.

**The forecast.** Two rates from the window's history of readings: a recent one (the last hour,
half-life 15 minutes; gaps over 30 minutes do not count) and a sustained one (the last 24 hours,
half-life 6 hours), each weighting an interval by its length and recency. The recent burst decays
toward the sustained rate over `tau = min(1 h, window / 5)`, and the forecast integrates that up to
the reset: near a 5h reset a burst dominates, across a week it fades. Until a window has 3 readings
spanning `min(1 h, window / 10)`, the linear pace (used divided by the fraction of the window
elapsed, as in CodexBar) stands in, from 10% elapsed and 20% used. A reading older than 15 minutes
still counts as a minimum (use only grows within a window) but not for the weighted forecast. A
spend limit has no length, so only its absolute thresholds apply.

**Not feeding back.** The policy's own pick (the baseline) is kept apart from the level applied, so
a limited stretch never drags the running average or the level down, and the baseline returns at
the next prompt once the pressure clears.

Settings, in the shared file:

```json
"limits": {
  "enabled": true,
  "caution":  { "used": 0.75, "projected": 1.0 },
  "critical": { "used": 0.90, "projected": 1.5, "exhaustMinutes": 30 },
  "steps": { "caution": 1, "critical": 2 },
  "exitProjected": 0.95,
  "hysteresis": 0.05,
  "confirmMinutes": 5,
  "staleMinutes": 15,
  "warmup": { "readings": 3, "spanMinutes": 60, "minElapsed": 0.1, "minUsed": 0.2 },
  "recent": { "lookbackMinutes": 60, "halfLifeMinutes": 15 },
  "sustained": { "lookbackHours": 24, "halfLifeHours": 6 }
}
```

On by default; `"limits": { "enabled": false }` in the shared `auto-effort.json` turns it off for
every port. An invalid value
falls back to its default.

## Settings

Settings live in a shared, harness-neutral place that the pi and Claude Code ports of this plugin
read as well, so one file configures auto-effort everywhere: `~/.config/agents/auto-effort.json`
(under `$XDG_CONFIG_HOME` when set) for you, and `<project>/.agents/auto-effort.json` for a
project. Keys a harness does not know are ignored, so pi-only keys in the same file are fine. All
keys are optional; the defaults:

```jsonc
{
  "enabled": true,
  "agents": ["build"],
  "toast": true,
  "jev": { "model": "jev-latest", "timeoutMs": 1500 },
  "policy": { "floor": "low", "alpha": 0.5, "margin": 0.6, "jump": 1.5, "jumpConfidence": 0.6, "minDwell": 2, "ackThreshold": 0.7 }
}
```

OpenCode-only overrides go in the plugin's options in `opencode.jsonc` (`{ "package":
"opencode-auto-effort@...", "options": { "toast": false } }`) or in
`<project>/.opencode/auto-effort.json`. The layers merge in this order, later winning, objects
deep-merged and arrays and scalars replaced: built-in defaults, `~/.config/agents/auto-effort.json`,
the `opencode.jsonc` options, `<project>/.agents/auto-effort.json`,
`<project>/.opencode/auto-effort.json`. The files are re-read when they change, so edits apply to
the next prompt without a restart; a missing or invalid file is ignored.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci
npm run check   # typecheck and tests
```
