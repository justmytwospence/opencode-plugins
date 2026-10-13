// opencode-prose-width (TUI): wraps prose in the transcript at a readable measure while code
// blocks and tables keep the full width of the terminal (patch.ts).
//
// The measure comes from PROSE_WIDTH, else `width` in ~/.config/agents/prose-width.json (shared
// with the pi and Claude Code ports), else this plugin's `width` option, else 80. `0` or `off`
// turns it off. `/prose-width` toggles it for the session.
//
// MarkdownRenderable is taken from opencode itself, the Bun virtual module
// `opentui:runtime-module:@opentui/core`: a git install's own `@opentui/core` would be a second
// copy whose class opencode never draws with.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { DEFAULT_MEASURE, install, parseMeasure, setMeasure } from "./patch.js";

const RUNTIME_MODULE = "opentui:runtime-module:";

type Core = typeof import("@opentui/core");

async function hostCore(): Promise<Core> {
  try {
    return (await import(RUNTIME_MODULE + encodeURIComponent("@opentui/core"))) as Core;
  } catch {
    return import("@opentui/core");
  }
}

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

const tui: TuiPlugin = async (api, options) => {
  const { MarkdownRenderable } = await hostCore();
  const configured = configuredMeasure((options as { width?: unknown } | undefined)?.width);
  const state = install(MarkdownRenderable.prototype as never, configured);

  const offToggle = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "prose-width.toggle",
        title: "Toggle prose width",
        category: "View",
        slashName: "prose-width",
        run: () => {
          setMeasure(state, state.measure ? 0 : configured || DEFAULT_MEASURE);
          api.renderer.requestRender();
          api.ui.toast({ message: state.measure ? `prose wraps at ${state.measure} columns` : "prose width off", variant: "info" });
          return true;
        },
      },
    ],
  } as never);
  api.lifecycle.onDispose(() => {
    offToggle();
    setMeasure(state, 0);
  });
};

export default { id: "opencode-prose-width-tui", tui };
