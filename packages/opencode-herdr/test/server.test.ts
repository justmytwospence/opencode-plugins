import { describe, expect, it } from "vitest";
import { DESCRIPTION, INPUT_SCHEMA, createServer } from "../src/server.ts";
import { OPUS, PANE, fakeHerdr, fakeHost } from "./harness.ts";

describe("herdr RPC", () => {
  it("stores tokens per session, re-emits every call, and answers state", async () => {
    const h = fakeHost();
    const s = createServer(h.host);
    await s.rpc.token({ sessionID: "a", key: "nb", value: "notebook", ttlMs: 60_000 });
    await s.rpc.token({ sessionID: "a", key: "x", value: "1" });
    await s.rpc.token({ sessionID: "b", key: "nb", value: "other" });
    await s.rpc.token({ sessionID: "a", key: "x" });
    await s.rpc.notify({ sessionID: "a", title: "done", sound: "done" });
    await s.rpc.zoom({ sessionID: "a", holder: "review", active: true });
    expect(await s.rpc.state({ sessionID: "a" })).toEqual({ tokens: [{ sessionID: "a", key: "nb", value: "notebook", ttlMs: 60_000 }] });
    expect(await s.rpc.state({ sessionID: "c" })).toEqual({ tokens: [] });
    expect(h.events.map((e) => e.name)).toEqual(["token", "token", "token", "token", "notify", "zoom"]);
    expect(h.events[3]!.data).toEqual({ sessionID: "a", key: "x" });
    expect(h.events[4]!.data).toEqual({ sessionID: "a", title: "done", sound: "done" });
    s.forget("a");
    expect(await s.rpc.state({ sessionID: "a" })).toEqual({ tokens: [] });
  });
});

