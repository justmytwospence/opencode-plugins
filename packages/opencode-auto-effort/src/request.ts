// The Jev request for a new prompt: questions, and the state built from the session's messages.
import type { Question } from "./jev.ts";

export const QUESTIONS: Record<string, Question> = {
  depth: {
    type: "score",
    instructions:
      "How much careful reasoning does the work asked for in `request` need from a coding agent, given `previous_requests`, `last_outcome` and `signals`?",
    criteria: [
      "A lookup, a trivial answer, or a mechanical change",
      "A routine single-file change or a clear question",
      "A multi-step change, debugging with clear symptoms, or design inside a known pattern",
      "Subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
    ],
  },
  ack: {
    type: "noul",
    instructions:
      'Is `request` a short go-ahead or acknowledgement (like "yes", "go ahead", "continue", "do it") that relies on the plan already discussed, rather than a new task?',
    criteria: { true: "A go-ahead for work already under way", false: "A new or changed request" },
  },
};

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

/**
 * The part of a model message (OpenCode 2's `Message` from `@opencode/ai`, as the session's
 * `context` hook sees it) this reads.
 */
export interface MessageLike {
  role: string;
  content: readonly { type: string; text?: string; name?: string; result?: { type: string } }[];
}

/** The text a user typed, or an assistant wrote: its text parts. */
export function messageText(message: MessageLike): string {
  return message.content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * The Jev state for a new prompt: the request, the two before it, the last answer, and what the
 * last run did. `messages` are the session's messages before the new prompt.
 */
export function effortState(prompt: string, messages: readonly MessageLike[]): Record<string, unknown> {
  const prompts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user" && messageText(m)) prompts.push(i);
  });
  const runStart = prompts.at(-1);
  const previous = prompts.slice(-2).map((i) => clip(messageText(messages[i]!), 1_000));
  let lastOutcome = "";
  const signals = { last_run_errors: 0, files_edited: 0, tool_calls: 0 };
  if (runStart !== undefined) {
    for (const m of messages.slice(runStart + 1)) {
      if (m.role === "assistant") {
        const text = messageText(m);
        if (text) lastOutcome = text;
        for (const part of m.content) {
          if (part.type !== "tool-call") continue;
          signals.tool_calls++;
          if (EDIT_TOOLS.has(part.name ?? "")) signals.files_edited++;
        }
      }
      for (const part of m.content) {
        if (part.type === "tool-result" && part.result?.type === "error") signals.last_run_errors++;
      }
    }
  }
  return {
    request: clip(prompt, 8_000),
    previous_requests: previous.length ? previous : ["(none: this is the first request)"],
    last_outcome: lastOutcome ? clip(lastOutcome, 1_500) : "(none)",
    signals,
  };
}

/**
 * The messages before the prompt being decided: `messages` as the first model request of a turn
 * sees them ends with that prompt, which is dropped.
 */
export function history(prompt: string, messages: readonly MessageLike[]): readonly MessageLike[] {
  const last = messages.at(-1);
  return last && last.role === "user" && messageText(last) === prompt.trim() ? messages.slice(0, -1) : messages;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
