// opencode-subagents (server): the `delegate` tool, the port of pi-subagents' `subagent` tool on
// top of OpenCode's own child sessions. A delegated task is a child session (parentID = the
// calling session) of one of OpenCode's subagent-mode agents, prompted once and awaited
// (core.ts): a single task, parallel tasks, or a chain whose steps receive the previous output;
// in the foreground, or async with the results delivered as one queued synthetic message that
// starts a turn once the parent is idle; with fresh context, or the parent's conversation as
// background; optionally each in a new git worktree (`ctx.worktree.create`, then a branch).
// What a call leaves open (agent, model tier, variant) Jev picks, one request per task (pick.ts,
// jev.ts); without TYPESAFE_API_KEY the defaults apply. The tool is direct (`codemode: false`) so
// the model sees its description. Sessions `maxDepth` levels down lose the tool (the `context`
// hook drops it). Settings: `~/.config/agents/subagents.json`, the plugin options, then
// `<project>/.agents/subagents.json` and `<project>/.opencode/subagents.json` (settings.ts).
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "@opencode/plugin";
import { DEFAULT_OPTIONS, DESCRIPTION, type Host, type ModelInfo, type Options, SCHEMA, type SessionInfo, createDelegate } from "./core.ts";
import { loadSettings } from "./settings.ts";

export const NAME = "subagents";

const run = promisify(execFile);

/** The options in force now: defaults, the shared user file, the plugin options, the project files. */
export function currentOptions(raw: Record<string, unknown> | undefined, directory: string): Options {
  return loadSettings(NAME, DEFAULT_OPTIONS, raw, directory);
}

/** The main checkout of the repository `cwd` is in (its common git dir's parent), for `.worktrees/`. */
export async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 10_000, ...(signal ? { signal } : {}) });
  return stdout.trim().replace(/[\\/]\.git[\\/]?$/u, "");
}

export function createHost(ctx: Plugin.Context): Host {
  return {
    async agents() {
      const list = (await ctx.agent.list()) as unknown as { data?: readonly AgentLike[] } | readonly AgentLike[];
      const agents = Array.isArray(list) ? list : ((list as { data?: readonly AgentLike[] }).data ?? []);
      return agents
        .filter((a) => a.mode !== "primary" && !a.hidden)
        .map((a) => ({
          id: a.id,
          description: a.description ?? a.name,
          ...(a.model ? { model: `${a.model.providerID}/${a.model.id}` } : {}),
          ...(a.model?.variant ? { variant: a.model.variant } : {}),
        }));
    },
    async models() {
      const list = (await ctx.model.list()) as unknown as { data?: readonly ModelLike[] } | readonly ModelLike[];
      const models = Array.isArray(list) ? list : ((list as { data?: readonly ModelLike[] }).data ?? []);
      return models.map((m): ModelInfo => ({ provider: m.providerID, id: m.id, variants: (m.variants ?? []).map((v: { id: string }) => v.id) }));
    },
    async session(sessionID) {
      const info = (await ctx.session.get({ sessionID })) as unknown as SessionLike;
      return {
        id: info.id,
        ...(info.parentID ? { parentID: info.parentID } : {}),
        projectID: info.projectID,
        directory: info.location?.directory || ctx.location.directory,
        ...(info.model ? { model: info.model } : {}),
        cost: info.cost ?? 0,
        tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...(info.outcome ? { outcome: info.outcome } : {}),
        ...(info.time?.idle ? { idleAt: info.time.idle } : {}),
      } satisfies SessionInfo;
    },
    async messages(sessionID) {
      return (await ctx.session.context({ sessionID })) as unknown as Awaited<ReturnType<Host["messages"]>>;
    },
    async create(input) {
      // A child session is created in its parent's location (the host ignores `location` with a
      // parentID), so a task with another cwd (a worktree) is moved there before its prompt.
      const info = (await ctx.session.create({
        parentID: input.parentID,
        title: input.title,
        agent: input.agent,
        model: input.model,
      } as never)) as unknown as { id: string; location?: { directory?: string } };
      if (input.directory && input.directory !== info.location?.directory) {
        await ctx.session.move({ sessionID: info.id, directory: input.directory });
      }
      return { id: info.id };
    },
    async prompt(sessionID, text, delivery) {
      await ctx.session.prompt({ sessionID, text, delivery } as never);
    },
    async wait(sessionID) {
      await ctx.session.wait({ sessionID });
    },
    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID });
    },
    async deliver(sessionID, text) {
      await ctx.session.synthetic({ sessionID, text, description: "delegate", delivery: "queue" });
    },
    async worktree({ projectID, cwd, name, branch, signal }) {
      let root: string;
      try {
        root = await repositoryRoot(cwd, signal);
      } catch (error) {
        throw new Error(`worktree ${name} failed: not in a git repository: ${cwd} (${error instanceof Error ? error.message : String(error)})`);
      }
      // <repo>/.worktrees/<name>: the location every harness shares. OpenCode checks out HEAD detached;
      // the branch is made after, so the child's commits have a home.
      const created = (await ctx.worktree.create({ projectID, from: cwd, directory: path.join(root, ".worktrees"), name } as never)) as unknown as { directory: string };
      try {
        await run("git", ["switch", "-c", branch], { cwd: created.directory, timeout: 30_000, ...(signal ? { signal } : {}) });
      } catch (error) {
        console.error(`[${NAME}] worktree ${created.directory} stays detached: git switch -c ${branch} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return created.directory;
    },
    log: (message) => console.error(`[${NAME}] ${message}`),
  };
}

interface AgentLike {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  model?: { providerID: string; id: string; variant?: string };
}

interface ModelLike {
  id: string;
  providerID: string;
  variants?: readonly { id: string }[];
}

interface SessionLike {
  id: string;
  parentID?: string;
  projectID: string;
  location?: { directory?: string };
  model?: { providerID: string; id: string; variant?: string };
  cost?: number;
  tokens?: SessionInfo["tokens"];
  outcome?: SessionInfo["outcome"];
  time?: { idle?: number };
}

export default {
  id: NAME,
  async setup(ctx) {
    const ignore = () => undefined;
    const host = createHost(ctx);
    const options = () => currentOptions(ctx.options, ctx.location.directory);
    const delegate = createDelegate(host, options);

    const tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: "delegate",
        description: DESCRIPTION,
        input: SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => {
          const result = await delegate.execute(input as never, {
            sessionID: context.sessionID,
            signal: context.signal,
            progress: (update) => void context.progress(update).catch(ignore),
          });
          return { content: result.content, metadata: result.metadata };
        },
      });
    });

    // A session at the depth limit does not see the tool, so nesting cannot run away.
    const hook = await ctx.session.hook("context", async (event) => {
      if (!event.tools.delegate) return;
      if ((await delegate.depth(event.sessionID)) >= options().maxDepth) delete event.tools.delegate;
    });

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as { type?: string; data?: { sessionID?: string; info?: { id?: string } } };
          if (e.type !== "session.deleted") continue;
          const sessionID = e.data?.sessionID ?? e.data?.info?.id;
          if (sessionID) void delegate.sessionDeleted(sessionID).catch(ignore);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();

    host.log("registered delegate");
    return async () => {
      stop.abort();
      await delegate.dispose();
      await Promise.allSettled([tool.dispose(), hook.dispose()]);
    };
  },
} satisfies Plugin.Plugin;
