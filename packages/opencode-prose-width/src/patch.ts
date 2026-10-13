// The patch on opentui's MarkdownRenderable, the component opencode draws every message with.
//
// MarkdownRenderable keeps one child renderable per block (`_blockStates`): in
// opencode's "top-level" mode one per paragraph, heading, list, quote, code block
// or table. After it builds or updates its blocks, this caps the width of each
// prose block at the measure (yoga's maxWidth); code blocks, tables and rules keep
// the full width. A list or quote holding a table, or a code line longer than the
// measure, keeps the full width too.

export const DEFAULT_MEASURE = 80;
const STATE = Symbol.for("opencode-prose-width");

type Token = { type: string; raw?: string; text?: string; tokens?: Token[]; items?: Token[] };
const CAP = Symbol.for("opencode-prose-width.cap");
type Sized = { maxWidth?: number | string | null; [CAP]?: number };
type BlockState = { token: Token; renderable: Sized };
export type MarkdownLike = {
  _blockStates?: BlockState[];
  requestRender?: () => void;
};

export interface State {
  measure: number;
  /** Every patched instance alive, so a new measure reaches the ones already drawn. */
  live: Set<MarkdownLike>;
}

type Proto = Record<string | symbol, unknown> & { [STATE]?: State };

const PROSE = new Set(["paragraph", "heading", "text", "list", "blockquote"]);
const FENCED = /^\s*(`{3,}|~{3,})/;

export function parseMeasure(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "off" || value === false) return 0;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Whether a prose token holds preformatted content that must not be squeezed to the measure. */
export function holdsWideContent(token: Token, measure: number): boolean {
  if (token.type === "table") return true;
  if (token.type === "code") return (token.text ?? "").split("\n").some((line) => line.length > measure - 4);
  const children = [...(token.tokens ?? []), ...(token.items ?? [])];
  if (children.length) return children.some((child) => holdsWideContent(child, measure));
  // A block opentui coalesced from raw markdown carries no child tokens: look at its fences.
  const raw = token.raw ?? "";
  if (!/^\s*(`{3,}|~{3,})/m.test(raw) && !/^\s*\|.*\|\s*$/m.test(raw)) return false;
  let inFence = false;
  for (const line of raw.split("\n")) {
    if (FENCED.test(line)) inFence = !inFence;
    else if (inFence && line.length > measure) return true;
    else if (!inFence && /^\s*\|.*\|\s*$/.test(line)) return true;
  }
  return false;
}

export function widthFor(token: Token, measure: number): number | undefined {
  if (!measure || !PROSE.has(token.type) || holdsWideContent(token, measure)) return undefined;
  return measure;
}

function apply(self: MarkdownLike, state: State): void {
  const blocks = self._blockStates;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block?.renderable || !block.token) continue;
    const width = widthFor(block.token, state.measure);
    // Renderable has no maxWidth getter, so the cap set last is kept beside it. Set only on a
    // change, since each assignment marks the layout dirty; a cap is lifted with "100%".
    const current = block.renderable[CAP];
    if (current === width) continue;
    block.renderable.maxWidth = width ?? "100%";
    block.renderable[CAP] = width;
  }
}

/**
 * Patches the class once per process (a reload only updates the measure). Wraps
 * `updateBlocks`, which every content, streaming, table or style change goes through.
 */
export function install(proto: Proto, measure: number): State {
  const existing = proto[STATE];
  if (existing) {
    setMeasure(existing, measure);
    return existing;
  }
  const updateBlocks = proto.updateBlocks;
  const destroySelf = proto.destroySelf;
  if (typeof updateBlocks !== "function") throw new Error("opentui's MarkdownRenderable has no updateBlocks to patch");
  const state: State = { measure, live: new Set() };
  proto.updateBlocks = function (this: MarkdownLike, ...args: unknown[]) {
    const result = updateBlocks.apply(this, args);
    state.live.add(this);
    apply(this, state);
    return result;
  };
  if (typeof destroySelf === "function") {
    proto.destroySelf = function (this: MarkdownLike, ...args: unknown[]) {
      state.live.delete(this);
      return destroySelf.apply(this, args);
    };
  }
  proto[STATE] = state;
  return state;
}

export function setMeasure(state: State, measure: number): void {
  if (state.measure === measure) return;
  state.measure = measure;
  for (const self of state.live) {
    apply(self, state);
    self.requestRender?.();
  }
}
