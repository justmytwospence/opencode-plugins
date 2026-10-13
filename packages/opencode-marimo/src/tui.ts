// opencode-marimo (terminal): the current notebook and what its kernel is running, right after
// the footer's own `dir:branch` (`marimo fit.py · 1 error`, `marimo ▸ Model fit 12s`); every
// followed notebook in the session sidebar; and `/marimo` to choose the notebooks followed, or
// `/marimo auto|off|show`. Everything comes from the server half over the marimo RPC: the report
// of the session this terminal shows, re-read whenever the server says something changed.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createSignal } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { statusText } from "./core/render.ts";
import { MarimoRpc, type ModeInput, type Report } from "./rpc.ts";
import { type Segment, segments, sidebarLines, ticking, view } from "./status.ts";

/** `/marimo <arg>`: the argument, whether the prompt's text or the argument alone arrives. */
export function commandArg(input: string | undefined): string {
  return (input ?? "").trim().replace(/^\/marimo\b/, "").trim();
}

export default Plugin.define({
  id: "marimo.tui",
  setup(context) {
    const rpc = context.client.rpc(MarimoRpc);
    const [report, setReport] = createSignal<Report | undefined>(undefined);
    const [now, setNow] = createSignal(Date.now());

    const sessionID = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const directory = (): string => {
      const id = sessionID();
      const dir = id ? context.data.session.get(id)?.location?.directory : undefined;
      return dir ?? (context.location ?? context.data.location.default()).directory;
    };
    // The server half runs once per location: calls go to the one of the directory shown.
    const at = () => ({ location: { directory: directory() } });

    let generation = 0;
    const load = async (): Promise<void> => {
      const mine = ++generation;
      try {
        const result = (await rpc.status({ sessionID: sessionID() ?? "" }, at())) as unknown as { report: Report };
        if (mine === generation) setReport(result.report);
      } catch {
        if (mine === generation) setReport(undefined);
      }
    };
    createEffect(() => {
      sessionID();
      void load();
    });
    const offChanged = rpc.events.on("changed", (event) => {
      const where = (event as { location?: { directory?: string } }).location?.directory;
      if (where && where !== directory()) return;
      void load();
    });

    // The elapsed time of a running cell ticks here; the server reports when it started.
    let ticker: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
      const needed = ticking(report());
      if (needed && !ticker) ticker = setInterval(() => setNow(Date.now()), 1000);
      if (!needed && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
    });

    const color = (name: Segment["color"]) => {
      const t = context.theme;
      if (name === "error" || name === "warning") return t.text.feedback[name].base;
      if (name === "accent") return t.text.action.primary.base;
      return t.text.muted;
    };
    const spans = (line: Segment[]) => line.map((s) => jsx("span", { style: { fg: color(s.color) }, children: s.text }));

    const status = () =>
      jsx(Show as never, {
        get when() {
          return segments(view(report(), now()));
        },
        children: (line: () => Segment[]) =>
          jsx("text", {
            wrapMode: "none",
            get children() {
              return spans(line());
            },
          }),
      });
    // The prompt footer (and its status) shows on the home screen too, so that slot alone suffices.
    context.ui.slot({ append: "prompt.footer.status", render: status });

    context.ui.slot({
      append: "sidebar.content",
      render: () =>
        jsx(For as never, {
          get each() {
            return sidebarLines(report(), now()) ?? [];
          },
          children: (line: Segment[]) =>
            jsx("text", {
              wrapMode: "none",
              get children() {
                return spans(line);
              },
            }),
        }),
    });

    const setMode = async (mode: ModeInput, message: string): Promise<void> => {
      await rpc.setMode({ mode }, at());
      context.ui.toast.show({ message, variant: "info" });
    };

    const choose = async (): Promise<void> => {
      const current = (await rpc.mode({}, at())) as unknown as { mode: ModeInput };
      const listed = (await rpc.list({}, at())) as unknown as { notebooks: { path: string; url: string }[] };
      const open = [...new Map(listed.notebooks.map((n) => [n.path, n])).values()];
      const pinned = new Set(current.mode.kind === "pinned" ? current.mode.paths : []);
      for (const p of pinned) if (!open.some((n) => n.path === p)) open.push({ path: p, url: "" });
      for (;;) {
        const options = [
          { title: "Done", value: "done", description: pinned.size ? `follow the ${pinned.size} picked` : "follow every notebook open under this directory" },
          ...open.map((n) => ({ title: `${pinned.has(n.path) ? "[x]" : "[ ]"} ${context.ui.format.path(n.path)}`, value: `nb:${n.path}`, description: n.url ? n.url : "not open" })),
          { title: "Auto", value: "auto", description: `every notebook open under ${context.ui.format.path(directory())}` },
          { title: "Off", value: "off", description: "stop following notebooks" },
        ];
        const choice = await context.ui.dialog.select<string>({ title: "Notebooks to follow (pick to toggle)", options });
        if (choice === undefined) return;
        if (choice === "auto") return setMode({ kind: "auto" }, "marimo: following every notebook open under this directory");
        if (choice === "off") return setMode({ kind: "off" }, "marimo: off");
        if (choice === "done") {
          return pinned.size
            ? setMode({ kind: "pinned", paths: [...pinned] }, `marimo: following ${[...pinned].map((p) => context.ui.format.path(p)).join(", ")}`)
            : setMode({ kind: "auto" }, "marimo: following every notebook open under this directory");
        }
        const path = choice.slice(3);
        if (pinned.has(path)) pinned.delete(path);
        else pinned.add(path);
      }
    };

    const run = async (input?: string): Promise<void> => {
      const arg = commandArg(input);
      try {
        if (arg === "auto") return await setMode({ kind: "auto" }, "marimo: following every notebook open under this directory");
        if (arg === "off") return await setMode({ kind: "off" }, "marimo: off");
        if (arg === "show") {
          const { text } = (await rpc.snapshot({ sessionID: sessionID() ?? "" }, at())) as unknown as { text: string };
          const v = view(report(), Date.now());
          const fallback = v.parts ? statusText(v.parts) : v.note ? `marimo: ${v.note}` : "marimo: no notebook attached";
          await context.ui.dialog.alert({ title: "marimo", message: text || fallback });
          return;
        }
        await choose();
      } catch (error) {
        context.ui.toast.show({ message: `marimo: ${error instanceof Error ? error.message : String(error)}`, variant: "error" });
      }
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "marimo.notebooks",
          title: "marimo: choose the notebooks followed",
          description: "Pin notebooks, follow every one open under the directory (auto), turn it off, or show the state block",
          group: "marimo",
          palette: true,
          slash: { name: "marimo", arguments: true },
          run: (input) => run(input),
        },
      ],
    }));

    return () => {
      offChanged();
      if (ticker) clearInterval(ticker);
    };
  },
});
