import { MarkdownRenderable, StyledText, SyntaxStyle, TextRenderable, createMarkdownCodeBlockRenderer, fg } from "@opentui/core";
import type { RenderContext, TextChunk } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDiagramRenderer, diagramSource, loadMermaid, setMermaid } from "../src/diagram.ts";
import { apply, install } from "../src/patch.ts";
import { transform } from "../src/transform.ts";

const proto = MarkdownRenderable.prototype as never;

async function draw(content: string, options: Partial<ConstructorParameters<typeof MarkdownRenderable>[1]> = {}) {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 40 });
  const md = new MarkdownRenderable(renderer, {
    content,
    syntaxStyle: SyntaxStyle.create(),
    internalBlockMode: "top-level",
    width: "100%",
    ...options,
  });
  renderer.root.add(md);
  await renderOnce();
  // Quote and paragraph text is drawn once tree-sitter has highlighted it, a little later.
  const until = async (text: string) => {
    for (let i = 0; i < 40 && !captureCharFrame().includes(text); i++) {
      await new Promise((r) => setTimeout(r, 100));
      await renderOnce();
    }
    return captureCharFrame();
  };
  return { renderer, renderOnce, md, frame: () => captureCharFrame(), until };
}

describe("apply", () => {
  test("transforms once per distinct content and leaves plain text alone", () => {
    let calls = 0;
    const state = { enabled: true, transform: (s: string) => (calls++, transform(s)) };
    const self = { _content: "> [!NOTE] hi" };
    expect(apply(self, state)).toBe(true);
    expect(self._content).toBe("> **Note:** hi\n");
    expect(apply(self, state)).toBe(false);
    expect(calls).toBe(1);
    self._content = "plain";
    expect(apply(self, state)).toBe(false);
    expect(self._content).toBe("plain");
    self._content = "";
    expect(apply(self, state)).toBe(false);
  });

  test("does nothing while disabled", () => {
    const self = { _content: "> [!NOTE] hi" };
    expect(apply(self, { enabled: false, transform })).toBe(false);
    expect(self._content).toBe("> [!NOTE] hi");
  });
});

describe("drawn", () => {
  const state = install(proto, transform);
  afterEach(() => {
    state.enabled = true;
  });

  test("an admonition draws as a labelled quote, also after the content changes", async () => {
    const { renderer, md, frame, until } = await draw("> [!WARNING]\n> The cache is cleared\n> on every restart.\n\nafter");
    expect(await until("Warning: The cache is cleared on every restart.")).toContain("Warning: The cache is cleared on every restart.");
    expect(frame()).not.toContain("[!WARNING]");
    md.content = "> [!TIP] second \u2460";
    expect(await until("Tip: second (1)")).toContain("Tip: second (1)");
    expect(frame()).not.toContain("Warning");
    renderer.destroy();
  });

  test("the host's own content survives a streaming toggle and a disabled patch", async () => {
    const { renderer, md, frame, until } = await draw("> [!NOTE] streaming", { streaming: true });
    expect(await until("Note: streaming")).toContain("Note: streaming");
    md.streaming = false;
    expect(await until("Note: streaming")).toContain("Note: streaming");
    state.enabled = false;
    md.content = "> [!NOTE] off";
    // Concealed brackets: the untransformed marker reads `!NOTE off`.
    expect(await until("!NOTE off")).toContain("!NOTE off");
    expect(frame()).not.toContain("Note: off");
    renderer.destroy();
  });

  test("composes with another updateBlocks wrapper installed after it", async () => {
    const original = (proto as { updateBlocks: (...a: unknown[]) => unknown }).updateBlocks;
    let seen = 0;
    (proto as { updateBlocks: unknown }).updateBlocks = function (this: unknown, ...args: unknown[]) {
      seen++;
      return original.apply(this, args);
    };
    try {
      const { renderer, until } = await draw("> [!CAUTION] both");
      expect(await until("Caution: both")).toContain("Caution: both");
      expect(seen).toBeGreaterThan(0);
      renderer.destroy();
    } finally {
      (proto as { updateBlocks: unknown }).updateBlocks = original;
    }
  });

  test("a reinstall swaps the transform and re-enables", () => {
    const again = install(proto, (s) => s);
    expect(again).toBe(state);
    expect(again.enabled).toBe(true);
    expect(install(proto, transform)).toBe(state);
  });
});

