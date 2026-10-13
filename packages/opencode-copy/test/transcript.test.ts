import { expect, test } from "vitest";
import { extractSegments } from "../src/segments.ts";
import { type MessageLike, recentUserMessages, toEntries } from "../src/transcript.ts";

const messages: MessageLike[] = [
  { type: "agent_selected" },
  { type: "user", text: "Show me the install command" },
  {
    type: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "Run this:\n\n```sh\nnpm install opencode-copy\n```\n\nThen:\n\n```ts\nimport x from \"y\";\n```\n" },
      { type: "tool", name: "bash", state: { input: { command: "git status --short", description: "status" } } },
      { type: "tool", name: "read", state: { input: { filePath: "/x" } } },
    ],
  },
  { type: "shell", command: "ls -la" },
  { type: "shell", command: "  " },
  { type: "idle" },
];

test("OpenCode messages become Pi-shaped entries: text, bash tool calls and shell commands", () => {
  const entries = toEntries(messages);
  expect(entries.map((e) => e.message.role)).toEqual(["user", "assistant", "assistant"]);
  expect(entries[0]?.message.content).toBe("Show me the install command");
  expect(entries[1]?.message.content).toEqual([
    { type: "text", text: "Run this:\n\n```sh\nnpm install opencode-copy\n```\n\nThen:\n\n```ts\nimport x from \"y\";\n```\n" },
    { type: "toolCall", name: "bash", arguments: { command: "git status --short", description: "status" } },
  ]);
  expect(entries[2]?.message.content).toEqual([{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } }]);
});

test("the extracted pieces include the reply, its code, the tool command and the shell command", () => {
  const segments = extractSegments(toEntries(messages));
  const byKind = (kind: string) => segments.filter((s) => s.kind === kind).map((s) => s.text);
  expect(byKind("user")).toEqual(["Show me the install command"]);
  expect(byKind("code")).toEqual(['import x from "y";']);
  // A shell fence is a command, like the bash tool call and the shell message.
  expect(byKind("command")).toEqual(expect.arrayContaining(["npm install opencode-copy", "git status --short", "ls -la"]));
});

test("recent user messages: the last three, oldest first, clipped", () => {
  const entries = toEntries([
    { type: "user", text: "one" },
    { type: "user", text: "   " },
    { type: "user", text: "two" },
    { type: "assistant", content: [{ type: "text", text: "reply" }] },
    { type: "user", text: "three" },
    { type: "user", text: "x".repeat(600) },
  ]);
  const recent = recentUserMessages(entries);
  expect(recent.length).toBe(3);
  expect(recent.slice(0, 2)).toEqual(["two", "three"]);
  expect(recent[2]?.length).toBe(500);
  expect(recent[2]?.endsWith("…")).toBe(true);
});
