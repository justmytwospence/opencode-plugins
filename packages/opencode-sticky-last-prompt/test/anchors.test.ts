import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test, vi } from "vitest";
import {
  type NodeLike,
  type ScrollLike,
  type UserAnchor,
  collapseWhitespace,
  collectAnchors,
  findTranscript,
  isScrollLike,
  jumpTarget,
  selectAnchor,
  showsPrompts,
} from "../src/anchors.ts";
vi.mock("@opencode/plugin/tui", () => ({ Plugin: { define: (p: unknown) => p } }));
const { parseLines } = await import("../src/tui.ts");

const anchor = (id: string, start: number, end: number): UserAnchor => ({ id, text: id, start, end });

describe("selectAnchor", () => {
  const anchors = [anchor("a", 0, 3), anchor("b", 10, 13), anchor("c", 20, 23)];

  test("pins the latest prompt fully above the viewport or under the bar", () => {
    expect(selectAnchor(anchors, 0, 1)).toBeUndefined();
    expect(selectAnchor(anchors, 1, 1)).toBeUndefined(); // a still crosses the top edge
    expect(selectAnchor(anchors, 2, 1)?.id).toBe("a"); // its last row is under the bar
    expect(selectAnchor(anchors, 3, 1)?.id).toBe("a");
    expect(selectAnchor(anchors, 9, 1)?.id).toBe("a");
    expect(selectAnchor(anchors, 10, 1)).toBeUndefined(); // b at the top, still visible
    expect(selectAnchor(anchors, 12, 1)?.id).toBe("b"); // b's last row is under the bar
    expect(selectAnchor(anchors, 12, 2)?.id).toBe("b");
    expect(selectAnchor(anchors, 11, 1)).toBeUndefined();
    expect(selectAnchor(anchors, 11, 2)?.id).toBe("b");
    expect(selectAnchor(anchors, 100, 1)?.id).toBe("c");
  });

  test("rejects bad offsets and empty input", () => {
    expect(selectAnchor(anchors, -1, 1)).toBeUndefined();
    expect(selectAnchor(anchors, Number.NaN, 1)).toBeUndefined();
    expect(selectAnchor([], 50, 1)).toBeUndefined();
  });

  test("a jump puts the prompt just below the bar", () => {
    expect(jumpTarget(anchor("b", 10, 13), 1)).toBe(9);
    expect(jumpTarget(anchor("a", 0, 3), 2)).toBe(0);
  });
});

describe("collectAnchors", () => {
  const scroll = (children: NodeLike[], scrollTop = 0, viewportY = 5): ScrollLike => ({
    scrollTop,
    viewport: { x: 0, y: viewportY, width: 80, height: 20 },
    content: {},
    getChildren: () => children,
    scrollTo: () => {},
  });
  const prompts = new Map([
    ["u1", "first  prompt\n  with lines"],
    ["u2", "second"],
    ["u3", "   "],
  ]);

  test("maps prompt rows to document rows, collapsing whitespace, in order", () => {
    const s = scroll(
      [
        { id: "u2", y: 35, height: 3 },
        { id: "a1", y: 5, height: 20 },
        { id: "u1", y: -10, height: 3 },
        { y: 60, height: 2 },
        { id: "u3", y: 70, height: 3 },
        { id: "u-hidden", y: 80, height: 3, visible: false },
      ],
      100,
    );
    expect(collectAnchors(s, prompts)).toEqual([
      { id: "u1", text: "first prompt with lines", start: 85, end: 88 },
      { id: "u2", text: "second", start: 130, end: 133 },
    ]);
  });

  test("skips rows without a position or height, and unknown scroll state", () => {
    expect(collectAnchors(scroll([{ id: "u1", height: 0, y: 1 }, { id: "u2", y: Number.NaN, height: 1 }]), prompts)).toEqual([]);
    expect(collectAnchors(scroll([{ id: "u1", height: 2, y: 1 }], Number.NaN), prompts)).toEqual([]);
  });

  test("collapseWhitespace", () => {
    expect(collapseWhitespace("  a\n\n b\t c ")).toBe("a b c");
  });
});

