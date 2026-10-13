// opencode-context (terminal): `/context` opens a dialog with a usage bar and one row per part of
// the last model request (system prompt, instruction files, skills, tool definitions, tool
// results, conversation, other, free space); Enter or a click on a row opens a scrollable
// preview of that part as the model received it. The breakdown comes from the server half over
// the context RPC; the total is what OpenCode reports for the session's last response, and the
// window is the model's context limit.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { type PartKey, type Report, type ReportRow, type Snapshot, formatTokens, normalizePreviewText, assembleReport } from "./breakdown.ts";
import { ContextRpc, type UpdatedEvent } from "./rpc.ts";
import { type MessageLike, ago, barCells, reportedUsage } from "./usage.ts";

const PREVIEW_KEYS: readonly PartKey[] = ["system", "instructions", "skills", "tools", "toolResults", "conversation"];

export default Plugin.define({
  id: "context.tui",
  setup(context) {
    const rpc = context.client.rpc(ContextRpc);

    const limitFor = (model: { providerID: string; id: string } | undefined): number => {
      if (!model) return 0;
      const route = context.ui.router.current();
      const location = route.type === "session" ? context.data.session.get(route.sessionID)?.location : undefined;
      const models = context.data.location.model.list(location) ?? context.data.location.model.list();
      const found = models?.find((m) => m.providerID === model.providerID && (m.modelID === model.id || m.id === model.id));
      return found?.limit.context ?? 0;
    };

    const load = async (sessionID: string): Promise<{ snapshot: Snapshot; report: Report } | undefined> => {
      // Server halves run once per location: ask the one the session lives in.
      const location = context.data.session.get(sessionID)?.location;
      const result = (await rpc.breakdown({ sessionID }, location ? { location } : {})) as { snapshot?: Snapshot };
      const snapshot = result.snapshot;
      if (!snapshot) return undefined;
      await context.data.session.message.sync(sessionID).catch(() => undefined);
      const usage = reportedUsage(context.data.session.message.list(sessionID) as unknown as MessageLike[]);
      const current = context.ui.model.current();
      const model = snapshot.model ?? usage?.model ?? (current ? { providerID: current.providerID, id: current.modelID } : undefined);
      const report = assembleReport(snapshot.parts, usage?.tokens, limitFor(model));
      return { snapshot, report };
    };

    const open = async () => {
      const route = context.ui.router.current();
      if (route.type !== "session") {
        context.ui.toast.show({ message: "Open a session first", variant: "warning" });
        return;
      }
      const sessionID = route.sessionID;
      let loaded: { snapshot: Snapshot; report: Report } | undefined;
      try {
        loaded = await load(sessionID);
      } catch (error) {
        context.ui.toast.show({ message: `Context breakdown unavailable: ${error instanceof Error ? error.message : String(error)}`, variant: "error" });
        return;
      }
      if (!loaded) {
        context.ui.toast.show({ message: "No model request in this session yet (or the server restarted since the last one)", variant: "info" });
        return;
      }
      const initial = loaded;
      context.ui.dialog.show(
        () => UsageDialog({ context, sessionID, initial, reload: () => load(sessionID) }),
        undefined,
      );
      context.ui.dialog.set({ size: "large", centered: true });
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "context.show",
          title: "Context usage",
          description: "Where the context window goes: system prompt, instructions, skills, tools, tool results, conversation",
          group: "Session",
          palette: true,
          slash: { name: "context" },
          run: () => void open(),
        },
      ],
    }));
  },
});

interface DialogProps {
  context: Plugin.Context;
  sessionID: string;
  initial: { snapshot: Snapshot; report: Report };
  reload: () => Promise<{ snapshot: Snapshot; report: Report } | undefined>;
}

