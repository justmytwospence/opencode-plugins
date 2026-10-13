// opencode-cache-guard (server): keeps each session's prompt-cache clock (when the last model
// request started, how many tokens the next one re-sends, the model, its TTL and prices) and
// serves it to the terminals over RPC; the terminal half holds a cold-cache prompt before it is
// submitted and shows the clock. With Jev (TYPESAFE_API_KEY) the server also trims large tool
// output before it enters the context (trim.ts) and compacts: on the terminal's request, Jev's
// summary written in code replaces the model's (the `compaction` hook's `result`), and for every
// other compaction Jev tells OpenCode's summarizer what must survive word for word (compact.ts).
//
// Keeping the cache warm is OpenCode's own job (`"warming": true` in opencode.jsonc), as it is
// Pi's for pi-cache-guard. src/core.ts and src/lean.ts are shared with the pi, Claude Code and
// Codex ports unchanged.
import type { Plugin } from "@opencode/plugin";

import { type CostLike, Clock, type ModelRef, type Snapshot, priceOf, ttlOf } from "./clock.ts";
import { jevSummary, verbatimContext } from "./compact.ts";
import { NAME, type Settings } from "./core.ts";
import { type JevState, askJev, label, probe, resolveJev } from "./jev.ts";
import { type ArmInput, CacheGuardRpc, type Compacted, type JevOutput, type Note } from "./rpc.ts";
import { loadSettings } from "./settings.ts";
import { type ToolResultLike, createTrimmer } from "./trim.ts";
import type { MessageLike } from "./units.ts";
import { readUsage } from "./usage.ts";

/** How long a terminal's `arm` stays in force waiting for its compaction. */
const ARM_TTL_MS = 10 * 60_000;

/** What the hooks need from OpenCode, so tests can fake it. */
export interface Host {
  /** The settings in force now (read on each use, so edits apply without a restart). */
  settings(): Settings;
  /** The session's context messages; empty when they cannot be read. */
  messages(sessionID: string): Promise<MessageLike[]>;
  /** A model's catalog prices, undefined when unknown. */
  cost(model: ModelRef): Promise<CostLike | undefined>;
  emit: {
    state(snapshot: Snapshot): void;
    trimmed(note: Note): void;
    compacted(event: Compacted): void;
  };
  log(line: string): void;
  env?: NodeJS.ProcessEnv;
  /** Jev's HTTP requests go through this (the live API otherwise). */
  fetch?: typeof fetch;
}

/** The parts of the hook events the server reads and writes. */
export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id?: string; readonly modelID?: string };
}

export interface HttpEvent {
  readonly sessionID: string;
  readonly kind: string;
  readonly model: { readonly providerID: string };
}

export interface ToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
  readonly status: "completed" | "error";
  result?: ToolResultLike;
}

export interface CompactionEvent {
  readonly sessionID: string;
  system: Array<{ type: "text"; text: string; [key: string]: unknown }>;
  result?: { summary: string; [key: string]: unknown };
}

export interface TokensLike {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface Hooks {
  /** A new prompt in the session: a tool call trimmed last turn may be trimmed again. */
  prompt(sessionID: string): void;
  context(event: ContextEvent): Promise<void>;
  httpRequest(event: HttpEvent): void;
  httpResponse(event: HttpEvent & { response: Pick<Response, "clone"> }): void;
  stepStarted(sessionID: string, started: number, model?: ModelRef): void;
  stepEnded(sessionID: string, tokens: TokensLike, model?: ModelRef): void;
  toolAfter(event: ToolEvent): Promise<void>;
  compaction(event: CompactionEvent): Promise<void>;
  compacted(sessionID: string): void;
  forget(sessionID: string): void;
  /** RPC: the session's snapshot, null when the server has none. */
  state(sessionID: string): Snapshot | null;
  /** RPC: what the session's next compaction should do. */
  arm(input: ArmInput): void;
  /** RPC: whether the server reaches Jev, and how fast. */
  jev(): Promise<JevOutput>;
  /** Pending usage reads (tests await them). */
  settle(): Promise<void>;
}

export function modelRef(model: { providerID: string; id?: string; modelID?: string }): ModelRef {
  return { providerID: model.providerID, modelID: model.modelID ?? model.id ?? "" };
}

export function totalTokens(t: TokensLike): number {
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0);
}

interface Armed {
  kind: "jev" | "guidance";
  text?: string;
  at: number;
}

