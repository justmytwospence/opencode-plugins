import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { isAcceptEditsBash } from "../src/bash.ts";
import { cycleOf, nextMode, parseMode } from "../src/modes.ts";
import { footerText, parseCommand } from "../src/tui.ts";
import { risky, setup } from "./harness.ts";

process.env.XDG_CONFIG_HOME = path.join(mkdtempSync(path.join(tmpdir(), "gate-modes-")), "config");

describe("mode helpers", () => {
  test("parseMode takes config values, Claude Code names and short names", () => {
    expect(parseMode("manual")).toBe("default");
    expect(parseMode("acceptEdits")).toBe("acceptEdits");
    expect(parseMode("accept-edits")).toBe("acceptEdits");
    expect(parseMode("bypass")).toBe("bypassPermissions");
    expect(parseMode("nope")).toBeUndefined();
  });

  test("the cycle follows Claude Code's order", () => {
    const all = ["auto", "plan", "default", "acceptEdits", "bypassPermissions"] as const;
    expect(cycleOf(all)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
    expect(nextMode("auto", ["default", "acceptEdits", "plan", "auto"])).toBe("default");
    expect(nextMode("bypassPermissions", ["default", "auto"])).toBe("default");
  });

  test("the footer shows the mode, with Jev's counts where Jev judges", () => {
    expect(footerText({ mode: "auto", counts: { auto: 3, pushedBack: 1, asked: 0 } })).toBe("auto mode on · 3 auto · 1 pushed back · 0 asked");
    expect(footerText({ mode: "default", counts: { auto: 3, pushedBack: 1, asked: 0 } })).toBe("manual mode on");
    expect(footerText({ mode: "bypassPermissions", counts: { auto: 0, pushedBack: 0, asked: 0 } })).toBe("bypass permissions on");
  });

  test("/tool-gate words", () => {
    expect(parseCommand(undefined)).toEqual({ action: "status" });
    expect(parseCommand("mode")).toEqual({ action: "select" });
    expect(parseCommand("mode accept-edits")).toEqual({ action: "set", mode: "acceptEdits" });
    expect(parseCommand("bypass")).toEqual({ action: "set", mode: "bypassPermissions" });
    expect(parseCommand("on")).toEqual({ action: "set", mode: "auto" });
    expect(parseCommand("off")).toEqual({ action: "set", mode: "bypassPermissions" });
    expect(parseCommand("cycle")).toEqual({ action: "cycle" });
    expect(parseCommand("mode nope")).toEqual({ action: "unknown", word: "nope" });
  });
});

describe("isAcceptEditsBash", () => {
  const cwd = "/Users/me/Projects/app";
  test("filesystem commands inside the project", () => {
    expect(isAcceptEditsBash("mkdir -p src/new && touch src/new/a.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("mv src/a.ts src/b.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("sed -i 's/a/b/' src/a.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("rm -rf build && ls", cwd)).toBe(true);
  });
  test("anything else, or a file outside the project, is not covered", () => {
    expect(isAcceptEditsBash("npm install", cwd)).toBe(false);
    expect(isAcceptEditsBash("cp src/a.ts /tmp/a.ts", cwd)).toBe(false);
    expect(isAcceptEditsBash("cd /tmp && touch x", cwd)).toBe(false);
    expect(isAcceptEditsBash("rm -rf .", cwd)).toBe(false);
    expect(isAcceptEditsBash("touch .env", cwd)).toBe(false);
    expect(isAcceptEditsBash("sed -i 's/a/b/w out' src/a.ts", cwd)).toBe(false);
    expect(isAcceptEditsBash("touch $(echo x)", cwd)).toBe(false);
    expect(isAcceptEditsBash("echo hi > src/a.ts", cwd)).toBe(false);
  });
});

describe("modes", () => {
  test("a new session starts in the configured mode; a stored mode and a parent's mode are inherited", async () => {
    const s = setup({ stored: { resumed: "acceptEdits" }, parents: { child: "s" } });
    expect(await s.gate.mode("s")).toBe("auto");
    expect(await s.gate.mode("resumed")).toBe("acceptEdits");
    expect(await s.gate.mode("child")).toBe("auto");
    expect(await s.gate.setMode("s", "manual")).toBe("default");
    expect(await s.gate.mode("child")).toBe("default");
    expect(s.stored.get("s")).toBe("default");
    expect(s.changes.at(-1)).toMatchObject({ sessionID: "s", mode: "default", previous: "auto" });
    expect(await s.gate.setMode("s", "nope")).toBeUndefined();

    const off = setup({ options: { enabled: false } });
    expect(await off.gate.mode("s")).toBe("bypassPermissions");
  });

  test("cycleMode steps through the configured cycle", async () => {
    const s = setup();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(await s.gate.cycleMode("s"));
    expect(seen).toEqual(["default", "acceptEdits", "auto", "default"]);
    expect((await s.gate.status("s")).cycle).toEqual(["default", "acceptEdits", "auto"]);
  });

  test("manual mode asks about anything that does more than read, without Jev; always grants similar calls", async () => {
    const s = setup();
    await s.gate.setMode("s", "manual");
    expect(await s.call("read", { path: "a.ts" })).toEqual({ effect: "allow" });
    const edit = await s.call("edit", { path: "src/a.ts", oldString: "a", newString: "b" });
    expect(edit.effect).toBe("ask");
    expect(edit.message).toMatch(/^manual mode: tool-gate asks/u);
    s.reply("always");
    expect(await s.call("edit", { path: "src/b.ts", oldString: "a", newString: "b" })).toEqual({ effect: "allow" });
    expect((await s.call("edit", { path: "lib/b.ts", oldString: "a", newString: "b" })).effect).toBe("ask");
    const held = await s.call("shell", { command: "sudo ls" });
    expect(held.effect).toBe("ask");
    expect(held.message).toMatch(/Held: runs as root/u);
    s.reply("always");
    expect((await s.call("shell", { command: "sudo ls" })).effect).toBe("ask");
    expect(s.sent).toHaveLength(0);
    expect(s.changes.at(-1)?.counts).toEqual({ auto: 2, pushedBack: 0, asked: 4 });
  });

  test("accept-edits mode runs project edits and filesystem commands, asks about the rest", async () => {
    const s = setup();
    await s.gate.setMode("s", "accept-edits");
    expect(await s.call("write", { path: "src/new.ts", content: "x" })).toEqual({ effect: "allow" });
    expect(await s.call("shell", { command: "mkdir -p src/lib" })).toEqual({ effect: "allow" });
    expect((await s.call("write", { path: "/etc/hosts", content: "x" })).effect).toBe("ask");
    expect((await s.call("shell", { command: "npm publish" })).effect).toBe("ask");
    expect((await s.call("shell", { command: "touch x", workdir: "/tmp" })).effect).toBe("ask");
    expect(s.sent).toHaveLength(0);
  });

  test("bypass mode runs everything but critical removals", async () => {
    const s = setup({ answers: risky });
    await s.gate.setMode("s", "bypass");
    expect(await s.call("shell", { command: "npm publish" }, { effect: "ask" })).toEqual({ effect: "allow" });
    expect(await s.call("write", { path: "/etc/hosts", content: "x" }, { effect: "ask" })).toEqual({ effect: "allow" });
    const held = await s.call("shell", { command: "rm -rf ~" });
    expect(held.effect).toBe("ask");
    expect(held.message).toMatch(/deletes ~/u);
    expect(s.sent).toHaveLength(0);
  });

  test("plan mode denies edits; commands go to Jev", async () => {
    const s = setup();
    await s.gate.setMode("s", "plan");
    const edit = await s.call("edit", { path: "src/a.ts", oldString: "a", newString: "b" });
    expect(edit.effect).toBe("deny");
    expect(edit.message).toMatch(/Plan mode is on/u);
    expect(await s.call("shell", { command: "npm test" })).toEqual({ effect: "allow" });
    expect(s.sent).toHaveLength(1);
  });

  test("forget drops a session's mode and state", async () => {
    const s = setup();
    await s.gate.setMode("s", "manual");
    s.gate.forget("s");
    s.stored.clear();
    expect(await s.gate.mode("s")).toBe("auto");
  });
});
