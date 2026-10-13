// The gate, OpenCode-free: the decisions behind the server half's hooks, so tests can drive them
// with fakes. Fixed rules settle the clear cases (read-only calls run, a short list of dangerous
// ones is always held); Jev judges the gray zone. A held call is first denied with Jev's
// explanation and suggested workaround (the denial reason is what the agent reads); the agent
// works around it or makes its case and retries, and only that retry, or another held call of
// the same family in the same user turn, is put to you through OpenCode's own permission prompt,
// with the agent's case. Project rules in `.agents/tool-gate-rules.md` and
// `.opencode/tool-gate-rules.md` are checked on every judged call. Without Jev, judged calls fall
// through to OpenCode's own permission rules.
//
// That is auto mode, one of Claude Code's permission modes the gate keeps per session (see
// modes.ts): manual asks about everything that does more than read, accept edits also runs edits
// and filesystem commands inside the project, plan denies edits, and bypass runs everything but
// critical removals.
import path from "node:path";
import {
  alwaysAskBash,
  alwaysAskPath,
  bashKeys,
  expandHome,
  isAcceptEditsBash,
  isCredentialPath,
  isReadOnlyBash,
  secretGitAdds,
} from "./bash.ts";
import { askJev } from "./jev.ts";
import {
  DEFAULT_THRESHOLDS,
  type Thresholds,
  WORKAROUNDS,
  judgeQuestions,
  judgeState,
  steerReason,
  suggestions,
  verdict,
  workaroundQuestion,
} from "./judge.ts";
import { MODE_NAMES, type PermissionMode, cycleOf, nextMode, parseMode } from "./modes.ts";
import { loadRules } from "./rules.ts";
import type { ChangedEvent, Counts, NoticeEvent, Status } from "./rpc.ts";
import { deepMerge, loadSettings } from "./settings.ts";
import { type MessageLike, agentBeforeLatestUser, callerText, clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";

/** The plugin's name: its settings files are `<dir>/tool-gate.json`. */
export const NAME = "tool-gate";

export interface Options {
  enabled: boolean;
  jev: { model: string; timeoutMs: number };
  thresholds: Thresholds;
  /** Tools that never need a decision (they change nothing, or gate their own nested calls). */
  allowTools: string[];
  /** Extra programs treated as read-only in shell commands. */
  readOnlyCommands: string[];
  /** Deny a held call once with a reason for the agent before asking you; a retry asks you. */
  pushBack: boolean;
  /** The mode a new session starts in: manual, accept-edits, plan, auto or bypass. */
  defaultMode: string;
  /** The modes `cycleMode` steps through. */
  modes: string[];
  /** Show a toast when the mode changes or Jev becomes unavailable. */
  toast: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  jev: { model: "jev-latest", timeoutMs: 3_000 },
  thresholds: DEFAULT_THRESHOLDS,
  allowTools: [
    "subagent", "question", "skill", "websearch", "webfetch", "todowrite", "todoread", "codesearch",
    "opencode_models", "opencode_list_mcp_resources", "opencode_read_mcp_resource", "opencode_session_rename", "opencode_session_move",
  ],
  readOnlyCommands: [],
  pushBack: true,
  defaultMode: "auto",
  modes: ["default", "acceptEdits", "auto"],
  toast: true,
};

/** Built-in tools and permission actions that only read; `read` is still checked for credential files. */
const BUILTIN_READ = new Set(["read", "glob", "grep", "list", "lsp"]);
/** Tools whose `command` is a shell command. */
const SHELL_TOOLS = new Set(["shell", "bash"]);
/** Tools that edit files, all under OpenCode's `edit` permission action. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

export const DECLINED = "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed.";

export type Effect = "allow" | "ask" | "deny";

/** The parts of the `evaluate` permission event the gate reads and writes. */
export interface Evaluation {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string };
  effect: Effect;
  message?: string;
}

