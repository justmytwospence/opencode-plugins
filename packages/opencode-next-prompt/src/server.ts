// opencode-next-prompt (server): one short system-prompt section asks the model to end its final
// message with a `<next>…</next>` line when exactly one next step is obvious, and every finished
// text part has that line removed before it is stored, so it never reaches the session or later
// requests. The TUI half reads the line from the streamed deltas and shows it in the prompt.
//
// The section goes only to the user's own sessions: hidden agents (title, summary, compaction)
// and subagent sessions are skipped, since nothing would show their suggestion.

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { loadSettings } from "./settings.js";
import { INSTRUCTION, extractNext } from "./tag.js";

export const NAME = "next-prompt";

export interface Options {
  enabled: boolean;
  acceptKeys: string[];
  maxChars: number;
  jev: { enabled: boolean; model: string; timeoutMs: number; threshold: number };
}

export const DEFAULTS: Options = {
  enabled: true,
  acceptKeys: ["tab", "right"],
  maxChars: 110,
  jev: { enabled: true, model: "jev-latest", timeoutMs: 1_500, threshold: 0.6 },
};

/** What the server half needs from opencode's client: hidden agents' prompts and whether a session is a child. */
export interface Lookup {
  hiddenPrompts(): Promise<string[]>;
  isChild(sessionID: string): Promise<boolean>;
}

/** True when `system` belongs to a hidden agent (its prompt leads the first system block). */
export function isHiddenAgent(system: readonly string[], hiddenPrompts: readonly string[]): boolean {
  const first = system[0] ?? "";
  return hiddenPrompts.some((prompt) => {
    const head = prompt.trim().slice(0, 200);
    return head.length > 0 && first.trimStart().startsWith(head);
  });
}

export function createHooks(lookup: Lookup, options: () => Options): Hooks {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!options().enabled || !input.sessionID) return;
      if (output.system.some((block) => block.includes(INSTRUCTION))) return;
      try {
        if (isHiddenAgent(output.system, await lookup.hiddenPrompts())) return;
        if (await lookup.isChild(input.sessionID)) return;
      } catch {
        // Unknown: keep the request as it is.
        return;
      }
      // A separate block after the first keeps the main system prompt's cache prefix intact.
      output.system.push(INSTRUCTION);
    },
    "experimental.text.complete": async (_input, output) => {
      const out = extractNext(output.text, options().maxChars);
      if (out.found) output.text = out.text;
    },
  };
}

type Client = {
  app: { agents: () => Promise<{ data?: Array<{ hidden?: boolean; prompt?: string }> }> };
  session: { get: (input: { path: { id: string } }) => Promise<{ data?: { parentID?: string } }> };
};

export function clientLookup(client: Client): Lookup {
  let prompts: Promise<string[]> | undefined;
  const children = new Map<string, Promise<boolean>>();
  return {
    hiddenPrompts: () => {
      prompts ??= client.app
        .agents()
        .then(({ data }) => (data ?? []).filter((a) => a.hidden && a.prompt).map((a) => a.prompt as string))
        .catch(() => {
          prompts = undefined;
          return [];
        });
      return prompts;
    },
    isChild: (sessionID) => {
      let known = children.get(sessionID);
      if (!known) {
        known = client.session
          .get({ path: { id: sessionID } })
          .then(({ data }) => Boolean(data?.parentID))
          .catch(() => {
            children.delete(sessionID);
            return false;
          });
        children.set(sessionID, known);
      }
      return known;
    },
  };
}

const server: Plugin = async (input, pluginOptions) =>
  createHooks(clientLookup(input.client as unknown as Client), () =>
    loadSettings(NAME, DEFAULTS, pluginOptions as Record<string, unknown> | undefined, input.directory),
  );

export default { id: "opencode-next-prompt", server };
