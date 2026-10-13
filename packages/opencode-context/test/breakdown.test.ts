import { describe, expect, test } from "vitest";
import {
  type Part,
  assembleReport,
  capParts,
  collectBreakdown,
  formatReport,
  formatTokens,
  labelFor,
  normalizePreviewText,
  resolveUsedTokens,
  splitBlocks,
  startsWithBlock,
  tokenEstimate,
} from "../src/breakdown.ts";

const total = (parts: readonly { tokens: number }[]) => parts.reduce((sum, p) => sum + p.tokens, 0);
const part = (label: string, tokens: number) => ({ label, tokens });

describe("tokenEstimate", () => {
  test("is characters / 4, rounded up, and 0 for nothing", () => {
    expect(tokenEstimate("")).toBe(0);
    expect(tokenEstimate(undefined)).toBe(0);
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
  });

  test("serializes non-strings as JSON", () => {
    expect(tokenEstimate({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 4));
  });
});

describe("formatTokens", () => {
  test("formats by magnitude", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(99_949)).toBe("99.9k");
    expect(formatTokens(123_456)).toBe("123k");
  });
});

describe("normalizePreviewText", () => {
  test("normalizes newlines, expands tabs and strips control characters", () => {
    expect(normalizePreviewText("a\r\nb\rc\td\u0007e\u001b[1mf")).toBe("a\nb\nc  de[1mf");
  });
});

describe("splitBlocks", () => {
  // The system part OpenCode 2 builds from its instruction blocks, as seen in 2.0.24.
  const joined = [
    "# Code Mode",
    "",
    "Use the `execute` tool to call the tools listed below.",
    "## Available tools",
    "- read(filePath) // Read a file",
    "",
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    "  <skill>",
    "    <id>demo</id>",
    "  </skill>",
    "</available_skills>",
    "",
    "Instructions from: /p/AGENTS.md",
    "# House rules",
    "",
    "Be terse.",
    "",
    "Instructions from: /home/me/.config/opencode/AGENTS.md",
    "Global rules.",
    "",
    "",
    "Today's date: Tue Oct 13 2026",
    "",
    "Here is some useful information about the environment you are running in:",
    "<env>",
    "  Platform: darwin",
    "</env>",
  ].join("\n");

  test("cuts the joined instruction blocks at the lines they start with", () => {
    const blocks = splitBlocks(joined, "system", "System prompt");
    expect(blocks.map((b) => [b.key, b.label])).toEqual([
      ["tools", "Code Mode catalog"],
      ["skills", "Available skills"],
      ["instructions", "/p/AGENTS.md"],
      ["instructions", "/home/me/.config/opencode/AGENTS.md"],
      ["system", "Date"],
      ["system", "Environment"],
    ]);
    expect(blocks[2]?.text).toBe("Instructions from: /p/AGENTS.md\n# House rules\n\nBe terse.");
    expect(blocks[3]?.text).toBe("Instructions from: /home/me/.config/opencode/AGENTS.md\nGlobal rules.");
    expect(blocks[5]?.text.endsWith("</env>")).toBe(true);
  });

  test("text before any block start is one block of the default kind, labelled by its first line", () => {
    const blocks = splitBlocks("You are an AI agent running in OpenCode.\n\nHelp the user.", "system", "System prompt");
    expect(blocks).toEqual([{ key: "system", label: "You are an AI agent running in OpenCode.", text: "You are an AI agent running in OpenCode.\n\nHelp the user." }]);
    expect(labelFor("# Your Model\n- Name: X", "fallback")).toBe("Your Model");
    expect(labelFor("\n\n", "fallback")).toBe("fallback");
    expect(labelFor("x".repeat(80), "f")).toHaveLength(60);
  });

  test("classifies the update notices OpenCode sends mid-session", () => {
    expect(splitBlocks("The available skills have changed. This list supersedes the previous available skills list.\n<available_skills>\n</available_skills>", "system", "n").map((b) => b.key)).toEqual(["skills"]);
    expect(splitBlocks("New instructions apply from:\nInstructions from: /p/NEW.md\nhello", "system", "n").map((b) => [b.key, b.label])).toEqual([
      ["instructions", "Instructions update"],
      ["instructions", "/p/NEW.md"],
    ]);
    expect(splitBlocks("The instructions from /p/AGENTS.md changed. Here's the diff:\n```diff\n@@\n```", "system", "n").map((b) => [b.key, b.label])).toEqual([["instructions", "/p/AGENTS.md (update)"]]);
    expect(splitBlocks("The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n# Code Mode", "system", "n").map((b) => b.key)).toEqual(["tools", "tools"]);
    expect(splitBlocks("<skill_content name=\"demo\">\nbody\n</skill_content>", "conversation", "n").map((b) => b.key)).toEqual(["skills"]);
    expect(startsWithBlock("\nInstructions from: /x")).toBe(true);
    expect(startsWithBlock("please read Instructions from: /x")).toBe(false);
  });
});

