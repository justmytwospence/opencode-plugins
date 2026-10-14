// Lay a parsed diff out as rows, one terminal line each: file headers, hunk headers, lines,
// notes, and the lines of each comment thread under the code it is on. Ported from
// pi-diff-review's model.ts in its unified layout; the panel is too narrow for a split view.

import { type DiffLine, type FileDiff, filePath, type Hunk } from "./parse.ts";
import type { Side, Thread } from "./threads.ts";

export type Row =
  | { kind: "file"; file: number }
  | { kind: "hunk"; file: number; hunk: number }
  | { kind: "line"; file: number; hunk: number; line: DiffLine; pair?: DiffLine }
  | { kind: "note"; file: number; text: string; expand?: boolean }
  | { kind: "thread"; file: number; thread: string; text: string; first: boolean; outdated: boolean; part: ThreadPart }
  | { kind: "blank"; file: number };

export type ThreadPart = "head" | "body" | "suggestion" | "reply";

export interface LayoutOptions {
  /** Files shown as their header only (by path). */
  folded: ReadonlySet<string>;
  /** Large files the user asked to show in full (by path). */
  expanded: ReadonlySet<string>;
  threads: readonly Thread[];
  /** Files with more diff lines than this start collapsed behind a note. */
  maxLines: number;
}

export interface Layout {
  rows: Row[];
  /** Index of each file's header row. */
  fileRows: number[];
  /** Threads on files that are not in this diff. */
  orphanStart?: number;
}

