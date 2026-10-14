---
title: opencode-tool-gate
description: Auto-approves OpenCode tool calls with read-only parsing and Jev judgments, holds only confident danger, and gives each session Claude Code's permission modes. Not a sandbox.
plugin: opencode-tool-gate
---
An OpenCode 2 plugin that auto-approves tool calls, so you are only pulled in when a call is risky and the agent could not find a way around it, with Claude Code's permission modes per session. The port of pi-tool-gate, with the same read-only parsing, always-held list, Jev questions, thresholds and modes.

It is an approval policy inside OpenCode, not a sandbox, a complete secret scanner, or a guarantee that every dangerous operation is caught.

Source: [packages/opencode-tool-gate](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-tool-gate).

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-tool-gate@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-tool-gate"
]
```

## Requirements and costs

Needs `TYPESAFE_API_KEY` in the environment of OpenCode's server. In auto and plan modes every edit, write, patch, non-read-only shell command and MCP call is one Jev request (about 250 ms, billed by TypeSafe), and a held call makes a second one for the workaround. Jev sees the call, your last three messages, the agent's message your newest one replies to, the agent's latest explanation, the working directory, the Git branch and the project rules. Without the key, or when Jev fails or takes over 3 s, judged calls fall through to OpenCode's own permission rules (logged as a warning, with one toast per session); the always-held list still holds. Tested with OpenCode 2.0.24.

## Auto mode

1. **Clear cases, no model call.** Read-only calls run: the built-in `read`, `glob` and `grep`, the tools in `allowTools`, and shell commands made only of read-only programs (`ls`, `rg`, `git status|diff|log`, `npm ls`, `curl`/`wget` GETs, `docker ps|logs|inspect`, `kubectl get|describe|logs`, `gh pr|issue|run view|list`, `systemctl status`, `journalctl`, `sqlite3 -readonly`, `dig`, and more, with no writing redirects or command substitution). A short list is always held, whatever Jev says: `sudo`, deleting `/`, a top-level directory, your home directory, the project, or a parent of either, force-pushing main/master, `curl ... | sh`, and touching credential files (`.env*` but not `.env.example`, `~/.ssh`, `auth.json`, keys; a `git add` of an ignored one is fine).
2. **Jev for the gray zone, holding only on confident danger.** A call is held only when Jev is confident it is dangerous and you did not ask for it (or agree to the agent's offer of it, at >= 0.8): it cannot be undone (>= 0.9); it does something other people see or depend on (>= 0.85: deploy, publish, post a message, open or merge a PR, modify a shared or cloud resource; pushing commits to a branch and maintaining your own machines over ssh do not count); its impact if unwanted is 2.5 or more of 3; it is clearly unrelated to your request (< 0.1) and could do significant harm (impact >= 2); or, whatever you said, it sends secrets or private data off the machine (>= 0.8) or breaks a project rule (>= 0.7). Doubt alone never holds a call.
3. **Jev pushes back, the agent works around it or makes its case.** A held call is denied in the `evaluate` permission hook; the denial reason carries Jev's explanation and a suggested workaround (preview with a dry run, narrow it, make it reversible, keep it local, follow the project rule, skip it, or "no workaround, this is the user's call"). The agent then does the job another way, drops the call, or makes its case in a visible message and retries the identical call. That retry (or another held call of the same family in the same user turn) goes to you through OpenCode's own permission prompt, with why it was held and the agent's case. `once` lets it run; `always` also allows similar calls for the rest of the session; `reject` blocks that call for the turn. `"pushBack": false` skips the workaround and asks straight away.

Subagent sessions go through the same gate, in the mode of the session that started them. In `opencode run`, an escalated call is answered by OpenCode's own rules (`--auto` approves it). OpenCode's own `permission` rules still apply to calls the gate lets through; an explicit `deny` never reaches the gate. Each decision is logged with a `[tool-gate]` prefix and Jev's scores and latency.

## Permission modes

Each session has a mode, kept by the server half across restarts; a new session starts in `defaultMode` (`auto`). The prompt footer shows it right after OpenCode's `dir:branch` (`auto mode on · 3 auto · 1 pushed back · 0 asked`), and a toast announces a change.

| Mode | Runs without asking |
| --- | --- |
| manual | Recognized reads only; every other call goes to OpenCode's prompt, where `always` allows similar calls for the session. No Jev requests. |
| accept-edits | Reads, edits and writes inside the project, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` on files inside the project. Other calls ask. |
| plan | Edits and writes are denied; commands are judged as in auto mode. OpenCode's plan agent is the native alternative. |
| auto | The default: the checks and judgments above. |
| bypass | Everything, including what your config asks about, except removing `/`, top-level directories, home, the project or their parents. |

