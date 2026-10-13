// Which prompt to pin, from the live transcript. Derived from pi-sticky-last-prompt (MIT,
// pi-collections contributors), reshaped for OpenTUI: OpenCode's transcript is a ScrollBox whose
// direct children are message rows, and the row of a user prompt carries that message's id. A
// row's document position is its screen y relative to the viewport, plus the scroll offset.

/** The parts of a renderable this plugin reads. */
export interface NodeLike {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  isDestroyed?: boolean;
  parent?: NodeLike | null;
  getChildren?: () => NodeLike[];
}

/** The parts of OpenTUI's ScrollBoxRenderable this plugin reads. */
export interface ScrollLike extends NodeLike {
  scrollTop: number;
  viewport: NodeLike;
  content: NodeLike;
  getChildren: () => NodeLike[];
  scrollTo: (position: number) => void;
}

export interface UserAnchor {
  id: string;
  text: string;
  /** First document row of the prompt's row box. */
  start: number;
  /** Exclusive end in document rows. */
  end: number;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isScrollLike(value: unknown): value is ScrollLike {
  const s = value as Partial<ScrollLike> | null | undefined;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.scrollTop === "number" &&
    typeof s.scrollTo === "function" &&
    typeof s.getChildren === "function" &&
    !!s.viewport &&
    typeof s.viewport === "object" &&
    !!s.content &&
    typeof s.content === "object"
  );
}

/** Whether a scroll box shows this session's transcript: one of its rows is a known prompt. */
export function showsPrompts(scroll: ScrollLike, prompts: ReadonlyMap<string, string>): boolean {
  try {
    return scroll.getChildren().some((child) => !!child.id && prompts.has(child.id));
  } catch {
    return false;
  }
}

/** Breadth-first search for the transcript's scroll box under `root`. */
export function findTranscript(root: NodeLike, prompts: ReadonlyMap<string, string>, limit = 20000): ScrollLike | undefined {
  const queue: NodeLike[] = [root];
  let seen = 0;
  while (queue.length && seen++ < limit) {
    const node = queue.shift()!;
    if (isScrollLike(node)) {
      if (showsPrompts(node, prompts)) return node;
      continue; // Nothing of ours nests inside another scroll box.
    }
    if (node.visible === false) continue;
    try {
      const children = node.getChildren?.();
      if (children) queue.push(...children);
    } catch {
      // A renderable mid-destruction: skip it.
    }
  }
  return undefined;
}

/** Every mounted prompt row with its document rows, in document order. */
export function collectAnchors(scroll: ScrollLike, prompts: ReadonlyMap<string, string>): UserAnchor[] {
  const anchors: UserAnchor[] = [];
  const viewportY = scroll.viewport.y ?? 0;
  const scrollTop = scroll.scrollTop;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportY)) return anchors;
  for (const child of scroll.getChildren()) {
    if (!child.id || child.visible === false) continue;
    const prompt = prompts.get(child.id);
    if (prompt === undefined) continue;
    const text = collapseWhitespace(prompt);
    const height = child.height ?? 0;
    if (!text || !Number.isFinite(child.y) || height <= 0) continue;
    const start = scrollTop + (child.y as number) - viewportY;
    anchors.push({ id: child.id, text, start, end: start + height });
  }
  return anchors.sort((a, b) => a.start - b.start);
}

/**
 * The latest prompt that has scrolled completely out of view: above the viewport, or hidden under
 * the bar's own rows. A prompt still crossing that edge leaves the bar blank rather than pinning
 * an older one above it.
 */
export function selectAnchor(anchors: readonly UserAnchor[], scrollTop: number, barHeight: number): UserAnchor | undefined {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return undefined;
  let selected: UserAnchor | undefined;
  for (const anchor of anchors) if (anchor.start <= scrollTop) selected = anchor;
  return selected && selected.end <= scrollTop + barHeight ? selected : undefined;
}

/** The scroll offset that puts a prompt just below a bar of `barHeight` rows. */
export function jumpTarget(anchor: UserAnchor, barHeight: number): number {
  return Math.max(0, anchor.start - barHeight);
}
