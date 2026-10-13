import { describe, expect, test } from "vitest";
import {
  deCircled,
  fenceMask,
  findFences,
  normalizeMultilineLinks,
  renderAdmonitions,
  routeDiagramFences,
  transform,
} from "../src/transform.ts";

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("fences", () => {
  test("finds closed, unclosed and tilde fences", () => {
    const lines = ["a", "```ts", "x", "```", "b", "~~~", "y", "~~~", "````", "z"];
    expect(findFences(lines)).toEqual([
      { open: 1, close: 3, info: "ts" },
      { open: 5, close: 7, info: "" },
      { open: 8, close: -1, info: "" },
    ]);
    expect(fenceMask(lines)).toEqual([false, true, true, true, false, true, true, true, true, true]);
  });

  test("a shorter marker does not close a longer fence", () => {
    expect(findFences(["````", "```", "x", "````"])).toEqual([{ open: 0, close: 3, info: "" }]);
  });
});

describe("bare URLs are not linkified (regression)", () => {
  test("bold bare URL passes through unchanged", () => {
    const md = "**https://example.com/a**";
    expect(transform(md)).toBe(md);
  });

  test("plain and trailing-punctuation URLs pass through unchanged", () => {
    const md = "See https://example.com/path, then (https://example.com/x) and <https://example.com/y>.";
    expect(transform(md)).toBe(md);
  });
});

describe("admonitions", () => {
  test("single line", () => {
    expect(renderAdmonitions("> [!WARNING] Careful")).toBe("> **Warning:** Careful\n");
  });

  test("multi-line body is joined, trailing blank quote lines dropped, label is plain text", () => {
    const md = ["> [!TIP]", "> first", "> second", ">", "after"].join("\n");
    expect(renderAdmonitions(md)).toBe("> **Tip:** first second\n\nafter");
  });

  test("each type gets its label and is case-insensitive", () => {
    expect(renderAdmonitions("> [!note] a")).toBe("> **Note:** a\n");
    expect(renderAdmonitions("> [!IMPORTANT] a")).toBe("> **Important:** a\n");
    expect(renderAdmonitions("> [!CAUTION] a")).toBe("> **Caution:** a\n");
  });

  test("consecutive admonitions stay separate", () => {
    const md = "> [!NOTE] a\n> [!TIP] b";
    expect(renderAdmonitions(md)).toBe("> **Note:** a\n\n> **Tip:** b\n");
  });

  test("unknown types and fenced code are untouched", () => {
    expect(renderAdmonitions("> [!FOO] a")).toBe("> [!FOO] a");
    const md = "```\n> [!NOTE] a\n```";
    expect(renderAdmonitions(md)).toBe(md);
    const open = "```\n> [!NOTE] a";
    expect(renderAdmonitions(open)).toBe(open);
  });

  test("output has no emoji", () => {
    for (const t of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(renderAdmonitions(`> [!${t}] x`)).toMatch(/^[\x20-\x7e\n]+$/);
    }
  });
});

describe("circled numbers", () => {
  test("rewrites U+2460..U+2473 to (n)", () => {
    expect(deCircled("\u2460 one \u2473 twenty")).toBe("(1) one (20) twenty");
  });

  test("leaves other text alone", () => {
    expect(deCircled("plain (1) text")).toBe("plain (1) text");
  });
});

describe("multi-line link labels", () => {
  test("joins label lines and trims padding", () => {
    expect(normalizeMultilineLinks("[a  \n   b](https://x)")).toBe("[a b](https://x)");
  });

  test("single-line links and fenced code are untouched", () => {
    expect(normalizeMultilineLinks("[a](https://x)")).toBe("[a](https://x)");
    const md = "```\n[a\nb](https://x)\n```";
    expect(normalizeMultilineLinks(md)).toBe(md);
  });

  test("brackets without a following paren are untouched", () => {
    expect(normalizeMultilineLinks("[a\nb] c")).toBe("[a\nb] c");
  });
});