- `/tool-gate mode [manual|accept-edits|plan|auto|bypass]` switches the mode; with no name it opens a picker. Palette: "Tool gate: permission mode".
- `/tool-gate cycle` (palette "Tool gate: cycle permission mode") steps through `modes` (default `manual > accept-edits > auto`). Bind it through OpenCode's keybinds with the id `tool-gate.cycle`; Shift+Tab is left to OpenCode's agent switch.
- `/tool-gate status` (palette "Tool gate: status") shows the mode, counts, Jev settings, rules and grants.
- `/tool-gate on` switches to auto mode; `/tool-gate off` to bypass mode.

## Project rules

Each top-level bullet in a rules file is a rule, checked on every judged call. The rules are the union of `<project>/.agents/tool-gate-rules.md`, `<project>/.opencode/tool-gate-rules.md`, `~/.config/agents/tool-gate-rules.md` and `~/.config/opencode/tool-gate-rules.md`, in that order, exact duplicates dropped, at most 30. The `.agents` and `~/.config/agents` files are shared with the pi and Claude Code ports.

```markdown
- Migrations are append-only: never edit an existing migration, add a new one.
- No new runtime dependencies without asking.
```

## Settings

Shared, harness-neutral settings in `~/.config/agents/tool-gate.json` (under `$XDG_CONFIG_HOME` when set) and `<project>/.agents/tool-gate.json`; OpenCode-only overrides in the plugin's options in `opencode.jsonc` or `<project>/.opencode/tool-gate.json`. The layers merge in this order, later winning, objects deep-merged, arrays and scalars replaced: defaults, the shared user file, the options, the shared project file, the project's `.opencode` file. Files are re-read when they change. The defaults:

```jsonc
{
  "enabled": true,
  "jev": { "model": "jev-latest", "timeoutMs": 3000 },
  "thresholds": {
    "irreversible": 0.9, "remoteChange": 0.85, "requested": 0.8, "exfiltration": 0.8,
    "impact": 2.5, "offTask": 0.1, "offTaskImpact": 2, "rule": 0.7
  },
  "allowTools": ["subagent", "question", "skill", "websearch", "webfetch", "todowrite", "todoread", "codesearch",
    "opencode_models", "opencode_list_mcp_resources", "opencode_read_mcp_resource", "opencode_session_rename", "opencode_session_move"],
  "readOnlyCommands": [],
  "pushBack": true,
  "defaultMode": "auto",
  "modes": ["default", "acceptEdits", "auto"],
  "toast": true
}
```

`allowTools` replaces the default list; adding a tool there skips its checks. `subagent` is allowed because each tool a subagent calls is gated on its own; `webfetch` only does GETs. `readOnlyCommands` adds programs treated as read-only in shell commands. `enabled: false` starts sessions in bypass mode and leaves every call to OpenCode's own rules.

## Differences from pi-tool-gate

Approval is OpenCode's own permission prompt (`once`, `always`, `reject`), not a dialog of the gate's: no laid-out command or diff view, and "allow similar" is the prompt's `always`, which also saves OpenCode's own rule for the resource. Plan mode is a plain mode of the gate that denies edits; there is no plan file. The mode cycle has no default key. Without Jev, judged calls fall through to OpenCode's rules; plugins cannot see tool annotations, so there is no "flagged by hints" fallback. Jev's token usage is logged, not added to the tool result.
