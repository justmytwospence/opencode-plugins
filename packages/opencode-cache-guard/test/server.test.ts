import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { Clock, priceOf, ttlOf } from "../src/clock.ts";
import { VERBATIM_LEAD } from "../src/compact.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import { modelRef, totalTokens } from "../src/server.ts";
import { savePath } from "../src/trim.ts";
import { readUsage, usageOf, usageOfStream } from "../src/usage.ts";
import { type Answerer, fake, sseResponse } from "./harness.ts";
import { assistant, user } from "./messages.ts";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const data = mkdtempSync(path.join(tmpdir(), "cg-server-"));
afterAll(() => rmSync(data, { recursive: true, force: true }));
const sonnet = { providerID: "anthropic", id: "claude-sonnet-5-5" };

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");
const keepErrors: Answerer = (questions, state) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: id.startsWith("block::") && String(state?.output?.[id.slice(7)] ?? "").includes("Error") ? 0.9 : 0.05 }]));
const keepFirstVerbatim: Answerer = (questions) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "choice", choice: id === "keep::U001" ? "verbatim" : "summarize", probabilities: {}, confidence: 1 }]));
const history = [user("Use pnpm, never npm."), assistant(["Exploring."], [{ tool: "bash", callID: "c1", input: { command: "ls" }, output: "a" }]), user("Now add a cache.")];

test("the clock: model and prices from the context hook, the start from the request, the size from the step", async () => {
  const f = fake({ cost: async () => ({ input: 3, cache: { read: 0.3, write: 3.75 } }) });
  await f.hooks.context({ sessionID: "s", agent: "build", model: sonnet });
  expect(f.hooks.state("s")).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, ttlMs: 300_000, price: { input: 3, cacheRead: 0.3, cacheWrite: 3.75 }, lastAt: 0, tokens: 0 });
  f.hooks.httpRequest({ sessionID: "s", kind: "primary", model: sonnet });
  expect(f.hooks.state("s")!.lastAt).toBe(T0);
  f.hooks.stepStarted("s", T0 - 100);
  expect(f.hooks.state("s")!.lastAt).toBe(T0); // the wire time, when later, wins
  f.hooks.stepEnded("s", { input: 2, output: 1_000, reasoning: 0, cache: { read: 599_000, write: 0 } });
  expect(f.hooks.state("s")!.tokens).toBe(600_002);
  // Auxiliary requests (titles, compaction) do not restart the clock.
  f.now = T0 + 10_000;
  f.hooks.httpRequest({ sessionID: "s", kind: "title", model: sonnet });
  expect(f.hooks.state("s")!.lastAt).toBe(T0);
  // Every change reached the terminals; an unknown session is null.
  expect(f.states.length).toBeGreaterThanOrEqual(3);
  expect(f.states.at(-1)).toMatchObject({ sessionID: "s", tokens: 600_002 });
  expect(f.hooks.state("nope")).toBeNull();
  // A compaction empties the clock; a deleted session is forgotten.
  f.hooks.compacted("s");
  expect(f.hooks.state("s")).toMatchObject({ lastAt: 0, tokens: 0 });
  f.hooks.forget("s");
  expect(f.hooks.state("s")).toBeNull();
});

test("the Anthropic response's usage is read from a clone: cache reads and writes, logged", async () => {
  const f = fake();
  const response = sseResponse({ input: 2, read: 599_000, write: 1_000 });
  f.hooks.httpResponse({ sessionID: "s", kind: "primary", model: sonnet, response });
  await f.hooks.settle();
  expect(f.hooks.state("s")!.lastCache).toEqual({ read: 599_000, write: 1_000, prompt: 600_002 });
  expect(f.hooks.state("s")!.tokens).toBe(600_002);
  expect(f.logs).toContain("s cache: read 599000, wrote 1000 of 600002 prompt tokens");
  // The original stream is untouched.
  expect(await response.text()).toContain("message_stop");
  // Other providers and auxiliary requests are not read.
  f.hooks.httpResponse({ sessionID: "o", kind: "primary", model: { providerID: "openai" }, response: sseResponse({ input: 1, read: 1, write: 1 }) });
  f.hooks.httpResponse({ sessionID: "s", kind: "compaction", model: sonnet, response: sseResponse({ input: 1, read: 1, write: 1 }) });
  await f.hooks.settle();
  expect(f.hooks.state("o")).toBeNull();
  expect(f.hooks.state("s")!.lastCache!.read).toBe(599_000);
});

test("usage parsing: JSON bodies, SSE streams, errors and other bodies", async () => {
  expect(usageOf({ usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } })).toEqual({ read: 10, write: 2, prompt: 17 });
  expect(usageOf({ usage: { input_tokens: 5 } })).toEqual({ read: 0, write: 0, prompt: 5 });
  expect(usageOf({})).toBeUndefined();
  expect(usageOfStream('event: ping\ndata: {"type":"ping"}\n\nevent: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":9}}}\n\n')).toEqual({ read: 9, write: 0, prompt: 10 });
  expect(usageOfStream("data: {broken")).toBeUndefined();
  expect(await readUsage(new Response(JSON.stringify({ usage: { input_tokens: 3 } }), { headers: { "content-type": "application/json" } }))).toEqual({ read: 0, write: 0, prompt: 3 });
  expect(await readUsage(new Response("nope", { status: 500 }))).toBeUndefined();
  expect(await readUsage(new Response("not json", { headers: { "content-type": "application/json" } }))).toBeUndefined();
});