/** The hooks, OpenCode-free. */
export function createHooks(host: Host, now: () => number = Date.now): Hooks {
  const env = host.env ?? process.env;
  const clock = new Clock({ now, onChange: (s) => host.emit.state(s) });
  const armed = new Map<string, Armed>();
  const pending = new Set<Promise<unknown>>();
  const prices = new Map<string, Promise<ReturnType<typeof priceOf>>>();
  const price = (model: ModelRef) => {
    const key = `${model.providerID}/${model.modelID}`;
    let p = prices.get(key);
    if (!p) {
      p = host
        .cost(model)
        .then((cost) => priceOf(model, cost))
        .catch(() => priceOf(model));
      prices.set(key, p);
    }
    return p;
  };
  const ask = (settings: Settings, jev: Extract<JevState, { kind: "ready" }>, timeoutMs: number) => (state: Record<string, unknown>, questions: Parameters<typeof askJev>[1]) =>
    askJev(state, questions, { model: jev.target.model, timeoutMs, apiKey: env.TYPESAFE_API_KEY, ...(host.fetch ? { fetch: host.fetch } : {}) });
  const trimmer = createTrimmer({
    settings: host.settings,
    messages: host.messages,
    ask: (s) => {
      const jev = resolveJev(s, env);
      return jev.kind === "ready" ? ask(s, jev, s.jev.timeoutMs) : async () => ({ ok: false as const, reason: "Jev is not set up" });
    },
    log: (line) => host.log(`trim ${line}`),
    toast: (sessionID, message) => host.emit.trimmed({ sessionID, message }),
    env,
  });

  return {
    prompt(sessionID) {
      trimmer.newTurn(sessionID);
    },
    async context(event) {
      const model = modelRef(event.model);
      clock.setModel(event.sessionID, model, await price(model), ttlOf(model, env));
    },
    httpRequest(event) {
      if (event.kind !== "primary") return;
      clock.requestStarted(event.sessionID, now());
    },
    httpResponse(event) {
      if (event.kind !== "primary" || event.model.providerID !== "anthropic") return;
      let clone: Response;
      try {
        clone = event.response.clone();
      } catch {
        return;
      }
      const read = readUsage(clone).then((usage) => {
        if (!usage) return;
        clock.recordCache(event.sessionID, usage);
        host.log(`${event.sessionID} cache: read ${usage.read}, wrote ${usage.write} of ${usage.prompt} prompt tokens`);
      });
      pending.add(read);
      void read.finally(() => pending.delete(read));
    },
    // The event stream is global (every location's sessions), while the hooks above fire only
    // for this instance's sessions; another location's instance must not emit bare snapshots for
    // a session it never served, so step events count only for sessions a hook has seen.
    stepStarted(sessionID, started, model) {
      if (!clock.sessions.has(sessionID)) return;
      clock.requestStarted(sessionID, started);
      if (model) clock.recordTokens(sessionID, 0, model);
    },
    stepEnded(sessionID, tokens, model) {
      if (!clock.sessions.has(sessionID)) return;
      clock.recordTokens(sessionID, totalTokens(tokens), model);
    },
    async toolAfter(event) {
      if (event.status !== "completed" || !event.result) return;
      await trimmer.afterTool({ tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }, event.result);
    },
    // What the terminal armed for this compaction (Jev's summary, or guidance for the model's),
    // and with Jev the items that must survive word for word, judged against that guidance (else
    // the last two requests). Any Jev failure adds nothing; an armed Jev compaction fails instead.
    async compaction(event) {
      const settings = host.settings();
      const arm = armed.get(event.sessionID);
      armed.delete(event.sessionID);
      const live = arm && now() - arm.at <= ARM_TTL_MS ? arm : undefined;
      const jev = resolveJev(settings, env);
      const messages = async () => host.messages(event.sessionID);
      if (live?.kind === "jev") {
        const fail = (reason: string) => {
          host.log(`${event.sessionID} compaction: Jev's summary did not run (${reason})`);
          host.emit.compacted({ sessionID: event.sessionID, ok: false, message: `Compaction with Jev did not run: ${reason}.` });
          throw new Error(`${NAME}: compaction with Jev did not run (${reason})`);
        };
        if (jev.kind !== "ready") return fail(jev.kind === "off" ? "Jev is off" : jev.reason);
        const summary = await jevSummary(await messages(), live.text ?? "", settings.compact, ask(settings, jev, settings.compact.timeoutMs));
        if (!summary.ok) return fail(summary.reason);
        event.result = { summary: summary.summary };
        host.log(`${event.sessionID} compaction: Jev kept ${summary.counts.verbatim} of ${summary.units} items word for word in ${summary.latencyMs} ms`);
        host.emit.compacted({ sessionID: event.sessionID, ok: true, message: `Jev kept ${summary.counts.verbatim} of ${summary.units} items word for word in ${(summary.latencyMs / 1000).toFixed(1)} s.` });
        return;
      }
      const guidance = live?.kind === "guidance" ? live.text?.trim() || undefined : undefined;
      if (guidance) event.system.push({ type: "text", text: guidance });
      if (!settings.compact.filter || jev.kind !== "ready") return;
      const verbatim = await verbatimContext(await messages(), guidance, settings.compact, ask(settings, jev, settings.compact.timeoutMs));
      if (!verbatim.ok) {
        host.log(`${event.sessionID} compaction: Jev added nothing (${verbatim.reason})`);
        return;
      }
      host.log(`${event.sessionID} compaction: Jev judged ${verbatim.units} items in ${verbatim.latencyMs} ms (${verbatim.counts.verbatim} verbatim, ${verbatim.counts.summarize} noted, ${verbatim.counts.drop} dropped)`);
      if (verbatim.context) event.system.push({ type: "text", text: verbatim.context });
    },
    compacted(sessionID) {
      clock.reset(sessionID);
    },
    forget(sessionID) {
      clock.forget(sessionID);
      armed.delete(sessionID);
      trimmer.forget(sessionID);
    },
    state(sessionID) {
      const s = clock.sessions.get(sessionID);
      return s ? { ...s } : null;
    },
    arm(input) {
      armed.set(input.sessionID, { kind: input.kind, text: input.text, at: now() });
    },
    async jev() {
      const settings = host.settings();
      const state = resolveJev(settings, env);
      if (state.kind !== "ready") return state.kind === "off" ? { kind: "off" } : { kind: "missing", reason: state.reason };
      const answer = await probe({ model: state.target.model, apiKey: env.TYPESAFE_API_KEY, ...(host.fetch ? { fetch: host.fetch } : {}) });
      return answer.ok ? { kind: "ready", label: label(state.target), latencyMs: answer.latencyMs } : { kind: "ready", label: label(state.target), reason: answer.reason };
    },
    async settle() {
      await Promise.all([...pending]);
    },
  };
}

