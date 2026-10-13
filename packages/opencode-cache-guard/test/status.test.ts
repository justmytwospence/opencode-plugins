import { expect, test } from "vitest";

import type { Snapshot } from "../src/clock.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import { coldCost, coldReason, fromMessages, herdrValue, statusLines, view, warningLine } from "../src/status.ts";
import { assistant, compaction, user } from "./messages.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const opus = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
const snap = (over: Partial<Snapshot>): Snapshot => ({
  sessionID: "s", lastAt: NOW - 60_000, ttlMs: 300_000, tokens: 600_000, price: opus, model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, updatedAt: NOW, ...over,
});

test("view and cold reason follow the TTL, or the idle limit without one", () => {
  expect(view(snap({}), NOW, DEFAULT_SETTINGS)).toEqual({ left: "4:00" });
  expect(view(snap({ lastAt: NOW - 900_000 }), NOW, DEFAULT_SETTINGS)).toEqual({ cold: "cold" });
  expect(view(snap({ ttlMs: undefined }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(view(snap({ ttlMs: undefined, lastAt: NOW - 4 * 3_600_000 }), NOW, DEFAULT_SETTINGS)).toEqual({ cold: "cold?" });
  expect(view(snap({ lastAt: 0 }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(coldReason(snap({}), undefined, NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(coldReason(snap({ lastAt: NOW - 900_000 }), undefined, NOW, DEFAULT_SETTINGS)).toEqual({ kind: "expired", idleMs: 600_000 });
  expect(coldReason(snap({ ttlMs: undefined, lastAt: NOW - 4 * 3_600_000 }), undefined, NOW, DEFAULT_SETTINGS)).toEqual({ kind: "idle", idleMs: 4 * 3_600_000 });
  // The selected model is not the one the conversation was cached for.
  expect(coldReason(snap({}), { providerID: "anthropic", modelID: "claude-sonnet-5" }, NOW, DEFAULT_SETTINGS)).toEqual({ kind: "model", from: "claude-opus-5-5", to: "claude-sonnet-5" });
  expect(coldReason(snap({}), { providerID: "anthropic", modelID: "claude-opus-5-5" }, NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(coldReason(undefined, undefined, NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(coldCost(snap({}))).toBeCloseTo((600_000 * (5 - 0.2)) / 1e6);
  expect(coldCost(snap({ price: undefined }))).toBeUndefined();
});

test("herdr token: big cold caches only, priced from the snapshot", () => {
  expect(herdrValue(snap({}), NOW, DEFAULT_SETTINGS)).toBeUndefined();
  expect(herdrValue(snap({ lastAt: NOW - 900_000 }), NOW, DEFAULT_SETTINGS)).toBe("cold 600k");
  expect(herdrValue(snap({ lastAt: NOW - 900_000, tokens: 50_000 }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
  // No price (an OpenAI session): the token threshold applies, and the idle guess is marked.
  expect(herdrValue(snap({ price: undefined, ttlMs: undefined, lastAt: NOW - 4 * 3_600_000, tokens: 180_000 }), NOW, DEFAULT_SETTINGS)).toBe("cold? 180k");
  expect(herdrValue(snap({ lastAt: NOW - 900_000 }), NOW, mergeSettings(DEFAULT_SETTINGS, ['{"herdr":{"enabled":false}}']))).toBeUndefined();
});

test("fromMessages: the clock and size from the last assistant message, none past a compaction", () => {
  const ttl = (m: { providerID: string }) => (m.providerID === "anthropic" ? 300_000 : undefined);
  const price = () => opus;
  const reply = (created: number, extra: Record<string, unknown> = {}) =>
    assistant(["ok"], [], { model: { providerID: "anthropic", id: "claude-opus-5-5" }, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 500_000, write: 1_000 } }, time: { created }, ...extra });
  const s = fromMessages("s", [user("a"), reply(NOW - 10_000), user("b")] as never, ttl, price, NOW);
  expect(s).toEqual({ sessionID: "s", lastAt: NOW - 10_000, tokens: 501_120, model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, ttlMs: 300_000, price: opus, updatedAt: NOW });
  expect(fromMessages("s", [user("a"), reply(NOW - 10_000), compaction("summary")] as never, ttl, price, NOW)).toBeUndefined();
  expect(fromMessages("s", [user("a"), reply(NOW - 10_000), compaction("", "failed")] as never, ttl, price, NOW)?.lastAt).toBe(NOW - 10_000);
  // A reply without usage (an error) does not count; the one before it does.
  expect(fromMessages("s", [reply(NOW - 20_000), reply(NOW - 10_000, { tokens: undefined })] as never, ttl, price, NOW)?.lastAt).toBe(NOW - 20_000);
  expect(fromMessages("s", [user("a")] as never, ttl, price, NOW)).toBeUndefined();
});

test("statusLines: the last request, the TTL, warm or cold, the warning's state and Jev", () => {
  const base = { model: undefined, now: NOW, settings: DEFAULT_SETTINGS, off: false, muted: false, jev: { kind: "ready" as const, label: "typesafe/jev-latest" } };
  expect(statusLines({ ...base, snapshot: snap({}) })).toEqual([
    "Last request: anthropic/claude-opus-5-5, 600k tokens, 1m ago.",
    "TTL: 5m.",
    "Warm: 4:00 left.",
    "Warning: on, from $0.50 or 100k tokens re-cached (warn.minCost, warn.minTokens). Keep-warm: OpenCode's \"warming\" setting.",
    "Jev: typesafe/jev-latest; trimming on; Jev compaction from the cold-cache menu and cache-guard: compact; it marks what /compact must keep too.",
  ]);
  const cold = statusLines({ ...base, snapshot: snap({ lastAt: NOW - 900_000 }) });
  expect(cold[2]).toBe("The prompt cache expired 10m ago: this prompt re-caches 600k tokens (~$2.88 at API prices).");
  expect(cold[3]).toBe("The next prompt asks before sending.");
  expect(statusLines({ ...base, snapshot: snap({ lastAt: NOW - 900_000, tokens: 10_000 }) })[3]).toBe("Below the warning threshold.");
  expect(statusLines({ ...base, snapshot: snap({ lastAt: NOW - 900_000 }), muted: true })[3]).toBe("The next prompt is sent without asking: the warning is off.");
  // A model switch is a miss too.
  expect(statusLines({ ...base, snapshot: snap({}), model: { providerID: "anthropic", modelID: "claude-sonnet-5" } })[3]).toContain("claude-sonnet-5 has no cache of this conversation");
  // No request yet; no TTL; Jev missing or off.
  expect(statusLines({ ...base, snapshot: undefined })[0]).toBe("No cached request in this session yet (or the context was just compacted).");
  expect(statusLines({ ...base, snapshot: snap({ ttlMs: undefined }) })[1]).toBe("TTL: not published for anthropic/claude-opus-5-5; warning after 180m idle.");
  expect(statusLines({ ...base, snapshot: undefined, jev: { kind: "missing", reason: "TYPESAFE_API_KEY is not set" } }).at(-1)).toBe("Jev: not set up (TYPESAFE_API_KEY is not set); cache-guard: Jev.");
  expect(statusLines({ ...base, snapshot: undefined, jev: { kind: "off" } }).at(-1)).toBe("Jev: off (cache-guard: Jev turns it on).");
  expect(statusLines({ ...base, snapshot: undefined, jev: undefined }).at(-1)).toBe("Jev: off (cache-guard: Jev turns it on).");
  expect(warningLine({ settings: DEFAULT_SETTINGS, off: true, muted: false })).toBe("off for this session (cache-guard: on turns it back on)");
  expect(warningLine({ settings: DEFAULT_SETTINGS, off: false, muted: true })).toContain("muted for this session");
  expect(warningLine({ settings: mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"enabled":false}}']), off: false, muted: false })).toBe('off ("warn.enabled": false in settings)');
  expect(warningLine({ settings: mergeSettings(DEFAULT_SETTINGS, ['{"enabled":false}']), off: false, muted: false })).toBe('off ("enabled": false in settings)');
});
