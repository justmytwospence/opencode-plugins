---
title: Requirements & costs
description: Which OpenCode Plugins components call Jev with TYPESAFE_API_KEY, which need herdr, marimo, Git or a runtime dependency, and which rely on OpenTUI internals.
---
## The site and the plugins are separate

This is a static Astro/Starlight site. Reading it, searching it and building it require **no model credentials and no backend service**. Search uses a build-time Pagefind index served with the site. Fonts are bundled locally.

Installing a plugin is different: its server half runs code inside OpenCode's shared background service, with your operating-system permissions, and its terminal half runs in your terminal process. A background task runs whatever command the agent gives it, and a delegated task or side thread consumes your configured model access.

Every component was tested with OpenCode 2.0.24. Private OpenTUI internals can change independently of that version; see [the last section](#opentui-internals-some-components-rely-on).

## Classifier features are optional, not free

[Jev](https://docs.typesafe.ai) is TypeSafe's judgment model, reached over its HTTP API with `TYPESAFE_API_KEY` (a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)). The key must be in the environment of **OpenCode's server**, since every Jev call is made by a server half; set it, then `opencode service restart`. Each call is billed by TypeSafe and takes a fraction of a second. When the key is unset, Jev fails or a timeout passes, every component falls back as its table row says; none of them blocks on Jev.

| Component | What Jev sees | When it is called | Without Jev |
| --- | --- | --- | --- |
| [Auto effort](/plugins/opencode-auto-effort/) | The prompt, the two before it, the last answer, and what the last run did | The first model request of each turn of an `agents` session | The level holds |
| [Cache guard](/plugins/opencode-cache-guard/) | Large tool output split into blocks with the current step; the history for a Jev compaction; the items a compaction should keep | Tool results over 12k characters (50k for `read`); *Compact with Jev*; every other compaction | The hold, the clock and OpenCode's own compaction still work |
| [Tool gate](/plugins/opencode-tool-gate/) | The proposed call, your last three messages, the agent's latest explanation, cwd, branch and project rules | Every edit, write, patch, non-read-only shell command and MCP call in auto and plan modes; a second call for held calls | Judged calls fall through to OpenCode's permission rules; the always-held list still holds |
| [Delegation](/plugins/opencode-subagents/) | The task, the agents and the tier descriptions | Once per delegated task, only for the choices (agent, tier, variant) the call left open | The `general` agent, the balanced tier and the parent's model and variant |
| [Copy picker](/plugins/opencode-copy/) | Up to 120 candidate pieces clipped to 600 characters and your last three messages | Each time `/yank` opens (cached by content while the terminal runs) | Recency order |
| [Next prompt](/plugins/opencode-next-prompt/) | The suggestion, the last prompt and the end of the answer | Once per candidate suggestion; none when the model gives no candidate | The suggestion is shown unvetted |

Cache guard, delegation, the copy picker and next prompt read `jev.enabled` in their settings files. Auto effort and the tool gate have no separate Jev switch: leave the key unset, or set their top-level `enabled` to `false`, which turns the whole component off (the gate then starts sessions in bypass mode). **There is no suite-wide Jev switch.** Side conversations, background work, herdr, marimo, the context breakdown, diff review, the status footer and the terminal refinements never call Jev. Jev's answers are logged to the server log, not recorded in the session.

:::caution[Tool gate is not a security boundary]
Classifier judgments are probabilistic, and doubt alone never holds a call. Without Jev, calls other than the always-held list fall through to OpenCode's own rules. Do not use the gate as your only control over untrusted programs or secrets.
:::

## What needs something else?

| Component or feature | Requirement and boundary |
| --- | --- |
| [Background work](/plugins/opencode-bg/) | `bash` (or `/bin/sh`) and `ps`. Commands may need their own tools or credentials. Logs go under `~/.local/share/opencode/bg/`. |
| [Delegation](/plugins/opencode-subagents/) worktrees | A Git repository; `worktree: true` creates `<repo>/.worktrees/<name>` through OpenCode's worktree API and a `subagent/<name>` branch. Not needed for ordinary delegation. |
| [Herdr](/plugins/opencode-herdr/) | OpenCode running inside a [herdr](https://herdr.dev) pane (tested with herdr 0.9.3) with herdr's own OpenCode integration. Worktree children need the `worktree` helper; the `$pr` token needs an authenticated `gh`. |
| herdr reporting by other components | Cache guard, background work and marimo report tokens and notifications through opencode-herdr's RPC. Without opencode-herdr the calls fail silently. |
| [Notebooks](/plugins/opencode-marimo/) | A running [marimo](https://marimo.io) server. Servers started with `--no-token` register themselves for discovery; token-protected servers need `MARIMO_TOKEN` in the server's environment. Editing is the separate marimo-pair skill. |
| [Diff review](/plugins/opencode-diff-review/) | A session in a Git repository: OpenCode's turn snapshots and `vcs.diff` need one. |
| [Status footer](/plugins/opencode-status-footer/) | Git marks need a Git checkout and never fetch. Subscription windows come from `anthropic` and `chatgpt`/`openai` response headers, or from Claude Code's `oauth-usage.json` cache; API-key users see none. |
| [Markdown extras](/plugins/opencode-markdown-extras/) | `grok-mermaid`, its only runtime dependency, installed by OpenCode with the plugin. Loaded lazily; without it every other transform still works. |
| [Side conversations](/plugins/opencode-btw/) | Model access for a second session; `/btw:ask` needs a read-only agent (`plan` by default). |

The documentation does **not** assert a Windows compatibility matrix. Background work uses POSIX shells and process groups. Check a component's implementation before adopting it in a different environment.

## OpenTUI internals some components rely on

OpenCode draws the transcript with OpenTUI, and the plugin API covers slots, panels, dialogs, commands and code-block renderers. Three terminal components reach past it:

- [Markdown extras](/plugins/opencode-markdown-extras/) and [prose width](/plugins/opencode-prose-width/) wrap `MarkdownRenderable.updateBlocks`, which every content, streaming or style change goes through. The wrapper calls whatever was installed before it, so the two compose in either load order. `updateBlocks` is internal to OpenTUI: a release that renames it makes the plugin **fail at load** rather than misdraw.
- The [sticky prompt](/plugins/opencode-sticky-last-prompt/) walks the renderer's tree to find the transcript scroll box and its prompt rows. If a release changes them, the bar **stays hidden** and nothing else is affected.

`/plugins` in the TUI shows a plugin that failed to load. The suite's checks target OpenCode 2.0.24.

## Read the right number

Cache guard's cost figures use the model's catalog prices and Anthropic's published cache multipliers; they are estimates, not an invoice, and subscription use is "plan usage", not dollars. The context breakdown counts characters divided by four per part and scales to the usage OpenCode reports. Subscription windows show percent used and time to reset from provider headers, dropped when older than ten minutes. [Context and cost](/recipes/cache-cost/) explains the distinctions.
