// The CLI half of tool-gate: the permission mode of the session on screen, in the prompt footer
// right after OpenCode's `dir:branch` (`auto mode on · 3 auto · 1 pushed back · 0 asked`), the
// `/tool-gate` slash command and the palette commands that switch or cycle it, and toasts for
// the server half's notices. The mode itself lives in the server half, per session, reached over
// the tool-gate RPC.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import { Show } from "solid-js";
import { createStore } from "solid-js/store";
import { jsx } from "@opentui/solid/jsx-runtime";
import { MODES, MODE_DESCRIPTIONS, MODE_LABELS, MODE_NAMES, type PermissionMode, parseMode } from "./modes.ts";
import { type ChangedEvent, type NoticeEvent, type Status, ToolGateRpc } from "./rpc.ts";

/** The footer text for a session's status: the mode, and Jev's counts where Jev judges. */
export function footerText(status: Pick<Status, "mode" | "counts">): string {
  const mode = parseMode(status.mode) ?? "auto";
  const label = MODE_LABELS[mode];
  if (mode !== "auto" && mode !== "plan") return label;
  const c = status.counts;
  return `${label} · ${c.auto} auto · ${c.pushedBack} pushed back · ${c.asked} asked`;
}

/** `/tool-gate <words>` parsed: what to do and, for `mode`, which mode. */
export function parseCommand(input: string | undefined): { action: "status" | "select" | "set" | "cycle" | "unknown"; mode?: PermissionMode; word?: string } {
  const words = (input ?? "").trim().split(/\s+/u).filter(Boolean);
  const [first, second] = words;
  if (!first || first === "status") return { action: "status" };
  if (first === "cycle") return { action: "cycle" };
  if (first === "on") return { action: "set", mode: "auto" };
  if (first === "off") return { action: "set", mode: "bypassPermissions" };
  if (first === "mode") {
    if (!second) return { action: "select" };
    const mode = parseMode(second);
    return mode ? { action: "set", mode } : { action: "unknown", word: second };
  }
  const mode = parseMode(first);
  return mode ? { action: "set", mode } : { action: "unknown", word: first };
}

