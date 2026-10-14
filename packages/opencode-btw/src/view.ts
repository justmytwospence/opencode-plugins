// What the /btw panel shows, as plain data: the transcript blocks built from the side session's
// messages, and the header. tui.ts turns them into OpenTUI elements.
import { type MessageLike, type ThreadMode, assistantText, toolLine } from "./thread.ts";

export type Color = "base" | "muted" | "accent" | "success" | "warning" | "error";

export type Block =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string }
  | { kind: "tool"; id: string; text: string; color: Color }
  | { kind: "error"; id: string; text: string };

/** The transcript blocks of the thread's messages, in order. */
export function blocks(messages: readonly MessageLike[], running: boolean): Block[] {
  const out: Block[] = [];
  messages.forEach((message, index) => {
    const last = index === messages.length - 1;
    if (message.type === "user") {
      const text = (message.text ?? "").trim();
      if (text) out.push({ kind: "user", id: message.id, text });
      return;
    }
    if (message.type !== "assistant") return;
    const parts = message.content ?? [];
    let text = "";
    let n = 0;
    const flush = (streaming: boolean) => {
      if (text.trim()) out.push({ kind: "assistant", id: `${message.id}:${n++}`, text: text.trim(), streaming });
      text = "";
    };
    parts.forEach((part, i) => {
      const lastPart = i === parts.length - 1;
      if (part.type === "text") {
        text = text ? `${text}\n${part.text ?? ""}` : (part.text ?? "");
        if (!lastPart) flush(false);
      } else if (part.type === "reasoning") {
        flush(false);
        if (last && lastPart && running && message.time?.completed === undefined) out.push({ kind: "thinking", id: `${message.id}:${i}` });
      } else if (part.type === "tool") {
        flush(false);
        const status = part.state?.status;
        const color: Color = status === "error" ? "error" : status === "completed" ? "muted" : "warning";
        out.push({ kind: "tool", id: `${message.id}:${i}`, text: `${toolLine(part)}${status === "completed" || status === "error" ? "" : "…"}`, color });
      }
    });
    flush(last && running && message.time?.completed === undefined);
    const error = message.error as { message?: string; name?: string; data?: { message?: string } } | undefined;
    if (error) out.push({ kind: "error", id: `${message.id}:error`, text: error.data?.message ?? error.message ?? error.name ?? "error" });
    else if (message.finish === "error" && !assistantText(message)) out.push({ kind: "error", id: `${message.id}:error`, text: "the reply failed" });
  });
  return out;
}

export function modeLabel(mode: ThreadMode): string {
  return mode === "tangent" ? "tangent" : mode === "readonly" ? "ask (read-only)" : "contextual";
}

/** The panel header: `btw · contextual · anthropic/claude-opus-4-6 · running`. */
export function header(mode: ThreadMode, model: string | undefined, agent: string | undefined, running: boolean): string {
  const bits = ["btw", modeLabel(mode)];
  if (agent) bits.push(agent);
  if (model) bits.push(model);
  bits.push(running ? "running" : "idle");
  return bits.join(" · ");
}

export const HINTS = "enter send · shift+enter newline · esc interrupt/close · ctrl+f full screen · /btw:inject · /btw:summarize";
