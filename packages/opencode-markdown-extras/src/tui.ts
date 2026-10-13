// opencode-markdown-extras (terminal): extra Markdown rendering for the transcript.
//
// - Class and ER diagrams (```classdiagram, ```erdiagram, or a ```mermaid fence opening with that
//   header) drawn as box-drawing art through grok-mermaid (diagram.ts); OpenCode's built-in
//   renderer keeps every ```mermaid kind it draws itself, and state and sequence dialect fences
//   are re-labelled so it draws them too (transform.ts).
// - GitHub admonitions (`> [!NOTE]` ...) as quotes with a bold label, circled numbers as `(n)`,
//   and link labels that span lines joined: text transforms applied through a patch on OpenTUI's
//   MarkdownRenderable (patch.ts), the class OpenCode draws every message with. The host rewrites
//   this file's static `@opentui/core` import to its runtime module, also inside a Git install,
//   so the patch and the `instanceof`-free renderables below reach OpenCode's own classes.

import { Plugin } from "@opencode/plugin/tui";
import { MarkdownRenderable, StyledText, TextRenderable, fg } from "@opentui/core";
import type { ColorInput, RenderContext, TextChunk } from "@opentui/core";
import { OWN_DIALECTS } from "./transform.ts";
import { transform } from "./transform.ts";
import { install } from "./patch.ts";
import { createDiagramRenderer, loadMermaid } from "./diagram.ts";

export default Plugin.define({
  id: "markdown-extras.tui",
  setup(context) {
    const state = install(MarkdownRenderable.prototype as never, transform);
    void loadMermaid().then(() => context.renderer.requestRender());

    const render = createDiagramRenderer({
      ctx: context.renderer as unknown as RenderContext,
      // The art must fit the terminal; the transcript is narrower by its gutters and sidebar.
      width: () => Math.max(20, context.renderer.width - 6),
      colors: () => ({
        border: context.theme.text.muted,
        text: context.theme.text.base,
        edge: context.theme.text.muted,
        edgeLabel: context.theme.text.base,
        title: context.theme.text.muted,
      }),
      chunk: (text, color) => fg(color as ColorInput)(text) as TextChunk,
      // Mirrors OpenCode's own diagram renderable: full width, no wrapping, a blank line above.
      text: (ctx, chunks, height) =>
        new TextRenderable(ctx, { content: new StyledText(chunks), width: "100%", height, wrapMode: "none", selectable: false, marginTop: 1, flexShrink: 0 }),
    });
    const unregister = Object.keys(OWN_DIALECTS).map((language) => context.markdown.registerCodeBlockRenderer(language, render));

    return () => {
      state.enabled = false;
      for (const off of unregister) off();
    };
  },
});
