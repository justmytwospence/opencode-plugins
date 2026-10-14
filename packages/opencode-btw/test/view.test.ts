import { expect, test } from "vitest";
import { blocks, header } from "../src/view.ts";

test("transcript blocks: user text, assistant text split around tool calls, errors, streaming marker", () => {
  const messages = [
    { id: "u1", type: "user", text: "q" },
    { id: "s1", type: "synthetic", text: "<system-reminder>plan mode</system-reminder>" },
    {
      id: "a1",
      type: "assistant",
      time: { created: 1, completed: 2 },
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool", name: "read", state: { status: "completed", input: { path: "a.ts" } } },
        { type: "tool", name: "shell", state: { status: "error", title: "echo hi" } },
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "Done." },
      ],
    },
    { id: "a2", type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "Partial" }] },
    { id: "i", type: "idle" },
  ];
  expect(blocks(messages, true)).toEqual([
    { kind: "user", id: "u1", text: "q" },
    { kind: "assistant", id: "a1:0", text: "Let me look.", streaming: false },
    { kind: "tool", id: "a1:1", text: "read a.ts", color: "muted" },
    { kind: "tool", id: "a1:2", text: "shell echo hi", color: "error" },
    { kind: "assistant", id: "a1:1", text: "Done.", streaming: false },
    { kind: "assistant", id: "a2:0", text: "Partial", streaming: false },
  ]);
  const last = { id: "a3", type: "assistant", time: { created: 4 }, content: [{ type: "text", text: "Streaming" }] };
  expect(blocks([last], true).at(-1)).toEqual({ kind: "assistant", id: "a3:0", text: "Streaming", streaming: true });
  expect(blocks([last], false).at(-1)).toEqual({ kind: "assistant", id: "a3:0", text: "Streaming", streaming: false });
  const thinking = { id: "a4", type: "assistant", time: { created: 5 }, content: [{ type: "reasoning", text: "…" }] };
  expect(blocks([thinking], true)).toEqual([{ kind: "thinking", id: "a4:0" }]);
  expect(blocks([thinking], false)).toEqual([]);
  const failed = { id: "a5", type: "assistant", time: { created: 6, completed: 7 }, content: [], error: { name: "ProviderError", data: { message: "overloaded" } } };
  expect(blocks([failed], false)).toEqual([{ kind: "error", id: "a5:error", text: "overloaded" }]);
});

test("the header names the mode, agent, model and state", () => {
  expect(header("contextual", "anthropic/claude-opus-4-6", "build", true)).toBe("btw · contextual · build · anthropic/claude-opus-4-6 · running");
  expect(header("readonly", undefined, "plan", false)).toBe("btw · ask (read-only) · plan · idle");
  expect(header("tangent", undefined, undefined, false)).toBe("btw · tangent · idle");
});
