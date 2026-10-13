// opencode-copy (terminal): `/yank` opens a picker of things to copy from the session shown:
// whole messages and the pieces inside replies (sections, code, commands, paths, URLs, tables,
// lists, quotes, commit messages, paragraphs; segments.ts), found in code. The server half ranks
// them with Jev over the `copy` RPC (rank.ts; the picker opens at once, in recency order, and
// reorders when the ranking arrives); prose Jev judges not worth pasting leaves Suggested.
//
// The picker is OpenCode's select dialog: typing filters (fuzzy), the footer actions switch
// Suggested/All and open a preview of the highlighted piece (a scrollable dialog: Enter copies,
// Esc or left returns to the picker), Enter copies and closes. The copy goes through OpenCode's
// own clipboard route (OpenTUI's host clipboard and OSC 52, both). OpenCode's `/copy` (the last
// reply) is left as it is.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import { type ClipboardService, type ScrollBoxRenderable, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { type Ranking, type Row, type Tab, BADGE, copiedMessage, dialogTitle, fuzzyFilter, rowFor } from "./picker.ts";
import { DEFAULT_RANK, type Judged, type RankSettings, chronological, piecesToJudge, suggested } from "./rank.ts";
import { CopyRpc, type RankOutput } from "./rpc.ts";
import { type Segment, extractSegments, segmentKey } from "./segments.ts";
import { loadSettings } from "./settings.ts";
import { type MessageLike, recentUserMessages, toEntries } from "./transcript.ts";

export const NAME = "copy";

export interface CopySettings {
  jev: { enabled: boolean; model: string; timeoutMs: number };
  rank: RankSettings;
  /** User turns the picker covers. */
  maxTurns: number;
  /** The command's key binding; `false` or empty for none. */
  shortcut: string | false;
}

export const DEFAULT_SETTINGS: CopySettings = {
  jev: { enabled: true, model: "jev-latest", timeoutMs: 3_000 },
  rank: DEFAULT_RANK,
  maxTurns: 30,
  shortcut: "ctrl+shift+x",
};

/** Characters of a piece the preview dialog draws (the copy uses the whole text). */
const PREVIEW_CHARS = 20_000;

type PreviewOutcome = "copy" | "back" | undefined;

/** OpenCode's select option, which @opencode/plugin/tui does not export: the title, value and footer of a row. */
type SelectOption = { readonly title: string; readonly value: string; readonly footer?: string; readonly description?: string; readonly category?: string; readonly disabled?: boolean };

