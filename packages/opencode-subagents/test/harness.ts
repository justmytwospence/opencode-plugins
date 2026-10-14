// A fake OpenCode for the delegate tool: sessions in memory, children that answer from a script,
// and a recorder for prompts, interrupts, deliveries and worktrees.
import type { Host, ModelInfo, SessionInfo } from "../src/core.ts";
import type { AgentInfo } from "../src/pick.ts";
import type { MessageLike } from "../src/text.ts";

export interface Reply {
  text?: string;
  error?: string;
  /** Milliseconds before the child answers. */
  delay?: number;
  /** The child never answers on its own (until interrupted). */
  hang?: boolean;
}

export interface FakeSession extends SessionInfo {
  messages: MessageLike[];
  busy: Promise<void>;
  resolveBusy: () => void;
  running?: boolean;
}

export const AGENTS: AgentInfo[] = [
  { id: "general", description: "General-purpose agent" },
  { id: "explore", description: "Fast codebase exploration" },
  { id: "reviewer", description: "Independent review", model: "anthropic/claude-opus", variant: "high" },
];

export const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet", variants: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "anthropic", id: "claude-opus", variants: ["low", "high", "max"] },
  { provider: "anthropic", id: "claude-haiku", variants: [] },
];

export function fakeHost(reply: (sessionID: string, text: string, agent: string) => Reply = () => ({ text: "ok" })) {
  const sessions = new Map<string, FakeSession>();
  const prompts: { sessionID: string; text: string; delivery: string }[] = [];
  const interrupts: string[] = [];
  const deliveries: { sessionID: string; text: string }[] = [];
  const worktrees: { cwd: string; name: string; branch: string }[] = [];
  const logs: string[] = [];
  let next = 0;

  const settled = () => {
    let resolveBusy = () => undefined as void;
    const busy = new Promise<void>((r) => (resolveBusy = r));
    return { busy, resolveBusy };
  };

  const add = (input: Partial<FakeSession> & { id: string }): FakeSession => {
    const s: FakeSession = {
      projectID: "proj",
      directory: "/repo",
      model: { providerID: "anthropic", id: "claude-sonnet", variant: "default" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      messages: [],
      ...settled(),
      ...input,
    };
    s.resolveBusy();
    sessions.set(s.id, s);
    return s;
  };
  const parent = add({ id: "parent", messages: [{ type: "user", text: "please delegate", time: { created: 1 } }] });

  const host: Host = {
    agents: async () => AGENTS,
    models: async () => MODELS,
    session: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      const { messages: _m, busy: _b, resolveBusy: _r, ...info } = s;
      return info;
    },
    messages: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return [...s.messages];
    },
    create: async (input) => {
      const id = `child-${++next}`;
      add({ id, parentID: input.parentID, directory: input.directory, model: input.model, agent: input.agent } as Partial<FakeSession> & { id: string });
      return { id };
    },
    prompt: async (sessionID, text, delivery) => {
      prompts.push({ sessionID, text, delivery });
      const s = sessions.get(sessionID);
      if (!s) throw new Error(`no session ${sessionID}`);
      s.messages.push({ type: "user", text, time: { created: Date.now() } });
      // A steer into a running turn is just another message of that turn.
      if (s.running) return;
      const agent = (s as unknown as { agent?: string }).agent ?? "";
      const r = reply(sessionID, text, agent);
      Object.assign(s, settled());
      s.running = true;
      const answer = () => {
        if (s.outcome === "interrupted") return;
        s.running = false;
        const created = Date.now();
        s.messages.push({
          type: "assistant",
          time: { created, completed: created },
          content: r.text ? [{ type: "text", text: r.text }] : [],
          ...(r.error ? { error: { message: r.error } } : {}),
          finish: r.error ? "error" : "stop",
        });
        s.messages.push({ type: "idle", outcome: r.error ? "failed" : "succeeded", time: { created } });
        s.outcome = r.error ? "failed" : "succeeded";
        s.cost += 0.01;
        s.tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
        s.resolveBusy();
      };
      if (!r.hang) setTimeout(answer, r.delay ?? 0);
    },
    wait: async (sessionID) => {
      await sessions.get(sessionID)?.busy;
    },
    interrupt: async (sessionID) => {
      interrupts.push(sessionID);
      const s = sessions.get(sessionID);
      if (!s) return;
      s.outcome = "interrupted";
      s.running = false;
      s.messages.push({ type: "idle", outcome: "interrupted", time: { created: Date.now() } });
      s.resolveBusy();
    },
    deliver: async (sessionID, text) => {
      deliveries.push({ sessionID, text });
    },
    worktree: async ({ cwd, name, branch }) => {
      worktrees.push({ cwd, name, branch });
      return `${cwd}/.worktrees/${name}`;
    },
    log: (message) => void logs.push(message),
  };
  return { host, sessions, parent, prompts, interrupts, deliveries, worktrees, logs };
}

export const call = (sessionID = "parent", signal: AbortSignal = new AbortController().signal) => {
  const progress: Record<string, unknown>[] = [];
  return { context: { sessionID, signal, progress: (u: Record<string, unknown>) => void progress.push(u) }, progress };
};
