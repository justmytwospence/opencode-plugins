import { describe, expect, it } from "vitest";
import { assistantText, userMessages } from "../src/messages.ts";

const messages = [
  { id: "a1", type: "assistant", time: { created: 5 }, content: [{ type: "text", text: "earlier" }] },
  { id: "m2", type: "user", text: "second", time: { created: 20 } },
  { id: "m1", type: "user", text: "first", time: { created: 10 } },
  { id: "s1", type: "synthetic", text: "bg done", time: { created: 15 } },
  { id: "a2", type: "assistant", time: { created: 30 }, content: [{ type: "reasoning", text: "hmm" }, { type: "tool", text: "x" }, { type: "text", text: "[[dr:abcd]] done" }] },
];

describe("messages", () => {
  it("lists user messages oldest first, leaving synthetic ones out", () => {
    expect(userMessages(messages)).toEqual([
      { id: "m1", text: "first", created: 10 },
      { id: "m2", text: "second", created: 20 },
    ]);
  });
  it("collects assistant text since a time", () => {
    expect(assistantText(messages, 20)).toBe("[[dr:abcd]] done");
    expect(assistantText(messages, 0)).toBe("earlier\n[[dr:abcd]] done");
  });
});
