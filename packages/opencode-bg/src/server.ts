// opencode-bg (server): background jobs and services for OpenCode. The port of pi-bg.
//
// The tools bg_run, bg_wait, bg_logs and bg_kill (core.ts) are registered with
// `ctx.tool.transform` as direct tools (`codemode: false`), so the model sees them and their
// descriptions rather than reaching them through Code Mode's `execute`. The processes live in this shared server, keyed by the session whose
// agent started them (process groups, logs under `bg/` in OpenCode's data directory, registry.ts).
// A job's end, or a service's readiness, wakes the owning session's agent through
// `ctx.session.synthetic` with `delivery: "queue"`, which OpenCode delivers once the session is
// idle and then runs a turn on; wake-ups that come due during a turn wait for the idle status
// event and go out as one message. bg_wait returns early when a user message is enqueued for the
// session (`session.inbox.enqueued`), when the turn is interrupted (the tool's signal), or at its
// timeout. The CLI half (tui.ts) reads the tasks over the bg RPC (rpc.ts). While a job that will
// wake the agent runs, the session's herdr pane token `bg` names it (herdr-rpc.ts; ignored when
// opencode-herdr is absent). Deleting a session kills its tasks; the plugin's cleanup kills every
// task but kept services.
import type { Plugin } from "@opencode/plugin";
import { WAIT_DEFAULT_S, WAIT_MAX_S, createBg } from "./core.ts";
import { HerdrRpc } from "./herdr-rpc.ts";
import { Registry } from "./registry.ts";
import { BgRpc } from "./rpc.ts";

export const NAME = "bg";

/** The herdr pane token: lives a day unless cleared or refreshed (opencode-herdr may come later). */
const TOKEN_TTL_MS = 86_400_000;

export const RUN_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command (bash -c), run in its own process group with stdout and stderr to a log file" },
    kind: {
      enum: ["job", "service"],
      description: "job: finite, you need its result (tests, builds, fits, exports, long scripts). service: keeps running (dev or notebook servers, tunnels, watchers)",
    },
    name: { type: "string", description: "Short label for the footer and lists, e.g. `tests`, `vite`" },
    ready: { type: "string", description: "service: regex (case-insensitive, or /src/flags) for the log line that means it is up; you are woken once when it matches" },
    timeout: { type: "number", description: "job: kill it after this many seconds" },
    keep: { type: "boolean", description: "service: leave it running when this session ends or the server stops (a server the user works in)" },
    cwd: { type: "string", description: "Working directory (default: the session's)" },
  },
  required: ["command", "kind"],
  additionalProperties: false,
} as const;

export const WAIT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Task id or name; default: whichever running job ends first" },
    timeout: { type: "number", description: `Seconds to wait at most (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` },
  },
  additionalProperties: false,
} as const;

export const LOGS_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Task id or name; omit to list all tasks" },
    lines: { type: "number", description: "Lines to return (default 60, max 400)" },
    grep: { type: "string", description: "Only lines matching this regex (case-insensitive, or /src/flags)" },
    head: { type: "boolean", description: "The first lines instead of the last" },
  },
  additionalProperties: false,
} as const;

export const KILL_SCHEMA = {
  type: "object",
  properties: { id: { type: "string", description: "Task id or name" } },
  required: ["id"],
  additionalProperties: false,
} as const;

export const DESCRIPTIONS = {
  bg_run:
    "Run a shell command in the background, in its own process group, with its output in a log file. kind=job for a finite command whose result you need: you are woken with its outcome when it exits. kind=service for something that keeps running (dev or notebook server, tunnel, watcher): set `ready` to a regex for the line that means it is up; you are woken once when it matches, or if it exits. Use bg_run for commands that may take more than a minute and for anything that must keep running; the plain shell for the rest. After starting a job, keep doing other useful work; when nothing is left but the job's result, call bg_wait instead of ending your turn. Never poll with sleep loops or repeated bg_logs calls. Jobs and services stop when this session is deleted, except services with keep=true.",
  bg_wait: `Wait inside this turn for a background job to end (or a service to become ready, when named), then get its outcome and the end of its log. Without id, waits for whichever running job ends first. Returns early when the user sends a message, when the turn is interrupted, or after \`timeout\` seconds (default ${WAIT_DEFAULT_S}); the job keeps running and still wakes you when it ends.`,
  bg_logs: "Read a background task's log: its status, then the last lines (or the first, or only lines matching `grep`). Without id, lists every task of this session.",
  bg_kill: "Stop a background task: SIGTERM to its process group, then SIGKILL after 3 seconds.",
};

