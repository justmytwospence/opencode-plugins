// What the terminal shows for a session's cache state, from a snapshot: the footer's `cache 4:12`,
// why the next request misses, and the herdr `cache` token. Free of UI imports so tests can use it.
import { type ColdReason, type Settings, describeMiss, formatClock, formatCost, formatDuration, formatTokens, herdrCacheValue, missCost, worthWarning } from "./core.ts";
import { ANTHROPIC_TTL_MS, type ModelRef, type Snapshot, sameModel } from "./clock.ts";

export interface View {
  /** "4:12" while warm. */
  left?: string;
  /** "cold" once the next request misses; "cold?" when no TTL is known and the idle limit passed. */
  cold?: string;
}

/** What the footer shows for a session's state at `now`; undefined shows nothing. */
export function view(snapshot: Snapshot | undefined, now: number, settings: Settings): View | undefined {
  if (!snapshot || !snapshot.lastAt || !snapshot.tokens) return undefined;
  const idleMs = Math.max(0, now - snapshot.lastAt);
  if (snapshot.ttlMs === undefined) {
    return idleMs >= settings.warn.idleMinutes * 60_000 ? { cold: "cold?" } : undefined;
  }
  const left = snapshot.lastAt + snapshot.ttlMs - now;
  return left > 0 ? { left: formatClock(left) } : { cold: "cold" };
}

/**
 * Why the session's next request misses, if it does: the cache expired, the selected model
 * (`model`, when known) is not the one the conversation was cached for, or (providers without a
 * TTL) the session has been idle past the warning threshold.
 */
export function coldReason(snapshot: Snapshot | undefined, model: ModelRef | undefined, now: number, settings: Settings): ColdReason | undefined {
  if (!snapshot || !snapshot.lastAt || !snapshot.tokens) return undefined;
  if (model && snapshot.model && !sameModel(model, snapshot.model)) return { kind: "model", from: snapshot.model.modelID, to: model.modelID };
  const idleMs = Math.max(0, now - snapshot.lastAt);
  if (snapshot.ttlMs !== undefined) return idleMs > snapshot.ttlMs ? { kind: "expired", idleMs: idleMs - snapshot.ttlMs } : undefined;
  return idleMs >= settings.warn.idleMinutes * 60_000 ? { kind: "idle", idleMs } : undefined;
}

/** What the miss costs over a hit, in dollars at list prices, when the model's prices are known. */
export function coldCost(snapshot: Snapshot): number | undefined {
  return snapshot.price ? missCost(snapshot.tokens, snapshot.price, snapshot.ttlMs ?? ANTHROPIC_TTL_MS) : undefined;
}

/** The herdr `cache` token for the session on screen: "cold 664k" while doomed, else undefined. */
export function herdrValue(snapshot: Snapshot | undefined, now: number, settings: Settings): string | undefined {
  const reason = coldReason(snapshot, undefined, now, settings);
  if (!reason || !snapshot) return undefined;
  return herdrCacheValue(reason, snapshot.tokens, coldCost(snapshot), settings);
}

/** What `cache-guard: status` needs to know besides the snapshot. */
export interface StatusInput {
  snapshot: Snapshot | undefined;
  /** The prompt's selected model, to notice a switch. */
  model: ModelRef | undefined;
  now: number;
  settings: Settings;
  /** This terminal turned the session off (`cache-guard: off`). */
  off: boolean;
  /** "Send, and stop asking" was chosen in this session. */
  muted: boolean;
  /** The server's view of Jev: ready (with its label), missing (the reason) or off. */
  jev: { kind: "ready" | "missing" | "off"; label?: string; reason?: string } | undefined;
}

