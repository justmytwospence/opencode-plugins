import { expect, test } from "vitest";
import { type ContextEvent, SnapshotBook } from "../src/server.ts";
import { ago, barCells, reportedUsage } from "../src/usage.ts";

const event = (sessionID: string, text = "hi"): ContextEvent => ({
  sessionID,
  agent: "build",
  model: { providerID: "anthropic", id: "opus" },
  system: [{ text: "You are helpful." }],
  tools: { read: { description: "Read", input: { type: "object" } } },
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

test("the book keeps the last request per session and forgets deleted ones", () => {
  const book = new SnapshotBook(2);
  book.observe(event("a", "first"), 1_000);
  const snapshot = book.observe(event("a", "second"), 2_000);
  expect(book.get("a")).toBe(snapshot);
  expect(snapshot.at).toBe(2_000);
  expect(snapshot.agent).toBe("build");
  expect(snapshot.messages).toBe(1);
  expect(snapshot.parts.find((p) => p.key === "conversation")?.preview).toBe("## User\n\nsecond");
  expect(snapshot.parts.find((p) => p.key === "tools")?.items.map((i) => i.label)).toEqual(["read"]);

  book.observe(event("b"), 3_000);
  book.observe(event("c"), 4_000);
  expect(book.get("a")).toBeUndefined(); // the oldest went over the cap
  expect(book.get("b")).toBeDefined();
  book.forget("b");
  expect(book.get("b")).toBeUndefined();
});

test("usage is the last assistant response since the last completed compaction", () => {
  const tokens = (input: number) => ({ input, output: 5, reasoning: 0, cache: { read: 10, write: 1 } });
  expect(reportedUsage([])).toBeUndefined();
  expect(reportedUsage([{ type: "assistant" }])).toBeUndefined();
  expect(reportedUsage([{ type: "assistant", tokens: tokens(100), model: { providerID: "p", id: "m" } }, { type: "idle" }])).toEqual({ tokens: 116, model: { providerID: "p", id: "m" } });
  expect(
    reportedUsage([
      { type: "assistant", tokens: tokens(100) },
      { type: "compaction", status: "completed" },
      { type: "assistant", tokens: tokens(20) },
      { type: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    ])?.tokens,
  ).toBe(36);
  expect(reportedUsage([{ type: "assistant", tokens: tokens(100) }, { type: "compaction", status: "completed" }])).toBeUndefined();
  expect(reportedUsage([{ type: "assistant", tokens: tokens(100) }, { type: "compaction", status: "running" }])?.tokens).toBe(116);
});

test("the bar gives each row its share and the last row the rest", () => {
  expect(barCells([{ tokens: 25 }, { tokens: 25 }, { tokens: 50 }], 100, 20)).toEqual([5, 5, 10]);
  expect(barCells([{ tokens: 1 }, { tokens: 0 }, { tokens: 99 }], 100, 10)).toEqual([0, 0, 10]);
  expect(barCells([{ tokens: 300 }, { tokens: 0 }], 100, 10)).toEqual([10, 0]);
  expect(ago(0, 30_000)).toBe("30s ago");
  expect(ago(0, 120_000)).toBe("2m ago");
  expect(ago(0, 7_200_000)).toBe("2h ago");
});
