# opencode-tool-gate

An [OpenCode 2](https://opencode.ai) plugin that auto-approves tool calls, so you are only pulled in
when a call is risky and the agent could not find a way around it, with Claude Code's permission
modes per session. The port of
[pi-tool-gate](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate), with
the same read-only parsing, always-held list, Jev questions, thresholds and modes.

It is an approval policy inside OpenCode, not a sandbox, a complete secret scanner, or a guarantee
that every dangerous operation is caught.

## Auto mode

1. **Clear cases, no model call.** Read-only calls run: the built-in `read`, `glob` and `grep`,
   the tools in `allowTools` (`subagent`, `question`, `skill`, `websearch`, `webfetch`, ...), and
   shell commands made only of read-only programs (`ls`, `rg`, `git status|diff|log`, `npm ls`,
   `curl`/`wget` GETs, `docker ps|logs|inspect`, `kubectl get|describe|logs`, `gh pr|issue|run
   view|list`, `systemctl status`, `journalctl`, `sqlite3 -readonly`, `dig`, ... with no writing
   redirects or command substitution). A short list is always held, whatever Jev says: `sudo`,
   deleting `/`, a top-level directory, your home directory, the project, or a parent of either,
   force-pushing main/master, `curl ... | sh`, and touching credential files (`.env*` but not
   `.env.example`, `~/.ssh`, `auth.json`, keys; a `git add` of an ignored one is fine).
2. **Jev for the gray zone, holding only on confident danger.** Edits, writes, patches, other
   shell commands, and MCP tools go to [Jev](https://docs.typesafe.ai), TypeSafe's System One
   model, in one request (about 250 ms). A call is held only when Jev is confident it is
   dangerous and you did not ask for it (or agree to the agent's offer of it, at >= 0.8):
   - it cannot be undone (>= 0.9),
   - it does something other people see or depend on (>= 0.85: deploy, publish, post a message,
     open or merge a PR, modify a shared or cloud resource); pushing commits to a git branch and
     maintaining your own machines over ssh do not count,
   - its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production),
   - it is clearly unrelated to your request (< 0.1) and could do significant harm (impact >= 2),
   - or, whatever you said, it sends secrets or private data off the machine (>= 0.8) or breaks a
     project rule (>= 0.7).

   Doubt alone never holds a call. Jev sees your last three messages, the agent's message your
   newest one replies to, the agent's latest explanation, the working directory and git branch.
3. **Jev pushes back, the agent works around it or makes its case.** A held call is denied in
   the `evaluate` permission hook; the denial reason the agent reads carries Jev's explanation
   (which checks failed and how sure it is, plus any quoted rules) and a suggested workaround,
   which Jev picks in a second request made only for held calls: preview it with a dry run,
   narrow it, make it reversible, keep it local, follow the project rule, skip it, or "no
   workaround, this is the user's call". The agent then does the job another way, drops the
   call, or makes its case in a visible message and retries the identical call. That retry (or
   another held call of the same family in the same user turn) goes to you through OpenCode's own
   permission prompt, with why it was held and the agent's case. `once` lets it run; `always`
   also allows similar calls for the rest of the session (same program and subcommand, edits in
   the same directory, calls of the same tool); `reject` blocks that call for the turn. Set
   `"pushBack": false` to skip the workaround and be asked straight away.

Subagent sessions go through the same gate, in the mode of the session that started them. In
`opencode run`, an escalated call is answered by OpenCode's own rules (`--auto` approves it).

OpenCode's own `permission` rules still apply to calls the gate lets through: a command your
config sets to `ask` is asked by OpenCode; an explicit `deny` never reaches the gate. OpenCode's
`external_directory` check is left to your config.

Without `TYPESAFE_API_KEY`, or when Jev fails or takes over 3 s, judged calls fall through to
OpenCode's own permission rules (logged as a warning, with one toast per session); the always-held
list still holds. Each decision is logged with a `[tool-gate]` prefix and Jev's scores and
latency (`opencode run --print-logs`, or the server log).

## Permission modes

Each session has a mode, kept by the server half across restarts; a new session starts in
`defaultMode` (`auto`). The prompt footer shows it right after OpenCode's `dir:branch`
(`auto mode on · 3 auto · 1 pushed back · 0 asked`), and a toast announces a change.

| Mode | Runs without asking |
| --- | --- |
| manual (`manual mode on`) | Recognized reads only; every other call goes to OpenCode's prompt, where `always` allows similar calls for the session. No Jev requests. |
| accept-edits (`accept edits on`) | Reads, edits and writes inside the project, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` on files inside the project. Other calls ask. |
| plan (`plan mode on`) | Edits and writes are denied; commands are judged as in auto mode. OpenCode's plan agent is the native alternative. |
| auto (`auto mode on`) | The default: the checks and judgments above. |
| bypass (`bypass permissions on`) | Everything, including what your config asks about, except removing `/`, top-level directories, home, the project or their parents. |

- `/tool-gate mode [manual|accept-edits|plan|auto|bypass]` switches the mode; with no name it
  opens a picker. Also in the command palette as "Tool gate: permission mode".
- `/tool-gate cycle` (palette: "Tool gate: cycle permission mode") steps through `modes`
  (default `manual > accept-edits > auto`). Bind it to a key through OpenCode's keybinds with the
  id `tool-gate.cycle`; Shift+Tab is left to OpenCode's agent switch.
- `/tool-gate` or `/tool-gate status` shows the mode, counts, Jev settings, rules and grants.
- `/tool-gate on` switches to auto mode; `/tool-gate off` to bypass mode.

## Project rules

Each top-level bullet in a rules file is a rule, checked on every judged call. The rules are the
union of `<project>/.agents/tool-gate-rules.md`, `<project>/.opencode/tool-gate-rules.md`,
`~/.config/agents/tool-gate-rules.md` and `~/.config/opencode/tool-gate-rules.md`, in that order
(`$XDG_CONFIG_HOME` honoured), exact duplicates dropped, at most 30. The `.agents` and
`~/.config/agents` files are shared: the pi and Claude Code ports of tool-gate read the same ones.

```markdown
- Migrations are append-only: never edit an existing migration, add a new one.
- No new runtime dependencies without asking.
```

## Install

In `opencode.jsonc`, pinned to a suite commit (the terminal half loads with it):

```jsonc
"plugins": [
  "opencode-tool-gate@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-tool-gate"
]
```

Needs `TYPESAFE_API_KEY` in OpenCode's environment. Tested with OpenCode 2.0.24.

## Settings

Settings live in a shared, harness-neutral place that the pi and Claude Code ports of this plugin
read as well, so one file configures tool-gate everywhere: `~/.config/agents/tool-gate.json` (under
`$XDG_CONFIG_HOME` when set) for you, and `<project>/.agents/tool-gate.json` for a project. Keys a
harness does not know are ignored, so pi-only keys in the same file are fine. All keys are
optional; the defaults:

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

`allowTools` replaces the default list; adding a tool there skips its checks. `subagent` is
allowed because each tool a subagent calls is gated on its own; `webfetch` only does GETs.
`readOnlyCommands` adds programs (say `bd`) treated as read-only in shell commands. `enabled:
false` starts sessions in bypass mode and leaves every call to OpenCode's own rules.

OpenCode-only overrides go in the plugin's options in `opencode.jsonc` (`{ "package":
"opencode-tool-gate@...", "options": { "pushBack": false } }`) or in
`<project>/.opencode/tool-gate.json`. The layers merge in this order, later winning, objects
deep-merged and arrays and scalars replaced: built-in defaults, `~/.config/agents/tool-gate.json`,
the `opencode.jsonc` options, `<project>/.agents/tool-gate.json`, `<project>/.opencode/tool-gate.json`.
The files are re-read when they change, so edits apply to the next tool call without a restart; a
missing or invalid file is ignored.

## Differences from pi-tool-gate

- Approval is OpenCode's own permission prompt (`once`, `always`, `reject`), not a dialog of the
  gate's: no laid-out command or diff view, and "allow similar" is the prompt's `always` (which
  also saves OpenCode's own rule for the resource).
- Plan mode is a plain mode of the gate that denies edits; there is no plan file. OpenCode's plan
  agent is the native way to plan.
- The mode cycle has no default key (OpenCode uses Shift+Tab for agents); bind `tool-gate.cycle`
  yourself or use `/tool-gate cycle`.
- Without Jev, judged calls fall through to OpenCode's own permission rules; OpenCode plugins
  cannot see tool annotations, so there is no "flagged by hints" fallback.
- Jev's token usage is logged, not added to the tool result; the shell tool has no description
  argument for Jev to read.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci
npm run check   # typecheck and tests
```
