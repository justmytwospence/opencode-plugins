// Subscription windows: what the server half has read from provider responses (Anthropic's
// unified 5h/7d headers, Codex's x-codex-* headers), else Claude Code's shared usage cache
// (`$CLAUDE_STATUSLINE_CACHE_DIR` or `~/.cache/claude-statusline/oauth-usage.json`, written by
// Claude Code's status line and pi-status-footer; read only, never fetched here), and how the
// footer shows them. Readings older than STALE_MS, or past their reset, are dropped.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type Reading, readAnthropicHeaders, readCodexHeaders, windowLabel } from "./limits.ts";
import type { Account, Quota, QuotaWindow } from "./rpc.ts";

export const STALE_MS = 10 * 60_000;

/** The subscription account behind an OpenCode provider id. */
export function accountOf(providerID: string): "Claude" | "Codex" | undefined {
  if (providerID === "anthropic") return "Claude";
  if (["chatgpt", "openai", "openai-codex", "codex"].includes(providerID)) return "Codex";
  return undefined;
}

/** Readings from one response's headers. */
export function readHeaders(account: "Claude" | "Codex", headers: Pick<Headers, "forEach">, now: number): Reading[] {
  const map: Record<string, string> = {};
  headers.forEach((value, name) => {
    map[name] = value;
  });
  return account === "Claude" ? readAnthropicHeaders(map, now) : readCodexHeaders(map, now);
}

export function toWindow(r: Reading): QuotaWindow {
  const label = windowLabel(r);
  return { label: label === "7d" || label === "seven_day" ? "week" : label === "five_hour" ? "5h" : label, used: r.used, at: r.at, ...(r.resetsAt !== undefined ? { resetsAt: r.resetsAt } : {}) };
}

/** Windows still worth showing: fresh and not past their reset. */
export function fresh(windows: readonly QuotaWindow[], now: number): QuotaWindow[] {
  return windows.filter((w) => now - w.at < STALE_MS && (w.resetsAt === undefined || w.resetsAt > now));
}

export function claudeCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_STATUSLINE_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "claude-statusline");
  return path.join(dir, "oauth-usage.json");
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const number = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const time = (v: unknown): number | undefined => {
  if (typeof v === "string" && Number.isNaN(Number(v))) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  const n = number(v);
  return n === undefined ? undefined : n < 1e12 ? n * 1000 : n;
};

/** Claude's OAuth usage JSON (`five_hour`/`seven_day` utilization in percent points). */
export function parseClaudeUsage(raw: unknown, at: number): QuotaWindow[] {
  const data = record(raw);
  const limits = Array.isArray(data.limits) ? data.limits.map(record) : [];
  const out: QuotaWindow[] = [];
  for (const [key, kind, label] of [["five_hour", "session", "5h"], ["seven_day", "weekly_all", "week"]] as const) {
    const flat = record(data[key]);
    const limit = limits.find((l) => l.kind === kind);
    const pct = number(flat.utilization ?? limit?.percent);
    if (pct === undefined) continue;
    const resetsAt = time(flat.resets_at ?? limit?.resets_at);
    out.push({ label, used: pct / 100, at, ...(resetsAt !== undefined ? { resetsAt } : {}) });
  }
  return out;
}

/** Claude Code's cached usage, when the file exists and parses. */
export async function readClaudeCache(file = claudeCacheFile()): Promise<QuotaWindow[]> {
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return parseClaudeUsage(JSON.parse(text), info.mtimeMs);
  } catch {
    return [];
  }
}

/** `42%` with its reset countdown, e.g. `5h 42% 2h13m`. */
export function formatWindow(w: QuotaWindow, now: number): string {
  const pct = `${Math.round(w.used * 100)}%`;
  return [w.label, pct, w.resetsAt !== undefined ? countdown(w.resetsAt - now) : undefined].filter(Boolean).join(" ");
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.round(h / 24)}d`;
}

/** The severity color for a window: warning from 70% used, error from 90%. */
export function severity(used: number): "warning" | "error" | undefined {
  return used >= 0.9 ? "error" : used >= 0.7 ? "warning" : undefined;
}

export function emptyQuota(): Quota {
  return { accounts: [] };
}

export type { Account, Quota, QuotaWindow };
