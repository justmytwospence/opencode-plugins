// opencode-tool-gate: auto-approves tool calls. The gate itself is in gate.ts; this wires it to
// OpenCode 2: the `evaluate` permission hook decides (allow, ask through OpenCode's own prompt,
// or deny with a reason the agent reads), `tool.execute.before` records each call's arguments
// for its evaluation, the session's `prompt` hook starts a user turn, and the event stream tells
// the gate how you answered a prompt. Each session's permission mode lives here, switched and
// shown by the CLI half (tui.ts) over the tool-gate RPC. Settings come from the shared
// `~/.config/agents/tool-gate.json` and `.agents/tool-gate.json`, the plugin options, and
// `.opencode/tool-gate.json`, read on each call (see settings.ts).
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "@opencode/plugin";
import { type Evaluation, type GitInfo, NAME, createGate, currentOptions } from "./gate.ts";
import { ToolGateRpc } from "./rpc.ts";
import type { MessageLike } from "./transcript.ts";

export { DEFAULT_OPTIONS, NAME, type Options, createGate, currentOptions, resolveOptions } from "./gate.ts";

const execFileAsync = promisify(execFile);

async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const branch = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2_000 });
    const dirty = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=no"], { timeout: 2_000 });
    return { branch: branch.stdout.trim() || "(detached)", dirty: dirty.stdout.trim().length > 0 };
  } catch {
    return undefined;
  }
}

/** Which of these paths git ignores, asked in the directory each `git add` runs in. */
async function gitIgnored(byDir: Map<string, string[]>): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (const [dir, files] of byDir) {
    try {
      const out = await execFileAsync("git", ["-C", dir, "check-ignore", "--", ...files], { timeout: 2_000 });
      for (const line of out.stdout.split("\n")) if (line.trim()) ignored.add(path.resolve(dir, line.trim()));
    } catch {
      // Unknown means not ignored: the call is held.
    }
  }
  return ignored;
}

export default {
  id: NAME,
  async setup(ctx) {
    const directory = ctx.location.directory;
    const log = (level: "info" | "warn", message: string, extra?: Record<string, unknown>) =>
      console.error(`[tool-gate] ${level === "warn" ? "warning: " : ""}${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
    let emit: (name: "changed" | "notice", data: Record<string, unknown>) => void = () => undefined;

    const gate = createGate(
      {
        context: async (sessionID) => (await ctx.session.context({ sessionID })) as unknown as readonly MessageLike[],
        parent: async (sessionID) => (await ctx.session.get({ sessionID }))?.parentID ?? undefined,
        loadMode: async (sessionID) => {
          const value = await ctx.storage.get(`mode/${sessionID}`);
          return typeof value === "string" ? value : undefined;
        },
        saveMode: (sessionID, mode) => ctx.storage.set(`mode/${sessionID}`, mode),
        changed: (event) => emit("changed", event as unknown as Record<string, unknown>),
        notify: (event) => emit("notice", event as unknown as Record<string, unknown>),
        log,
      },
      () => currentOptions(ctx.options, directory),
      directory,
      { git: gitInfo, gitIgnored },
    );

    // The contract's JSON schemas type the inputs as unknown; OpenCode validates them before the call.
    const rpc = await ctx.rpc.register(ToolGateRpc, {
      status: (input) => gate.status((input as { sessionID: string }).sessionID),
      setMode: async (input, { error }) => {
        const { sessionID, mode } = input as { sessionID: string; mode: string };
        const next = await gate.setMode(sessionID, mode);
        return next ? { mode: next } : error("unknown_mode", `Unknown mode "${mode}"`, {});
      },
      cycleMode: async (input) => ({ mode: await gate.cycleMode((input as { sessionID: string }).sessionID) }),
    });
    emit = (name, data) => void (rpc.events.emit as (name: string, data: unknown) => Promise<void>)(name, data).catch(() => undefined);

    await ctx.tool.hook("execute.before", (event) => gate.before(event.sessionID, event.id, event.tool, event.input));
    await ctx.permission.hook("evaluate", (event) => gate.evaluate(event as unknown as Evaluation));
    await ctx.session.hook("prompt", (event) => gate.prompt(event.sessionID));

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as { type?: string; data?: Record<string, unknown> };
          if (e.type === "permission.asked") {
            const d = e.data as { id: string; sessionID: string; source?: { id: string } };
            gate.asked(d.sessionID, d.id, d.source);
          } else if (e.type === "permission.replied") {
            const d = e.data as { sessionID: string; requestID: string; reply: "once" | "always" | "reject" };
            gate.replied(d.sessionID, d.requestID, d.reply);
          } else if (e.type === "session.deleted") {
            const d = e.data as { sessionID?: string; info?: { id?: string } } | undefined;
            const sessionID = d?.sessionID ?? d?.info?.id;
            if (sessionID) gate.forget(sessionID);
          }
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return () => stop.abort();
  },
} satisfies Plugin.Plugin;
