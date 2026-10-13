// What the TUI shows, apart from the JSX so it can be tested as plain TypeScript.

import { type StatusParts, statusParts } from "./core/render.js";
import type { MarimoWatcher } from "./core/watcher.js";

export interface View {
  parts?: StatusParts;
  /** Shown instead of parts (several notebooks, or a pinned one not open). */
  note?: string;
}

export function view(watcher: MarimoWatcher, now = Date.now()): View {
  const { connection, attachment, mode } = watcher;
  if (!attachment) return {};
  if (connection === "searching") return mode.kind === "pinned" ? { note: `${mode.paths.map((p) => p.split("/").pop()).join(", ")} not open` } : {};
  return { parts: statusParts(watcher.notebook, attachment, connection, now, watcher.others()) };
}

/** The prompt line is narrow: keep the whole heading path only when short, else the deepest heading. */
export function shortSection(section: string, max = 22): string {
  if (section.length <= max) return section;
  const deepest = section.split(" › ").pop() ?? section;
  return deepest.length <= max ? deepest : `${deepest.slice(0, max - 1)}…`;
}

/** A run of text in the status line; `color` names a theme color, or the line's own when absent. */
export interface Segment {
  text: string;
  color?: "warning" | "accent" | "error";
}

/**
 * The line beside the prompt, short because the agent and model labels share it:
 * `marimo fit.py · 1 error`, or while a cell runs `marimo ▸ Model fit 12s · 1 error`.
 * Undefined shows nothing.
 */
export function segments(v: View): Segment[] | undefined {
  const p = v.parts;
  if (!p) return v.note ? [{ text: "marimo " }, { text: v.note, color: "warning" }] : undefined;
  const out: Segment[] = [{ text: "marimo " }];
  if (p.running) {
    out.push({ text: "▸ ", color: "warning" });
    const section = shortSection(p.running.section) || `cell ${p.running.cell}`;
    out.push({ text: `${section}${p.running.elapsed ? ` ${p.running.elapsed}` : ""}` });
  } else {
    out.push({ text: p.notebook, color: "accent" });
  }
  if (p.connection !== "connected") out.push({ text: " · " }, { text: p.connection, color: "warning" });
  if (p.errors) out.push({ text: " · " }, { text: `${p.errors} error${p.errors === 1 ? "" : "s"}`, color: "error" });
  if (p.others?.length) out.push({ text: ` · +${p.others.length}` });
  return out;
}

/**
 * The sidebar's list: every followed notebook on its own line, the current one first and marked,
 * with what its kernel is doing; the others by name.
 */
export function sidebarLines(watcher: MarimoWatcher, now = Date.now()): Segment[][] | undefined {
  const followed = watcher.followed();
  if (!followed.length) return undefined;
  return [
    [{ text: "marimo", color: "accent" }],
    ...followed.map((f): Segment[] => {
      const name = f.attachment.path.split("/").pop() ?? f.attachment.path;
      if (!f.current) return [{ text: `  ${name}` }];
      const p = statusParts(f.notebook, f.attachment, f.connection, now);
      const line: Segment[] = [{ text: "▸ ", color: "warning" }, { text: name, color: "accent" }];
      if (p.connection !== "connected") line.push({ text: ` ${p.connection}`, color: "warning" });
      if (p.running) line.push({ text: ` · running ${shortSection(p.running.section, 18) || `cell ${p.running.cell}`}${p.running.elapsed ? ` ${p.running.elapsed}` : ""}` });
      if (p.errors) line.push({ text: " · " }, { text: `${p.errors} error${p.errors === 1 ? "" : "s"}`, color: "error" });
      return line;
    }),
  ];
}
