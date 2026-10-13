// opencode-marimo (server): follows the marimo notebooks open under this location's directory and
// gives each session's agent their state.
//
// - Context: when a session's user sends a prompt (the `prompt` hook), the state of every followed
//   notebook is taken once at the turn's first model request and appended to the turn's user
//   message in every model request of that turn (the `context` hook). It is never stored, so old
//   copies never pile up, and it stays unchanged through the turn so what the model reasoned after
//   it stays valid; at the next prompt a fresh copy replaces it. Being after the cached prefix
//   (system prompt and earlier turns), a changed notebook never invalidates the prompt cache.
// - Current notebook: the one the session's agent last worked in through marimo-pair (its tool
//   calls, the `execute.before` hook), so two sessions in two notebooks each keep their own even
//   though one server follows the directory for all of them; before that, the one used most
//   recently by anyone.
// - Status: the CLI halves ask for a session's report (rpc.ts) and are told when it changes.
// - herdr: when a session's turn ends while a cell its agent started still runs, the pane token
//   `marimo` says what runs until the kernel goes quiet, then a notification says it finished
//   (core/hold.ts, through the `herdr` RPC in herdr.ts).
//
// One shared server runs this once per location: the watcher is the location's, the rest is keyed
// by session. The port of pi-marimo; src/core is shared with it verbatim.
import type { Plugin } from "@opencode/plugin";
import { HERDR_TOKEN, KernelHold } from "./core/hold.ts";
import { nodeIo } from "./core/node-io.ts";
import { snapshot, STATE_TAG } from "./core/render.ts";
import { pairTargets } from "./core/touch.ts";
import { type Followed, MarimoWatcher, type Mode, parseMode, type WatcherOptions } from "./core/watcher.ts";
import { HerdrRpc } from "./herdr-rpc.ts";
import { HerdrHold, type HerdrPort, TTL_MS } from "./herdr.ts";
import { modeFromEnv } from "./mode.ts";
import { MarimoRpc, type NotebookReport, type Report } from "./rpc.ts";

/** The plugin's id. */
export const NAME = "marimo";

/** The parts of a model request's messages this reads and writes. */
export interface MessageLike {
  role: string;
  content: { type: string; text?: string }[];
}

interface SessionState {
  /** When this session's agent last worked in each notebook, by path. */
  touches: Map<string, number>;
  /** Per notebook path: browser edits after this change number are flagged as new. */
  seen: Map<string, number>;
  /** A prompt arrived: the turn's first model request takes a fresh state. */
  pending: boolean;
  /** The state taken for the current turn ("" when no notebook was connected). */
  turn?: { text: string };
  hold: KernelHold;
  inTurn: boolean;
}

export interface MarimoOptions {
  watcher: Omit<WatcherOptions, "onChange">;
  herdr: HerdrPort;
  /** Tells the CLI halves that a report changed. */
  changed(): void;
  /** Persists a mode chosen with /marimo. */
  saveMode?(mode: Mode): void;
  now?(): number;
  /** How long watcher changes are gathered before one render (0 in tests). */
  debounceMs?: number;
}

/**
 * The watcher's notebooks ranked for one session: connected first, then the one its agent worked
 * in last, then a running cell, then the latest use by anyone (the watcher's own rule, with this
 * session's touches in place of the watcher's).
 */
export function rankFor(followed: Followed[], touches: Map<string, number>): Followed[] {
  const rank = (f: Followed): number[] => [f.connection === "connected" ? 1 : 0, touches.get(f.attachment.path) ?? 0, f.notebook.running() ? 1 : 0, f.notebook.lastActivity];
  const ranked = followed
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => {
      for (let k = 0; k < a.r.length; k++) if (a.r[k] !== b.r[k]) return b.r[k]! - a.r[k]!;
      return a.i - b.i;
    });
  return ranked.map(({ f }, i) => ({ ...f, current: i === 0, touchedAt: touches.get(f.attachment.path) ?? 0 }));
}

