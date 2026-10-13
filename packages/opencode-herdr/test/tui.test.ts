import { describe, expect, it } from "vitest";
import type { HerdrToken } from "../src/herdr-rpc.ts";
import { TokenView, type TuiHost, createPaneView, displayAgent, lastModel, sessionTitle } from "../src/tui.ts";
import { fakeCall } from "./core/fake.ts";

const TARGET = { socketPath: "/tmp/herdr.sock", paneId: "w1:p1" };
/** Let the reporters' queued sends reach the fake herdr. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function world() {
  const f = fakeCall({
    "pane.get": () => ({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", focused: false } } }),
    "pane.layout": () => ({ result: { layout: { zoomed: false } } }),
  });
  const state = new Map<string, HerdrToken[]>();
  const attached: { sessionID: string; paneId: string }[] = [];
  const detached: { sessionID: string; paneId: string }[] = [];
  const execs: string[][] = [];
  let shown: string | undefined;
  let gh = { code: 0, stdout: JSON.stringify({ number: 12, state: "OPEN", reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "" };
  const parents: Record<string, string> = { ses_sub: "ses_root" };
  const host: TuiHost = {
    shown: () => shown,
    root: (id) => parents[id] ?? id,
    family: (root) => Object.entries(parents).filter(([, p]) => p === root).map(([c]) => c),
    title: (id) => (id === "ses_root" ? "Fix the auth flow" : undefined),
    directory: () => "/repo",
    model: () => ({ modelID: "claude-opus-4-6", variant: "high" }),
    attach: async (a) => void attached.push({ sessionID: a.sessionID, paneId: a.paneId }),
    detach: async (d) => void detached.push(d),
    state: async (id) => state.get(id) ?? [],
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      return gh;
    },
    prEnabled: true,
  };
  const scheduled: (() => void)[] = [];
  const view = createPaneView(TARGET, f.call, host, (fn) => void scheduled.push(fn));
  const reports = () => f.of("pane.report_metadata").map((l) => l.params);
  return { f, view, state, attached, detached, execs, scheduled, reports, show: (id: string | undefined) => void (shown = id), setGh: (g: typeof gh) => void (gh = g) };
}

describe("presentation", () => {
  it("names the agent from the model and variant", () => {
    expect(displayAgent({ modelID: "claude-opus-4-6", variant: "high" })).toBe("opencode opus-4-6:high");
    expect(displayAgent({ id: "gpt-5" })).toBe("opencode gpt-5");
    expect(displayAgent(undefined)).toBe("opencode");
    expect(lastModel([{ model: { id: "a" } }, {}, { model: { id: "b", variant: "low" } }, {}])).toEqual({ id: "b", variant: "low" });
    expect(lastModel([])).toBeUndefined();
  });

  it("ignores OpenCode's placeholder titles", () => {
    expect(sessionTitle("New session - 2026-09-23T22:19:40.673Z")).toBeUndefined();
    expect(sessionTitle("Untitled")).toBeUndefined();
    expect(sessionTitle(" Fix auth flow ")).toBe("Fix auth flow");
    expect(sessionTitle(undefined)).toBeUndefined();
  });

  it("merges one key over several sessions of the family", () => {
    const v = new TokenView();
    v.set({ sessionID: "a", key: "bg", value: "child x", ttlMs: 90_000 });
    v.set({ sessionID: "b", key: "bg", value: "subagents (2)" });
    expect(v.value("bg")).toBe("child x · subagents (2)");
    expect(v.ttl("bg")).toBe(90_000);
    v.set({ sessionID: "a", key: "bg" });
    expect(v.value("bg")).toBe("subagents (2)");
    v.set({ sessionID: "b", key: "bg", value: "" });
    expect(v.value("bg")).toBeUndefined();
    expect(v.keys()).toEqual([]);
  });
});

describe("pane view", () => {
  it("reports the shown session's title and agent, attaches its root, and loads the family's tokens", async () => {
    const w = world();
    w.state.set("ses_root", [{ sessionID: "ses_root", key: "nb", value: "notebook" }]);
    w.state.set("ses_sub", [{ sessionID: "ses_sub", key: "bg", value: "subagents (1)", ttlMs: 90_000 }]);
    await w.view.tick();
    expect(w.view.shownRoot).toBeUndefined();
    expect(w.reports().at(-1)).toMatchObject({ agent: "opencode", applies_to_source: "herdr:opencode", clear_title: true, display_agent: "opencode" });

    w.show("ses_sub");
    await w.view.tick();
    await flush();
    expect(w.view.shownRoot).toBe("ses_root");
    expect(w.attached).toEqual([{ sessionID: "ses_root", paneId: "w1:p1" }]);
    const tokens = w.reports().filter((p) => p.tokens);
    expect(tokens.map((p) => p.tokens)).toEqual([{ nb: "notebook" }, { bg: "subagents (1)" }]);
    expect(w.reports().at(-1)).toMatchObject({ display_agent: "opencode opus-4-6:high", clear_title: true });

    w.show("ses_root");
    await w.view.tick();
    await flush();
    expect(w.attached).toHaveLength(1);
    const last2 = w.reports().slice(-2);
    expect(last2.find((p) => p.title)).toMatchObject({ title: "Fix the auth flow", display_agent: "opencode opus-4-6:high" });
    expect(last2.find((p) => p.tokens)!.tokens).toEqual({ task: "Fix the auth flow" });
  });

  it("applies token, notify and zoom events of the shown family only", async () => {
    const w = world();
    w.show("ses_root");
    await w.view.tick();
    w.view.token({ sessionID: "ses_sub", key: "bg", value: "child x", ttlMs: 90_000 });
    w.view.token({ sessionID: "ses_other", key: "bg", value: "not mine" });
    await flush();
    expect(w.reports().at(-1)).toMatchObject({ tokens: { bg: "child x" }, ttl_ms: 90_000 });
    await w.view.notify({ sessionID: "ses_other", title: "nope" });
    await w.view.notify({ sessionID: "ses_sub", title: "done", body: "all green", sound: "done" });
    expect(w.f.of("notification.show").map((l) => l.params)).toEqual([{ title: "done", body: "all green", sound: "done" }]);
    await w.view.zoom({ sessionID: "ses_root", holder: "review", active: true });
    await w.view.zoom({ sessionID: "ses_root", holder: "diff", active: true });
    await w.view.zoom({ sessionID: "ses_root", holder: "review", active: false });
    expect(w.f.of("pane.zoom").map((l) => l.params.mode)).toEqual(["on"]);
    await w.view.zoom({ sessionID: "ses_root", holder: "diff", active: false });
    expect(w.f.of("pane.zoom").map((l) => l.params.mode)).toEqual(["on", "off"]);
  });

  it("clears the family's tokens and detaches when the pane shows another session; ready reloads", async () => {
    const w = world();
    w.show("ses_root");
    await w.view.tick();
    w.view.token({ sessionID: "ses_root", key: "nb", value: "notebook" });
    await flush();
    w.show("ses_other");
    await w.view.tick();
    await flush();
    expect(w.detached).toEqual([{ sessionID: "ses_root", paneId: "w1:p1" }]);
    expect(w.attached.at(-1)).toEqual({ sessionID: "ses_other", paneId: "w1:p1" });
    expect(w.reports().some((p) => p.tokens && p.tokens.nb === null)).toBe(true);
    w.state.set("ses_other", [{ sessionID: "ses_other", key: "x", value: "1" }]);
    await w.view.ready();
    await flush();
    expect(w.attached).toHaveLength(3);
    expect(w.reports().at(-1)).toMatchObject({ tokens: { x: "1" } });
    await w.view.dispose();
    expect(w.detached.at(-1)).toEqual({ sessionID: "ses_other", paneId: "w1:p1" });
    expect(w.reports().at(-1)).toMatchObject({ tokens: { x: null } });
  });

  it("reports the branch's PR on the space after a turn and clears it when there is none", async () => {
    const w = world();
    w.show("ses_root");
    await w.view.tick();
    w.view.turnEnded("ses_other");
    expect(w.scheduled).toHaveLength(0);
    w.view.turnEnded("ses_sub");
    expect(w.scheduled).toHaveLength(1);
    await w.view.refreshPr();
    await flush();
    expect(w.execs[0]).toEqual(["gh", "pr", "view", "--json", "number,state,isDraft,reviewDecision,statusCheckRollup"]);
    expect(w.f.of("workspace.report_metadata").at(-1)!.params).toMatchObject({ workspace_id: "w1", tokens: { pr: "#12 ✓ approved" }, ttl_ms: 600_000 });
    w.setGh({ code: 1, stdout: "", stderr: "no pull requests found for branch" });
    await w.view.refreshPr();
    await flush();
    expect(w.f.of("workspace.report_metadata").at(-1)!.params.tokens).toEqual({ pr: null });
  });
});
