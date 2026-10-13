// opencode-status-footer (server): reads the Claude and Codex subscription windows from the
// rate-limit headers of every `anthropic` and `chatgpt`/`openai` provider response (the session's `http.response` hook; headers
// only, never bodies) and serves them to the terminals over the status-footer RPC, falling back
// to Claude Code's shared usage cache for Claude when no response has said anything yet.
import type { Plugin } from "@opencode/plugin";
import { type Account, type Quota, type QuotaWindow, accountOf, fresh, readClaudeCache, readHeaders, toWindow } from "./quota.ts";
import { StatusFooterRpc } from "./rpc.ts";

export const NAME = "status-footer";

/** The windows seen in responses, per account. */
export class QuotaBook {
  private readonly seen = new Map<"Claude" | "Codex", QuotaWindow[]>();

  /** Records one response; true when it changed what is known. */
  observe(providerID: string, headers: Pick<Headers, "forEach">, now: number): boolean {
    const account = accountOf(providerID);
    if (!account) return false;
    const readings = readHeaders(account, headers, now);
    if (!readings.length) return false;
    const windows = readings.map(toWindow);
    const before = JSON.stringify(this.seen.get(account)?.map(({ at: _at, ...w }) => w));
    this.seen.set(account, windows);
    return JSON.stringify(windows.map(({ at: _at, ...w }) => w)) !== before;
  }

  async quota(now: number, claudeCache: () => Promise<QuotaWindow[]> = () => readClaudeCache()): Promise<Quota> {
    const accounts: Account[] = [];
    const claude = fresh(this.seen.get("Claude") ?? [], now);
    if (claude.length) accounts.push({ name: "Claude", source: "responses", windows: claude });
    else {
      const cached = fresh(await claudeCache(), now);
      if (cached.length) accounts.push({ name: "Claude", source: "Claude Code", windows: cached });
    }
    const codex = fresh(this.seen.get("Codex") ?? [], now);
    if (codex.length) accounts.push({ name: "Codex", source: "responses", windows: codex });
    return { accounts };
  }
}

export default {
  id: NAME,
  async setup(ctx) {
    const book = new QuotaBook();
    const rpc = await ctx.rpc.register(StatusFooterRpc, {
      quota: async () => book.quota(Date.now()),
    });
    await ctx.session.hook("http.response", (event) => {
      if (book.observe(event.model.providerID, event.response.headers, Date.now())) {
        void book
          .quota(Date.now())
          .then((quota) => rpc.events.emit("quota", quota))
          .catch(() => undefined);
      }
    });
  },
} satisfies Plugin.Plugin;
