// Fakes for the tests: Pi-shaped session entries for segments.ts (the same shape pi-copy's tests
// use) and a fetch that plays Jev with scripted answers.
import type { Answer } from "../src/jev.ts";

export function userEntry(text: string) {
  return { type: "message", id: `u${Math.random()}`, message: { role: "user", content: text } };
}

export function assistantEntry(text: string) {
  return { type: "message", id: `a${Math.random()}`, message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** A fetch that answers every Jev request with `answers` and records the request bodies. */
export function jevFetch(answers: Record<string, Answer>) {
  const requests: unknown[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 42 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