/** What the gate needs from OpenCode, so tests can fake it. */
export interface Host {
  /** The session's transcript, for Jev and the agent's case. */
  context(sessionID: string): Promise<readonly MessageLike[]>;
  /** The parent of a session, when it is a subagent's. */
  parent(sessionID: string): Promise<string | undefined>;
  /** The mode a session was last in, across restarts. */
  loadMode(sessionID: string): Promise<string | undefined>;
  saveMode(sessionID: string, mode: string): Promise<void>;
  changed(event: ChangedEvent): void;
  notify(event: NoticeEvent): void;
  log(level: "info" | "warn", message: string, extra?: Record<string, unknown>): void;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
}

export interface Deps {
  fetch?: typeof fetch;
  git?: (cwd: string) => Promise<GitInfo | undefined>;
  /** Which of these paths git ignores, asked in the directory each `git add` runs in. */
  gitIgnored?: (byDir: Map<string, string[]>) => Promise<Set<string>>;
}

type Args = Record<string, unknown>;

type Plan =
  | { kind: "allow"; why: string }
  | { kind: "ask"; reasons: string[]; key: string; args: string }
  | { kind: "judge"; args: string; key: string; similar: Similar };

/** What "allow similar for this session" (the prompt's "always") grants: every key, described. */
interface Similar {
  keys: string[];
  label: string;
}

interface Held {
  tool: string;
  /** The exact call: tool and normalized args. */
  exact: string;
  /** Same program and subcommand, or same directory: one push-back per family per user turn. */
  family: string;
  similar?: Similar;
}

interface Call {
  tool: string;
  input: Args;
}

interface SessionState {
  counts: Counts;
  /** Tool calls seen by `execute.before`, by call id, so the evaluation knows the full arguments. */
  calls: Map<string, Call>;
  /** Exact calls and families pushed back this user turn. */
  pushedBack: Set<string>;
  /** Calls put to the user, by call id, until OpenCode reports the prompt and its answer. */
  holds: Map<string, Held>;
  /** Permission requests OpenCode published for held calls. */
  requests: Map<string, Held>;
  /** Exact calls the user declined this turn. */
  denied: Set<string>;
  /** "Allow similar" grants for the session. */
  allowSimilar: Set<string>;
  git: Map<string, Promise<GitInfo | undefined>>;
  warnedUnavailable: boolean;
}

/** The plugin options from opencode.jsonc over the defaults: that layer alone, without the shared files. */
export function resolveOptions(raw: Record<string, unknown> | undefined): Options {
  return deepMerge(DEFAULT_OPTIONS, raw);
}

/**
 * The options in force now: defaults, `~/.config/agents/tool-gate.json`, the plugin options,
 * `<directory>/.agents/tool-gate.json`, then `<directory>/.opencode/tool-gate.json`.
 */
export function currentOptions(raw: Record<string, unknown> | undefined, directory: string): Options {
  return loadSettings(NAME, DEFAULT_OPTIONS, raw, directory);
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The file an edit or write touches (OpenCode's `path`; `filePath` is accepted too). */
const fileOf = (args: Args) => str(args.path) || str(args.filePath);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Args)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Args)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The exact call, for refusals and retries: shell by command and directory, others by args. */
export function exactKey(tool: string, args: Args): string {
  if (SHELL_TOOLS.has(tool)) return `shell\0${str(args.workdir)}\0${str(args.command).trim()}`;
  return `${tool}\0${stableJson(args)}`;
}

/** The files a patch (`*** Add|Update|Delete File: path`) touches, in order. */
export function patchFiles(patchText: string): string[] {
  const files: string[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gmu)) files.push(match[1] as string);
  return [...new Set(files)];
}

/** The files an `edit` evaluation names: OpenCode's metadata, the resources, or the arguments. */
function editFiles(event: Evaluation, args: Args): string[] {
  const meta = event.metadata as { files?: { file?: string }[] } | undefined;
  const fromMeta = (meta?.files ?? []).map((f) => str(f.file)).filter(Boolean);
  if (fromMeta.length) return [...new Set(fromMeta)];
  if (event.resources.length) return [...new Set(event.resources)];
  const file = fileOf(args);
  if (file) return [file];
  return patchFiles(str(args.patchText));
}