function hunkRows(fi: number, hi: number, h: Hunk): Row[] {
  const out: Row[] = [{ kind: "hunk", file: fi, hunk: hi }];
  const lines = h.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as DiffLine;
    if (l.kind === "context") {
      out.push({ kind: "line", file: fi, hunk: hi, line: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && (lines[i] as DiffLine).kind === "del") dels.push(lines[i++] as DiffLine);
    while (i < lines.length && (lines[i] as DiffLine).kind === "add") adds.push(lines[i++] as DiffLine);
    dels.forEach((d, k) => out.push({ kind: "line", file: fi, hunk: hi, line: d, pair: adds[k] }));
    adds.forEach((a, k) => out.push({ kind: "line", file: fi, hunk: hi, line: a, pair: dels[k] }));
  }
  return out;
}

/** The line a row shows on a side, if any. */
export function rowLineOn(row: Row, side: Side): DiffLine | undefined {
  if (row.kind !== "line") return undefined;
  const n = side === "new" ? row.line.newLine : row.line.oldLine;
  return n === undefined ? undefined : row.line;
}

function lineNo(l: DiffLine, side: Side): number | undefined {
  return side === "new" ? l.newLine : l.oldLine;
}

/** Where a thread sits among a file's rows: the row index to insert after, and whether it still matches. */
export function anchorThread(rows: Row[], from: number, to: number, t: Thread): { after: number; outdated: boolean } {
  if (t.start === 0) return { after: from, outdated: false };
  const want = t.excerpt[t.excerpt.length - 1]?.slice(2);
  let byNumber = -1;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let r = from; r < to; r++) {
    const l = rowLineOn(rows[r] as Row, t.side);
    if (!l) continue;
    const n = lineNo(l, t.side) ?? 0;
    if (n === t.end) {
      byNumber = r;
      if (want === undefined || l.text === want) return { after: r, outdated: false };
    }
    if (want !== undefined && l.text === want) {
      const d = Math.abs(n - t.end);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
  }
  if (best >= 0) return { after: best, outdated: false };
  if (byNumber >= 0) return { after: byNumber, outdated: true };
  return { after: from, outdated: true };
}

/** A thread's status and place, for its first row. */
export function threadTitle(t: Thread, outdated: boolean): string {
  const kind = t.suggestion !== undefined ? "suggestion" : "comment";
  const where = t.start === 0 ? "on the file" : t.start === t.end ? `L${t.start}` : `L${t.start}-${t.end}`;
  const side = t.side === "old" && t.start !== 0 ? " (removed)" : "";
  return `${kind} ${t.id} · ${t.status} · ${where}${side}${outdated ? " · outdated" : ""}`;
}

/** The rows of one thread: its title, body, suggestion and reply, one line each. */
export function threadRows(fi: number, t: Thread, outdated: boolean): Row[] {
  const out: Row[] = [{ kind: "thread", file: fi, thread: t.id, text: threadTitle(t, outdated), first: true, outdated, part: "head" }];
  const push = (part: ThreadPart, text: string) => {
    for (const line of text.replace(/\s+$/u, "").split("\n")) out.push({ kind: "thread", file: fi, thread: t.id, text: line, first: false, outdated, part });
  };
  if (t.suggestion !== undefined) push("suggestion", t.suggestion.length ? t.suggestion : "(delete these lines)");
  if (t.body.trim()) push("body", t.body.trim());
  if (t.reply) push("reply", t.reply);
  return out;
}

export function layout(files: readonly FileDiff[], opts: LayoutOptions): Layout {
  const rows: Row[] = [];
  const fileRows: number[] = [];
  const byFile = new Map<string, Thread[]>();
  for (const t of opts.threads) {
    const list = byFile.get(t.file) ?? [];
    list.push(t);
    byFile.set(t.file, list);
  }
  const placed = new Set<string>();

  files.forEach((f, fi) => {
    const path = filePath(f);
    fileRows.push(rows.length);
    rows.push({ kind: "file", file: fi });
    if (opts.folded.has(path)) {
      for (const t of byFile.get(path) ?? []) placed.add(t.id);
      return;
    }
    const body: Row[] = [];
    const total = f.hunks.reduce((s, h) => s + h.lines.length, 0);
    if (f.binary) body.push({ kind: "note", file: fi, text: "binary file" });
    else if (f.hunks.length === 0) {
      if (f.status === "renamed") body.push({ kind: "note", file: fi, text: `renamed from ${f.oldPath}, contents unchanged` });
      else if (f.oldMode && f.newMode) body.push({ kind: "note", file: fi, text: `mode ${f.oldMode} -> ${f.newMode}` });
      else body.push({ kind: "note", file: fi, text: f.status === "added" ? "empty file" : "no textual changes" });
    } else if (total > opts.maxLines && !opts.expanded.has(path)) {
      body.push({ kind: "note", file: fi, text: `${total} diff lines hidden; Enter shows them`, expand: true });
    } else {
      f.hunks.forEach((h, hi) => body.push(...hunkRows(fi, hi, h)));
    }
    if (f.status === "renamed" && f.hunks.length > 0) body.unshift({ kind: "note", file: fi, text: `renamed from ${f.oldPath}` });

    // Insert threads after their anchor rows (indices relative to `body`, with the header at -1).
    const threads = (byFile.get(path) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const inserts = new Map<number, Row[]>();
    for (const t of threads) {
      const a = anchorThread(body, 0, body.length, t);
      const after = t.start === 0 ? -1 : a.after;
      const list = inserts.get(after) ?? [];
      list.push(...threadRows(fi, t, a.outdated));
      inserts.set(after, list);
      placed.add(t.id);
    }
    rows.push(...(inserts.get(-1) ?? []));
    body.forEach((r, k) => {
      rows.push(r);
      rows.push(...(inserts.get(k) ?? []));
    });
    rows.push({ kind: "blank", file: fi });
  });

  const orphans = opts.threads.filter((t) => !placed.has(t.id));
  let orphanStart: number | undefined;
  if (orphans.length) {
    orphanStart = rows.length;
    rows.push({ kind: "note", file: -1, text: "Comments on files not in this diff" });
    for (const t of orphans) rows.push(...threadRows(-1, t, true));
  }
  return { rows, fileRows, orphanStart };
}

export interface Selection {
  file: number;
  side: Side;
  start: number;
  end: number;
  excerpt: string[];
}

function marker(l: DiffLine): string {
  return l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ";
}

/**
 * The lines a comment covers, from a span of rows in one file. Comments anchor on the new side
 * when the span has any current line, else on the removed lines.
 */
export function selectionFromRows(rows: readonly Row[], from: number, to: number): Selection | undefined {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const file = rows[lo]?.file;
  if (file === undefined || file < 0) return undefined;
  const lines: DiffLine[] = [];
  for (let r = lo; r <= hi; r++) {
    const row = rows[r] as Row;
    if (row.file !== file) continue;
    if (row.kind === "line") lines.push(row.line);
  }
  if (lines.length === 0) return undefined;
  const side: Side = lines.some((l) => l.newLine !== undefined) ? "new" : "old";
  const nums = lines.map((l) => (side === "new" ? l.newLine : l.oldLine)).filter((n): n is number => n !== undefined);
  return {
    file,
    side,
    start: Math.min(...nums),
    end: Math.max(...nums),
    excerpt: lines.map((l) => marker(l) + l.text),
  };
}

/** The rows of the hunk a hunk header starts (its lines and the threads under them). */
export function hunkSpan(rows: readonly Row[], header: number): [number, number] | undefined {
  const h = rows[header];
  if (h?.kind !== "hunk") return undefined;
  let end = header + 1;
  while (end < rows.length) {
    const r = rows[end] as Row;
    if (r.file !== h.file || (r.kind !== "line" && r.kind !== "thread")) break;
    end++;
  }
  return end > header + 1 ? [header + 1, end - 1] : undefined;
}

/** The next (or previous) row of a kind after `from`, wrapping nowhere. */
export function nextOfKind(rows: readonly Row[], from: number, kind: "file" | "hunk", delta: 1 | -1): number | undefined {
  for (let r = from + delta; r >= 0 && r < rows.length; r += delta) {
    if ((rows[r] as Row).kind === kind) return r;
  }
  return undefined;
}

/** The first row of the thread at `row`, if the row belongs to one. */
export function threadAt(rows: readonly Row[], row: number): string | undefined {
  const r = rows[row];
  return r?.kind === "thread" ? r.thread : undefined;
}
