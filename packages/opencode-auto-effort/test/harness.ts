// A fake OpenCode for the hooks: model variants, a recorder for toasts and logs, and a driver
// that plays one prompt through the `prompt` and `context` hooks the way a turn does.
import type { ChangedEvent } from "../src/rpc.ts";
import type { ContextEvent, Hooks, Host, VariantInfo } from "../src/server.ts";
import type { MessageLike } from "../src/request.ts";

export const LEVEL_SETTINGS = (level: string) => ({ reasoningEffort: level });

export function host(variants: readonly string[] = ["low", "medium", "high", "xhigh", "max"]) {
  const toasts: ChangedEvent[] = [];
  const logs: string[] = [];
  const list: VariantInfo[] = variants.map((id) => ({ id, settings: LEVEL_SETTINGS(id), ...(id === "low" ? { headers: { "x-effort": "low" } } : {}) }));
  const h: Host = {
    variants: async () => list,
    notify: (e) => void toasts.push(e),
    log: (m) => void logs.push(m),
  };
  return { host: h, toasts, logs, messages: toasts as { message: string }[] };
}

/**
 * One prompt: the `prompt` hook, then the first model request of the turn. Returns the level the
 * request ran at (the overlaid `reasoningEffort`, or the ceiling when nothing was overlaid).
 */
export async function turn(hooks: Hooks, text: string, ceiling: string | undefined, agent = "build", messages: MessageLike[] = []) {
  hooks.prompt("s", text);
  const event: ContextEvent = {
    sessionID: "s",
    agent,
    model: { providerID: "anthropic", id: "opus", ...(ceiling ? { variant: ceiling } : {}) },
    messages: [...messages, { role: "user", content: [{ type: "text", text }] }],
    options: {},
  };
  await hooks.context(event);
  return (event.options.reasoningEffort as string | undefined) ?? ceiling;
}

/** A follow-up model request of the same turn (after a tool call): no new prompt. */
export async function followUp(hooks: Hooks, ceiling: string) {
  const event: ContextEvent = { sessionID: "s", agent: "build", model: { providerID: "anthropic", id: "opus", variant: ceiling }, messages: [], options: {} };
  await hooks.context(event);
  return (event.options.reasoningEffort as string | undefined) ?? ceiling;
}
