// A fake OpenCode for the gate: a scripted Jev, a transcript, recorders for logs, toasts and
// mode changes, and a driver that plays one tool call through `execute.before` and the
// `evaluate` permission hook the way OpenCode does.
import type { Effect, Evaluation, Gate, Host, Options } from "../src/gate.ts";
import { createGate, resolveOptions } from "../src/gate.ts";
import type { ChangedEvent, NoticeEvent } from "../src/rpc.ts";
import type { MessageLike } from "../src/transcript.ts";

export const safe = {
  in_scope: { type: "noul", noul: 0.95 },
  requested: { type: "noul", noul: 0.1 },
  irreversible: { type: "noul", noul: 0.05 },
  remote_change: { type: "noul", noul: 0.02 },
  exfiltration: { type: "noul", noul: 0.01 },
  impact: { type: "score", score: 1, confidence: 0.9 },
};
export const risky = {
  ...safe,
  remote_change: { type: "noul", noul: 0.95 },
  impact: { type: "score", score: 2.2, confidence: 0.8 },
};
export const workaround = {
  workaround: { type: "choice", choice: "local", probabilities: { local: 0.6, dry_run: 0.32, skip: 0.08 }, confidence: 0.6 },
};

export const user = (text: string, id = `u${text.length}`): MessageLike => ({ id, type: "user", text });
export const assistant = (text: string, callID?: string, id = `a${text.length}`): MessageLike => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }, ...(callID ? [{ type: "tool", id: callID, name: "shell" }] : [])],
});

export interface Setup {
  answers?: Record<string, unknown> | ((questions: Record<string, unknown>) => Record<string, unknown> | undefined);
  workaround?: Record<string, unknown>;
  key?: string;
  /** Every Jev request fails. */
  down?: boolean;
  options?: Partial<Options> | (() => Options);
  directory?: string;
  messages?: MessageLike[];
  /** The mode stored for a session, as a previous run left it. */
  stored?: Record<string, string>;
  /** Parent sessions, child to parent. */
  parents?: Record<string, string>;
}

export interface Outcome {
  effect: Effect;
  message?: string;
}

export function setup(s: Setup = {}) {
  process.env.TYPESAFE_API_KEY = s.key ?? "k";
  const sent: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = [];
  const toasts: NoticeEvent[] = [];
  const changes: ChangedEvent[] = [];
  const stored = new Map(Object.entries(s.stored ?? {}));
  const messages = s.messages ?? [user("Fix the failing test"), assistant("I'll rerun the tests.", "c1")];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as (typeof sent)[number];
    sent.push(body);
    if (s.down) return new Response("nope", { status: 500 });
    const answers = body.questions.workaround
      ? (s.workaround ?? workaround)
      : typeof s.answers === "function"
        ? s.answers(body.questions)
        : (s.answers ?? safe);
    if (!answers) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 300 } }));
  }) as unknown as typeof fetch;
  const host: Host = {
    context: async () => messages,
    parent: async (id) => s.parents?.[id],
    loadMode: async (id) => stored.get(id),
    saveMode: async (id, mode) => void stored.set(id, mode),
    changed: (e) => void changes.push(e),
    notify: (e) => void toasts.push(e),
    log: (level, message, extra) => void logs.push({ level, message, ...(extra ? { extra } : {}) }),
  };
  const directory = s.directory ?? "/Users/me/Projects/app";
  const options = typeof s.options === "function" ? s.options : resolveOptions(s.options);
  const gate: Gate = createGate(host, options, directory, {
    fetch: fetchImpl,
    git: async () => ({ branch: "feature", dirty: false }),
    gitIgnored: async () => new Set(),
  });
  let n = 0;
  /** The permission action OpenCode raises for a tool, and its resources. */
  const actionOf = (tool: string, args: Record<string, unknown>): { action: string; resources: string[]; metadata?: Record<string, unknown> } => {
    if (tool === "shell") return { action: "shell", resources: [String(args.command ?? "")] };
    if (tool === "edit" || tool === "write") {
      const file = String(args.path ?? "");
      return { action: "edit", resources: [file], metadata: { files: [{ file, patch: "", status: "modified" }] } };
    }
    if (tool === "patch") return { action: "edit", resources: [], metadata: { files: (args.files as string[] | undefined)?.map((file) => ({ file })) ?? [] } };
    if (tool === "read" || tool === "glob" || tool === "grep") return { action: tool, resources: [String(args.path ?? args.pattern ?? "")] };
    if (tool === "question") return { action: "question", resources: ["*"] };
    return { action: tool, resources: ["*"] };
  };
  /**
   * One tool call: `execute.before`, then the `evaluate` hook with OpenCode's effect (`allow`
   * unless given). Resolves to the effect and message the gate left.
   */
  const call = async (tool: string, args: Record<string, unknown>, opts: { sessionID?: string; effect?: Effect; callID?: string } = {}): Promise<Outcome> => {
    n++;
    const sessionID = opts.sessionID ?? "s";
    const callID = opts.callID ?? `c${n}`;
    gate.before(sessionID, callID, tool, args);
    const event: Evaluation = {
      sessionID,
      ...actionOf(tool, args),
      source: { type: "tool", messageID: `m${n}`, id: callID },
      effect: opts.effect ?? "allow",
    };
    await gate.evaluate(event);
    return { effect: event.effect, ...(event.message !== undefined ? { message: event.message } : {}) };
  };
  /** OpenCode published the prompt for the last asked call and the user answered it. */
  const reply = (reply: "once" | "always" | "reject", sessionID = "s", callID = `c${n}`) => {
    const requestID = `p${n}`;
    gate.asked(sessionID, requestID, { id: callID });
    gate.replied(sessionID, requestID, reply);
  };
  const newTurn = (sessionID = "s") => gate.prompt(sessionID);
  return { gate, call, reply, newTurn, sent, logs, toasts, changes, stored, messages };
}
