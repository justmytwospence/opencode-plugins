import { afterEach, describe, expect, test } from "vitest";
import { STATE_TAG } from "../src/core/render.ts";
import { HerdrHold } from "../src/herdr.ts";
import { modeFromEnv } from "../src/mode.ts";
import type { Report } from "../src/rpc.ts";
import { Marimo, rankFor } from "../src/server.ts";
import { segments, shortSection, sidebarLines, ticking, view } from "../src/status.ts";
import { commandArg } from "../src/tui.ts";
import { EVENTS, FakeMarimo, RUNNING_AT, herdrRecorder, marimo, until } from "./harness.ts";

const running: Marimo[] = [];
afterEach(async () => {
  for (const m of running.splice(0)) await m.stop();
});

function start(fake: FakeMarimo) {
  const h = marimo(fake);
  h.marimo.start({ kind: "auto" });
  running.push(h.marimo);
  return h;
}

describe("server", () => {
  test("the turn's state block is appended to the turn's user message once per turn, and nothing without a notebook", async () => {
    const fake = new FakeMarimo();
    const { marimo } = start(fake);
    const user = () => ({ role: "user", content: [{ type: "text", text: "You are helpful." }] });
    const messages = [{ role: "assistant", content: [{ type: "text", text: "earlier" }] }, user()];
    const system = messages[1]!.content;
    await marimo.prompt("s1");
    marimo.context("s1", messages);
    expect(system).toHaveLength(1);

    fake.open("b1", "/w/nb.py");
    await marimo.prompt("s1");
    await until(() => marimo.followedFor("s1").some((f) => f.connection === "connected"));
    marimo.context("s1", messages);
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toMatch(new RegExp(`^<${STATE_TAG} notebooks="1">`));
    expect(system[1]!.text).toContain("=== /w/nb.py (current; http://127.0.0.1:2799, session b1) ===");
    expect(system[1]!.text).toContain("PKri: defines z -- ERROR ZeroDivisionError: division by zero");
    // The next request of the same turn: the same block, not a second one.
    const text = system[1]!.text;
    marimo.context("s1", messages);
    expect(system).toHaveLength(2);
    const again = [user()];
    marimo.context("s1", again);
    expect(again[0]!.content[1]!.text).toBe(text);
    // Earlier messages are left alone.
    expect(messages[0]!.content).toHaveLength(1);
    // The same block comes back in /marimo show.
    expect(marimo.snapshot("s1")).toContain("=== /w/nb.py");
  });

  test("a notebook under a hidden directory is left out; off follows nothing", async () => {
    const fake = new FakeMarimo();
    fake.open("b1", "/w/nb.py");
    fake.open("b2", "/w/.worktrees/x/nb.py");
    fake.open("b3", "/elsewhere/nb.py");
    const { marimo, changes } = start(fake);
    await until(() => marimo.report("s").notebooks.length === 1 && marimo.report("s").notebooks[0]!.connection === "connected");
    expect(marimo.report("s").notebooks[0]).toMatchObject({ path: "/w/nb.py", current: true, errors: 1, queued: 0 });
    const before = changes();
    marimo.setMode({ kind: "off" });
    await until(() => marimo.report("s").notebooks.length === 0);
    expect(marimo.report("s")).toEqual({ mode: "off", notebooks: [] });
    expect(changes()).toBeGreaterThan(before);
    marimo.setMode({ kind: "pinned", paths: ["/elsewhere/nb.py", "/w/missing.py"] });
    await until(() => marimo.report("s").notebooks.length === 1);
    expect(marimo.report("s")).toMatchObject({ mode: "pinned", pinned: ["/elsewhere/nb.py", "/w/missing.py"], notebooks: [{ path: "/elsewhere/nb.py" }] });
  });

  test("each session's current notebook is the one its agent worked in last", async () => {
    const fake = new FakeMarimo();
    fake.open("b1", "/w/fit.py");
    fake.open("b2", "/w/prep.py");
    const { marimo } = start(fake);
    await until(() => marimo.report("a").notebooks.filter((n) => n.connection === "connected").length === 2);
    expect(marimo.toolCall("a", { command: "bash execute-code.sh --url http://localhost:2799 --file prep.py - <<'PY'\nPY" })).toBe(true);
    expect(marimo.toolCall("b", { command: "marimo pair execute --url http://127.0.0.1:2799 --session b1 --code-file -" })).toBe(true);
    expect(marimo.toolCall("b", { command: "ls" })).toBe(false);
    expect(marimo.report("a").notebooks.map((n) => n.path)).toEqual(["/w/prep.py", "/w/fit.py"]);
    expect(marimo.report("b").notebooks.map((n) => n.path)).toEqual(["/w/fit.py", "/w/prep.py"]);
    expect(marimo.report("").notebooks.map((n) => n.current)).toEqual([true, false]);
    expect(marimo.snapshot("a")).toContain("=== /w/prep.py (current;");
    expect(marimo.snapshot("a")).toContain("=== /w/fit.py (also followed;");
  });

  test("a cell the agent started that outlives its turn holds the pane in herdr, then notifies", async () => {
    const fake = new FakeMarimo();
    fake.open("b1", "/w/nb.py", RUNNING_AT);
    const { marimo, herdr } = start(fake);
    await until(() => marimo.report("s").notebooks[0]?.running !== undefined);
    expect(marimo.report("s").notebooks[0]!.running).toMatchObject({ section: "Data loading › Slow model fit", cell: "lEQa" });
    // A turn in which the agent ran the notebook, ending while it still runs.
    marimo.turnBegan("s");
    marimo.toolCall("s", { command: "marimo pair execute --url http://127.0.0.1:2799 --file nb.py" });
    marimo.turnEnded("s");
    await until(() => herdr.calls.length === 1);
    expect(herdr.calls[0]).toEqual(["token", "s", "nb.py: Slow model fit"]);
    expect(marimo.holding("s")).toBe(true);
    // Another session that did nothing holds nothing.
    marimo.turnBegan("t");
    marimo.turnEnded("t");
    // The run ends: the token clears and a notification says so.
    fake.send("/w/nb.py", RUNNING_AT, EVENTS.length);
    await until(() => herdr.calls.some((c) => c[0] === "notify"));
    // The token followed the kernel (a queued cell in between), then cleared, then the notice.
    const last = herdr.calls.slice(-2);
    expect(herdr.calls.slice(1, -2).every((c) => c[0] === "token" && c[1] === "s" && typeof c[2] === "string")).toBe(true);
    expect(last[0]).toEqual(["token", "s", undefined]);
    expect(last[1]!.slice(0, 3)).toEqual(["notify", "s", "nb.py finished"]);
    expect(last[1]![3]).toMatch(/^ran \d+s · 1 error$/);
    expect(marimo.holding("s")).toBe(false);
  });

  test("a new turn releases the hold; herdr ready resends the token", async () => {
    const fake = new FakeMarimo();
    fake.open("b1", "/w/nb.py", RUNNING_AT);
    const { marimo, herdr } = start(fake);
    await until(() => marimo.report("s").notebooks[0]?.running !== undefined);
    marimo.turnBegan("s");
    marimo.toolCall("s", { command: "marimo pair execute --url http://127.0.0.1:2799 --file nb.py" });
    marimo.turnEnded("s");
    await until(() => herdr.calls.length === 1);
    await marimo.resendHerdr();
    expect(herdr.calls).toHaveLength(2);
    marimo.turnBegan("s");
    await until(() => herdr.calls.length === 3);
    expect(herdr.calls[2]).toEqual(["token", "s", undefined]);
    expect(marimo.holding("s")).toBe(false);
    // A turn that did not touch the notebook holds nothing; one that did holds again.
    marimo.turnEnded("s");
    expect(marimo.holding("s")).toBe(false);
    marimo.turnBegan("s");
    marimo.toolCall("s", { command: "marimo pair execute --url http://127.0.0.1:2799 --file nb.py" });
    marimo.turnEnded("s");
    expect(marimo.holding("s")).toBe(true);
    await until(() => herdr.calls.length === 4);
    // Forgetting the session (deleted) clears the token without a notice.
    marimo.forget("s");
    await until(() => herdr.calls.length === 5);
    expect(herdr.calls[4]).toEqual(["token", "s", undefined]);
  });

  test("ranking for a session follows the watcher's rule with the session's touches", () => {
    const nb = (lastActivity: number, run = false) => ({ lastActivity, running: () => (run ? {} : undefined) });
    const f = (path: string, connection: string, notebook: unknown) => ({ attachment: { url: "u", sessionId: "s", path }, notebook, connection, current: false, touchedAt: 0 }) as any;
    const followed = [f("/a", "connected", nb(5)), f("/b", "connected", nb(9)), f("/c", "disconnected", nb(99, true))];
    expect(rankFor(followed, new Map()).map((x) => x.attachment.path)).toEqual(["/b", "/a", "/c"]);
    const ranked = rankFor(followed, new Map([["/a", 1000]]));
    expect(ranked.map((x) => [x.attachment.path, x.current, x.touchedAt])).toEqual([["/a", true, 1000], ["/b", false, 0], ["/c", false, 0]]);
  });

  test("MARIMO_NOTEBOOK or the notebook option pins or turns off", () => {
    expect(modeFromEnv({})).toEqual({ kind: "auto" });
    expect(modeFromEnv({ MARIMO_NOTEBOOK: "/a/b.py" })).toEqual({ kind: "pinned", paths: ["/a/b.py"] });
    expect(modeFromEnv({ MARIMO_NOTEBOOK: "/a/b.py, /c.py" })).toEqual({ kind: "pinned", paths: ["/a/b.py", "/c.py"] });
    expect(modeFromEnv({ MARIMO_NOTEBOOK: "off" })).toEqual({ kind: "off" });
    expect(modeFromEnv({ MARIMO_NOTEBOOK: "off" }, { notebook: "/x.py" })).toEqual({ kind: "pinned", paths: ["/x.py"] });
  });
});

