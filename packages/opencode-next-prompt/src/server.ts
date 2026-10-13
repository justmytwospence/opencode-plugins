// opencode-next-prompt (server): on every primary model request of a user's own session (the
// session's `context` hook) it adds one short system part asking the model to end its final
// message with a fenced `next` block when exactly one next step is obvious, and removes the
// blocks of earlier answers from the request's assistant messages, so the suggestions never go
// back to the model. The removal runs on every request, so the request is the same whether a
// block was stripped before or not and prompt caches survive.
//
// OpenCode 2 has no hook that rewrites a finished text part, so the block stays in the stored
// message; the terminal half hides it in the transcript and reads the suggestion from it. It
// also vets a suggestion with Jev through the `vet` RPC method here, where TYPESAFE_API_KEY lives.
//
// Subagent sessions (those with a parent) get no instruction: nothing shows their suggestion.
// Title, compaction and generate requests have their own hooks and never see the `context` hook.
import type { Plugin } from "@opencode/plugin";
import { askJev, noul, type JevOptions, type Question } from "./jev.ts";
import { type Candidate, NextPromptRpc, type Verdict } from "./rpc.ts";
import { loadSettings } from "./settings.ts";
import { INSTRUCTION, extractNext } from "./tag.ts";

/** The plugin's name: its settings files are `<dir>/next-prompt.json`. */
export const NAME = "next-prompt";

export interface Options {
  enabled: boolean;
  /** Agents whose sessions get the instruction; empty means every agent. Subagent sessions never do. */
  agents: string[];
  /** Keys that fill the suggestion into the empty prompt (terminal half). */
  acceptKeys: string[];
  maxChars: number;
  jev: { enabled: boolean; model: string; timeoutMs: number; threshold: number };
}

export const DEFAULTS: Options = {
  enabled: true,
  agents: [],
  acceptKeys: ["tab", "right"],
  maxChars: 110,
  jev: { enabled: true, model: "jev-latest", timeoutMs: 1_500, threshold: 0.6 },
};

/**
 * The options in force now: defaults, `~/.config/agents/next-prompt.json`, the plugin options,
 * `<directory>/.agents/next-prompt.json`, then `<directory>/.opencode/next-prompt.json`.
 */
export function currentOptions(raw: Record<string, unknown> | undefined, directory: string): Options {
  return loadSettings(NAME, DEFAULTS, raw, directory);
}

export const QUESTIONS: Record<string, Question> = {
  useful: {
    type: "noul",
    instructions:
      "A coding agent finished answering `last_user_prompt` with a response ending in `assistant_text_tail`, and proposes `suggestion` as the user's next message. " +
      "Is the suggestion a concrete, non-generic next step that follows from the response, is not already done, and the user would plausibly send next?",
    criteria: {
      true: "A specific, useful next step the user would likely send",
      false: "Generic, already done, unrelated, or a guess among several options",
    },
  },
};

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `\u2026${text.slice(-(max - 1))}` : text;
}

/** Jev's vote; shown when Jev is off or unavailable, since the model already abstains on its own. */
export async function vet(candidate: Candidate, jev: Options["jev"], options: JevOptions = {}): Promise<Verdict> {
  if (!jev.enabled) return { show: true, reason: "Jev off" };
  const outcome = await askJev(
    {
      last_user_prompt: clip(candidate.userPrompt, 1_500),
      assistant_text_tail: clipTail(candidate.assistantTail, 2_000),
      suggestion: candidate.suggestion,
    },
    QUESTIONS,
    { model: jev.model, timeoutMs: jev.timeoutMs, ...options },
  );
  if (!outcome.ok) return { show: true, reason: `Jev unavailable (${outcome.reason}), shown anyway` };
  const p = noul(outcome.answers, "useful");
  if (p === undefined) return { show: true, reason: "Jev gave no answer, shown anyway" };
  return { show: p >= jev.threshold, reason: `Jev ${p.toFixed(2)} ${p >= jev.threshold ? ">=" : "<"} ${jev.threshold}` };
}