export default Plugin.define({
  id: "copy.tui",
  setup(context) {
    const rpc = context.client.rpc(CopyRpc);
    let clipboard: ClipboardService | undefined;
    /** Jev's judgments by piece content, per session, for this terminal's lifetime. */
    const judgments = new Map<string, Map<string, Judged>>();

    const directoryOf = (sessionID?: string) => {
      const dir = sessionID ? context.data.session.get(sessionID)?.location?.directory : undefined;
      return dir ?? (context.location ?? context.data.location.default()).directory;
    };
    const settingsFor = (sessionID?: string) => loadSettings(NAME, DEFAULT_SETTINGS, context.options as Record<string, unknown>, directoryOf(sessionID));
    const toast = (message: string, variant: "info" | "warning" | "error" = "info") => context.ui.toast.show({ message, variant });

    const copy = async (segment: Segment) => {
      try {
        clipboard ??= createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(context.renderer) });
        const result = await clipboard.writeText(segment.text.replaceAll("\0", ""), { destination: "all-available", selection: "clipboard" });
        if (result.host.status === "failed") throw result.host.error;
        if (result.host.status !== "written" && result.terminal.status !== "attempted") throw new Error(`host ${result.host.status}, terminal ${result.terminal.status}`);
        toast(copiedMessage(segment));
      } catch (error) {
        toast(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };

    const open = async () => {
      const route = context.ui.router.current();
      if (route.type !== "session") {
        toast("Open a session first.", "warning");
        return;
      }
      const sessionID = route.sessionID;
      const settings = settingsFor(sessionID);
      await context.data.session.message.sync(sessionID).catch(() => undefined);
      const entries = toEntries(context.data.session.message.list(sessionID) as unknown as MessageLike[]);
      const segments = extractSegments(entries, settings.maxTurns);
      if (!segments.length) {
        toast("Nothing to copy yet.");
        return;
      }
      const judged = judgments.get(sessionID) ?? new Map<string, Judged>();
      judgments.set(sessionID, judged);

      // Ranking: ask for the newest pieces not judged yet; the picker does not wait for it.
      const pending = settings.jev.enabled ? piecesToJudge(segments, settings.rank).filter((s) => !judged.has(segmentKey(s))) : [];
      const [ranking, setRanking] = createSignal<Ranking>(pending.length ? "pending" : judged.size ? "done" : "unavailable");
      const [version, setVersion] = createSignal(0);
      const controller = new AbortController();
      if (pending.length) {
        const location = context.data.session.get(sessionID)?.location;
        rpc
          .rank(
            {
              sessionID,
              pieces: pending.map((s) => ({ id: s.id, kind: s.kind, text: s.text, ...(s.lang ? { lang: s.lang } : {}) })),
              recent: recentUserMessages(entries),
              pieceChars: settings.rank.pieceChars,
              model: settings.jev.model,
              timeoutMs: settings.jev.timeoutMs,
            },
            { signal: controller.signal, ...(location ? { location } : {}) },
          )
          .then((result) => {
            const out = result as RankOutput;
            if (!out.ok) {
              setRanking(judged.size ? "done" : "unavailable");
              return;
            }
            for (const j of out.judged) judged.set(j.key, { want: j.want, ...(j.copyable !== undefined ? { copyable: j.copyable } : {}) });
            setRanking("done");
            setVersion((v) => v + 1);
          })
          .catch(() => setRanking(judged.size ? "done" : "unavailable"));
      }

      const chosen = await pick(segments, judged, settings.rank, ranking, version);
      controller.abort();
      if (chosen) {
        context.ui.dialog.clear();
        await copy(chosen);
      }
    };

    /** The picker, and the preview it hands over to, until a piece is chosen or the dialog closed. */
    const pick = async (segments: Segment[], judged: Map<string, Judged>, rank: RankSettings, ranking: () => Ranking, version: () => number): Promise<Segment | undefined> => {
      const byId = new Map(segments.map((s) => [s.id, s]));
      const lastTurn = Math.max(0, ...segments.map((s) => s.turn));
      const [tab, setTab] = createSignal<Tab>("suggested");
      const rows = (): Row[] => {
        version();
        const list = tab() === "suggested" ? suggested(segments, judged, rank) : chronological(segments);
        return list.map((s) => rowFor(s, lastTurn));
      };
      let current: string | undefined;
      for (;;) {
        // Set by the preview action before it replaces the picker with the preview dialog.
        let handoff: { segment: Segment; outcome: Promise<PreviewOutcome> } | undefined;
        const options = {
          get title() {
            return dialogTitle(tab(), ranking(), rows().length);
          },
          placeholder: "Filter",
          get options() {
            return rows();
          },
          ...(current ? { current } : {}),
          search: (query: string, items: readonly SelectOption[]) => fuzzyFilter(items, query, (row) => `${row.footer ?? ""} ${row.title}`),
          actions: [
            { bind: "ctrl+t", title: "suggested/all", selection: "none" as const, onTrigger: () => setTab((t) => (t === "suggested" ? "all" : "suggested")) },
            {
              bind: "right",
              title: "preview",
              onTrigger: (value: string) => {
                const segment = byId.get(value);
                if (!segment) return;
                handoff = { segment, outcome: showPreview(segment) };
              },
            },
          ],
        };
        const selection = context.ui.dialog.select<string>(options);
        context.ui.dialog.set({ size: "large" });
        const id = await selection;
        if (id !== undefined) return byId.get(id);
        if (!handoff) return undefined;
        const outcome = await handoff.outcome;
        if (outcome === "copy") return handoff.segment;
        if (outcome !== "back") return undefined;
        current = handoff.segment.id;
      }
    };

    /** The preview dialog of one piece; resolves with what the user did. */
    const showPreview = (segment: Segment): Promise<PreviewOutcome> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (outcome: PreviewOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        context.ui.dialog.show(
          () => PreviewDialog({ context, segment, done }),
          () => done(undefined),
        );
        context.ui.dialog.set({ size: "large" });
      });

    const shortcut = settingsFor().shortcut;
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "copy.yank",
          title: "Copy from this session",
          description: "Pick a reply, code block, command, path or URL from this session to copy",
          group: "Session",
          palette: true,
          slash: { name: "yank" },
          bind: typeof shortcut === "string" && shortcut.trim() ? shortcut : false,
          run: () => void open(),
        },
      ],
    }));

    return () => {
      void clipboard?.dispose().catch(() => undefined);
    };
  },
});

