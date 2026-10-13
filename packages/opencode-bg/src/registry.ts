// The tasks and their processes. One registry per OpenCode server; tasks belong to the session
// whose agent started them. Each task runs `bash -c <command>` in its own process group, with
// stdout and stderr written straight to a log file, so output keeps flowing whatever OpenCode does.
//
// `state/<pid>-<instance>.json` (beside the logs) lists one registry's running tasks (a server
// runs one per location), so a later server can kill what a crashed one left behind. Kept
// services are left alone (and listed nowhere).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogFollower, logSize } from "./log.ts";

export type Kind = "job" | "service";
export type Status = "running" | "done" | "failed" | "killed" | "timeout";

export interface Task {
  id: string;
  /** The session whose agent started it; its wake-ups go there. */
  sessionID: string;
  name: string;
  kind: Kind;
  command: string;
  cwd: string;
  logPath: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: Status;
  /** A service whose `ready` pattern has matched. */
  ready: boolean;
  readyPattern?: string;
  timeoutSec?: number;
  /** A service left running when the server stops or the session is deleted. */
  keep: boolean;
  /** Who stopped it, when someone did. */
  killedBy?: "agent" | "user" | "session" | "timeout";
  /** The agent has (or is about to get) this task's outcome: no wake-up is owed. */
  delivered: boolean;
  /** The agent has been told the service is ready. */
  readyDelivered: boolean;
  /** The line that matched `ready`. */
  readyLine?: string;
  /** The shell exited but processes it started are still running in its group. */
  strays?: boolean;
}

export type TaskEvent = { type: "start" | "ready" | "end"; task: Task };

export interface StartOptions {
  command: string;
  name: string;
  kind: Kind;
  cwd: string;
  sessionID: string;
  ready?: string;
  timeoutSec?: number;
  keep?: boolean;
}

interface StateEntry {
  id: string;
  name: string;
  command: string;
  pid: number;
  keep: boolean;
}

const POLL_MS = 500;
/** A running task's log is cut back to its last megabyte when it passes this size. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const KEEP_TAIL_BYTES = 1024 * 1024;
/** How often (in polls) running logs are checked against the cap. */
const SIZE_CHECK_POLLS = 20;
const KILL_GRACE_MS = 3_000;
const KEEP_LOG_DAYS = 7;

/** Where logs and state live: `OPENCODE_BG_DIR`, else `bg/` under OpenCode's data directory. */
export function bgDir(): string {
  if (process.env.OPENCODE_BG_DIR) return process.env.OPENCODE_BG_DIR;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "bg");
}

function stateDir(): string {
  return path.join(bgDir(), "state");
}

