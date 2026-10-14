// What the CLI half reads from a session's messages: the user messages that name turns, and
// the assistant text the agent wrote since the comments went out.

import type { UserMessage } from "./review.ts";

export type MessageLike = { id: string; type: string; text?: string; time?: { created?: number }; content?: { type: string; text?: string }[] };

/** The session's user messages, oldest first. */
export function userMessages(messages: readonly MessageLike[]): UserMessage[] {
  return messages
    .filter((m) => m.type === "user")
    .map((m) => ({ id: m.id, text: m.text ?? "", created: m.time?.created ?? 0 }))
    .sort((a, b) => a.created - b.created);
}

/** The assistant text written at or after `since`. */
export function assistantText(messages: readonly MessageLike[], since: number): string {
  return messages
    .filter((m) => m.type === "assistant" && (m.time?.created ?? 0) >= since)
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? ""))
    .join("\n");
}
