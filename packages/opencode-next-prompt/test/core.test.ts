import { expect, test } from "vitest";
import { Tracker, keyLabel, lastUserPrompt } from "../src/core.ts";

const messages = [
  { id: "u1", type: "user", text: "rename foo to bar" },
  { id: "a1", type: "assistant" },
  { id: "i1", type: "idle" },
];

test("the suggestion comes from the last finished text of the session, read once", () => {
  const t = new Tracker();
  t.ended("s1", "a1", "Renamed.\n\n```next\nRun the tests\n```");
  expect(t.take("s1", messages, 110)).toEqual({
    sessionID: "s1",
    messageID: "a1",
    suggestion: "Run the tests",
    userPrompt: "rename foo to bar",
    assistantTail: "Renamed.",
  });
  expect(t.take("s1", messages, 110)).toBeUndefined();
});

test("a later text of the same run supersedes an earlier one (a block before a tool call does not count)", () => {
  const t = new Tracker();
  t.ended("s1", "a1", "Checking.\n```next\nnope\n```");
  t.ended("s1", "a2", "All done.");
  expect(t.take("s1", messages, 110)).toBeUndefined();
});

test("sessions are kept apart and a new run forgets the old text", () => {
  const t = new Tracker();
  t.ended("s1", "a1", "A\n```next\none\n```");
  t.ended("s2", "b1", "B\n```next\ntwo\n```");
  t.forget("s1");
  expect(t.take("s1", messages, 110)).toBeUndefined();
  expect(t.take("s2", [], 110)?.suggestion).toBe("two");
  expect(t.take("s2", [], 110)).toBeUndefined();
});

test("an over-long block is no suggestion; the prompt falls back to empty", () => {
  const t = new Tracker();
  t.ended("s1", "a1", `Done.\n\`\`\`next\n${"x".repeat(111)}\n\`\`\``);
  expect(t.take("s1", messages, 110)).toBeUndefined();
  t.ended("s1", "a1", "Done.\n```next\nok\n```");
  expect(t.take("s1", [{ id: "a1", type: "assistant" }], 110)?.userPrompt).toBe("");
});

test("helpers", () => {
  expect(lastUserPrompt([{ id: "u1", type: "user", text: " a " }, { id: "u2", type: "user", text: "b" }, { id: "a", type: "assistant" }])).toBe("b");
  expect(keyLabel("tab")).toBe("Tab");
  expect(keyLabel("ctrl+f")).toBe("Ctrl+f");
});