function shell(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** Whether any process of the group led by `pid` is still alive. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals a whole process group. Never a bare pid: a reused pid could belong to anything. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

const squash = (s: string) => s.replace(/\s+/gu, " ").trim();

/**
 * Whether `pid` still runs the task's command (`bash -c <command>`, or the command itself when bash
 * exec'd into it), so a pid reused by an unrelated process is never signalled.
 */
export function stillOurs(pid: number, command: string): boolean {
  let line: string;
  try {
    line = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  } catch {
    return false;
  }
  const want = squash(command).slice(0, 40);
  return want.length > 0 && squash(line).includes(want);
}

/** A pattern from the model: `/src/flags`, or a plain regex matched case-insensitively. */
export function parsePattern(pattern: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/su.exec(pattern);
  return m ? new RegExp(m[1] as string, (m[2] ?? "").replace(/[gy]/gu, "")) : new RegExp(pattern, "i");
}

export class Registry {
  readonly tasks = new Map<string, Task>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly followers = new Map<string, { follower: LogFollower; re: RegExp }>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(e: TaskEvent) => void>();
  /** Process groups of ended tasks that still have members, killed with the session. */
  private readonly strays = new Map<string, Set<number>>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private polls = 0;
  /** Ended tasks hidden from lists (`clear` in the panel). */
  readonly cleared = new Set<string>();
  /** This registry's state file: the server's pid, then a tag telling its instances apart. */
  private readonly instance = `${process.pid}-${randomBytes(2).toString("hex")}`;

  subscribe(fn: (e: TaskEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: TaskEvent["type"], task: Task): void {
    for (const fn of [...this.listeners]) {
      try {
        fn({ type, task });
      } catch {
        // A listener must not break the registry.
      }
    }
  }

  /** A session's tasks, oldest first; every session's when none is given. */
  list(sessionID?: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => !this.cleared.has(t.id) && (sessionID === undefined || t.sessionID === sessionID))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  running(sessionID?: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "running" && (sessionID === undefined || t.sessionID === sessionID))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** By id, by id prefix, or by name (the most recent task with it), among a session's tasks. */
  find(ref: string, sessionID?: string): Task | undefined {
    const r = ref.trim();
    if (!r) return undefined;
    const exact = this.tasks.get(r);
    if (exact && (sessionID === undefined || exact.sessionID === sessionID)) return exact;
    const all = [...this.tasks.values()].filter((t) => sessionID === undefined || t.sessionID === sessionID).sort((a, b) => b.startedAt - a.startedAt);
    const byName = all.find((t) => t.name === r);
    if (byName) return byName;
    const byPrefix = all.filter((t) => t.id.startsWith(r));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString("hex").slice(0, 5);
      if (!this.tasks.has(id) && !/^\d+$/u.test(id)) return id;
    }
  }

  start(o: StartOptions): Task {
    const id = this.newId();
    const dir = path.join(bgDir(), o.sessionID || "no-session");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `${id}.log`);
    const re = o.ready ? parsePattern(o.ready) : undefined;
    const task: Task = {
      id,
      sessionID: o.sessionID,
      name: o.name,
      kind: o.kind,
      command: o.command,
      cwd: o.cwd,
      logPath,
      startedAt: Date.now(),
      status: "running",
      ready: false,
      readyPattern: o.ready,
      timeoutSec: o.kind === "job" ? o.timeoutSec : undefined,
      keep: o.kind === "service" && Boolean(o.keep),
      delivered: false,
      readyDelivered: false,
    };
    const fd = fs.openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(shell(), ["-c", o.command], {
        cwd: o.cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, OPENCODE_BG_TASK_ID: id },
      });
    } finally {
      fs.closeSync(fd);
    }
    task.pid = child.pid;
    this.tasks.set(id, task);
    this.procs.set(id, child);
    child.unref();
    child.on("error", (err) => {
      fs.appendFileSync(logPath, `\n[bg] could not start: ${err.message}\n`);
      this.finish(id, 127, null);
    });
    child.on("exit", (code, signal) => this.finish(id, code, signal));
    if (re) this.followers.set(id, { follower: new LogFollower(logPath), re });
    if (task.timeoutSec && task.timeoutSec > 0) {
      const t = setTimeout(() => void this.kill(id, "timeout"), task.timeoutSec * 1000);
      t.unref?.();
      this.timeouts.set(id, t);
    }
    this.ensurePoller();
    this.persist();
    this.emit("start", task);
    return task;
  }

  private ensurePoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.poll(), POLL_MS);
    this.poller.unref?.();
  }

  /** Ready patterns and the log size cap. */
  poll(): void {
    if (++this.polls % SIZE_CHECK_POLLS === 0) this.capLogs();
    for (const [id, w] of this.followers) {
      const task = this.tasks.get(id);
      if (!task || task.status !== "running" || task.ready) {
        this.followers.delete(id);
        continue;
      }
      for (const line of w.follower.read()) {
        w.re.lastIndex = 0;
        if (w.re.test(line)) {
          this.markReady(task, line);
          break;
        }
      }
    }
    if (!this.followers.size && !this.running().length) {
      if (this.poller) clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  /**
   * Cuts a running task's log back to its last megabyte once it passes 64 MB. The cut tail goes back
   * through an appending descriptor, so a line the task writes meanwhile lands beside it instead of
   * being overwritten; a ready pattern's follower starts over at the cut.
   */
  capLogs(max = MAX_LOG_BYTES, keep = KEEP_TAIL_BYTES): void {
    for (const t of this.tasks.values()) {
      if (t.status !== "running") continue;
      const size = logSize(t.logPath);
      if (size <= max) continue;
      try {
        const fd = fs.openSync(t.logPath, "r");
        let text: string;
        try {
          const buf = Buffer.alloc(Math.min(keep, size));
          fs.readSync(fd, buf, 0, buf.length, size - buf.length);
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        const tailStart = text.indexOf("\n") + 1;
        fs.truncateSync(t.logPath, 0);
        fs.appendFileSync(t.logPath, `[bg] log cut at ${Math.round(max / 1024 / 1024)} MB; earlier output dropped\n${text.slice(tailStart)}`);
      } catch {
        // Leave it; the next check tries again.
      }
    }
  }

  private markReady(task: Task, line: string): void {
    if (task.ready) return;
    task.ready = true;
    task.readyLine = line;
    this.followers.delete(task.id);
    this.emit("ready", task);
  }

  private finish(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    // Read the last of the log before deciding about readiness, in case the line came at the end.
    const w = this.followers.get(id);
    if (w && !task.ready) {
      for (const line of w.follower.flush()) {
        w.re.lastIndex = 0;
        if (w.re.test(line)) {
          task.ready = true;
          task.readyLine = line;
          break;
        }
      }
    }
    this.followers.delete(id);
    const t = this.timeouts.get(id);
    if (t) clearTimeout(t);
    this.timeouts.delete(id);
    this.procs.delete(id);
    task.endedAt = Date.now();
    task.exitCode = code;
    task.signal = signal;
    // A command that exited 0 on its own finished, even if a stop or timeout raced it.
    task.status = code === 0 ? "done" : task.killedBy === "timeout" ? "timeout" : task.killedBy ? "killed" : "failed";
    // The shell is gone; anything it left running in its group (`npm run dev &`) dies with the session.
    if (task.pid && groupAlive(task.pid)) {
      task.strays = true;
      const set = this.strays.get(task.sessionID) ?? new Set<number>();
      set.add(task.pid);
      this.strays.set(task.sessionID, set);
    }
    this.persist();
    this.emit("end", task);
  }

  /** SIGTERM to the task's process group, then SIGKILL after a grace period. Resolves once it ended. */
  async kill(id: string, by: NonNullable<Task["killedBy"]>, graceMs = KILL_GRACE_MS): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running" || !task.pid) return;
    task.killedBy ??= by;
    const pid = task.pid;
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(pid)) await new Promise((r) => setTimeout(r, 50));
    const forced = groupAlive(pid);
    if (forced) signalGroup(pid, "SIGKILL");
    if (task.status === "running") {
      // The shell's exit event normally lands first.
      const until = Date.now() + 1_000;
      while (task.status === "running" && Date.now() < until && this.procs.has(id)) await new Promise((r) => setTimeout(r, 20));
      if (task.status === "running") this.finish(id, null, forced ? "SIGKILL" : "SIGTERM");
    }
    this.strays.get(task.sessionID)?.delete(pid);
  }

  /**
   * Kill every running task except kept services, and what ended tasks left behind: a session's
   * when one is given (the session was deleted), else everything (the server stops).
   */
  async killAll(by: NonNullable<Task["killedBy"]>, sessionID?: string, graceMs = 1_000): Promise<void> {
    const strays: number[] = [];
    for (const [sid, set] of this.strays) {
      if (sessionID !== undefined && sid !== sessionID) continue;
      strays.push(...set);
      this.strays.delete(sid);
    }
    for (const pgid of strays) signalGroup(pgid, "SIGTERM");
    await Promise.all(
      this.running(sessionID)
        .filter((t) => !t.keep)
        .map((t) => this.kill(t.id, by, graceMs)),
    );
    for (const pgid of strays) if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  }

  /** Forget a session's tasks that are not running (its kept services stay, and keep running). */
  forget(sessionID: string): void {
    for (const [id, t] of this.tasks) {
      if (t.sessionID !== sessionID) continue;
      if (t.status !== "running") {
        this.tasks.delete(id);
        this.cleared.delete(id);
      }
    }
  }

  // ---- state files ----

  private ownStatePath(): string {
    return path.join(stateDir(), `${this.instance}.json`);
  }

  private static readEntries(file: string): StateEntry[] {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private static writeEntries(file: string, entries: StateEntry[]): void {
    try {
      if (!entries.length) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } catch {
      // Best effort: losing it only loses crash cleanup.
    }
  }

  /** Rewrites this registry's state file: its running tasks. */
  persist(): void {
    Registry.writeEntries(
      this.ownStatePath(),
      this.running()
        .filter((t) => t.pid)
        .map((t) => ({ id: t.id, name: t.name, command: t.command, pid: t.pid as number, keep: t.keep })),
    );
  }

  /** The server stops for good: nothing of it is left for cleanup (kept services run on). */
  release(): void {
    Registry.writeEntries(this.ownStatePath(), []);
  }

  /**
   * At startup: kill what crashed servers left running (never kept services, never a pid that no
   * longer runs the task's command), and delete log directories older than a week. Returns the
   * names of the tasks killed.
   */
  sweep(): string[] {
    const killed: string[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(stateDir()).filter((name) => /^\d+(?:-[0-9a-f]+)?\.json$/u.test(name));
    } catch {
      // No state yet.
    }
    for (const name of files) {
      const owner = Number(/^\d+/u.exec(name)?.[0]);
      if (owner === process.pid) continue;
      const file = path.join(stateDir(), name);
      if (owner > 0 && pidAlive(owner)) continue;
      for (const e of Registry.readEntries(file)) {
        if (e.keep || !groupAlive(e.pid) || !stillOurs(e.pid, e.command)) continue;
        signalGroup(e.pid, "SIGTERM");
        const pgid = e.pid;
        setTimeout(() => {
          if (groupAlive(pgid) && stillOurs(pgid, e.command)) signalGroup(pgid, "SIGKILL");
        }, KILL_GRACE_MS).unref?.();
        killed.push(e.name);
      }
      fs.rmSync(file, { force: true });
    }
    this.cleanOldLogs();
    return killed;
  }

  private cleanOldLogs(): void {
    const cutoff = Date.now() - KEEP_LOG_DAYS * 86_400_000;
    const inUse = new Set([...this.tasks.values()].map((t) => path.dirname(t.logPath)));
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(bgDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name === "state") continue;
      const p = path.join(bgDir(), d.name);
      if (inUse.has(p)) continue;
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
    }
  }
}
