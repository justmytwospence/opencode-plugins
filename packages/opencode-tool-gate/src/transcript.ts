// The transcript context Jev judges a call in, read from OpenCode's session context
// (`ctx.session.context`): the user's recent requests, the agent's latest explanation, the agent's
// message the newest request replies to, and the agent's words beside a tool call. Ported from
// pi-tool-gate's transcript module, which read pi's session branch.

/** The parts of an OpenCode session message (`SessionMessageInfo`) this reads. */
export interface MessageLike {
  id?: string;
  type: string;
  /** User and synthetic messages: the text typed. */
  text?: string;
  /** Assistant messages: text, reasoning and tool parts. */
  content?: readonly { type: string; text?: string; id?: string; name?: string }[];
}

/** The visible text of a message: a user's prompt, or an assistant's text parts. */
export function messageText(message: MessageLike): string {
  if (message.type === "user") return (message.text ?? "").trim();
  if (message.type !== "assistant") return "";
  return (message.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** The latest user message and the latest assistant text written after it. */
export function recentTexts(messages: readonly MessageLike[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = messages.length - 1; i >= 0 && (!user || !assistant); i--) {
    const message = messages[i] as MessageLike;
    const text = messageText(message);
    if (!text) continue;
    if (!user && message.type === "user") user = text;
    if (!assistant && !user && message.type === "assistant") assistant = text;
  }
  return { user, assistant };
}

/**
 * The agent's last message before the newest user message: what a short reply like "yes" or
 * "do it" answers.
 */
export function agentBeforeLatestUser(messages: readonly MessageLike[]): string {
  let seenUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    const text = messageText(message);
    if (!text) continue;
    if (message.type === "user") {
      if (seenUser) return "";
      seenUser = true;
    } else if (seenUser && message.type === "assistant") return text;
  }
  return "";
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

/** The last `count` user messages, oldest first. */
export function recentUserMessages(messages: readonly MessageLike[], count: number): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < count; i--) {
    const message = messages[i] as MessageLike;
    if (message.type !== "user") continue;
    const text = messageText(message);
    if (text) out.unshift(text);
  }
  return out;
}

/** Readable reasoning in an assistant message (encrypted-only reasoning gives nothing). */
export function reasoningText(message: MessageLike): string {
  if (message.type !== "assistant") return "";
  return (message.content ?? [])
    .filter((p) => p.type === "reasoning" && typeof p.text === "string" && p.text.trim())
    .map((p) => (p.text as string).trim())
    .join("\n\n");
}

/**
 * The agent's words beside tool call `callID` (or in the message `messageID`): the visible text
 * of the assistant message that issued it, or, when it wrote none (models often make their case
 * only in reasoning), its reasoning.
 */
export function callerText(messages: readonly MessageLike[], call: { messageID?: string; callID?: string }): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    if (message.type !== "assistant") continue;
    const issued =
      (call.messageID !== undefined && message.id === call.messageID) ||
      (call.callID !== undefined && (message.content ?? []).some((p) => p.type === "tool" && p.id === call.callID));
    if (issued) return messageText(message) || reasoningText(message);
  }
  return "";
}
