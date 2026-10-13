// opencode-context (server): remembers, per session, how the last primary model request was
// made up (the session's `context` hook: system parts, tool declarations, messages), as token
// estimates and previews per part, and serves it to the terminals over the context RPC. One
// shared server runs for every terminal, so everything is keyed by session id.
import type { Plugin } from "@opencode/plugin";
import { type RequestLike, type Snapshot, collectBreakdown, formatTokens } from "./breakdown.ts";
import { ContextRpc } from "./rpc.ts";

export const NAME = "context";

/** The parts of the `context` hook's event the server reads. */
export interface ContextEvent extends RequestLike {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
}

/** Snapshots by session, with a cap so a long-running server does not grow without bound. */
export class SnapshotBook {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly limit = 200) {}

  /** Records one request; returns the snapshot. */
  observe(event: ContextEvent, now: number): Snapshot {
    const snapshot: Snapshot = {
      parts: collectBreakdown(event),
      at: now,
      model: { providerID: event.model.providerID, id: event.model.id },
      agent: event.agent,
      messages: event.messages.length,
    };
    this.snapshots.delete(event.sessionID);
    this.snapshots.set(event.sessionID, snapshot);
    while (this.snapshots.size > this.limit) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  get(sessionID: string): Snapshot | undefined {
    return this.snapshots.get(sessionID);
  }

  forget(sessionID: string): void {
    this.snapshots.delete(sessionID);
  }
}

export default {
  id: NAME,
  async setup(ctx) {
    const book = new SnapshotBook();
    const rpc = await ctx.rpc.register(ContextRpc, {
      breakdown: async (input) => {
        const { sessionID } = input as { sessionID: string };
        const snapshot = book.get(sessionID);
        return snapshot ? { snapshot } : {};
      },
    });
    // Only the agent loop's requests count: compaction, title and generate have their own hooks.
    await ctx.session.hook("context", (event) => {
      const snapshot = book.observe(event as unknown as ContextEvent, Date.now());
      console.error(`[context] ${event.sessionID}: ${snapshot.parts.map((p) => `${p.key} ${formatTokens(p.tokens)}`).join(", ")}`);
      void rpc.events.emit("updated", { sessionID: event.sessionID }).catch(() => undefined);
    });

    const stop = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          if ((event as { type?: string }).type !== "session.deleted") continue;
          const data = (event as { data?: { sessionID?: string; info?: { id?: string } } }).data;
          const sessionID = data?.sessionID ?? data?.info?.id;
          if (sessionID) book.forget(sessionID);
        }
      } catch {
        // The stream ends with the plugin.
      }
    })();
    return () => stop.abort();
  },
} satisfies Plugin.Plugin;
