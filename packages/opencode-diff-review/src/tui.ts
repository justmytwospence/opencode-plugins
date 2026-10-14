// opencode-diff-review (terminal): `/diff-review` opens a session panel with the diff of what the
// agent changed (every turn since your last review mark by default; also the last turn, the
// whole session, the working tree against HEAD or the base branch), to read with vim keys and
// annotate: `c` comments on a line, a selection, a hunk or a file, `s` suggests a replacement
// for the selected lines, `l` lists the comments to edit or delete, and `w` sends every draft
// to the agent as one message, formatted like pi-diff-review's, which asks for one tagged reply
// line per comment; those replies show up under the comments when the run ends. Comments and
// the review mark are kept per session in the terminal's durable storage.
//
// Everything here runs in the terminal: OpenCode's `session.diff` provides the per-turn diffs
// (it snapshots the working tree around each turn), `vcs.diff` the repository ones, and
// `session.prompt` with `delivery: "queue"` delivers the comments without interrupting a run.
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import type { RGBA, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { type MessageLike, assistantText, userMessages } from "./messages.ts";
import { type Row, type Selection, hunkSpan, layout, nextOfKind, selectionFromRows, threadAt } from "./model.ts";
import { type FileDiff, filePath, parsePatches } from "./parse.ts";
import { type Mark, SCOPES, type ScopeKind, type ScopeRequest, type UserMessage, defaultScope, parseScopeArgs, resolveRange } from "./review.ts";
import { type Thread, attachReplies, buildPrompt, location, newThreadId } from "./threads.ts";
import { type Color, HINTS, KEYS, type Segment, numberWidth, paintRow, summary } from "./view.ts";

export const PANEL = "review";
const CONTEXT_LINES = 3;
const MAX_FILE_LINES = 1500;

interface SessionReview {
  threads: Thread[];
  mark?: Mark;
}

interface ReviewStore {
  sessions: Record<string, SessionReview>;
}

interface ReviewData {
  scope: ScopeRequest;
  label: string;
  files: FileDiff[];
  /** The user message whose turn the view ends with: what `m` marks reviewed. */
  through?: string;
}

export default Plugin.define({
  id: "diff-review.tui",
  setup(context) {
    const [store, update] = context.storage.store<ReviewStore>("review", { initial: { sessions: {} } });

    const threadsOf = (sessionID: string): Thread[] => store.sessions[sessionID]?.threads ?? [];
    const markOf = (sessionID: string): Mark | undefined => store.sessions[sessionID]?.mark;
    const setThreads = (sessionID: string, next: Thread[]) =>
      update((draft) => {
        const s = (draft.sessions[sessionID] ??= { threads: [] });
        s.threads = next;
      });
    const copyThreads = (sessionID: string): Thread[] => JSON.parse(JSON.stringify(threadsOf(sessionID))) as Thread[];

    const sessionID = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const locationOf = (id: string) => context.data.session.get(id)?.location ?? context.location ?? context.data.location.default();

    const users = async (id: string): Promise<UserMessage[]> => {
      await context.data.session.message.sync(id).catch(() => undefined);
      return userMessages(context.data.session.message.list(id) as unknown as MessageLike[]);
    };

    const load = async (id: string, req: ScopeRequest): Promise<ReviewData | string> => {
      const list = await users(id);
      const range = resolveRange(req, list, markOf(id));
      if (typeof range === "string") return range;
      let patches: { file: string; patch: string; status: "added" | "deleted" | "modified" }[];
      if (range.kind === "turns") {
        patches = await context.client.session.diff({ sessionID: id, from: range.from, to: range.to, context: CONTEXT_LINES });
      } else {
        const result = await context.client.vcs.diff({ mode: range.mode, context: CONTEXT_LINES, location: { directory: locationOf(id).directory } });
        patches = result.data;
      }
      const through = range.kind === "turns" ? (range.to ?? range.from) : list[list.length - 1]?.id;
      return { scope: req, label: range.label, files: parsePatches(patches), through };
    };

    // The agent's tagged replies attach to the comments they answer when its run ends.
    const settle = async (id: string) => {
      const sent = threadsOf(id).filter((t) => t.status === "sent");
      if (!sent.length) return;
      await context.data.session.message.sync(id).catch(() => undefined);
      const since = Math.min(...sent.map((t) => t.sentAt ?? 0));
      const text = assistantText(context.data.session.message.list(id) as unknown as MessageLike[], since);
      const next = copyThreads(id);
      if (attachReplies(next, text)) await setThreads(id, next);
    };
    const offSettled = context.data.on("session.execution.succeeded", (event) => void settle(event.data.sessionID));
    const offDeleted = context.data.on("session.deleted", (event) =>
      void update((draft) => {
        delete draft.sessions[event.data.sessionID];
      }),
    );

    const color = (name: Color) => {
      const t = context.theme;
      switch (name) {
        case "error":
        case "warning":
        case "success":
        case "info":
          return t.text.feedback[name].base;
        case "accent":
          return t.text.action.primary.base;
        case "muted":
          return t.text.muted;
        default:
          return t.text.base;
      }
    };
    const spans = (line: Segment[]) => line.map((s) => jsx("span", { style: { fg: color(s.color), ...(s.bold ? { attributes: 1 } : {}) }, children: s.text }));
    const line = (segments: () => Segment[], bg?: () => RGBA | string | undefined) =>
      jsx("text", {
        wrapMode: "none",
        get bg() {
          return bg?.();
        },
        get children() {
          return spans(segments());
        },
      });

    /**
     * A multi-line editor dialog. OpenCode's input keybinds apply to the textarea: Enter submits,
     * shift/ctrl/alt+Enter or ctrl+j inserts a newline, esc cancels.
     */
    const edit = (opts: { title: string; description?: string; value?: string; placeholder?: string; lines?: number }): Promise<string | undefined> =>
      new Promise((resolve) => {
        let settled = false;
        let area: TextareaRenderable | undefined;
        const finish = (value: string | undefined) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const submit = () => {
          finish(area?.plainText ?? "");
          context.ui.dialog.clear();
        };
        context.ui.dialog.show(
          () => {
            context.keymap.layer(() => ({
              mode: "modal",
              priority: 1,
              commands: [{ bind: "ctrl+s", title: "Submit", group: "Dialog", run: submit }],
            }));
            const t = context.theme;
            return jsx("box", {
              flexDirection: "column",
              paddingLeft: 2,
              paddingRight: 2,
              paddingBottom: 1,
              gap: 1,
              children: [
                jsx("box", {
                  flexDirection: "row",
                  justifyContent: "space-between",
                  children: [
                    jsx("text", { fg: t.text.base, attributes: 1, children: opts.title }),
                    jsx("text", { fg: t.text.muted, children: "esc" }),
                  ],
                }),
                ...(opts.description ? [jsx("text", { fg: t.text.muted, wrapMode: "word", children: opts.description })] : []),
                jsx("textarea", {
                  ref: (el: TextareaRenderable) => {
                    area = el;
                    setTimeout(() => {
                      if (!el.isDestroyed) {
                        el.focus();
                        el.gotoBufferEnd();
                      }
                    }, 1);
                  },
                  initialValue: opts.value ?? "",
                  placeholder: opts.placeholder ?? "",
                  placeholderColor: t.text.muted,
                  textColor: t.text.formfield.base,
                  focusedTextColor: t.text.formfield.base,
                  backgroundColor: t.background.formfield.base,
                  focusedBackgroundColor: t.background.formfield.base,
                  height: Math.max(3, Math.min(opts.lines ?? 6, Math.floor(context.renderer.height * 0.5))),
                  wrapMode: "none",
                  onSubmit: submit,
                }),
                jsx("text", { fg: t.text.muted, children: "enter submit · shift+enter newline · esc cancel" }),
              ],
            });
          },
          () => finish(undefined),
        );
        context.ui.dialog.set({ size: "large" });
      });

    /** The panel's contents; its keymap layer lives and dies with it. */
    const Panel = (props: { panel: PanelInput }) => {
      const id = props.panel.sessionID;
      const [data, setData] = createSignal<ReviewData | undefined>(undefined);
      const [status, setStatus] = createSignal<string>("loading…");
      const [cursor, setCursor] = createSignal(0);
      const [anchor, setAnchor] = createSignal<number | undefined>(undefined);
      const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
      const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
      let scroller: ScrollBoxRenderable | undefined;
      let generation = 0;

      const threads = () => threadsOf(id);
      const byId = createMemo(() => new Map(threads().map((t) => [t.id, t])));
      const files = () => data()?.files ?? [];
      const rows = createMemo<Row[]>(() => layout(files(), { folded: folded(), expanded: expanded(), threads: threads(), maxLines: MAX_FILE_LINES }).rows);
      const numWidth = createMemo(() => numberWidth(files()));
      const drafts = () => threads().filter((t) => t.status === "draft");

      const reload = async (req?: ScopeRequest) => {
        const mine = ++generation;
        const scope = req ?? untrack(data)?.scope ?? pendingScope ?? defaultScope(await users(id));
        pendingScope = undefined;
        setStatus("loading…");
        let result: ReviewData | string;
        try {
          result = await load(id, scope);
        } catch (error) {
          result = `could not load the diff: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (mine !== generation) return;
        if (typeof result === "string") {
          setData((d) => (d ? { ...d, files: [], scope, label: scopeTitle(scope) } : { scope, label: scopeTitle(scope), files: [] }));
          setStatus(result);
          return;
        }
        setData(result);
        setStatus(result.files.length ? "" : "no changes in this scope");
        setAnchor(undefined);
        setCursor((c) => Math.min(c, Math.max(0, untrack(rows).length - 1)));
      };
      void reload();

      // Keep the cursor on a row, and the row in view.
      createEffect(() => {
        const n = rows().length;
        if (cursor() >= n) setCursor(Math.max(0, n - 1));
      });
      createEffect(
        on([cursor, rows], () => {
          const s = scroller;
          if (!s) return;
          const height = s.viewport.height;
          if (height <= 0) return;
          const c = cursor();
          if (c < s.scrollTop) s.scrollTo(c);
          else if (c >= s.scrollTop + height) s.scrollTo(c - height + 1);
        }),
      );

      const move = (delta: number) => {
        const n = rows().length;
        if (!n) return;
        setCursor((c) => Math.max(0, Math.min(n - 1, c + delta)));
      };
      const page = () => Math.max(1, Math.floor((scroller?.viewport.height ?? 20) / 2));
      const jump = (kind: "file" | "hunk", delta: 1 | -1) => {
        const r = nextOfKind(rows(), cursor(), kind, delta);
        if (r !== undefined) setCursor(r);
      };
      const toast = (message: string, variant: "info" | "warning" | "error" = "info") => context.ui.toast.show({ message: `review: ${message}`, variant });

      const toggleFold = () => {
        const r = rows()[cursor()];
        if (!r || r.file < 0) return;
        const f = files()[r.file];
        if (!f) return;
        const path = filePath(f);
        if (r.kind === "note" && r.expand) {
          setExpanded(new Set([...expanded(), path]));
          return;
        }
        const next = new Set(folded());
        if (next.has(path)) next.delete(path);
        else next.add(path);
        setFolded(next);
        const header = rows().findIndex((row) => row.kind === "file" && row.file === r.file);
        if (header >= 0) setCursor(header);
      };

      const select = () => {
        const r = rows()[cursor()];
        if (anchor() !== undefined) setAnchor(undefined);
        else if (r?.kind === "line") setAnchor(cursor());
        else toast("select lines of the diff", "warning");
      };

      const addThread = async (path: string, sel: Selection | undefined, suggest: boolean) => {
        const where = !sel ? "" : sel.start === sel.end ? ` L${sel.start}` : ` L${sel.start}-${sel.end}`;
        let text: string | undefined;
        if (suggest && sel) {
          const lines = sel.excerpt.filter((l) => (sel.side === "new" ? !l.startsWith("- ") : !l.startsWith("+ "))).map((l) => l.slice(2));
          const before = lines.join("\n");
          text = await edit({ title: `Suggest an edit to ${path}${where}`, description: "Rewrite these lines as they should be; the agent is asked to make the change.", value: before, lines: Math.max(3, lines.length + 2) });
          if (text === undefined) return;
          if (text === before) {
            toast("suggestion unchanged; discarded");
            return;
          }
        } else {
          text = await edit({ title: `Comment on ${path}${where}`, placeholder: "What should change, or what you want to know", lines: 5 });
          if (!text?.trim()) return;
        }
        const next = copyThreads(id);
        next.push({
          id: newThreadId(next.map((t) => t.id)),
          file: path,
          side: sel?.side ?? "new",
          start: sel?.start ?? 0,
          end: sel?.end ?? 0,
          excerpt: sel?.excerpt ?? [],
          body: suggest ? "" : (text ?? ""),
          ...(suggest ? { suggestion: text } : {}),
          status: "draft",
          createdAt: Date.now(),
        });
        await setThreads(id, next);
        setAnchor(undefined);
      };

      const comment = async (suggest: boolean) => {
        const all = rows();
        const r = all[cursor()];
        if (!r) return;
        if (!suggest && r.kind === "thread") return editThread(r.thread);
        if (r.file < 0) return toast("move to a line of the diff", "warning");
        const path = filePath(files()[r.file] as FileDiff);
        if (r.kind === "line") return addThread(path, selectionFromRows(all, anchor() ?? cursor(), cursor()), suggest);
        if (suggest) return toast("put the cursor on lines to suggest an edit", "warning");
        if (r.kind === "hunk") {
          const span = hunkSpan(all, cursor());
          const sel = span ? selectionFromRows(all, span[0], span[1]) : undefined;
          if (sel) return addThread(path, sel, false);
        }
        if (r.kind === "file" || r.kind === "hunk") return addThread(path, undefined, false);
        toast("move to a line, a hunk or a file header", "warning");
      };

      const editThread = async (threadID: string) => {
        const t = byId().get(threadID);
        if (!t) return;
        const isSuggest = t.suggestion !== undefined;
        const text = await edit({
          title: `${isSuggest ? "Edit suggestion" : "Edit comment"} on ${t.file}${t.start ? ` L${t.start}${t.end !== t.start ? `-${t.end}` : ""}` : ""}`,
          value: isSuggest ? t.suggestion : t.body,
          lines: Math.max(5, (isSuggest ? (t.suggestion ?? "") : t.body).split("\n").length + 2),
        });
        if (text === undefined) return;
        const next = copyThreads(id);
        const mine = next.find((x) => x.id === threadID);
        if (!mine) return;
        if (isSuggest) mine.suggestion = text;
        else mine.body = text;
        if (mine.status !== "draft") {
          mine.status = "draft";
          delete mine.reply;
          delete mine.sentAt;
        }
        await setThreads(id, next);
      };
      const deleteThread = async (threadID: string) => {
        const t = byId().get(threadID);
        if (!t) return;
        await setThreads(
          id,
          copyThreads(id).filter((x) => x.id !== threadID),
        );
        toast(t.status === "draft" ? "draft deleted" : "comment removed");
      };
      const underCursor = (): string | undefined => threadAt(rows(), cursor());
      const goTo = (threadID: string) => {
        const r = rows().findIndex((row) => row.kind === "thread" && row.thread === threadID && row.first);
        if (r >= 0) setCursor(r);
      };

      const list = async () => {
        const all = threads();
        if (!all.length) return toast("no comments yet: c comments on a line");
        const options = all.map((t) => ({
          title: `${t.status.padEnd(8)} ${location(t).replace(/`/g, "")}${t.suggestion !== undefined ? " (suggestion)" : ""}`,
          value: t.id,
          description: (t.suggestion !== undefined ? t.suggestion : t.body).split("\n")[0] ?? "",
        }));
        const picked = await context.ui.dialog.select<string>({
          title: `Comments (${drafts().length} draft${drafts().length === 1 ? "" : "s"})`,
          options,
          current: underCursor(),
          actions: [
            {
              bind: "e",
              title: "edit",
              onTrigger: (value: string) => {
                context.ui.dialog.clear();
                void editThread(value);
              },
            },
            {
              bind: "x",
              title: "delete",
              onTrigger: (value: string) => {
                context.ui.dialog.clear();
                void deleteThread(value);
              },
            },
            { bind: "w", title: "send drafts", selection: "none", side: "right", onTrigger: () => void send(false) },
          ],
        });
        if (picked) goTo(picked);
      };

      const send = async (thenClose: boolean) => {
        const mine = drafts();
        const d = data();
        if (!mine.length || !d) {
          toast("no draft comments to send");
          if (thenClose) props.panel.close();
          return;
        }
        const text = buildPrompt(mine, d.label);
        try {
          await context.client.session.prompt({ sessionID: id, text, delivery: "queue" });
        } catch (error) {
          toast(`could not send: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        const now = Date.now();
        const ids = new Set(mine.map((t) => t.id));
        const next = copyThreads(id).map((t) => (ids.has(t.id) ? { ...t, status: "sent" as const, sentAt: now } : t));
        await setThreads(id, next);
        const busy = context.data.session.status(id) === "running";
        const what = `${mine.length} comment${mine.length === 1 ? "" : "s"}`;
        toast(busy ? `queued ${what} after the current run` : `sent ${what} to the agent`);
        if (thenClose) props.panel.close();
      };

      const mark = async () => {
        const d = data();
        const through = d?.through;
        if (!through) return toast("nothing to mark: the session has no turns yet", "warning");
        const ok = await context.ui.dialog.confirm({ title: "Mark reviewed", message: `Mark ${d.label} as reviewed? The unreviewed scope then starts after it; answered comments are resolved.` });
        if (!ok) return;
        await update((draft) => {
          const s = (draft.sessions[id] ??= { threads: [] });
          s.mark = { through, at: Date.now() };
          for (const t of s.threads) if (t.status === "answered") t.status = "resolved";
        });
        toast("marked reviewed");
        if (d.scope.kind === "unreviewed") void reload();
      };

      const pickScope = async () => {
        const picked = await context.ui.dialog.select<ScopeKind>({
          title: "Review scope",
          options: SCOPES.map((s) => ({ title: s.title, value: s.value, description: s.description })),
          current: data()?.scope.kind,
        });
        if (picked) void reload({ kind: picked, ...(picked === "turn" ? { turn: 1 } : {}) });
      };

      const help = () =>
        void context.ui.dialog.alert({ title: "Review keys", message: KEYS.map(([k, what]) => `${k.padEnd(18)} ${what}`).join("\n") });

      context.keymap.layer(() => ({
        commands: [
          { bind: "j,down", run: () => move(1) },
          { bind: "k,up", run: () => move(-1) },
          { bind: "ctrl+d,pagedown", run: () => move(page()) },
          { bind: "ctrl+u,pageup", run: () => move(-page()) },
          { bind: "g,home", run: () => setCursor(0) },
          {
            bind: "shift+g,end",
            run: () => {
              const all = rows();
              let last = all.length - 1;
              while (last > 0 && all[last]?.kind === "blank") last--;
              setCursor(Math.max(0, last));
            },
          },
          { bind: "]", run: () => jump("hunk", 1) },
          { bind: "[", run: () => jump("hunk", -1) },
          { bind: "},shift+]", run: () => jump("file", 1) },
          { bind: "{,shift+[", run: () => jump("file", -1) },
          { bind: "return", run: toggleFold },
          { bind: "v,shift+v", run: select },
          { bind: "c", run: () => void comment(false) },
          { bind: "s", run: () => void comment(true) },
          {
            bind: "e",
            run: () => {
              const t = underCursor();
              if (t) void editThread(t);
              else toast("no comment here", "warning");
            },
          },
          {
            bind: "x",
            run: () => {
              const t = underCursor();
              if (t) void deleteThread(t);
              else toast("no comment here", "warning");
            },
          },
          { bind: "l", run: () => void list() },
          { bind: "w", run: () => void send(false) },
          { bind: "shift+w", run: () => void send(true) },
          { bind: "shift+s", run: () => void pickScope() },
          { bind: "m", run: () => void mark() },
          { bind: "r", run: () => void reload() },
          { bind: "?,shift+/", run: help },
          { bind: "f", run: () => props.panel.toggleFullscreen() },
          { bind: "q", run: () => props.panel.close() },
          {
            bind: "escape",
            run: () => {
              if (anchor() !== undefined) setAnchor(undefined);
              else props.panel.close();
            },
          },
        ],
      }));
      onCleanup(() => {
        generation++;
      });

      const rowState = (index: number, row: Row) => {
        const a = anchor();
        const c = cursor();
        const selected = a !== undefined && index >= Math.min(a, c) && index <= Math.max(a, c);
        const f = row.file >= 0 ? files()[row.file] : undefined;
        return { cursor: index === c, selected, folded: f ? folded().has(filePath(f)) : false };
      };

      return jsx("box", {
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        children: [
          line(() => [
            { text: "Review", color: "base", bold: true },
            { text: `  ${data()?.label ?? ""}`, color: "accent" },
            { text: `  ${summary(files(), threads())}`, color: "muted" },
          ]),
          jsx(Show as never, {
            get when() {
              return status();
            },
            children: () => line(() => [{ text: `  ${status()}`, color: status().startsWith("loading") ? "muted" : "warning" }]),
          }),
          jsx("scrollbox", {
            ref: (el: ScrollBoxRenderable) => (scroller = el),
            flexGrow: 1,
            minHeight: 0,
            contentOptions: { minHeight: 0 },
            get scrollbarOptions() {
              return { trackOptions: { backgroundColor: context.theme.background.raised.base, foregroundColor: context.theme.scrollbar.base } };
            },
            children: jsx(For as never, {
              get each() {
                return rows();
              },
              children: (row: Row, index: () => number) =>
                line(
                  () => paintRow(row, files(), rowState(index(), row), numWidth(), byId()),
                  () => {
                    const s = rowState(index(), row);
                    return s.cursor ? context.theme.background.raised.high : s.selected ? context.theme.background.raised.base : undefined;
                  },
                ),
            }),
          }),
          line(() => [{ text: HINTS, color: "muted" }]),
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

    /** The scope `/diff-review <args>` asked for, taken by the panel when it opens. */
    let pendingScope: ScopeRequest | undefined;
    const open = (input?: string) => {
      if (!sessionID()) {
        context.ui.toast.show({ message: "review: open a session first", variant: "warning" });
        return;
      }
      const args = (input ?? "").replace(/^\/(?:diff-review|dr)\s*/u, "");
      const req = parseScopeArgs(args);
      if (args.trim() && !req) {
        context.ui.toast.show({ message: `review: unknown scope "${args.trim()}"; use unreviewed, turn [n], session, head or branch`, variant: "warning" });
        return;
      }
      pendingScope = req;
      if (context.ui.panel.current()?.name === PANEL) {
        // Already open: the panel reloads through its own keys; close and reopen for a new scope.
        context.ui.panel.close();
      }
      if (!context.ui.panel.open(PANEL, { presentation: "fullscreen" })) context.ui.toast.show({ message: "review: open a session first", variant: "warning" });
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "diff-review.open",
          title: "Review changes",
          description: "Diff of what the agent changed, with line comments and suggested edits to send back",
          group: "Session",
          palette: true,
          slash: { name: "diff-review", aliases: ["dr"], arguments: true },
          run: (input?: string) => open(input),
        },
      ],
    }));

    return () => {
      offSettled();
      offDeleted();
    };
  },
});

function scopeTitle(req: ScopeRequest): string {
  const s = SCOPES.find((x) => x.value === req.kind);
  return req.kind === "turn" && (req.turn ?? 1) > 1 ? `turn -${req.turn}` : (s?.title ?? req.kind);
}
