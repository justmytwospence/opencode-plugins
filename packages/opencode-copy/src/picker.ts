// The /yank picker's rows and filter, OpenCode-free: one select option per piece (the piece on
// one line, its kind and age in the footer), the fuzzy filter typed text goes through, and the
// toast after a copy. tui.ts puts them in OpenCode's select dialog.
import { type Segment, preview } from "./segments.ts";

export type Tab = "suggested" | "all";
export type Ranking = "pending" | "done" | "unavailable";

export const BADGE: Record<Segment["kind"], string> = {
  user: "you",
  assistant: "reply",
  section: "sect",
  code: "code",
  command: "cmd",
  snippet: "snip",
  path: "path",
  url: "url",
  table: "table",
  list: "list",
  quote: "quote",
  commit: "commit",
  paragraph: "text",
};

export interface Row {
  title: string;
  value: string;
  footer: string;
}

/** How many user turns ago the piece is: `now` for the current turn. */
export function ageText(segment: Segment, lastTurn: number): string {
  const age = lastTurn - segment.turn;
  return age <= 0 ? "now" : `${age}t ago`;
}

/** The select option for a piece: its text (the host truncates it), the kind and age in the footer. */
export function rowFor(segment: Segment, lastTurn: number): Row {
  return { title: preview(segment) || `(${segment.kind})`, value: segment.id, footer: `${BADGE[segment.kind]} · ${ageText(segment, lastTurn)}` };
}

/** The dialog's title: the tab and, on Suggested, how the order was made. */
export function dialogTitle(tab: Tab, ranking: Ranking, count: number): string {
  const where = tab === "suggested" ? (ranking === "pending" ? "suggested · ranking…" : ranking === "done" ? "suggested" : "suggested (by recency)") : "all";
  return `Copy from this session · ${where} · ${count}`;
}

/** The toast after a copy: what kind of piece, how long. */
export function copiedMessage(segment: Segment): string {
  const lines = segment.text.split("\n").length;
  const what = segment.kind === "code" && segment.lang ? `${segment.lang} code` : segment.kind;
  return `Copied ${what} (${lines} line${lines === 1 ? "" : "s"}, ${segment.text.length} chars)`;
}

/**
 * Match `query` against `text`: every character of the query in order, scored lower for gaps
 * and for matches away from the start, higher (negative) for consecutive characters and word
 * starts. Undefined when the query is not in the text.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return undefined;
    if (i === last + 1) score -= 5;
    else if (last >= 0) score += Math.min(20, (i - last - 1) * 2);
    if (i === 0 || /[\s\-_./:`"'(]/.test(t[i - 1] as string)) score -= 10;
    score += i * 0.1;
    last = i;
    from = i + 1;
  }
  if (q === t) score -= 100;
  return score;
}

/** Items every whitespace-separated token of `query` matches, best first; all items for an empty query. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...items];
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const haystack = text(item);
    let total = 0;
    let all = true;
    for (const token of tokens) {
      const s = fuzzyScore(token, haystack);
      if (s === undefined) {
        all = false;
        break;
      }
      total += s;
    }
    if (all) scored.push({ item, score: total });
  }
  return scored.sort((a, b) => a.score - b.score).map((x) => x.item);
}
