---
title: opencode-diff-review
description: Review what the OpenCode agent changed the way you would review a pull request, with line comments, suggested edits and one message back to the agent.
plugin: opencode-diff-review
---
An OpenCode 2 terminal plugin for reviewing what the agent changed the way you would review a pull request, the port of pi-diff-review. `/diff-review` opens a full-screen session panel with the diff of every turn you have not reviewed yet; you move through it with vim keys, comment on lines or suggest replacements, and send the drafts to the agent as one message. The agent is asked to answer each comment with a tagged line, and those answers show up under the comments when its run ends.

OpenCode's own `/diff` shows the session's changes; this adds the review on top: comments anchored to lines, suggested edits, a draft list, one message that quotes each commented hunk, reply tracking, and a review mark so `/diff-review` shows only what is new since you last looked.

Example output, not a screenshot:

~~~
Review  unreviewed, since the session began (2 turns)  2 files · +9 -1 · 1 draft
▾ src/hello.ts added +8 -0
   @@ -0,0 +1,8 @@
▌ 1 + export function hello(name: string) {
  2 +   return "Hello " + name;
    ┌ comment k7mq · draft · L2
    │   Use a template literal here.
  3 + }
~~~

Source: [packages/opencode-diff-review](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-diff-review).

## Install

Terminal-only: list it in `~/.config/opencode/cli.json`, pinned to a suite commit.

```json
{
  "plugins": [
    "opencode-diff-review@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-diff-review"
  ]
}
```

## Requirements and costs

A session in a Git repository: OpenCode's snapshots and `vcs.diff` need one. No settings, no network calls, no Jev. The message sent with `w` is an ordinary prompt the agent answers at your configured access. Tested with OpenCode 2.0.24.

## Scopes

`/diff-review [scope]` (also "Review changes" in the command palette); `S` in the panel picks one. OpenCode has a built-in `/diff-review` command that asks the agent for a review; both are listed in the slash completion.

| Scope | Compares |
| --- | --- |
| `unreviewed` (default) | Every turn since your review mark, or since the session began |
| `turn [n]` | The last agent run; `turn 2` the one before |
| `session` | Every turn of this session |
| `head` | The working tree against HEAD |
| `branch` | The working tree against the base branch |

A turn is what OpenCode calls one: the messages from a prompt until the session is idle again. OpenCode snapshots the working tree around each turn and `session.diff` compares those snapshots, so a turn's diff includes edits anyone made while it ran. The two repository scopes come from OpenCode's `vcs.diff`. Without turns, `/diff-review` opens `head`.

## Keys

| Key | Action |
| --- | --- |
| `j`/`k`, arrows, `ctrl+d`/`ctrl+u`, `g`/`G` | Move |
| `]`/`[`, `}`/`{` | Next or previous hunk, file |
| `Enter` | Fold or unfold the file (also shows a file over 1500 diff lines) |
| `v` | Start or end a line selection |
| `c` | Comment on the line, the selection, a hunk header (the whole hunk) or a file header (the whole file) |
| `s` | Suggest a replacement for the line or the selection: the editor opens on the current lines |
| `e`, `x` | Edit or delete the comment under the cursor |
| `l` | List the comments; `Enter` jumps to one, `e` edits, `x` deletes, `w` sends the drafts |
| `w`, `W` | Send the drafts to the agent (`W` also closes) |
| `S` | Pick the scope |
| `m` | Mark the shown turns reviewed; answered comments become resolved |
| `r`, `f`, `?` | Reload, toggle full screen, show the keys |
| `q`, `Esc` | Close; drafts are kept |

The comment and suggestion editors follow OpenCode's input keys: `Enter` submits, `shift+Enter` (or `ctrl+j`) adds a line, `Esc` cancels. A suggestion left unchanged is discarded.

## Sending and replies

`w` builds one user message: the scope, then each comment with the lines it is on quoted as a diff (or, for a suggestion, the lines to replace and their replacement), then a request to end the reply with `[[dr:<id>]] <answer>` per comment. It is delivered with `delivery: "queue"`, so a busy agent gets it after its current run. When a run ends, the assistant text written since the comments went out is scanned for those tags and each match is attached to its comment as `answered`. An answer is not verification: look at the resulting diff, which `/diff-review` shows as unreviewed.

Comments, replies and the review mark are kept per session in the terminal's durable plugin storage; closing the panel or the terminal keeps the drafts. Deleting the session drops them.

## Differences from pi-diff-review

Turns, snapshots and diffs come from OpenCode rather than from the plugin's own Git plumbing, so scopes are OpenCode's turns and its `working`/`branch` comparisons; `staged` and arbitrary refs are not offered, and there is no split view, search, per-file reviewed checks or editor split. Comments are stored per session rather than per branch of the session tree, so a fork starts without them. Sending is `w` instead of `:w`, since the panel has no command line.

See the [review loop recipe](/recipes/review-loop/) for the workflow with the [tool gate](/plugins/opencode-tool-gate/).