/** The server's state machine, OpenCode-free: the watcher plus what each session sees and holds. */
export class Marimo {
  readonly watcher: MarimoWatcher;
  private readonly sessions = new Map<string, SessionState>();
  private readonly herdr: HerdrHold;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: MarimoOptions) {
    this.watcher = new MarimoWatcher({ ...options.watcher, onChange: () => this.schedule() });
    this.herdr = new HerdrHold(options.herdr);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(mode: Mode): void {
    this.watcher.mode = mode;
    this.watcher.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending);
    for (const [id, s] of this.sessions) await this.herdr.apply(id, s.hold.release());
    this.sessions.clear();
    await this.watcher.stop();
  }

  get mode(): Mode {
    return this.watcher.mode;
  }

  setMode(mode: Mode): void {
    this.watcher.setMode(mode);
    this.options.saveMode?.(mode);
    this.schedule();
  }

  private state(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = { touches: new Map(), seen: new Map(), pending: false, hold: new KernelHold(), inTurn: false };
      this.sessions.set(sessionID, s);
    }
    return s;
  }

  /** The followed notebooks as this session sees them: its current one first. */
  followedFor(sessionID: string): Followed[] {
    return rankFor(this.watcher.followed(), this.sessions.get(sessionID)?.touches ?? new Map());
  }

  report(sessionID: string): Report {
    const mode = this.watcher.mode;
    return {
      mode: mode.kind,
      ...(mode.kind === "pinned" ? { pinned: mode.paths } : {}),
      notebooks: this.followedFor(sessionID).map((f): NotebookReport => {
        const connected = f.connection === "connected";
        const run = connected ? f.notebook.running() : undefined;
        return {
          path: f.attachment.path,
          connection: f.connection,
          current: f.current,
          ...(run
            ? { running: { section: run.section.join(" › "), cell: run.cell.name !== "_" ? run.cell.name : run.cell.id, ...(run.since !== undefined ? { since: run.since } : {}) } }
            : {}),
          queued: connected ? f.notebook.queued() : 0,
          errors: connected ? f.notebook.errors().length : 0,
        };
      }),
    };
  }

  /** The state block for this session now: "" when no followed notebook is connected. */
  snapshot(sessionID: string): string {
    const seen = this.sessions.get(sessionID)?.seen;
    const entries = this.followedFor(sessionID)
      .filter((f) => f.connection === "connected" && f.notebook.ready)
      .map((f) => ({ notebook: f.notebook, attachment: f.attachment, current: f.current, seenSeq: seen?.get(f.attachment.path) ?? 0 }));
    return entries.length ? snapshot(entries, { refresh: "prompt", now: this.now() }) : "";
  }

  /** A prompt was sent: rescan so the turn's first request has the notebooks, and take a fresh state then. */
  async prompt(sessionID: string): Promise<void> {
    const s = this.state(sessionID);
    s.pending = true;
    s.turn = undefined;
    this.watcher.refresh();
    await this.watcher.settle(2000);
  }

  /** A model request of the session's turn: the turn's state goes at the end of the turn's user message. */
  context(sessionID: string, messages: MessageLike[]): void {
    const s = this.state(sessionID);
    if (s.pending || !s.turn) {
      s.pending = false;
      s.turn = { text: this.snapshot(sessionID) };
    }
    if (!s.turn.text) return;
    const user = messages.findLast((m) => m.role === "user");
    if (!user) return;
    if (user.content.some((p) => typeof p.text === "string" && p.text.startsWith(`<${STATE_TAG}`))) return;
    user.content.push({ type: "text", text: s.turn.text });
  }

  /** The notebooks a tool call's marimo-pair commands target become the ones this session works in. */
  toolCall(sessionID: string, input: unknown): boolean {
    const targets = pairTargets(JSON.stringify(input ?? {}));
    if (!targets.length) return false;
    const paths = this.watcher.targeted(targets);
    if (!paths.length) return false;
    const s = this.state(sessionID);
    const now = this.now();
    // Later calls in one tool call win.
    paths.forEach((p, i) => s.touches.set(p, now + i));
    this.schedule();
    return true;
  }

  /** The session's agent is working: any hold of its ends. */
  turnBegan(sessionID: string): void {
    const s = this.state(sessionID);
    if (s.inTurn) return;
    s.inTurn = true;
    void this.herdr.apply(sessionID, s.hold.begin(this.now()));
  }

  /** The session's agent is done for now: a cell it started that still runs holds the pane's attention. */
  turnEnded(sessionID: string): void {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    // Browser edits made after this point are flagged as new in the next turn.
    for (const f of this.watcher.followed()) s.seen.set(f.attachment.path, f.notebook.seq);
    if (!s.inTurn) return;
    s.inTurn = false;
    void this.herdr.apply(sessionID, s.hold.end(this.followedFor(sessionID), this.now()));
  }

  /** Whether the session's hold is active (tests). */
  holding(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.hold.active ?? false;
  }

  forget(sessionID: string): void {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    this.sessions.delete(sessionID);
    void this.herdr.apply(sessionID, s.hold.release());
  }

  /** opencode-herdr became ready: send the tokens of active holds again. */
  resendHerdr(): Promise<unknown> {
    return this.herdr.resend();
  }

  private schedule(): void {
    if (this.stopped) return;
    const ms = this.options.debounceMs ?? 150;
    if (ms <= 0) return this.render();
    this.pending ??= setTimeout(() => this.render(), ms);
  }

  private render(): void {
    this.pending = undefined;
    for (const [id, s] of this.sessions) if (s.hold.active) void this.herdr.apply(id, s.hold.update(this.followedFor(id), this.now()));
    this.options.changed();
  }
}

