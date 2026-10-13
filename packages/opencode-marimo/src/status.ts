// What the CLI half shows, as plain TypeScript over the server half's report so it can be tested
// without a terminal: the prompt-line segments and the sidebar lines.

import { basename } from "./core/io.ts";
import { elapsed, type StatusParts } from "./core/render.ts";
import type { NotebookReport, Report } from "./rpc.ts";

export interface View {
  parts?: StatusParts;
  /** Shown instead of parts (a pinned notebook not open). */
  note?: string;
}

function running(n: NotebookReport, now: number): StatusParts["running"] {
  if (!n.running || n.connection !== "connected") return undefined;
  return { section: n.running.section, cell: n.running.cell, elapsed: n.running.since !== undefined ? elapsed(now - n.running.since) : undefined };
}

/** The status parts of one notebook of the report; `others` names the rest. */
export function partsOf(n: NotebookReport, now: number, others: NotebookReport[] = []): StatusParts {
  const connected = n.connection === "connected";
  return {
    notebook: basename(n.path),
    connection: n.connection,
    running: running(n, now),
    queued: connected ? n.queued : 0,
    errors: connected ? n.errors : 0,
    others: others.map((o) => basename(o.path)),
  };
}

export function view(report: Report | undefined, now = Date.now()): View {
  if (!report || report.mode === "off") return {};
  const [first, ...rest] = report.notebooks;
  if (!first) return report.mode === "pinned" && report.pinned?.length ? { note: `${report.pinned.map(basename).join(", ")} not open` } : {};
  return { parts: partsOf(first, now, rest) };
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
 * The line beside the prompt, short because the footer's own parts share it:
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
export function sidebarLines(report: Report | undefined, now = Date.now()): Segment[][] | undefined {
  if (!report?.notebooks.length) return undefined;
  return [
    [{ text: "marimo", color: "accent" }],
    ...report.notebooks.map((n): Segment[] => {
      const name = basename(n.path);
      if (!n.current) return [{ text: `  ${name}` }];
      const p = partsOf(n, now);
      const line: Segment[] = [{ text: "▸ ", color: "warning" }, { text: name, color: "accent" }];
      if (p.connection !== "connected") line.push({ text: ` ${p.connection}`, color: "warning" });
      if (p.running) line.push({ text: ` · running ${shortSection(p.running.section, 18) || `cell ${p.running.cell}`}${p.running.elapsed ? ` ${p.running.elapsed}` : ""}` });
      if (p.errors) line.push({ text: " · " }, { text: `${p.errors} error${p.errors === 1 ? "" : "s"}`, color: "error" });
      return line;
    }),
  ];
}

/** Whether the elapsed time in the line needs ticking. */
export function ticking(report: Report | undefined): boolean {
  return report?.notebooks.some((n) => n.connection === "connected" && n.running?.since !== undefined) ?? false;
}
