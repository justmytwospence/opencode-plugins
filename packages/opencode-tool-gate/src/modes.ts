// Permission modes, after Claude Code's: what runs without asking you. The server half keeps one
// per session (subagent sessions follow their parent); the CLI half switches them with
// `/tool-gate mode` or the palette and shows the mode in the prompt footer. Ported from
// pi-tool-gate's modes module without Pi's event bus: OpenCode's plan agent is the native way to
// plan, so plan mode here is a plain mode that denies edits, not a provider another plugin offers.

export const MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof MODES)[number];

/** Status-bar labels, after Claude Code's. */
export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "manual mode on",
  acceptEdits: "accept edits on",
  plan: "plan mode on",
  auto: "auto mode on",
  bypassPermissions: "bypass permissions on",
};

/** Short names for `/tool-gate mode` and descriptions. */
export const MODE_NAMES: Record<PermissionMode, string> = {
  default: "manual",
  acceptEdits: "accept-edits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "bypass",
};

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: "Ask before every edit, write and command that does more than read.",
  acceptEdits: "Edits, writes and filesystem commands inside the project run; other commands ask.",
  plan: "Edits and writes are denied; commands are judged as in auto mode (or use OpenCode's plan agent).",
  auto: "Jev judges each call; you are asked only about risky ones the agent cannot work around.",
  bypassPermissions: "Everything runs, except removing /, home, the project or a parent of them.",
};

/** Accepts config values, Claude Code's names, and the short names. */
export function parseMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_-]/gu, "");
  const aliases: Record<string, PermissionMode> = {
    default: "default",
    manual: "default",
    acceptedits: "acceptEdits",
    edits: "acceptEdits",
    plan: "plan",
    auto: "auto",
    bypass: "bypassPermissions",
    bypasspermissions: "bypassPermissions",
    yolo: "bypassPermissions",
  };
  return aliases[key];
}

/**
 * The modes the cycle steps through, in Claude Code's order (manual, accept edits, plan, then
 * bypass and auto), keeping only those configured.
 */
export function cycleOf(configured: readonly PermissionMode[]): PermissionMode[] {
  return MODES.filter((mode) => configured.includes(mode)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}
const ORDER: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];

/** The next mode in the cycle; a mode outside it goes to the cycle's first. */
export function nextMode(current: PermissionMode, cycle: readonly PermissionMode[]): PermissionMode {
  if (cycle.length === 0) return current;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length] ?? current;
}