describe("collectBreakdown", () => {
  const request = {
    system: [
      { text: "You are helpful." },
      { text: "# Code Mode\n- read // Read\n\nSkills provide specialized instructions and workflows.\n<available_skills>\n</available_skills>\n\nInstructions from: /p/AGENTS.md\nMEMORY BODY\n\nToday's date: Mon" },
    ],
    tools: {
      read: { description: "Read a file", input: { type: "object", properties: { filePath: { type: "string" } } } },
      edit: { description: "Edit", input: { type: "object" } },
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "hello there" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking..." }, { type: "text", text: "Reading." }, { type: "tool-call", id: "t1", name: "read", input: { filePath: "a.ts" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "t1", name: "read", result: { type: "text", value: "x".repeat(400) } }] },
      { role: "tool", content: [{ type: "tool-result", id: "t2", name: "shell", result: { type: "error", value: { message: "boom" } } }] },
      { role: "system", content: [{ type: "text", text: "New instructions apply from:\nInstructions from: /p/NEW.md\nmore rules" }] },
      { role: "user", content: [{ type: "media", media: { mime: "image/png", source: { type: "bytes", data: new Uint8Array(10) } } }, { type: "text", text: "Instructions from: /p/LATE.md\nlate" }] },
    ],
  };

  test("files every token of the request under one part, in the fixed order", () => {
    const parts = collectBreakdown(request);
    expect(parts.map((p) => p.key)).toEqual(["system", "instructions", "skills", "tools", "toolResults", "conversation"]);
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p])) as Record<string, Part>;

    expect(byKey.system?.items.map((i) => i.label)).toEqual(["You are helpful.", "Date"]);
    expect(byKey.system?.tokens).toBe(tokenEstimate("You are helpful.") + tokenEstimate("Today's date: Mon"));

    expect(byKey.instructions?.items.map((i) => i.label)).toEqual(["/p/AGENTS.md", "Instructions update", "/p/NEW.md", "/p/LATE.md"]);
    expect(byKey.instructions?.preview).toContain("MEMORY BODY");
    expect(byKey.instructions?.preview).toContain("## /p/AGENTS.md");

    expect(byKey.skills?.items.map((i) => i.label)).toEqual(["Available skills"]);

    expect(byKey.tools?.items.map((i) => i.label)).toEqual(["Code Mode catalog", "read", "edit"]);
    expect(byKey.tools?.tokens).toBe(
      tokenEstimate("# Code Mode\n- read // Read") +
        tokenEstimate({ name: "read", description: "Read a file", input: request.tools.read.input }) +
        tokenEstimate({ name: "edit", description: "Edit", input: { type: "object" } }),
    );
    expect(byKey.tools?.preview).toContain("## read");

    expect(byKey.toolResults?.items.map((i) => i.label)).toEqual(["read", "shell"]);
    expect(byKey.toolResults?.tokens).toBe(tokenEstimate("read") + 100 + tokenEstimate("shell") + tokenEstimate('{"message":"boom"}'));
    expect(byKey.toolResults?.preview).toContain("## Result: shell\n\nError:");

    expect(byKey.conversation?.items.map((i) => i.label)).toEqual(["User: hello there", "Assistant reasoning", "Assistant: Reading.", "Tool call: read", "Media: image/png 10 bytes (not counted)"]);
    expect(byKey.conversation?.tokens).toBe(tokenEstimate("hello there") + tokenEstimate("thinking...") + tokenEstimate("Reading.") + tokenEstimate("read") + tokenEstimate({ filePath: "a.ts" }));
    expect(byKey.conversation?.preview).toContain("## Tool call: read\n\n```json");
  });

  test("says when a part is empty", () => {
    const parts = collectBreakdown({ system: [], tools: {}, messages: [] });
    expect(parts.every((p) => p.tokens === 0 && p.items.length === 0)).toBe(true);
    expect(parts.find((p) => p.key === "skills")?.preview).toBe("No skills in context.");
  });

  test("cuts long previews and says so", () => {
    const parts = collectBreakdown({ system: [{ text: "y".repeat(90_000) }], tools: {}, messages: [] });
    const system = parts[0] as Part;
    expect(system.tokens).toBe(22_500);
    expect(system.truncated).toBe(true);
    expect(system.preview).toMatch(/more characters\]$/);
    expect(system.preview.length).toBeLessThan(90_000);
  });
});