describe("diagrams", () => {
  beforeAll(async () => {
    expect(await loadMermaid()).not.toBeNull();
  });

  test("the header is added only when missing", () => {
    expect(diagramSource("classdiagram", "A <|-- B")).toBe("classDiagram\nA <|-- B");
    expect(diagramSource("classdiagram-v2", "classDiagram\nA <|-- B")).toBe("classDiagram\nA <|-- B");
    expect(diagramSource("erdiagram", "%% c\nerDiagram\nA ||--o{ B : has")).toBe("%% c\nerDiagram\nA ||--o{ B : has");
    expect(diagramSource("ts", "const a = 1;")).toBe("const a = 1;");
  });

  const renderers = (width: () => number) => {
    const render = createDiagramRenderer({
      ctx: undefined as unknown as RenderContext,
      width,
      colors: () => ({ border: "#888888", text: "#ffffff", edge: "#888888", edgeLabel: "#ffffff", title: "#888888" }),
      chunk: (text, color) => fg(color as string)(text) as TextChunk,
      text: (_ctx, chunks, height) => new TextRenderable(ctx!, { content: new StyledText(chunks), width: "100%", height, wrapMode: "none" }),
    });
    return createMarkdownCodeBlockRenderer({ classdiagram: render, "classdiagram-v2": render, erdiagram: render });
  };
  let ctx: RenderContext | undefined;

  test("class and ER fences draw as box art; a mermaid fence with that header too", async () => {
    install(proto, transform);
    const content = "```classdiagram\nAnimal <|-- Dog\n```\n\n```mermaid\nerDiagram\nCUSTOMER ||--o{ ORDER : places\n```\n\n```mermaid\nflowchart LR\nA --> B\n```";
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 40 });
    ctx = renderer;
    const md = new MarkdownRenderable(renderer, {
      content,
      syntaxStyle: SyntaxStyle.create(),
      internalBlockMode: "top-level",
      width: "100%",
      renderNode: renderers(() => 80),
    });
    renderer.root.add(md);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("\u250c");
    expect(frame).toContain("Animal");
    expect(frame).toContain("Dog");
    expect(frame).toContain("CUSTOMER");
    expect(frame).toContain("places");
    expect(frame).not.toContain("<|--");
    expect(frame).not.toContain("||--o{");
    // The flowchart is the host's: without its renderer it stays a code block.
    expect(frame).toContain("A --> B");
    renderer.destroy();
  });

  test("too narrow a width, unparseable source or a missing module fall back to the code block", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 });
    ctx = renderer;
    const md = new MarkdownRenderable(renderer, {
      content: "```classdiagram\nAnimal <|-- Dog\n```",
      syntaxStyle: SyntaxStyle.create(),
      internalBlockMode: "top-level",
      width: "100%",
      renderNode: renderers(() => 5),
    });
    renderer.root.add(md);
    await renderOnce();
    expect(captureCharFrame()).toContain("Animal <|-- Dog");
    md.renderNode = renderers(() => 80);
    md.content = "```erdiagram\nthis is not a diagram {{{\n```";
    await renderOnce();
    expect(captureCharFrame()).toContain("this is not a diagram");
    setMermaid(null);
    try {
      md.content = "```classdiagram\nAnimal <|-- Cat\n```";
      await renderOnce();
      expect(captureCharFrame()).toContain("Animal <|-- Cat");
    } finally {
      await loadMermaid();
    }
    renderer.destroy();
  });
});