interface ModelLike {
  providerID: string;
  id: string;
  cost?: readonly CostLike[];
}

/** The catalog's prices of every model, cached until the model list changes. */
function costSource(ctx: Plugin.Context) {
  let cache: Promise<Map<string, CostLike | undefined>> | undefined;
  const load = async () => {
    const list = (await ctx.model.list()) as unknown as { data?: readonly ModelLike[] } | readonly ModelLike[];
    const models = Array.isArray(list) ? list : ((list as { data?: readonly ModelLike[] }).data ?? []);
    return new Map(models.map((m) => [`${m.providerID}/${m.id}`, m.cost?.find((c: CostLike & { tier?: unknown }) => !c.tier) ?? m.cost?.[0]]));
  };
  return {
    async cost(model: ModelRef) {
      cache ??= load().catch(() => new Map());
      return (await cache).get(`${model.providerID}/${model.modelID}`);
    },
    invalidate() {
      cache = undefined;
    },
  };
}

export default {
  id: NAME,
  async setup(ctx) {
    const rpc = await ctx.rpc.register(CacheGuardRpc, {
      state: async (input) => hooks.state((input as { sessionID: string }).sessionID) as never,
      arm: async (input) => {
        hooks.arm(input as ArmInput);
        return {};
      },
      jev: async () => hooks.jev(),
    });
    const source = costSource(ctx);
    const emit = <Name extends "state" | "trimmed" | "compacted">(name: Name, data: unknown) =>
      void (rpc.events.emit as (name: Name, data: unknown) => Promise<void>)(name, data).catch(() => undefined);
    const hooks = createHooks({
      settings: () => loadSettings(ctx.location.directory, process.env, ctx.options as Record<string, unknown>),
      messages: async (sessionID) => {
        try {
          return (await ctx.session.context({ sessionID: sessionID as never })) as unknown as MessageLike[];
        } catch {
          return [];
        }
      },
      cost: source.cost,
      emit: {
        state: (s) => emit("state", s),
        trimmed: (n) => emit("trimmed", n),
        compacted: (c) => emit("compacted", c),
      },
      log: (line) => console.error(`[${NAME}] ${line}`),
    });

    await ctx.session.hook("prompt", (event) => hooks.prompt(event.sessionID));
    await ctx.session.hook("context", (event) => hooks.context(event as unknown as ContextEvent));
    await ctx.session.hook("http.request", (event) => hooks.httpRequest(event));
    await ctx.session.hook("http.response", (event) => hooks.httpResponse(event), { providerID: "anthropic" });
    await ctx.tool.hook("execute.after", (event) => hooks.toolAfter(event as unknown as ToolEvent));
    await ctx.session.hook("compaction", (event) => hooks.compaction(event as unknown as CompactionEvent));

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const { type, data } = event as { type?: string; data?: Record<string, any> };
          if (!data?.sessionID) {
            if (type === "model.updated" || type === "provider.updated") source.invalidate();
            continue;
          }
          const sessionID = String(data.sessionID);
          if (type === "session.step.started") hooks.stepStarted(sessionID, Number(data.started) || Date.now(), data.model ? modelRef(data.model) : undefined);
          else if (type === "session.step.ended" && data.tokens) hooks.stepEnded(sessionID, data.tokens as TokensLike);
          else if (type === "session.compaction.ended") hooks.compacted(sessionID);
          else if (type === "session.deleted") hooks.forget(sessionID);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return () => stop.abort();
  },
} satisfies Plugin.Plugin;
