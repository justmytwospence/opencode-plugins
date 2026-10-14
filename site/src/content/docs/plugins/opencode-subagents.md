---
title: opencode-subagents
description: A delegate tool beside OpenCode's subagent tool, with parallel tasks, chains, worktree isolation, forked context, async results, and Jev picking the agent, model tier and effort.
plugin: opencode-subagents
---
An OpenCode 2 plugin that adds a `delegate` tool beside OpenCode's own `subagent` tool: a single task, parallel tasks, or a chain whose steps receive the previous step's output; in the foreground or async with the results delivered as one message; with fresh context or the parent's conversation as background; optionally each in a new Git worktree. What a call leaves open (agent, model tier, variant) Jev picks, one request per task; without `TYPESAFE_API_KEY` the defaults apply. The port of pi-subagents' `subagent` tool on top of OpenCode's child sessions.

This component is still being finished; this page describes the server half in the repository at the time of writing. It has no terminal half and no commands.

Source: [packages/opencode-subagents](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-subagents).

## Install

In `opencode.jsonc`, pinned to a suite commit:

```jsonc
"plugins": [
  "opencode-subagents@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-subagents"
]
```

## Requirements and costs

Every delegated task is a child session that makes model calls at your configured access. Jev (one request per task, only for the choices the call left open) needs `TYPESAFE_API_KEY` in the environment of OpenCode's server and is billed by TypeSafe; without it, the `general` agent, the balanced tier and the parent's model and variant apply. Worktrees need a Git repository. Tested with OpenCode 2.0.24.

## The tool

`delegate` is registered directly (not only through Code Mode's `execute`), so the model sees its description, which tells it to prefer doing work directly and to delegate only genuinely independent tasks with a clear payoff, or when you ask.

| Argument | Meaning |
| --- | --- |
| `action` | `run` (default), `status`, `steer`, `stop`, `result` |
| `task`, `agent`, `label`, `model`, `variant` | A single task; omit `agent`, `model` or `variant` to let Jev choose |
| `tasks` | Parallel tasks (up to 8, 4 at a time), each with the same fields |
| `chain` | Sequential steps; `{previous}` in a step's task is replaced by the previous step's output |
| `async` | Return run ids at once and deliver the results as a message when they end |
| `context` | `fresh` (default) or `fork`: start each child with this conversation as background |
| `worktree` | Run each task in a new Git worktree; the description tells the agent to ask first unless you requested isolation |
| `cwd` | Working directory (default: the session's) |
| `id`, `message` | The run id (or a prefix) for `status`, `steer`, `stop` and `result`; the steering message |

A child is a session with the calling session as parent, on one of OpenCode's subagent-mode agents, prompted once and awaited until idle. Its title is `<label> · <agent>`. Results carry the child's last reply, cut to 2,000 lines or 50 KB, and name the child session for the rest. A chain returns its last step's result; parallel runs return each. Cancelling a foreground call interrupts its running children and never starts the queued ones. Async results arrive as one queued synthetic message (`Subagent parallel finished:`) that starts a turn once the parent is idle.

## Who runs it

For each choice, precedence is: explicit arguments, then the agent's own model, then Jev, then defaults. Agents are OpenCode's subagent-mode agents (`mode: subagent` or `all`, not hidden), as `ctx.agent.list()` reports them. Jev is asked which agent suits the task (when more than one exists), how capable a model it needs (`fast`, `balanced`, `strong`, with the `tierDescriptions`), and how much careful reasoning it needs (a 0 to 3 score mapped to `low`, `medium`, `high`, `xhigh`); a variant the model does not offer falls to the nearest lower one.

Implicit models never leave the parent session's provider: an agent's own model from another provider is ignored, and tier models from `tiers` or `providerTiers` apply only when they match the parent's provider. For `openai-codex` the fast tier prefers the matching Luna sibling and the others Sol. An explicit `model` argument may cross providers.

## Worktrees

With `worktree: true`, each task gets `<repo>/.worktrees/subagent-<slug>-<id>` created through OpenCode's worktree API from the session's checkout, then a `subagent/<slug>-<id>` branch, so the child's commits have a home; the child session is moved there before its prompt. A worktree that cannot be made fails the call and stops its other children. The tool does not remove the checkout afterwards.

## Depth and cleanup

Sessions `maxDepth` levels below a top-level session (default 2) lose the tool: the session's `context` hook drops it, so nesting cannot run away. When a parent session is deleted, its running children are interrupted and its runs forgotten; when the plugin unloads, every running child is interrupted.

## Settings

Shared, harness-neutral settings in `~/.config/agents/subagents.json` (under `$XDG_CONFIG_HOME` when set), then the plugin's options in `opencode.jsonc`, then `<project>/.agents/subagents.json` and `<project>/.opencode/subagents.json`; later layers win, objects merge, arrays and scalars replace. Files are re-read when they change. The defaults:

```json
{
  "jev": { "enabled": true, "model": "jev-latest", "timeoutMs": 3000 },
  "tiers": {},
  "providerTiers": {},
  "maxParallel": 8,
  "concurrency": 4,
  "maxDepth": 2
}
```

`tiers` maps `fast`, `balanced` and `strong` to `provider/model`; `providerTiers` does the same per provider, selected by the parent's model. `tierDescriptions` replaces the text Jev sees for each tier.

See the [background work recipe](/recipes/background-work/) for delegation beside shell jobs, and [opencode-herdr](/plugins/opencode-herdr/) for interactive children in their own panes.
