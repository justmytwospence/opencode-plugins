// What a review compares, without OpenCode: the scope words `/diff-review` accepts, and the range of
// turns a session scope asks OpenCode's `session.diff` for. OpenCode snapshots the working tree
// around every turn (the messages between one idle marker and the next), so a scope over turns
// is a pair of user messages: the one whose turn starts the range and the one whose turn ends
// it. The review mark is the user message whose turn you last reviewed through.

export type ScopeKind = "unreviewed" | "turn" | "session" | "head" | "branch";

export interface ScopeRequest {
  kind: ScopeKind;
  /** For "turn": 1 is the latest run, 2 the one before, and so on. */
  turn?: number;
}

/** The review mark: the user message whose turn was reviewed through, and when. */
export interface Mark {
  through: string;
  at: number;
}

/** A user message that started (or joined) a turn. */
export interface UserMessage {
  id: string;
  text: string;
  created: number;
}

/** A session scope resolved to `session.diff` parameters. */
export interface TurnRange {
  kind: "turns";
  from: string;
  /** Omitted for one turn. */
  to?: string;
  label: string;
}

/** A repository scope resolved to `vcs.diff` parameters. */
export interface VcsRange {
  kind: "vcs";
  mode: "working" | "branch";
  label: string;
}

export type Range = TurnRange | VcsRange;

export const SCOPES: readonly { value: ScopeKind; title: string; description: string }[] = [
  { value: "unreviewed", title: "unreviewed", description: "every turn since your last review mark (default)" },
  { value: "turn", title: "last turn", description: "the last agent run; `turn 2` is the one before" },
  { value: "session", title: "session", description: "every turn of this session" },
  { value: "head", title: "uncommitted", description: "the working tree vs HEAD" },
  { value: "branch", title: "branch", description: "the working tree vs the base branch" },
];

export function parseScopeArgs(args: string): ScopeRequest | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const [w, arg] = words;
  switch (w) {
    case "unreviewed":
    case "new":
      return { kind: "unreviewed" };
    case "turn":
    case "last":
      return { kind: "turn", turn: arg ? Math.max(1, Number.parseInt(arg, 10) || 1) : 1 };
    case "session":
    case "all":
      return { kind: "session" };
    case "head":
    case "uncommitted":
    case "working":
      return { kind: "head" };
    case "branch":
      return { kind: "branch" };
    default:
      return undefined;
  }
}

export function shortPrompt(p: string, max = 48): string {
  const one = p.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The scope `/diff-review` opens with: everything unreviewed when the session has turns, else uncommitted changes. */
export function defaultScope(users: readonly UserMessage[]): ScopeRequest {
  return users.length > 0 ? { kind: "unreviewed" } : { kind: "head" };
}

/**
 * The range a scope asks for, given the session's user messages (oldest first) and the review
 * mark; a string says why there is none.
 */
export function resolveRange(req: ScopeRequest, users: readonly UserMessage[], mark: Mark | undefined, now = Date.now()): Range | string {
  const last = users[users.length - 1];
  switch (req.kind) {
    case "head":
      return { kind: "vcs", mode: "working", label: "uncommitted vs HEAD" };
    case "branch":
      return { kind: "vcs", mode: "branch", label: "working tree vs the base branch" };
    case "session":
      if (!users.length || !last) return "no turns in this session yet";
      return { kind: "turns", from: (users[0] as UserMessage).id, to: last.id, label: "everything this session changed" };
    case "turn": {
      if (!users.length) return "no turns in this session yet";
      const n = Math.min(Math.max(1, req.turn ?? 1), users.length);
      const u = users[users.length - n] as UserMessage;
      const which = n === 1 ? "last turn" : `turn -${n}`;
      return { kind: "turns", from: u.id, label: `${which}: ${shortPrompt(u.text)}` };
    }
    case "unreviewed": {
      if (!users.length || !last) return "no turns in this session yet";
      const marked = mark ? users.findIndex((u) => u.id === mark.through) : -1;
      const first = users[marked + 1];
      if (!first) return "nothing unreviewed since your last review mark";
      const since = marked >= 0 && mark ? `since your review ${relativeTime(mark.at, now)}` : "since the session began";
      const n = users.length - marked - 1;
      return { kind: "turns", from: first.id, to: last.id, label: `unreviewed, ${since} (${n} turn${n === 1 ? "" : "s"})` };
    }
  }
}
