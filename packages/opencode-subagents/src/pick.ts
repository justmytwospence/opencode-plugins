// Which agent, model and variant a task runs with: explicit arguments, then the agent's own
// model, then Jev's picks, then defaults (from pi-subagents' pick.ts; "thinking" is OpenCode's
// model variant). Agents are OpenCode's own subagent-mode agents, not agent files.
import { type Answer, type Question, choice, score } from "./jev.ts";

export type Tier = "fast" | "balanced" | "strong";
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** An agent a task may run as, as `ctx.agent.list()` reports it. */
export interface AgentInfo {
  id: string;
  description: string;
  /** The agent's own model, as `provider/model`, when it has one. */
  model?: string;
  variant?: string;
}

export interface TierConfig {
  /** `provider/model` per tier; a missing tier uses the parent's model. */
  models: Partial<Record<Tier, string>>;
  descriptions: Record<Tier, string>;
}

/** Resolve defaults only within the parent's provider. Explicit call models bypass this policy. */
export function providerTiers(
  parentModel: string,
  configured: Partial<Record<Tier, string>>,
  byProvider: Record<string, Partial<Record<Tier, string>>> = {},
  available: readonly { provider: string; id: string }[] = [],
): Partial<Record<Tier, string>> {
  const provider = parentModel.split("/")[0];
  const sameProvider = (model: string | undefined) => (model?.startsWith(`${provider}/`) ? model : undefined);
  const models: Partial<Record<Tier, string>> = {};
  // Prefer the matching Sol/Luna generation, and never invent a model absent from the registry.
  const parentId = parentModel.slice(provider.length + 1);
  const sibling = (name: string) => {
    const candidates = available
      .filter((m) => m.provider === provider && m.id.endsWith(`-${name}`))
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
    return candidates.find((m) => m.id === parentId.replace(/-(sol|luna)$/u, `-${name}`)) ?? candidates[0];
  };
  const sol = provider === "openai-codex" ? sibling("sol") : undefined;
  const luna = provider === "openai-codex" ? sibling("luna") : undefined;
  for (const tier of ["fast", "balanced", "strong"] as const) {
    const preset = tier === "fast" ? luna : sol;
    const model = sameProvider(byProvider[provider]?.[tier]) ?? sameProvider(configured[tier]) ?? (preset ? `${provider}/${preset.id}` : undefined);
    if (model) models[tier] = model;
  }
  return models;
}

export const DEFAULT_TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Quick lookups, searches, mechanical edits, summarizing, simple scripted work",
  balanced: "Ordinary implementation, debugging with clear symptoms, reviews, research",
  strong: "Subtle design, hard debugging, cross-cutting changes, correctness-critical work",
};

/** What the caller already decided; Jev fills only the gaps. */
export interface Given {
  agent?: string;
  model?: string;
  variant?: string;
}

/** The Jev questions for the gaps in `given`, or {} when nothing is left to decide. */
export function pickQuestions(given: Given, agents: readonly AgentInfo[], tiers: TierConfig, askTier: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {};
  if (!given.agent && agents.length > 1) {
    questions.role = {
      type: "choice",
      instructions: "Which agent is best suited to carry out `task`?",
      criteria: Object.fromEntries(agents.map((a) => [a.id, a.description])),
    };
  }
  if (!given.model && askTier) {
    questions.tier = {
      type: "choice",
      instructions: "How capable a model does `task` need?",
      criteria: tiers.descriptions,
    };
  }
  if (!given.variant) {
    questions.effort = {
      type: "score",
      instructions: "How much careful reasoning does `task` need from the agent doing it?",
      criteria: [
        "A lookup, a search, or a mechanical change",
        "A routine change or a clear question",
        "A multi-step change, debugging with clear symptoms, or design in a known pattern",
        "Subtle design, a cross-cutting change, hard debugging, or correctness-critical work",
      ],
    };
  }
  return questions;
}

export interface Picks {
  agent?: string;
  tier?: Tier;
  variant?: string;
}

/** Read Jev's answers: a role at confidence >= 0.5, a tier at >= 0.4 (else balanced), effort by score. */
export function readPicks(answers: Record<string, Answer>): Picks {
  const picks: Picks = {};
  const role = choice(answers, "role");
  if (role && role.confidence >= 0.5) picks.agent = role.choice;
  const tier = choice(answers, "tier");
  if (tier) picks.tier = tier.confidence >= 0.4 && ["fast", "balanced", "strong"].includes(tier.choice) ? (tier.choice as Tier) : "balanced";
  const effort = score(answers, "effort");
  if (effort) picks.variant = EFFORTS[Math.min(3, Math.max(0, Math.round(effort.score)))];
  return picks;
}

export interface Resolved {
  agent: AgentInfo;
  /** `provider/model`. */
  model: string;
  /** The variant to run with; undefined leaves the model's default. */
  variant?: string;
  /** Which choices Jev made, for display. */
  byJev: { agent: boolean; model: boolean; variant: boolean };
  tier?: Tier;
}

/** The parent session's model and variant; `variant` is undefined when it runs the model's default. */
export interface ParentModel {
  model: string;
  variant?: string;
}

/**
 * Precedence for each choice: explicit arguments, then the agent's own model, then Jev, then
 * defaults (`general`, the balanced tier, the parent's model and variant).
 */
export function resolve(given: Given, agents: readonly AgentInfo[], picks: Picks | undefined, tiers: TierConfig, parent: ParentModel): Resolved | { error: string } {
  const byJev = { agent: false, model: false, variant: false };
  let agentName = given.agent;
  if (!agentName && picks?.agent && agents.some((a) => a.id === picks.agent)) {
    agentName = picks.agent;
    byJev.agent = true;
  }
  agentName ??= agents.some((a) => a.id === "general") ? "general" : agents[0]?.id;
  const agent = agents.find((a) => a.id === agentName);
  if (!agent) return { error: `Unknown agent "${agentName ?? ""}". Available: ${agents.map((a) => a.id).join(", ")}.` };

  // An agent's own model is a default too: switching the main session's provider must not silently
  // launch children against a different subscription. Only an explicit call model may do that.
  const provider = parent.model.split("/")[0];
  const agentModel = agent.model?.startsWith(`${provider}/`) ? agent.model : undefined;
  let model = given.model ?? agentModel;
  let tier: Tier | undefined;
  if (!model) {
    tier = picks?.tier ?? "balanced";
    const tierModel = tiers.models[tier]?.startsWith(`${provider}/`) ? tiers.models[tier] : undefined;
    model = tierModel ?? parent.model;
    byJev.model = picks?.tier !== undefined && tierModel !== undefined;
  }
  let variant = given.variant ?? (agentModel ? agent.variant : undefined);
  if (!variant && picks?.variant) {
    variant = picks.variant;
    byJev.variant = true;
  }
  variant ??= parent.variant;
  return { agent, model, ...(variant ? { variant } : {}), byJev, ...(tier ? { tier } : {}) };
}

/** `variant` when the model offers it, else the nearest lower effort it does offer, else none. */
export function fitVariant(variant: string | undefined, available: readonly string[] | undefined): string | undefined {
  if (!variant || !available) return variant;
  if (available.includes(variant)) return variant;
  const index = EFFORTS.indexOf(variant as (typeof EFFORTS)[number]);
  if (index < 0) return undefined;
  for (let i = index; i >= 0; i--) {
    const name = EFFORTS[i] as string;
    if (available.includes(name)) return name;
  }
  return undefined;
}
