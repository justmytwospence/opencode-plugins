import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "vitest";
import { holdsWideContent, install, parseMeasure, setMeasure, widthFor } from "../src/patch.js";
import { configuredMeasure } from "../src/tui.js";

const LONG = "word ".repeat(40).trim();
const LONG_CODE = `echo ${"x".repeat(110)}`;

describe("which blocks are narrowed", () => {
  test("prose is, code and tables are not", () => {
    expect(widthFor({ type: "paragraph" }, 72)).toBe(72);
    expect(widthFor({ type: "heading" }, 72)).toBe(72);
    expect(widthFor({ type: "code", text: "ls" }, 72)).toBe(undefined);
    expect(widthFor({ type: "table" }, 72)).toBe(undefined);
    expect(widthFor({ type: "paragraph" }, 0)).toBe(undefined);
  });

  test("a list keeps the full width only for a long code line or a table", () => {
    const list = (code: string) => ({ type: "list", items: [{ type: "list_item", tokens: [{ type: "code", text: code }] }] });
    expect(widthFor(list("ls"), 72)).toBe(72);
    expect(widthFor(list(LONG_CODE), 72)).toBe(undefined);
  });

  test("a coalesced block is read from its raw markdown", () => {
    expect(holdsWideContent({ type: "paragraph", raw: `- step\n  \`\`\`\n  ${LONG_CODE}\n  \`\`\`` }, 72)).toBe(true);
    expect(holdsWideContent({ type: "paragraph", raw: "- step\n  ```\n  ls\n  ```" }, 72)).toBe(false);
    expect(holdsWideContent({ type: "paragraph", raw: "| a | b |\n|---|---|" }, 72)).toBe(true);
  });
});

describe("drawn", () => {
  test("prose wraps at the measure, code keeps the full width, and the measure can change", async () => {
    const state = install(MarkdownRenderable.prototype as never, 72);
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 160, height: 30 });
    const md = new MarkdownRenderable(renderer, {
      content: `${LONG}\n\n\`\`\`sh\n${LONG_CODE}\n\`\`\``,
      syntaxStyle: SyntaxStyle.create(),
      internalBlockMode: "top-level",
      width: "100%",
    });
    renderer.root.add(md);
    await renderOnce();
    const widths = () => captureCharFrame().split("\n").map((l) => l.trimEnd().length).filter((n) => n > 0);
    const before = widths();
    expect(Math.max(...before.slice(0, -1))).toBeLessThanOrEqual(72);
    expect(captureCharFrame()).toContain(LONG_CODE);

    setMeasure(state, 0);
    await renderOnce();
    expect(widths()[0]).toBeGreaterThan(72);
    setMeasure(state, 72);
    renderer.destroy();
  });
});

describe("settings", () => {
  test("parse", () => {
    expect(parseMeasure("80")).toBe(80);
    expect(parseMeasure("off")).toBe(0);
    expect(parseMeasure("wide")).toBe(undefined);
  });

  test("env, then the shared file, then the plugin option", () => {
    const home = mkdtempSync(path.join(tmpdir(), "prose-width-"));
    expect(configuredMeasure(undefined, {}, home)).toBe(80);
    expect(configuredMeasure(80, {}, home)).toBe(80);
    mkdirSync(path.join(home, ".config/agents"), { recursive: true });
    writeFileSync(path.join(home, ".config/agents/prose-width.json"), '{ "width": 66 }');
    expect(configuredMeasure(80, {}, home)).toBe(66);
    expect(configuredMeasure(80, { PROSE_WIDTH: "off" }, home)).toBe(0);
  });
});
