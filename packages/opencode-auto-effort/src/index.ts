// opencode-auto-effort: sets the effort (opencode's variant) for each prompt you send. Jev rates
// how demanding the request is (0-3) in chat.message, before the user message is saved; the
// policy smooths that into a level, and the message carries it, so every model request of that
// turn (tool follow-ups included) uses it and prompt caches survive. The variant the session
// would have used (your pick, or the agent's) is the ceiling. Settings come from the shared
// `~/.config/agents/auto-effort.json` and `.agents/auto-effort.json`, the plugin options, and
// `.opencode/auto-effort.json`, read on each prompt (see settings.ts). When a subscription window
// is on track to run out before it resets (limits.ts, read from response headers by usage.ts),
// the variant goes one or two levels below the policy's pick; the pick itself is kept apart.
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { askJev, noul, score } from "./jev.ts";
import { DEFAULT_LIMITS, type LimitsPolicy, type Pressure, type Tier, type Tracker, applyLimit, limitsPolicy, pressureLabel } from "./limits.ts";
import { DEFAULT_POLICY, type EffortState, LEVELS, type Policy, decide, levelIndex } from "./policy.ts";
import { type MessageLike, QUESTIONS, effortState } from "./request.ts";
import { deepMerge, loadSettings } from "./settings.ts";
import { install, trackerKey, uninstall } from "./usage.ts";

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
}

export interface LimitsDeps {
  /** Readings by tracker key (`anthropic`, `codex`); usage.ts fills them from response headers. */
  trackers?: Map<string, Tracker>;
  now?: () => number;
}

const NO_PRESSURE: Pressure = { tier: "none", steps: 0 };

type Client = PluginInput["client"];

/** The plugin options from opencode.jsonc over the defaults: that layer alone, without the shared files. */
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

/**
 * `options` is read on every prompt when it is a function (the server passes one that merges the
 * settings files), so edits apply without a restart.
 */
export async function createHooks(
  client: Client,
  options: Options | (() => Options),
  fetchImpl?: typeof fetch,
  limitsDeps: LimitsDeps = {},
): Promise<Hooks> {
  const optionsNow = typeof options === "function" ? options : () => options;
  const trackers = limitsDeps.trackers ?? new Map<string, Tracker>();
  const now = limitsDeps.now ?? Date.now;
  const sessions = new Map<string, SessionState>();
  const variants = new Map<string, string[] | undefined>();

  const variantsOf = async (providerID: string, modelID: string) => {
    const key = `${providerID}/${modelID}`;
    if (!variants.has(key)) {
      try {
        const { data } = await client.config.providers();
        const provider = (data as { providers?: { id: string; models?: Record<string, { variants?: Record<string, unknown> }> }[] })
          ?.providers?.find((p) => p.id === providerID);
        const found = provider?.models?.[modelID]?.variants;
        variants.set(key, found ? Object.keys(found) : undefined);
      } catch {
        variants.set(key, undefined);
      }
    }
    return variants.get(key);
  };

  const log = (message: string) =>
    client.app.log({ body: { service: "auto-effort", level: "info", message } }).catch(() => undefined);

  return {
    "chat.message": async (input, output) => {
      const options = optionsNow();
      if (!options.enabled || !options.agents.includes(output.message.agent)) return;
      const model = output.message.model as { providerID: string; modelID: string; variant?: string };
      const ceiling = model.variant;
      if (!ceiling || levelIndex(ceiling) < 0) return;
      const text = output.parts
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n")
        .trim();
      if (!text) return;

      const s = sessions.get(input.sessionID) ?? { dwell: options.policy.minDwell };
      let messages: MessageLike[] = [];
      try {
        const { data } = await client.session.messages({ path: { id: input.sessionID } });
        messages = (data ?? []) as unknown as MessageLike[];
      } catch {
        // No history: Jev judges the request alone.
      }
      const outcome = await askJev(effortState(text, messages), QUESTIONS, {
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
      const available = await variantsOf(model.providerID, model.modelID);
      const baseline = fit(decision.level, ceiling, available);
      const limits = limitsPolicy(options.limits);
      const key = trackerKey(model.providerID);
      const pressure = limits.enabled && key ? (trackers.get(key)?.assess(now(), limits) ?? NO_PRESSURE) : NO_PRESSURE;
      let level = fit(applyLimit(decision.level, pressure, options.policy.floor, LEVELS).level, ceiling, available);
      // No supported variant below: keep the baseline rather than going up to the ceiling.
      if (levelIndex(level) > levelIndex(baseline)) level = baseline;
      const tierChanged = pressure.tier !== (s.tier ?? "none");
      sessions.set(input.sessionID, { ...decision.state, level, baseline, tier: pressure.tier });
      model.variant = level;

      const limited = pressure.tier !== "none" ? `, limited: ${pressureLabel(pressure)}` : "";
      const reason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;
      const detail = judgment
        ? ` (score ${judgment.score.toFixed(2)}, confidence ${judgment.confidence.toFixed(2)}, go-ahead ${judgment.ack.toFixed(2)}${outcome.ok ? `, ${outcome.latencyMs} ms` : ""})`
        : "";
      const limitDetail =
        pressure.tier !== "none"
          ? `; limit ${pressure.tier} (${pressureLabel(pressure)}${pressure.projected !== undefined ? `, projected ${Math.round(pressure.projected * 100)}%` : ""}), baseline ${baseline}`
          : "";
      await log(`${current} -> ${level} (ceiling ${ceiling}): ${reason}${detail}${limitDetail}`);
      if (options.toast && (level !== current || tierChanged)) {
        await client.tui
          .showToast({ body: { message: `effort: ${level} (auto${limited})`, variant: pressure.tier === "none" ? "info" : "warning" } })
          .catch(() => undefined);
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") sessions.delete((event.properties as { info: { id: string } }).info.id);
    },
  };
}

const server: Plugin = async (input, options) => {
  const hooks = await createHooks(input.client, () => currentOptions(options, input.directory), undefined, { trackers: install() });
  return { ...hooks, dispose: async () => uninstall() };
};

export default { id: NAME, server };
