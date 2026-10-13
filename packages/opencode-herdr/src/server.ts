// opencode-herdr (server): the `herdr` RPC other components report through, the `herdr_child`
// tool, and the children bookkeeping. The port of pi-herdr; src/core is shared with it.
//
// OpenCode 2 runs this half once, in a shared service that serves every terminal and herdr pane,
// so it never knows a pane itself. The CLI half (src/tui.ts), which runs in a pane, calls the
// private `attach` RPC (src/rpc.ts) for the root session it shows; `herdr_child` finds the pane
// through the root of the session that called it and fails clearly when no herdr terminal shows
// it. Everything else here is keyed by session:
//
// - The `herdr` RPC (src/herdr-rpc.ts): `token`, `notify` and `zoom` calls are stored (tokens)
//   and re-emitted as events; the CLI half showing that session's family applies them to its pane.
//   `state` returns a session's tokens for a terminal that starts showing it. `ready` is emitted
//   once the RPC is registered, so components whose calls failed earlier can resend.
// - `herdr_child` (tool.transform): interactive OpenCode children in a herdr tab, a split beside
//   the parent's pane, or a new worktree's space. The OpenCode 2 TUI takes no `--model`, so the
//   child's session is created here first (with the model, in the child's directory) and the child
//   starts on it with `--session <id>`. Each reply to a message the parent sent arrives in the
//   parent session as a new prompt. While a reply is pending, the root session's pane token `bg`
//   names the child (emitted as a `token` event like any other).
// - Children are saved per parent session in the plugin's storage (`children:<session>`), so
//   `list`, `send` and pending replies survive a restart: polling resumes when a pane attaches
//   for that session's root.
import type { Plugin } from "@opencode/plugin";
import { Activity } from "./core/activity.ts";
import { type ChildRecord, Children, type Exec, type Where } from "./core/children.ts";
import { type Call, socketCall } from "./core/herdr.ts";
import { exec as runExec } from "./exec.ts";
import { HerdrRpc, type HerdrNotify, type HerdrToken, type HerdrZoom } from "./herdr-rpc.ts";
import { HerdrPaneRpc, type PaneAttachment } from "./rpc.ts";
import { type MessageLike, type ModelRef, type OpencodeChild, formatModel, opencodeChild, parseModel } from "./session.ts";

export const NAME = "herdr";
export const TOOL = "herdr_child";
const BG_TTL_MS = 90_000;
const STORAGE_PREFIX = "children:";

export const DESCRIPTION =
  "Start and talk to persistent, human-led OpenCode sessions in herdr, only for an explicit interactive-session request or a clear handoff to the user. Default to a subagent (the task tool) for delegated work that reports back to this session, even when long, multi-step, or parallel. Duration, complexity, and the possibility the user might want to watch are not reasons to create a Herdr pane. For an interactive handoff sharing this checkout and branch, use where=tab in the existing space; use where=split only for deliberate side-by-side interaction or when requested. Tabs and splits share files, not isolated parallel editors. Use where=worktree only for a user-requested independent branch/checkout; otherwise ask before creating one. It gets the checkout's own space (or a tab there if already open). Never create a new space or worktree merely because work is delegated, long, or parallel. Preserve focus unless asked to switch. action=spawn takes `task` (plus optional name, where, branch, model, focus); replies arrive as new messages in this session, so end your turn instead of polling. action=send (name, message), read (name), list, interrupt (name), close (name). Give it a complete, self-contained task: it cannot see this conversation. Needs this session open in OpenCode inside a herdr pane.";

