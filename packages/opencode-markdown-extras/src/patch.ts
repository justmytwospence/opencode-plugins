// The patch on OpenTUI's MarkdownRenderable, the component OpenCode draws every message with.
//
// Its `content` is parsed into blocks by `updateBlocks`, which every content, streaming or style
// change goes through. This wraps that method once per process and swaps the content for its
// transformed form (transform.ts) before the original parses it, caching the result per instance
// so unchanged content costs nothing. The wrapper calls whatever `updateBlocks` was installed
// before it (opencode-prose-width wraps the same method), so the two compose in either order.

const STATE = Symbol.for("opencode-markdown-extras");
const RAW = Symbol.for("opencode-markdown-extras.raw");
const OUT = Symbol.for("opencode-markdown-extras.out");

export type Transform = (markdown: string) => string;

export type MarkdownLike = {
  _content?: string;
  [RAW]?: string;
  [OUT]?: string;
};

export interface State {
  enabled: boolean;
  transform: Transform;
}

type Proto = Record<string | symbol, unknown> & { [STATE]?: State };

/** Transforms `self._content` in place, once per distinct content. Returns whether it changed. */
export function apply(self: MarkdownLike, state: State): boolean {
  const content = self._content;
  if (!state.enabled || typeof content !== "string" || !content) return false;
  // Already the transformed form of the last content: nothing to do.
  if (content === self[OUT]) return false;
  const out = state.transform(content);
  self[RAW] = content;
  self[OUT] = out;
  if (out === content) return false;
  self._content = out;
  return true;
}

/**
 * Patches the class once per process (a reload only swaps the transform). Wraps `updateBlocks`
 * rather than the `content` setter because the constructor assigns `_content` directly before its
 * first `updateBlocks`.
 */
export function install(proto: Proto, transform: Transform): State {
  const existing = proto[STATE];
  if (existing) {
    existing.transform = transform;
    existing.enabled = true;
    return existing;
  }
  const updateBlocks = proto.updateBlocks;
  if (typeof updateBlocks !== "function") throw new Error("opentui's MarkdownRenderable has no updateBlocks to patch");
  const state: State = { enabled: true, transform };
  proto.updateBlocks = function (this: MarkdownLike, ...args: unknown[]) {
    apply(this, state);
    return updateBlocks.apply(this, args);
  };
  proto[STATE] = state;
  return state;
}
