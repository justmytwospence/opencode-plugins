// Jev's compaction, both forms the server's `compaction` hook uses: a summary written in code that
// replaces the model's (the cold-cache dialog's Jev option; the hook sets `result`), and the items
// OpenCode's own summarizer must keep word for word. Jev judges each message and tool call against
// a goal, in batches, with `compact.concurrency` requests in flight and `compact.timeoutMs` for
// each.
import type { Settings } from "./core.ts";
import type { Ask } from "./jev.ts";
import { type Keep, type Unit, batches, codeSummary, keepAnswers, keepCounts, keepQuestions, keepState, verbatimSection } from "./lean.ts";
import { type MessageLike, extractUnits, lastUserMessages } from "./units.ts";

export type Judged =
  | { ok: true; keep: Map<string, Keep>; counts: Record<Keep, number>; latencyMs: number; inputTokens: number }
  | { ok: false; reason: string };

/** Jev's verdict on every unit; any failed request fails the whole pass. */
export async function judgeUnits(units: readonly Unit[], goal: string, settings: Settings["compact"], ask: Ask): Promise<Judged> {
  const started = Date.now();
  const keep = new Map<string, Keep>();
  const queue = batches(units);
  let inputTokens = 0;
  let reason: string | undefined;
  const worker = async () => {
    for (let batch = queue.shift(); batch && !reason; batch = queue.shift()) {
      const outcome = await ask(keepState(goal, batch), keepQuestions(batch));
      if (!outcome.ok) {
        reason = outcome.reason;
        return;
      }
      inputTokens += outcome.inputTokens ?? 0;
      keepAnswers(batch, outcome.answers, keep);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, worker));
  if (reason) return { ok: false, reason: `Jev failed (${reason})` };
  return { ok: true, keep, counts: keepCounts(keep), latencyMs: Date.now() - started, inputTokens };
}

export type Summary =
  | { ok: true; summary: string; counts: Record<Keep, number>; units: number; latencyMs: number }
  | { ok: false; reason: string };

/**
 * The code summary's sections under the headings of OpenCode's compaction template: OpenCode
 * accepts a summary only when it carries one of them, and a hook's `result` is checked the same
 * way. `# Compacted with Jev` and `## Earlier summary` stay as they are.
 */
export function templateHeadings(summary: string): string {
  const map: Record<string, string> = { "## Goal": "## Objective", "## Kept verbatim": "## Important Context", "## Notes": "## Work State", "## Files": "## Relevant Files" };
  return summary
    .split("\n")
    .map((line) => map[line.trim()] ?? line)
    .join("\n");
}

/**
 * The summary Jev's compaction writes in code from a session's messages, judged against `goal`
 * (the held prompt, or a focus; the last two requests when empty), shaped for OpenCode's
 * template. Nothing is spent on an LLM; a Jev failure yields no summary.
 */
export async function jevSummary(messages: readonly MessageLike[], goal: string, settings: Settings["compact"], ask: Ask): Promise<Summary> {
  const { units, previousSummary, fileOps } = extractUnits(messages);
  if (!units.length) return { ok: false, reason: "nothing for Jev to judge" };
  const judged = await judgeUnits(units, goal.trim() || lastUserMessages(messages, 2), settings, ask);
  if (!judged.ok) return judged;
  const summary = templateHeadings(codeSummary({ units, keep: judged.keep, previousSummary, fileOps }));
  return { ok: true, summary, counts: judged.counts, units: units.length, latencyMs: judged.latencyMs };
}

/** One sentence for OpenCode's summarizer, then the items Jev kept word for word. */
export const VERBATIM_LEAD = "Carry the items under \"Kept verbatim\" below into the summary word for word; they are what the conversation still needs exactly.";

export type Verbatim =
  | { ok: true; context: string; counts: Record<Keep, number>; units: number; latencyMs: number }
  | { ok: false; reason: string };

/**
 * What the compacting hook adds to the summarizer's context: Jev's verbatim items, judged against
 * `goal` (the guidance, else the last two user messages). Empty when Jev kept nothing verbatim.
 */
export async function verbatimContext(messages: readonly MessageLike[], goal: string | undefined, settings: Settings["compact"], ask: Ask): Promise<Verbatim> {
  const { units } = extractUnits(messages);
  if (!units.length) return { ok: false, reason: "nothing for Jev to judge" };
  const judged = await judgeUnits(units, goal?.trim() || lastUserMessages(messages, 2), settings, ask);
  if (!judged.ok) return judged;
  const section = verbatimSection(units, judged.keep);
  return { ok: true, context: section ? `${VERBATIM_LEAD}\n\n${section}` : "", counts: judged.counts, units: units.length, latencyMs: judged.latencyMs };
}