export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["spawn", "send", "read", "list", "interrupt", "close"],
      description: "spawn a child; send it a message; read its last reply or screen; list children; interrupt its turn (Escape); close its pane",
    },
    task: { type: "string", description: "spawn: the complete, self-contained task" },
    name: { type: "string", description: "spawn: a short name (lowercase, dashes); otherwise from the task. send/read/interrupt/close: which child" },
    where: {
      type: "string",
      enum: ["tab", "split", "worktree"],
      description: "spawn: tab in this space for a persistent session sharing this checkout (default); split for side-by-side interaction; worktree for a user-requested independent branch/checkout in its own space (needs branch)",
    },
    branch: { type: "string", description: "spawn with where=worktree: the user-requested independent branch (checked out, tracked or created from HEAD); do not create a worktree without the user's request" },
    model: { type: "string", description: "spawn: provider/model[#variant]; default this session's" },
    focus: { type: "boolean", description: "spawn: switch to the child's pane (default false)" },
    message: { type: "string", description: "send: the message" },
    lines: { type: "number", description: "read: screen lines while it works (default 80)" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export interface ToolArgs {
  action: "spawn" | "send" | "read" | "list" | "interrupt" | "close";
  task?: string;
  name?: string;
  where?: Where;
  branch?: string;
  model?: string;
  focus?: boolean;
  message?: string;
  lines?: number;
}

export type { ModelRef } from "./session.ts";

export interface SessionLike {
  parentID?: string;
  model?: ModelRef;
  directory?: string;
}

/** What the server needs from OpenCode and the machine, so tests can fake it. */
export interface Host {
  session(sessionID: string): Promise<SessionLike | undefined>;
  /** A new session for a child, in `directory`; its id. */
  createSession(input: { directory: string; model?: ModelRef }): Promise<string>;
  removeSession(sessionID: string): Promise<void>;
  messages(sessionID: string, directory: string): Promise<MessageLike[] | undefined>;
  /** A child's reply (or a notice) as a new prompt in the parent session. */
  deliver(sessionID: string, text: string): Promise<void>;
  emit(name: "token" | "notify" | "zoom", data: Record<string, unknown>): void;
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  scan(prefix: string): Promise<string[]>;
  log(message: string): void;
  /** A herdr socket client; tests fake it. */
  socket(socketPath: string): Call;
  exec: Exec;
  pollMs?: number;
  readyPollMs?: number;
}

interface StoredChildren {
  root: string;
  records: ChildRecord[];
}

interface Bound {
  children: Children;
  agent: OpencodeChild;
  root: string;
  paneId: string;
  socketPath: string;
}

export interface Server {
  rpc: {
    token(input: HerdrToken): Promise<void>;
    notify(input: HerdrNotify): Promise<void>;
    zoom(input: HerdrZoom): Promise<void>;
    state(input: { sessionID: string }): Promise<{ tokens: HerdrToken[] }>;
  };
  pane: {
    attach(input: PaneAttachment): Promise<void>;
    detach(input: { sessionID: string; paneId: string }): Promise<void>;
  };
  execute(args: ToolArgs, ctx: { sessionID: string }): Promise<string>;
  /** The root of a session (walking parentID), cached. */
  root(sessionID: string): Promise<string>;
  /** Storage was scanned and awaited children restored for attached panes. */
  ready: Promise<void>;
  /** The children bound for a parent session, if any (tests drive their poll). */
  children(sessionID: string): Children | undefined;
  forget(sessionID: string): void;
  dispose(): void;
}

/** The model of the latest message that names one (assistant replies, model switches). */
export function lastMessageModel(messages: readonly MessageLike[]): ModelRef | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = (messages[i] as { model?: ModelRef } | undefined)?.model;
    if (m?.providerID && m.id) return { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) };
  }
  return undefined;
}

