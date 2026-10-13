// Class and ER diagrams as Unicode box-drawing art, through grok-mermaid, as a Markdown code-block
// renderer for the dialect labels OpenCode's built-in mermaid renderer does not draw (see
// transform.ts for how fences are routed to it).

import type { MarkdownCodeBlockRenderer, RenderContext, Renderable, TextChunk } from "@opentui/core";
import type { MermaidArt } from "grok-mermaid";
import { OWN_DIALECTS, headerOf } from "./transform.ts";

export interface MermaidModule {
  render(src: string): MermaidArt | null;
}

let mermaid: MermaidModule | null = null;
let loading: Promise<MermaidModule | null> | undefined;

/** Load grok-mermaid once. Until it resolves (or if it cannot), diagram fences stay code blocks. */
export function loadMermaid(): Promise<MermaidModule | null> {
  if (mermaid) return Promise.resolve(mermaid);
  loading ??= import("grok-mermaid")
    .then((m) => (mermaid = m as MermaidModule))
    .catch(() => (mermaid = null));
  return loading;
}

/** Test hook: inject or clear the renderer without importing it. */
export function setMermaid(module: MermaidModule | null): void {
  mermaid = module;
  loading = undefined;
  ART_CACHE.clear();
}

/** The source grok-mermaid parses: the fence body with the dialect header added when missing. */
export function diagramSource(language: string, text: string): string {
  const header = OWN_DIALECTS[language.toLowerCase()];
  if (!header) return text;
  const lines = text.split("\n");
  const first = headerOf(lines, 0, lines.length);
  return first && first.toLowerCase().startsWith(header.toLowerCase()) ? text : `${header}\n${text}`;
}

// Streaming and resizes render the same source repeatedly; cache art by source with a fixed cap.
const ART_CACHE = new Map<string, MermaidArt | null>();
const ART_CACHE_MAX = 50;

export function getArt(module: MermaidModule, src: string): MermaidArt | null {
  const cached = ART_CACHE.get(src);
  if (cached !== undefined) return cached;
  let art: MermaidArt | null = null;
  try {
    art = module.render(src);
  } catch {
    art = null;
  }
  if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
  ART_CACHE.set(src, art);
  return art;
}

export interface DiagramColors {
  border: unknown;
  text: unknown;
  edge: unknown;
  edgeLabel: unknown;
  title: unknown;
}

export type ChunkFactory = (text: string, color: unknown) => TextChunk;
export type TextFactory = (ctx: RenderContext, chunks: TextChunk[], height: number) => Renderable;

/** The art's rows as styled chunks, one per semantic run, rows joined by newlines. */
export function chunksFor(art: MermaidArt, colors: DiagramColors, chunk: ChunkFactory): TextChunk[] {
  const chunks: TextChunk[] = [];
  art.styled.forEach((row, index) => {
    for (const span of row) {
      if (!span.text) continue;
      const color = span.cls === "none" ? colors.text : colors[span.cls];
      chunks.push(chunk(span.text, color));
    }
    if (index < art.styled.length - 1) chunks.push(chunk("\n", colors.text));
  });
  return chunks;
}

/**
 * The code-block renderer. Returns nothing (the default code block) until grok-mermaid is loaded,
 * when it cannot draw the source, or when the art is wider than `width()` columns.
 */
export function createDiagramRenderer(input: {
  ctx: RenderContext;
  width: () => number;
  colors: () => DiagramColors;
  chunk: ChunkFactory;
  text: TextFactory;
}): MarkdownCodeBlockRenderer {
  return (token) => {
    const module = mermaid;
    if (!module) return undefined;
    const language = (token.lang ?? "").trim().split(/\s+/, 1)[0];
    const art = getArt(module, diagramSource(language, token.text));
    if (!art || art.plain.length === 0 || art.width > input.width()) return undefined;
    return input.text(input.ctx, chunksFor(art, input.colors(), input.chunk), art.plain.length);
  };
}
