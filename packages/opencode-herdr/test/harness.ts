// Fakes for the server half: an OpenCode (sessions, storage, delivered prompts, emitted RPC
// events) and a herdr with one parent pane and the child panes it creates (as test/core does).
import type { ChildRecord } from "../src/core/children.ts";
import type { Host, ModelRef, SessionLike } from "../src/server.ts";
import type { MessageLike } from "../src/session.ts";
import { fakeCall } from "./core/fake.ts";

export function fakeHerdr(opts: { startError?: { code: string; message: string } } = {}) {
  const agent = { agent: "opencode", interactive_ready: true, agent_status: "idle", completion_seq: 1 as number | undefined, state_change_seq: 1, agent_session: undefined as { kind: string; value: string } | undefined };
  const state = { agent, paneGone: false };
  const f = fakeCall({
    "pane.get": (p) => (p.pane_id === "w1:p1" ? { result: { pane: { pane_id: "w1:p1", workspace_id: "w1", focused: false } } } : state.paneGone ? { error: { code: "not_found", message: "pane not found" } } : { result: { pane: { pane_id: p.pane_id } } }),
    "agent.list": () => ({ result: { agents: [] } }),
    "tab.create": () => ({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }),
    "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }),
    "pane.split": () => ({ result: { pane: { pane_id: "w1:p3" } } }),
    "worktree.open": () => ({ result: { already_open: false, workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
    "agent.start": () => (opts.startError ? { error: opts.startError } : { result: { agent: { ...agent } } }),
    "agent.get": () => (state.paneGone ? { error: { code: "not_found", message: "agent not found" } } : { result: { agent: { ...state.agent } } }),
    "agent.prompt": () => ({ result: {} }),
    "agent.read": () => ({ result: { read: { text: "working on it" } } }),
  });
  return { ...f, state };
}

export function fakeHost(herdr = fakeHerdr()) {
  const sessions = new Map<string, SessionLike>();
  const messages = new Map<string, MessageLike[]>();
  const storage = new Map<string, unknown>();
  const delivered: { sessionID: string; text: string }[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const execs: string[][] = [];
  const removed: string[] = [];
  let next = 1;
  const host: Host = {
    session: async (id) => sessions.get(id),
    createSession: async ({ directory, model }) => {
      const id = `ses_child_${next++}`;
      sessions.set(id, { directory, ...(model ? { model } : {}) });
      return id;
    },
    removeSession: async (id) => void removed.push(id),
    messages: async (id) => messages.get(id),
    deliver: async (sessionID, text) => void delivered.push({ sessionID, text }),
    emit: (name, data) => void events.push({ name, data }),
    load: async (key) => storage.get(key),
    save: async (key, value) => void (value === null ? storage.delete(key) : storage.set(key, JSON.parse(JSON.stringify(value)))),
    scan: async (prefix) => [...storage.keys()].filter((k) => k.startsWith(prefix)),
    log: (m) => void logs.push(m),
    socket: () => herdr.call,
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      if (cmd === "worktree" && args[0] === "path") return { code: 0, stdout: "/repo/.worktrees/feat-x\n", stderr: "" };
      if (cmd === "git") return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    pollMs: 60_000,
    readyPollMs: 1,
  };
  const session = (id: string, info: SessionLike) => sessions.set(id, info);
  const reply = (sessionID: string, text: string) => messages.set(sessionID, [{ type: "user", content: [] }, { type: "assistant", content: [{ type: "text", text }] }]);
  const tokenEvents = () => events.filter((e) => e.name === "token").map((e) => e.data as { sessionID: string; key: string; value?: string });
  return { host, herdr, sessions, storage, delivered, events, logs, execs, removed, session, reply, tokenEvents, records: (k: string) => (storage.get(`children:${k}`) as { records: ChildRecord[] } | undefined)?.records };
}

export const OPUS: ModelRef = { providerID: "anthropic", id: "claude-opus-4-6", variant: "high" };
export const PANE = { sessionID: "ses_root", paneId: "w1:p1", socketPath: "/tmp/herdr.sock" };
