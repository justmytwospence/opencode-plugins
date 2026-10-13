// OpenCode 2's session messages (`ctx.session.context` on the server, `data.session.message.list`
// in the terminal: `{ type: "user", text }`, `{ type: "assistant", content: [...] }`,
// `{ type: "compaction", summary }`, ...) in and out of `lean.ts`: the units Jev judges for a
// compaction, the files the conversation touched, and the agent's current step for a trim.
import { type FileOps, type Unit, clip, finishUnits } from "./lean.ts";

/** The part of an OpenCode message this reads; a structural subset of `SessionMessage.Info`. */
export type MessageLike =
  | { type: "user"; text: string; [key: string]: unknown }
  | { type: "synthetic"; text: string; [key: string]: unknown }
  | { type: "assistant"; content: ReadonlyArray<ContentLike>; [key: string]: unknown }
  | { type: "compaction"; status?: string; summary?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type ContentLike =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: ToolStateLike }
  | { type: string; [key: string]: unknown };

export interface ToolStateLike {
  status?: string;
  input?: unknown;
  content?: ReadonlyArray<{ type: string; text?: string }>;
  error?: { message?: string; name?: string; [key: string]: unknown } | string;
  [key: string]: unknown;
}

/** The text a user typed, or an assistant wrote (reasoning left out). */
export function messageText(message: MessageLike): string {
  if (message.type === "user" || message.type === "synthetic") return String((message as { text?: unknown }).text ?? "");
  if (message.type === "assistant") {
    return (message as { content: ReadonlyArray<ContentLike> }).content
      .filter((c) => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => (c as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** A tool result's text: its text content items joined, or the error's message. */
export function toolResultText(state: ToolStateLike): { text: string; isError: boolean } {
  if (state.status === "error") {
    const error = state.error;
    const text = typeof error === "string" ? error : (error?.message ?? (error ? JSON.stringify(error) : ""));
    return { text: String(text ?? ""), isError: true };
  }
  const items = Array.isArray(state.content) ? state.content : [];
  return { text: items.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n"), isError: false };
}

export interface Extracted {
  units: Unit[];
  /** The last compaction summary, when the history has one; the units start after it. */
  previousSummary?: string;
  fileOps: FileOps;
}

/**
 * Split messages into units: each user text, each assistant text, and each tool call with its
 * result. Messages up to the last completed compaction are already covered by its summary.
 */
export function extractUnits(messages: readonly MessageLike[], prefix = "U"): Extracted {
  let start = 0;
  let previousSummary: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    if (message.type === "compaction" && (message.status === undefined || message.status === "completed")) {
      const summary = (message as { summary?: unknown }).summary;
      previousSummary = typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
      start = i + 1;
      break;
    }
  }
  const units: Unit[] = [];
  const fileOps: FileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
  const id = () => `${prefix}${String(units.length + 1).padStart(3, "0")}`;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index] as MessageLike;
    if (message.type === "user") {
      const text = messageText(message).trim();
      if (text) units.push({ id: id(), kind: "user", text, message: index });
    } else if (message.type === "assistant") {
      const text = messageText(message).trim();
      if (text) units.push({ id: id(), kind: "assistant", text, message: index });
      for (const part of (message as { content: ReadonlyArray<ContentLike> }).content) {
        if (part.type !== "tool") continue;
        const tool = part as { id?: unknown; name?: unknown; state?: ToolStateLike };
        const state = tool.state ?? {};
        const name = String(tool.name ?? "tool");
        const input = state.input ?? {};
        const { text: result, isError } = toolResultText(state);
        units.push({
          id: id(),
          kind: "tool",
          text: "",
          tool: { name, args: JSON.stringify(input), result, isError, callId: String(tool.id ?? "") },
          message: index,
        });
        noteFile(fileOps, name, input);
      }
    }
  }
  return { units: finishUnits(units), previousSummary, fileOps };
}

function noteFile(ops: FileOps, tool: string, input: unknown) {
  const file = input && typeof input === "object" ? (input as { filePath?: unknown }).filePath : undefined;
  if (typeof file !== "string" || !file) return;
  if (tool === "read") (ops.read as Set<string>).add(file);
  else if (tool === "write") (ops.written as Set<string>).add(file);
  else if (tool === "edit" || tool === "multiedit" || tool === "patch" || tool === "apply_patch") (ops.edited as Set<string>).add(file);
}

/** The latest user message and the assistant's latest text after it: the agent's current step. */
export function recentTexts(messages: readonly MessageLike[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = messages.length - 1; i >= 0 && (!user || !assistant); i--) {
    const message = messages[i] as MessageLike;
    if (message.type !== "user" && message.type !== "assistant") continue;
    const text = messageText(message).trim();
    if (!text) continue;
    if (!user && message.type === "user") user = text;
    if (!assistant && !user && message.type === "assistant") assistant = text;
  }
  return { user, assistant };
}

/** The last `count` user messages, oldest first: the goal of a compaction when none is given. */
export function lastUserMessages(messages: readonly MessageLike[], count: number): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const message = messages[i] as MessageLike;
    if (message.type !== "user") continue;
    const text = messageText(message).trim();
    if (text) texts.unshift(clip(text, 1_500));
  }
  return texts.join("\n---\n");
}
