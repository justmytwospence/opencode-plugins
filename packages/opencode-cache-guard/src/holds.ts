// A held prompt and the ways through it. The terminal half holds a prompt before it is submitted
// (a keymap layer over Enter takes the text out of the prompt box with OpenCode's own stash) and
// offers these choices; the server half runs the compactions the choices ask for.
import { type ColdReason, type Price, type Settings, choiceCosts, compactionFocus, formatCost, formatTokens } from "./core.ts";
import { JEV_KEY_URL } from "./lean.ts";

export interface HeldPrompt {
  /** The prompt as typed. */
  text: string;
  at: number;
  /** Why the next request misses, worded. */
  line: string;
  reason: ColdReason["kind"];
  /** Prompt tokens the next request re-sends. */
  tokens: number;
  /** Dollars at list prices; absent for a model with no known prices. */
  costs?: { send: number; compact: number };
}

export function heldPrompt(input: { text: string; now: number; line: string; reason: ColdReason; tokens: number; price?: Price; ttlMs: number }): HeldPrompt {
  return {
    text: input.text,
    at: input.now,
    line: input.line,
    reason: input.reason.kind,
    tokens: input.tokens,
    costs: input.price ? choiceCosts(input.tokens, input.price, input.ttlMs) : undefined,
  };
}

export type Choice = "keep" | "jev" | "compact" | "fresh" | "send" | "mute";

export interface ChoiceOption {
  value: Choice;
  title: string;
  description: string;
}

/** Under the cold-cache question while Jev is not set up (and not turned off). */
export const JEV_TIP = `Tip: set TYPESAFE_API_KEY (${JEV_KEY_URL}) for Jev, which compacts on a one-second summary for ~$0; "jev": { "enabled": false } in cache-guard.json hides this.`;

/** The dialog's title: why the prompt is held, and the Jev tip when Jev is wanted but missing. */
export function choiceTitle(held: HeldPrompt, jev: { ready: boolean; tip: boolean } = { ready: false, tip: false }): string {
  const line = `Prompt cache miss. ${held.line}`;
  return !jev.ready && jev.tip ? `${line}\n${JEV_TIP}` : line;
}

/**
 * The dialog's options in Pi's order: sending first, so Enter sends as if nothing had asked (Esc
 * keeps the prompt); Jev's compaction, when it is set up, before the summary; Keep last.
 */
export function choiceOptions(held: HeldPrompt, jev: { ready: boolean } = { ready: false }): ChoiceOption[] {
  const size = formatTokens(held.tokens);
  const send = held.costs ? ` (~${formatCost(held.costs.send)})` : "";
  const compact = held.costs ? ` (~${formatCost(held.costs.compact)})` : "";
  return [
    { value: "send", title: `Send anyway${send}`, description: `Write the ${size}-token history to the cache again.` },
    { value: "mute", title: "Send, and stop asking in this session", description: "Same as sending, and no more holds here." },
    ...(jev.ready
      ? [{ value: "jev" as const, title: "Compact with Jev, then send (~1s, ~$0)", description: `Jev picks what the ${size}-token history still needs; the summary is written in code, no LLM reads the history.` }]
      : []),
    { value: "compact", title: `Compact first, then send${compact}`, description: `Summarize the ${size}-token history once, uncached, and continue on the summary.` },
    { value: "fresh", title: "Start fresh with this prompt", description: "A new session with the same agent and model; the history stays here." },
    { value: "keep", title: "Keep the prompt", description: "Leave it in the box; nothing is sent." },
  ];
}

export type Guidance = { kind: "default" } | { kind: "focus" } | { kind: "custom" };

export interface GuidanceOption {
  value: Guidance["kind"];
  title: string;
  description: string;
}

export const GUIDANCE_OPTIONS: GuidanceOption[] = [
  { value: "default", title: "Default summary", description: "OpenCode's own compaction prompt." },
  { value: "focus", title: "Focus on this prompt", description: "Keep what the held prompt needs, drop the rest." },
  { value: "custom", title: "Write guidance...", description: "Your own instructions for the summary." },
];

/** What the compaction hook adds to the summarizer's instructions for a choice; undefined adds nothing. */
export function guidanceText(kind: Guidance["kind"], held: HeldPrompt, custom?: string): string | undefined {
  if (kind === "focus") return compactionFocus(held.text);
  if (kind === "custom") return custom?.trim() || undefined;
  return undefined;
}

/**
 * Whether a prompt about to be submitted is one to hold: real text (not a slash command, which
 * is not a model request; `/compact` and `/new` are ways out) while the settings allow asking.
 */
export function holdable(text: string, mode: string, settings: Settings): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || mode !== "normal") return false;
  return settings.enabled && settings.warn.enabled;
}
