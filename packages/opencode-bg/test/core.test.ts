import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Bg, createBg } from "../src/core.ts";
import { Registry } from "../src/registry.ts";
import { call, fakeHost, until } from "./fake.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-core-"));
  process.env.OPENCODE_BG_DIR = dir;
});
afterAll(() => {
  delete process.env.OPENCODE_BG_DIR;
});

const made: Bg[] = [];
function setup(startupWaitMs = 200) {
  const reg = new Registry();
  const h = fakeHost();
  const bg = createBg(reg, h.host, { startupWaitMs });
  made.push(bg);
  return { reg, bg, ...h };
}
afterEach(async () => {
  for (const bg of made.splice(0)) await bg.dispose();
});

describe("bg_run", () => {
  it("starts a job and tells the agent to bg_wait; a command that fails at once is reported in the result", async () => {
    const { bg } = setup();
    const c = call("s", dir);
    const out = await bg.run({ command: "sleep 5", kind: "job", name: "slow" }, c);
    expect(out).toMatch(/^Started slow \(job [a-z0-9]{5}, pid \d+\)\. Log: /u);
    expect(out).toMatch(/call bg_wait instead of ending your turn/u);
    const failed = await bg.run({ command: "exit 2", kind: "job" }, c);
    expect(failed).toMatch(/ended at once/u);
    expect(failed).toMatch(/exit 2/u);
  });

  it("validates its arguments", async () => {
    const { bg } = setup();
    const c = call("s", dir);
    await expect(bg.run({ command: "true", kind: "job", ready: "x" }, c)).rejects.toThrow(/ready/u);
    await expect(bg.run({ command: "true", kind: "service", timeout: 5 }, c)).rejects.toThrow(/timeout/u);
    await expect(bg.run({ command: "true", kind: "job", cwd: "nope" }, c)).rejects.toThrow(/No such directory/u);
    await expect(bg.run({ command: "true", kind: "job", ready: "(" } as never, c)).rejects.toThrow();
  });

  it("names a marimo server after its notebook and knows when it is ready", async () => {
    const { bg } = setup(1_200);
    const out = await bg.run({ command: "marimo() { echo '  URL: http://localhost:2718'; sleep 5; }; marimo edit nb.py", kind: "service" }, call("s", dir));
    expect(out).toMatch(/Started marimo nb\.py \(service/u);
    expect(out).toMatch(/It is ready: +URL: http:\/\/localhost:2718/u);
  });
});

describe("wake-ups", () => {
  it("a job's end wakes its session once the session is idle, as one message with the report", async () => {
    const { bg, wakes, reg } = setup();
    await bg.run({ command: "echo out; exit 1", kind: "job", name: "quick" }, call("s", dir));
    // The startup check saw it end: no wake-up owed, it was in the result.
    expect(wakes).toEqual([]);
    bg.status("s", true);
    await bg.run({ command: "sleep 0.4; echo done-a", kind: "job", name: "a" }, call("s", dir));
    await bg.run({ command: "sleep 0.4; echo done-b", kind: "job", name: "b" }, call("s", dir));
    await until(() => reg.running("s").length === 0, 3_000);
    // Busy: nothing sent yet.
    expect(wakes).toEqual([]);
    bg.status("s", false);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.sessionID).toBe("s");
    expect(wakes[0]?.text).toMatch(/Background job a \(\w+\) ended: exit 0 after 0:00/u);
    expect(wakes[0]?.text).toMatch(/done-a/u);
    expect(wakes[0]?.text).toMatch(/---/u);
    expect(wakes[0]?.text).toMatch(/Background job b/u);
    expect(wakes[0]?.text).toMatch(/done-b/u);
  });

  it("a service wakes the agent when its ready line appears, and again if it exits", async () => {
    const { bg, wakes } = setup(100);
    await bg.run({ command: "sleep 0.3; echo 'Listening on :3000'; sleep 0.3; exit 0", kind: "service", name: "srv", ready: "listening on" }, call("s", dir));
    await until(() => wakes.length === 2, 4_000);
    expect(wakes[0]?.text).toMatch(/Background service srv \(\w+\) is ready: Listening on :3000/u);
    expect(wakes[1]?.text).toMatch(/Background service srv \(\w+\) ended: exit 0/u);
  });

  it("wake-ups go to the session that started the task", async () => {
    const { bg, wakes } = setup(100);
    await bg.run({ command: "sleep 0.3", kind: "job", name: "one" }, call("s1", dir));
    await bg.run({ command: "sleep 0.3", kind: "job", name: "two" }, call("s2", dir));
    await until(() => wakes.length === 2, 3_000);
    expect(wakes.map((w) => w.sessionID).sort()).toEqual(["s1", "s2"]);
  });

  it("what bg_logs or bg_kill already showed is no longer owed", async () => {
    const { bg, wakes, reg } = setup(100);
    bg.status("s", true);
    const c = call("s", dir);
    await bg.run({ command: "exit 4", kind: "job", name: "shown" }, c);
    await until(() => reg.running("s").length === 0);
    const id = reg.list("s")[0]?.id as string;
    expect(await bg.logs({ id }, c)).toMatch(/exit 4/u);
    const killed = await bg.run({ command: "sleep 5", kind: "job", name: "k" }, c);
    const kid = /job ([a-z0-9]{5})/u.exec(killed)?.[1] as string;
    expect(await bg.kill({ id: kid }, c)).toMatch(/^Stopped k/u);
    bg.status("s", false);
    expect(wakes).toEqual([]);
  });

  it("a task the user stops from the panel tells the agent so; one stopped with the session says nothing", async () => {
    const { bg, wakes, reg } = setup(100);
    await bg.run({ command: "sleep 5", kind: "job", name: "u" }, call("s", dir));
    const id = reg.running("s")[0]?.id as string;
    expect(await bg.stop(id)).toBe("stopped u");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toMatch(/The user stopped background task u/u);
    await bg.run({ command: "sleep 5", kind: "job", name: "gone" }, call("s", dir));
    await bg.sessionDeleted("s");
    expect(wakes).toHaveLength(1);
    expect(reg.list("s")).toEqual([]);
  });
});

