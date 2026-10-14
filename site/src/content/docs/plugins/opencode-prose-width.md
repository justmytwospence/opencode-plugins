---
title: opencode-prose-width
description: Wraps prose in the OpenCode transcript at a readable measure, 80 columns by default, while fenced code blocks and tables keep the full width.
plugin: opencode-prose-width
---
An OpenCode 2 terminal plugin that wraps prose in the transcript at a readable measure, 80 columns by default, while fenced code blocks and tables keep the full width of the transcript. The port of pi-prose-width.

Example (an illustration, not a screenshot):

~~~
Line length matters because the eye has to travel back to the start of
the next line after every line it reads, and the longer that journey,
the more likely it is to land on the wrong line.

echo "a long command line keeps the whole width of the transcript, as code should, instead of wrapping at the measure"
~~~

Source: [packages/opencode-prose-width](https://github.com/justmytwospence/opencode-plugins/tree/main/packages/opencode-prose-width).

## Install

Terminal-only: list it in `~/.config/opencode/cli.json`, pinned to a suite commit.

```json
{
  "plugins": [
    "opencode-prose-width@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-prose-width"
  ]
}
```

## Requirements and costs

Nothing external: no dependencies, network calls or model requests. It wraps an OpenTUI internal (below). Tested with OpenCode 2.0.24.

## How it works

OpenCode draws every message with OpenTUI's `MarkdownRenderable`, which keeps one child renderable per top-level block: paragraph, heading, list, quote, code block, table. The plugin wraps the class's `updateBlocks`, which every content, streaming, style or table change goes through, and afterwards caps each prose block at the measure with yoga's `maxWidth`. Code blocks, tables and rules keep the full width; so does a list or quote holding a table or a code line longer than the measure.

The class is OpenCode's own: OpenCode rewrites the plugin's static `@opentui/core` import to its runtime module, so the patch reaches the class OpenCode draws with rather than a second copy. The wrapper composes with [opencode-markdown-extras](/plugins/opencode-markdown-extras/) in either load order.

## Compatibility

`updateBlocks` is internal to OpenTUI, so an OpenTUI release that renames it makes the plugin fail at load rather than misdraw; `/plugins` shows the failure. See [requirements](/guides/requirements/#opentui-internals-some-components-rely-on).

## Settings and command

The measure is `PROSE_WIDTH` in the terminal's environment, else `width` in `~/.config/agents/prose-width.json` (shared with pi-prose-width and claude-prose-width), else the plugin's `width` option in `cli.json`, else 80. `0` or `off` turns it off.

```json
{
  "width": 72
}
```

`/prose-width` (also "Toggle prose width" in the command palette) toggles it for the session.
