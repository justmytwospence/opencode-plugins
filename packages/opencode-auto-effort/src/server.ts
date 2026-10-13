// opencode-auto-effort: sets the effort (OpenCode's model variant) for each prompt you send. The
// session's `prompt` hook notes the new prompt; on the first model request of that turn (the
// `context` hook) Jev rates how demanding it is (0-3) and the policy smooths that into a level,
// which every model request of the turn (tool follow-ups included) then uses, so prompt caches
// survive. The level is applied by overlaying that variant's settings on the request (and its
// headers in `model.request`); the variant the session would have used (your pick, or the
// agent's) is the ceiling and stays selected. Settings come from the shared
// `~/.config/agents/auto-effort.json` and `.agents/auto-effort.json`, the plugin options, and
// `.opencode/auto-effort.json`, read on each prompt (see settings.ts). When a subscription window
// is on track to run out before it resets (limits.ts, read from response headers by usage.ts),
// the level goes one or two steps below the policy's pick; the pick itself is kept apart.
import type { Plugin } from "@opencode/plugin";
import { askJev, noul, score } from "./jev.ts";
import { DEFAULT_LIMITS, type LimitsPolicy, type Pressure, type Tier, type Tracker, applyLimit, limitsPolicy, pressureLabel } from "./limits.ts";
import { DEFAULT_POLICY, type EffortState, LEVELS, type Policy, decide, levelIndex } from "./policy.ts";
import { type MessageLike, QUESTIONS, effortState, history } from "./request.ts";
import { AutoEffortRpc, type ChangedEvent } from "./rpc.ts";
import { deepMerge, loadSettings } from "./settings.ts";
import { observe, trackerKey } from "./usage.ts";

/** The plugin's name: its settings files are `<dir>/auto-effort.json`. */
export const NAME = "auto-effort";