/** The warning's state, naming what turned it off (Pi's `/cache-guard status`). */
export function warningLine(input: Pick<StatusInput, "settings" | "off" | "muted">): string {
  const { settings } = input;
  if (!settings.enabled) return 'off ("enabled": false in settings)';
  if (!settings.warn.enabled) return 'off ("warn.enabled": false in settings)';
  if (input.off) return "off for this session (cache-guard: on turns it back on)";
  if (input.muted) return 'muted for this session after "Send, and stop asking" (cache-guard: on turns it back on)';
  return `on, from ${formatCost(settings.warn.minCost)} or ${formatTokens(settings.warn.minTokens)} tokens re-cached (warn.minCost, warn.minTokens)`;
}

/** The lines of `cache-guard: status`: the last request, the TTL, warm or cold, the warning, Jev. */
export function statusLines(input: StatusInput): string[] {
  const { snapshot, settings, now } = input;
  const lines: string[] = [];
  if (!snapshot || !snapshot.lastAt || !snapshot.tokens) {
    lines.push("No cached request in this session yet (or the context was just compacted).");
  } else {
    const model = snapshot.model ? `${snapshot.model.providerID}/${snapshot.model.modelID}` : "unknown model";
    lines.push(`Last request: ${model}, ${formatTokens(snapshot.tokens)} tokens, ${formatDuration(now - snapshot.lastAt)} ago.`);
    lines.push(snapshot.ttlMs === undefined ? `TTL: not published for ${model}; warning after ${settings.warn.idleMinutes}m idle.` : `TTL: ${formatDuration(snapshot.ttlMs)}.`);
    const v = view(snapshot, now, settings);
    if (v?.left) lines.push(`Warm: ${v.left} left.`);
    const reason = coldReason(snapshot, input.model, now, settings);
    if (reason) {
      const cost = coldCost(snapshot);
      lines.push(describeMiss(reason, snapshot.tokens, cost));
      const on = settings.enabled && settings.warn.enabled && !input.off && !input.muted;
      if (!on) lines.push("The next prompt is sent without asking: the warning is off.");
      else if (!worthWarning(snapshot.tokens, cost, settings)) lines.push("Below the warning threshold.");
      else lines.push("The next prompt asks before sending.");
    }
  }
  lines.push(`Warning: ${warningLine(input)}. Keep-warm: OpenCode's "warming" setting.`);
  const jev = input.jev;
  if (!jev || jev.kind === "off") lines.push("Jev: off (cache-guard: Jev turns it on).");
  else if (jev.kind === "missing") lines.push(`Jev: not set up (${jev.reason}); cache-guard: Jev.`);
  else {
    const trim = settings.trim.enabled ? "trimming on" : "trimming off";
    lines.push(`Jev: ${jev.label}; ${trim}; Jev compaction from the cold-cache menu and cache-guard: compact${settings.compact.filter ? "; it marks what /compact must keep too" : ""}.`);
  }
  return lines;
}

/** The part of a session message the restore reads. */
export interface AssistantLike {
  type: string;
  time?: { created?: number; completed?: number };
  model?: { providerID: string; id?: string; modelID?: string };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/**
 * A session's cache state from its stored messages (a resumed session the server has not seen a
 * request for): the clock from the last assistant message's start, its size from that message's
 * usage. Messages before the last completed compaction do not count. Undefined without one.
 */
export function fromMessages(sessionID: string, messages: readonly AssistantLike[], ttl: (model: ModelRef) => number | undefined, price: (model: ModelRef) => Snapshot["price"], now = Date.now()): Snapshot | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type === "compaction" && (message as { status?: string }).status !== "failed") return undefined;
    if (message.type !== "assistant" || !message.tokens || !message.model) continue;
    const t = message.tokens;
    const tokens = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0);
    const at = message.time?.created ?? 0;
    if (tokens <= 0 || !at) continue;
    const model: ModelRef = { providerID: message.model.providerID, modelID: message.model.modelID ?? message.model.id ?? "" };
    return { sessionID, lastAt: at, tokens, model, ttlMs: ttl(model), price: price(model), updatedAt: now };
  }
  return undefined;
}
