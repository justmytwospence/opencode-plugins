import { expect, test } from "vitest";
import { ageText, copiedMessage, dialogTitle, fuzzyFilter, fuzzyScore, rowFor } from "../src/picker.ts";
import type { Segment } from "../src/segments.ts";

const seg = (id: string, kind: Segment["kind"], text: string, turn = 0, lang?: string): Segment => ({ id, kind, text, turn, order: 0, ...(lang ? { lang } : {}) });

test("rows: the piece on one line, kind and age in the footer", () => {
  expect(rowFor(seg("S001", "code", "const a = 1;\nconst b = 2;", 1, "ts"), 3)).toEqual({ title: "ts: const a = 1; const b = 2;", value: "S001", footer: "code · 2t ago" });
  expect(rowFor(seg("S002", "user", "hi", 3), 3).footer).toBe("you · now");
  expect(ageText(seg("S003", "url", "https://x", 0), 0)).toBe("now");
});

test("the title names the tab and how Suggested was ordered", () => {
  expect(dialogTitle("suggested", "pending", 4)).toBe("Copy from this session · suggested · ranking… · 4");
  expect(dialogTitle("suggested", "done", 4)).toBe("Copy from this session · suggested · 4");
  expect(dialogTitle("suggested", "unavailable", 4)).toBe("Copy from this session · suggested (by recency) · 4");
  expect(dialogTitle("all", "pending", 9)).toBe("Copy from this session · all · 9");
});

test("the toast says what was copied", () => {
  expect(copiedMessage(seg("S1", "code", "a\nb", 0, "py"))).toBe("Copied py code (2 lines, 3 chars)");
  expect(copiedMessage(seg("S1", "command", "ls"))).toBe("Copied command (1 line, 2 chars)");
});

test("fuzzy: characters in order, word starts and runs score better, every token must match", () => {
  expect(fuzzyScore("gst", "git status")).toBeDefined();
  expect(fuzzyScore("xyz", "git status")).toBeUndefined();
  expect(fuzzyScore("", "anything")).toBe(0);
  expect(fuzzyScore("status", "git status")! < fuzzyScore("sttus", "git status")!).toBe(true);
  const items = ["npm install opencode-copy", "git status --short", "https://opencode.ai/docs", "git commit -m 'fix'"];
  expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  expect(fuzzyFilter(items, "git", (s) => s)).toEqual(["git status --short", "git commit -m 'fix'"]);
  expect(fuzzyFilter(items, "git fix", (s) => s)).toEqual(["git commit -m 'fix'"]);
  expect(fuzzyFilter(items, "opencode", (s) => s)).toEqual(expect.arrayContaining(["npm install opencode-copy", "https://opencode.ai/docs"]));
  expect(fuzzyFilter(items, "npm", (s) => s)[0]).toBe("npm install opencode-copy");
});
