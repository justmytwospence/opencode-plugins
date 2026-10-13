// The TUI half's state, free of Solid and opentui so it can be tested on its own.
//
// The server half strips the `<next>` line from each text part when it completes, so the stored
// part never has it; the streamed deltas do. This keeps the raw text of each streaming text part,
// and when the session goes idle reads the line from the last assistant message.

import { askJev, noul, type JevOptions, type Question } from "./jev.js";
import { extractNext } from "./tag.js";

export const QUESTIONS: Record<string, Question> = {
  useful: {
    type: "noul",
    instructions:
      "A coding agent finished answering `last_user_prompt` with a response ending in `assistant_text_tail`, and proposes `suggestion` as the user's next message. " +
      "Is the suggestion a concrete, non-generic next step that follows from the response, is not already done, and the user would plausibly send next?",
    criteria: {
      true: "A specific, useful next step the user would likely send",
      false: "Generic, already done, unrelated, or a guess among several options",
    },
  },
};

export interface Candidate {
  sessionID: string;
  messageID: string;
  suggestion: string;
  userPrompt: string;
  assistantTail: string;
}

type MessageLike = { id: string; role: string; error?: unknown };
type PartLike = { id: string; type: string; text?: string; synthetic?: boolean; ignored?: boolean };

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

export class Tracker {
  /** Raw streamed text per part, with its session. */
  private raw = new Map<string, { sessionID: string; text: string }>();
  /** Messages whose suggestion was already offered (or found to have none). */
  private done = new Set<string>();

  delta(props: { sessionID: string; partID: string; field: string; delta: string }): void {
    if (props.field !== "text") return;
    const entry = this.raw.get(props.partID);
    if (entry) entry.text += props.delta;
    else this.raw.set(props.partID, { sessionID: props.sessionID, text: props.delta });
  }

  /** Forget the raw text of a session (after reading it, or when it starts over). */
  forget(sessionID: string): void {
    for (const [id, entry] of this.raw) if (entry.sessionID === sessionID) this.raw.delete(id);
  }

  /**
   * The suggestion of the session's last assistant message, read once per message, or undefined
   * when there is none, it failed or was aborted, or the turn is not over.
   */
  candidate(
    sessionID: string,
    messages: readonly MessageLike[],
    parts: (messageID: string) => readonly PartLike[],
    maxChars: number,
  ): Candidate | undefined {
    const last = messages.at(-1);
    try {
      if (!last || last.role !== "assistant" || this.done.has(last.id)) return undefined;
      this.done.add(last.id);
      if (last.error) return undefined;
      const texts = parts(last.id).filter((p) => p.type === "text" && !p.synthetic && !p.ignored);
      let suggestion: string | undefined;
      for (const part of texts) {
        const out = extractNext(this.raw.get(part.id)?.text ?? part.text ?? "", maxChars);
        if (out.found) suggestion = out.suggestion;
      }
      if (!suggestion) return undefined;
      const assistantTail = texts.map((p) => extractNext(p.text ?? "", maxChars).text).join("\n").trim();
      const user = [...messages].reverse().find((m) => m.role === "user");
      const userPrompt = user
        ? parts(user.id)
            .filter((p) => p.type === "text" && !p.synthetic)
            .map((p) => p.text ?? "")
            .join("\n")
            .trim()
        : "";
      return { sessionID, messageID: last.id, suggestion, userPrompt, assistantTail };
    } finally {
      this.forget(sessionID);
    }
  }
}

export interface Verdict {
  show: boolean;
  reason: string;
}

/** Jev's vote; shown when Jev is off or unavailable, since the model already abstains on its own. */
export async function vet(
  candidate: Candidate,
  jev: { enabled: boolean; model: string; timeoutMs: number; threshold: number },
  options: JevOptions = {},
): Promise<Verdict> {
  if (!jev.enabled) return { show: true, reason: "Jev off" };
  const outcome = await askJev(
    {
      last_user_prompt: clip(candidate.userPrompt, 1_500),
      assistant_text_tail: clipTail(candidate.assistantTail, 2_000),
      suggestion: candidate.suggestion,
    },
    QUESTIONS,
    { model: jev.model, timeoutMs: jev.timeoutMs, ...options },
  );
  if (!outcome.ok) return { show: true, reason: `Jev unavailable (${outcome.reason}), shown anyway` };
  const p = noul(outcome.answers, "useful");
  if (p === undefined) return { show: true, reason: "Jev gave no answer, shown anyway" };
  return { show: p >= jev.threshold, reason: `Jev ${p.toFixed(2)} ${p >= jev.threshold ? ">=" : "<"} ${jev.threshold}` };
}