export function createServer(host: Host): Server {
  /** Tokens per session: kept until cleared or the session is deleted (the pane's TTL is refreshed by the CLI half). */
  const tokens = new Map<string, Map<string, HerdrToken>>();
  /** The pane showing each root session, from the CLI half. */
  const panes = new Map<string, PaneAttachment>();
  const roots = new Map<string, string>();
  /** Children per parent (calling) session, bound to the pane they use. */
  const bound = new Map<string, Bound>();
  /** What storage holds, by parent session; loaded at start and kept current. */
  const stored = new Map<string, StoredChildren>();
  /** The `bg` holds per root session. */
  const activity = new Map<string, Activity>();
  let disposed = false;

  /** Without undefined values: the event schemas reject an explicit `value: undefined`. */
  const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const setToken = (raw: HerdrToken) => {
    const t = clean(raw);
    let forSession = tokens.get(t.sessionID);
    if (!forSession) tokens.set(t.sessionID, (forSession = new Map()));
    if (t.value?.trim()) forSession.set(t.key, t);
    else forSession.delete(t.key);
    if (!forSession.size) tokens.delete(t.sessionID);
    host.emit("token", t);
  };

  const root = async (sessionID: string): Promise<string> => {
    const hit = roots.get(sessionID);
    if (hit) return hit;
    let id = sessionID;
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const info = await host.session(id);
      if (!info?.parentID) break;
      id = info.parentID;
    }
    roots.set(sessionID, id);
    return id;
  };

  const updateBg = (rootID: string) => {
    const a = activity.get(rootID);
    setToken({ sessionID: rootID, key: "bg", value: a?.token(), ttlMs: BG_TTL_MS });
  };

  const persist = (sessionID: string, rootID: string, rec: ChildRecord) => {
    let s = stored.get(sessionID);
    if (!s) stored.set(sessionID, (s = { root: rootID, records: [] }));
    s.root = rootID;
    const i = s.records.findIndex((r) => r.name === rec.name);
    if (i >= 0) s.records[i] = rec;
    else s.records.push(rec);
    void host.save(`${STORAGE_PREFIX}${sessionID}`, s).catch(() => undefined);
  };

  /** The Children of a parent session on the pane showing its root; rebuilt when the pane changes. */
  const bind = (sessionID: string, rootID: string, pane: PaneAttachment): Children => {
    const current = bound.get(sessionID);
    if (current && current.paneId === pane.paneId && current.socketPath === pane.socketPath) return current.children;
    const records = current ? [...current.children.records.values()] : (stored.get(sessionID)?.records ?? []);
    current?.children.shutdown();
    const agent = opencodeChild({ messages: host.messages }, host.exec, (directory, model) => host.createSession({ directory, ...(model ? { model } : {}) }));
    const children = new Children({
      call: host.socket(pane.socketPath),
      agent,
      selfPane: pane.paneId,
      exec: host.exec,
      persist: (rec) => persist(sessionID, rootID, rec),
      deliver: (_rec, text) => void host.deliver(sessionID, text).catch((e) => host.log(`could not deliver to ${sessionID}: ${String(e)}`)),
      hold: (rec, on) => {
        let a = activity.get(rootID);
        if (!a) activity.set(rootID, (a = new Activity()));
        a.apply("herdr:background", on ? { active: true, label: `child ${rec.name}`, id: `${sessionID}:${rec.name}` } : { active: false, id: `${sessionID}:${rec.name}` });
        updateBg(rootID);
      },
      ...(host.pollMs ? { pollMs: host.pollMs } : {}),
      ...(host.readyPollMs ? { readyPollMs: host.readyPollMs } : {}),
    });
    bound.set(sessionID, { children, agent, root: rootID, paneId: pane.paneId, socketPath: pane.socketPath });
    children.restore(records);
    return children;
  };

  /**
   * After a spawn: the sessions `args` created go to their records (herdr may not have reported
   * the child's session yet); one whose child never started is removed again.
   */
  const settleCreated = (sessionID: string, rootID: string, b: Bound) => {
    for (const [name, session] of b.agent.created) {
      const rec = b.children.records.get(name);
      if (rec) {
        if (!rec.session) {
          rec.session = session;
          persist(sessionID, rootID, rec);
        }
      } else void host.removeSession(session).catch(() => undefined);
    }
    b.agent.created.clear();
  };

  /** Stored children of sessions rooted at `rootID` whose reply is pending: resume polling on this pane. */
  const resume = (rootID: string, pane: PaneAttachment) => {
    for (const [sessionID, s] of stored) {
      if (s.root !== rootID || !s.records.some((r) => r.awaiting && !r.closed)) continue;
      bind(sessionID, rootID, pane);
    }
  };

  const ready = (async () => {
    try {
      for (const key of await host.scan(STORAGE_PREFIX)) {
        const value = (await host.load(key)) as StoredChildren | undefined;
        if (value && typeof value.root === "string" && Array.isArray(value.records)) stored.set(key.slice(STORAGE_PREFIX.length), value);
      }
    } catch (e) {
      host.log(`could not read saved children: ${String(e)}`);
    }
    for (const [rootID, pane] of panes) resume(rootID, pane);
  })();

  const need = (action: string, v: string | undefined, what: string) => {
    if (!v?.trim()) throw new Error(`action=${action} needs \`${what}\`.`);
    return v.trim();
  };

  return {
    ready,
    root,
    children: (sessionID) => bound.get(sessionID)?.children,
    rpc: {
      async token(input) {
        setToken(input);
      },
      async notify(input) {
        host.emit("notify", clean(input));
      },
      async zoom(input) {
        host.emit("zoom", clean(input));
      },
      async state(input) {
        return { tokens: [...(tokens.get(input.sessionID)?.values() ?? [])] };
      },
    },
    pane: {
      async attach(input) {
        panes.set(input.sessionID, input);
        await ready;
        if (!disposed) resume(input.sessionID, input);
      },
      async detach(input) {
        if (panes.get(input.sessionID)?.paneId === input.paneId) panes.delete(input.sessionID);
      },
    },
    async execute(args, ctx) {
      await ready;
      const rootID = await root(ctx.sessionID);
      const pane = panes.get(rootID);
      if (!pane) throw new Error(`${TOOL} needs this session open in OpenCode inside a herdr pane (none shows it, or opencode-herdr's terminal half is not loaded there).`);
      const children = bind(ctx.sessionID, rootID, pane);
      switch (args.action) {
        case "spawn": {
          const where: Where = args.where ?? "tab";
          const parent = await host.session(ctx.sessionID);
          // The calling session's model (its info, else its latest message; a subagent's, else its
          // root's), unless given.
          const modelOf = async (sessionID: string, info: SessionLike | undefined) => info?.model ?? lastMessageModel((await host.messages(sessionID, info?.directory ?? "")) ?? []);
          const model = args.model ? parseModel(args.model) : ((await modelOf(ctx.sessionID, parent)) ?? (rootID !== ctx.sessionID ? await modelOf(rootID, await host.session(rootID)) : undefined));
          if (args.model && !model) throw new Error(`model must be provider/model[#variant], not "${args.model}".`);
          let rec: ChildRecord;
          try {
            rec = await children.spawn({
              task: need(args.action, args.task, "task"),
              name: args.name,
              where,
              branch: args.branch,
              model: formatModel(model),
              focus: args.focus,
              cwd: parent?.directory ?? process.cwd(),
            });
          } finally {
            settleCreated(ctx.sessionID, rootID, bound.get(ctx.sessionID)!);
          }
          const place = where === "worktree" ? `worktree ${rec.branch} (${rec.cwd})` : where === "split" ? "a split beside this pane" : "a new tab";
          host.log(`${ctx.sessionID}: started child ${rec.name} in ${place}, pane ${rec.paneId}, session ${rec.session}`);
          return `Started herdr child "${rec.name}" in ${place}, pane ${rec.paneId}, and sent it the task. Its reply arrives as a message in this session when its turn ends; end your turn instead of polling.`;
        }
        case "send": {
          const rec = await children.send(need(args.action, args.name, "name"), need(args.action, args.message, "message"));
          return `Sent to ${rec.name}. Its reply arrives as a message.`;
        }
        case "read":
          return children.read(need(args.action, args.name, "name"), args.lines);
        case "list":
          return children.list();
        case "interrupt":
          return children.interrupt(need(args.action, args.name, "name"));
        case "close":
          return children.close(need(args.action, args.name, "name"));
        default:
          throw new Error(`unknown action ${String((args as { action?: unknown }).action)}.`);
      }
    },
    forget(sessionID) {
      tokens.delete(sessionID);
      panes.delete(sessionID);
      roots.delete(sessionID);
      activity.delete(sessionID);
      const b = bound.get(sessionID);
      if (b) {
        b.children.shutdown();
        bound.delete(sessionID);
      }
      if (stored.delete(sessionID)) void host.save(`${STORAGE_PREFIX}${sessionID}`, null).catch(() => undefined);
    },
    dispose() {
      disposed = true;
      for (const b of bound.values()) b.children.shutdown();
      bound.clear();
    },
  };
}

