// opencode-bg (terminal): a count of the shown session's background shells right after the
// footer's own `dir:branch` (`2 shells`, plus `1 failed` in the error color while a failure you
// have not seen is there, until your next message), and `/bg` (also `/tasks`, `/bashes`, `/ps`,
// and the palette), a session panel listing the session family's tasks with the selected one's
// log tail: j/k select, x stops a running task, c hides ended ones, f toggles full screen, q or
// Esc closes. Everything comes from the server half over the bg RPC.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { type TaskView, pill } from "./format.ts";
import { BgRpc, type ChangedEvent } from "./rpc.ts";
import { type Color, type Segment, commandLine, ordered, row, summary } from "./view.ts";

export const PANEL = "bg";
const LOG_LINES = 12;

export default Plugin.define({
  id: "bg.tui",
  setup(context) {
    const rpc = context.client.rpc(BgRpc);
    const [tasks, setTasks] = createSignal<TaskView[]>([]);
    const [now, setNow] = createSignal(Date.now());
    /** When the user last sent a message: failures before it no longer alert. */
    const [seenAt, setSeenAt] = createSignal(0);

    const sessionID = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    /** The shown session and its subagents: tasks started by any of them are listed. */
    const family = (): string[] => {
      const id = sessionID();
      if (!id) return [];
      let ids: string[] = [];
      try {
        ids = context.data.session.family(id);
      } catch {
        // No hierarchy known.
      }
      return [...new Set([id, ...ids])];
    };
    const directory = (): string => {
      const id = sessionID();
      const dir = id ? context.data.session.get(id)?.location?.directory : undefined;
      return dir ?? (context.location ?? context.data.location.default()).directory;
    };
    // The server half runs once per location: calls go to the instance of the directory shown.
    const at = () => ({ location: { directory: directory() } });

    let generation = 0;
    const load = async (): Promise<void> => {
      const mine = ++generation;
      const ids = family();
      if (!ids.length) {
        setTasks([]);
        return;
      }
      try {
        const result = (await rpc.tasks({ sessionIDs: ids }, at())) as unknown as { tasks: TaskView[] };
        if (mine === generation) setTasks(result.tasks);
      } catch {
        if (mine === generation) setTasks([]);
      }
    };
    createEffect(() => {
      sessionID();
      void load();
    });
    const offChanged = rpc.events.on("changed", (event) => {
      const where = (event as { location?: { directory?: string } }).location?.directory;
      if (where && where !== directory()) return;
      if (family().includes((event.data as unknown as ChangedEvent).sessionID)) void load();
    });
    const offInbox = context.data.on("session.inbox.enqueued", (event) => {
      const data = event.data as { sessionID?: string; item?: { type?: string } };
      if (data.item?.type === "user" && data.sessionID && family().includes(data.sessionID)) setSeenAt(Date.now());
    });

    // Runtimes tick while something runs.
    let ticker: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
      const needed = tasks().some((t) => t.status === "running") || context.ui.panel.current()?.name === PANEL;
      if (needed && !ticker) ticker = setInterval(() => setNow(Date.now()), 1000);
      if (!needed && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
    });

    const color = (name: Color) => {
      const t = context.theme;
      if (name === "error" || name === "warning" || name === "success") return t.text.feedback[name].base;
      if (name === "accent") return t.text.action.primary.base;
      if (name === "muted") return t.text.muted;
      return t.text.base;
    };
    const spans = (line: Segment[]) => line.map((s) => jsx("span", { style: { fg: color(s.color) }, children: s.text }));
    const line = (segments: () => Segment[]) =>
      jsx("text", {
        wrapMode: "none",
        get children() {
          return spans(segments());
        },
      });

    context.ui.slot({
      append: "prompt.footer.status",
      render: () =>
        jsx(Show as never, {
          get when() {
            return pill(tasks(), seenAt());
          },
          children: (p: () => NonNullable<ReturnType<typeof pill>>) =>
            line(() => [
              { text: p().label, color: "muted" },
              ...(p().alert ? [{ text: ` · ${p().alert}`, color: "error" as const }] : []),
            ]),
        }),
    });

    /** The panel's contents; its keymap layer lives and dies with it. */
    const Panel = (props: { panel: PanelInput }) => {
      const [selected, setSelected] = createSignal(0);
      const [log, setLog] = createSignal<string[]>([]);
      const list = () => ordered(tasks());
      const current = (): TaskView | undefined => list()[Math.min(selected(), Math.max(0, list().length - 1))];
      const move = (delta: number) => {
        const n = list().length;
        if (!n) return;
        setSelected((i) => (Math.min(i, n - 1) + delta + n) % n);
      };

      let logGeneration = 0;
      const readLog = async (): Promise<void> => {
        const t = current();
        const mine = ++logGeneration;
        if (!t) {
          setLog([]);
          return;
        }
        try {
          const result = (await rpc.logs({ id: t.id, lines: LOG_LINES }, at())) as unknown as { lines: string[] };
          if (mine === logGeneration) setLog(result.lines);
        } catch {
          if (mine === logGeneration) setLog([]);
        }
      };
      createEffect(() => {
        current()?.id;
        tasks();
        now();
        void readLog();
      });

      const stop = async () => {
        const t = current();
        if (!t || t.status !== "running") return;
        const ok = await context.ui.dialog.confirm({ title: "Stop background task", message: `Stop ${t.name} (${t.id})? SIGTERM to its process group, SIGKILL after 3 seconds.` });
        if (!ok) return;
        const result = (await rpc.kill({ id: t.id }, at())) as unknown as { message: string };
        context.ui.toast.show({ message: `bg: ${result.message}`, variant: "info" });
      };
      const clear = async () => {
        const result = (await rpc.clear({ sessionIDs: family() }, at())) as unknown as { count: number };
        context.ui.toast.show({ message: result.count ? `bg: cleared ${result.count} ended task${result.count === 1 ? "" : "s"}` : "bg: nothing to clear", variant: "info" });
        setSelected(0);
      };

      context.keymap.layer(() => ({
        commands: [
          { bind: "j", run: () => move(1) },
          { bind: "down", run: () => move(1) },
          { bind: "k", run: () => move(-1) },
          { bind: "up", run: () => move(-1) },
          { bind: "x", run: () => void stop() },
          { bind: "c", run: () => void clear() },
          { bind: "f", run: () => props.panel.toggleFullscreen() },
          { bind: "q", run: () => props.panel.close() },
          { bind: "escape", run: () => props.panel.close() },
        ],
      }));
      onCleanup(() => {
        logGeneration++;
      });

      return jsx("box", {
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        children: [
          line(() => [
            { text: "Background tasks", color: "base" },
            { text: `  ${summary(tasks())}`, color: "muted" },
          ]),
          jsx("text", { children: " " }),
          jsx(Show as never, {
            get when() {
              return list().length === 0;
            },
            children: line(() => [{ text: "  No background tasks in this session.", color: "muted" }]),
          }),
          jsx(For as never, {
            get each() {
              return list();
            },
            children: (t: TaskView, index: () => number) =>
              jsx("box", {
                flexDirection: "column",
                children: [
                  line(() => row(t, now(), index() === Math.min(selected(), Math.max(0, list().length - 1)))),
                  line(() => [{ text: commandLine(t, props.panel.width - 2), color: "muted" }]),
                ],
              }),
          }),
          jsx(Show as never, {
            get when() {
              return current();
            },
            children: (t: () => TaskView) =>
              jsx("box", {
                flexDirection: "column",
                marginTop: 1,
                children: [
                  line(() => [{ text: `${t().name}: last ${LOG_LINES} lines of ${t().logPath}`, color: "muted" }]),
                  jsx(For as never, {
                    get each() {
                      return log();
                    },
                    children: (text: string) => jsx("text", { wrapMode: "none", children: text || " " }),
                  }),
                ],
              }),
          }),
          jsx("box", {
            flexGrow: 1,
          }),
          line(() => [{ text: "j/k select · x stop · c clear ended · f full screen · q close", color: "muted" }]),
        ],
      });
    };

    context.ui.slot({
      append: "session.panel",
      render: (panel) =>
        jsx(Show as never, {
          get when() {
            return panel.name === PANEL;
          },
          children: () => jsx(Panel as never, { panel }),
        }),
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "bg.open",
          title: "Background tasks",
          description: "The session's background jobs and services, with their logs",
          group: "Session",
          palette: true,
          slash: { name: "bg", aliases: ["tasks", "bashes", "ps"] },
          run: () => {
            if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ message: "bg: open a session first", variant: "warning" });
          },
        },
      ],
    }));

    return () => {
      if (ticker) clearInterval(ticker);
      offChanged();
      offInbox();
    };
  },
});
