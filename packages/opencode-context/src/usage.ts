// The usage OpenCode itself reports, read from the session's messages the way its sidebar does,
// and the bar geometry; pure, so tests cover them without a terminal.

export type MessageLike = {
  type: string;
  status?: string;
  model?: { providerID: string; id: string };
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
};

/**
 * The context tokens OpenCode shows for a session: the last assistant response since the last
 * completed compaction, input + output + reasoning + cache read + cache write.
 */
export function reportedUsage(messages: readonly MessageLike[]): { tokens: number; model?: { providerID: string; id: string } } | undefined {
  let start = -1;
  messages.forEach((m, i) => {
    if (m.type === "compaction" && m.status === "completed") start = i;
  });
  for (let i = messages.length - 1; i > start; i--) {
    const m = messages[i];
    if (m?.type !== "assistant" || !m.tokens) continue;
    const t = m.tokens;
    const total = t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    if (total > 0) return { tokens: total, ...(m.model ? { model: m.model } : {}) };
  }
  return undefined;
}

/** `n` cells of a bar of `width`, one entry per row, the last row taking what is left. */
export function barCells(rows: readonly { tokens: number }[], total: number, width: number): number[] {
  let remaining = width;
  return rows.map((row, index) => {
    const cells = index === rows.length - 1 ? remaining : Math.min(remaining, Math.round((row.tokens / Math.max(1, total)) * width));
    remaining -= cells;
    return Math.max(0, cells);
  });
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
