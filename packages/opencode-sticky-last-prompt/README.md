# opencode-sticky-last-prompt

An [OpenCode 2](https://opencode.ai) terminal plugin that shows the last user prompt that has
scrolled out of view in a dim bar at the top of the transcript, the port of
[pi-sticky-last-prompt](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-sticky-last-prompt).
A left click on the bar scrolls the transcript back so that prompt sits just below it.

Example (an illustration, not a screenshot):

~~~
 ↑ second question about another thing
   Line 18 of a long answer that keeps going.
   Line 19 of a long answer that keeps going.
   ...
~~~

## Behavior

- The bar shows the latest prompt whose rows have all scrolled above the top of the viewport (or
  under the bar itself). While a prompt is still crossing that edge, the bar is hidden rather
  than repeating an older prompt above it. Prompt text is collapsed to one line and truncated.
- A left click on the bar jumps to the pinned prompt. The wheel over the bar scrolls the
  transcript beneath it; other buttons and ordinary transcript input are untouched.
- The pin is recomputed after every drawn frame from the live layout, so scrolling, streaming
  output, resizing, session switches and sidebar changes re-derive it without polling. On the
  home screen or outside a session nothing is shown.

## How it works

OpenCode's transcript is an OpenTUI scroll box whose rows carry message ids. The plugin finds that
box by walking the renderer's tree from the root for a scroll box with a row for one of the
session's user prompts (`context.data.session.message.list`), then reads each prompt row's
position and height to pick the one to pin. The bar is a box claimed in the `app` slot and placed
absolutely over the top rows of the transcript's viewport, so nothing in the layout shifts.

These renderable internals are not plugin API. If an OpenCode release changes them so that the
transcript or its rows cannot be found, the bar stays hidden and nothing else is affected. Tested
with OpenCode 2.0.24.

Differences from pi-sticky-last-prompt: there is no fullscreen-mode condition (OpenCode's TUI is
always fullscreen), skill invocations are tools in OpenCode and so are not pinned, there is no
clear-screen horizon, and the bar uses a plain arrow instead of a Nerd Font pin glyph.

## Settings

Plugin option `lines` (1 to 3, default 1): how many rows the bar may use for a long prompt, set
as `{ "package": "opencode-sticky-last-prompt@...", "options": { "lines": 2 } }` in the
`plugins` list. There are no commands, shortcuts, network calls or model requests.

Terminal-only: list it in `~/.config/opencode/cli.json`, pinned to a suite commit.

```json
{
  "plugins": [
    "opencode-sticky-last-prompt@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-sticky-last-prompt"
  ]
}
```

## Development

Part of [opencode-plugins](https://github.com/justmytwospence/opencode-plugins); see its README.
The license carries the notice of the pi-collections contributors, whose pi-sticky-last-prompt
the selection logic descends from.

```sh
npm ci && npm run check
```