/** The dialog: the usage rows, or the preview of one part. */
function UsageDialog(props: DialogProps) {
  const { context } = props;
  const theme = () => context.theme;
  const [data, setData] = createSignal(props.initial);
  const [selected, setSelected] = createSignal(0);
  const [preview, setPreview] = createSignal<PartKey | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 10_000);
  onCleanup(() => clearInterval(clock));
  let scroller: ScrollBoxRenderable | undefined;

  // A new model request while the dialog is open refreshes it.
  const rpc = context.client.rpc(ContextRpc);
  const off = rpc.events.on("updated", (event: { data: unknown }) => {
    if ((event.data as UpdatedEvent).sessionID !== props.sessionID) return;
    void props.reload().then((next) => next && setData(next));
  });
  onCleanup(off);

  const rows = () => data().report.rows;
  const window = () => data().report.contextWindow;
  const used = () => data().report.used;
  const page = () => Math.max(8, Math.floor(context.renderer.height * 0.6));
  const colors = (): Record<ReportRow["key"], ReturnType<typeof rowColor>> => ({
    system: rowColor(0),
    instructions: rowColor(1),
    skills: rowColor(2),
    tools: rowColor(3),
    toolResults: rowColor(4),
    conversation: rowColor(5),
    other: theme().text.muted,
    free: theme().border.base,
  });
  function rowColor(index: number) {
    const scale = theme().categorical[index % Math.max(1, theme().categorical.length)];
    return scale?.[context.themeMode === "dark" ? 300 : 700] ?? theme().text.base;
  }

  const part = () => data().snapshot.parts.find((p) => p.key === preview());
  const previewText = createMemo(() => {
    const p = part();
    if (!p) return "";
    const items = p.items.length > 1 ? `${p.items.map((i) => `- ${i.label}  ${formatTokens(i.tokens)}`).join("\n")}\n\n---\n\n` : "";
    return normalizePreviewText(items + p.preview);
  });

  const move = (delta: number) => {
    const n = PREVIEW_KEYS.length;
    setSelected((i) => (i + delta + n) % n);
  };
  const openPreview = () => {
    setPreview(PREVIEW_KEYS[selected()]);
    scroller?.scrollTo(0);
  };
  const scroll = (delta: number) => scroller?.scrollBy(delta);

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: preview()
      ? [
          { bind: "escape,left", title: "Back to the usage rows", group: "Context", run: () => setPreview(undefined) },
          { bind: "up,k", title: "Scroll up", group: "Context", run: () => scroll(-1) },
          { bind: "down,j", title: "Scroll down", group: "Context", run: () => scroll(1) },
          { bind: "pageup", title: "Page up", group: "Context", run: () => scroll(-page()) },
          { bind: "pagedown", title: "Page down", group: "Context", run: () => scroll(page()) },
          { bind: "home", title: "Top", group: "Context", run: () => scroller?.scrollTo(0) },
          { bind: "end", title: "Bottom", group: "Context", run: () => scroller?.scrollTo(scroller.scrollHeight) },
        ]
      : [
          { bind: "up,k", title: "Previous part", group: "Context", run: () => move(-1) },
          { bind: "down,j", title: "Next part", group: "Context", run: () => move(1) },
          { bind: "return,right,space", title: "Preview the part", group: "Context", run: openPreview },
        ],
  }));

  const muted = () => theme().text.muted;
  const header = () =>
    jsx("box", {
      flexDirection: "row",
      gap: 2,
      paddingLeft: 2,
      paddingRight: 2,
      get children() {
        const p = part();
        return [
          jsx("text", { flexShrink: 0, get fg() { return theme().text.base; }, children: p ? `Context: ${p.label}` : "Context usage" }),
          jsx("text", {
            wrapMode: "none",
            flexGrow: 1,
            truncate: true,
            get fg() { return muted(); },
            get children() {
              if (p) return `${formatTokens(p.tokens)} tokens estimated${p.truncated ? " · preview cut" : ""}`;
              const pct = window() > 0 ? ` (${((used() / window()) * 100).toFixed(1)}%)` : "";
              return `${formatTokens(used())}${window() > 0 ? ` / ${formatTokens(window())}` : ""} tokens${pct} · request ${ago(data().snapshot.at, now())}`;
            },
          }),
          jsx("text", { flexShrink: 0, get fg() { return muted(); }, onMouseUp: () => (preview() ? setPreview(undefined) : context.ui.dialog.clear()), children: "esc" }),
        ];
      },
    });

  const bar = () =>
    jsx("text", {
      wrapMode: "none",
      get children() {
        const width = Math.max(10, Math.min(72, context.renderer.width - 12));
        const total = window() > 0 ? window() : used();
        const cells = barCells(rows(), total, width);
        return rows().map((row, i) => jsx("span", { style: { fg: colors()[row.key] }, children: "█".repeat(cells[i] ?? 0) }));
      },
    });

  const list = () =>
    jsx("box", {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      gap: 1,
      get children() {
        return [
          bar(),
          jsx("box", {
            flexDirection: "column",
            get children() {
              return jsx(For as never, {
                get each() { return rows(); },
                children: (row: ReportRow, index: () => number) => {
                  const selectable = () => index() < PREVIEW_KEYS.length;
                  const isSelected = () => selectable() && index() === selected();
                  return jsx("box", {
                    flexDirection: "row",
                    onMouseUp: () => {
                      if (!selectable()) return;
                      setSelected(index());
                      openPreview();
                    },
                    get backgroundColor() { return isSelected() ? theme().background.raised.high : undefined; },
                    get children() {
                      const pct = window() > 0 ? `${((row.tokens / window()) * 100).toFixed(1).padStart(5)}%` : "";
                      return jsx("text", {
                        wrapMode: "none",
                        get children() {
                          return [
                            jsx("span", { style: { fg: theme().text.base }, children: isSelected() ? "› " : "  " }),
                            jsx("span", { style: { fg: colors()[row.key] }, children: "■ " }),
                            jsx("span", { style: { fg: selectable() ? theme().text.base : muted() }, children: row.label.padEnd(18) }),
                            jsx("span", { style: { fg: theme().text.base }, children: formatTokens(row.tokens).padStart(8) }),
                            jsx("span", { style: { fg: muted() }, children: pct ? `  ${pct}` : "" }),
                          ];
                        },
                      });
                    },
                  });
                },
              });
            },
          }),
          jsx("text", {
            get fg() { return muted(); },
            get children() {
              const s = data().snapshot;
              return `${s.agent} · ${s.model.providerID}/${s.model.id} · ${s.messages} messages in the request · per-part counts are estimates (characters / 4)`;
            },
          }),
        ];
      },
    });

  const body = () =>
    jsx("scrollbox", {
      ref: (el: ScrollBoxRenderable) => (scroller = el),
      get height() { return page(); },
      contentOptions: { minHeight: 0 },
      get scrollbarOptions() {
        return { trackOptions: { backgroundColor: theme().background.raised.base, foregroundColor: theme().scrollbar.base } };
      },
      get children() {
        return jsx("box", {
          paddingLeft: 2,
          paddingRight: 2,
          get children() {
            return jsx("text", { wrapMode: "word", get fg() { return theme().text.base; }, get children() { return previewText(); } });
          },
        });
      },
    });

  const footer = () =>
    jsx("box", {
      paddingLeft: 2,
      paddingRight: 2,
      get children() {
        return jsx("text", {
          get fg() { return muted(); },
          get children() {
            return preview() ? "↑↓ PgUp/PgDn Home/End scroll · esc back" : "↑↓ select · enter or click to preview · esc close";
          },
        });
      },
    });

  return jsx("box", {
    flexDirection: "column",
    gap: 1,
    paddingBottom: 1,
    get children() {
      return [
        header(),
        jsx(Show as never, {
          get when() { return preview() === undefined; },
          get fallback() { return body(); },
          get children() { return list(); },
        }),
        footer(),
      ];
    },
  });
}
