// The terminal half's state, free of Solid and OpenTUI so it can be tested on its own: which
// answer each session ended with (from `session.text.ended` events), and the candidate
// suggestion read from it once the run has succeeded.
import type { Candidate } from "./rpc.ts";
import { extractNext } from "./tag.ts";

/** A message as the terminal's data layer lists it (`SessionMessageInfo`); only what is read here. */
export interface MessageInfoLike {
  id: string;
  type: string;
  /** A user message's text. */
  text?: string;
}

/** The last user message's text, for Jev. */
export function lastUserPrompt(messages: readonly MessageInfoLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "user") return (m.text ?? "").trim();
  }
  return "";
}

export class Tracker {
  /** The last finished text part per session, with its message. */
  private last = new Map<string, { messageID: string; text: string }>();

  /** A text part finished: the latest one is the answer the run ends with. */
  ended(sessionID: string, messageID: string, text: string): void {
    this.last.set(sessionID, { messageID, text });
  }

  /** A run started (or the session is gone): what was tracked no longer matters. */
  forget(sessionID: string): void {
    this.last.delete(sessionID);
  }

  /**
   * The suggestion the session's last answer ends with, read once (the tracked text is dropped),
   * or undefined when the answer has no usable block.
   */
  take(sessionID: string, messages: readonly MessageInfoLike[], maxChars: number): Candidate | undefined {
    const entry = this.last.get(sessionID);
    this.last.delete(sessionID);
    if (!entry) return undefined;
    const out = extractNext(entry.text, maxChars);
    if (!out.suggestion) return undefined;
    return {
      sessionID,
      messageID: entry.messageID,
      suggestion: out.suggestion,
      userPrompt: lastUserPrompt(messages),
      assistantTail: out.text.trim(),
    };
  }
}

export function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) => (part.length === 1 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
}
