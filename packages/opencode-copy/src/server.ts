// opencode-copy (server): ranks the /yank picker's candidates with Jev for the terminal half
// (the `rank` RPC). Everything else, from the session's messages to the clipboard, is the
// terminal's; the server half only holds the API key and asks the questions.
import type { Plugin } from "@opencode/plugin";
import { askJev } from "./jev.ts";
import { DEFAULT_RANK, rankQuestions, rankState, readJudgments } from "./rank.ts";
import { CopyRpc, type RankInput, type RankOutput } from "./rpc.ts";
import type { Kind, Segment } from "./segments.ts";

export const NAME = "copy";

export interface RankDeps {
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** One ranking request: Jev's judgment of every piece, keyed by content hash; never throws. */
export async function rank(input: RankInput, deps: RankDeps = {}): Promise<RankOutput> {
  const pieces: Segment[] = input.pieces.map((p, order) => ({ id: p.id, kind: p.kind as Kind, text: p.text, ...(p.lang ? { lang: p.lang } : {}), turn: 0, order }));
  if (!pieces.length) return { ok: true, judged: [] };
  const settings = { ...DEFAULT_RANK, pieceChars: input.pieceChars };
  const outcome = await askJev(rankState(pieces, input.recent, settings), rankQuestions(pieces), {
    model: input.model,
    timeoutMs: input.timeoutMs,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (!outcome.ok) {
    deps.log?.(`${input.sessionID}: ranking unavailable: ${outcome.reason}`);
    return { ok: false, judged: [], reason: outcome.reason };
  }
  const judged = [...readJudgments(pieces, outcome.answers)].map(([key, j]) => ({ key, ...j }));
  deps.log?.(`${input.sessionID}: ranked ${pieces.length} pieces in ${outcome.latencyMs} ms${outcome.inputTokens !== undefined ? ` (${outcome.inputTokens} input tokens)` : ""}`);
  return { ok: true, judged, latencyMs: outcome.latencyMs };
}

export default {
  id: NAME,
  async setup(ctx) {
    await ctx.rpc.register(CopyRpc, {
      rank: (input) => rank(input as RankInput, { log: (message) => console.error(`[copy] ${message}`) }),
    });
  },
} satisfies Plugin.Plugin;
