// Per-session cache state: when the prompt cache was last written or read, how many tokens the
// next request re-sends, the model it was cached for, its TTL and prices. The server half fills
// it from the session's requests and responses; the terminal half reads it over RPC (and derives
// the same shape from the session's messages when the server has none, after a restart).
import { type Price, claudePrice } from "./core.ts";

export const ANTHROPIC_TTL_MS = 5 * 60_000;

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Everything the terminal needs about a session's cache; also the RPC `state` shape. */
export interface Snapshot {
  sessionID: string;
  /** When the cache entry was last read or written: the start of the last model request. 0: none. */
  lastAt: number;
  /** The provider's cache lifetime; absent for providers that publish none. */
  ttlMs?: number;
  /** Prompt tokens the next request re-sends (the last request's prompt and reply). */
  tokens: number;
  model?: ModelRef;
  /** The model's prices per million tokens, so the terminal can price a miss. */
  price?: Price;
  /** What the last Anthropic response said the cache did. */
  lastCache?: { read: number; write: number; prompt: number };
  updatedAt: number;
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
}

export function ttlOf(model: ModelRef, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (model.providerID !== "anthropic") return undefined;
  // For testing: a short TTL makes a session go cold in seconds.
  const override = Number(env.OPENCODE_CACHE_GUARD_TTL_MS);
  return Number.isFinite(override) && override > 0 ? override : ANTHROPIC_TTL_MS;
}

/** One entry of a model's `cost` list, as OpenCode's catalog has it. */
export interface CostLike {
  input?: number;
  cache?: { read?: number; write?: number };
}

/**
 * The model's prices per million tokens from OpenCode's catalog; Anthropic list prices when the
 * catalog has none or zeroed them (a subscription, whose usage still scales the same way).
 */
export function priceOf(model: ModelRef, cost?: CostLike): Price | undefined {
  if (cost && (cost.input ?? 0) > 0) {
    return { input: cost.input!, cacheRead: cost.cache?.read ?? 0, cacheWrite: (cost.cache?.write ?? 0) > 0 ? cost.cache!.write : undefined };
  }
  return model.providerID === "anthropic" ? claudePrice(model.modelID) : undefined;
}

/** The sessions' cache state, with one `onChange` per change (the server emits it to the terminals). */
export class Clock {
  readonly sessions = new Map<string, Snapshot>();

  constructor(private readonly deps: { now?: () => number; onChange?: (snapshot: Snapshot) => void } = {}) {}

  get(sessionID: string): Snapshot {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = { sessionID, lastAt: 0, tokens: 0, updatedAt: this.now() };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  /** The model and price the session's next request uses. */
  setModel(sessionID: string, model: ModelRef, price: Price | undefined, ttlMs: number | undefined): void {
    const state = this.get(sessionID);
    if (sameModel(state.model, model) && state.ttlMs === ttlMs && JSON.stringify(state.price) === JSON.stringify(price)) return;
    state.model = model;
    state.price = price;
    state.ttlMs = ttlMs;
    this.changed(state);
  }

  /** A model request started for the session at `at`: the cache clock restarts. */
  requestStarted(sessionID: string, at: number): void {
    const state = this.get(sessionID);
    if (at <= state.lastAt) return;
    state.lastAt = at;
    this.changed(state);
  }

  /** A request's usage: the prompt and reply size the next request re-sends. */
  recordTokens(sessionID: string, tokens: number, model?: ModelRef): void {
    const state = this.get(sessionID);
    let changed = false;
    if (tokens > 0 && tokens !== state.tokens) {
      state.tokens = tokens;
      changed = true;
    }
    if (model && !sameModel(model, state.model)) {
      state.model = model;
      changed = true;
    }
    if (changed) this.changed(state);
  }

  /** What an Anthropic response said: how much of the prompt the cache served, and what it wrote. */
  recordCache(sessionID: string, usage: { read: number; write: number; prompt: number }): void {
    const state = this.get(sessionID);
    state.lastCache = usage;
    if (usage.prompt > 0 && !state.tokens) state.tokens = usage.prompt;
    this.changed(state);
  }

  /** The context was replaced (compaction): there is no cache to keep. */
  reset(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (!state) return;
    state.lastAt = 0;
    state.tokens = 0;
    state.lastCache = undefined;
    this.changed(state);
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  private changed(state: Snapshot): void {
    state.updatedAt = this.now();
    this.deps.onChange?.({ ...state });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
