// The delegate tool, OpenCode-free: runs (single, parallel, chain), their children as sessions of
// the host, Jev's picks for what a call leaves open, async delivery, and status/steer/stop/result
// by run id. server.ts binds it to OpenCode; the tests bind it to a fake host.
import path from "node:path";
import { askJev } from "./jev.ts";
import { clip, shortId, slug, taskLabel } from "./label.ts";
import { type AgentInfo, DEFAULT_TIER_DESCRIPTIONS, type Given, type Picks, type Resolved, type Tier, fitVariant, pickQuestions, providerTiers, readPicks, resolve } from "./pick.ts";
import { type MessageLike, forkPrompt, lastAssistantText, lastUserText, truncateOutput } from "./text.ts";

export interface Options {
  jev: { enabled: boolean; model: string; timeoutMs: number };
  /** Legacy tier defaults; only entries matching the parent's provider apply. */
  tiers: Partial<Record<Tier, string>>;
  /** Provider-specific tier defaults, selected using the current parent model. */
  providerTiers: Record<string, Partial<Record<Tier, string>>>;
  tierDescriptions: Record<Tier, string>;
  maxParallel: number;
  concurrency: number;
  /** Levels of children below a top-level session: 2 lets a child delegate once more, 1 does not. */
  maxDepth: number;
}

export const DEFAULT_OPTIONS: Options = {
  jev: { enabled: true, model: "jev-latest", timeoutMs: 3_000 },
  tiers: {},
  providerTiers: {},
  tierDescriptions: DEFAULT_TIER_DESCRIPTIONS,
  maxParallel: 8,
  concurrency: 4,
  maxDepth: 2,
};

/** A session as the host reports it. */
export interface SessionInfo {
  id: string;
  parentID?: string;
  projectID: string;
  directory: string;
  model?: { providerID: string; id: string; variant?: string };
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  outcome?: "succeeded" | "failed" | "interrupted";
  /** When the session last went idle. */
  idleAt?: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  variants: readonly string[];
}

/** What the tool needs from OpenCode, so tests can fake it. */
export interface Host {
  /** The agents a task may run as (subagent mode, not hidden), for the session's directory. */
  agents(directory: string): Promise<AgentInfo[]>;
  models(directory: string): Promise<ModelInfo[]>;
  session(sessionID: string): Promise<SessionInfo>;
  messages(sessionID: string): Promise<MessageLike[]>;
  create(input: { parentID: string; title: string; agent: string; model: { providerID: string; id: string; variant?: string }; directory: string }): Promise<{ id: string }>;
  prompt(sessionID: string, text: string, delivery: "steer" | "queue"): Promise<void>;
  /** Resolves once the session is idle. */
  wait(sessionID: string): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  /** A message to the parent, delivered once it is idle, that starts a turn. */
  deliver(sessionID: string, text: string): Promise<void>;
  /** A new checkout `<repo>/.worktrees/<name>` on branch `branch` from HEAD of `cwd`'s repository. */
  worktree(input: { projectID: string; cwd: string; name: string; branch: string; signal: AbortSignal }): Promise<string>;
  log(message: string): void;
  fetch?: typeof fetch;
}

export type Status = "queued" | "running" | "done" | "failed" | "stopped";

export interface Run {
  id: string;
  /** The session whose tool call started it. */
  parent: string;
  /** The child session, once created. */
  sessionID?: string;
  agent: string;
  task: string;
  label: string;
  model: string;
  variant?: string;
  byJev: Resolved["byJev"];
  tier?: Tier;
  cwd: string;
  async: boolean;
  status: Status;
  output: string;
  error?: string;
  turns: number;
  tokens: number;
  cost: number;
  startedAt: number;
  endedAt?: number;
}

export interface RunView extends Omit<Run, "parent" | "cwd" | "startedAt" | "endedAt"> {
  seconds: number;
}

export interface Item {
  agent?: string;
  task: string;
  label?: string;
  cwd?: string;
  model?: string;
  variant?: string;
}

export interface Input {
  action?: "run" | "status" | "steer" | "stop" | "result";
  agent?: string;
  task?: string;
  label?: string;
  tasks?: Item[];
  chain?: Item[];
  async?: boolean;
  context?: "fresh" | "fork";
  worktree?: boolean;
  cwd?: string;
  model?: string;
  variant?: string;
  id?: string;
  message?: string;
}

