// opencode children: how they start (`opencode [--model provider/model]`, in the child's pane), and
// their reply: the text of the last assistant message of the session herdr's opencode integration
// reports for the pane, read through this server's client (sessions share opencode's database),
// else through `opencode export`.
import type { ChildAgent, Exec } from "./core/children.ts";
import { clipReply, stripNext } from "./core/text.ts";

export interface MessageLike {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }>;
}

/** The last assistant message's text (its non-synthetic text parts), or undefined. */
export function lastAssistantText(messages: readonly MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

export interface SessionReader {
  /** The session's messages through the server API, or undefined when it cannot read them. */
  messages(sessionID: string, directory: string): Promise<MessageLike[] | undefined>;
}

export function opencodeChild(reader: SessionReader, exec: Exec): ChildAgent {
  return {
    kind: "opencode",
    args: (opts) => (opts.model ? ["--model", opts.model] : []),
    reply: async (rec) => {
      if (!rec.session) return undefined;
      let text = lastAssistantText((await reader.messages(rec.session, rec.cwd)) ?? []);
      if (text === undefined) {
        const r = await exec("opencode", ["export", rec.session], rec.cwd);
        try {
          text = r.code === 0 ? lastAssistantText(JSON.parse(r.stdout).messages ?? []) : undefined;
        } catch {
          text = undefined;
        }
      }
      return text === undefined ? undefined : clipReply(stripNext(text), `opencode session ${rec.session}`);
    },
  };
}
