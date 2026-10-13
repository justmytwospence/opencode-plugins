// OpenCode children: how they start and how their reply is read.
//
// The OpenCode 2 TUI takes no `--model`, so the parent's server half creates the child's session
// first (with the model, in the child's directory) and starts the child on it with `--session
// <id>`. The reply is the text of the last assistant message of that session, read through the
// shared server (`ctx.session.context`), else through `opencode session export`.
import type { ChildAgent, ChildRecord, Exec, SpawnOptions } from "./core/children.ts";
import { clipReply, stripNext } from "./core/text.ts";

/** A session message as the server reports it: only what the reply needs. */
export interface MessageLike {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** The last assistant message's text (its text parts), or undefined. */
export function lastAssistantText(messages: readonly MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

export interface SessionReader {
  /** The session's messages through the server, or undefined when it cannot read them. */
  messages(sessionID: string, directory: string): Promise<MessageLike[] | undefined>;
}


export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** `provider/model[#variant]` as OpenCode writes it. */
export function parseModel(spec: string | undefined): ModelRef | undefined {
  if (!spec) return undefined;
  const hash = spec.indexOf("#");
  const variant = hash >= 0 ? spec.slice(hash + 1).trim() : undefined;
  const ref = hash >= 0 ? spec.slice(0, hash) : spec;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { providerID: ref.slice(0, slash).trim(), id: ref.slice(slash + 1).trim(), ...(variant ? { variant } : {}) };
}

export function formatModel(model: ModelRef | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export interface OpencodeChild extends ChildAgent {
  /** The sessions `args` created, by child name, until the server takes them. */
  readonly created: Map<string, string>;
}

/**
 * The OpenCode child agent. With `create`, `args` makes the child's session in its directory
 * (`opts.cwd`, resolved by the core) with `opts.model` and starts the TUI on it (`--session`);
 * without, the child starts on a fresh session with OpenCode's default model.
 */
export function opencodeChild(reader: SessionReader, exec: Exec, create?: (directory: string, model: ModelRef | undefined) => Promise<string>): OpencodeChild {
  const created = new Map<string, string>();
  return {
    kind: "opencode",
    created,
    args: async (opts: SpawnOptions, name: string) => {
      if (!create) return [];
      const session = await create(opts.cwd, parseModel(opts.model));
      created.set(name, session);
      return ["--session", session];
    },
    reply: async (rec: ChildRecord) => {
      if (!rec.session) return undefined;
      let text = lastAssistantText((await reader.messages(rec.session, rec.cwd)) ?? []);
      if (text === undefined) {
        const r = await exec("opencode", ["session", "export", rec.session], rec.cwd);
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
