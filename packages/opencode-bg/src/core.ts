// The OpenCode-free core of opencode-bg: the four tools, the waits, the wake-ups and the herdr
// holds, over a Registry and a Host that server.ts fills with OpenCode calls (and tests fake).
//
// - bg_run starts a job (a finite command whose result the agent needs) or a service (a server,
//   tunnel or watcher). A job wakes the agent when it exits; a service wakes it once when its
//   `ready` pattern matches, or if it exits.
// - bg_wait keeps the turn going until a job ends, so the agent is visibly working while it waits.
//   It returns early when the user sends a message, when the turn is interrupted, or after its
//   timeout.
// - bg_logs reads a log (or lists the tasks); bg_kill stops one.
//
// Everything is per session: tasks belong to the session whose agent started them, wake-ups go
// there, and a session's bg_wait only sees its own tasks.
import fs from "node:fs";
import path from "node:path";
import { type TaskView, elapsed, header, marimoNote, nameFromCommand, outcome, report, runtime, taskLine } from "./format.ts";
import { bounded, grep, head, tail } from "./log.ts";
import { MARIMO_READY, marimoName, marimoServer } from "./marimo.ts";
import { type Kind, type Registry, type Task, type TaskEvent, parsePattern } from "./registry.ts";

export const STARTUP_WAIT_MS = 1_500;
export const WAIT_DEFAULT_S = 1_800;
export const WAIT_MAX_S = 3_600;
const LOGS_DEFAULT = 60;
const LOGS_MAX = 400;
const LOGS_BYTES = 12_000;

/** What the core needs from OpenCode. */
export interface Host {
  /** Wakes a session's agent with a message, once the session is idle (a queued synthetic message). */
  wake(sessionID: string, text: string): Promise<void>;
  /** Sets (a label) or clears (undefined) the session's herdr pane token `bg`. */
  token(sessionID: string, value: string | undefined): void;
  /** Tells the terminals that a session's tasks changed. */
  changed(sessionID: string): void;
  log(message: string): void;
}

/** What a tool call brings: the calling session, its directory, and the host's cancellation. */
export interface Call {
  sessionID: string;
  cwd: string;
  signal?: AbortSignal;
  /** Shown while the tool runs (bg_wait's `Waiting on tests 0:12`). */
  progress?: (title: string) => void;
}

export interface RunInput {
  command: string;
  kind: Kind;
  name?: string;
  ready?: string;
  timeout?: number;
  keep?: boolean;
  cwd?: string;
}
export interface WaitInput {
  id?: string;
  timeout?: number;
}
export interface LogsInput {
  id?: string;
  lines?: number;
  grep?: string;
  head?: boolean;
}
export interface KillInput {
  id: string;
}

type Reason = "done" | "message" | "timeout" | "aborted";

interface Waiter {
  sessionID: string;
  /** Task ids; empty with `any` means any running job of the session. */
  targets: Set<string>;
  any: boolean;
  /** bg_run's short startup check: takes only its own task, never other tasks' news. */
  silent: boolean;
  finished: Task[];
  readied: Task[];
  /** Other tasks of the session that ended (or got ready) meanwhile; delivered with this wait's result. */
  extras: string[];
  resolve: (r: Reason) => void;
}