describe("capParts", () => {
  test("leaves parts alone when they fit", () => {
    const parts = [part("a", 10), part("b", 20)];
    expect(capParts(parts, 100)).toBe(parts);
  });

  test("scales the variable parts to the target and keeps the fixed prefix", () => {
    const parts = [part("fixed", 50), part("x", 300), part("y", 100)];
    const capped = capParts(parts, 250, 1);
    expect(capped[0]).toEqual(part("fixed", 50));
    expect(total(capped)).toBe(250);
    expect(capped[1]?.tokens).toBe(150);
    expect(capped[2]?.tokens).toBe(50);
  });

  test("zeroes variable parts when the fixed prefix already exceeds the target", () => {
    expect(capParts([part("fixed", 80), part("x", 10)], 50, 1)).toEqual([part("fixed", 80), part("x", 0)]);
  });

  test("puts rounding error on the last part so the total is exact", () => {
    expect(total(capParts([part("a", 1), part("b", 1), part("c", 1)], 2))).toBe(2);
  });
});

describe("resolveUsedTokens", () => {
  test("uses the reported count", () => {
    expect(resolveUsedTokens(10_000, 1_000)).toBe(10_000);
  });

  test("falls back to the estimate without a report", () => {
    expect(resolveUsedTokens(undefined, 4_321)).toBe(4_321);
    expect(resolveUsedTokens(0, 4_321)).toBe(4_321);
  });

  test("uses the estimate when the report is far below what the content must cost", () => {
    expect(resolveUsedTokens(100, 8_000)).toBe(8_000);
  });
});

describe("assembleReport", () => {
  const blank = { items: [], preview: "", truncated: false };
  const parts: Part[] = [
    { key: "system", label: "System prompt", tokens: 1_000, ...blank },
    { key: "instructions", label: "Instructions", tokens: 500, ...blank },
    { key: "skills", label: "Skills", tokens: 200, ...blank },
    { key: "tools", label: "Tool definitions", tokens: 300, ...blank },
    { key: "toolResults", label: "Tool results", tokens: 4_000, ...blank },
    { key: "conversation", label: "Conversation", tokens: 2_000, ...blank },
  ];

  test("adds Other and Free space so the rows sum to the window", () => {
    const report = assembleReport(parts, 10_000, 200_000);
    expect(report.used).toBe(10_000);
    expect(report.rows.map((r) => r.key)).toEqual(["system", "instructions", "skills", "tools", "toolResults", "conversation", "other", "free"]);
    expect(report.rows.at(-2)?.tokens).toBe(2_000);
    expect(report.rows.at(-1)?.tokens).toBe(190_000);
    expect(total(report.rows)).toBe(200_000);
  });

  test("caps the variable parts when usage is below the estimate, never the fixed ones", () => {
    const report = assembleReport(parts, 5_000, 200_000);
    expect(report.rows.slice(0, 4).map((r) => r.tokens)).toEqual([1_000, 500, 200, 300]);
    expect((report.rows[4]?.tokens ?? 0) + (report.rows[5]?.tokens ?? 0)).toBe(3_000);
    expect(report.rows[6]?.tokens).toBe(0);
  });

  test("never reports less than the fixed parts", () => {
    expect(assembleReport(parts, 10, 200_000).used).toBeGreaterThanOrEqual(2_000);
  });

  test("works without a known window", () => {
    const report = assembleReport(parts, undefined, 0);
    expect(report.used).toBe(8_000);
    expect(report.rows.at(-1)?.tokens).toBe(0);
    expect(formatReport(report).split("\n")[0]).toBe("Context: 8.0k tokens");
  });

  test("formats a plain-text report", () => {
    const text = formatReport(assembleReport(parts, 10_000, 200_000));
    expect(text.split("\n")[0]).toBe("Context: 10.0k / 200k tokens (5.0%)");
    expect(text).toContain("Free space: 190k tokens");
  });
});
