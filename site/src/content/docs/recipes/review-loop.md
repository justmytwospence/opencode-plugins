---
title: Review loop
description: Let the tool gate decide which calls need you, then review the turns you have not looked at with line comments and suggested edits sent back as one message.
---
**Use:** [opencode-diff-review](/plugins/opencode-diff-review/) and, optionally, [opencode-tool-gate](/plugins/opencode-tool-gate/). Diff review is terminal-only and needs a session in a Git repository. The gate needs `TYPESAFE_API_KEY` for its judged calls.

## Decide how much to be asked

The gate gives each session a permission mode. The default, `auto`, runs read-only calls at once, sends edits, writes and other shell commands to Jev, and holds a call only when Jev is confident it is dangerous and you did not ask for it. A held call is denied with Jev's explanation and a suggested workaround; the agent then does the job another way, drops the call, or makes its case and retries, and the retry reaches you through OpenCode's own permission prompt (`once`, `always`, `reject`).

For a change you want to watch closely, switch modes before prompting:

```text
/tool-gate mode accept-edits
```

`accept-edits` runs reads, edits and writes inside the project without asking and asks about everything else. `manual` asks about everything but reads. `plan` denies edits and writes, so the agent can only explore and explain; OpenCode's own Plan agent (Shift+Tab) is the native alternative, with plan files. `/tool-gate status` shows the mode and how many calls were auto-approved, pushed back and asked this session; the footer shows the same after `dir:branch`.

Project rules in `.agents/tool-gate-rules.md` (one top-level bullet each) are checked on every judged call, so "migrations are append-only" becomes a hold rather than a hope.

## Review the turns you have not seen

After the agent has worked:

```text
/diff-review
```

The default scope is `unreviewed`: every turn since your review mark, or since the session began. Other scopes:

```text
/diff-review turn
/diff-review turn 2
/diff-review session
/diff-review head
/diff-review branch
```

A turn is OpenCode's: the messages from a prompt until the session is idle again. OpenCode snapshots the working tree around each turn and `session.diff` compares those snapshots, so a turn's diff includes edits anyone made while it ran. `head` and `branch` come from OpenCode's `vcs.diff` and compare the working tree to HEAD or to the base branch. `S` in the panel picks a scope.

Inside the panel:

1. Move with `j`/`k`, `ctrl+d`/`ctrl+u`, `g`/`G`; jump between hunks with `]`/`[` and files with `}`/`{`. `Enter` folds a file.
2. Press `c` to comment on the line under the cursor, on a `v` selection, on a hunk header (the whole hunk) or on a file header (the whole file).
3. Press `s` to suggest a replacement: the editor opens on the current lines. A suggestion left unchanged is discarded.
4. `l` lists the drafts; `e` and `x` edit or delete the one under the cursor.
5. Send everything with `w` (`W` also closes).

`w` builds one user message: the scope, then each comment with the lines it is on quoted as a diff (or, for a suggestion, the lines to replace and their replacement), then a request to end the reply with `[[dr:<id>]] <answer>` per comment. It is delivered with `delivery: "queue"`, so a busy agent gets it after its current run.

## Read the answers, then mark

When the run ends, the assistant text written since the comments went out is scanned for those tags, and each match is attached to its comment as `answered`. An answer is not verification: open `/diff-review` again, where the new turn is unreviewed, and read the resulting diff.

Marking is explicit. `m` marks the shown turns reviewed and moves the review mark, so the next `/diff-review` shows only what is new; answered comments become resolved. Closing with `q` or `Esc` never marks and keeps the drafts. Comments, replies and the mark are kept per session in the terminal's durable plugin storage, so closing the panel or the terminal keeps them; deleting the session drops them, and a fork starts without them.

## What stays with OpenCode

Undoing a turn is OpenCode's `/undo` and `/redo`, which revert the latest user message and the work that followed it and return the prompt to the composer. OpenCode's own `/diff` shows the session's changes without comments, and its built-in `/diff-review` asks the agent for a review in prose; both are listed beside the suite's panel in the slash completion. See [built into OpenCode 2](/guides/built-in/) for the Pi plan-mode and rewind features that were not ported.