describe("herdr reports of the kernel hold", () => {
  test("the token while held, then cleared with a notification; nothing on a release", async () => {
    const { port, calls } = herdrRecorder();
    const herdr = new HerdrHold(port);
    await herdr.apply("s", { kind: "held", value: "fit.py: Model fit" });
    await herdr.apply("s", { kind: "none" });
    await herdr.apply("s", { kind: "finished", title: "fit.py finished", body: "ran 2m00s" });
    await herdr.apply("s", { kind: "released" });
    expect(calls).toEqual([
      ["token", "s", "fit.py: Model fit"],
      ["token", "s", undefined],
      ["notify", "s", "fit.py finished", "ran 2m00s"],
    ]);
  });
});

describe("terminal", () => {
  const nb = (path: string, extra: Partial<Report["notebooks"][number]> = {}): Report["notebooks"][number] => ({ path, connection: "connected", current: false, queued: 0, errors: 0, ...extra });

  test("the prompt line keeps the whole heading path only when short", () => {
    expect(shortSection("Data › Fit")).toBe("Data › Fit");
    expect(shortSection("Data loading › Slow model fit")).toBe("Slow model fit");
    expect(shortSection("A › An extremely long heading that goes on")).toBe("An extremely long hea…");
  });

  test("status line segments from a report", () => {
    expect(segments(view(undefined))).toBeUndefined();
    expect(segments(view({ mode: "off", notebooks: [] }))).toBeUndefined();
    expect(segments(view({ mode: "auto", notebooks: [] }))).toBeUndefined();
    expect(segments(view({ mode: "pinned", pinned: ["/w/fit.py"], notebooks: [] }))).toEqual([{ text: "marimo " }, { text: "fit.py not open", color: "warning" }]);
    expect(segments(view({ mode: "auto", notebooks: [nb("/w/fit.py", { current: true })] }))).toEqual([{ text: "marimo " }, { text: "fit.py", color: "accent" }]);
    const report: Report = {
      mode: "auto",
      notebooks: [nb("/w/fit.py", { current: true, connection: "connecting", errors: 2, running: { section: "Data › Fit", cell: "c1", since: 100_000 } }), nb("/w/prep.py")],
    };
    expect(ticking(report)).toBe(false); // not connected: no elapsed to tick
    expect(segments(view(report, 112_400))).toEqual([
      { text: "marimo " },
      { text: "fit.py", color: "accent" },
      { text: " · " },
      { text: "connecting", color: "warning" },
      { text: " · +1" },
    ]);
    report.notebooks[0]!.connection = "connected";
    expect(ticking(report)).toBe(true);
    expect(segments(view(report, 112_400))).toEqual([
      { text: "marimo " },
      { text: "▸ ", color: "warning" },
      { text: "Data › Fit 12s" },
      { text: " · " },
      { text: "2 errors", color: "error" },
      { text: " · +1" },
    ]);
  });

  test("the sidebar names every followed notebook, details for the current one", () => {
    const report: Report = {
      mode: "auto",
      notebooks: [nb("/w/fit.py", { current: true, running: { section: "Fit", cell: "c", since: 100_000 } }), nb("/w/prep.py")],
    };
    expect(sidebarLines(report, 112_000)).toEqual([
      [{ text: "marimo", color: "accent" }],
      [{ text: "▸ ", color: "warning" }, { text: "fit.py", color: "accent" }, { text: " · running Fit 12s" }],
      [{ text: "  prep.py" }],
    ]);
    expect(sidebarLines({ mode: "auto", notebooks: [] })).toBeUndefined();
  });

  test("the /marimo argument, with or without the command in front", () => {
    expect(commandArg(undefined)).toBe("");
    expect(commandArg("/marimo show")).toBe("show");
    expect(commandArg(" auto ")).toBe("auto");
    expect(commandArg("/marimo")).toBe("");
  });
});
