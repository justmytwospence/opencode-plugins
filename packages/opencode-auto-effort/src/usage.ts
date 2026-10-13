// Subscription limits for opencode. The plugin API has no response hook, so a `globalThis.fetch`
// wrapper (installed once per process, over any wrapper already there) reads the rate-limit
// headers of each provider response: Anthropic's unified 5h/7d headers on api.anthropic.com and
// Codex's `x-codex-*` on chatgpt.com. It reads response headers only, never bodies or request
// headers, and keeps the readings in memory.
import { Tracker, readAnthropicHeaders, readCodexHeaders } from "./limits.ts";

type FetchFn = typeof globalThis.fetch;

interface Installed {
  original: FetchFn;
  wrapped: FetchFn;
  trackers: Map<string, Tracker>;
  /** Plugin instances using the wrapper; the last to dispose restores fetch. */
  users: number;
  now: () => number;
  /** False once disposed under another wrapper: forward only. */
  active: boolean;
}

const KEY = Symbol.for("auto-effort:usage");
type Global = typeof globalThis & { [KEY]?: Installed };

/** The tracker key for an opencode provider id: `anthropic`, `codex`, or undefined (no limits). */
export function trackerKey(providerID: string): string | undefined {
  if (providerID === "anthropic") return "anthropic";
  if (providerID === "openai" || providerID === "openai-codex" || providerID === "codex") return "codex";
  return undefined;
}

/** Records the rate-limit headers of a response to `url` into `trackers`. Never throws. */
export function observe(trackers: Map<string, Tracker>, url: string, response: Response, now: number): void {
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

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Wraps `globalThis.fetch` once per process; returns the shared trackers. */
export function install(now: () => number = Date.now): Map<string, Tracker> {
  const g = globalThis as Global;
  const existing = g[KEY];
  if (existing) {
    existing.users++;
    return existing.trackers;
  }
  const original = globalThis.fetch;
  const trackers = new Map<string, Tracker>();
  const state: Installed = { original, trackers, users: 1, now, active: true, wrapped: undefined as unknown as FetchFn };
  state.wrapped = async (input, init) => {
    const response = await state.original(input, init);
    if (state.active) observe(trackers, urlOf(input), response, state.now());
    return response;
  };
  globalThis.fetch = state.wrapped;
  g[KEY] = state;
  return trackers;
}

/** Drops one user; the last restores the fetch it wrapped when the wrapper is still on top. */
export function uninstall(): void {
  const g = globalThis as Global;
  const state = g[KEY];
  if (!state) return;
  state.users--;
  if (state.users > 0) return;
  if (globalThis.fetch === state.wrapped) globalThis.fetch = state.original;
  else {
    // Another wrapper sits on top and calls ours: keep forwarding, stop recording.
    state.active = false;
    state.trackers.clear();
  }
  delete g[KEY];
}
