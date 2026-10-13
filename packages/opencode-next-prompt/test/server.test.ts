import { expect, test } from "vitest";
import type { Candidate } from "../src/rpc.ts";
import { type ContextEvent, DEFAULTS, type Host, type MessageLike, createHooks, stripHistory, vet } from "../src/server.ts";
import { INSTRUCTION } from "../src/tag.ts";

function host(over: Partial<Host> = {}): Host {
  return { isChild: async () => false, ...over };
}

function request(messages: MessageLike[] = [], agent = "build", sessionID = "s1"): ContextEvent {
  return { sessionID, agent, system: [{ type: "text", text: "You are OpenCode." }], messages };
}

const block = (body: string) => `\`\`\`next\n${body}\n\`\`\``;

test("the instruction is appended once, as its own system part", async () => {
  const hooks = createHooks(host(), DEFAULTS);
  const event = request();
  await hooks.context(event);
  expect(event.system.map((p) => p.text)).toEqual(["You are OpenCode.", INSTRUCTION]);
  await hooks.context(event);
  expect(event.system).toHaveLength(2);
});

test("earlier next blocks are removed from the assistant messages of the request, not from user text", async () => {
  const hooks = createHooks(host(), DEFAULTS);
  const event = request([
    { role: "user", content: [{ type: "text", text: `Please write ${block("keep me")}` }] },
    { role: "assistant", content: [{ type: "text", text: `Edited.\n\n${block("Run the tests")}` }, { type: "tool-call" }] },
    { role: "tool", content: [{ type: "tool-result" }] },
    { role: "assistant", content: [{ type: "text", text: "Tests pass." }] },
  ]);
  await hooks.context(event);
  expect(event.messages[0]!.content[0]!.text).toContain("keep me");
  expect(event.messages[1]!.content[0]!.text).toBe("Edited.");
  expect(event.messages[3]!.content[0]!.text).toBe("Tests pass.");
  // The same request again is byte-identical: stripping is deterministic.
  const again = request([{ role: "assistant", content: [{ type: "text", text: "Edited." }] }]);
  await hooks.context(again);
  expect(again.messages[0]!.content[0]!.text).toBe("Edited.");
});

test("stripHistory reports how many parts changed and skips text without a block", () => {
  const messages: MessageLike[] = [
    { role: "assistant", content: [{ type: "text", text: `A\n${block("x")}` }, { type: "text", text: "plain" }] },
    { role: "assistant", content: [{ type: "text", text: `B\n${block("y")}` }] },
  ];
  expect(stripHistory(messages, 110)).toBe(2);
  expect(messages.map((m) => m.content.map((p) => p.text))).toEqual([["A", "plain"], ["B"]]);
  expect(stripHistory(messages, 110)).toBe(0);
});

test("subagent sessions, other agents when restricted, and a disabled plugin get nothing", async () => {
  const child = request();
  await createHooks(host({ isChild: async () => true }), DEFAULTS).context(child);
  expect(child.system).toHaveLength(1);

  const plan = request([], "plan");
  await createHooks(host(), { ...DEFAULTS, agents: ["build"] }).context(plan);
  expect(plan.system).toHaveLength(1);
  const build = request([], "build");
  await createHooks(host(), { ...DEFAULTS, agents: ["build"] }).context(build);
  expect(build.system).toHaveLength(2);

  const off = request();
  await createHooks(host(), { ...DEFAULTS, enabled: false }).context(off);
  expect(off.system).toHaveLength(1);

  // A lookup failure is treated as "not a child" and retried next time.
  let calls = 0;
  const flaky = createHooks(
    host({
      isChild: async () => {
        calls++;
        if (calls === 1) throw new Error("x");
        return true;
      },
    }),
    DEFAULTS,
  );
  const first = request();
  await flaky.context(first);
  expect(first.system).toHaveLength(2);
  const second = request();
  await flaky.context(second);
  expect(second.system).toHaveLength(1);
  expect(calls).toBe(2);
});

test("a disabled plugin leaves old blocks in place too (nothing of its own in the request)", async () => {
  const event = request([{ role: "assistant", content: [{ type: "text", text: `A\n${block("x")}` }] }]);
  await createHooks(host(), { ...DEFAULTS, enabled: false }).context(event);
  expect(event.messages[0]!.content[0]!.text).toContain("```next");
});

test("options are re-read on each request when given as a function", async () => {
  let enabled = true;
  const hooks = createHooks(host(), () => ({ ...DEFAULTS, enabled }));
  const a = request();
  await hooks.context(a);
  expect(a.system).toHaveLength(2);
  enabled = false;
  const b = request();
  await hooks.context(b);
  expect(b.system).toHaveLength(1);
});

const candidate: Candidate = { sessionID: "s", messageID: "m", suggestion: "Run the tests", userPrompt: "edit", assistantTail: "Edited." };

function jevFetch(body: unknown, status = 200) {
  const calls: any[] = [];
  const fetch = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("Jev's threshold decides; failures and a missing key show it anyway", async () => {
  const yes = jevFetch({ answers: { useful: { type: "noul", noul: 0.8 } } });
  expect((await vet(candidate, DEFAULTS.jev, { apiKey: "k", fetch: yes.fetch })).show).toBe(true);
  expect(yes.calls[0].state).toEqual({ last_user_prompt: "edit", assistant_text_tail: "Edited.", suggestion: "Run the tests" });
  expect(yes.calls[0].questions.useful.type).toBe("noul");

  const no = jevFetch({ answers: { useful: { type: "noul", noul: 0.4 } } });
  expect(await vet(candidate, DEFAULTS.jev, { apiKey: "k", fetch: no.fetch })).toEqual({ show: false, reason: "Jev 0.40 < 0.6" });

  const broken = jevFetch({}, 500);
  expect(await vet(candidate, DEFAULTS.jev, { apiKey: "k", fetch: broken.fetch })).toMatchObject({ show: true });

  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  expect(await vet(candidate, DEFAULTS.jev)).toMatchObject({ show: true, reason: expect.stringContaining("TYPESAFE_API_KEY") });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;

  expect(await vet(candidate, { ...DEFAULTS.jev, enabled: false })).toEqual({ show: true, reason: "Jev off" });
});

test("long prompts and answers are clipped before they reach Jev", async () => {
  const jev = jevFetch({ answers: { useful: { type: "noul", noul: 0.9 } } });
  await vet({ ...candidate, userPrompt: "u".repeat(2_000), assistantTail: "a".repeat(3_000) }, DEFAULTS.jev, { apiKey: "k", fetch: jev.fetch });
  expect(jev.calls[0].state.last_user_prompt).toHaveLength(1_500);
  expect(jev.calls[0].state.last_user_prompt.endsWith("\u2026")).toBe(true);
  expect(jev.calls[0].state.assistant_text_tail).toHaveLength(2_000);
  expect(jev.calls[0].state.assistant_text_tail.startsWith("\u2026")).toBe(true);
});

test("the vet method asks Jev once per message and forgets a deleted session", async () => {
  const jev = jevFetch({ answers: { useful: { type: "noul", noul: 0.9 } } });
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "k";
  try {
    const hooks = createHooks(host(), DEFAULTS, jev.fetch);
    expect(await hooks.vet(candidate)).toEqual({ show: true, reason: "Jev 0.90 >= 0.6" });
    expect(await hooks.vet(candidate)).toEqual({ show: true, reason: "Jev 0.90 >= 0.6" });
    expect(jev.calls).toHaveLength(1);
    hooks.forget("s");
    await hooks.vet(candidate);
    expect(jev.calls).toHaveLength(2);
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});