export function createBg(reg: Registry, host: Host, options: { startupWaitMs?: number } = {}) {
  const startupWaitMs = options.startupWaitMs ?? STARTUP_WAIT_MS;
  const waiters = new Set<Waiter>();
  /** Wake-ups owed, by task id. Sent once the session is idle; whatever a tool delivered meanwhile is no longer owed. */
  const owed = new Map<string, "end" | "ready">();
  /** Sessions whose agent is running a turn now (from session.status events). */
  const busy = new Set<string>();
  /** User messages enqueued for a session and not yet delivered: a bg_wait returns so they can be. */
  const pending = new Map<string, Set<string>>();
  /** The herdr token value last sent per session. */
  const tokens = new Map<string, string>();
  let disposed = false;

  const jobs = (sessionID: string) => reg.running(sessionID).filter((t) => t.kind === "job");
  const hasPending = (sessionID: string) => (pending.get(sessionID)?.size ?? 0) > 0;

  /** The tasks a bg_wait is waiting on. */
  const waitingIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const w of waiters) {
      if (w.silent) continue;
      for (const id of w.targets) ids.add(id);
      if (w.any) for (const t of jobs(w.sessionID)) ids.add(t.id);
    }
    return ids;
  };

  const willWake = (t: Task) => t.status === "running" && !t.delivered;

  const view = (t: Task, waiting: Set<string>): TaskView => ({
    id: t.id,
    sessionID: t.sessionID,
    name: t.name,
    kind: t.kind,
    command: t.command,
    cwd: t.cwd,
    logPath: t.logPath,
    ...(t.pid !== undefined ? { pid: t.pid } : {}),
    startedAt: t.startedAt,
    ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    ...(t.signal !== undefined ? { signal: t.signal } : {}),
    status: t.status,
    ready: t.ready,
    ...(t.readyPattern !== undefined ? { readyPattern: t.readyPattern } : {}),
    ...(t.readyLine !== undefined ? { readyLine: t.readyLine } : {}),
    keep: t.keep,
    ...(t.killedBy !== undefined ? { killedBy: t.killedBy } : {}),
    waiting: waiting.has(t.id),
    willWake: willWake(t),
  });

  /** Label for the herdr token: the jobs whose end will wake the agent. */
  const tokenLabel = (sessionID: string): string | undefined => {
    const names: string[] = [];
    for (const t of reg.running(sessionID)) if (t.kind === "job" && !t.delivered) names.push(t.name);
    for (const id of owed.keys()) {
      const t = reg.tasks.get(id);
      if (t && t.sessionID === sessionID && t.status !== "running") names.push(t.name);
    }
    if (!names.length) return undefined;
    return names.length <= 2 ? names.join(" · ") : `${names.length} jobs`;
  };

  const syncToken = (sessionID: string) => {
    const want = tokenLabel(sessionID);
    if (tokens.get(sessionID) === want) return;
    if (want === undefined) tokens.delete(sessionID);
    else tokens.set(sessionID, want);
    host.token(sessionID, want);
  };

  const refresh = (sessionID: string) => {
    syncToken(sessionID);
    host.changed(sessionID);
  };

  // ---- waking the agent ----

  const wakeText = (t: Task, kind: "end" | "ready"): string => {
    if (kind === "ready") {
      return `Background service ${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}. It keeps running; bg_logs ${t.id} reads its log.`;
    }
    const what = t.kind === "job" ? "Background job" : "Background service";
    return `${what} ${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}.\n\n${report(t)}`;
  };

  /**
   * Sends a session's owed wake-ups as one message, while its agent is idle. One that comes due
   * during a turn waits for the turn to end (the idle status event flushes it), so several that
   * pile up go out together.
   */
  const flushOwed = (sessionID: string) => {
    if (disposed || busy.has(sessionID)) return;
    const parts: string[] = [];
    for (const [id, kind] of owed) {
      const t = reg.tasks.get(id);
      if (!t || t.sessionID !== sessionID) continue;
      owed.delete(id);
      if (kind === "end" ? t.delivered : t.readyDelivered) continue;
      if (kind === "end") t.delivered = true;
      else t.readyDelivered = true;
      parts.push(wakeText(t, kind));
    }
    if (!parts.length) return;
    host.wake(sessionID, parts.join("\n\n---\n\n")).catch((e) => host.log(`could not wake ${sessionID}: ${String(e)}`));
    refresh(sessionID);
  };

  const wake = (t: Task, kind: "end" | "ready") => {
    owed.set(t.id, kind);
    flushOwed(t.sessionID);
  };

  /** Hands an ended or ready task to a waiter of its session; true when one took it. */
  const toWaiter = (t: Task, kind: "end" | "ready"): boolean => {
    for (const w of waiters) {
      if (w.sessionID !== t.sessionID) continue;
      const targeted = w.targets.has(t.id) || (w.any && kind === "end" && t.kind === "job");
      if (!targeted) continue;
      if (kind === "end") {
        t.delivered = true;
        w.finished.push(t);
      } else {
        t.readyDelivered = true;
        w.readied.push(t);
      }
      w.resolve("done");
      return true;
    }
    const open = [...waiters].find((w) => !w.silent && w.sessionID === t.sessionID);
    if (!open) return false;
    if (kind === "end") t.delivered = true;
    else t.readyDelivered = true;
    open.extras.push(kind === "end" ? `${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}. bg_logs ${t.id} for its output.` : `${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}.`);
    return true;
  };

  const onTask = (e: TaskEvent) => {
    const t = e.task;
    if (e.type === "ready" && !t.readyDelivered) {
      if (!toWaiter(t, "ready")) wake(t, "ready");
    }
    if (e.type === "end") {
      const awaited = [...waiters].some((w) => w.sessionID === t.sessionID && (w.targets.has(t.id) || (w.any && t.kind === "job")));
      if (t.killedBy === "session") t.delivered = true;
      else if (awaited) toWaiter(t, "end");
      else if (t.killedBy === "agent") t.delivered = true;
      else if (!t.delivered) {
        if (t.killedBy === "user") {
          // The user stopped it from the panel: the agent is told, without a report.
          t.delivered = true;
          host.wake(t.sessionID, `The user stopped background task ${t.name} (${t.id}) after ${runtime(t)}.`).catch(() => undefined);
        } else if (!toWaiter(t, "end")) wake(t, "end");
      }
    }
    refresh(t.sessionID);
  };
  const unsubscribe = reg.subscribe(onTask);

  // ---- waiting ----

  const waitFor = (
    w: Omit<Waiter, "resolve" | "finished" | "readied" | "extras">,
    timeoutMs: number,
    tick: (() => Reason | undefined) | undefined,
  ): { waiter: Waiter; done: Promise<Reason> } => {
    let resolve!: (r: Reason) => void;
    const done = new Promise<Reason>((r) => {
      resolve = r;
    });
    let settled = false;
    const waiter: Waiter = { ...w, finished: [], readied: [], extras: [], resolve: () => {} };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const ticker = tick
      ? setInterval(() => {
          const r = tick();
          if (r) finish(r);
        }, 250)
      : undefined;
    function finish(r: Reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      waiters.delete(waiter);
      resolve(r);
    }
    waiter.resolve = finish;
    waiters.add(waiter);
    return { waiter, done };
  };

  // ---- tools ----

  const run = async (params: RunInput, call: Call): Promise<string> => {
    const kind = params.kind;
    if (kind !== "job" && kind !== "service") throw new Error("`kind` must be `job` or `service`.");
    if (!params.command?.trim()) throw new Error("`command` is required.");
    if (params.ready && kind !== "service") throw new Error("`ready` is for services; a job wakes you when it exits.");
    if (params.ready) parsePattern(params.ready);
    if (params.keep && kind !== "service") throw new Error("`keep` is for services.");
    if (params.timeout && kind !== "job") throw new Error("`timeout` is for jobs; a service runs until it is stopped.");
    // A marimo server still gets a name and a ready line.
    const server = kind === "service" ? marimoServer(params.command) : undefined;
    const cwd = params.cwd ? path.resolve(call.cwd, params.cwd.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~")) : call.cwd;
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No such directory: ${cwd}`);
    const task = reg.start({
      command: params.command,
      name: params.name?.trim() || (server ? marimoName(server) : nameFromCommand(params.command)),
      kind,
      cwd,
      sessionID: call.sessionID,
      ready: params.ready ?? (server ? MARIMO_READY : undefined),
      timeoutSec: params.timeout,
      keep: params.keep,
    });
    // A command that fails at once (a typo, a missing file) is reported here rather than as a wake-up.
    const { waiter, done } = waitFor({ sessionID: call.sessionID, targets: new Set([task.id]), any: false, silent: true }, startupWaitMs, undefined);
    await done;
    refresh(call.sessionID);
    if (waiter.finished.length) return `${task.name} (${task.kind} ${task.id}) ended at once.\n\n${report(task)}`;
    const lines = [`Started ${task.name} (${task.kind} ${task.id}, pid ${task.pid}). Log: ${task.logPath}`];
    if (task.kind === "job") {
      lines.push(`You will be woken when it exits${task.timeoutSec ? ` (killed after ${task.timeoutSec}s)` : ""}. If nothing else is left to do, call bg_wait instead of ending your turn.`);
    } else if (waiter.readied.length) {
      lines.push(`It is ready: ${task.readyLine}`);
    } else if (task.readyPattern) {
      lines.push(`You will be woken once when a log line matches /${task.readyPattern}/, or if it exits. bg_wait ${task.id} waits for that.`);
    } else {
      lines.push("You will be woken if it exits. Set `ready` next time to be told when it is up.");
    }
    if (task.keep) lines.push("It keeps running after this session ends.");
    return lines.join("\n");
  };

  const wait = async (params: WaitInput, call: Call): Promise<string> => {
    const sessionID = call.sessionID;
    const timeoutS = Math.min(Math.max(1, Math.round(params.timeout ?? WAIT_DEFAULT_S)), WAIT_MAX_S);
    const targets = new Set<string>();
    let any = false;
    if (params.id) {
      const t = reg.find(params.id, sessionID);
      if (!t) {
        const known = reg.list(sessionID).map((k) => `${k.id} ${k.name}`);
        throw new Error(`No task matches "${params.id}". ${known.length ? `Known: ${known.join(", ")}.` : "Nothing is running."}`);
      }
      if (t.status !== "running") {
        t.delivered = true;
        refresh(sessionID);
        return report(t);
      }
      if (t.kind === "service" && t.ready) {
        t.readyDelivered = true;
        return report(t);
      }
      if (t.kind === "service" && !t.readyPattern) throw new Error(`${t.name} is a service without a ready pattern: there is nothing to wait for until it exits.`);
      targets.add(t.id);
    } else {
      if (!jobs(sessionID).length) {
        const services = reg.running(sessionID).filter((t) => t.kind === "service");
        return `Nothing to wait for: no job is running.${services.length ? ` Services: ${services.map((t) => `${t.name} (${outcome(t)})`).join(", ")}.` : ""}`;
      }
      any = true;
    }
    if (hasPending(sessionID)) {
      return "Not waiting: a message from the user is queued and arrives when this tool returns. Running jobs keep going and wake you when they end.";
    }
    const names = () => (any ? jobs(sessionID) : [...targets].map((id) => reg.tasks.get(id)).filter((t): t is Task => !!t));
    const label = () => names().map((t) => `${t.name} ${runtime(t)}`).join(" · ");
    const started = Date.now();
    const setWorking = () => call.progress?.(`Waiting on ${label()} (type to interrupt)`);
    setWorking();
    let ticks = 0;
    const { waiter, done } = waitFor({ sessionID, targets, any, silent: false }, timeoutS * 1000, () => {
      if (disposed || call.signal?.aborted) return "aborted";
      if (hasPending(sessionID)) return "message";
      if (++ticks % 4 === 0) setWorking();
      return undefined;
    });
    refresh(sessionID);
    const reason = await done;
    refresh(sessionID);
    const out: string[] = [];
    for (const t of waiter.finished) out.push(report(t));
    for (const t of waiter.readied) out.push(report(t));
    if (reason !== "done") {
      const still = names().filter((t) => t.status === "running");
      const what = still.length ? still.map((t) => `${t.name} (${t.id}, ${runtime(t)})`).join(", ") : label();
      const why =
        reason === "message"
          ? "Stopped waiting: the user sent a message."
          : reason === "aborted"
            ? "Stopped waiting: interrupted."
            : `Stopped waiting after ${elapsed(Date.now() - started)} (the timeout).`;
      out.push(`${why} Still running: ${what}. It wakes you when it ends; call bg_wait again to keep waiting.`);
    }
    if (waiter.extras.length) out.push(`Also while you waited:\n${waiter.extras.map((e) => `- ${e}`).join("\n")}`);
    return out.join("\n\n");
  };

  const logs = async (params: LogsInput, call: Call): Promise<string> => {
    if (!params.id) {
      const lines = reg.list(call.sessionID).map((t) => taskLine(t));
      return lines.length ? lines.join("\n") : "No background tasks.";
    }
    const t = reg.find(params.id, call.sessionID);
    if (!t) throw new Error(`No task matches "${params.id}".`);
    const n = Math.min(Math.max(1, Math.round(params.lines ?? LOGS_DEFAULT)), LOGS_MAX);
    const lines = params.grep ? grep(t.logPath, parsePattern(params.grep), n) : params.head ? head(t.logPath, n) : tail(t.logPath, n);
    if (t.status !== "running" && !t.delivered) {
      t.delivered = true;
      owed.delete(t.id);
      refresh(call.sessionID);
    }
    const { text: body, dropped } = bounded(lines, LOGS_BYTES);
    const what = params.grep ? `lines matching ${params.grep}` : params.head ? "first lines" : "last lines";
    const shown = lines.length - dropped;
    return `${header(t)}\nLog: ${t.logPath}\n\n${shown ? `${shown} ${what}${dropped ? ` (${dropped} more cut for length)` : ""}:\n${body}` : `No ${what}.`}`;
  };

  const stopTask = async (t: Task, by: "agent" | "user") => {
    await reg.kill(t.id, by);
    refresh(t.sessionID);
  };

  const kill = async (params: KillInput, call: Call): Promise<string> => {
    const t = reg.find(params.id, call.sessionID);
    if (!t) throw new Error(`No task matches "${params.id}".`);
    if (t.status !== "running") {
      t.delivered = true;
      owed.delete(t.id);
      refresh(call.sessionID);
      return `${t.name} (${t.id}) already ended: ${outcome(t)} after ${runtime(t)}.`;
    }
    await stopTask(t, "agent");
    const note = marimoNote(t.command);
    const last = tail(t.logPath, 10);
    return [`Stopped ${t.name} (${t.id}) after ${runtime(t)}.`, note, last.length ? `Last lines:\n${bounded(last, 3_000).text}` : undefined].filter(Boolean).join("\n\n");
  };

  return {
    run,
    wait,
    logs,
    kill,

    // ---- what the server glue and the CLI half (over RPC) need ----

    /** The tasks of some sessions, as the terminals see them. */
    snapshot(sessionIDs: readonly string[]): TaskView[] {
      const waiting = waitingIds();
      const want = new Set(sessionIDs);
      return reg
        .list()
        .filter((t) => want.has(t.sessionID))
        .map((t) => view(t, waiting));
    },
    /** The user stops a task from the panel. */
    async stop(id: string): Promise<string> {
      const t = reg.tasks.get(id);
      if (!t) return `No task ${id}.`;
      if (t.status !== "running") return `${t.name} already ended.`;
      await stopTask(t, "user");
      return `stopped ${t.name}`;
    },
    /** Hides ended tasks of some sessions; the number hidden. */
    clear(sessionIDs: readonly string[]): number {
      let n = 0;
      for (const t of reg.list()) {
        if (t.status === "running" || !sessionIDs.includes(t.sessionID)) continue;
        reg.cleared.add(t.id);
        n++;
      }
      for (const id of new Set(sessionIDs)) host.changed(id);
      return n;
    },
    logTail(id: string, n: number): string[] {
      const t = reg.tasks.get(id);
      return t ? tail(t.logPath, Math.min(Math.max(1, n), LOGS_MAX)) : [];
    },

    // ---- session events ----

    /** The session's agent started or stopped running (session.status events). */
    status(sessionID: string, running: boolean): void {
      if (running) busy.add(sessionID);
      else {
        busy.delete(sessionID);
        flushOwed(sessionID);
      }
    },
    /** A user message was enqueued for the session (session.inbox.enqueued). */
    enqueued(sessionID: string, inboxID: string): void {
      let set = pending.get(sessionID);
      if (!set) pending.set(sessionID, (set = new Set()));
      set.add(inboxID);
    },
    /** An inbox item was delivered or cancelled. */
    dequeued(sessionID: string, inboxID: string): void {
      const set = pending.get(sessionID);
      if (!set) return;
      set.delete(inboxID);
      if (!set.size) pending.delete(sessionID);
    },
    /** The session was deleted: its tasks (but kept services) die, and nothing of it is owed. */
    async sessionDeleted(sessionID: string): Promise<void> {
      for (const w of [...waiters]) if (w.sessionID === sessionID) w.resolve("aborted");
      for (const [id] of owed) if (reg.tasks.get(id)?.sessionID === sessionID) owed.delete(id);
      busy.delete(sessionID);
      pending.delete(sessionID);
      await reg.killAll("session", sessionID);
      reg.forget(sessionID);
      syncToken(sessionID);
    },
    /** herdr came up (or back): the tokens in force are sent again. */
    resendTokens(): void {
      for (const [sessionID, value] of tokens) host.token(sessionID, value);
    },
    /** The server stops: every task but kept services dies. */
    async dispose(): Promise<void> {
      disposed = true;
      unsubscribe();
      for (const w of [...waiters]) w.resolve("aborted");
      await reg.killAll("session");
      reg.release();
    },
  };
}

export type Bg = ReturnType<typeof createBg>;