export interface Options {
  enabled: boolean;
  /** Agents whose prompts auto-effort sets; others (planners, scouts) keep their own variant. */
  agents: string[];
  /** Show a toast when the level changes. */
  toast: boolean;
  jev: { model: string; timeoutMs: number };
  policy: Policy;
  /** Lower the effort when a subscription window is on a risky trajectory. */
  limits: LimitsPolicy;
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  agents: ["build"],
  toast: true,
  jev: { model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
  limits: DEFAULT_LIMITS,
};

interface SessionState extends EffortState {
  /** The level auto-effort set last in this session. */
  level?: string;
  /** The policy's own pick last time, before any limit. */
  baseline?: string;
  tier?: Tier;
  /** The ceiling `level` was decided under. */
  ceiling?: string;
}

export interface LimitsDeps {
  /** Readings by tracker key (`anthropic`, `codex`); usage.ts fills them from response headers. */
  trackers?: Map<string, Tracker>;
  now?: () => number;
}

const NO_PRESSURE: Pressure = { tier: "none", steps: 0 };

/** The plugin options from opencode.json(c) over the defaults: that layer alone, without the shared files. */
export function resolveOptions(raw: Record<string, unknown> | undefined): Options {
  return deepMerge(DEFAULT_OPTIONS, raw);
}

/**
 * The options in force now: defaults, `~/.config/agents/auto-effort.json`, the plugin options,
 * `<directory>/.agents/auto-effort.json`, then `<directory>/.opencode/auto-effort.json`.
 */
export function currentOptions(raw: Record<string, unknown> | undefined, directory: string): Options {
  return loadSettings(NAME, DEFAULT_OPTIONS, raw, directory);
}

/** The highest of `available` at or below `level`; the ceiling when none is. */
export function fit(level: string, ceiling: string, available: readonly string[] | undefined): string {
  if (!available?.length) return level;
  for (let i = levelIndex(level); i >= 0; i--) {
    const name = LEVELS[i] as string;
    if (available.includes(name)) return name;
  }
  return ceiling;
}

/** One variant of a model, as `ctx.model.list()` reports it. */
export interface VariantInfo {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** What the hooks need from OpenCode, so tests can fake it. */
export interface Host {
  /** The variants of a model; undefined when unknown. */
  variants(providerID: string, modelID: string): Promise<readonly VariantInfo[] | undefined>;
  /** Tells the CLI half to show a toast. */
  notify(event: ChangedEvent): void;
  log(message: string): void;
}

/** The parts of the `context` hook's event auto-effort reads and writes. */
export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
  readonly messages: readonly MessageLike[];
  options: Record<string, unknown>;
}

export interface Hooks {
  prompt(sessionID: string, text: string): void;
  context(event: ContextEvent): Promise<void>;
  headers(event: { readonly sessionID: string; readonly agent: string; headers: Record<string, string> }): void;
  response(url: string, response: Pick<Response, "headers">): void;
  forget(sessionID: string): void;
}

/**
 * The hooks, OpenCode-free. `options` is read on every prompt when it is a function (the server
 * passes one that merges the settings files), so edits apply without a restart.
 */
export function createHooks(
  host: Host,
  options: Options | (() => Options),
  fetchImpl?: typeof fetch,
  limitsDeps: LimitsDeps = {},
): Hooks {
  const optionsNow = typeof options === "function" ? options : () => options;
  const trackers = limitsDeps.trackers ?? new Map<string, Tracker>();
  const now = limitsDeps.now ?? Date.now;
  const sessions = new Map<string, SessionState>();
  /** Prompts sent but not yet decided, by session. */
  const pending = new Map<string, string>();
  /** The variant whose headers the session's requests carry this turn. */
  const applied = new Map<string, Record<string, string>>();

  async function decideFor(event: ContextEvent, text: string, ceiling: string, options: Options) {
    const s = sessions.get(event.sessionID) ?? { dwell: options.policy.minDwell };
    const outcome = await askJev(effortState(text, history(text, event.messages)), QUESTIONS, {
      model: options.jev.model,
      timeoutMs: options.jev.timeoutMs,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const depth = outcome.ok ? score(outcome.answers, "depth") : undefined;
    const ack = outcome.ok ? noul(outcome.answers, "ack") : undefined;
    const judgment = depth && ack !== undefined ? { ...depth, ack } : undefined;
    const current = s.level ?? ceiling;
    // The policy works from its own last pick, never from a limited level.
    const decision = decide(s.baseline ?? current, ceiling, s, judgment, options.policy);
    const variants = await host.variants(event.model.providerID, event.model.id);
    const available = variants?.map((v) => v.id);
    const baseline = fit(decision.level, ceiling, available);
    const limits = limitsPolicy(options.limits);
    const key = trackerKey(event.model.providerID);
    const pressure = limits.enabled && key ? (trackers.get(key)?.assess(now(), limits) ?? NO_PRESSURE) : NO_PRESSURE;
    let level = fit(applyLimit(decision.level, pressure, options.policy.floor, LEVELS).level, ceiling, available);
    // No supported variant below: keep the baseline rather than going up to the ceiling.
    if (levelIndex(level) > levelIndex(baseline)) level = baseline;
    const tierChanged = pressure.tier !== (s.tier ?? "none");
    sessions.set(event.sessionID, { ...decision.state, level, baseline, tier: pressure.tier, ceiling });

    const limited = pressure.tier !== "none" ? `, limited: ${pressureLabel(pressure)}` : "";
    const reason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;
    const detail = judgment
      ? ` (score ${judgment.score.toFixed(2)}, confidence ${judgment.confidence.toFixed(2)}, go-ahead ${judgment.ack.toFixed(2)}${outcome.ok ? `, ${outcome.latencyMs} ms` : ""})`
      : "";
    const limitDetail =
      pressure.tier !== "none"
        ? `; limit ${pressure.tier} (${pressureLabel(pressure)}${pressure.projected !== undefined ? `, projected ${Math.round(pressure.projected * 100)}%` : ""}), baseline ${baseline}`
        : "";
    host.log(`${current} -> ${level} (ceiling ${ceiling}): ${reason}${detail}${limitDetail}`);
    if (options.toast && (level !== current || tierChanged)) {
      host.notify({ sessionID: event.sessionID, message: `effort: ${level} (auto${limited})`, warning: pressure.tier !== "none" });
    }
  }

  return {
    prompt(sessionID, text) {
      const trimmed = text.trim();
      if (trimmed) pending.set(sessionID, trimmed);
    },
    async context(event) {
      const options = optionsNow();
      const text = pending.get(event.sessionID);
      pending.delete(event.sessionID);
      applied.delete(event.sessionID);
      if (!options.enabled || !options.agents.includes(event.agent)) return;
      const ceiling = event.model.variant;
      if (!ceiling || levelIndex(ceiling) < 0) return;
      if (text !== undefined) await decideFor(event, text, ceiling, options);
      const s = sessions.get(event.sessionID);
      // A level decided under another ceiling (you picked a variant since) is not reused.
      if (!s?.level || s.ceiling !== ceiling || s.level === ceiling) return;
      const variant = (await host.variants(event.model.providerID, event.model.id))?.find((v) => v.id === s.level);
      if (!variant) return;
      Object.assign(event.options, variant.settings ?? {});
      if (variant.headers && Object.keys(variant.headers).length) applied.set(event.sessionID, variant.headers);
    },
    headers(event) {
      const headers = applied.get(event.sessionID);
      if (headers) Object.assign(event.headers, headers);
    },
    response(url, response) {
      observe(trackers, url, response, now());
    },
    forget(sessionID) {
      sessions.delete(sessionID);
      pending.delete(sessionID);
      applied.delete(sessionID);
    },
  };
}

/** The variants of every model, from `ctx.model.list()`, cached until the model list changes. */
function variantSource(ctx: Plugin.Context) {
  let cache: Promise<Map<string, readonly VariantInfo[]>> | undefined;
  const load = async () => {
    const list = (await ctx.model.list()) as unknown as { data?: readonly ModelLike[] } | readonly ModelLike[];
    const models = Array.isArray(list) ? list : ((list as { data?: readonly ModelLike[] }).data ?? []);
    return new Map(models.map((m) => [`${m.providerID}/${m.id}`, m.variants ?? []]));
  };
  return {
    async variants(providerID: string, modelID: string) {
      cache ??= load().catch(() => new Map());
      return (await cache).get(`${providerID}/${modelID}`);
    },
    invalidate() {
      cache = undefined;
    },
  };
}

interface ModelLike {
  providerID: string;
  id: string;
  variants?: readonly VariantInfo[];
}

export default {
  id: NAME,
  async setup(ctx) {
    const source = variantSource(ctx);
    const rpc = await ctx.rpc.register(AutoEffortRpc, {});
    const hooks = createHooks(
      {
        variants: source.variants,
        notify: (event) => void rpc.events.emit("changed", event).catch(() => undefined),
        log: (message) => console.error(`[auto-effort] ${message}`),
      },
      () => currentOptions(ctx.options, ctx.location.directory),
    );
    await ctx.session.hook("prompt", (event) => hooks.prompt(event.sessionID, event.prompt.text ?? ""));
    await ctx.session.hook("context", (event) => hooks.context(event as unknown as ContextEvent));
    await ctx.session.hook("model.request", (event) => {
      if (event.kind === "primary") hooks.headers(event);
    });
    await ctx.session.hook("http.response", (event) => hooks.response(event.request.url, event.response));

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const type = (event as { type?: string }).type;
          if (type === "model.updated" || type === "provider.updated") source.invalidate();
          if (type === "session.deleted") {
            const id = (event as { data?: { sessionID?: string; info?: { id?: string } } }).data;
            const sessionID = id?.sessionID ?? id?.info?.id;
            if (sessionID) hooks.forget(sessionID);
          }
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return () => stop.abort();
  },
} satisfies Plugin.Plugin;
