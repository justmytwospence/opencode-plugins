// opencode-cache-guard (terminal): holds a prompt that would re-cache a large conversation
// before it is sent, shows the prompt cache's time left in the prompt footer, runs Pi's
// `/cache-guard` commands (status, compact, fresh, on, off, jev) from the palette and as slash
// commands, and reports the herdr `cache` token for the session on screen.
//
// The hold is a keymap layer over Enter, above the prompt's own submit binding: when the session's
// cache is cold and the re-cache is worth asking about, the layer takes the prompt out of the box
// with OpenCode's own stash and offers the choices (send, send and stop asking, compact with Jev,
// compact first, start fresh, keep); every other Enter falls through untouched. The cache state
// comes from the server half over RPC, or, for a session the server has not seen a request for
// since it started, from the session's stored messages. The server half runs once per location,
// so every RPC call names the session's location.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { Show, createEffect, createSignal } from "solid-js";

import { ANTHROPIC_TTL_MS, type ModelRef, type Snapshot, priceOf, ttlOf } from "./clock.ts";
import { type Settings, describeMiss, worthWarning } from "./core.ts";
import { HerdrRpc } from "./herdr-rpc.ts";
import { type Choice, GUIDANCE_OPTIONS, type HeldPrompt, choiceOptions, choiceTitle, guidanceText, heldPrompt, holdable } from "./holds.ts";
import { JEV_KEY_URL, JEV_PITCH } from "./lean.ts";
import { type ArmInput, CacheGuardRpc, type Compacted, type JevOutput, type Note, type StateOutput } from "./rpc.ts";
import { loadSettings, saveUserSettings } from "./settings.ts";
import { type View, coldCost, coldReason, fromMessages, herdrValue, statusLines, view } from "./status.ts";

/** The palette commands (Pi's `/cache-guard <sub>`), also slash commands. */
export const JEV_COMMAND = "cache-guard.jev";
export const JEV_SLASH = "cache-guard-jev";
export const STATUS_COMMAND = "cache-guard.status";
export const STATUS_SLASH = "cache-guard";
export const COMPACT_COMMAND = "cache-guard.compact";
export const COMPACT_SLASH = "cache-guard-compact";
export const FRESH_COMMAND = "cache-guard.fresh";
export const FRESH_SLASH = "cache-guard-fresh";
export const ON_COMMAND = "cache-guard.on";
export const ON_SLASH = "cache-guard-on";
export const OFF_COMMAND = "cache-guard.off";
export const OFF_SLASH = "cache-guard-off";
/** Above the prompt's own Enter (priority 0) and its queue binding (1). */
const HOLD_PRIORITY = 10;
/** The longest a compaction the dialog asked for is waited on. */
const COMPACT_TIMEOUT_MS = 180_000;
/** Lets the prompt box settle (focus back after a dialog, mount after a navigation) before it is driven. */
const SETTLE_MS = 120;

/** One run of text in the footer. */
export interface Segment {
  text: string;
  color: "textMuted" | "warning";
}

/** `cache 4:12`, or `cache cold` in the warning color; undefined shows nothing. */
export function segments(v: View | undefined): Segment[] | undefined {
  if (!v) return undefined;
  return [{ text: "cache ", color: "textMuted" }, v.left ? { text: v.left, color: "textMuted" } : { text: v.cold ?? "", color: "warning" }];
}

/**
 * Whether a prompt about to be sent is held, and why: the text is a real prompt, the session is
 * not muted, its cache is cold (expired, a model switch, or long idle without a TTL) and the
 * re-cache is worth asking about.
 */
