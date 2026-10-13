// opencode-prose-width (terminal): wraps prose in the transcript at a readable measure while code
// blocks and tables keep the full width of the terminal (patch.ts).
//
// The measure comes from PROSE_WIDTH, else `width` in ~/.config/agents/prose-width.json (shared
// with the pi and Claude Code ports), else this plugin's `width` option, else 80. `0` or `off`
// turns it off. `/prose-width` toggles it for the session.
//
// MarkdownRenderable is OpenCode's own: the host rewrites this static `@opentui/core` import to
// its runtime module, also inside a Git install, so the patch reaches the class OpenCode draws
// every message with.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Plugin } from "@opencode/plugin/tui";
import { MarkdownRenderable } from "@opentui/core";
import { DEFAULT_MEASURE, install, parseMeasure, setMeasure } from "./patch.ts";

export function configuredMeasure(option: unknown, env = process.env, home = homedir()): number {
  const fromEnv = parseMeasure(env.PROSE_WIDTH);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const file = JSON.parse(readFileSync(path.join(home, ".config/agents/prose-width.json"), "utf8"));
    const fromFile = parseMeasure(file?.width);
    if (fromFile !== undefined) return fromFile;
  } catch {}
  return parseMeasure(option) ?? DEFAULT_MEASURE;
}

export default Plugin.define({
  id: "prose-width.tui",
  setup(context) {
    const configured = configuredMeasure((context.options as { width?: unknown }).width);
    const state = install(MarkdownRenderable.prototype as never, configured);
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "prose-width.toggle",
          title: "Toggle prose width",
          group: "View",
          palette: true,
          slash: { name: "prose-width" },
          run: () => {
            setMeasure(state, state.measure ? 0 : configured || DEFAULT_MEASURE);
            context.renderer.requestRender();
            context.ui.toast.show({ message: state.measure ? `prose wraps at ${state.measure} columns` : "prose width off", variant: "info" });
          },
        },
      ],
    }));
    return () => setMeasure(state, 0);
  },
});