test("with Jev, large tool output is trimmed in the tool hook, logged, and noted to the terminals", async () => {
  const f = fake({ messages: history, answer: keepErrors, env: { XDG_DATA_HOME: data } });
  const result = { content: [{ type: "text", text: big }], metadata: {} };
  await f.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "call_1", input: { command: "npm test" }, status: "completed", result });
  const text = (result.content[0] as { text: string }).text;
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text.length).toBeLessThan(big.length / 5);
  expect(readFileSync(savePath("s", "call_1", { XDG_DATA_HOME: data }), "utf8")).toBe(big);
  expect(f.sent[0].state.intent).toMatchObject({ user_request: "Now add a cache.", tool: "bash" });
  expect(f.logs[0]).toMatch(/^trim bash: kept \d+ of 2000 lines/u);
  expect(f.trimmed).toEqual([{ sessionID: "s", message: expect.stringMatching(/^bash output trimmed to \d+ of 2000 lines$/u) }]);
  // The same call again this turn is left whole; the next prompt starts a new turn.
  const again = { content: [{ type: "text", text: big }] };
  await f.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "call_2", input: { command: "npm test" }, status: "completed", result: again });
  expect((again.content[0] as { text: string }).text).toBe(big);
  f.hooks.prompt("s");
  await f.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "call_3", input: { command: "npm test" }, status: "completed", result: again });
  expect((again.content[0] as { text: string }).text).not.toBe(big);
  // Errors, small output and tools kept whole pass without Jev.
  const before = f.sent.length;
  const error = { content: [{ type: "text", text: big }] };
  await f.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "call_4", input: {}, status: "error", result: error });
  await f.hooks.toolAfter({ tool: "edit", sessionID: "s", id: "call_5", input: {}, status: "completed", result: { content: [{ type: "text", text: big }] } });
  expect(f.sent).toHaveLength(before);
});

test("without a key, or with Jev off, tool output is left whole", async () => {
  const noKey = fake({ messages: history, answer: keepErrors, key: "", env: { XDG_DATA_HOME: data } });
  const result = { content: [{ type: "text", text: big }] };
  await noKey.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "c", input: {}, status: "completed", result });
  expect((result.content[0] as { text: string }).text).toBe(big);
  expect(noKey.sent).toEqual([]);
  const off = fake({ messages: history, answer: keepErrors, settings: mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"enabled":false}}']), env: { XDG_DATA_HOME: data } });
  await off.hooks.toolAfter({ tool: "bash", sessionID: "s", id: "c", input: {}, status: "completed", result });
  expect(off.sent).toEqual([]);
});

test("an ordinary compaction: guidance armed by the terminal, then Jev's verbatim items; failures add nothing", async () => {
  const f = fake({ messages: history, answer: keepFirstVerbatim });
  f.hooks.arm({ sessionID: "s", kind: "guidance", text: "Keep the plan." });
  const event = { sessionID: "s", system: [] as Array<{ type: "text"; text: string }>, result: undefined as { summary: string } | undefined };
  await f.hooks.compaction(event);
  expect(event.result).toBeUndefined();
  expect(event.system.map((p) => p.text)).toEqual(["Keep the plan.", expect.stringContaining(VERBATIM_LEAD)]);
  expect(event.system[1]!.text).toContain("**User:** Use pnpm, never npm.");
  expect(f.sent[0].state.current_goal).toBe("Keep the plan.");
  expect(f.logs.at(-1)).toMatch(/^s compaction: Jev judged 4 items in \d+ ms \(1 verbatim, 3 noted, 0 dropped\)$/u);
  // The arm is consumed: the next compaction has no guidance and judges against the last requests.
  const next = { sessionID: "s", system: [] as Array<{ type: "text"; text: string }> };
  await f.hooks.compaction(next);
  expect(next.system).toHaveLength(1);
  expect(f.sent[1].state.current_goal).toBe("Use pnpm, never npm.\n---\nNow add a cache.");
  // Jev down: nothing is added, the compaction proceeds.
  const down = fake({ messages: history, answer: () => new Response("x", { status: 503 }) });
  const plain = { sessionID: "s", system: [] as Array<{ type: "text"; text: string }> };
  await down.hooks.compaction(plain);
  expect(plain.system).toEqual([]);
  expect(down.logs).toEqual(["s compaction: Jev added nothing (Jev failed (HTTP 503))"]);
  // compact.filter off, or no key: nothing is asked.
  const filterOff = fake({ messages: history, answer: keepFirstVerbatim, settings: mergeSettings(DEFAULT_SETTINGS, ['{"compact":{"filter":false}}']) });
  await filterOff.hooks.compaction({ sessionID: "s", system: [] });
  expect(filterOff.sent).toEqual([]);
});

