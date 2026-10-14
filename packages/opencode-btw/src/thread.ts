// The side thread as data, shared by both halves: the modes, the prompts the side session gets,
// the handoff text, and the message bookkeeping that turns OpenCode session messages into
// exchanges. Adapted from pi-btw 0.6.1 (MIT, Dan Bachelder); the prompts and handoff formats
// are upstream's.

/**
 * `contextual`: a fork of the main session (its conversation so far, same agent).
 * `tangent`: a fresh session without the main conversation.
 * `readonly`: a fork run by a read-only agent, with the editing tools and actions removed.
 */
export type ThreadMode = "contextual" | "tangent" | "readonly";

/** The side session's metadata entry; the server half reads it to recognise side sessions. */
export interface BtwMetadata {
  /** The main session the thread belongs to. */
  main: string;
  mode: ThreadMode;
  title: string;
}

export const METADATA_KEY = "btw";

export const SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only: that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

export const READONLY_PROMPT = "This side thread is read-only: inspect and explain, do not edit files, run commands that change anything, or start subagents.";

export const SUMMARIZE_PROMPT =
  "Summarize the side conversation so far concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

/** Tools (by name) and permission actions a read-only thread does without. */
export const READONLY_DENIED = ["edit", "write", "patch", "shell", "bash", "subagent", "worktree"] as const;

export function isDeniedReadonly(action: string): boolean {
  return (READONLY_DENIED as readonly string[]).includes(action);
}

/** Session metadata that marks a side session, or undefined. */
export function btwMetadata(metadata: unknown): BtwMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const entry = (metadata as Record<string, unknown>)[METADATA_KEY];
  if (!entry || typeof entry !== "object") return undefined;
  const { main, mode, title } = entry as Record<string, unknown>;
  if (typeof main !== "string" || (mode !== "contextual" && mode !== "tangent" && mode !== "readonly")) return undefined;
  return { main, mode, title: typeof title === "string" ? title : "" };
}

/**
 * The arguments of a slash command: OpenCode passes the text after the command, but a command
 * picked from the completion list arrives with the command itself, which is dropped here.
 */
export function commandArgs(input: string | undefined, names: readonly string[]): string {
  const text = (input ?? "").trim();
  for (const name of names) {
    if (text === `/${name}`) return "";
    if (text.startsWith(`/${name} `)) return text.slice(name.length + 2).trim();
  }
  return text;
}