interface PreviewProps {
  context: Plugin.Context;
  segment: Segment;
  done: (outcome: PreviewOutcome) => void;
}

/** One piece in full, scrollable: Enter copies it, Esc or left goes back to the picker. */
function PreviewDialog(props: PreviewProps) {
  const { context, segment } = props;
  const theme = () => context.theme;
  const muted = () => theme().text.muted;
  let scroller: ScrollBoxRenderable | undefined;
  const page = () => Math.max(6, Math.floor(context.renderer.height * 0.6));
  const text = segment.text.length > PREVIEW_CHARS ? `${segment.text.slice(0, PREVIEW_CHARS)}\n\n[... ${segment.text.length - PREVIEW_CHARS} more characters]` : segment.text;
  const lines = segment.text.split("\n").length;
  const what = `${BADGE[segment.kind]}${segment.lang ? ` (${segment.lang})` : ""} · ${lines} line${lines === 1 ? "" : "s"} · ${segment.text.length} chars`;

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      { bind: "return", title: "Copy", group: "Copy", run: () => props.done("copy") },
      { bind: "escape,left", title: "Back to the picker", group: "Copy", run: () => props.done("back") },
      { bind: "up,k", title: "Scroll up", group: "Copy", run: () => scroller?.scrollBy(-1) },
      { bind: "down,j", title: "Scroll down", group: "Copy", run: () => scroller?.scrollBy(1) },
      { bind: "pageup", title: "Page up", group: "Copy", run: () => scroller?.scrollBy(-page()) },
      { bind: "pagedown", title: "Page down", group: "Copy", run: () => scroller?.scrollBy(page()) },
      { bind: "home", title: "Top", group: "Copy", run: () => scroller?.scrollTo(0) },
      { bind: "end", title: "Bottom", group: "Copy", run: () => scroller?.scrollTo(scroller.scrollHeight) },
    ],
  }));

  return jsx("box", {
    flexDirection: "column",
    gap: 1,
    paddingBottom: 1,
    get children() {
      return [
        jsx("box", {
          flexDirection: "row",
          gap: 2,
          paddingLeft: 2,
          paddingRight: 2,
          get children() {
            return [
              jsx("text", { flexShrink: 0, get fg() { return theme().text.base; }, children: "Copy: preview" }),
              jsx("text", { wrapMode: "none", flexGrow: 1, truncate: true, get fg() { return muted(); }, children: what }),
              jsx("text", { flexShrink: 0, get fg() { return muted(); }, onMouseUp: () => props.done("back"), children: "esc" }),
            ];
          },
        }),
        jsx("scrollbox", {
          ref: (el: ScrollBoxRenderable) => (scroller = el),
          get maxHeight() { return page(); },
          flexShrink: 1,
          contentOptions: { minHeight: 0 },
          get scrollbarOptions() {
            return { trackOptions: { backgroundColor: theme().background.raised.base, foregroundColor: theme().scrollbar.base } };
          },
          get children() {
            return jsx("box", {
              paddingLeft: 2,
              paddingRight: 2,
              get children() {
                return jsx("text", { wrapMode: "word", get fg() { return theme().text.base; }, children: text });
              },
            });
          },
        }),
        jsx("box", {
          paddingLeft: 2,
          paddingRight: 2,
          get children() {
            return jsx("text", { get fg() { return muted(); }, children: "enter copy · ↑↓ PgUp/PgDn scroll · esc or ← back" });
          },
        }),
      ];
    },
  });
}