test("a compaction armed for Jev replaces the model's summary with one written in code; a Jev failure fails it", async () => {
  const f = fake({ messages: history, answer: keepFirstVerbatim });
  f.hooks.arm({ sessionID: "s", kind: "jev", text: "fix the parser" });
  const event = { sessionID: "s", system: [] as Array<{ type: "text"; text: string }>, result: undefined as { summary: string } | undefined };
  await f.hooks.compaction(event);
  expect(event.result!.summary).toContain("# Compacted with Jev");
  expect(event.result!.summary).toContain("**User:** Use pnpm, never npm.");
  expect(f.sent[0].state.current_goal).toBe("fix the parser");
  expect(f.compacted).toEqual([{ sessionID: "s", ok: true, message: expect.stringMatching(/^Jev kept 1 of 4 items word for word in \d+\.\d s\.$/u) }]);
  // Jev fails: the hook throws, so nothing is compacted, and the terminal hears why.
  const down = fake({ messages: history, answer: () => new Response("x", { status: 503 }) });
  down.hooks.arm({ sessionID: "s", kind: "jev", text: "go on" });
  await expect(down.hooks.compaction({ sessionID: "s", system: [] })).rejects.toThrow(/compaction with Jev did not run \(Jev failed \(HTTP 503\)\)/u);
  expect(down.compacted).toEqual([{ sessionID: "s", ok: false, message: "Compaction with Jev did not run: Jev failed (HTTP 503)." }]);
  // No key: the same.
  const noKey = fake({ messages: history, key: "" });
  noKey.hooks.arm({ sessionID: "s", kind: "jev", text: "go on" });
  await expect(noKey.hooks.compaction({ sessionID: "s", system: [] })).rejects.toThrow(/TYPESAFE_API_KEY is not set/u);
  // A stale arm (older than ten minutes) is ignored.
  const stale = fake({ messages: history, answer: keepFirstVerbatim });
  stale.hooks.arm({ sessionID: "s", kind: "jev", text: "go on" });
  stale.now = T0 + 11 * 60_000;
  const later = { sessionID: "s", system: [] as Array<{ type: "text"; text: string }>, result: undefined as { summary: string } | undefined };
  await stale.hooks.compaction(later);
  expect(later.result).toBeUndefined();
});

test("the Jev RPC: ready with the probe's latency, missing with the reason, off", async () => {
  const ready = fake({ answer: (q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "noul", noul: 0.9 }])) });
  expect(await ready.hooks.jev()).toMatchObject({ kind: "ready", label: "typesafe/jev-latest", latencyMs: expect.any(Number) });
  const down = fake({ answer: () => new Response("x", { status: 401 }) });
  expect(await down.hooks.jev()).toEqual({ kind: "ready", label: "typesafe/jev-latest", reason: "invalid API key" });
  expect(await fake({ key: "" }).hooks.jev()).toEqual({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" });
  expect(await fake({ settings: mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"enabled":false}}']) }).hooks.jev()).toEqual({ kind: "off" });
});

test("helpers: prices, TTLs, model refs, token totals, the clock's changes", () => {
  expect(priceOf({ providerID: "anthropic", modelID: "claude-sonnet-5-5" }, { input: 3, cache: { read: 0.3, write: 3.75 } })).toEqual({ input: 3, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(priceOf({ providerID: "anthropic", modelID: "claude-sonnet-5-5" }, { input: 0, cache: { read: 0, write: 0 } })).toEqual({ input: 2, cacheRead: 0.2 });
  expect(priceOf({ providerID: "anthropic", modelID: "claude-sonnet-5-5" })).toEqual({ input: 2, cacheRead: 0.2 });
  expect(priceOf({ providerID: "openai", modelID: "gpt-5" }, { input: 0 })).toBeUndefined();
  expect(ttlOf({ providerID: "anthropic", modelID: "x" }, {})).toBe(300_000);
  expect(ttlOf({ providerID: "anthropic", modelID: "x" }, { OPENCODE_CACHE_GUARD_TTL_MS: "2000" })).toBe(2_000);
  expect(ttlOf({ providerID: "openai", modelID: "x" }, {})).toBeUndefined();
  expect(modelRef({ providerID: "anthropic", id: "a" })).toEqual({ providerID: "anthropic", modelID: "a" });
  expect(modelRef({ providerID: "anthropic", modelID: "b" })).toEqual({ providerID: "anthropic", modelID: "b" });
  expect(totalTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toBe(12);
  const changes: number[] = [];
  const clock = new Clock({ now: () => T0, onChange: (s) => changes.push(s.tokens) });
  clock.recordTokens("s", 10);
  clock.recordTokens("s", 10);
  clock.requestStarted("s", T0 - 1);
  clock.requestStarted("s", T0 - 2);
  expect(changes).toEqual([10, 10]);
  expect(clock.get("s").lastAt).toBe(T0 - 1);
});