export default {
  id: NAME,
  async setup(ctx) {
    const log = (message: string) => console.error(`[herdr] ${message}`);
    const directoryOf = (info: { location?: { directory?: string } } | undefined) => info?.location?.directory;
    const host: Host = {
      session: async (sessionID) => {
        try {
          const info = (await ctx.session.get({ sessionID })) as { parentID?: string; model?: ModelRef; location?: { directory?: string } };
          return { parentID: info.parentID, model: info.model, directory: directoryOf(info) };
        } catch {
          return undefined;
        }
      },
      createSession: async (input) => {
        const info = await ctx.session.create({ location: { directory: input.directory }, ...(input.model ? { model: input.model } : {}) });
        return info.id;
      },
      removeSession: async (sessionID) => {
        await ctx.session.remove({ sessionID });
      },
      messages: async (sessionID) => {
        try {
          return (await ctx.session.context({ sessionID })) as unknown as MessageLike[];
        } catch {
          return undefined;
        }
      },
      deliver: async (sessionID, text) => {
        await ctx.session.prompt({ sessionID, text, delivery: "queue" });
      },
      emit: (name, data) => void rpc.events.emit(name, data).catch(() => undefined),
      load: (key) => ctx.storage.get(key),
      save: async (key, value) => {
        if (value === null || value === undefined) await ctx.storage.remove(key);
        else await ctx.storage.set(key, value as never);
      },
      scan: async (prefix) => {
        const keys: string[] = [];
        let after: string | undefined;
        do {
          const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}) });
          for (const e of page.entries) keys.push(e.key);
          after = page.next;
        } while (after);
        return keys;
      },
      log,
      socket: socketCall,
      exec: runExec,
    };
    const server = createServer(host);
    const rpc = await ctx.rpc.register(HerdrRpc, {
      token: async (input) => {
        await server.rpc.token(input as HerdrToken);
        return {};
      },
      notify: async (input) => {
        await server.rpc.notify(input as HerdrNotify);
        return {};
      },
      zoom: async (input) => {
        await server.rpc.zoom(input as HerdrZoom);
        return {};
      },
      state: async (input) => server.rpc.state(input as { sessionID: string }) as never,
    });
    const paneRpc = await ctx.rpc.register(HerdrPaneRpc, {
      attach: async (input) => {
        await server.pane.attach(input as PaneAttachment);
        return {};
      },
      detach: async (input) => {
        await server.pane.detach(input as { sessionID: string; paneId: string });
        return {};
      },
    });
    const tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        description: DESCRIPTION,
        input: INPUT_SCHEMA,
        // A direct tool, as in V1: the model must see the guidance above when it decides, which
        // Code Mode's catalog (the default for plugin tools) would hide behind `execute`.
        options: { codemode: false },
        execute: async (input, context) => ({ content: await server.execute(input as ToolArgs, { sessionID: context.sessionID }) }),
      });
    });

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as { type?: string; data?: { sessionID?: string } };
          if (e.type === "session.deleted" && e.data?.sessionID) server.forget(e.data.sessionID);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    void rpc.events.emit("ready", {}).catch(() => undefined);
    log("registered the herdr RPC and herdr_child");
    return async () => {
      stop.abort();
      server.dispose();
      await Promise.allSettled([tool.dispose(), paneRpc.dispose(), rpc.dispose()]);
    };
  },
} satisfies Plugin.Plugin;
