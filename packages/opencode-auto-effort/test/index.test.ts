import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_OPTIONS, NAME, createHooks, currentOptions, fit, resolveOptions } from "../src/index.ts";
import { effortState } from "../src/request.ts";

const root = mkdtempSync(path.join(tmpdir(), "auto-effort-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");

const jevBody = (score: number, ack = 0.02, confidence = 0.9) =>
  JSON.stringify({ model: "jev-test", answers: { depth: { type: "score", score, confidence }, ack: { type: "noul", noul: ack } } });

function setup(script: number[], opts: { variants?: string[]; key?: string } = {}) {
  process.env.TYPESAFE_API_KEY = opts.key ?? "k";
  const queue = [...script];
  const sent: unknown[] = [];
  const toasts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(jevBody(queue.shift() ?? 1));
  }) as unknown as typeof fetch;
  const client = {
    config: {
      providers: async () => ({
        data: { providers: [{ id: "anthropic", models: { opus: { variants: Object.fromEntries((opts.variants ?? ["low", "medium", "high", "xhigh", "max"]).map((v) => [v, {}])) } } }] },
      }),
    },
    session: { messages: async () => ({ data: [] }) },
    app: { log: async () => ({}) },
    tui: { showToast: async ({ body }: { body: { message: string } }) => (toasts.push(body.message), {}) },
  };
  return { client: client as never, fetchImpl, sent, toasts };
}

async function prompt(hooks: Awaited<ReturnType<typeof createHooks>>, text: string, variant: string | undefined, agent = "build") {
  const message = { id: "m", sessionID: "s", role: "user", agent, model: { providerID: "anthropic", modelID: "opus", variant } };
  await hooks["chat.message"]!(
    { sessionID: "s", agent, model: { providerID: "anthropic", modelID: "opus" } },
    { message: message as never, parts: [{ type: "text", text } as never] },
  );
  return message.model.variant;
}

test("effort follows the requests, capped at the session's variant", async () => {
  const s = setup([0, 3]);
  const hooks = await createHooks(s.client, DEFAULT_OPTIONS, s.fetchImpl);
  expect(await prompt(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(await prompt(hooks, "redesign the sync engine", "high")).toBe("high");
  expect(s.toasts).toEqual(["effort: low (auto)", "effort: high (auto)"]);
});

test("other agents, no variant, and an empty prompt are left alone", async () => {
  const s = setup([0, 0, 0]);
  const hooks = await createHooks(s.client, DEFAULT_OPTIONS, s.fetchImpl);
  expect(await prompt(hooks, "list files", "xhigh", "plan")).toBe("xhigh");
  expect(await prompt(hooks, "list files", undefined)).toBeUndefined();
  expect(await prompt(hooks, "   ", "high")).toBe("high");
  expect(s.sent).toEqual([]);
});

test("without an API key the level holds at the ceiling", async () => {
  const s = setup([0], { key: "" });
  const hooks = await createHooks(s.client, DEFAULT_OPTIONS, s.fetchImpl);
  expect(await prompt(hooks, "list files", "xhigh")).toBe("xhigh");
  expect(s.sent).toEqual([]);
});

test("a level the model lacks falls to the next one down", async () => {
  expect(fit("medium", "high", ["low", "high"])).toBe("low");
  expect(fit("medium", "high", ["high"])).toBe("high");
  expect(fit("xhigh", "max", undefined)).toBe("xhigh");
  const s = setup([1], { variants: ["low", "high"] });
  const hooks = await createHooks(s.client, DEFAULT_OPTIONS, s.fetchImpl);
  expect(await prompt(hooks, "fix the typo in README", "high")).toBe("low");
});

test("options merge over the defaults", () => {
  const o = resolveOptions({ agents: ["build", "general"], policy: { floor: "medium" } });
  expect(o.agents).toEqual(["build", "general"]);
  expect(o.policy.floor).toBe("medium");
  expect(o.policy.alpha).toBe(0.5);
});

test("the shared settings files are read on each prompt, so edits apply without a restart", async () => {
  const project = path.join(root, "project");
  const file = path.join(root, "config", "agents", `${NAME}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabled: false }));
  utimesSync(file, 1_000, 1_000);
  const s = setup([0, 0]);
  const hooks = await createHooks(s.client, () => currentOptions({ toast: false }, project), s.fetchImpl);
  expect(await prompt(hooks, "what does ls -a do?", "high")).toBe("high");
  expect(s.sent).toEqual([]);

  writeFileSync(file, JSON.stringify({ enabled: true }));
  utimesSync(file, 2_000, 2_000);
  expect(await prompt(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(s.sent).toHaveLength(1);
  expect(s.toasts).toEqual([]);
});

test("state: previous prompts and what the last run did", () => {
  const s = effortState("now this", [
    { info: { role: "user" }, parts: [{ type: "text", text: "first" }] },
    {
      info: { role: "assistant" },
      parts: [
        { type: "tool", tool: "edit", state: { status: "completed" } },
        { type: "tool", tool: "bash", state: { status: "error" } },
        { type: "text", text: "done editing" },
      ],
    },
  ]);
  expect(s.previous_requests).toEqual(["first"]);
  expect(s.last_outcome).toBe("done editing");
  expect(s.signals).toEqual({ last_run_errors: 1, files_edited: 1, tool_calls: 2 });
});