describe("finding the transcript", () => {
  const prompts = new Map([["u1", "hello"]]);
  const leaf = (id?: string): NodeLike => ({ id, getChildren: () => [] });
  const box = (children: NodeLike[], extra: Partial<NodeLike> = {}): NodeLike => ({ getChildren: () => children, ...extra });
  const scrollbox = (children: NodeLike[]): ScrollLike => ({
    scrollTop: 0,
    viewport: {},
    content: {},
    getChildren: () => children,
    scrollTo: () => {},
  });

  test("duck-types a scroll box", () => {
    expect(isScrollLike(scrollbox([]))).toBe(true);
    expect(isScrollLike(box([]))).toBe(false);
    expect(isScrollLike(null)).toBe(false);
    expect(showsPrompts(scrollbox([leaf("u1")]), prompts)).toBe(true);
    expect(showsPrompts(scrollbox([leaf("x")]), prompts)).toBe(false);
  });

  test("finds the scroll box holding a prompt row, skipping invisible subtrees and other boxes", () => {
    const transcript = scrollbox([leaf("a1"), leaf("u1")]);
    const other = scrollbox([leaf("x")]);
    const hidden = box([scrollbox([leaf("u1")])], { visible: false });
    const root = box([box([other]), hidden, box([box([transcript])])]);
    expect(findTranscript(root, prompts)).toBe(transcript);
    expect(findTranscript(box([other]), prompts)).toBeUndefined();
  });

  test("tolerates a node that throws while listing children", () => {
    const transcript = scrollbox([leaf("u1")]);
    const broken: NodeLike = {
      getChildren: () => {
        throw new Error("destroyed");
      },
    };
    expect(findTranscript(box([broken, transcript]), prompts)).toBe(transcript);
  });
});

describe("with a real ScrollBox", () => {
  test("rows report document positions through scrolling", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 10 });
    const outer = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    const header = new BoxRenderable(renderer, { height: 2, width: "100%" });
    const scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", stickyStart: "bottom", stickyScroll: true });
    outer.add(header);
    outer.add(scroll);
    renderer.root.add(outer);
    const prompts = new Map<string, string>();
    for (let i = 0; i < 4; i++) {
      const row = new BoxRenderable(renderer, { id: `u${i}`, height: 3, width: "100%", marginTop: 1, flexShrink: 0 });
      row.add(new TextRenderable(renderer, { content: `prompt ${i}` }));
      scroll.add(row);
      prompts.set(`u${i}`, `prompt ${i}`);
      const answer = new BoxRenderable(renderer, { id: `a${i}`, height: 6, width: "100%", flexShrink: 0 });
      scroll.add(answer);
    }
    await renderOnce();
    expect(findTranscript(renderer.root as unknown as NodeLike, prompts)).toBe(scroll);

    scroll.scrollTo(0);
    await renderOnce();
    let anchors = collectAnchors(scroll as unknown as ScrollLike, prompts);
    expect(anchors.map((a) => [a.id, a.start, a.end])).toEqual([
      ["u0", 1, 4],
      ["u1", 11, 14],
      ["u2", 21, 24],
      ["u3", 31, 34],
    ]);
    expect(selectAnchor(anchors, scroll.scrollTop, 1)).toBeUndefined();

    scroll.scrollTo(15);
    await renderOnce();
    anchors = collectAnchors(scroll as unknown as ScrollLike, prompts);
    expect(anchors[1]).toEqual({ id: "u1", text: "prompt 1", start: 11, end: 14 });
    expect(selectAnchor(anchors, scroll.scrollTop, 1)?.id).toBe("u1");

    scroll.scrollTo(jumpTarget(anchors[1], 1));
    await renderOnce();
    expect(scroll.scrollTop).toBe(10);
    expect(selectAnchor(collectAnchors(scroll as unknown as ScrollLike, prompts), scroll.scrollTop, 1)?.id).toBe("u0");
    renderer.destroy();
  });
});

describe("options", () => {
  test("lines is 1 to 3", () => {
    expect(parseLines(undefined)).toBe(1);
    expect(parseLines(2)).toBe(2);
    expect(parseLines("3")).toBe(3);
    expect(parseLines(9)).toBe(3);
    expect(parseLines(0)).toBe(1);
    expect(parseLines("x")).toBe(1);
  });
});
