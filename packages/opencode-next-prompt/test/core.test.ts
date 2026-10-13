import { expect, test } from "vitest";
import { Tracker, vet, type Candidate } from "../src/core.js";
import { DEFAULTS } from "../src/server.js";
import { extractNext } from "../src/tag.js";

type Part = { id: string; type: string; text?: string; synthetic?: boolean };

function session(stored: string, extra: { error?: unknown; reasoning?: string } = {}) {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", ...(extra.error ? { error: extra.error } : {}) },
  ];
  const parts: Record<string, Part[]> = {
    u1: [{ id: "pu", type: "text", text: "rename foo to bar" }, { id: "ps", type: "text", text: "<file>", synthetic: true }],
    a1: [
      ...(extra.reasoning ? [{ id: "pr", type: "reasoning", text: extra.reasoning }] : []),
      { id: "pt", type: "text", text: stored },
    ],
  };
  return { messages, parts: (id: string) => parts[id] ?? [] };
}

function stream(tracker: Tracker, partID: string, text: string, sessionID = "s1") {
  // Split into uneven chunks, as providers do.
  for (let i = 0; i < text.length; i += 7) tracker.delta({ sessionID, partID, field: "text", delta: text.slice(i, i + 7) });
}

test("the tag is read from the streamed deltas when the stored text was stripped", () => {
  const raw = "Renamed.\n\n<next>Run the tests</next>";
  const t = new Tracker();
  stream(t, "pt", raw);
  const s = session(extractNext(raw).text);
  expect(t.candidate("s1", s.messages, s.parts, 110)).toEqual({
    sessionID: "s1",
    messageID: "a1",
    suggestion: "Run the tests",
    userPrompt: "rename foo to bar",
    assistantTail: "Renamed.",
  } satisfies Candidate);
});

test("reasoning deltas are ignored; stored text with a tag still works without deltas", () => {
  const t = new Tracker();
  stream(t, "pr", "thinking <next>nope</next>");
  const s = session("Done.\n<next>Commit it</next>", { reasoning: "thinking\n<next>nope</next>" });
  expect(t.candidate("s1", s.messages, s.parts, 110)?.suggestion).toBe("Commit it");
});

test("each message is read once; failed and tagless turns give nothing", () => {
  const t = new Tracker();
  stream(t, "pt", "Done.\n<next>Run it</next>");
  const s = session("Done.");
  expect(t.candidate("s1", s.messages, s.parts, 110)?.suggestion).toBe("Run it");
  expect(t.candidate("s1", s.messages, s.parts, 110)).toBeUndefined();

  const failed = session("Partial.\n<next>Continue</next>", { error: { name: "MessageAbortedError" } });
  expect(new Tracker().candidate("s1", failed.messages, failed.parts, 110)).toBeUndefined();

  const none = session("All done.");
  expect(new Tracker().candidate("s1", none.messages, none.parts, 110)).toBeUndefined();
});

test("a turn still waiting on the user (last message is the user's) gives nothing", () => {
  const t = new Tracker();
  expect(t.candidate("s1", [{ id: "u1", role: "user" }], () => [], 110)).toBeUndefined();
});

test("raw text is kept per session and dropped after reading", () => {
  const t = new Tracker();
  stream(t, "pt", "A\n<next>one</next>", "s1");
  stream(t, "px", "B\n<next>two</next>", "s2");
  t.forget("s1");
  const s = session("A");
  expect(t.candidate("s1", s.messages, s.parts, 110)).toBeUndefined();
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
  expect((await vet(candidate, DEFAULTS.jev, { apiKey: "k", fetch: no.fetch })).show).toBe(false);

  const broken = jevFetch({}, 500);
  expect(await vet(candidate, DEFAULTS.jev, { apiKey: "k", fetch: broken.fetch })).toMatchObject({ show: true });

  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  expect(await vet(candidate, DEFAULTS.jev)).toMatchObject({ show: true, reason: expect.stringContaining("TYPESAFE_API_KEY") });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;

  expect(await vet(candidate, { ...DEFAULTS.jev, enabled: false })).toEqual({ show: true, reason: "Jev off" });
});