describe("bg_wait", () => {
  it("waits inside the turn for the next job and returns its report, with other news", async () => {
    const { bg, wakes } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "sleep 0.5; echo first", kind: "job", name: "first" }, c);
    await bg.run({ command: "sleep 0.3; echo 'Up'; sleep 5", kind: "service", name: "srv", ready: "up" }, c);
    const out = await bg.wait({}, c);
    expect(out).toMatch(/^first \(job \w+\) · exit 0 after 0:00/u);
    expect(out).toMatch(/Also while you waited:\n- srv \(\w+\) is ready: Up/u);
    expect(c.titles[0]).toMatch(/^Waiting on first 0:00/u);
    expect(wakes).toEqual([]);
  });

  it("waits on a named task, or a service's readiness", async () => {
    const { bg, reg } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "sleep 0.3; echo 'ready now'; sleep 5", kind: "service", name: "srv", ready: "ready now" }, c);
    expect(await bg.wait({ id: "srv" }, c)).toMatch(/ready: ready now/u);
    // Already ready: returns at once.
    expect(await bg.wait({ id: "srv" }, c)).toMatch(/^srv \(service \w+\) · ready for/u);
    await bg.run({ command: "sleep 5", kind: "service", name: "plain" }, c);
    await expect(bg.wait({ id: "plain" }, c)).rejects.toThrow(/without a ready pattern/u);
    await expect(bg.wait({ id: "nothing" }, c)).rejects.toThrow(/No task matches "nothing"\. Known:/u);
    expect(reg.running("s")).toHaveLength(2);
    await reg.killAll("session");
  });

  it("returns early when the user sends a message, when interrupted, or at its timeout; the job keeps running", async () => {
    const { bg, reg } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "sleep 5", kind: "job", name: "long" }, c);
    const timed = await bg.wait({ timeout: 1 }, c);
    expect(timed).toMatch(/Stopped waiting after 0:01 \(the timeout\)\. Still running: long/u);
    const waiting = bg.wait({}, c);
    await new Promise((r) => setTimeout(r, 100));
    bg.enqueued("s", "m1");
    expect(await waiting).toMatch(/Stopped waiting: the user sent a message/u);
    // Queued messages: not waiting at all.
    expect(await bg.wait({}, c)).toMatch(/^Not waiting: a message from the user is queued/u);
    bg.dequeued("s", "m1");
    const interrupted = bg.wait({}, c);
    await new Promise((r) => setTimeout(r, 100));
    c.abort.abort();
    expect(await interrupted).toMatch(/Stopped waiting: interrupted/u);
    expect(reg.running("s")).toHaveLength(1);
    expect(reg.running("s")[0]?.delivered).toBe(false);
  });

  it("with no job running, says so", async () => {
    const { bg } = setup(100);
    const c = call("s", dir);
    expect(await bg.wait({}, c)).toBe("Nothing to wait for: no job is running.");
    await bg.run({ command: "sleep 5", kind: "service", name: "srv" }, c);
    expect(await bg.wait({}, c)).toMatch(/Services: srv \(starting\)/u);
    // Another session's job is not this session's.
    await bg.run({ command: "sleep 5", kind: "job", name: "theirs" }, call("other", dir));
    expect(await bg.wait({}, c)).toMatch(/^Nothing to wait for/u);
  });
});