export default Plugin.define({
  id: "tool-gate.tui",
  setup(context) {
    const rpc = context.client.rpc(ToolGateRpc);
    const [status, setStatus] = createStore<Record<string, Status>>({});
    const loading = new Set<string>();

    const shown = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const toast = (message: string, variant: "info" | "warning" | "error" = "info", sessionID?: string) =>
      context.ui.toast.show({ message, variant, ...(sessionID ? { sessionID } : {}) });

    const load = (sessionID: string) => {
      if (loading.has(sessionID)) return;
      loading.add(sessionID);
      rpc
        .status({ sessionID })
        .then((s) => setStatus(sessionID, s as unknown as Status))
        .catch(() => undefined)
        .finally(() => loading.delete(sessionID));
    };
    const offChanged = rpc.events.on("changed", (event) => {
      const data = event.data as unknown as ChangedEvent;
      const current = status[data.sessionID];
      if (current) setStatus(data.sessionID, { ...current, mode: data.mode, counts: data.counts });
      else load(data.sessionID);
      if (data.previous && data.previous !== data.mode && data.sessionID === shown()) {
        const mode = parseMode(data.mode) ?? "auto";
        toast(`tool-gate: ${MODE_LABELS[mode]}. ${MODE_DESCRIPTIONS[mode]}`, mode === "bypassPermissions" ? "warning" : "info");
      }
    });
    const offNotice = rpc.events.on("notice", (event) => {
      const data = event.data as unknown as NoticeEvent;
      toast(data.message, data.variant, data.sessionID);
    });

    const setMode = async (sessionID: string, mode: PermissionMode) => {
      try {
        await rpc.setMode({ sessionID, mode });
      } catch (error) {
        toast(`tool-gate: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    const select = async (sessionID: string) => {
      const current = parseMode(status[sessionID]?.mode);
      const picked = await context.ui.dialog.select<PermissionMode>({
        title: "Permission mode",
        options: MODES.map((mode) => ({ title: MODE_NAMES[mode], value: mode, description: MODE_DESCRIPTIONS[mode] })),
        ...(current ? { current } : {}),
      });
      if (picked) await setMode(sessionID, picked);
    };
    const showStatus = async (sessionID: string) => {
      try {
        const s = (await rpc.status({ sessionID })) as unknown as Status;
        setStatus(sessionID, s);
        const mode = parseMode(s.mode) ?? "auto";
        await context.ui.dialog.alert({
          title: "tool-gate",
          message: [
            `Mode: ${MODE_NAMES[mode]} (${MODE_DESCRIPTIONS[mode]})`,
            `Cycle: ${s.cycle.map((m) => MODE_NAMES[parseMode(m) ?? "auto"]).join(" > ")}.`,
            `${s.counts.auto} auto-approved, ${s.counts.pushedBack} pushed back, ${s.counts.asked} asked this session.`,
            `Jev: ${s.jev}; push-back ${s.pushBack ? "on" : "off"}.`,
            `${s.rules} project rule${s.rules === 1 ? "" : "s"}; ${s.grants} "allow similar" grant${s.grants === 1 ? "" : "s"}.`,
            "",
            "/tool-gate mode [manual|accept-edits|plan|auto|bypass], /tool-gate cycle, /tool-gate on|off.",
          ].join("\n"),
        });
      } catch (error) {
        toast(`tool-gate: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    const run = async (input?: string) => {
      const sessionID = shown();
      if (!sessionID) return toast("tool-gate: open a session first.", "warning");
      const command = parseCommand(input);
      if (command.action === "status") return showStatus(sessionID);
      if (command.action === "select") return select(sessionID);
      if (command.action === "set") return setMode(sessionID, command.mode as PermissionMode);
      if (command.action === "cycle") {
        try {
          await rpc.cycleMode({ sessionID });
        } catch (error) {
          toast(`tool-gate: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      toast(`tool-gate: unknown mode "${command.word}". Modes: ${MODES.map((m) => MODE_NAMES[m]).join(", ")}.`, "warning");
    };

    // A global layer: the palette and slash completion list only commands reachable from every
    // input mode (a base layer's run from the prompt, but are not listed).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tool-gate.mode",
          title: "Tool gate: permission mode",
          description: "Switch the permission mode of this session (manual, accept edits, plan, auto, bypass)",
          group: "Tool gate",
          palette: true,
          slash: { name: "tool-gate", arguments: true },
          run: (input) => run(input ?? "mode"),
        },
        {
          id: "tool-gate.cycle",
          title: "Tool gate: cycle permission mode",
          description: "The next mode in the configured cycle",
          group: "Tool gate",
          palette: true,
          run: () => run("cycle"),
        },
        {
          id: "tool-gate.status",
          title: "Tool gate: status",
          description: "The mode, counts, Jev settings, rules and grants of this session",
          group: "Tool gate",
          palette: true,
          run: () => run("status"),
        },
      ],
    }));

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) =>
        jsx(Show as never, {
          get when() {
            const sessionID = input.sessionID;
            if (!sessionID) return undefined;
            const s = status[sessionID];
            if (!s) load(sessionID);
            return s;
          },
          children: (s: () => Status) =>
            jsx("text", {
              wrapMode: "none",
              get children() {
                const mode = parseMode(s().mode) ?? "auto";
                const t = context.theme;
                const fg = mode === "bypassPermissions" ? t.text.feedback.warning.base : mode === "auto" ? t.text.muted : t.text.feedback.info.base;
                return [jsx("span", { style: { fg }, children: ` ${footerText(s())}` })];
              },
            }),
        }),
    });

    return () => {
      offChanged();
      offNotice();
    };
  },
});