/** Pi's `/btw [--save] question` syntax; `--save` is accepted and ignored (no visible notes in OpenCode). */
export function parseArgs(args: string): { question: string; save: boolean } {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

/** `provider/model`, `provider/model#variant`, `clear`, or nothing (show). */
export function parseModelArgs(args: string): { action: "show" } | { action: "clear" } | { action: "set"; providerID: string; modelID: string; variant?: string } | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  if (trimmed === "clear") return { action: "clear" };
  const match = /^([^\s/]+)\/([^\s#]+)(?:#(\S+))?$/.exec(trimmed);
  if (!match) return { action: "invalid", message: "Usage: /btw:model <provider>/<model>[#variant] | clear" };
  return { action: "set", providerID: match[1]!, modelID: match[2]!, ...(match[3] ? { variant: match[3] } : {}) };
}

/** A variant name (OpenCode's thinking levels), `clear`, or nothing (show). */
export function parseThinkingArgs(args: string): { action: "show" } | { action: "clear" } | { action: "set"; variant: string } | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  if (trimmed === "clear") return { action: "clear" };
  if (!/^[\w-]+$/.test(trimmed)) return { action: "invalid", message: "Usage: /btw:thinking <variant> | clear" };
  return { action: "set", variant: trimmed };
}

export function formatModel(model: { providerID: string; modelID: string; variant?: string }): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`;
}

/** The title a side session gets: `btw: <question>`, cut to one line. */
export function threadTitle(question: string, mode: ThreadMode): string {
  const first = question.replace(/\s+/g, " ").trim();
  const base = first ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "side conversation";
  return mode === "tangent" ? `btw tangent: ${base}` : mode === "readonly" ? `btw ask: ${base}` : `btw: ${base}`;
}

/**
 * A session id in OpenCode 2.0.24's format (`ses_` + 9 hex digits of a descending time, a 3-digit
 * counter, 14 random characters): `session.import` needs a fresh id, and these sort like the
 * server's own. Only the `ses_` prefix is checked by the server.
 */
export function newSessionID(now = Date.now(), random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const time = (0xfffffffff - (now % 0x1000000000)).toString(16).padStart(9, "0");
  let tail = "";
  for (let i = 0; i < 14; i++) tail += alphabet[Math.floor(random() * alphabet.length)];
  return `ses_${time}ffe${tail}`;
}

/**
 * The main session's messages a hidden fork copies (`session.export` then `session.import` into
 * a child session): everything complete, as OpenCode's own fork does, under new ids (message ids
 * are global) that keep their order.
 */
export function forkCopies<M extends MessageLike & { status?: string }>(messages: readonly M[]): M[] {
  return messages
    .filter((m) => !(m.type === "assistant" && m.time?.completed === undefined) && m.status !== "running")
    .map((m, i) => ({ ...m, id: `${m.id}_b${i}` }));
}

/** The shape of OpenCode's session messages this module reads (a subset of SessionMessageInfo). */
export interface MessageLike {
  id: string;
  type: string;
  text?: string;
  content?: ReadonlyArray<{ type: string; text?: string; name?: string; state?: { status?: string; title?: string; input?: Record<string, unknown> } }>;
  finish?: string;
  error?: unknown;
  time?: { created: number; completed?: number };
}

export interface Exchange {
  user: string;
  assistant: string;
}

export function assistantText(message: MessageLike): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n")
    .trim();
}

/**
 * The messages of the thread itself: those after `after`, the last message the side session had
 * when it was created (a fork starts with copies of the main session's messages); without it, or
 * when it is gone, those created at or after `since`. Messages are in creation order.
 */
export function threadMessages<M extends MessageLike>(messages: readonly M[], after: string | undefined, since: number): M[] {
  if (after) {
    const index = messages.findIndex((m) => m.id === after);
    if (index >= 0) return messages.slice(index + 1);
  }
  return messages.filter((m) => (m.time?.created ?? 0) >= since);
}

/**
 * Exchanges for a handoff: each user message with the assistant text that followed it (several
 * assistant messages merged); an exchange whose reply errored or was interrupted is dropped.
 * Synthetic messages (OpenCode's own, such as an agent's mode reminder) are not the user's.
 */
export function exchanges(messages: readonly MessageLike[]): Exchange[] {
  const out: Exchange[] = [];
  let user = "";
  let assistant = "";
  let exclude = false;
  const push = () => {
    if (!exclude && (user || assistant)) out.push({ user: user.trim() || "(No user prompt)", assistant: assistant.trim() || "(No assistant response)" });
    user = "";
    assistant = "";
    exclude = false;
  };
  for (const message of messages) {
    if (message.type === "user") {
      const text = (message.text ?? "").trim();
      if (!text) continue;
      push();
      user = text;
      continue;
    }
    if (message.type !== "assistant") continue;
    if (message.error || message.finish === "error") {
      exclude = true;
      continue;
    }
    const text = assistantText(message);
    if (text) assistant = assistant ? `${assistant}\n\n${text}` : text;
  }
  push();
  return out;
}

export function formatThread(thread: readonly Exchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

/** The message injected into the main session; `summary` is the model's summary, else the thread. */
export function handoffMessage(body: string, instructions: string, summary: boolean): string {
  const trimmed = instructions.trim();
  if (summary) return `Here is a summary of a side conversation I had.${trimmed ? ` ${trimmed}` : ":"}\n\n${body}`;
  return trimmed ? `Here is a side conversation I had. ${trimmed}\n\n${body}` : `Here is a side conversation I had for additional context:\n\n${body}`;
}

/** One line for a tool call in the transcript: `read src/a.ts`, `shell ls`. */
export function toolLine(part: { name?: string; state?: { status?: string; title?: string; input?: Record<string, unknown> } }): string {
  const name = part.name ?? "tool";
  const title = part.state?.title?.trim();
  if (title) return `${name} ${title}`;
  const input = part.state?.input ?? {};
  const arg = ["filePath", "path", "pattern", "command", "query", "url", "description"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  return arg ? `${name} ${arg.replace(/\s+/g, " ").slice(0, 80)}` : name;
}