/** A model message as the session's `context` hook carries it (OpenCode 2's `Message` from `@opencode/ai`). */
export interface MessageLike {
  role: string;
  content: readonly { type: string; text?: string }[];
}

/** The parts of the `context` hook's event next-prompt reads and writes. */
export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  system: Array<{ type: "text"; text: string }>;
  messages: Array<MessageLike>;
}

/** What the hooks need from OpenCode, so tests can fake it. */
export interface Host {
  /** Whether the session has a parent (a subagent's session). */
  isChild(sessionID: string): Promise<boolean>;
}

export interface Hooks {
  context(event: ContextEvent): Promise<void>;
  vet(candidate: Candidate): Promise<Verdict>;
  forget(sessionID: string): void;
}

/**
 * Remove every `next` block from the assistant messages' text parts, in place. Returns how many
 * parts changed.
 */
export function stripHistory(messages: Array<MessageLike>, maxChars: number): number {
  let changed = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "text" || typeof part.text !== "string" || !part.text.includes("next")) continue;
      const out = extractNext(part.text, maxChars);
      if (!out.found) continue;
      (part as { text: string }).text = out.text;
      changed++;
    }
  }
  return changed;
}

/**
 * The hooks, OpenCode-free. `options` is read on every request when it is a function (the
 * server passes one that merges the settings files), so edits apply without a restart.
 */
export function createHooks(host: Host, options: Options | (() => Options), fetchImpl?: typeof fetch): Hooks {
  const optionsNow = typeof options === "function" ? options : () => options;
  const children = new Map<string, Promise<boolean>>();
  /** One verdict per message, so several terminals showing a session ask Jev once. */
  const verdicts = new Map<string, Promise<Verdict>>();
  const isChild = (sessionID: string) => {
    let known = children.get(sessionID);
    if (!known) {
      known = host.isChild(sessionID).catch(() => {
        children.delete(sessionID);
        return false;
      });
      children.set(sessionID, known);
    }
    return known;
  };
  return {
    async context(event) {
      const options = optionsNow();
      if (!options.enabled) return;
      if (options.agents.length && !options.agents.includes(event.agent)) return;
      if (await isChild(event.sessionID)) return;
      stripHistory(event.messages, options.maxChars);
      // Its own part after the main prompt keeps the main prompt's cache prefix intact.
      if (!event.system.some((part) => part.text === INSTRUCTION)) event.system.push({ type: "text", text: INSTRUCTION });
    },
    vet(candidate) {
      const key = `${candidate.sessionID}/${candidate.messageID}/${candidate.suggestion}`;
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = vet(candidate, optionsNow().jev, fetchImpl ? { fetch: fetchImpl } : {});
        verdicts.set(key, verdict);
        if (verdicts.size > 200) verdicts.delete(verdicts.keys().next().value as string);
      }
      return verdict;
    },
    forget(sessionID) {
      children.delete(sessionID);
      for (const key of verdicts.keys()) if (key.startsWith(`${sessionID}/`)) verdicts.delete(key);
    },
  };
}

export default {
  id: NAME,
  async setup(ctx) {
    const hooks = createHooks(
      {
        isChild: async (sessionID) => Boolean((await ctx.session.get({ sessionID }))?.parentID),
      },
      () => currentOptions(ctx.options, ctx.location.directory),
    );
    await ctx.rpc.register(NextPromptRpc, {
      vet: async (input) => hooks.vet(input as Candidate),
    });
    await ctx.session.hook("context", (event) => hooks.context(event as unknown as ContextEvent));

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          if ((event as { type?: string }).type === "session.deleted") {
            const data = (event as { data?: { sessionID?: string; info?: { id?: string } } }).data;
            const sessionID = data?.sessionID ?? data?.info?.id;
            if (sessionID) hooks.forget(sessionID);
          }
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return () => stop.abort();
  },
} satisfies Plugin.Plugin;
