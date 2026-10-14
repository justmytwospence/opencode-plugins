import { expect, test } from "vitest";
import { btwMetadata, commandArgs, exchanges, forkCopies, formatThread, handoffMessage, isDeniedReadonly, newSessionID, parseArgs, parseModelArgs, parseThinkingArgs, threadMessages, threadTitle, toolLine } from "../src/thread.ts";

const user = (id: string, text: string) => ({ id, type: "user", text });
const assistant = (id: string, text: string, finish?: string, error?: unknown) => ({ id, type: "assistant", content: text ? [{ type: "text", text }] : [], ...(finish ? { finish } : {}), ...(error ? { error } : {}) });

test("argument parsing: --save/-s accepted (ignored), model refs, variants", () => {
  expect(parseArgs("--save explain this")).toEqual({ question: "explain this", save: true });
  expect(parseArgs("explain -s this")).toEqual({ question: "explain  this", save: true });
  expect(parseArgs("explain --saved")).toEqual({ question: "explain --saved", save: false });
  expect(parseModelArgs("")).toEqual({ action: "show" });
  expect(parseModelArgs("clear")).toEqual({ action: "clear" });
  expect(parseModelArgs("openai/gpt-5-mini")).toEqual({ action: "set", providerID: "openai", modelID: "gpt-5-mini" });
  expect(parseModelArgs("anthropic/claude-opus-4-6#high")).toEqual({ action: "set", providerID: "anthropic", modelID: "claude-opus-4-6", variant: "high" });
  expect(parseModelArgs("openai gpt-5-mini")).toMatchObject({ action: "invalid" });
  expect(parseThinkingArgs("")).toEqual({ action: "show" });
  expect(parseThinkingArgs("clear")).toEqual({ action: "clear" });
  expect(parseThinkingArgs("low")).toEqual({ action: "set", variant: "low" });
  expect(parseThinkingArgs("a b")).toMatchObject({ action: "invalid" });
});

test("command arguments drop the command itself when the completion list passes it", () => {
  expect(commandArgs("what is this", ["btw", "side"])).toBe("what is this");
  expect(commandArgs("/btw what is this", ["btw", "side"])).toBe("what is this");
  expect(commandArgs("/side  what ", ["btw", "side"])).toBe("what");
  expect(commandArgs("/btw:model", ["btw:model"])).toBe("");
  expect(commandArgs("/btwx y", ["btw"])).toBe("/btwx y");
  expect(commandArgs(undefined, ["btw"])).toBe("");
});

test("metadata marks side sessions", () => {
  expect(btwMetadata({ btw: { main: "ses_1", mode: "readonly", title: "t" } })).toEqual({ main: "ses_1", mode: "readonly", title: "t" });
  expect(btwMetadata({ btw: { main: "ses_1", mode: "other" } })).toBeUndefined();
  expect(btwMetadata({ other: true })).toBeUndefined();
  expect(btwMetadata(undefined)).toBeUndefined();
});

test("read-only denies the editing actions and nothing else", () => {
  for (const action of ["edit", "write", "patch", "shell", "subagent"]) expect(isDeniedReadonly(action)).toBe(true);
  for (const action of ["read", "grep", "glob", "webfetch", "question", "external_directory"]) expect(isDeniedReadonly(action)).toBe(false);
});

test("thread messages start after the last message copied by the fork", () => {
  const at = <M extends { id: string; type: string }>(m: M, created: number) => ({ ...m, time: { created } });
  const messages = [at(user("m1", "main"), 10), at(assistant("m2", "reply"), 20), at(user("m3", "q"), 30), at(assistant("m4", "a"), 40)];
  expect(threadMessages(messages, "m2", 0).map((m) => m.id)).toEqual(["m3", "m4"]);
  expect(threadMessages(messages, undefined, 0).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  // The marker is gone: everything created since the thread was.
  expect(threadMessages(messages, "gone", 25).map((m) => m.id)).toEqual(["m3", "m4"]);
});

test("handoff extraction merges assistant parts and drops errored exchanges", () => {
  const messages = [
    user("1", "q1"),
    assistant("2", "a1 part 1"),
    assistant("3", "a1 part 2"),
    user("4", "q2"),
    assistant("5", "partial", "error"),
    user("6", "q3"),
    assistant("7", "", undefined, { name: "aborted" }),
    user("8", "q4"),
    assistant("9", "a4"),
    { id: "10", type: "idle" },
  ];
  expect(exchanges(messages)).toEqual([
    { user: "q1", assistant: "a1 part 1\n\na1 part 2" },
    { user: "q4", assistant: "a4" },
  ]);
  expect(formatThread([{ user: " q ", assistant: " a " }, { user: "x", assistant: "y" }])).toBe("User: q\nAssistant: a\n\n---\n\nUser: x\nAssistant: y");
});

test("handoff messages carry the instructions", () => {
  expect(handoffMessage("body", "", false)).toBe("Here is a side conversation I had for additional context:\n\nbody");
  expect(handoffMessage("body", "do it", false)).toBe("Here is a side conversation I had. do it\n\nbody");
  expect(handoffMessage("sum", "", true)).toBe("Here is a summary of a side conversation I had.:\n\nsum");
  expect(handoffMessage("sum", "apply it", true)).toBe("Here is a summary of a side conversation I had. apply it\n\nsum");
});

test("titles and tool lines", () => {
  expect(threadTitle("  what   is this ", "contextual")).toBe("btw: what is this");
  expect(threadTitle("", "tangent")).toBe("btw tangent: side conversation");
  expect(threadTitle("x".repeat(80), "readonly")).toBe(`btw ask: ${"x".repeat(59)}…`);
  expect(toolLine({ name: "read", state: { input: { filePath: "src/a.ts" } } })).toBe("read src/a.ts");
  expect(toolLine({ name: "shell", state: { title: "ls -la" } })).toBe("shell ls -la");
  expect(toolLine({ name: "glob" })).toBe("glob");
});

test("session ids follow OpenCode's format and sort newest first", () => {
  const a = newSessionID(1_791_937_477_491, () => 0);
  expect(a).toMatch(/^ses_[0-9a-f]{9}ffe[A-Za-z0-9]{14}$/);
  expect(a).toBe("ses_ec834048cffeAAAAAAAAAAAAAA");
  const later = newSessionID(1_791_937_477_491 + 1000, () => 0);
  expect(later < a).toBe(true);
  expect(newSessionID()).not.toBe(newSessionID());
});

test("fork copies keep complete messages, in order, under new ids", () => {
  const messages = [
    { id: "m1", type: "user", text: "q" },
    { id: "m2", type: "assistant", time: { created: 1, completed: 2 }, content: [] },
    { id: "m3", type: "shell", status: "running" },
    { id: "m4", type: "assistant", time: { created: 3 }, content: [] },
    { id: "m5", type: "idle" },
  ];
  expect(forkCopies(messages).map((m) => m.id)).toEqual(["m1_b0", "m2_b1", "m5_b2"]);
  expect(forkCopies([])).toEqual([]);
});