export default {
  id: NAME,
  async setup(ctx) {
    const log = (message: string) => console.error(`[bg] ${message}`);
    const ignore = () => undefined;
    const herdr = ctx.rpc(HerdrRpc);
    let emit: (sessionID: string) => void = ignore;

    const reg = new Registry();
    const swept = reg.sweep();
    if (swept.length) log(`killed leftovers of an earlier server: ${swept.join(", ")}`);

    const bg = createBg(reg, {
      wake: async (sessionID, text) => {
        await ctx.session.synthetic({ sessionID, text, description: "bg", delivery: "queue" });
      },
      token: (sessionID, value) => void herdr.token({ sessionID, key: "bg", ...(value === undefined ? {} : { value, ttlMs: TOKEN_TTL_MS }) }).then(ignore, ignore),
      changed: (sessionID) => emit(sessionID),
      log,
    });

    const rpc = await ctx.rpc.register(BgRpc, {
      tasks: async (input) => ({ tasks: bg.snapshot((input as { sessionIDs: string[] }).sessionIDs) }),
      logs: async (input) => {
        const { id, lines } = input as { id: string; lines?: number };
        return { lines: bg.logTail(id, lines ?? 30) };
      },
      kill: async (input) => ({ message: await bg.stop((input as { id: string }).id) }),
      clear: async (input) => ({ count: bg.clear((input as { sessionIDs: string[] }).sessionIDs) }),
    });
    emit = (sessionID) => void rpc.events.emit("changed", { sessionID }).catch(ignore);

    /** The session's own directory (a session may live elsewhere than this plugin instance). */
    const directoryOf = async (sessionID: string): Promise<string> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as { location?: { directory?: string } };
        return info.location?.directory || ctx.location.directory;
      } catch {
        return ctx.location.directory;
      }
    };
    const tool = await ctx.tool.transform((editor) => {
      const call = async (context: { sessionID: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> }) => ({
        sessionID: context.sessionID,
        cwd: await directoryOf(context.sessionID),
        signal: context.signal,
        progress: (title: string) => void context.progress({ title }).catch(ignore),
      });
      editor.add({
        name: "bg_run",
        description: DESCRIPTIONS.bg_run,
        input: RUN_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => ({ content: await bg.run(input as never, await call(context)) }),
      });
      editor.add({
        name: "bg_wait",
        description: DESCRIPTIONS.bg_wait,
        input: WAIT_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => ({ content: await bg.wait(input as never, await call(context)) }),
      });
      editor.add({
        name: "bg_logs",
        description: DESCRIPTIONS.bg_logs,
        input: LOGS_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => ({ content: await bg.logs(input as never, await call(context)) }),
      });
      editor.add({
        name: "bg_kill",
        description: DESCRIPTIONS.bg_kill,
        input: KILL_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => ({ content: await bg.kill(input as never, await call(context)) }),
      });
    });

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as {
            type?: string;
            data?: { sessionID?: string; inboxID?: string; status?: { type?: string }; item?: { type?: string } };
          };
          const sessionID = e.data?.sessionID;
          if (!sessionID) continue;
          switch (e.type) {
            case "session.status":
              bg.status(sessionID, e.data?.status?.type !== "idle");
              break;
            case "session.idle":
              bg.status(sessionID, false);
              break;
            case "session.inbox.enqueued":
              if (e.data?.item?.type === "user" && e.data.inboxID) bg.enqueued(sessionID, e.data.inboxID);
              break;
            case "session.inbox.delivered":
            case "session.inbox.cancelled":
              if (e.data?.inboxID) bg.dequeued(sessionID, e.data.inboxID);
              break;
            case "session.deleted":
              void bg.sessionDeleted(sessionID).catch(ignore);
              break;
            default:
              break;
          }
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    // opencode-herdr came up after us (or restarted): the tokens in force are sent again.
    const offReady = herdr.events.on("ready", () => bg.resendTokens(), { signal: stop.signal });

    log("registered bg_run, bg_wait, bg_logs and bg_kill");
    return async () => {
      stop.abort();
      try {
        offReady();
      } catch {
        // Already gone.
      }
      await bg.dispose();
      await Promise.allSettled([tool.dispose(), rpc.dispose()]);
    };
  },
} satisfies Plugin.Plugin;