export default {
  id: NAME,
  async setup(ctx) {
    const herdr = ctx.rpc(HerdrRpc);
    const ignore = () => undefined;
    const port: HerdrPort = {
      token: (sessionID, value) => herdr.token({ sessionID, key: HERDR_TOKEN, ...(value === undefined ? {} : { value, ttlMs: TTL_MS }) }).then(ignore, ignore),
      notify: (sessionID, title, body) => herdr.notify({ sessionID, title, body, sound: "done", unlessFocused: true }).then(ignore, ignore),
    };
    const modeKey = `mode:${ctx.location.directory}`;
    let emit: (() => void) | undefined;
    const marimo = new Marimo({
      watcher: { io: nodeIo(), cwd: ctx.location.directory, token: process.env.MARIMO_TOKEN },
      herdr: port,
      changed: () => emit?.(),
      saveMode: (mode) => void ctx.storage.set(modeKey, mode).catch(ignore),
    });
    const rpc = await ctx.rpc.register(MarimoRpc, {
      status: async (input) => ({ report: marimo.report((input as { sessionID?: string }).sessionID ?? "") }),
      snapshot: async (input) => ({ text: marimo.snapshot((input as { sessionID?: string }).sessionID ?? "") }),
      mode: async () => ({ mode: marimo.mode }),
      setMode: async (input) => {
        const mode = parseMode((input as { mode: unknown }).mode);
        if (mode) marimo.setMode(mode);
        return {};
      },
      list: async () => ({ notebooks: await marimo.watcher.list() }),
    });
    emit = () => void rpc.events.emit("changed", {}).catch(ignore);
    const saved = parseMode(await ctx.storage.get(modeKey).catch(ignore));
    marimo.start(saved ?? modeFromEnv(process.env, ctx.options));

    await ctx.session.hook("prompt", (event) => marimo.prompt(event.sessionID));
    await ctx.session.hook("context", (event) => marimo.context(event.sessionID, event.messages as unknown as MessageLike[]));
    await ctx.tool.hook("execute.before", (event) => void marimo.toolCall(event.sessionID, event.input));

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as { type?: string; data?: { sessionID?: string; status?: { type?: string } } };
          const sessionID = e.data?.sessionID;
          if (!sessionID) continue;
          if (e.type === "session.status") {
            if (e.data?.status?.type === "idle") marimo.turnEnded(sessionID);
            else marimo.turnBegan(sessionID);
          } else if (e.type === "session.idle") marimo.turnEnded(sessionID);
          else if (e.type === "session.deleted") marimo.forget(sessionID);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    let offReady: (() => void) | undefined;
    try {
      offReady = herdr.events.on("ready", () => void marimo.resendHerdr(), { signal: stop.signal });
    } catch {
      // No event stream for the herdr RPC: tokens are sent once.
    }
    console.error(`[marimo] following notebooks under ${ctx.location.directory} (${marimo.mode.kind})`);
    return async () => {
      stop.abort();
      offReady?.();
      await marimo.stop();
      await rpc.dispose();
    };
  },
} satisfies Plugin.Plugin;
