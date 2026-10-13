// Subscription limits for OpenCode. The session's `http.response` hook hands the plugin every
// provider response; this reads the rate-limit headers of Anthropic's unified 5h/7d windows
// (api.anthropic.com) and Codex's `x-codex-*` (chatgpt.com). It reads response headers only, never
// bodies or request headers, and keeps the readings in memory.
import { Tracker, readAnthropicHeaders, readCodexHeaders } from "./limits.ts";

/** The tracker key for an OpenCode provider id: `anthropic`, `codex`, or undefined (no limits). */
export function trackerKey(providerID: string): string | undefined {
  if (providerID === "anthropic") return "anthropic";
  if (["chatgpt", "openai", "openai-codex", "codex"].includes(providerID)) return "codex";
  return undefined;
}

/** Records the rate-limit headers of one provider response. Never throws. */
export function observe(trackers: Map<string, Tracker>, url: string, response: Pick<Response, "headers">, now: number): void {
  try {
    const host = new URL(url).hostname;
    const key = host === "api.anthropic.com" ? "anthropic" : host === "chatgpt.com" ? "codex" : undefined;
    if (!key) return;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const readings = key === "anthropic" ? readAnthropicHeaders(headers, now) : readCodexHeaders(headers, now);
    if (!readings.length) return;
    let tracker = trackers.get(key);
    if (!tracker) trackers.set(key, (tracker = new Tracker()));
    for (const r of readings) tracker.record(r);
  } catch {
    // Observation must never break a request.
  }
}
