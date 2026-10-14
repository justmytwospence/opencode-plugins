import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type ContextEvent, type Host, type PermissionEvent, SKILL_PATH, createHooks, parseSkill } from "../src/server.ts";
import { type BtwMetadata, READONLY_PROMPT, SYSTEM_PROMPT } from "../src/thread.ts";

function host(sessions: Record<string, BtwMetadata | undefined>) {
  const logs: string[] = [];
  const lookups: string[] = [];
  const h: Host = {
    metadata: async (sessionID) => {
      lookups.push(sessionID);
      if (sessionID === "boom") throw new Error("not found");
      return sessions[sessionID];
    },
    log: (m) => void logs.push(m),
  };
  return { host: h, logs, lookups };
}

const context = (sessionID: string, tools: string[] = ["read", "edit", "shell", "grep"]): ContextEvent => ({
  sessionID,
  agent: "build",
  system: [{ type: "text", text: "base" }],
  tools: Object.fromEntries(tools.map((t) => [t, { description: t, input: {} }])),
});

test("side sessions get the aside system prompt; ordinary sessions are untouched", async () => {
  const { host: h, lookups } = host({ side: { main: "main", mode: "contextual", title: "btw: q" } });
  const hooks = createHooks(h);
  const event = context("side");
  await hooks.context(event);
  expect(event.system.map((s) => s.text)).toEqual(["base", SYSTEM_PROMPT]);
  expect(Object.keys(event.tools)).toEqual(["read", "edit", "shell", "grep"]);

  const plain = context("main");
  await hooks.context(plain);
  expect(plain.system).toHaveLength(1);
  // Lookups are cached per session.
  await hooks.context(context("side"));
  await hooks.context(context("main"));
  expect(lookups).toEqual(["side", "main"]);
});

test("read-only threads lose the editing tools and have the editing actions denied", async () => {
  const { host: h, logs } = host({ ro: { main: "main", mode: "readonly", title: "btw ask: q" }, side: { main: "main", mode: "contextual", title: "t" } });
  const hooks = createHooks(h);
  const event = context("ro");
  await hooks.context(event);
  expect(event.system.at(-1)?.text).toBe(`${SYSTEM_PROMPT} ${READONLY_PROMPT}`);
  expect(Object.keys(event.tools)).toEqual(["read", "grep"]);

  const summary = context("side");
  await hooks.generate(summary);
  expect(Object.keys(summary.tools)).toEqual([]);
  const own = context("main");
  await hooks.generate(own);
  expect(Object.keys(own.tools)).toHaveLength(4);

  const edit: PermissionEvent = { sessionID: "ro", action: "edit", effect: "allow" };
  await hooks.permission(edit);
  expect(edit.effect).toBe("deny");
  expect(edit.message).toContain("read-only");
  const read: PermissionEvent = { sessionID: "ro", action: "read", effect: "ask" };
  await hooks.permission(read);
  expect(read.effect).toBe("ask");
  const other: PermissionEvent = { sessionID: "side", action: "edit", effect: "allow" };
  await hooks.permission(other);
  expect(other.effect).toBe("allow");
  const plain: PermissionEvent = { sessionID: "main", action: "shell", effect: "ask" };
  await hooks.permission(plain);
  expect(plain.effect).toBe("ask");
  expect(logs).toHaveLength(1);
});

test("the title hook answers with the thread title; failures and unknown sessions pass through", async () => {
  const { host: h } = host({ side: { main: "main", mode: "tangent", title: "btw tangent: x" } });
  const hooks = createHooks(h);
  const event = { sessionID: "side", result: undefined as string | undefined };
  await hooks.title(event);
  expect(event.result).toBe("btw tangent: x");
  const plain = { sessionID: "main", result: undefined as string | undefined };
  await hooks.title(plain);
  expect(plain.result).toBeUndefined();
  const failing = context("boom");
  await hooks.context(failing);
  expect(failing.system).toHaveLength(1);
  hooks.forget("side");
});

test("the shipped skill parses to a named, described skill", () => {
  const skill = parseSkill(readFileSync(SKILL_PATH, "utf8"));
  expect(skill.name).toBe("btw");
  expect(skill.description).toMatch(/side-conversation/);
  expect(skill.content.startsWith("# BTW")).toBe(true);
  expect(parseSkill("no frontmatter")).toEqual({ name: "btw", description: "", content: "no frontmatter" });
});
