// opencode-marimo (server): the state of the marimo notebook open under the
// project, taken when the user sends a prompt, sits right after that prompt for
// every model request of the turn. It is added in the messages transform and
// never stored, so old copies never pile up. It stays unchanged and in place
// through the turn because Anthropic drops a thinking block when anything before
// it changes; at the next prompt the old copy goes, dropping that earlier turn's
// thinking once.
//
// The port of pi-marimo; src/core is shared with it unchanged.

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { snapshot, STATE_TAG } from "./core/render.js";
import { nodeIo } from "./core/node-io.js";
import { pairTargets } from "./core/touch.js";
import { MarimoWatcher } from "./core/watcher.js";
import { modeFromEnv } from "./mode.js";

type Message = { info: Record<string, any>; parts: Array<Record<string, any>> };

/** Insert the state block as a synthetic user message right after the latest user message (the turn's prompt). */
export function insertState(messages: Message[], text: string): void {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.info.role === "user") { at = i; break; }
  if (at < 0) return;
  const prompt = messages[at]!;
  const id = `${prompt.info.id}-marimo-state`;
  messages.splice(at + 1, 0, {
    info: { ...prompt.info, id },
    parts: [{ id: `${id}-text`, sessionID: prompt.info.sessionID, messageID: id, type: "text", text, synthetic: true }],
  });
}

/** The latest user message's id: the turn the state belongs to. */
export function turnOf(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.info.role === "user") return messages[i]!.info.id as string;
  return undefined;
}

export const MarimoPlugin: Plugin = async ({ directory }) => {
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: directory, token: process.env.MARIMO_TOKEN, onChange: () => {} });
  watcher.mode = modeFromEnv();
  watcher.start();
  // Per notebook path: browser edits after this change number are flagged as new.
  const seen = new Map<string, number>();
  // The state taken for the current turn, keyed by the prompt's message id.
  let turn: { prompt: string; text: string } | undefined;

  const hooks: Hooks = {
    dispose: async () => {
      await watcher.stop();
    },
    event: async ({ event }) => {
      // Browser edits made after the agent finished are flagged as new next time.
      if (event.type === "session.idle") for (const f of watcher.followed()) seen.set(f.attachment.path, f.notebook.seq);
    },
    // The notebook this session's agent works in (through marimo-pair) becomes current for it,
    // whatever other sessions or the browser do.
    "tool.execute.before": async (_input, output) => {
      const targets = pairTargets(JSON.stringify(output.args ?? {}));
      if (targets.length) watcher.touch(targets);
    },
    "chat.message": async () => {
      watcher.refresh();
      await watcher.settle(2000);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages as unknown as Message[];
      if (messages.some((m) => m.parts.some((p) => typeof p.text === "string" && p.text.startsWith(`<${STATE_TAG}`)))) return;
      const prompt = turnOf(messages);
      if (!prompt) return;
      if (turn?.prompt !== prompt) {
        // A new turn: take the state now, once.
        const entries = watcher.followed()
          .filter((f) => f.connection === "connected" && f.notebook.ready)
          .map((f) => ({ notebook: f.notebook, attachment: f.attachment, current: f.current, seenSeq: seen.get(f.attachment.path) ?? 0 }));
        turn = { prompt, text: entries.length ? snapshot(entries, { refresh: "prompt" }) : "" };
      }
      if (turn.text) insertState(messages, turn.text);
    },
  };
  return hooks;
};

export default { id: "opencode-marimo", server: MarimoPlugin };
