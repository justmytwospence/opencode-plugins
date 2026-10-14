---
title: Troubleshooting
description: Resolve OpenCode Plugins problems with the shared server, plugin loading, duplicate commands, missing Jev, herdr and footer text.
---
## Start with the shared server

OpenCode 2 runs every server half once, in a background service shared by all of your terminals, herdr panes and sessions. A plugin you added, a settings file a component reads only at startup, or a `TYPESAFE_API_KEY` you exported in one shell is not seen until that service restarts:

```sh
opencode service status
opencode service restart
```

`opencode reload` reloads configuration; changes under watched config directories reload on their own, but a changed local dependency or a new environment variable needs the restart. `opencode --standalone` starts a private server for one terminal: useful to reproduce a problem in isolation, but a [herdr child](/plugins/opencode-herdr/) of a standalone session cannot be read by the shared service, and `opencode run` sends prompts without the terminal-side holds.

Server-side state is per session and lives in the service's memory or its storage. After a restart, [cache guard](/plugins/opencode-cache-guard/) rebuilds its clock from the session's last assistant message, the [context breakdown](/plugins/opencode-context/) says it has nothing until the next request, and [background tasks](/plugins/opencode-bg/) listed in a crashed server's state file are killed by the next server.

## /plugins shows an error

`/plugins` in the TUI lists every loaded plugin and whether it failed. Common causes:

| Symptom | Check |
| --- | --- |
| A suite entry is missing from the list | A full commit hash or a typo in the `::path:` selector. The name before `@` must match the directory after `::path:packages/`. The package is installed in the background after startup; restart once it is there. |
| A terminal-only component never appears | It is in `opencode.jsonc`. [Diff review](/plugins/opencode-diff-review/), [markdown extras](/plugins/opencode-markdown-extras/), [prose width](/plugins/opencode-prose-width/) and the [sticky prompt](/plugins/opencode-sticky-last-prompt/) go in `cli.json`; the server's config scan drops a package without a server entry point. |
| Markdown extras or prose width fail at load | They wrap OpenTUI's internal `MarkdownRenderable.updateBlocks`; a release that renames it makes them fail at load rather than misdraw. Disable them until the suite is updated. |
| The sticky prompt bar never shows | It walks renderer internals to find the transcript; when they change, it stays hidden. Also hidden on the home screen and outside a session. |
| A plugin loads twice | Both a suite entry and a retired standalone `opencode-*` package are configured, or the same entry is in `opencode.jsonc` and `cli.json`. Keep one. |

The server log (`opencode run --print-logs` with `--standalone`, or the service's log) carries each component's lines with a `[name]` prefix: `[auto-effort]`, `[cache-guard]`, `[tool-gate]`, `[subagents]`, `[btw]`.

## Duplicate commands

| Symptom | Check |
| --- | --- |
| Two `/diff-review` entries in the slash completion | One is OpenCode's built-in, which asks the agent for a review; the suite's panel is listed beside it. Pick the entry whose description says "Review changes". |
| Two `/btw` entries | OpenCode has a built-in `/btw` that answers in a dialog without touching the conversation. The suite's `/side` alias is unambiguous. |
| `/copy` does not open a picker | `/copy` is OpenCode's own last-reply command. The suite's picker is `/yank`. |
| Shift+Tab does not cycle permission modes | It is OpenCode's agent cycle. Bind `tool-gate.cycle` through `keybinds`, or use `/tool-gate cycle`. |

## Jev is not being called

Every Jev call is made by a server half, so `TYPESAFE_API_KEY` must be in the **service's** environment, not just your shell's. Export it where the service starts, then `opencode service restart`. `/cache-guard-jev` sends one probe question and reports the latency or the failure; the tool gate toasts once per session when it falls through to OpenCode's rules; auto effort logs `[auto-effort]` decisions. `jev.provider` in cache guard's settings must be empty or `typesafe`. See [requirements and costs](/guides/requirements/) for what each component sends.

## Footer text is missing

Components draw right after OpenCode's `dir:branch` in the footer. If a component's text is missing:

- The [status footer](/plugins/opencode-status-footer/)'s Git marks show nothing on a clean checkout and nothing outside Git; `!` alone means Git failed or is paused in a merge, rebase or cherry-pick.
- Subscription windows need subscription response headers (`anthropic`, `chatgpt`/`openai`) or Claude Code's usage cache; API keys get none, and a reading older than ten minutes is dropped.
- The cache clock hides after `/cache-guard-off` (per terminal) and when the model has no known TTL (`cache cold?` after idle time instead).
- The notebook line needs a followed notebook: `/marimo show` prints what the server sees.
- The gate's mode line and the background count are per shown session; the home screen shows only the Git marks.

## herdr integration does nothing

`herdr_child` needs the session (or its root) open in OpenCode inside a herdr pane with opencode-herdr's terminal half loaded; otherwise it fails with a clear message. The pane tokens other components report (`bg`, `cache`, `marimo`) go through opencode-herdr's RPC and are dropped silently when it is absent; they are resent when it comes up. Add the tokens to a row in herdr's `[ui.sidebar.agents]` to see them. Herdr's own OpenCode integration (`herdr integration install opencode`) owns the pane's working, blocked and idle state; the suite reports no state.

## Isolate a problem

Reproduce with a scratch configuration before reporting. The repository's `scripts/smoke.mjs` installs a scratch OpenCode 2 under `.smoke/` with isolated XDG directories and loads every component; `scripts/e2e.mjs` runs one `opencode run --standalone` against a mock provider. Neither touches your live configuration. See [development and testing](/development/).

When reporting, [open an issue](https://github.com/justmytwospence/opencode-plugins/issues) with the OpenCode version (`opencode --version`), the suite commit, the `/plugins` output and the relevant log lines. Do not include credentials or private session content.