export function describeCall(tool: string, args: Args, files: readonly string[] = []): string {
  if (SHELL_TOOLS.has(tool)) return `${tool}: ${clip(str(args.command).trim(), 200)}`;
  if (files.length) return `${tool}: ${clip(files.join(", "), 200)}`;
  const file = fileOf(args);
  if (file) return `${tool}: ${file}`;
  return `${tool}: ${clip(JSON.stringify(args), 200)}`;
}

/** The hooks' view of the gate. */
export interface Gate {
  /** `tool.execute.before`: records the call so its evaluation sees the full arguments. */
  before(sessionID: string, callID: string, tool: string, input: unknown): void;
  /** `permission.evaluate`: the decision. */
  evaluate(event: Evaluation): Promise<void>;
  /** A new user turn: push-backs and refusals belong to the turn they were made in. */
  prompt(sessionID: string): void;
  /** OpenCode published a permission request (`permission.asked`). */
  asked(sessionID: string, requestID: string, source: { id: string } | undefined): void;
  /** The user answered one (`permission.replied`). */
  replied(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): void;
  mode(sessionID: string): Promise<PermissionMode>;
  setMode(sessionID: string, mode: string): Promise<PermissionMode | undefined>;
  cycleMode(sessionID: string): Promise<PermissionMode>;
  status(sessionID: string): Promise<Status>;
  forget(sessionID: string): void;
}

/**
 * `options` is read on every call when it is a function (the server passes one that merges the
 * settings files), so edits apply without a restart.
 */
