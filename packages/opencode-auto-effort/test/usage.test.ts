import { expect, test } from "vitest";
import { DEFAULT_OPTIONS, createHooks } from "../src/server.ts";
import { host, turn } from "./harness.ts";
import { Tracker } from "../src/limits.ts";
import { observe, trackerKey } from "../src/usage.ts";

const t0 = Date.UTC(2026, 0, 1);
const M = 60_000;
const anthropic = (used: number) =>
  new Response("{}", {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": String(used),
      "anthropic-ratelimit-unified-5h-reset": String((t0 + 120 * M) / 1000),
    },
  });

test("observe records Anthropic and Codex headers by host and ignores the rest", () => {
  const trackers = new Map<string, Tracker>();
  observe(trackers, "https://api.anthropic.com/v1/messages", anthropic(0.4), t0);
  observe(trackers, "https://chatgpt.com/backend-api/codex/responses", new Response("", { headers: { "x-codex-primary-used-percent": "12" } }), t0);
  observe(trackers, "https://api.typesafe.ai/v1/classify", anthropic(0.9), t0);
  observe(trackers, "not a url", anthropic(0.9), t0);
  expect(trackers.get("anthropic")?.readings()).toEqual([{ window: "5h", used: 0.4, at: t0, resetsAt: t0 + 120 * M }]);
  expect(trackers.get("codex")?.readings()).toEqual([{ window: "primary", used: 0.12, at: t0 }]);
  expect([...trackers.keys()].sort()).toEqual(["anthropic", "codex"]);
  expect([trackerKey("anthropic"), trackerKey("openai"), trackerKey("openai-codex"), trackerKey("google"), trackerKey("chatgpt")]).toEqual(["anthropic", "codex", "codex", undefined, "codex"]);
});

test("the context hook lowers the variant while a window is at risk and restores it after", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  const jev = (async () =>
    new Response(JSON.stringify({ model: "jev", answers: { depth: { type: "score", score: 3, confidence: 0.9 }, ack: { type: "noul", noul: 0.01 } } }))) as unknown as typeof fetch;
  const h = host(["low", "medium", "high", "xhigh"]);
  const toasts = h.messages;
  const logs = h.logs;
  const trackers = new Map<string, Tracker>();
  let clock = t0;
  const hooks = createHooks(h.host, DEFAULT_OPTIONS, jev, { trackers, now: () => clock });
  observe(trackers, "https://api.anthropic.com/v1/messages", anthropic(0.8), clock);
  expect(await turn(hooks, "redesign the sync engine", "high")).toBe("medium");
  expect(toasts.at(-1)?.message).toBe("effort: medium (auto, limited: 5h 80%)");
  expect(logs.at(-1)).toMatch(/limit caution \(5h 80%, projected \d+%\), baseline high$/);
  // Still limited, same tier: no new toast.
  expect(await turn(hooks, "redesign the sync engine", "high")).toBe("medium");
  expect(toasts).toHaveLength(1);
  // The window resets: the next prompt is back at the policy's level.
  clock += 121 * M;
  expect(await turn(hooks, "redesign the sync engine", "high")).toBe("high");
  expect(toasts.at(-1)?.message).toBe("effort: high (auto)");

  const off = createHooks(host().host, { ...DEFAULT_OPTIONS, limits: { ...DEFAULT_OPTIONS.limits, enabled: false } }, jev, { trackers, now: () => t0 });
  observe(trackers, "https://api.anthropic.com/v1/messages", anthropic(0.95), t0 + 122 * M);
  expect(await turn(off, "redesign the sync engine", "high")).toBe("high");
});