describe("bg_logs and bg_kill", () => {
  it("lists the session's tasks, reads tails, heads and greps, and stops a task", async () => {
    const { bg } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "echo one; echo two; echo ERROR three; sleep 5", kind: "job", name: "job" }, c);
    await bg.run({ command: "sleep 5", kind: "job", name: "elsewhere" }, call("other", dir));
    const list = await bg.logs({}, c);
    expect(list).toMatch(/^\w{5} {2}job {2}job {2}running 0:00$/u);
    expect(await bg.logs({ id: "job", lines: 2 }, c)).toMatch(/2 last lines:\ntwo\nERROR three$/u);
    expect(await bg.logs({ id: "job", head: true, lines: 1 }, c)).toMatch(/1 first lines:\none$/u);
    expect(await bg.logs({ id: "job", grep: "error" }, c)).toMatch(/1 lines matching error:\nERROR three$/u);
    await expect(bg.logs({ id: "elsewhere" }, c)).rejects.toThrow(/No task matches/u);
    expect(await bg.kill({ id: "job" }, c)).toMatch(/^Stopped job \(\w+\) after 0:00\.\n\nLast lines:\none\ntwo\nERROR three$/u);
    expect(await bg.kill({ id: "job" }, c)).toMatch(/already ended: stopped after/u);
    expect(await bg.logs({}, call("none", dir))).toBe("No background tasks.");
  });
});

describe("the terminals and herdr", () => {
  it("snapshots carry waiting and willWake, change notices follow every change, and clear hides ended tasks", async () => {
    const { bg, changed } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "sleep 0.5", kind: "job", name: "w" }, c);
    expect(changed).toContain("s");
    const waiting = bg.wait({}, c);
    await new Promise((r) => setTimeout(r, 50));
    expect(bg.snapshot(["s"]).map((t) => [t.name, t.waiting, t.willWake, t.status])).toEqual([["w", true, true, "running"]]);
    expect(bg.snapshot(["other"])).toEqual([]);
    await waiting;
    expect(bg.snapshot(["s"]).map((t) => [t.waiting, t.willWake, t.status])).toEqual([[false, false, "done"]]);
    expect(bg.logTail(bg.snapshot(["s"])[0]?.id as string, 5)).toEqual([]);
    expect(bg.clear(["s"])).toBe(1);
    expect(bg.snapshot(["s"])).toEqual([]);
  });

  it("holds the herdr token `bg` while a job that will wake the agent runs, and resends it on request", async () => {
    const { bg, tokens, reg } = setup(100);
    const c = call("s", dir);
    await bg.run({ command: "sleep 0.5", kind: "job", name: "tests" }, c);
    expect(tokens).toEqual([{ sessionID: "s", value: "tests" }]);
    await bg.run({ command: "sleep 0.5", kind: "job", name: "build" }, c);
    expect(tokens.at(-1)).toEqual({ sessionID: "s", value: "tests · build" });
    await bg.run({ command: "sleep 0.5", kind: "job", name: "lint" }, c);
    expect(tokens.at(-1)).toEqual({ sessionID: "s", value: "3 jobs" });
    // A service without a wake-up owed holds nothing.
    await bg.run({ command: "sleep 5", kind: "service", name: "srv" }, call("s2", dir));
    expect(tokens.some((t) => t.sessionID === "s2")).toBe(false);
    bg.resendTokens();
    expect(tokens.at(-1)).toEqual({ sessionID: "s", value: "3 jobs" });
    await until(() => reg.running("s").length === 0, 3_000);
    // Idle: the wake-ups went out, so nothing is held.
    expect(tokens.at(-1)).toEqual({ sessionID: "s", value: undefined });
  });
});
