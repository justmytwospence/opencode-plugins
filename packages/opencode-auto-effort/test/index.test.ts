import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { effortState, history } from "../src/request.ts";
import { DEFAULT_OPTIONS, NAME, createHooks, currentOptions, fit, resolveOptions } from "../src/server.ts";
import { followUp, host, turn } from "./harness.ts";

const root = mkdtempSync(path.join(tmpdir(), "auto-effort-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");

const jevBody = (score: number, ack = 0.02, confidence = 0.9) =>
  JSON.stringify({ model: "jev-test", answers: { depth: { type: "score", score, confidence }, ack: { type: "noul", noul: ack } } });

function jev(script: number[], key = "k") {
  process.env.TYPESAFE_API_KEY = key;
  const queue = [...script];
  const sent: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(jevBody(queue.shift() ?? 1));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

test("effort follows the requests, capped at the session's variant", async () => {
  const j = jev([0, 3]);
  const h = host();
  const hooks = createHooks(h.host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(await turn(hooks, "redesign the sync engine", "high")).toBe("high");
  expect(h.toasts.map((t) => t.message)).toEqual(["effort: low (auto)", "effort: high (auto)"]);
});

test("every model request of a turn runs at the turn's level, with one Jev call", async () => {
  const j = jev([0]);
  const hooks = createHooks(host().host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(await followUp(hooks, "high")).toBe("low");
  expect(await followUp(hooks, "high")).toBe("low");
  expect(j.sent).toHaveLength(1);
});

test("a variant picked since the decision is respected until the next prompt", async () => {
  const j = jev([0]);
  const hooks = createHooks(host().host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(await followUp(hooks, "xhigh")).toBe("xhigh");
});

test("a variant's headers ride on the turn's model requests", async () => {
  const j = jev([0]);
  const hooks = createHooks(host().host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("low");
  const event = { sessionID: "s", agent: "build", headers: {} as Record<string, string> };
  hooks.headers(event);
  expect(event.headers).toEqual({ "x-effort": "low" });
});

test("other agents, no variant, and an empty prompt are left alone", async () => {
  const j = jev([0, 0, 0]);
  const hooks = createHooks(host().host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "list files", "xhigh", "plan")).toBe("xhigh");
  expect(await turn(hooks, "list files", undefined)).toBeUndefined();
  expect(await turn(hooks, "   ", "high")).toBe("high");
  expect(j.sent).toEqual([]);
});

test("without an API key the level holds at the ceiling", async () => {
  const j = jev([0], "");
  const hooks = createHooks(host().host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "list files", "xhigh")).toBe("xhigh");
  expect(j.sent).toEqual([]);
});

test("a level the model lacks falls to the next one down", async () => {
  expect(fit("medium", "high", ["low", "high"])).toBe("low");
  expect(fit("medium", "high", ["high"])).toBe("high");
  expect(fit("xhigh", "max", undefined)).toBe("xhigh");
  const j = jev([1]);
  const hooks = createHooks(host(["low", "high"]).host, DEFAULT_OPTIONS, j.fetchImpl);
  expect(await turn(hooks, "fix the typo in README", "high")).toBe("low");
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
  const j = jev([0, 0]);
  const h = host();
  const hooks = createHooks(h.host, () => currentOptions({ toast: false }, project), j.fetchImpl);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("high");
  expect(j.sent).toEqual([]);

  writeFileSync(file, JSON.stringify({ enabled: true }));
  utimesSync(file, 2_000, 2_000);
  expect(await turn(hooks, "what does ls -a do?", "high")).toBe("low");
  expect(j.sent).toHaveLength(1);
  expect(h.toasts).toEqual([]);
});

test("state: previous prompts and what the last run did", () => {
  const s = effortState("now this", [
    { role: "user", content: [{ type: "text", text: "first" }] },
    {
      role: "assistant",
      content: [
        { type: "tool-call", name: "edit" },
        { type: "tool-call", name: "shell" },
        { type: "text", text: "done editing" },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", name: "edit", result: { type: "text" } }] },
    { role: "tool", content: [{ type: "tool-result", name: "shell", result: { type: "error" } }] },
  ]);
  expect(s.previous_requests).toEqual(["first"]);
  expect(s.last_outcome).toBe("done editing");
  expect(s.signals).toEqual({ last_run_errors: 1, files_edited: 1, tool_calls: 2 });
});

test("history drops the prompt being decided from the end of the request's messages", () => {
  const first = { role: "user", content: [{ type: "text", text: "first" }] };
  const now = { role: "user", content: [{ type: "text", text: "now this" }] };
  expect(history("now this", [first, now])).toEqual([first]);
  expect(history("now this", [first])).toEqual([first]);
});