describe("herdr_child", () => {
  it("keeps the guidance that reserves interactive sessions for human-led handoffs", () => {
    expect(DESCRIPTION).toContain("persistent, human-led");
    expect(DESCRIPTION).toContain("subagent (the task tool)");
    expect(DESCRIPTION).toContain("even when long, multi-step, or parallel");
    expect(DESCRIPTION).toContain("explicit interactive-session request");
    expect(DESCRIPTION).toContain("where=tab in the existing space");
    expect(DESCRIPTION).toContain("Tabs and splits share files");
    expect(DESCRIPTION).toContain("where=split only for deliberate side-by-side");
    expect(DESCRIPTION).toContain("otherwise ask before creating one");
    expect(DESCRIPTION).toContain("already open");
    expect(INPUT_SCHEMA.required).toEqual(["action"]);
    expect(INPUT_SCHEMA.properties.action.enum).toEqual(["spawn", "send", "read", "list", "interrupt", "close"]);
  });

  it("fails clearly when no herdr pane shows the session", async () => {
    const h = fakeHost();
    h.session("ses_root", { directory: "/repo" });
    const s = createServer(h.host);
    await expect(s.execute({ action: "list" }, { sessionID: "ses_root" })).rejects.toThrow(/needs this session open in OpenCode inside a herdr pane/u);
    await expect(s.execute({ action: "spawn", task: "x" }, { sessionID: "ses_root" })).rejects.toThrow(/herdr pane/u);
    expect(h.herdr.log).toEqual([]);
  });

  it("finds the pane through the root session, creates the child's session with the parent's model, and delivers the reply", async () => {
    const h = fakeHost();
    h.session("ses_root", { directory: "/repo", model: OPUS });
    h.session("ses_sub", { parentID: "ses_root", directory: "/repo" });
    const s = createServer(h.host);
    await s.pane.attach(PANE);
    const out = await s.execute({ action: "spawn", task: "Review the auth module" }, { sessionID: "ses_sub" });
    expect(out).toContain('Started herdr child "review-auth-module" in a new tab, pane w1:p2');
    expect(h.sessions.get("ses_child_1")).toEqual({ directory: "/repo", model: OPUS });
    expect(h.herdr.of("tab.create")[0]!.params).toMatchObject({ workspace_id: "w1", cwd: "/repo", label: "review-auth-module" });
    expect(h.herdr.of("agent.start")[0]!.params).toMatchObject({ kind: "opencode", pane_id: "w1:p2", args: ["--session", "ses_child_1"] });
    const prompt = h.herdr.of("agent.prompt")[0]!.params;
    expect(prompt.text).toMatch(/^\[You are a child opencode session\. Another opencode session \(herdr pane w1:p1\)/u);
    expect(prompt.text.endsWith("Review the auth module")).toBe(true);
    // The pending child shows as the root session's `bg` token.
    expect(h.tokenEvents().at(-1)).toEqual({ sessionID: "ses_root", key: "bg", value: "child review-auth-module", ttlMs: 90_000 });
    expect(await s.rpc.state({ sessionID: "ses_root" })).toEqual({ tokens: [{ sessionID: "ses_root", key: "bg", value: "child review-auth-module", ttlMs: 90_000 }] });
    expect(h.records("ses_sub")).toMatchObject([{ name: "review-auth-module", session: "ses_child_1", awaiting: true }]);
    expect(h.storage.get("children:ses_sub")).toMatchObject({ root: "ses_root" });

    expect(await s.execute({ action: "list" }, { sessionID: "ses_sub" })).toMatch(/^review-auth-module {2}idle \(reply pending\)/u);

    h.reply("ses_child_1", "All done: 3 files changed.\n\n<next>commit</next>");
    h.herdr.state.agent.agent_status = "working";
    h.herdr.state.agent.completion_seq = undefined;
    // Drive the poll by hand (pollMs is long in tests).
    const tick = () => s.children("ses_sub")!.tick();
    await tick();
    expect(h.delivered).toEqual([]);
    h.herdr.state.agent.agent_status = "done";
    h.herdr.state.agent.completion_seq = 7;
    await tick();
    expect(h.delivered).toEqual([{ sessionID: "ses_sub", text: 'Herdr child "review-auth-module" (tab, pane w1:p2) replied:\n\nAll done: 3 files changed.' }]);
    // No `value` key at all: the event schema rejects an explicit undefined.
    expect(h.tokenEvents().at(-1)).toStrictEqual({ sessionID: "ses_root", key: "bg", ttlMs: 90_000 });
    expect(await s.rpc.state({ sessionID: "ses_root" })).toEqual({ tokens: [] });
  });

  it("takes an explicit model, needs branch for worktrees, and starts worktree children in their checkout", async () => {
    const h = fakeHost();
    h.session("ses_root", { directory: "/repo", model: OPUS });
    const s = createServer(h.host);
    await s.pane.attach(PANE);
    await expect(s.execute({ action: "spawn", task: "x", model: "nope" }, { sessionID: "ses_root" })).rejects.toThrow(/provider\/model/u);
    await expect(s.execute({ action: "spawn", task: "x", where: "worktree" }, { sessionID: "ses_root" })).rejects.toThrow(/needs `branch`/u);
    const out = await s.execute({ action: "spawn", task: "build feature x", name: "feat", where: "worktree", branch: "feat/x", model: "openai/gpt-5#low" }, { sessionID: "ses_root" });
    expect(out).toContain("worktree feat/x (/repo/.worktrees/feat-x)");
    expect(h.sessions.get("ses_child_1")).toEqual({ directory: "/repo/.worktrees/feat-x", model: { providerID: "openai", id: "gpt-5", variant: "low" } });
    expect(h.herdr.of("agent.prompt").at(-1)!.params.text).toContain("on branch feat/x");
  });

  it("removes the child's session when the child never starts", async () => {
    const h = fakeHost(fakeHerdr({ startError: { code: "timeout", message: "agent did not start" } }));
    h.session("ses_root", { directory: "/repo" });
    const s = createServer(h.host);
    await s.pane.attach(PANE);
    await expect(s.execute({ action: "spawn", task: "t", name: "c" }, { sessionID: "ses_root" })).rejects.toThrow(/did not start/u);
    expect(h.removed).toEqual(["ses_child_1"]);
    expect(h.herdr.of("pane.close")[0]!.params).toEqual({ pane_id: "w1:p2" });
  });

  it("resumes saved children with a pending reply when a pane attaches, and forgets deleted sessions", async () => {
    const h = fakeHost();
    h.session("ses_root", { directory: "/repo" });
    h.storage.set("children:ses_root", { root: "ses_root", records: [{ name: "c", paneId: "w1:p2", where: "tab", cwd: "/repo", task: "t", createdAt: 0, awaiting: true, session: "ses_child_9" }] });
    const s = createServer(h.host);
    await s.ready;
    expect(await s.rpc.state({ sessionID: "ses_root" })).toEqual({ tokens: [] });
    await s.pane.attach(PANE);
    expect(await s.rpc.state({ sessionID: "ses_root" })).toEqual({ tokens: [{ sessionID: "ses_root", key: "bg", value: "child c", ttlMs: 90_000 }] });
    h.reply("ses_child_9", "PONG");
    h.herdr.state.agent.completion_seq = 2;
    await s.children("ses_root")!.tick();
    expect(h.delivered[0]!.text).toContain("PONG");
    s.forget("ses_root");
    expect(h.storage.has("children:ses_root")).toBe(false);
    await expect(s.execute({ action: "list" }, { sessionID: "ses_root" })).rejects.toThrow(/herdr pane/u);
  });

  it("rebinds children to a new pane without losing them", async () => {
    const h = fakeHost();
    h.session("ses_root", { directory: "/repo" });
    const s = createServer(h.host);
    await s.pane.attach(PANE);
    await s.execute({ action: "spawn", task: "t", name: "c" }, { sessionID: "ses_root" });
    await s.pane.detach({ sessionID: "ses_root", paneId: "w1:p1" });
    await expect(s.execute({ action: "list" }, { sessionID: "ses_root" })).rejects.toThrow(/herdr pane/u);
    await s.pane.attach({ ...PANE, paneId: "w1:p9" });
    expect(await s.execute({ action: "list" }, { sessionID: "ses_root" })).toMatch(/^c {2}idle \(reply pending\)/u);
    expect(await s.rpc.state({ sessionID: "ses_root" })).toEqual({ tokens: [{ sessionID: "ses_root", key: "bg", value: "child c", ttlMs: 90_000 }] });
  });
});
