// The OpenCode glue against a fake plugin context: tool registration, the depth hook, and how the
// host maps agents, models, sessions and worktrees.
import { execFileSync as exec } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import plugin, { createHost, repositoryRoot } from "../src/server.ts";

function fakeContext() {
  const calls: { name: string; args: unknown }[] = [];
  const record = (name: string, value?: unknown) => (args: unknown) => {
    calls.push({ name, args });
    return Promise.resolve(value);
  };
  const tools: Record<string, { name: string; options?: unknown; execute: (input: unknown, context: unknown) => Promise<unknown> }> = {};
  const hooks: Record<string, (event: unknown) => Promise<void> | void> = {};
  const sessions: Record<string, unknown> = {
    top: { id: "top", projectID: "p", location: { directory: "/repo" }, model: { providerID: "anthropic", id: "opus", variant: "high" }, cost: 1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 3 } } },
    child: { id: "child", parentID: "top", projectID: "p", location: { directory: "/repo" } },
    grandchild: { id: "grandchild", parentID: "child", projectID: "p", location: { directory: "/repo" } },
  };
  const ctx = {
    options: {},
    location: { directory: "/repo" },
    agent: {
      list: async () => ({
        data: [
          { id: "build", name: "Build", mode: "primary", hidden: false, description: "The default agent" },
          { id: "general", name: "General", mode: "subagent", hidden: false, description: "General-purpose" },
          { id: "explore", name: "Explore", mode: "subagent", hidden: false, model: { providerID: "anthropic", id: "haiku", variant: "low" } },
          { id: "compaction", name: "Compaction", mode: "subagent", hidden: true, description: "hidden" },
        ],
      }),
    },
    model: { list: async () => ({ data: [{ id: "opus", providerID: "anthropic", variants: [{ id: "low" }, { id: "high" }] }, { id: "haiku", providerID: "anthropic" }] }) },
    session: {
      hook: async (name: string, fn: (event: unknown) => Promise<void> | void) => {
        hooks[name] = fn;
        return { dispose: async () => undefined };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions[sessionID]) throw new Error("not found");
        return sessions[sessionID];
      },
      context: record("context", [{ type: "user", text: "hi" }]),
      create: async (input: { parentID: string }) => {
        calls.push({ name: "create", args: input });
        return { id: "new", parentID: input.parentID, location: { directory: "/repo" } };
      },
      move: record("move"),
      prompt: record("prompt"),
      wait: record("wait"),
      interrupt: record("interrupt"),
      synthetic: record("synthetic"),
    },
    worktree: { create: record("worktree.create", { directory: "/repo/.worktrees/subagent-x" }) },
    tool: {
      transform: async (fn: (editor: { add: (tool: (typeof tools)[string]) => void }) => void) => {
        fn({ add: (tool) => void (tools[tool.name] = tool) });
        return { dispose: async () => undefined };
      },
    },
    event: {
      subscribe: async function* () {
        // No events.
      },
    },
  };
  return { ctx: ctx as never, raw: ctx, calls, tools, hooks };
}

test("setup registers a direct delegate tool and a context hook that drops it at the depth limit", async () => {
  const f = fakeContext();
  const cleanup = await plugin.setup(f.ctx);
  expect(Object.keys(f.tools)).toEqual(["delegate"]);
  expect(f.tools.delegate?.options).toEqual({ codemode: false });
  const hook = f.hooks.context as (event: unknown) => Promise<void>;
  const event = (sessionID: string) => ({ sessionID, tools: { delegate: { description: "d", input: {} }, read: { description: "r", input: {} } } });
  const top = event("top");
  await hook(top);
  expect(Object.keys(top.tools)).toEqual(["delegate", "read"]);
  const child = event("child");
  await hook(child);
  expect(Object.keys(child.tools)).toEqual(["delegate", "read"]);
  const grandchild = event("grandchild");
  await hook(grandchild);
  expect(Object.keys(grandchild.tools)).toEqual(["read"]);
  await (cleanup as () => Promise<void>)?.();
});

test("the host maps OpenCode's agents, models and sessions", async () => {
  const f = fakeContext();
  const host = createHost(f.ctx);
  expect(await host.agents("/repo")).toEqual([
    { id: "general", description: "General-purpose" },
    { id: "explore", description: "Explore", model: "anthropic/haiku", variant: "low" },
  ]);
  expect(await host.models("/repo")).toEqual([
    { provider: "anthropic", id: "opus", variants: ["low", "high"] },
    { provider: "anthropic", id: "haiku", variants: [] },
  ]);
  expect(await host.session("top")).toEqual({
    id: "top",
    projectID: "p",
    directory: "/repo",
    model: { providerID: "anthropic", id: "opus", variant: "high" },
    cost: 1,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 3 } },
  });
  expect(await host.session("child")).toMatchObject({ parentID: "top", cost: 0 });
});

test("a child in another directory is created under its parent, then moved there", async () => {
  const f = fakeContext();
  const host = createHost(f.ctx);
  const model = { providerID: "anthropic", id: "opus", variant: "low" };
  expect(await host.create({ parentID: "top", title: "T", agent: "general", model, directory: "/repo" })).toEqual({ id: "new" });
  expect(f.calls).toEqual([{ name: "create", args: { parentID: "top", title: "T", agent: "general", model } }]);
  await host.create({ parentID: "top", title: "T", agent: "general", model, directory: "/repo/.worktrees/x" });
  expect(f.calls.at(-1)).toEqual({ name: "move", args: { sessionID: "new", directory: "/repo/.worktrees/x" } });
  await host.prompt("new", "go", "steer");
  await host.deliver("top", "done");
  expect(f.calls.slice(-2)).toEqual([
    { name: "prompt", args: { sessionID: "new", text: "go", delivery: "steer" } },
    { name: "synthetic", args: { sessionID: "top", text: "done", description: "delegate", delivery: "queue" } },
  ]);
});

test("a worktree is made under <repo>/.worktrees through OpenCode, on its own branch", async () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "subagents-repo-")));
  exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  expect(await repositoryRoot(repo)).toBe(repo);
  const f = fakeContext();
  // The fake creates the directory the way OpenCode would: a detached worktree.
  f.raw.worktree.create = (async (input: { directory: string; name: string }) => {
    const dir = path.join(input.directory, input.name);
    exec("git", ["worktree", "add", "-q", "--detach", dir], { cwd: repo });
    f.calls.push({ name: "worktree.create", args: input });
    return { directory: dir };
  }) as never;
  const host = createHost(f.ctx);
  const dir = await host.worktree({ projectID: "p", cwd: repo, name: "subagent-fix-abc123", branch: "subagent/fix-abc123", signal: new AbortController().signal });
  expect(dir).toBe(path.join(repo, ".worktrees", "subagent-fix-abc123"));
  expect(f.calls[0]).toEqual({ name: "worktree.create", args: { projectID: "p", from: repo, directory: path.join(repo, ".worktrees"), name: "subagent-fix-abc123" } });
  expect(exec("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim()).toBe("subagent/fix-abc123");
  await expect(host.worktree({ projectID: "p", cwd: tmpdir(), name: "n", branch: "b", signal: new AbortController().signal })).rejects.toThrow("not in a git repository");
});