export interface CallContext {
  sessionID: string;
  signal: AbortSignal;
  progress: (update: Record<string, unknown>) => void;
}

export interface Result {
  content: string;
  metadata: { mode?: Mode; runs: RunView[]; title?: string };
  isError?: boolean;
}

type Mode = "single" | "parallel" | "chain";

export const SCHEMA = {
  type: "object",
  properties: {
    action: { enum: ["run", "status", "steer", "stop", "result"], description: "run (default), status, steer, stop, or result" },
    agent: { type: "string", description: "Agent for a single task; omit to let Jev choose" },
    task: { type: "string", description: "A single task" },
    label: { type: "string", description: "Short name for a single task; omit to derive from the task" },
    tasks: { type: "array", items: { $ref: "#/$defs/item" }, description: "Parallel tasks (up to 8, 4 at a time)" },
    chain: { type: "array", items: { $ref: "#/$defs/item" }, description: "Sequential steps; {previous} in a task is replaced by the previous step's output" },
    async: { type: "boolean", description: "Return at once and deliver results as a message when done (default false)" },
    context: { enum: ["fresh", "fork"], description: "fresh (default) or fork: start each child with this conversation as background" },
    worktree: { type: "boolean", description: "Run each task in a new git worktree, only when the user requests a worktree or branch isolation; otherwise ask (default false)" },
    cwd: { type: "string", description: "Working directory (default: the session's)" },
    model: { type: "string", description: "provider/model for a single task; explicit models may cross providers" },
    variant: { type: "string", description: "Model variant (effort) for a single task: low|medium|high|xhigh|max; omit to let Jev choose" },
    id: { type: "string", description: "Run id (or prefix) for status, steer, stop, result" },
    message: { type: "string", description: "Steering message for steer" },
  },
  additionalProperties: false,
  $defs: {
    item: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name; omit to let Jev choose" },
        task: { type: "string", description: "The complete, self-contained task" },
        label: { type: "string", description: "Short task name for lists and headings; omit to derive from the task" },
        cwd: { type: "string", description: "Working directory for this task" },
        model: { type: "string", description: "provider/model; omit for the agent's or Jev's tier on the parent's provider; explicit models may cross providers" },
        variant: { type: "string", description: "Model variant (effort): low|medium|high|xhigh|max; omit to let Jev choose" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
} as const;

export const DESCRIPTION =
  "Prefer doing work directly. Delegate only genuinely independent tasks with a clear payoff, or when the user requests it; each subagent is a child session with its own context and token usage. action=run (default): a single `task`, parallel `tasks`, or a `chain` whose steps can use {previous}. Omit agent, model, or variant to let Jev choose them; implicit models stay on the parent session's provider. `async: true` returns run ids at once and delivers the results as a message when they end. action=status|steer|stop|result take `id` (steer also `message`). Give each child a complete, self-contained task; it cannot see this conversation unless context is fork. Use worktree only when the user asks for a worktree or branch isolation; otherwise ask first.";

export function view(run: Run, withOutput = false): RunView {
  const { parent: _parent, cwd: _cwd, startedAt, endedAt, ...rest } = run;
  return {
    ...rest,
    output: withOutput ? clip(run.output, 2_000) : "",
    seconds: Math.round(((endedAt ?? Date.now()) - startedAt) / 1000),
  };
}

export interface Delegate {
  execute(input: Input, context: CallContext): Promise<Result>;
  /** How many sessions lie above `sessionID` (0 for a top-level session). */
  depth(sessionID: string): Promise<number>;
  /** The session is gone: its running children stop, its runs are forgotten. */
  sessionDeleted(sessionID: string): Promise<void>;
  /** Every running child is interrupted. */
  dispose(): Promise<void>;
  runs(): Run[];
}

function modelOf(info: SessionInfo | undefined): { model: string; variant?: string } {
  if (!info?.model) return { model: "" };
  const variant = info.model.variant && info.model.variant !== "default" ? info.model.variant : undefined;
  return { model: `${info.model.providerID}/${info.model.id}`, ...(variant ? { variant } : {}) };
}

/** A tick of real time, so a session's inbox can be admitted before we wait on it. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createDelegate(host: Host, options: Options | (() => Options)): Delegate {
  const optionsNow = typeof options === "function" ? options : () => options;
  const runs = new Map<string, Run>();
  const depths = new Map<string, number>();

  const findRun = (sessionID: string, id: string | undefined) => {
    if (!id) return undefined;
    const exact = runs.get(id);
    if (exact?.parent === sessionID) return exact;
    const matches = [...runs.values()].filter((r) => r.parent === sessionID && r.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const resultText = (run: Run) => {
    const head = `[${run.label} · ${run.agent} · ${run.model}${run.variant ? ` · ${run.variant}` : ""} · ${run.status}${run.error ? `: ${clip(run.error, 300)}` : ""}${run.sessionID ? ` · session ${run.sessionID}` : ""}]`;
    return `${head}\n${truncateOutput(run.output || "(no output)", `Full output in child session ${run.sessionID ?? "?"}.`)}`;
  };

  const depth = async (sessionID: string): Promise<number> => {
    const hit = depths.get(sessionID);
    if (hit !== undefined) return hit;
    let n = 0;
    let id: string | undefined = sessionID;
    const seen = new Set<string>();
    while (id && !seen.has(id) && n < 16) {
      seen.add(id);
      let info: SessionInfo;
      try {
        info = await host.session(id);
      } catch {
        break;
      }
      id = info.parentID;
      if (id) n++;
    }
    depths.set(sessionID, n);
    return n;
  };

  /** Jev's picks for the gaps in each item, one request per item, in parallel. */
  const plan = async (items: Item[], agents: AgentInfo[], parentInfo: SessionInfo, options: Options, signal: AbortSignal) => {
    const parent = modelOf(parentInfo);
    const models = await host.models(parentInfo.directory).catch(() => [] as ModelInfo[]);
    const tiers = {
      models: providerTiers(parent.model, options.tiers, options.providerTiers, models),
      descriptions: options.tierDescriptions,
    };
    const askTier = Object.values(tiers.models).some(Boolean);
    let parentRequest = "";
    try {
      parentRequest = clip(lastUserText(await host.messages(parentInfo.id)), 2_000);
    } catch {
      // Without it Jev sees the task alone.
    }
    return Promise.all(
      items.map(async (item) => {
        const given: Given = { ...(item.agent ? { agent: item.agent } : {}), ...(item.model ? { model: item.model } : {}), ...(item.variant ? { variant: item.variant } : {}) };
        const questions = pickQuestions(given, agents, tiers, askTier);
        let picks: Picks | undefined;
        if (options.jev.enabled && Object.keys(questions).length) {
          const outcome = await askJev({ task: clip(item.task, 6_000), parent_request: parentRequest || "(none)" }, questions, {
            model: options.jev.model,
            timeoutMs: options.jev.timeoutMs,
            signal,
            ...(host.fetch ? { fetch: host.fetch } : {}),
          });
          if (outcome.ok) picks = readPicks(outcome.answers);
          else host.log(`Jev unavailable for "${taskLabel(item.task, item.label)}": ${outcome.reason}`);
        }
        const resolved = resolve(given, agents, picks, tiers, parent);
        if ("error" in resolved) return resolved;
        if (!resolved.model) return { error: "No model: the session has no model selected; pass `model`." };
        const [provider, ...rest] = resolved.model.split("/");
        const available = models.find((m) => m.provider === provider && m.id === rest.join("/"))?.variants;
        const variant = fitVariant(resolved.variant, available);
        return { ...resolved, ...(variant ? { variant } : { variant: undefined }) } as Resolved;
      }),
    );
  };

  /**
   * Waits for the child's turn on `since` to end: the session went idle after `since`, or its
   * messages say so. `wait` alone may return before the prompt is admitted.
   */
  const awaitTurn = async (sessionID: string, since: number) => {
    for (let i = 0; i < 100; i++) {
      await host.wait(sessionID);
      const messages = await host.messages(sessionID);
      const idleAt = await host.session(sessionID).then((s) => s.idleAt ?? 0, () => 0);
      const ended =
        idleAt >= since ||
        messages.some((m) => {
          const created = (m as { time?: { created?: number } }).time?.created ?? 0;
          if (created < since) return false;
          if (m.type === "idle") return true;
          if (m.type === "assistant") {
            const a = m as Extract<MessageLike, { type: "assistant" }>;
            return Boolean(a.error) || (a.finish !== undefined && a.finish !== "tool-calls");
          }
          return false;
        });
      if (ended) return messages;
      await sleep(100);
    }
    return host.messages(sessionID);
  };

  const finish = async (run: Run, messages: MessageLike[]) => {
    const assistant = messages.filter((m) => m.type === "assistant") as Extract<MessageLike, { type: "assistant" }>[];
    run.turns = assistant.length;
    run.output = lastAssistantText(messages);
    const failed = assistant.find((m) => m.error);
    let info: SessionInfo | undefined;
    try {
      info = await host.session(run.sessionID as string);
      run.cost = info.cost;
      run.tokens = info.tokens.input + info.tokens.output + info.tokens.cache.write;
    } catch {
      // The totals stay at what we know.
    }
    if (run.status === "stopped") {
      // Interrupted by us.
    } else if (info?.outcome === "interrupted") run.status = "stopped";
    else if (info?.outcome === "failed" || (failed && !run.output)) {
      run.status = "failed";
      run.error = failed?.error?.message ?? "the child session failed";
    } else run.status = "done";
    run.endedAt = Date.now();
  };

  /** Registers the run at once; `done` settles when the child's turn has ended. */
  const startRun = (parentInfo: SessionInfo, item: Item, resolved: Resolved, cwd: string, call: { async: boolean; fork?: MessageLike[]; signal: AbortSignal }): { run: Run; done: Promise<Run> } => {
    const [providerID, ...rest] = resolved.model.split("/");
    const run: Run = {
      id: shortId(),
      parent: parentInfo.id,
      agent: resolved.agent.id,
      task: item.task,
      label: taskLabel(item.task, item.label),
      model: resolved.model,
      ...(resolved.variant ? { variant: resolved.variant } : {}),
      byJev: resolved.byJev,
      ...(resolved.tier ? { tier: resolved.tier } : {}),
      cwd,
      async: call.async,
      status: "running",
      output: "",
      turns: 0,
      tokens: 0,
      cost: 0,
      startedAt: Date.now(),
    };
    runs.set(run.id, run);
    const stop = () => {
      if (run.status !== "running" || !run.sessionID) return;
      run.status = "stopped";
      void host.interrupt(run.sessionID).catch(() => undefined);
    };
    const done = (async () => {
      if (!call.async) call.signal.addEventListener("abort", stop, { once: true });
      try {
        const child = await host.create({
          parentID: parentInfo.id,
          title: `${run.label} · ${run.agent}`,
          agent: resolved.agent.id,
          model: { providerID: providerID as string, id: rest.join("/"), ...(resolved.variant ? { variant: resolved.variant } : {}) },
          directory: cwd,
        });
        run.sessionID = child.id;
        if (!call.async && call.signal.aborted) {
          run.status = "stopped";
          run.endedAt = Date.now();
          return run;
        }
        const since = Date.now();
        await host.prompt(child.id, call.fork ? forkPrompt(call.fork, item.task) : item.task, "steer");
        if (!call.async && call.signal.aborted) stop();
        const messages = await awaitTurn(child.id, since);
        await finish(run, messages);
      } catch (error) {
        run.status = run.status === "stopped" ? "stopped" : "failed";
        run.error = error instanceof Error ? error.message : String(error);
        run.endedAt = Date.now();
      } finally {
        if (!call.async) call.signal.removeEventListener("abort", stop);
      }
      host.log(`${run.label} · ${run.agent} · ${run.model}${run.variant ? ` · ${run.variant}` : ""}: ${run.status} after ${Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000)}s, ${run.turns} turns${run.sessionID ? ` (session ${run.sessionID})` : ""}`);
      return run;
    })();
    return { run, done };
  };

  const execute = async (input: Input, context: CallContext): Promise<Result> => {
    const options = optionsNow();
    const action = input.action ?? "run";
    const sessionID = context.sessionID;

    if (action !== "run") {
      if (action === "status" && !input.id) {
        const all = [...runs.values()].filter((r) => r.parent === sessionID);
        const text = all.length ? all.map((r) => `${r.id}  ${r.status.padEnd(7)} ${r.label} · ${r.agent}${r.sessionID ? ` · session ${r.sessionID}` : ""}`).join("\n") : "No subagent runs in this session.";
        return { content: text, metadata: { runs: all.map((r) => view(r)) } };
      }
      const run = findRun(sessionID, input.id);
      if (!run) throw new Error(`No run ${input.id ?? "(missing id)"}. Use action=status to list runs.`);
      if (action === "steer") {
        if (!input.message?.trim()) throw new Error("steer needs `message`.");
        if (run.status !== "running" || !run.sessionID) throw new Error(`Run ${run.id} is ${run.status}; only running runs can be steered.`);
        await host.prompt(run.sessionID, input.message, "steer");
        return { content: `Steered ${run.id}.`, metadata: { runs: [view(run)] } };
      }
      if (action === "stop") {
        if (run.status === "running" && run.sessionID) {
          run.status = "stopped";
          await host.interrupt(run.sessionID).catch(() => undefined);
        }
        return { content: `Stopping ${run.id}.`, metadata: { runs: [view(run)] } };
      }
      if (action === "result") {
        let output = run.output;
        if (run.status === "running" && run.sessionID) {
          try {
            output = lastAssistantText(await host.messages(run.sessionID));
          } catch {
            // Still starting.
          }
        }
        const text = `[${run.label} · ${run.agent} · ${run.status}]\n${truncateOutput(output || "(no output yet)", `Full output in child session ${run.sessionID ?? "?"}.`)}`;
        return { content: text, metadata: { runs: [view(run, true)] } };
      }
      return { content: JSON.stringify(view(run, true), null, 2), metadata: { runs: [view(run, true)] } };
    }

    const mode: Mode = input.tasks?.length ? "parallel" : input.chain?.length ? "chain" : "single";
    const rawItems: Item[] =
      mode === "parallel"
        ? (input.tasks as Item[])
        : mode === "chain"
          ? (input.chain as Item[])
          : input.task
            ? [{ task: input.task, ...(input.label ? { label: input.label } : {}), ...(input.agent ? { agent: input.agent } : {}), ...(input.model ? { model: input.model } : {}), ...(input.variant ? { variant: input.variant } : {}) }]
            : [];
    // Resolve names before chain expansion: previous output must never rename a step.
    const items = rawItems.map((item) => ({ ...item, label: taskLabel(item.task, item.label) }));
    if (!items.length) throw new Error("run needs `task`, `tasks`, or `chain`.");
    if (mode === "parallel" && items.length > options.maxParallel) throw new Error(`At most ${options.maxParallel} parallel tasks.`);
    if ((await depth(sessionID)) >= options.maxDepth) throw new Error(`This session is ${options.maxDepth} levels deep; it cannot delegate further.`);

    const call = { async: Boolean(input.async), signal: context.signal };
    const cancelled = () => !call.async && context.signal.aborted;
    if (cancelled()) throw new Error("Cancelled before any subagent started.");
    const parentInfo = await host.session(sessionID);
    const agents = await host.agents(parentInfo.directory);
    if (!agents.length) throw new Error("No subagent-mode agents are available.");
    const resolvedAll = await plan(items, agents, parentInfo, options, context.signal);
    if (cancelled()) throw new Error("Cancelled before any subagent started.");
    const failed = resolvedAll.find((r): r is { error: string } => "error" in r);
    if (failed) throw new Error(failed.error);
    const resolved = resolvedAll as Resolved[];
    const fork = input.context === "fork" ? await host.messages(sessionID) : undefined;

    const started: Run[] = [];
    const running = () => started.filter((r) => r.status === "running").length;
    const update = () => {
      if (!call.async) context.progress({ title: `${running()} running`, mode, runs: started.map((r) => view(r)) });
    };

    const cwdFor = async (item: Item) => {
      const dir = path.resolve(parentInfo.directory, item.cwd ?? input.cwd ?? ".");
      if (!input.worktree) return dir;
      const name = `subagent-${slug(item.label ?? item.task)}-${shortId()}`;
      return host.worktree({ projectID: parentInfo.projectID, cwd: dir, name, branch: name.replace(/^subagent-/u, "subagent/"), signal: context.signal });
    };

    const runOne = async (item: Item, r: Resolved): Promise<Run | undefined> => {
      if (cancelled()) return undefined;
      const cwd = await cwdFor(item);
      if (cancelled()) return undefined;
      const { run, done } = startRun(parentInfo, item, r, cwd, { ...call, ...(fork ? { fork } : {}) });
      started.push(run);
      update();
      await done;
      update();
      return run;
    };

    const execute = async (): Promise<Run[]> => {
      if (mode === "chain") {
        let previous = "";
        const done: Run[] = [];
        for (const [index, item] of items.entries()) {
          const run = await runOne({ ...item, task: item.task.replaceAll("{previous}", previous) }, resolved[index] as Resolved);
          if (!run) break;
          done.push(run);
          if (run.status !== "done") break;
          previous = run.output;
        }
        return done;
      }
      const queue = items.map((item, index) => ({ item, index }));
      const done: Run[] = [];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            const run = await runOne(next.item, resolved[next.index] as Resolved);
            if (!run) break;
            done[next.index] = run;
          } catch (error) {
            // A worktree that could not be made: the call fails, its other children stop.
            queue.length = 0;
            for (const run of started) {
              if (run.status === "running" && run.sessionID) {
                run.status = "stopped";
                void host.interrupt(run.sessionID).catch(() => undefined);
              }
            }
            throw error;
          }
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(Math.floor(options.concurrency), items.length)) }, worker));
      const failure = workers.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return done.filter(Boolean);
    };

    const ids = () => started.map((r) => `${r.id} (${r.label} · ${r.agent}, ${r.model}${r.variant ? `, ${r.variant}` : ""})`).join(", ");

    if (call.async) {
      void execute()
        .then((list) => {
          const text = list.map(resultText).join("\n\n---\n\n");
          return host.deliver(sessionID, `Subagent ${mode} finished:\n\n${text}`);
        })
        .catch((error: unknown) => host.deliver(sessionID, `Subagent ${mode} failed: ${error instanceof Error ? error.message : String(error)}`))
        .catch((error: unknown) => host.log(`could not deliver a result to ${sessionID}: ${error instanceof Error ? error.message : String(error)}`));
      // Let the runs start so their ids exist.
      await sleep(50);
      return {
        content: `Started ${mode} in the background${started.length ? `: ${ids()}` : ""}. The results arrive as a message when it ends; use action=status, steer, stop, or result with an id meanwhile.`,
        metadata: { mode, runs: started.map((r) => view(r)) },
      };
    }

    const done = await execute();
    if (!done.length) throw new Error(context.signal.aborted ? "Cancelled before any subagent started." : "No subagent started.");
    const skipped = items.length - done.length;
    const text = `${mode === "chain" ? resultText(done.at(-1) as Run) : done.map(resultText).join("\n\n---\n\n")}${skipped > 0 && context.signal.aborted ? `\n\n[Cancelled: ${skipped} queued task${skipped === 1 ? "" : "s"} never started.]` : ""}`;
    const allFailed = done.every((r) => r.status !== "done");
    return {
      content: text,
      metadata: { mode, runs: done.map((r) => view(r, true)), title: `${done.length} ${mode === "chain" ? "steps" : "runs"}, $${done.reduce((s, r) => s + r.cost, 0).toFixed(3)}` },
      ...(allFailed ? { isError: true } : {}),
    };
  };

  return {
    execute,
    depth,
    async sessionDeleted(sessionID) {
      depths.delete(sessionID);
      for (const run of runs.values()) {
        if (run.parent !== sessionID) continue;
        if (run.status === "running" && run.sessionID) {
          run.status = "stopped";
          await host.interrupt(run.sessionID).catch(() => undefined);
        }
        runs.delete(run.id);
      }
    },
    async dispose() {
      for (const run of runs.values()) {
        if (run.status === "running" && run.sessionID) {
          run.status = "stopped";
          await host.interrupt(run.sessionID).catch(() => undefined);
        }
      }
    },
    runs: () => [...runs.values()],
  };
}

