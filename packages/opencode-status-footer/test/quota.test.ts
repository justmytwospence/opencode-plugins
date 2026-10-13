import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { countdown, formatWindow, fresh, parseClaudeUsage, readClaudeCache, severity } from "../src/quota.ts";
import { QuotaBook } from "../src/server.ts";

const t0 = Date.UTC(2026, 9, 1, 12);
const H = 3_600_000;

test("Anthropic's unified headers become 5h and week windows", async () => {
  const book = new QuotaBook();
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": String((t0 + 2 * H) / 1000),
    "anthropic-ratelimit-unified-7d-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-reset": String((t0 + 72 * H) / 1000),
  });
  expect(book.observe("anthropic", headers, t0)).toBe(true);
  expect(book.observe("anthropic", headers, t0 + 1000)).toBe(false);
  const quota = await book.quota(t0, async () => []);
  expect(quota.accounts).toHaveLength(1);
  expect(quota.accounts[0]!.windows.map((w) => formatWindow(w, t0))).toEqual(["5h 42% 2h00m", "week 10% 3d"]);
});

test("other hosts and header-less responses change nothing; Codex windows are named by length", async () => {
  const book = new QuotaBook();
  expect(book.observe("typesafe", new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.9" }), t0)).toBe(false);
  expect(book.observe("anthropic", new Headers(), t0)).toBe(false);
  book.observe("chatgpt", new Headers({ "x-codex-primary-used-percent": "12", "x-codex-primary-window-minutes": "300" }), t0);
  const quota = await book.quota(t0, async () => []);
  expect(quota.accounts.map((a) => a.name)).toEqual(["Codex"]);
  expect(quota.accounts[0]!.windows[0]!.label).toBe("5h");
});

test("without response readings, Claude Code's cache stands in", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "status-footer-"));
  const file = path.join(dir, "oauth-usage.json");
  writeFileSync(file, JSON.stringify({ five_hour: { utilization: 55, resets_at: new Date(t0 + H).toISOString() }, seven_day: { utilization: 20 } }));
  const windows = await readClaudeCache(file);
  expect(windows.map((w) => [w.label, w.used])).toEqual([["5h", 0.55], ["week", 0.2]]);
  const book = new QuotaBook();
  const quota = await book.quota(Date.now(), async () => windows);
  expect(quota.accounts[0]).toMatchObject({ name: "Claude", source: "Claude Code" });
  expect(await readClaudeCache(path.join(dir, "missing.json"))).toEqual([]);
});

test("stale and reset windows drop out; severity and countdowns", () => {
  const w = { label: "5h", used: 0.95, at: t0, resetsAt: t0 + H };
  expect(fresh([w], t0 + 5 * 60_000)).toHaveLength(1);
  expect(fresh([w], t0 + 11 * 60_000)).toHaveLength(0);
  expect(fresh([{ ...w, at: t0 + 2 * H }], t0 + 2 * H)).toHaveLength(0);
  expect([severity(0.5), severity(0.7), severity(0.95)]).toEqual([undefined, "warning", "error"]);
  expect([countdown(0), countdown(59_000), countdown(90 * 60_000), countdown(50 * H)]).toEqual(["now", "1m", "1h30m", "2d"]);
  expect(parseClaudeUsage({ limits: [{ kind: "session", percent: 30 }] }, t0)).toEqual([{ label: "5h", used: 0.3, at: t0 }]);
});