export function createGate(host: Host, options: Options | (() => Options), directory: string, deps: Deps = {}): Gate {
  const optionsNow = typeof options === "function" ? options : () => options;
  const sessions = new Map<string, SessionState>();
  const modes = new Map<string, PermissionMode>();
  const parents = new Map<string, Promise<string | undefined>>();
  /** Sessions whose stored mode was looked up (and may have been absent). */
  const loaded = new Set<string>();

  const session = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        counts: { auto: 0, pushedBack: 0, asked: 0 },
        calls: new Map(),
        pushedBack: new Set(),
        holds: new Map(),
        requests: new Map(),
        denied: new Set(),
        allowSimilar: new Set(),
        git: new Map(),
        warnedUnavailable: false,
      };
      sessions.set(id, s);
    }
    return s;
  };
  const jevOptionsFor = (options: Options) => ({ model: options.jev.model, timeoutMs: options.jev.timeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const configuredCycle = (options: Options) => cycleOf(options.modes.map(parseMode).filter((m): m is PermissionMode => m !== undefined));
  const startMode = (options: Options): PermissionMode => (options.enabled ? (parseMode(options.defaultMode) ?? "auto") : "bypassPermissions");

  const git = (s: SessionState, cwd: string) => {
    let info = s.git.get(cwd);
    if (!info) {
      info = deps.git ? deps.git(cwd) : Promise.resolve(undefined);
      s.git.set(cwd, info);
    }
    return info;
  };

  /** The session's own mode, else its parent's (a subagent follows the session that started it), else the configured start. */
  const modeOf = async (sessionID: string): Promise<PermissionMode> => {
    const own = modes.get(sessionID);
    if (own) return own;
    if (!loaded.has(sessionID)) {
      loaded.add(sessionID);
      const stored = parseMode(await host.loadMode(sessionID).catch(() => undefined));
      if (stored) {
        modes.set(sessionID, stored);
        return stored;
      }
    }
    let parent = parents.get(sessionID);
    if (!parent) {
      parent = host.parent(sessionID).catch(() => undefined);
      parents.set(sessionID, parent);
    }
    const parentID = await parent;
    if (parentID && parentID !== sessionID) return modeOf(parentID);
    return startMode(optionsNow());
  };

  const changed = (sessionID: string, mode: PermissionMode, previous?: PermissionMode) =>
    host.changed({ sessionID, mode, ...(previous ? { previous } : {}), counts: { ...session(sessionID).counts } });

  const setMode = async (sessionID: string, next: PermissionMode) => {
    const previous = await modeOf(sessionID);
    modes.set(sessionID, next);
    if (next !== previous) {
      await host.saveMode(sessionID, next).catch(() => undefined);
      changed(sessionID, next, previous);
    }
    return next;
  };

  const plan = async (options: Options, s: SessionState, tool: string, args: Args, cwd: string, event: Evaluation): Promise<Plan> => {
    if (options.allowTools.includes(tool) || options.allowTools.includes(event.action)) return { kind: "allow", why: "allow list" };
    if (SHELL_TOOLS.has(tool) || event.action === "shell") {
      const command = str(args.command) || str(event.resources[0]);
      const ignored = deps.gitIgnored ? await deps.gitIgnored(secretGitAdds(command, cwd)) : new Set<string>();
      const reasons = alwaysAskBash(command, cwd, (await git(s, cwd))?.branch, ignored, directory);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(command, 6_000) };
      if (isReadOnlyBash(command, options.readOnlyCommands)) return { kind: "allow", why: "read-only command" };
      const keys = bashKeys(command, options.readOnlyCommands);
      return {
        kind: "judge",
        args: clip(command, 6_000),
        key: `shell:${keys.join("|")}`,
        similar: { keys: keys.map((k) => `shell:${k}`), label: keys.map((k) => `\`${k}\``).join(", ") },
      };
    }
    if (EDIT_TOOLS.has(tool) || event.action === "edit") {
      const files = editFiles(event, args);
      const reasons = [...new Set(files.flatMap(alwaysAskPath))];
      const argsText = clip(tool === "patch" || tool === "apply_patch" ? str(args.patchText) || JSON.stringify(args) : JSON.stringify(args), 6_000);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: argsText };
      const dir = path.dirname(path.resolve(cwd, expandHome(files[0] ?? ".")));
      const shown = path.relative(cwd, dir) || ".";
      return {
        kind: "judge",
        args: argsText,
        key: `${tool}:${dir}`,
        similar: { keys: [`${tool}:${dir}`], label: `${tool}s in ${shown.startsWith("..") ? dir : shown}` },
      };
    }
    if (BUILTIN_READ.has(tool) || BUILTIN_READ.has(event.action)) {
      const file = fileOf(args) || str(event.resources[0]);
      if ((tool === "read" || event.action === "read") && file && isCredentialPath(expandHome(file))) {
        return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}`, args: clip(JSON.stringify(args), 2_000) };
      }
      return { kind: "allow", why: "read-only tool" };
    }
    return { kind: "judge", args: clip(JSON.stringify(args), 6_000), key: `tool:${tool}`, similar: { keys: [`tool:${tool}`], label: `${tool} calls` } };
  };

  const transcript = (sessionID: string) => host.context(sessionID).catch((): readonly MessageLike[] => []);

  /** The state Jev judges a call in. */
  const judgeStateFor = async (messages: readonly MessageLike[], s: SessionState, cwd: string, tool: string, args: string, rules: readonly string[]) =>
    judgeState({
      userRequest: recentUserMessages(messages, 3).map((text, i, all) => clip(text, i === all.length - 1 ? 3_000 : 1_000)),
      agentBefore: clipTail(agentBeforeLatestUser(messages), 1_500),
      recentIntent: clipTail(recentTexts(messages).assistant, 2_000),
      cwd,
      git: await git(s, cwd),
      tool,
      args,
      rules,
    });

  /** Put a call to the user: OpenCode's own permission prompt, with why and the agent's case. */
  const ask = (s: SessionState, event: Evaluation, held: Held, lines: string[]) => {
    s.counts.asked++;
    event.effect = "ask";
    event.message = lines.filter(Boolean).join("\n");
    if (event.source) s.holds.set(event.source.id, held);
  };

  /**
   * A held call. The first time in a user turn it is denied with Jev's explanation and suggested
   * workaround, and the agent either works around it or makes its case and retries the identical
   * call. That retry (or another held call of the same family) goes to the user with the agent's
   * case.
   */
  const hold = async (
    options: Options,
    s: SessionState,
    event: Evaluation,
    h: Held & { reason: string; summary: string; state: Record<string, unknown>; messages: readonly MessageLike[] },
    call: string,
  ) => {
    const { reason, summary, state, messages, ...held } = h;
    const repeat = s.pushedBack.has(held.exact) || s.pushedBack.has(held.family);
    if (options.pushBack && !repeat) {
      s.pushedBack.add(held.exact);
      s.pushedBack.add(held.family);
      s.counts.pushedBack++;
      const suggestion = await askJev({ ...state, held_because: reason }, workaroundQuestion(), jevOptionsFor(options));
      const ideas = suggestion.ok ? suggestions(suggestion.answers) : [];
      const noWorkaround = ideas[0] === WORKAROUNDS.user_only;
      const advice = noWorkaround
        ? "Jev sees no workaround: whether to do this is the user's decision."
        : ideas.length
          ? `Jev suggests: ${ideas.join("; or ")}.`
          : "Look for a safer way: reversible, local, narrower, or previewed first.";
      host.log("info", `pushed back: ${call}`, { held: summary, workaround: ideas[0] ?? "(none)" });
      event.effect = "deny";
      event.message =
        `${reason}\n${advice}\nThe user has not been asked. ` +
        (noWorkaround ? "If the call still seems worth it, " : "Get the job done another way if you can. If no workaround is good enough, ") +
        "make your case: in a short visible message to the user (not only in your thinking), say why this exact call is needed" +
        (noWorkaround ? "" : " and why the workarounds fall short") +
        ", then make the identical call in that same message. tool-gate will show your case to the user and ask them to approve it. " +
        "If it is not worth raising, carry on without it.";
      return;
    }
    const agentCase = event.source ? clip(callerText(messages, { messageID: event.source.messageID, callID: event.source.id }).replace(/\s+/gu, " "), 600) : "";
    host.log("info", `asked: ${call}`, { held: summary });
    ask(s, event, held, [`tool-gate held this call: ${summary}.`, `Agent: ${agentCase || "(gave no reason)"}`]);
  };

  /** Manual and accept-edits modes: you decide, with "always" granting similar calls for the session. */
  const askUser = (s: SessionState, event: Evaluation, mode: PermissionMode, tool: string, args: Args, p: Exclude<Plan, { kind: "allow" }>, call: string) => {
    if (p.kind === "judge" && p.similar.keys.every((key) => s.allowSimilar.has(key))) {
      s.counts.auto++;
      host.log("info", `allow: ${call}`, { why: "allowed similar for this session" });
      return;
    }
    host.log("info", `asked: ${call}`, { why: `${MODE_NAMES[mode]} mode` });
    ask(
      s,
      event,
      { tool, exact: exactKey(tool, args), family: p.key, ...(p.kind === "judge" ? { similar: p.similar } : {}) },
      [`${MODE_NAMES[mode]} mode: tool-gate asks before every call that does more than read.`, ...(p.kind === "ask" ? [`Held: ${p.reasons.join("; ")}.`] : [])],
    );
  };

  /** Accept-edits mode: edits and filesystem commands inside the project. */
  const acceptsEdit = (options: Options, event: Evaluation, tool: string, args: Args, cwd: string) => {
    const root = path.resolve(directory);
    const inside = (file: string) => file.startsWith(`${root}${path.sep}`);
    if (EDIT_TOOLS.has(tool) || event.action === "edit") {
      const files = editFiles(event, args);
      return files.length > 0 && files.every((f) => inside(path.resolve(cwd, expandHome(f))));
    }
    if (!SHELL_TOOLS.has(tool) && event.action !== "shell") return false;
    // A command in another directory still counts only for files inside the project.
    return isAcceptEditsBash(str(args.command) || str(event.resources[0]), cwd, options.readOnlyCommands) && (cwd === root || inside(cwd));
  };

  const evaluate = async (event: Evaluation) => {
    const options = optionsNow();
    if (!options.enabled) return;
    const s = session(event.sessionID);
    const recorded = event.source ? s.calls.get(event.source.id) : undefined;
    const tool = recorded?.tool ?? event.action;
    const args = recorded?.input ?? {};
    const cwd = SHELL_TOOLS.has(tool) && str(args.workdir) ? path.resolve(directory, expandHome(str(args.workdir))) : directory;
    const mode = await modeOf(event.sessionID);
    const report = () => changed(event.sessionID, mode);

    if (mode === "bypassPermissions") {
      // Everything runs, except removing /, home, the project or a parent of them (as Claude Code).
      const command = SHELL_TOOLS.has(tool) || event.action === "shell" ? str(args.command) || str(event.resources[0]) : "";
      const critical = command ? alwaysAskBash(command, cwd, undefined, new Set(), directory).filter((reason) => reason.startsWith("deletes ")) : [];
      if (critical.length) {
        host.log("info", `asked: ${describeCall(tool, args)}`, { held: critical.join("; ") });
        ask(s, event, { tool, exact: exactKey(tool, args), family: `fixed:${critical.join("; ")}` }, [`tool-gate held this call: it ${critical.join("; ")}.`]);
      } else {
        event.effect = "allow";
      }
      return report();
    }

    // OpenCode's own checks that are not about one tool's call (a directory outside the project,
    // a doom loop) are left to its configuration.
    if (event.action === "external_directory" || (!recorded && !KNOWN_ACTIONS.has(event.action))) return;

    if (mode === "plan" && (EDIT_TOOLS.has(tool) || event.action === "edit")) {
      event.effect = "deny";
      event.message = "Plan mode is on: nothing may be edited until the user approves a plan and switches the mode (/tool-gate mode).";
      host.log("info", `denied: ${describeCall(tool, args, editFiles(event, args))}`, { why: "plan mode" });
      return report();
    }

    const p = await plan(options, s, tool, args, cwd, event);
    const call = describeCall(tool, args, event.action === "edit" ? editFiles(event, args) : []);

    if (p.kind === "allow") {
      s.counts.auto++;
      host.log("info", `allow: ${call}`, { why: p.why });
      return report();
    }

    const exact = exactKey(tool, args);
    if (s.denied.has(exact)) {
      event.effect = "deny";
      event.message = DECLINED;
      host.log("info", `denied: ${call}`, { why: "the user declined it" });
      return report();
    }

    if (mode === "default") {
      askUser(s, event, mode, tool, args, p, call);
      return report();
    }
    if (mode === "acceptEdits") {
      if (p.kind === "judge" && acceptsEdit(options, event, tool, args, cwd)) {
        s.counts.auto++;
        host.log("info", `allow: ${call}`, { why: "accept edits" });
      } else {
        askUser(s, event, mode, tool, args, p, call);
      }
      return report();
    }

    // Auto mode (and commands in plan mode).
    const messages = await transcript(event.sessionID);
    if (p.kind === "ask") {
      const why = p.reasons.join("; ");
      await hold(
        options,
        s,
        event,
        {
          tool,
          exact,
          family: p.key,
          reason: `tool-gate held this ${tool} call: it ${why}. Calls like this are always held, whatever Jev says.`,
          summary: why,
          state: await judgeStateFor(messages, s, cwd, tool, p.args, []),
          messages,
        },
        call,
      );
      return report();
    }

    if (p.similar.keys.every((key) => s.allowSimilar.has(key))) {
      s.counts.auto++;
      host.log("info", `allow: ${call}`, { why: "allowed similar for this session" });
      return report();
    }

    const rules = loadRules(directory);
    const state = await judgeStateFor(messages, s, cwd, tool, p.args, rules);
    const outcome = await askJev(state, judgeQuestions(rules), jevOptionsFor(options));

    if (!outcome.ok) {
      host.log("warn", `allow: ${call}`, { why: `Jev unavailable (${outcome.reason}); OpenCode's own permission rules apply` });
      if (!s.warnedUnavailable && options.toast) {
        s.warnedUnavailable = true;
        host.notify({ sessionID: event.sessionID, message: `tool-gate: Jev unavailable (${outcome.reason}); OpenCode's own permission rules apply.`, variant: "warning" });
      }
      s.counts.auto++;
      return report();
    }

    const v = verdict(outcome.answers, rules, options.thresholds);
    const action = !v || v.allow ? "allow" : "hold";
    host.log("info", `${action}: ${call}`, {
      why: action === "allow" ? "Jev" : v!.failures.join("; "),
      scores: v?.scores,
      latencyMs: outcome.latencyMs,
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
    });
    if (action === "allow") {
      s.counts.auto++;
      return report();
    }
    const brokenRules = v!.brokenRules.length ? ` (${v!.brokenRules.map((r) => `"${clip(r, 120)}"`).join(", ")})` : "";
    await hold(
      options,
      s,
      event,
      {
        tool,
        exact,
        family: p.key,
        similar: p.similar,
        reason: steerReason(tool, v!),
        summary: `${v!.failures.join("; ")}${brokenRules}`,
        state,
        messages,
      },
      call,
    );
    return report();
  };

  return {
    before(sessionID, callID, tool, input) {
      const s = session(sessionID);
      s.calls.set(callID, { tool, input: input && typeof input === "object" && !Array.isArray(input) ? (input as Args) : {} });
      // Calls of a turn are few; a runaway loop still must not grow the map without bound.
      if (s.calls.size > 500) s.calls.delete(s.calls.keys().next().value as string);
    },
    evaluate,
    prompt(sessionID) {
      const s = sessions.get(sessionID);
      if (!s) return;
      s.pushedBack.clear();
      s.denied.clear();
      s.holds.clear();
      s.requests.clear();
      s.git.clear();
    },
    asked(sessionID, requestID, source) {
      const s = sessions.get(sessionID);
      const held = source ? s?.holds.get(source.id) : undefined;
      if (!s || !held) return;
      s.holds.delete(source!.id);
      s.requests.set(requestID, held);
    },
    replied(sessionID, requestID, reply) {
      const s = sessions.get(sessionID);
      const held = s?.requests.get(requestID);
      if (!s || !held) return;
      s.requests.delete(requestID);
      if (reply === "reject") s.denied.add(held.exact);
      if (reply === "always") for (const key of held.similar?.keys ?? []) s.allowSimilar.add(key);
      host.log("info", `user ${reply === "reject" ? "declined" : reply === "always" ? "allowed similar" : "allowed"}: ${held.tool}`, {
        ...(reply === "always" && held.similar ? { similar: held.similar.label } : {}),
      });
    },
    mode: modeOf,
    async setMode(sessionID, mode) {
      const next = parseMode(mode);
      if (!next) return undefined;
      return setMode(sessionID, next);
    },
    async cycleMode(sessionID) {
      return setMode(sessionID, nextMode(await modeOf(sessionID), configuredCycle(optionsNow())));
    },
    async status(sessionID) {
      const options = optionsNow();
      const s = session(sessionID);
      return {
        mode: await modeOf(sessionID),
        cycle: configuredCycle(options),
        counts: { ...s.counts },
        jev: options.jev.model,
        pushBack: options.pushBack,
        rules: loadRules(directory).length,
        grants: s.allowSimilar.size,
      };
    },
    forget(sessionID) {
      sessions.delete(sessionID);
      modes.delete(sessionID);
      parents.delete(sessionID);
      loaded.delete(sessionID);
    },
  };
}

/** Permission actions the gate judges even when it did not see the tool call that raised them. */
const KNOWN_ACTIONS = new Set(["shell", "edit", "read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "subagent", "question", "skill"]);
