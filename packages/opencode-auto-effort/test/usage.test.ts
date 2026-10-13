import { afterEach, expect, test } from "vitest";
import { DEFAULT_OPTIONS, createHooks } from "../src/index.ts";
import { Tracker } from "../src/limits.ts";
import { install, observe, trackerKey, uninstall } from "../src/usage.ts";

const t0 = Date.UTC(2026, 0, 1);
const M = 60_000;
const realFetch = globalThis.fetch;
afterEach(() => {
  while ((globalThis as Record<symbol, unknown>)[Symbol.for("auto-effort:usage")]) uninstall();
  globalThis.fetch = realFetch;
});

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
  expect([trackerKey("anthropic"), trackerKey("openai"), trackerKey("openai-codex"), trackerKey("google")]).toEqual(["anthropic", "codex", "codex", undefined]);
});

test("install wraps fetch once, reads only the response headers, and the last dispose restores it", async () => {
  const base = (async () => anthropic(0.3)) as unknown as typeof fetch;
  globalThis.fetch = base;
  const trackers = install(() => t0);
  expect(install(() => t0)).toBe(trackers);
  const response = await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "secret" });
  expect(await response.text()).toBe("{}");
  expect(trackers.get("anthropic")?.readings()[0]?.used).toBe(0.3);
  uninstall();
  expect(globalThis.fetch).not.toBe(base);
  uninstall();
  expect(globalThis.fetch).toBe(base);
});

test("disposed under another wrapper: fetch keeps working and nothing is recorded", async () => {
  const base = (async () => anthropic(0.3)) as unknown as typeof fetch;
  globalThis.fetch = base;
  const trackers = install(() => t0);
  const ours = globalThis.fetch;
  const outer = ((input: string, init?: RequestInit) => ours(input, init)) as unknown as typeof fetch;
  globalThis.fetch = outer;
  uninstall();
  expect(globalThis.fetch).toBe(outer);
  const response = await globalThis.fetch("https://api.anthropic.com/v1/messages");
  expect(response.ok).toBe(true);
  expect(trackers.size).toBe(0);
});

function client(toasts: string[], logs: string[]) {
  return {
    config: {
      providers: async () => ({ data: { providers: [{ id: "anthropic", models: { opus: { variants: { low: {}, medium: {}, high: {}, xhigh: {} } } } }] } }),
    },
    session: { messages: async () => ({ data: [] }) },
    app: { log: async ({ body }: { body: { message: string } }) => (logs.push(body.message), {}) },
    tui: { showToast: async ({ body }: { body: { message: string } }) => (toasts.push(body.message), {}) },
  } as never;
}

async function prompt(hooks: Awaited<ReturnType<typeof createHooks>>, variant: string) {
  const message = { id: "m", sessionID: "s", role: "user", agent: "build", model: { providerID: "anthropic", modelID: "opus", variant } };
  await hooks["chat.message"]!(
    { sessionID: "s", agent: "build", model: { providerID: "anthropic", modelID: "opus" } },
    { message: message as never, parts: [{ type: "text", text: "redesign the sync engine" } as never] },
  );
  return message.model.variant;
}

test("chat.message lowers the variant while a window is at risk and restores it after", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  const jev = (async () =>
    new Response(JSON.stringify({ model: "jev", answers: { depth: { type: "score", score: 3, confidence: 0.9 }, ack: { type: "noul", noul: 0.01 } } }))) as unknown as typeof fetch;
  const toasts: string[] = [];
  const logs: string[] = [];
  const trackers = new Map<string, Tracker>();
  let clock = t0;
  const hooks = await createHooks(client(toasts, logs), DEFAULT_OPTIONS, jev, { trackers, now: () => clock });
  observe(trackers, "https://api.anthropic.com/v1/messages", anthropic(0.8), clock);
  expect(await prompt(hooks, "high")).toBe("medium");
  expect(toasts.at(-1)).toBe("effort: medium (auto, limited: 5h 80%)");
  expect(logs.at(-1)).toMatch(/limit caution \(5h 80%, projected \d+%\), baseline high$/);
  // Still limited, same tier: no new toast.
  expect(await prompt(hooks, "high")).toBe("medium");
  expect(toasts).toHaveLength(1);
  // The window resets: the next prompt is back at the policy's level.
  clock += 121 * M;
  expect(await prompt(hooks, "high")).toBe("high");
  expect(toasts.at(-1)).toBe("effort: high (auto)");

  const off = await createHooks(client([], []), { ...DEFAULT_OPTIONS, limits: { ...DEFAULT_OPTIONS.limits, enabled: false } }, jev, { trackers, now: () => t0 });
  observe(trackers, "https://api.anthropic.com/v1/messages", anthropic(0.95), t0 + 122 * M);
  expect(await prompt(off, "high")).toBe("high");
});
