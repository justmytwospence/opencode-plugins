// What the review panel shows, as plain data: each row as colored segments, the header and the
// key hints. tui.ts turns segments into OpenTUI elements with the theme's colors.

import type { Row } from "./model.ts";
import { type FileDiff, filePath } from "./parse.ts";
import type { Thread } from "./threads.ts";

export type Color = "base" | "muted" | "accent" | "success" | "warning" | "error" | "info";

export interface Segment {
  text: string;
  color: Color;
  bold?: boolean;
}

export interface RowState {
  cursor: boolean;
  selected: boolean;
  folded: boolean;
}

/** Width of the line-number column for these files. */
export function numberWidth(files: readonly FileDiff[]): number {
  let max = 1;
  for (const f of files) for (const h of f.hunks) max = Math.max(max, h.oldStart + h.oldCount, h.newStart + h.newCount);
  return String(max).length;
}

function num(n: number | undefined, width: number): string {
  return n === undefined ? " ".repeat(width) : String(n).padStart(width);
}

export function fileLabel(f: FileDiff): string {
  const path = filePath(f);
  const status = f.status === "modified" ? "" : ` ${f.status}`;
  const counts = f.binary ? " binary" : ` +${f.additions} -${f.deletions}`;
  return `${path}${status}${counts}`;
}

function statusColor(status: Thread["status"]): Color {
  switch (status) {
    case "draft":
      return "warning";
    case "answered":
      return "success";
    case "sent":
      return "info";
    default:
      return "muted";
  }
}

/** One row as segments; `threads` resolves thread rows to their status color. */
export function paintRow(row: Row, files: readonly FileDiff[], state: RowState, numWidth: number, threads: ReadonlyMap<string, Thread>): Segment[] {
  const gutter: Segment = { text: state.cursor ? "▌" : state.selected ? "▏" : " ", color: state.cursor ? "accent" : "info" };
  const pad = " ".repeat(numWidth);
  switch (row.kind) {
    case "file": {
      const f = files[row.file];
      return [gutter, { text: `${state.folded ? "▸" : "▾"} ${f ? fileLabel(f) : "?"}`, color: "accent", bold: true }];
    }
    case "hunk": {
      const h = files[row.file]?.hunks[row.hunk];
      const text = h ? `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.section ? ` ${h.section}` : ""}` : "@@";
      return [gutter, { text: `${pad} ${text}`, color: "info" }];
    }
    case "line": {
      const l = row.line;
      const color: Color = l.kind === "add" ? "success" : l.kind === "del" ? "error" : "base";
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      const n = l.kind === "del" ? l.oldLine : (l.newLine ?? l.oldLine);
      return [
        gutter,
        { text: `${num(n, numWidth)} `, color: "muted" },
        { text: `${sign} ${l.text.replace(/\t/g, "    ")}${l.noNewline ? " ⏎" : ""}`, color },
      ];
    }
    case "note":
      return [gutter, { text: `${pad} ${row.text}`, color: "muted" }];
    case "thread": {
      const t = threads.get(row.thread);
      const color = t ? statusColor(t.status) : "muted";
      if (row.first) return [gutter, { text: `${pad} ┌ ${row.text}`, color, bold: true }];
      const lead = row.part === "suggestion" ? "│ + " : row.part === "reply" ? "│ ↳ " : "│   ";
      const textColor: Color = row.part === "suggestion" ? "success" : row.part === "reply" ? "muted" : "base";
      return [gutter, { text: `${pad} `, color }, { text: lead, color }, { text: row.text, color: textColor }];
    }
    case "blank":
      return [gutter];
  }
}

/** `3 files · +12 -4 · 2 drafts`: the panel's summary line. */
export function summary(files: readonly FileDiff[], threads: readonly Thread[]): string {
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const bits = [`${files.length} file${files.length === 1 ? "" : "s"}`, `+${add} -${del}`];
  const drafts = threads.filter((t) => t.status === "draft").length;
  const sent = threads.filter((t) => t.status === "sent").length;
  if (drafts) bits.push(`${drafts} draft${drafts === 1 ? "" : "s"}`);
  if (sent) bits.push(`${sent} awaiting a reply`);
  return bits.join(" · ");
}

export const HINTS = "j/k move · ] [ hunk · } { file · v select · c comment · s suggest · l list · w send · S scope · m mark · ? keys";

export const KEYS: readonly [string, string][] = [
  ["j / k, up / down", "move one row"],
  ["ctrl+d / ctrl+u", "half a page down / up"],
  ["g / G", "first / last row"],
  ["] / [", "next / previous hunk"],
  ["} / {", "next / previous file"],
  ["enter", "fold or unfold the file; show a large file"],
  ["v", "start or end a line selection"],
  ["c", "comment on the line, the selection, a hunk header or a file header"],
  ["s", "suggest a replacement for the line or the selection"],
  ["e / x", "edit / delete the comment under the cursor"],
  ["l", "list the comments: enter jumps, e edits, x deletes"],
  ["w / W", "send the drafts to the agent (W also closes)"],
  ["S", "pick the scope: unreviewed, last turn, session, uncommitted, branch"],
  ["m", "mark this scope reviewed (unreviewed then starts after it)"],
  ["r", "reload the diff"],
  ["f", "toggle full screen"],
  ["q / esc", "close (drafts are kept)"],
];
