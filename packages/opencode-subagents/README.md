# opencode-subagents

An [OpenCode 2](https://opencode.ai) plugin that adds a `delegate` tool beside OpenCode's own
`task` tool, the port of
[pi-subagents](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-subagents).
Each delegated task is a child session (its parent is the calling session, so OpenCode's sidebar
and `/sessions` show it) of one of OpenCode's subagent-mode agents, prompted once and awaited. On
top of what `task` does, `delegate` runs several tasks in parallel, chains steps that receive the
previous step's output, runs in the background and reports back as a message, seeds a child with
the conversation so far, isolates each task in its own git worktree and branch, and lets
[Jev](https://docs.typesafe.ai) pick the agent, the model tier and the variant (effort) a call
leaves open. Running children can be inspected, steered and stopped by run id.

## The `delegate` tool

`action: "run"` (the default) takes one of:

- `task` (with optional `label`, `agent`, `model`, `variant`): a single task;
- `tasks: [{ task, label?, agent?, cwd?, model?, variant? }]`: parallel tasks, at most `maxParallel`
  (8) per call, `concurrency` (4) at a time;
- `chain: [...]`: steps in order; `{previous}` in a step's task is replaced by the previous step's
  reply, and the chain stops at the first step that does not succeed.

Options:

| option | |
|---|---|
| `async` | default false. Return the run ids at once; when the call ends, its results arrive as one queued synthetic message (`delivery: "queue"`) that starts a turn once the session is idle |
| `context` | `fresh` (default) or `fork`: each child's prompt starts with a compact transcript of this conversation (user and assistant text, tool calls on one line, thinking dropped, at most 24,000 characters) marked as untrusted background, then the task |
| `worktree` | run each task in a new checkout `<repo>/.worktrees/subagent-<slug>-<id>` on branch `subagent/<slug>-<id>` from the current HEAD, made with OpenCode's own worktree support (its inventory lists it and the project's start command runs there). Set it only when the user requests a worktree or branch isolation; otherwise ask first |
| `cwd` | working directory (default: the session's); each task item may set its own. A child in another directory is moved there before its prompt |

`action: "status" | "steer" | "stop" | "result"` take an `id` (or a unique prefix). `steer` also
takes `message`, delivered to the running child as a steering message. `stop` interrupts the child
session. `status` without an id lists the calling session's runs.

**Labels.** `label` is a short task name, not an agent role. A missing label uses the task's first
nonempty line (without a Markdown heading or list prefix), with no model call. Each chain step gets
its label before `{previous}` is expanded. The child session's title is `<label> · <agent>`.

**Results.** A foreground call returns each child's final reply, headed by its label, agent, model,
variant, status and session id, cut to 2,000 lines or 50 KB (the child session keeps the full
conversation). A chain returns its last step's reply. The tool's metadata lists every run with its
status, turns, tokens and cost, and the title sums the cost. A call whose runs all failed is an
error result.

**Stopping.** Interrupting the turn (Esc) interrupts the call's running children; queued tasks
never start, and the result says how many were skipped. An `async` call is not affected. Deleting
the calling session interrupts its running children; the plugin's cleanup interrupts every
running child.

**Depth.** Sessions `maxDepth` (2) levels below a top-level session do not see the tool: a child
can delegate once more, a grandchild cannot.

## Agent, model and variant

Agents are OpenCode's own agents in `subagent` (or `all`) mode that are not hidden: the built-in
`general` and `explore`, plus any you define in `opencode.jsonc`. Precedence for each choice, as in
pi-subagents: the call's explicit `agent`, `model` and `variant`; then the agent's own model and
variant (when its model is on the parent session's provider); then Jev's picks; then the defaults
(`general`, the balanced tier, the parent session's model and variant).

Jev is asked once per task, with the task and the parent's latest request, only for what is left
open: which agent (a choice over their descriptions, taken at confidence 0.5), how capable a model
(fast, balanced or strong, taken at 0.4, else balanced; asked only when `providerTiers` or `tiers`
name a model for the parent's provider), and how much reasoning (a 0-3 score: low, medium, high,
xhigh). A variant the chosen model does not offer falls to the next lower one it does, or to the
model's default. Implicit models stay on the parent's provider; explicit `model` arguments may
cross providers. Without `TYPESAFE_API_KEY`, or when Jev fails or exceeds its timeout, the
defaults apply and the reason is logged.

## Install

In `opencode.jsonc`, pinned to a suite commit:

```jsonc
"plugins": [
  "opencode-subagents@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-subagents"
]
```

Optional `TYPESAFE_API_KEY` in OpenCode's environment for Jev; `git` on the path for worktrees.
Tested with OpenCode 2.0.24.

## Settings

Settings live in the shared, harness-neutral `~/.config/agents/subagents.json` (under
`$XDG_CONFIG_HOME` when set) and `<project>/.agents/subagents.json`; keys a harness does not know
are ignored. All keys are optional; the defaults:

```jsonc
{
  "jev": { "enabled": true, "model": "jev-latest", "timeoutMs": 3000 },
  "providerTiers": {},   // { "anthropic": { "fast": "anthropic/claude-haiku-4-5", "strong": "anthropic/claude-opus-4-6" } }
  "tiers": {},           // the same, for any provider; only entries on the parent's provider apply
  "tierDescriptions": { "fast": "...", "balanced": "...", "strong": "..." },
  "maxParallel": 8,
  "concurrency": 4,
  "maxDepth": 2
}
```

OpenCode-only overrides go in the plugin's options in `opencode.jsonc` (`{ "package":
"opencode-subagents@...", "options": { "concurrency": 2 } }`) or in
`<project>/.opencode/subagents.json`. The layers merge in this order, later winning, objects
deep-merged and arrays and scalars replaced: built-in defaults, `~/.config/agents/subagents.json`,
the `opencode.jsonc` options, `<project>/.agents/subagents.json`,
`<project>/.opencode/subagents.json`. The files are re-read when they change, so edits apply to the
next call without a restart; a missing or invalid file is ignored.

## Differences from pi-subagents

Children are OpenCode sessions, not separate processes: they share the server, show up in the
sidebar, and keep their conversation after the call. There are no agent definition files; OpenCode's
agents are used. `thinking` is `variant`. `context: "fork"` sends a transcript rather than forking
a session file, because a plugin cannot fork a session. OpenCode's TUI replaces pi's FleetView,
viewer, `/subagents`, `@subagent:` and `@run:` mentions: open the child session instead. A
child's permission requests and questions are OpenCode's to show, as for its `task` tool; the
call waits meanwhile.

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci
npm run check   # typecheck and tests
```

End to end, from the suite root against the scripted provider mock (`test/e2e/*.json`: parallel
children, a chain, an async call, a worktree, the depth limit):

```sh
node scripts/e2e.mjs opencode-subagents --script packages/opencode-subagents/test/e2e/parallel.json -- "delegate two tasks"
```
