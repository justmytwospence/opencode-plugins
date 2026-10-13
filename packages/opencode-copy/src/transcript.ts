// OpenCode session messages in the entry shape segments.ts reads (Pi's session entries:
// `{ type: "message", message: { role, content } }`), so the extraction code is the same file as
// pi-copy's. User messages carry their text; assistant messages their text blocks and `bash`
// tool calls (as `toolCall` blocks with the call's input); a shell message (a command you ran
// with `!`) becomes a `bash` tool call too, so the command is offered. Reasoning, other tools and
// tool results are not copyable pieces, as in Pi.

export interface Entry {
  type: "message";
  message: { role: "user" | "assistant"; content: string | Block[] };
}

export type Block = { type: "text"; text: string } | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

/** The parts of OpenCode's `SessionMessageInfo` the adapter reads. */
export interface MessageLike {
  type: string;
  text?: string;
  command?: string;
  content?: readonly { type: string; text?: string; name?: string; state?: { input?: Record<string, unknown> } }[];
}

export function toEntries(messages: readonly MessageLike[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      entries.push({ type: "message", message: { role: "user", content: message.text ?? "" } });
    } else if (message.type === "assistant") {
      const blocks: Block[] = [];
      for (const part of message.content ?? []) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text ?? "" });
        else if (part.type === "tool" && part.name === "bash" && part.state?.input) blocks.push({ type: "toolCall", name: "bash", arguments: part.state.input });
      }
      entries.push({ type: "message", message: { role: "assistant", content: blocks } });
    } else if (message.type === "shell" && message.command?.trim()) {
      entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: message.command } }] } });
    }
  }
  return entries;
}

/** Text of a message's content (string or blocks), without tool calls. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [],
    )
    .join("\n");
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last three nonempty user messages, oldest first, each clipped to 500 characters: Jev's context. */
export function recentUserMessages(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < 3; i--) {
    const entry = entries[i];
    if (entry?.message.role !== "user") continue;
    const text = messageText(entry.message.content).trim();
    if (text) out.unshift(clip(text, 500));
  }
  return out;
}
