// The level policy, ported unchanged from pi-auto-effort: a running average of Jev"s depth
// scores, a margin before moving, a jump rule for clearly harder work, a minimum dwell before
// going down, and a go-ahead ("yes", "continue") that keeps the level.

/** Effort levels auto-effort moves between, lowest first; the index is the depth score. */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type Level = (typeof LEVELS)[number]

export interface Policy {
  /** Lowest level auto-effort sets. */
  floor: Level
  /** Weight of the newest score in the running average (1 = no smoothing). */
  alpha: number
  /** The average must differ from the current level by this much to move. */
  margin: number
  /** A single score this far above the current level jumps straight to it... */
  jump: number
  /** ...when Jev is at least this confident. */
  jumpConfidence: number
  /** Messages a level must hold before it can go down. */
  minDwell: number
  /** A go-ahead message above this probability keeps the level. */
  ackThreshold: number
}

export const DEFAULT_POLICY: Policy = {
  floor: "low",
  alpha: 0.5,
  margin: 0.6,
  jump: 1.5,
  jumpConfidence: 0.6,
  minDwell: 2,
  ackThreshold: 0.7,
}

export interface EffortState {
  /** Running average of depth scores; undefined before the first judgment. */
  e?: number
  /** Messages since the level last changed. */
  dwell: number
}

export interface Judgment {
  /** Depth score 0-3. */
  score: number
  confidence: number
  /** Probability the message is a go-ahead relying on the earlier plan. */
  ack: number
}

export interface Decision {
  level: string
  state: EffortState
  reason: "ack" | "jump" | "up" | "down" | "hold" | "unavailable"
}

export function levelIndex(level: string): number {
  return LEVELS.indexOf(level as Level)
}

/**
 * The next level for a message. `current` is the level auto-effort set last (or the ceiling
 * before the first message); `ceiling` is the session"s own effort setting. Levels outside the
 * managed range, or a ceiling below the floor, are left alone.
 */
export function decide(
  current: string,
  ceilingLevel: string,
  state: EffortState,
  judgment: Judgment | undefined,
  policy: Policy,
): Decision {
  const floor = levelIndex(policy.floor)
  const ceiling = levelIndex(ceilingLevel)
  const c = Math.min(levelIndex(current), ceiling)
  if (c < 0 || ceiling < 0 || ceiling < floor) {
    return { level: ceilingLevel, state: { ...state, dwell: state.dwell + 1 }, reason: "hold" }
  }
  const held = LEVELS[c] as string
  if (!judgment) return { level: held, state: { ...state, dwell: state.dwell + 1 }, reason: "unavailable" }
  const s = judgment.score
  const e = state.e === undefined ? s : policy.alpha * s + (1 - policy.alpha) * state.e
  let target = c
  let reason: Decision["reason"] = "hold"
  if (judgment.ack > policy.ackThreshold) reason = "ack"
  else if (s - c >= policy.jump && judgment.confidence >= policy.jumpConfidence) {
    target = Math.round(s)
    reason = "jump"
  } else if (e - c >= policy.margin) {
    target = Math.round(e)
    reason = "up"
  } else if (c - e >= policy.margin && state.dwell >= policy.minDwell) {
    target = Math.round(e)
    reason = "down"
  }
  target = Math.min(Math.max(target, floor), ceiling)
  if (target === c) return { level: held, state: { e, dwell: state.dwell + 1 }, reason: reason === "ack" ? "ack" : "hold" }
  return { level: LEVELS[target] as string, state: { e, dwell: 0 }, reason }
}
