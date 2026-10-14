// opencode-btw (server): what a side session needs from the shared server. The CLI half creates
// side sessions (a fork of the main session, or a fresh one for a tangent) and marks them with
// `metadata.btw` (thread.ts); this half recognises them by that metadata, which is durable and
// per session, so nothing here depends on a terminal or on a "current session":
//
// - the `context` hook adds the aside system prompt to every model request of a side session,
//   and for a read-only thread also drops the editing tools from the request;
// - the `permission` hook denies the editing actions in a read-only thread, whatever the agent
//   (the CLI half runs those threads on OpenCode's read-only `plan` agent by default);
// - the `generate` hook strips the tools from a side session's one-shot requests (the summary);
// - the `title` hook answers the title request with the thread's own title, so no model call;
// - the `btw` skill (skills/btw/SKILL.md) is registered through `ctx.skill.transform`, so the
//   agent can tell the user when a side thread fits.
import type { Plugin } from "@opencode/plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BtwMetadata, READONLY_PROMPT, SYSTEM_PROMPT, btwMetadata, isDeniedReadonly } from "./thread.ts";

export const NAME = "btw";

/** What the hooks need from OpenCode, so tests can fake it. */
export interface Host {
  /** The side-thread metadata of a session, or undefined for an ordinary session. */
  metadata(sessionID: string): Promise<BtwMetadata | undefined>;
  log(message: string): void;
}

export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  system: Array<{ type: string; text?: string }>;
  tools: Record<string, unknown>;
}

export interface PermissionEvent {
  readonly sessionID: string;
  readonly action: string;
  effect: string;
  message?: string;
}

export interface TitleEvent {
  readonly sessionID: string;
  result?: string;
}

export interface Hooks {
  context(event: ContextEvent): Promise<void>;
  /** `session.generate` on a side session: the summary request, answered without tools. */
  generate(event: ContextEvent): Promise<void>;
  permission(event: PermissionEvent): Promise<void>;
  title(event: TitleEvent): Promise<void>;
  forget(sessionID: string): void;
}

/** The hooks, OpenCode-free. Metadata lookups are cached per session (it is set before the first prompt). */
export function createHooks(host: Host): Hooks {
  const cache = new Map<string, Promise<BtwMetadata | undefined>>();
  const lookup = (sessionID: string): Promise<BtwMetadata | undefined> => {
    let pending = cache.get(sessionID);
    if (!pending) {
      pending = host.metadata(sessionID).catch(() => undefined);
      cache.set(sessionID, pending);
      // Keep the map bounded: ordinary sessions are not remembered for long.
      void pending.then((meta) => {
        if (!meta) setTimeout(() => cache.delete(sessionID), 60_000).unref?.();
      });
    }
    return pending;
  };
  return {
    async context(event) {
      const meta = await lookup(event.sessionID);
      if (!meta) return;
      event.system.push({ type: "text", text: meta.mode === "readonly" ? `${SYSTEM_PROMPT} ${READONLY_PROMPT}` : SYSTEM_PROMPT });
      if (meta.mode === "readonly") for (const name of Object.keys(event.tools)) if (isDeniedReadonly(name)) delete event.tools[name];
    },
    async generate(event) {
      const meta = await lookup(event.sessionID);
      if (!meta) return;
      for (const name of Object.keys(event.tools)) delete event.tools[name];
    },
    async permission(event) {
      if (!isDeniedReadonly(event.action)) return;
      const meta = await lookup(event.sessionID);
      if (meta?.mode !== "readonly") return;
      event.effect = "deny";
      event.message = `btw: this side thread is read-only (${event.action} is not allowed)`;
      host.log(`${event.sessionID}: denied ${event.action} in a read-only thread`);
    },
    async title(event) {
      const meta = await lookup(event.sessionID);
      if (meta?.title) event.result = meta.title;
    },
    forget(sessionID) {
      cache.delete(sessionID);
    },
  };
}

/** The skill from its SKILL.md: frontmatter `name` and `description`, body as content. */
export function parseSkill(markdown: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const fields: Record<string, string> = {};
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return { name: fields.name ?? NAME, description: fields.description ?? "", content: (match ? markdown.slice(match[0].length) : markdown).trim() };
}

export const SKILL_PATH = fileURLToPath(new URL("../skills/btw/SKILL.md", import.meta.url));

export default {
  id: NAME,
  async setup(ctx) {
    const log = (message: string) => console.error(`[btw] ${message}`);
    const hooks = createHooks({
      metadata: async (sessionID) => btwMetadata((await ctx.session.get({ sessionID })).metadata),
      log,
    });
    await ctx.session.hook("context", (event) => hooks.context(event as unknown as ContextEvent));
    await ctx.session.hook("generate", (event) => hooks.generate(event as unknown as ContextEvent));
    await ctx.session.hook("title", (event) => hooks.title(event as unknown as TitleEvent));
    await ctx.permission.hook("evaluate", (event) => hooks.permission(event as unknown as PermissionEvent));

    let skill: { dispose(): Promise<void> } | undefined;
    try {
      const parsed = parseSkill(readFileSync(SKILL_PATH, "utf8"));
      skill = await ctx.skill.transform((editor) => {
        if (!editor.get(NAME)) editor.add({ id: NAME, name: parsed.name, description: parsed.description, path: SKILL_PATH, content: parsed.content } as unknown as Parameters<typeof editor.add>[0]);
      });
    } catch (error) {
      log(`skill not registered: ${error instanceof Error ? error.message : String(error)}`);
    }

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          const e = event as { type?: string; data?: { sessionID?: string } };
          if (e.type === "session.deleted" && e.data?.sessionID) hooks.forget(e.data.sessionID);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return async () => {
      stop.abort();
      await skill?.dispose();
    };
  },
} satisfies Plugin.Plugin;
