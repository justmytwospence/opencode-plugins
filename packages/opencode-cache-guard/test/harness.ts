// A fake OpenCode for the server hooks: settings, the session's messages, catalog prices, and a
// recorder for the RPC events and log lines; Jev answers through a fake fetch.
import type { Snapshot } from "../src/clock.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/core.ts";
import type { Compacted, Note } from "../src/rpc.ts";
import { type Hooks, type Host, createHooks } from "../src/server.ts";
import type { MessageLike } from "../src/units.ts";

export type Answerer = (questions: Record<string, any>, state: any) => unknown;

export interface Fake {
  hooks: Hooks;
  states: Snapshot[];
  trimmed: Note[];
  compacted: Compacted[];
  logs: string[];
  /** Jev requests, as sent. */
  sent: any[];
  settings: Settings;
  messages: MessageLike[];
  now: number;
}

export function fake(input: { messages?: MessageLike[]; settings?: Settings; answer?: Answerer; key?: string; env?: NodeJS.ProcessEnv; now?: number; cost?: Host["cost"] } = {}): Fake {
  const f: Fake = { states: [], trimmed: [], compacted: [], logs: [], sent: [], settings: input.settings ?? DEFAULT_SETTINGS, messages: input.messages ?? [], now: input.now ?? Date.parse("2026-10-07T12:00:00Z") } as unknown as Fake;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    f.sent.push(body);
    const answers = input.answer?.(body.questions, body.state) ?? {};
    if (answers instanceof Response) return answers;
    if (answers instanceof Error) throw answers;
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10 } }));
  }) as unknown as typeof fetch;
  const host: Host = {
    settings: () => f.settings,
    messages: async () => f.messages,
    cost: input.cost ?? (async () => undefined),
    emit: {
      state: (s) => void f.states.push(s),
      trimmed: (n) => void f.trimmed.push(n),
      compacted: (c) => void f.compacted.push(c),
    },
    log: (line) => void f.logs.push(line),
    env: { ...(input.env ?? {}), ...(input.key === undefined ? { TYPESAFE_API_KEY: "k" } : input.key ? { TYPESAFE_API_KEY: input.key } : {}) },
    fetch: fetchImpl,
  };
  f.hooks = createHooks(host, () => f.now);
  return f;
}

/** An SSE Messages response whose message_start carries this usage. */
export function sseResponse(usage: { input: number; read: number; write: number }, text = "ok"): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
