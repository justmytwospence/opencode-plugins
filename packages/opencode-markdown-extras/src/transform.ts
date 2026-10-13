// Text transforms applied to a message's Markdown before OpenTUI parses it (patch.ts). Ported
// from pi-markdown-extras, itself from pi-cc-extensions (MIT, minuque). Everything here is pure
// and display-only: the stored message and the model context never change.

// ----------------------------------------------------------------------------
// Fences
// ----------------------------------------------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface FenceInfo {
  /** Index of the opening fence line. */
  open: number;
  /** Index of the closing fence line, or -1 while the fence is still open. */
  close: number;
  /** The info string after the fence marker, trimmed. */
  info: string;
}

/**
 * Finds every fenced code block: the lines inside it (fence lines included) must not be touched by
 * prose transforms. A fence closes on a line of the same marker character at least as long as the
 * opening one; an unclosed fence runs to the end.
 */
export function findFences(lines: string[]): FenceInfo[] {
  const fences: FenceInfo[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open) {
      i++;
      continue;
    }
    const marker = open[1];
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    fences.push({ open: i, close: j < lines.length ? j : -1, info: open[2].trim() });
    i = j + 1;
  }
  return fences;
}

/** `true` for every line that belongs to a fenced block, fence lines included. */
export function fenceMask(lines: string[], fences = findFences(lines)): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  for (const fence of fences) {
    const end = fence.close === -1 ? lines.length - 1 : fence.close;
    for (let i = fence.open; i <= end; i++) mask[i] = true;
  }
  return mask;
}

// ----------------------------------------------------------------------------
// Diagram fences
// ----------------------------------------------------------------------------

// OpenCode's built-in `opencode.merman` plugin draws ```mermaid fences for flowchart, sequence,
// state, gantt, gitGraph and timeline diagrams. Dialect fences it would show as source are
// re-labelled: state and sequence become ```mermaid with their header line so the built-in draws
// them; class and ER diagrams, which the built-in does not draw, get a dialect label that this
// plugin's own grok-mermaid renderer is registered for (diagram.ts), also when they arrive as a
// ```mermaid fence.

/** Dialect labels drawn by this plugin's renderer, with the header grok-mermaid expects. */
export const OWN_DIALECTS: Readonly<Record<string, string>> = {
  classdiagram: "classDiagram",
  "classdiagram-v2": "classDiagram",
  erdiagram: "erDiagram",
};

/** Dialect labels handed to OpenCode's built-in mermaid renderer, with the header it expects. */
export const BUILTIN_DIALECTS: Readonly<Record<string, string>> = {
  statediagram: "stateDiagram-v2",
  "statediagram-v2": "stateDiagram-v2",
  sequencediagram: "sequenceDiagram",
};

/** The header keyword that opens a diagram body (`classDiagram`, `erDiagram`, ...), if any. */
export function headerOf(lines: string[], from: number, to: number): string | undefined {
  for (let i = from; i < to; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    return line.split(/\s+/, 1)[0];
  }
  return undefined;
}

/** `info` of a fence as the lowercase language word, or "" without one. */
function languageOf(info: string): string {
  return info.split(/\s+/, 1)[0].toLowerCase();
}

export function routeDiagramFences(markdown: string): string {
  const lines = markdown.split("\n");
  const fences = findFences(lines);
  if (!fences.some((f) => /^(mermaid|[a-z]+diagram(-v2)?)$/i.test(languageOf(f.info)))) return markdown;
  const out: string[] = [];
  let next = 0;
  for (const fence of fences) {
    const language = languageOf(fence.info);
    const end = fence.close === -1 ? lines.length : fence.close;
    const header = headerOf(lines, fence.open + 1, end);
    const marker = lines[fence.open].match(FENCE_OPEN)![1];
    const indent = lines[fence.open].match(/^ */)![0];
    let label: string | undefined;
    let inject: string | undefined;
    if (language === "mermaid") {
      const kind = header?.toLowerCase();
      if (kind === "classdiagram" || kind === "classdiagram-v2") label = "classdiagram";
      else if (kind === "erdiagram") label = "erdiagram";
    } else if (Object.hasOwn(BUILTIN_DIALECTS, language)) {
      label = "mermaid";
      if (header?.toLowerCase() !== BUILTIN_DIALECTS[language].toLowerCase()) inject = BUILTIN_DIALECTS[language];
    }
    if (!label) continue;
    out.push(...lines.slice(next, fence.open), `${indent}${marker}${label}`);
    if (inject) out.push(inject);
    next = fence.open + 1;
  }
  out.push(...lines.slice(next));
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// GitHub admonitions
// ----------------------------------------------------------------------------

const ADMONITION = /^>\s*\[\s*!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*\]\s*(.*)$/i;
const ADMONITION_LABEL: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/**
 * Turn `> [!TYPE]` and the `>` lines that follow it into a quote with a bold label. Multi-line
 * bodies are joined into one line. Returns null when the line is not an admonition.
 */
function renderAdmonition(lines: string[], i: number): { output: string[]; next: number } | null {
  const m = lines[i].match(ADMONITION);
  if (!m) return null;
  const label = ADMONITION_LABEL[m[1].toUpperCase()];
  const body: string[] = [m[2]];
  let j = i + 1;
  while (j < lines.length && /^>\s?/.test(lines[j]) && !ADMONITION.test(lines[j])) {
    body.push(lines[j].replace(/^>\s?/, ""));
    j++;
  }
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const content = body.join(" ").trim();
  return {
    output: [`> **${label}:**${content ? ` ${content}` : ""}`, ""],
    next: j,
  };
}

/** Admonitions outside fenced code become labelled quotes. */
export function renderAdmonitions(markdown: string): string {
  if (!/^>\s*\[\s*!/im.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  const fenced = fenceMask(lines);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!fenced[i] && /^>\s*\[\s*!/i.test(lines[i])) {
      const result = renderAdmonition(lines, i);
      if (result) {
        out.push(...result.output);
        i = result.next;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// Circled numbers
// ----------------------------------------------------------------------------

// Nerd Font patches draw U+2460..U+2473 wider than one cell, so they overlap the next character
// on some renderers. "(n)" has the same width in every font.
const CIRCLED_RE = /[\u2460-\u2473]/g;

export function deCircled(markdown: string): string {
  return markdown.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
}

// ----------------------------------------------------------------------------
// Multi-line link labels
// ----------------------------------------------------------------------------

const MULTILINE_LINK_RE = /\[([^\]\n]*(?:\n[^\]\n]*)+)\](?=\()/g;

/** Join link labels that span lines, so a hard-wrapped label reads and links as one. */
export function normalizeMultilineLinks(markdown: string): string {
  if (!markdown.includes("](")) return markdown;
  const lines = markdown.split("\n");
  const fenced = fenceMask(lines);
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length === 0) return;
    out.push(
      prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
        const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
        return `[${normalized}]`;
      }),
    );
    prose = [];
  };
  lines.forEach((line, i) => {
    if (fenced[i]) {
      flush();
      out.push(line);
    } else {
      prose.push(line);
    }
  });
  flush();
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// All of them
// ----------------------------------------------------------------------------

export function transform(markdown: string): string {
  if (!markdown) return markdown;
  markdown = normalizeMultilineLinks(markdown);
  markdown = deCircled(markdown);
  markdown = routeDiagramFences(markdown);
  return renderAdmonitions(markdown);
}