export function decideHold(input: { text: string; mode: string; snapshot: Snapshot | undefined; model: ModelRef | undefined; now: number; settings: Settings; muted: boolean }): HeldPrompt | undefined {
  const { text, snapshot, settings, now } = input;
  if (input.muted || !holdable(text, input.mode, settings) || !snapshot) return undefined;
  const reason = coldReason(snapshot, input.model, now, settings);
  if (!reason) return undefined;
  const next = reason.kind === "model" && input.model ? input.model : snapshot.model;
  const price = next ? (reason.kind === "model" ? priceOf(next) : snapshot.price) : undefined;
  const ttlMs = snapshot.ttlMs ?? ANTHROPIC_TTL_MS;
  const cost = price ? coldCost({ ...snapshot, price, ttlMs }) : undefined;
  if (!worthWarning(snapshot.tokens, cost, settings)) return undefined;
  return heldPrompt({ text: text.trim(), now, line: describeMiss(reason, snapshot.tokens, cost), reason, tokens: snapshot.tokens, price, ttlMs });
}

/** What the choices need from the terminal; a seam for tests. */
export interface Actions {
  /** Puts the held prompt back in the box (the stash pop). */
  restore(): void;
  /** Puts the held prompt back and submits it, in the session on screen. */
  submit(): Promise<void>;
  mute(sessionID: string): void;
  /** Arms the server for the compaction, runs it, resolves when it is done; rejects with the reason. */
  compact(sessionID: string, arm: ArmInput): Promise<void>;
  /** A new session with the same agent and model, shown; its id. */
  fresh(sessionID: string): Promise<string | undefined>;
  toast(message: string, variant: "warning" | "error" | "info"): void;
}

/**
 * Runs one choice. The held prompt is in the stash until a choice sends it or puts it back, so a
 * choice that fails before sending (a compaction or a session creation that errors) restores it.
 */
export async function act(choice: Choice, sessionID: string, held: HeldPrompt, actions: Actions, guidance?: string): Promise<void> {
  switch (choice) {
    case "keep":
      actions.restore();
      return;
    case "send":
      await actions.submit();
      return;
    case "mute":
      actions.mute(sessionID);
      await actions.submit();
      return;
    case "fresh": {
      const created = await actions.fresh(sessionID);
      if (!created) {
        actions.restore();
        actions.toast("Creating a session failed; the prompt is back in the box.", "error");
        return;
      }
      await actions.submit();
      return;
    }
    case "jev":
    case "compact": {
      const arm: ArmInput = choice === "jev" ? { sessionID, kind: "jev", text: held.text } : { sessionID, kind: "guidance", ...(guidance ? { text: guidance } : {}) };
      actions.toast(choice === "jev" ? "Compacting with Jev, then sending your prompt." : "Compacting, then sending your prompt.", "info");
      try {
        await actions.compact(sessionID, arm);
      } catch (error) {
        actions.restore();
        actions.toast(`${error instanceof Error ? error.message : String(error)} The prompt is back in the box.`, "error");
        return;
      }
      await actions.submit();
    }
  }
}

/** The dialogs the hold uses; a seam for tests. */
export interface Dialogs {
  select<Value>(title: string, options: ReadonlyArray<{ title: string; value: Value; description?: string }>): Promise<Value | undefined>;
  prompt(title: string, placeholder: string): Promise<string | undefined>;
}

/** The choice dialog, then (for Compact first) the guidance dialog or prompt; Esc keeps the prompt. */
export async function offer(dialogs: Dialogs, sessionID: string, held: HeldPrompt, actions: Actions, jev: { ready: boolean; tip: boolean }): Promise<void> {
  const choice = await dialogs.select<Choice>(choiceTitle(held, jev), choiceOptions(held, jev));
  if (choice === undefined || choice === "keep") return act("keep", sessionID, held, actions);
  if (choice !== "compact") return act(choice, sessionID, held, actions);
  const how = await dialogs.select("Compact with", GUIDANCE_OPTIONS);
  if (how === undefined) return act("keep", sessionID, held, actions);
  let custom: string | undefined;
  if (how === "custom") {
    custom = await dialogs.prompt("Compaction guidance", "What the summary should keep or stress");
    if (custom === undefined) return act("keep", sessionID, held, actions);
  }
  return act("compact", sessionID, held, actions, guidanceText(how, held, custom));
}