describe("diagram fence routing", () => {
  test("state and sequence dialects become mermaid fences with their header", () => {
    expect(routeDiagramFences(fence("statediagram", "[*] --> A"))).toBe(fence("mermaid", "stateDiagram-v2\n[*] --> A"));
    expect(routeDiagramFences(fence("stateDiagram-v2", "[*] --> A"))).toBe(fence("mermaid", "stateDiagram-v2\n[*] --> A"));
    expect(routeDiagramFences(fence("sequenceDiagram", "A->>B: hi"))).toBe(fence("mermaid", "sequenceDiagram\nA->>B: hi"));
  });

  test("a header already present is not repeated", () => {
    const md = fence("statediagram", "stateDiagram-v2\n[*] --> A");
    expect(routeDiagramFences(md)).toBe(fence("mermaid", "stateDiagram-v2\n[*] --> A"));
    const comment = fence("sequencediagram", "%% note\nsequenceDiagram\nA->>B: hi");
    expect(routeDiagramFences(comment)).toBe(fence("mermaid", "%% note\nsequenceDiagram\nA->>B: hi"));
  });

  test("class and ER diagrams in a mermaid fence get this plugin's label", () => {
    expect(routeDiagramFences(fence("mermaid", "classDiagram\nA <|-- B"))).toBe(fence("classdiagram", "classDiagram\nA <|-- B"));
    expect(routeDiagramFences(fence("mermaid", "  erDiagram\n  A ||--o{ B : has"))).toBe(fence("erdiagram", "  erDiagram\n  A ||--o{ B : has"));
    expect(routeDiagramFences(fence("mermaid", "%% c\n\nclassDiagram-v2\nA <|-- B"))).toBe(fence("classdiagram", "%% c\n\nclassDiagram-v2\nA <|-- B"));
  });

  test("class and ER dialect fences, mermaid kinds the host draws, and other code are untouched", () => {
    for (const md of [
      fence("classdiagram", "A <|-- B"),
      fence("erdiagram", "A ||--o{ B : has"),
      fence("mermaid", "flowchart LR\nA --> B"),
      fence("mermaid", "sequenceDiagram\nA->>B: hi"),
      fence("ts", "const a = 1;"),
      "use `mermaid` here",
      "```mermaid",
    ]) {
      expect(routeDiagramFences(md)).toBe(md);
    }
  });

  test("an unclosed dialect fence is re-labelled as it streams", () => {
    expect(routeDiagramFences("```statediagram")).toBe("```mermaid\nstateDiagram-v2");
    expect(routeDiagramFences("```statediagram\n[*] --> A")).toBe("```mermaid\nstateDiagram-v2\n[*] --> A");
    expect(routeDiagramFences("```mermaid\nerDiagram\nA ||--o{ B : has")).toBe("```erdiagram\nerDiagram\nA ||--o{ B : has");
  });

  test("indentation and tilde fences are kept", () => {
    expect(routeDiagramFences("  ~~~statediagram\n  [*] --> A\n  ~~~")).toBe("  ~~~mermaid\nstateDiagram-v2\n  [*] --> A\n  ~~~");
  });
});

describe("everything together", () => {
  test("applies every transform", () => {
    const md = "\u2460 [a\nb](https://x)\n> [!NOTE] n";
    expect(transform(md)).toBe("(1) [a b](https://x)\n> **Note:** n\n");
  });

  test("is idempotent and leaves plain text alone", () => {
    const md = "plain text\n\n- a list\n- with items\n\n```ts\nconst x = 1;\n```";
    expect(transform(md)).toBe(md);
    const once = transform("\u2460 [a\nb](https://x)\n> [!NOTE] n\n\n```statediagram\n[*] --> A\n```");
    expect(transform(once)).toBe(once);
    expect(transform("")).toBe("");
  });
});
