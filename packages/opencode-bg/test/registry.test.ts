import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tail } from "../src/log.ts";
import { Registry, type TaskEvent, bgDir, groupAlive } from "../src/registry.ts";
import { until } from "./fake.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-reg-"));
  process.env.OPENCODE_BG_DIR = dir;
});
afterAll(() => {
  delete process.env.OPENCODE_BG_DIR;
});

const base = { sessionID: "s1" };

describe("registry", () => {
  it("runs a job to completion with its output in the session's log directory", async () => {
    const reg = new Registry();
    const events: TaskEvent["type"][] = [];
    reg.subscribe((e) => events.push(e.type));
    const t = reg.start({ ...base, command: "echo hello; echo err >&2", name: "hi", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.exitCode).toBe(0);
    expect(tail(t.logPath, 5)).toEqual(["hello", "err"]);
    expect(path.dirname(t.logPath)).toBe(path.join(bgDir(), "s1"));
    expect(events).toEqual(["start", "end"]);
  });

  it("reports a failing job", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "exit 3", name: "fail", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(3);
  });

  it("sees a service's ready line, then kills its whole process group", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & echo 'Listening on :3000'; wait", name: "srv", kind: "service", cwd: dir, ready: "listening on" });
    await until(() => t.ready, 4_000);
    expect(t.readyLine).toBe("Listening on :3000");
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.kill(t.id, "agent");
    expect(t.status).toBe("killed");
    await until(() => !groupAlive(t.pid as number), 2_000);
  });

  it("times a job out", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30", name: "slow", kind: "job", cwd: dir, timeoutSec: 0.3 });
    await until(() => t.status !== "running", 5_000);
    expect(t.status).toBe("timeout");
  });

  it("finds tasks by id, prefix or name, within a session", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "true", name: "named", kind: "job", cwd: dir });
    expect(reg.find(t.id)).toBe(t);
    expect(reg.find("named", "s1")).toBe(t);
    expect(reg.find(t.id.slice(0, 4), "s1")).toBe(t);
    expect(reg.find(t.id, "other")).toBeUndefined();
    expect(reg.list("other")).toEqual([]);
    await until(() => t.status !== "running");
  });

  it("a session's end kills its tasks but not another session's, nor kept services", async () => {
    const reg = new Registry();
    const mine = reg.start({ ...base, command: "sleep 31", name: "mine", kind: "job", cwd: dir });
    const kept = reg.start({ ...base, command: "sleep 32", name: "kept", kind: "service", cwd: dir, keep: true });
    const other = reg.start({ sessionID: "s2", command: "sleep 33", name: "other", kind: "job", cwd: dir });
    await reg.killAll("session", "s1");
    expect(mine.status).toBe("killed");
    expect(mine.killedBy).toBe("session");
    expect(kept.status).toBe("running");
    expect(other.status).toBe("running");
    reg.forget("s1");
    expect(reg.tasks.has(mine.id)).toBe(false);
    expect(reg.tasks.has(kept.id)).toBe(true);
    await reg.killAll("session");
    expect(other.status).toBe("killed");
    expect(kept.status).toBe("running");
    await reg.kill(kept.id, "user");
  });

  it("a later server kills a crashed server's leftovers, checking each pid still runs our command", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 34", name: "kept", kind: "service", cwd: dir, keep: true });
    const orphan = a.start({ ...base, command: "sleep 35", name: "orphan", kind: "job", cwd: dir });
    const other = a.start({ ...base, command: "sleep 36", name: "other", kind: "job", cwd: dir });
    // Pretend the owner crashed: move its state file to a dead pid's name, and make one entry's
    // command not match what its pid runs (as if the pid had been reused).
    const own = path.join(dir, "state", fs.readdirSync(path.join(dir, "state")).find((n) => n.startsWith(`${process.pid}-`)) as string);
    const entries = JSON.parse(fs.readFileSync(own, "utf8")).map((e: { name: string }) => (e.name === "other" ? { ...e, command: "something else entirely" } : e));
    fs.rmSync(own);
    fs.writeFileSync(path.join(dir, "state", "999999.json"), JSON.stringify(entries));
    const b = new Registry();
    expect(b.sweep()).toEqual(["orphan"]);
    await until(() => !groupAlive(orphan.pid as number), 3_000);
    expect(groupAlive(kept.pid as number)).toBe(true);
    // Not ours any more: left alone.
    expect(groupAlive(other.pid as number)).toBe(true);
    expect(fs.existsSync(path.join(dir, "state", "999999.json"))).toBe(false);
    await a.kill(kept.id, "user");
    await a.kill(other.id, "user");
    await until(() => a.tasks.get(orphan.id)?.status !== "running");
  });

  it("an exit 0 that races a stop still reads as done; processes the shell left behind die with the session", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & exit 0", name: "leaves", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.strays).toBe(true);
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.killAll("session", "s1");
    await until(() => !groupAlive(t.pid as number), 3_000);
  });

  it("a running log past the cap is cut back to its tail", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "for i in $(seq 1 400); do echo line-$i; done; sleep 3", name: "chatty", kind: "job", cwd: dir });
    await until(() => (tail(t.logPath, 1)[0] ?? "") === "line-400", 3_000);
    reg.capLogs(1_000, 200);
    const lines = tail(t.logPath, 100);
    expect(lines[0]).toMatch(/^\[bg\] log cut at /u);
    expect(lines.at(-1)).toBe("line-400");
    expect(fs.statSync(t.logPath).size).toBeLessThan(300);
    await reg.kill(t.id, "agent");
  });
});