/** What the Jev command needs; a seam for tests. */
export interface JevCommandDeps {
  settings(): Settings;
  /** The server's view: whether it reaches Jev, and how fast. */
  state(): Promise<JevOutput>;
  /** Merge into the user settings file; throws when it cannot. */
  save(patch: Record<string, unknown>): void;
  select(title: string, options: Array<{ title: string; description?: string; onSelect: () => void }>): Promise<void>;
  toast(message: string, variant: "warning" | "error" | "info"): void;
}

const JEV_OFF_LINE = "Jev is off: no trimming, no Jev compaction, no tips.";
const JEV_USES = "It trims large tool output, compacts a cold cache on a one-second summary, and marks what a compaction must keep word for word.";

/**
 * `cache-guard: Jev`: whether the server reaches Jev (and how fast), how to set it up, and
 * turning it off or on (`jev.enabled` in ~/.config/opencode/cache-guard.json).
 */
export async function jevCommand(deps: JevCommandDeps): Promise<void> {
  const save = (patch: Record<string, unknown>) => {
    try {
      deps.save({ jev: patch });
      return true;
    } catch (error) {
      deps.toast(`Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  };
  const settings = deps.settings();
  if (!settings.enabled) {
    deps.toast("cache-guard is off in its settings (\"enabled\": false), Jev included.", "info");
    return;
  }
  if (!settings.jev.enabled) {
    await deps.select(`${JEV_OFF_LINE}\n${JEV_PITCH}`, [
      { title: "Turn Jev on", description: "jev.enabled: true in ~/.config/opencode/cache-guard.json", onSelect: () => void (save({ enabled: true }) && jevCommand(deps)) },
      { title: "Leave it off", onSelect: () => undefined },
    ]);
    return;
  }
  const state = await deps.state();
  if (state.kind === "off") return;
  const off = (tips: boolean) => {
    if (save({ enabled: false })) deps.toast(`Jev is off: no trimming, no Jev compaction${tips ? ", no tips" : ""}. cache-guard: Jev turns it back on.`, "info");
  };
  if (state.kind === "ready") {
    const head = state.latencyMs !== undefined ? `Jev: ${state.label}, answered in ${state.latencyMs} ms.` : `Jev: ${state.label} did not answer (${state.reason}).`;
    await deps.select(`${head} ${JEV_USES}`, [
      { title: "Done", onSelect: () => undefined },
      { title: "Turn Jev off", description: "No trimming, no Jev compaction, no tips.", onSelect: () => off(false) },
    ]);
    return;
  }
  await deps.select(
    `Jev is not set up: ${state.reason}.\n${JEV_PITCH}\nIt needs a TypeSafe API key from ${JEV_KEY_URL}, as TYPESAFE_API_KEY in the environment of OpenCode's server (restart it after setting the key).`,
    [
      { title: "Done", description: "Set the key, restart OpenCode's server, and run this again to check.", onSelect: () => undefined },
      ...(settings.jev.provider.trim()
        ? [{ title: "Use TypeSafe's API (clear jev.provider)", onSelect: () => void (save({ provider: "", model: "" }) && jevCommand(deps)) }]
        : []),
      { title: "Turn Jev off (no more tips)", onSelect: () => off(true) },
    ],
  );
}

/** What `cache-guard: compact` needs; a seam for tests. */
export interface CompactCommandDeps {
  /** The server's view of Jev. */
  state(): Promise<JevOutput>;
  /** Arms the server and runs the compaction; rejects with the reason. */
  compact(arm: ArmInput): Promise<void>;
  select<Value>(title: string, options: ReadonlyArray<{ title: string; value: Value; description?: string }>): Promise<Value | undefined>;
  /** Runs `cache-guard: Jev`. */
  setup(): Promise<void>;
  toast(message: string, variant: "warning" | "error" | "info"): void;
  now?: () => number;
}

/**
 * `cache-guard: compact [focus]`: Jev's compaction, written in code against `focus` (else the
 * last requests); nothing is compacted if Jev fails. Without Jev, offers OpenCode's own summary
 * (with `focus` as its guidance) or setting Jev up.
 */
export async function compactCommand(sessionID: string, focus: string, deps: CompactCommandDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const jev = await deps.state();
  const text = focus.trim();
  if (jev.kind !== "ready") {
    const why = jev.kind === "off" ? "Jev is off" : `Jev is not set up (${jev.reason})`;
    const pick = await deps.select<"summary" | "setup">(`${why}. Compact with OpenCode's summary instead?`, [
      { title: "Compact with OpenCode's summary", value: "summary", description: text ? `With the guidance: ${text}` : "The default compaction prompt." },
      { title: "Set up Jev", value: "setup" },
    ]);
    if (pick === "setup") return deps.setup();
    if (pick !== "summary") return;
    try {
      await deps.compact({ sessionID, kind: "guidance", ...(text ? { text } : {}) });
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : String(error), "warning");
    }
    return;
  }
  const started = now();
  try {
    await deps.compact({ sessionID, kind: "jev", ...(text ? { text } : {}) });
    deps.toast(`Compacted with Jev in ${((now() - started) / 1000).toFixed(1)} s.`, "info");
  } catch (error) {
    deps.toast(error instanceof Error ? error.message : String(error), "warning");
  }
}

/** Whether the dialog offers Jev, and whether it shows the tip for setting Jev up. */
export function jevOffer(state: JevOutput | undefined, settings: Settings): { ready: boolean; tip: boolean } {
  if (!settings.enabled || !settings.jev.enabled) return { ready: false, tip: false };
  return { ready: state?.kind === "ready", tip: state?.kind === "missing" };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default Plugin.define({
  id: "cache-guard.tui",
  setup(context) {
    const rpc = context.client.rpc(CacheGuardRpc);
    const herdr = context.client.rpc(HerdrRpc);
    const directoryOf = (sessionID: string | undefined) => {
      const dir = sessionID ? context.data.session.get(sessionID)?.location?.directory : undefined;
      return dir ?? (context.location ?? context.data.location.default()).directory;
    };
    const directory = () => {
      const route = context.ui.router.current();
      return directoryOf(route.type === "session" ? route.sessionID : undefined);
    };
    // The server half runs once per location: calls go to the instance serving the session.
    const at = (sessionID: string | undefined) => ({ location: { directory: directoryOf(sessionID) } });
    const settingsNow = () => loadSettings(directory(), process.env, context.options as Record<string, unknown>);
    const shown = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const toast = (message: string, variant: "warning" | "error" | "info" = "info", sessionID?: string) =>
      context.ui.toast.show({ title: "cache-guard", message, variant, duration: 8_000, ...(sessionID ? { sessionID } : {}) });

    // The cache state: the server's snapshots (over RPC), else what the session's messages say.
    const [snapshots, setSnapshots] = createSignal(new Map<string, Snapshot>(), { equals: false });
    const asked = new Set<string>();
    const remember = (s: Snapshot) => {
      snapshots().set(s.sessionID, s);
      setSnapshots(snapshots());
    };
    const fetchState = (sessionID: string) => {
      if (asked.has(sessionID)) return;
      asked.add(sessionID);
      void rpc
        .state({ sessionID }, at(sessionID))
        .then((s) => {
          if (s) remember(s as unknown as Snapshot);
        })
        .catch(() => asked.delete(sessionID));
    };
    const offState = rpc.events.on("state", (event) => remember(event.data as unknown as Snapshot));
    const catalogPrice = (model: ModelRef) => {
      const info = context.data.location.model.list()?.find((m) => m.providerID === model.providerID && m.id === model.modelID);
      const cost = info?.cost?.find((c) => !c.tier) ?? info?.cost?.[0];
      return priceOf(model, cost);
    };
    const snapshotOf = (sessionID: string): Snapshot | undefined => {
      fetchState(sessionID);
      const live = snapshots().get(sessionID);
      if (live) return live;
      return fromMessages(sessionID, context.data.session.message.list(sessionID) as never, ttlOf, catalogPrice);
    };
    const selectedModel = (): ModelRef | undefined => {
      const m = context.ui.model.current();
      return m ? { providerID: m.providerID, modelID: m.modelID } : undefined;
    };

    // Jev, as the server sees it; asked once a hold is being decided, so the dialog is right.
    let jevState: JevOutput | undefined;
    let jevAskedAt = 0;
    const refreshJev = () => {
      if (Date.now() - jevAskedAt < 60_000) return;
      jevAskedAt = Date.now();
      void rpc
        .jev({}, at(shown()))
        .then((s) => {
          jevState = s as JevOutput;
        })
        .catch(() => undefined);
    };

    // Per session, this terminal's switches (Pi's `/cache-guard on|off` and "Send, and stop
    // asking"): `off` hides the clock and holds nothing; `muted` holds nothing.
    const [switches, setSwitches] = context.storage.memory<{ off: string[]; muted: string[] }>("switches", { initial: { off: [], muted: [] } });
    const isOff = (sessionID: string) => switches.off.includes(sessionID);
    const isMuted = (sessionID: string) => switches.muted.includes(sessionID);
    const add = (list: string[], sessionID: string) => void (list.includes(sessionID) || list.push(sessionID));
    const remove = (list: string[], sessionID: string) => {
      const i = list.indexOf(sessionID);
      if (i >= 0) list.splice(i, 1);
    };
    let promptMode = "normal";
    const dispatch = (id: string) => {
      try {
        context.keymap.dispatch(id);
      } catch {
        // The command is not reachable right now (no prompt box on screen).
      }
    };
    // The prompt box's text, when OpenCode's prompt (not a dialog's editor) has the focus.
    const promptText = (): string | undefined => {
      const focused = context.renderer.currentFocusedRenderable as { plainText?: unknown; traits?: { role?: string; owner?: string } } | null;
      if (!focused || typeof focused.plainText !== "string") return undefined;
      if (focused.traits && (focused.traits.role !== "prompt" || focused.traits.owner !== "opencode")) return undefined;
      return focused.plainText;
    };
    const waitForCompaction = (sessionID: string) =>
      new Promise<void>((resolve, reject) => {
        const done = (fn: () => void) => {
          clearTimeout(timer);
          offEnded();
          offFailed();
          offCompacted();
          fn();
        };
        const timer = setTimeout(() => done(() => reject(new Error("The compaction did not finish in time."))), COMPACT_TIMEOUT_MS);
        const offEnded = context.data.on("session.compaction.ended", (event) => {
          if (event.data.sessionID === sessionID) done(resolve);
        });
        const offFailed = context.data.on("session.compaction.failed", (event) => {
          if (event.data.sessionID === sessionID) done(() => reject(new Error(`Compaction failed (${event.data.error?.message ?? event.data.error?.type ?? "error"}).`)));
        });
        const offCompacted = rpc.events.on("compacted", (event) => {
          const data = event.data as unknown as Compacted;
          if (data.sessionID === sessionID && !data.ok) done(() => reject(new Error(data.message)));
        });
      });
    const actions: Actions = {
      restore: () => dispatch("prompt.stash.pop"),
      submit: async () => {
        await sleep(SETTLE_MS);
        dispatch("prompt.stash.pop");
        dispatch("prompt.submit");
      },
      mute: (sessionID) => setSwitches((draft) => add(draft.muted, sessionID)),
      compact: async (sessionID, arm) => {
        await rpc.arm(arm, at(sessionID));
        const waited = waitForCompaction(sessionID);
        try {
          await context.client.session.compact({ sessionID });
        } catch (error) {
          waited.catch(() => undefined);
          throw new Error(`Compaction could not start (${error instanceof Error ? error.message : String(error)}).`);
        }
        await waited;
      },
      fresh: async (sessionID) => {
        const current = context.data.session.get(sessionID);
        const created = await context.client.session.create({
          ...(current?.agent ? { agent: current.agent } : {}),
          ...(current?.model ? { model: current.model } : {}),
          ...(current?.location ? { location: current.location } : {}),
        });
        if (!created?.id) return undefined;
        context.ui.router.navigate({ type: "session", sessionID: created.id });
        await sleep(SETTLE_MS * 3);
        return created.id;
      },
      toast: (message, variant) => toast(message, variant),
    };
    const dialogs: Dialogs = {
      select: (title, options) => context.ui.dialog.select({ title, options }),
      prompt: (title, placeholder) => context.ui.dialog.prompt({ title, placeholder }),
    };

    // The hold: Enter in the prompt, above the prompt's own submit binding.
    context.keymap.layer(() => ({
      priority: HOLD_PRIORITY,
      enabled: context.ui.router.current().type === "session",
      commands: [
        {
          title: "Check the prompt cache before sending",
          group: "Prompt",
          bind: "return",
          run: (_input, event) => {
            const sessionID = shown();
            const text = promptText();
            if (!sessionID || text === undefined) return false;
            const settings = settingsNow();
            const held = decideHold({
              text,
              mode: promptMode,
              snapshot: snapshotOf(sessionID),
              model: selectedModel(),
              now: Date.now(),
              settings,
              muted: isMuted(sessionID) || isOff(sessionID),
            });
            if (!held) return false;
            event?.preventDefault();
            event?.stopPropagation();
            dispatch("prompt.stash");
            refreshJev();
            void offer(dialogs, sessionID, held, actions, jevOffer(jevState, settings)).catch((error) => {
              actions.restore();
              toast(error instanceof Error ? error.message : String(error), "error");
            });
          },
        },
      ],
    }));

    // The commands (Pi's `/cache-guard status|compact|fresh|on|off|jev`): global, so the palette
    // and the slash completion list them in any mode.
    const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error");
    const runJev = () =>
      jevCommand({
        settings: settingsNow,
        state: () => rpc.jev({}, at(shown())).then((s) => s as JevOutput),
        save: (patch) => void saveUserSettings(patch),
        select: async (title, options) => {
          const picked = await context.ui.dialog.select({ title, options: options.map((o, value) => ({ title: o.title, value, description: o.description })) });
          if (picked !== undefined) options[picked]?.onSelect();
        },
        toast: (message, variant) => toast(message, variant),
      });
    const inSession = (): string | undefined => {
      const sessionID = shown();
      if (!sessionID) toast("Open a session first.", "warning");
      return sessionID;
    };
    const command = (id: string, slash: string, title: string, run: (input?: string) => void | Promise<void>, args?: true) => ({
      id,
      title,
      group: "Session",
      bind: false as const,
      palette: true as const,
      slash: { name: slash, ...(args ? { arguments: true as const } : {}) },
      run: (input?: string) => Promise.resolve(run(input)).catch(fail),
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        command(STATUS_COMMAND, STATUS_SLASH, "cache-guard: status", async () => {
          const sessionID = inSession();
          if (!sessionID) return;
          const jev = await rpc.jev({}, at(sessionID)).then((s) => s as JevOutput).catch(() => undefined);
          const lines = statusLines({ snapshot: snapshotOf(sessionID), model: selectedModel(), now: Date.now(), settings: settingsNow(), off: isOff(sessionID), muted: isMuted(sessionID), jev });
          await context.ui.dialog.alert({ title: "cache-guard", message: lines.join("\n") });
        }),
        command(
          COMPACT_COMMAND,
          COMPACT_SLASH,
          "cache-guard: compact with Jev",
          async (input) => {
            const sessionID = inSession();
            if (!sessionID) return;
            const focus = (input ?? "").replace(/^\/\S+/u, "");
            await compactCommand(sessionID, focus, {
              state: () => rpc.jev({}, at(sessionID)).then((s) => s as JevOutput),
              compact: (arm) => actions.compact(sessionID, arm),
              select: (title, options) => context.ui.dialog.select({ title, options }),
              setup: runJev,
              toast: (message, variant) => toast(message, variant),
            });
          },
          true,
        ),
        command(FRESH_COMMAND, FRESH_SLASH, "cache-guard: start fresh with this prompt", async () => {
          const sessionID = inSession();
          if (!sessionID) return;
          // The prompt box's text travels in OpenCode's stash: stashed here, popped and sent there.
          dispatch("prompt.stash");
          const created = await actions.fresh(sessionID);
          if (!created) {
            actions.restore();
            toast("Creating a session failed; the prompt is back in the box.", "error");
            return;
          }
          await actions.submit();
        }),
        command(ON_COMMAND, ON_SLASH, "cache-guard: on for this session", () => {
          const sessionID = inSession();
          if (!sessionID) return;
          setSwitches((draft) => {
            remove(draft.off, sessionID);
            remove(draft.muted, sessionID);
          });
          toast("cache-guard on for this session", "info");
        }),
        command(OFF_COMMAND, OFF_SLASH, "cache-guard: off for this session", () => {
          const sessionID = inSession();
          if (!sessionID) return;
          setSwitches((draft) => add(draft.off, sessionID));
          toast("cache-guard off for this session: no clock, no holds (trimming and compaction follow the settings)", "info");
        }),
        command(JEV_COMMAND, JEV_SLASH, "cache-guard: Jev", runJev),
      ],
    }));

    // The server's notes.
    const offTrimmed = rpc.events.on("trimmed", (event) => {
      const data = event.data as unknown as Note;
      toast(data.message, "info", data.sessionID);
    });
    const offCompacted = rpc.events.on("compacted", (event) => {
      const data = event.data as unknown as Compacted;
      if (data.ok) toast(data.message, "info", data.sessionID);
    });

    // The footer, the herdr token and the Jev state, once a second for the session on screen.
    const [now, setNow] = createSignal(Date.now());
    const reported = new Map<string, string | undefined>();
    const report = (sessionID: string, value: string | undefined, force = false) => {
      if (!force && reported.get(sessionID) === value && reported.has(sessionID)) return;
      reported.set(sessionID, value);
      void herdr.token({ sessionID, key: "cache", ...(value === undefined ? {} : { value, ttlMs: 86_400_000 }) }, at(sessionID)).catch(() => undefined);
    };
    const offReady = herdr.events.on("ready", () => {
      for (const [sessionID, value] of reported) report(sessionID, value, true);
    });
    const ticker = setInterval(() => {
      setNow(Date.now());
      const sessionID = shown();
      if (!sessionID) return;
      const settings = settingsNow();
      const value = settings.herdr.enabled && !isOff(sessionID) ? herdrValue(snapshotOf(sessionID), Date.now(), settings) : undefined;
      if (value !== undefined || reported.has(sessionID)) report(sessionID, value);
      if (value !== undefined) refreshJev();
    }, 1000);

    const color = (name: Segment["color"]) => (name === "warning" ? context.theme.text.feedback.warning.base : context.theme.text.muted);
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        createEffect(() => {
          promptMode = input.mode;
        });
        return jsx(Show as never, {
          get when() {
            const sessionID = input.sessionID;
            if (!sessionID || isOff(sessionID)) return undefined;
            const settings = settingsNow();
            return settings.enabled ? segments(view(snapshotOf(sessionID), now(), settings)) : undefined;
          },
          children: (parts: () => Segment[]) =>
            jsx("text", {
              wrapMode: "none",
              get children() {
                return parts().map((s) => jsx("span", { style: { fg: color(s.color) }, children: s.text }));
              },
            }),
        });
      },
    });

    return () => {
      clearInterval(ticker);
      offState();
      offTrimmed();
      offCompacted();
      offReady();
      for (const [sessionID, value] of reported) if (value !== undefined) report(sessionID, undefined, true);
    };
  },
});
