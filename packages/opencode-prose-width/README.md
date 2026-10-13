# opencode-prose-width

An [OpenCode 2](https://opencode.ai) terminal plugin that wraps prose in the transcript at a readable
measure, 80 columns by default, while fenced code blocks and tables keep the full width of the
transcript.

~~~
Line length matters because the eye has to travel back to the start of
the next line after every line it reads, and the longer that journey,
the more likely it is to land on the wrong line.

echo "a long command line keeps the whole width of the transcript, as code should, instead of wrapping at the measure"
~~~

## How it works

OpenCode draws every message with OpenTUI's `MarkdownRenderable`, which keeps one child
renderable per top-level block: paragraph, heading, list, quote, code block, table. The plugin
wraps the class's `updateBlocks`, which every content, streaming, style or table change goes
through, and afterwards caps each prose block at the measure with yoga's `maxWidth`. Code
blocks, tables and rules keep the full width; so does a list or quote holding a table or a code
line longer than the measure.

The class is OpenCode's own: OpenCode rewrites the plugin's static `@opentui/core` import to its
runtime module, so the patch reaches the class OpenCode draws with rather than a second copy.
`updateBlocks` is internal to OpenTUI, so an OpenTUI release that renames it makes the plugin
fail at load rather than misdraw. Tested with OpenCode 2.0.24.

## Settings

The measure is `PROSE_WIDTH`, else `width` in `~/.config/agents/prose-width.json` (shared with
pi-prose-width and claude-prose-width), else the plugin's `width` option, else 80. `0` or `off`
turns it off. `/prose-width` toggles it for the session.

Terminal-only: list it in `~/.config/opencode/cli.json`, pinned to a suite commit.

```json
{
  "plugins": [
    "opencode-prose-width@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-prose-width"
  ]
}
```

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.

```sh
npm ci && npm run check
```
