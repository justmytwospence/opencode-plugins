// opencode-btw (terminal): `/btw [question]` (also `/side`) opens a session panel with a side
// thread: a real OpenCode session forked from the shown session (so it knows the conversation
// so far) that answers while the main run keeps going. The panel has the thread's transcript and
// its own input; `/btw:tangent` starts one without the main conversation, `/btw:ask` one on the
// read-only `plan` agent, `/btw:new` a fresh contextual one, `/btw:clear` drops it.
// `/btw:inject [instructions]` hands the thread to the main session as a queued synthetic
// message (after its current turn, if busy) and `/btw:summarize` hands a model-written summary
// instead; both then drop the thread. `/btw:model` and `/btw:thinking` pick the thread's model and
// variant. Threads are remembered per main session in the terminal's durable storage, and the
// side sessions carry `metadata.btw`, which the server half acts on (system prompt, read-only).
//
// Everything here goes through OpenCode's own API (`context.client.session.*`): export and import
// (a fork as a hidden child session), prompt, generate, synthetic. Plain TypeScript with jsx()
// rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import {
  type Exchange,
  METADATA_KEY,
  type MessageLike,
  SUMMARIZE_PROMPT,
  type ThreadMode,
  commandArgs,
  exchanges,
  forkCopies,
  formatModel,
  formatThread,
  handoffMessage,
  newSessionID,
  parseArgs,
  parseModelArgs,
  parseThinkingArgs,
  threadMessages,
  threadTitle,
} from "./thread.ts";
import { type Block, type Color, HINTS, blocks, header } from "./view.ts";

export const PANEL = "btw";

interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

interface Thread {
  sessionID: string;
  mode: ThreadMode;
  created: number;
  /** The last message the side session had when created: a fork's copies of the main conversation end there. */
  after?: string;
}

interface Store {
  /** Threads by main session id. */
  threads: Record<string, Thread>;
  /** `/btw:model` and `/btw:thinking` overrides by main session id. */
  models: Record<string, ModelRef>;
  /** The notice about OpenCode's own `/btw` has been shown. */
  noticed?: boolean;
}

type Metadata = { [key: string]: { [key: string]: string } };

interface Options {
  /** The agent of `/btw:ask` threads. */
  askAgent: string;
}

export default Plugin.define({
  id: "btw.tui",
  setup(context) {
    const client = context.client;
    const ignore = () => undefined;
    const options: Options = { askAgent: typeof context.options.askAgent === "string" ? context.options.askAgent : "plan" };
    const [store, update] = context.storage.store<Store>("threads", { initial: { threads: {}, models: {} } });
    const toast = (message: string, variant: "info" | "warning" | "error" | "success" = "info") => context.ui.toast.show({ message: `btw: ${message}`, variant });
    const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error");

    /** The shown session's root: the main session a thread belongs to. */
    const main = (): string | undefined => {
      const route = context.ui.router.current();
      if (route.type !== "session") return undefined;
      try {
        return context.data.session.root(route.sessionID) || route.sessionID;
      } catch {
        return route.sessionID;
      }
    };
    const directory = (id = main()): string => {
      const dir = id ? context.data.session.get(id)?.location?.directory : undefined;
      return dir ?? (context.location ?? context.data.location.default()).directory;
    };
    /** Requests go to the server instance of the shown session's directory. */
    const at = (id = main()) => ({ headers: { "x-opencode-directory": encodeURIComponent(directory(id)) } });

    const thread = (id = main()): Thread | undefined => (id ? store.threads[id] : undefined);
    const setThread = (id: string, value: Thread | undefined) =>
      update((draft) => {
        if (value) draft.threads[id] = value;
        else delete draft.threads[id];
      });

    const mainModel = (id: string): ModelRef | undefined => {
      const route = context.ui.router.current();
      const picked = route.type === "session" && route.sessionID === id ? context.ui.model.current() : undefined;
      if (picked) return picked;
      const m = context.data.session.get(id)?.model;
      return m ? { providerID: m.providerID, modelID: m.id, ...(m.variant ? { variant: m.variant } : {}) } : undefined;
    };
    const effectiveModel = (id: string): ModelRef | undefined => store.models[id] ?? mainModel(id);

    const applyModel = async (id: string, t: Thread): Promise<void> => {
      const model = effectiveModel(id);
      if (!model) return;
      await client.session.switchModel({ sessionID: t.sessionID, model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } }, at(id));
    };

    /**
     * A fork of `id` as a child session, so it stays out of the session list, tabs and
     * `--continue`: the main session is exported and imported under a new id with `parentID`
     * set and its complete messages copied (what `session.fork` copies). Falls back to
     * `session.fork` (a root session, titled `btw: ...`) when the import is refused.
     */
    const fork = async (id: string, title: string, metadata: Metadata): Promise<{ sessionID: string; after?: string }> => {
      try {
        const exported = await client.session.export({ sessionID: id }, at(id));
        const copies = forkCopies(exported.messages as unknown as (MessageLike & { status?: string })[]);
        const sessionID = newSessionID();
        const now = Date.now();
        const { revert: _revert, ...rest } = exported.info;
        const info = {
          ...rest,
          id: sessionID,
          parentID: id,
          title,
          metadata,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
          ...(copies.length ? { fork: { sessionID: id, boundary: { type: "through" as const, messageID: copies[copies.length - 1]!.id.replace(/_b\d+$/, "") } } } : {}),
        };
        await client.session.import({ info, messages: copies } as unknown as Parameters<typeof client.session.import>[0], at(id));
        return { sessionID, ...(copies.length ? { after: copies[copies.length - 1]!.id } : {}) };
      } catch (error) {
        toast(`hidden fork failed (${error instanceof Error ? error.message : String(error)}); forking as a listed session`, "warning");
        const info = await client.session.fork({ sessionID: id }, at(id));
        await client.session.update({ sessionID: info.id, title, metadata }, at(id));
        const after = (await client.message.list({ sessionID: info.id, limit: 1, order: "desc" }, at(id))).data[0]?.id;
        return { sessionID: info.id, ...(after ? { after } : {}) };
      }
    };

    /** A new side session for `id`: a fork (contextual, readonly) or a fresh child session (tangent). */
    const create = async (id: string, mode: ThreadMode, question: string): Promise<Thread> => {
      const title = threadTitle(question, mode);
      const metadata: Metadata = { [METADATA_KEY]: { main: id, mode, title } };
      const side =
        mode === "tangent"
          ? { sessionID: (await client.session.create({ parentID: id, title, metadata, location: { directory: directory(id) } }, at(id))).id }
          : await fork(id, title, metadata);
      const t: Thread = { sessionID: side.sessionID, mode, created: Date.now(), ...(side.after ? { after: side.after } : {}) };
      const agent = mode === "readonly" ? options.askAgent : context.data.session.get(id)?.agent;
      if (agent) await client.session.switchAgent({ sessionID: t.sessionID, agent }, at(id)).catch((error: unknown) => toast(`agent ${agent}: ${error instanceof Error ? error.message : String(error)}`, "warning"));
      await applyModel(id, t).catch(ignore);
      await setThread(id, t);
      return t;
    };

    /** Drops the thread of `id`: deletes its side session and closes the panel. */
    const drop = async (id: string, t = thread(id)): Promise<void> => {
      if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close();
      if (!t) return;
      await setThread(id, undefined);
      await client.session.remove({ sessionID: t.sessionID }, at(id)).catch(ignore);
    };

    const alive = async (id: string, t: Thread): Promise<boolean> => {
      try {
        await client.session.get({ sessionID: t.sessionID }, at(id));
        return true;
      } catch {
        await setThread(id, undefined);
        return false;
      }
    };

    const running = (sessionID: string): boolean => {
      try {
        return context.data.session.status(sessionID) === "running";
      } catch {
        return false;
      }
    };

    /** A follow-up while the thread is answering waits for its turn; otherwise the prompt runs now. */
    const send = async (id: string, t: Thread, text: string): Promise<void> => {
      await client.session.prompt({ sessionID: t.sessionID, text, ...(running(t.sessionID) ? { delivery: "queue" as const } : {}) }, at(id));
    };

    /** `/btw`, `/btw:new`, `/btw:tangent`, `/btw:ask`: the thread for the mode, then the question. */
    let focusInput: (() => void) | undefined;
    const ask = async (input: string, requested: ThreadMode | "current" | "new"): Promise<void> => {
      const id = main();
      if (!id) {
        toast("open a session first", "warning");
        return;
      }
      const { question } = parseArgs(input);
      let t = thread(id);
      if (t && !(await alive(id, t))) t = undefined;
      const mode: ThreadMode = requested === "current" ? (t?.mode ?? "contextual") : requested === "new" ? "contextual" : requested;
      try {
        if (t && (requested === "new" || t.mode !== mode)) {
          await drop(id, t);
          t = undefined;
        }
        t ??= await create(id, mode, question);
        if (!context.ui.panel.open(PANEL)) {
          toast("the panel needs an open session", "warning");
          return;
        }
        focusInput?.();
        if (question) await send(id, t, question);
      } catch (error) {
        fail(error);
      }
    };

    /** The thread's own messages (after the fork's copies), in creation order. */
    const messagesOf = async (id: string, t: Thread): Promise<MessageLike[]> => {
      const all: MessageLike[] = [];
      const limit = 100;
      let cursor: string | undefined;
      for (;;) {
        const page = await client.message.list({ sessionID: t.sessionID, order: "asc", limit, ...(cursor ? { cursor } : {}) }, at(id));
        all.push(...(page.data as unknown as MessageLike[]));
        if (page.data.length < limit || !page.cursor.next) break;
        cursor = page.cursor.next;
      }
      return threadMessages(all, t.after, t.created);
    };

    /** `/btw:inject` and `/btw:summarize`: the thread (or its summary) to the main session, then drop it. */
    const handoff = async (input: string, summarize: boolean): Promise<void> => {
      const id = main();
      const t = id ? thread(id) : undefined;
      if (!id || !t) {
        toast(`no side thread to ${summarize ? "summarize" : "inject"}`, "warning");
        return;
      }
      try {
        const thread: Exchange[] = exchanges(await messagesOf(id, t));
        if (!thread.length) {
          toast("the side thread has no completed exchange yet", "warning");
          return;
        }
        if (running(t.sessionID)) {
          toast("the side thread is still answering", "warning");
          return;
        }
        toast(summarize ? "summarizing…" : "injecting…");
        const body = summarize ? (await client.session.generate({ sessionID: t.sessionID, prompt: SUMMARIZE_PROMPT }, at(id))).text.trim() : formatThread(thread);
        if (!body) throw new Error("the summary came back empty");
        const n = `${thread.length} exchange${thread.length === 1 ? "" : "s"}`;
        await client.session.synthetic(
          { sessionID: id, text: handoffMessage(body, input, summarize), description: `btw: ${summarize ? "summary of a side thread" : "side thread"} (${n})`, delivery: "queue" },
          at(id),
        );
        await drop(id, t);
        toast(`${summarize ? "summary" : "thread"} injected (${n})${running(id) ? ", queued after the current turn" : ""}`, "success");
      } catch (error) {
        fail(error);
      }
    };

    const model = async (input: string): Promise<void> => {
      const id = main();
      if (!id) return;
      const parsed = parseModelArgs(input);
      if (parsed.action === "invalid") return toast(parsed.message, "warning");
      if (parsed.action === "show") {
        const m = effectiveModel(id);
        return toast(m ? `model ${formatModel(m)}${store.models[id] ? " (override)" : " (main session's)"}` : "no model selected");
      }
      if (parsed.action === "set") {
        const known = context.data.location.model.list({ directory: directory(id) }) ?? [];
        if (known.length && !known.some((m) => m.providerID === parsed.providerID && (m.modelID === parsed.modelID || m.id === parsed.modelID))) return toast(`model not available: ${parsed.providerID}/${parsed.modelID}`, "warning");
      }
      await update((draft) => {
        if (parsed.action === "clear") delete draft.models[id];
        else draft.models[id] = { providerID: parsed.providerID, modelID: parsed.modelID, ...(parsed.variant ? { variant: parsed.variant } : {}) };
      });
      const t = thread(id);
      if (t) await applyModel(id, t).catch(fail);
      const m = effectiveModel(id);
      toast(parsed.action === "clear" ? `override cleared${m ? `, using ${formatModel(m)}` : ""}` : `model ${formatModel(m!)}`);
    };

    const thinking = async (input: string): Promise<void> => {
      const id = main();
      if (!id) return;
      const parsed = parseThinkingArgs(input);
      if (parsed.action === "invalid") return toast(parsed.message, "warning");
      const base = effectiveModel(id);
      if (parsed.action === "show") return toast(base ? `thinking ${base.variant ?? "default"} (${formatModel(base)})` : "no model selected");
      if (!base) return toast("no model selected", "warning");
      await update((draft) => {
        const next: ModelRef = { providerID: base.providerID, modelID: base.modelID };
        if (parsed.action === "set") next.variant = parsed.variant;
        draft.models[id] = next;
      });
      const t = thread(id);
      if (t) await applyModel(id, t).catch(fail);
      toast(parsed.action === "clear" ? "thinking override cleared" : `thinking ${parsed.variant}`);
    };

    // Threads whose sessions are gone are forgotten.
    const offDeleted = context.data.on("session.deleted", (event) => {
      const gone = (event as { data?: { sessionID?: string } }).data?.sessionID;
      if (!gone) return;
      for (const [id, t] of Object.entries(store.threads)) {
        if (id === gone) void drop(id, t);
        else if (t.sessionID === gone) void setThread(id, undefined);
      }
    });

    const color = (name: Color) => {
      const t = context.theme;
      if (name === "error" || name === "warning" || name === "success") return t.text.feedback[name].base;
      if (name === "accent") return t.text.action.primary.base;
      if (name === "muted") return t.text.muted;
      return t.text.base;
    };

    /** The panel's contents; its keymap layer lives and dies with it. */
    const Panel = (props: { panel: PanelInput }) => {
      const id = (): string => {
        try {
          return context.data.session.root(props.panel.sessionID) || props.panel.sessionID;
        } catch {
          return props.panel.sessionID;
        }
      };
      const current = () => thread(id());
      const [messages, setMessages] = createSignal<MessageLike[]>([]);
      const [tick, setTick] = createSignal(0);
      /** The last failure of the side session's run (a model that is unavailable, a provider error). */
      const [failure, setFailure] = createSignal<string | undefined>(undefined);
      let area: TextareaRenderable | undefined;
      let scroller: ScrollBoxRenderable | undefined;
      let generation = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const reload = async () => {
        const t = current();
        const mine = ++generation;
        if (!t) {
          setMessages([]);
          return;
        }
        try {
          const list = await messagesOf(id(), t);
          if (mine === generation) setMessages(list);
        } catch (error) {
          if (mine === generation) toast(`could not read the thread: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      };
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          void reload();
        }, 80);
      };
      createEffect(on(() => current()?.sessionID, () => void reload()));
      const offEvents = context.data.listen(({ details }) => {
        const data = (details as { data?: { sessionID?: string; error?: { message?: string; type?: string } } }).data;
        if (!data?.sessionID || data.sessionID !== current()?.sessionID || !details.type.startsWith("session.")) return;
        if (details.type === "session.execution.failed") setFailure(data.error?.message ?? data.error?.type ?? "the run failed");
        else if (details.type === "session.execution.started") setFailure(undefined);
        schedule();
        setTick((n) => n + 1);
      });
      onCleanup(() => {
        offEvents();
        if (timer) clearTimeout(timer);
        generation++;
        focusInput = undefined;
      });

      const isRunning = () => {
        tick();
        const t = current();
        return t ? running(t.sessionID) : false;
      };
      const rows = createMemo<Block[]>(() => blocks(messages(), isRunning()));
      const focus = () => {
        setTimeout(() => {
          if (area && !area.isDestroyed) area.focus();
        }, 1);
      };
      focusInput = focus;
      createEffect(() => {
        if (props.panel.focused) focus();
      });

      const submit = () => {
        const text = (area?.plainText ?? "").trim();
        const t = current();
        if (!text || !t) return;
        area?.clear();
        void send(id(), t, text).catch(fail);
      };
      const escape = async () => {
        const t = current();
        if (t && running(t.sessionID)) {
          await client.session.interrupt({ sessionID: t.sessionID }, at(id())).catch(ignore);
          return;
        }
        props.panel.close();
      };
      const scroll = (delta: number) => {
        if (scroller && !scroller.isDestroyed) scroller.scrollBy(delta);
      };

      context.keymap.layer(() => ({
        commands: [
          { bind: "escape", run: () => void escape() },
          { bind: "pageup", run: () => scroll(-10) },
          { bind: "pagedown", run: () => scroll(10) },
          { bind: "ctrl+f", run: () => props.panel.toggleFullscreen() },
        ],
      }));

      const t = context.theme;
      const line = (text: () => string, c: Color = "base", wrap = true) =>
        jsx("text", {
          wrapMode: wrap ? "word" : "none",
          get fg() {
            return color(c);
          },
          get children() {
            return text();
          },
        });
      const block = (b: Block) => {
        switch (b.kind) {
          case "user":
            return jsx("box", {
              flexDirection: "column",
              marginTop: 1,
              children: [jsx("text", { fg: color("accent"), attributes: 1, children: "You" }), line(() => b.text, "base")],
            });
          case "assistant":
            return jsx("box", {
              flexDirection: "column",
              marginTop: 1,
              children: [jsx("text", { fg: color("success"), attributes: 1, children: b.streaming ? "Assistant …" : "Assistant" }), line(() => b.text, "base")],
            });
          case "thinking":
            return jsx("text", { fg: color("warning"), children: "thinking…" });
          case "tool":
            return jsx("text", { fg: color(b.color), wrapMode: "none", children: `· ${b.text}` });
          case "error":
            return jsx("text", { fg: color("error"), wrapMode: "word", children: `error: ${b.text}` });
        }
      };

      return jsx("box", {
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        flexGrow: 1,
        children: [
          line(() => {
            const th = current();
            const m = th ? effectiveModel(id()) : undefined;
            return th ? header(th.mode, m ? formatModel(m) : undefined, context.data.session.get(th.sessionID)?.agent, isRunning()) : "btw · no thread";
          }, "muted", false),
          jsx("scrollbox", {
            ref: (el: ScrollBoxRenderable) => {
              scroller = el;
            },
            flexGrow: 1,
            stickyScroll: true,
            stickyStart: "bottom",
            children: [
              jsx(Show as never, {
                get when() {
                  return rows().length === 0;
                },
                children: line(() => (current() ? "Ask a side question below. The main session keeps running." : "No side thread. /btw <question> starts one."), "muted"),
              }),
              jsx(For as never, {
                get each() {
                  return rows();
                },
                children: (b: Block) => block(b),
              }),
              jsx(Show as never, {
                get when() {
                  return failure();
                },
                children: (f: () => string) => jsx("text", { fg: color("error"), wrapMode: "word", marginTop: 1, children: `error: ${f()}` }),
              }),
            ],
          }),
          jsx("textarea", {
            ref: (el: TextareaRenderable) => {
              area = el;
            },
            placeholder: "Side question…",
            placeholderColor: t.text.muted,
            textColor: t.text.formfield.base,
            focusedTextColor: t.text.formfield.base,
            backgroundColor: t.background.formfield.base,
            focusedBackgroundColor: t.background.formfield.base,
            height: 3,
            marginTop: 1,
            wrapMode: "word",
            keyBindings: [
              { name: "return", action: "submit" },
              { name: "kpenter", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "return", meta: true, action: "newline" },
            ],
            onSubmit: submit,
          }),
          line(() => HINTS, "muted"),
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

    // Every command takes arguments: a slash command without them only runs from the completion
    // list, and typed with a trailing space would go to the model as a prompt.
    const command = (id: string, title: string, description: string, name: string, run: (input: string) => Promise<void> | void, aliases: string[] = []) => ({
      id,
      title,
      description,
      group: "BTW",
      palette: true as const,
      slash: { name, aliases, arguments: true as const },
      run: (input?: string) => void run(commandArgs(input, [name, ...aliases])),
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        command("btw.ask", "Side conversation", "Ask a side question in a thread forked from this session", "btw", (input) => ask(input, "current"), ["side"]),
        command("btw.new", "New side thread", "Drop the side thread and start a fresh contextual one", "btw:new", (input) => ask(input, "new")),
        command("btw.tangent", "Side tangent", "A side thread without the main conversation", "btw:tangent", (input) => ask(input, "tangent")),
        command("btw.readonly", "Side question, read-only", `A side thread on the ${options.askAgent} agent with editing denied`, "btw:ask", (input) => ask(input, "readonly")),
        command("btw.clear", "Clear side thread", "Close the panel and delete the side session", "btw:clear", async () => {
          const id = main();
          if (id) await drop(id);
        }),
        command("btw.inject", "Inject side thread", "Send the side thread to this session as a queued message, then drop it", "btw:inject", (input) => handoff(input, false)),
        command("btw.summarize", "Summarize side thread", "Send a summary of the side thread to this session, then drop it", "btw:summarize", (input) => handoff(input, true)),
        command("btw.model", "Side thread model", "Show, set (provider/model[#variant]) or clear the side thread's model", "btw:model", model),
        command("btw.thinking", "Side thread thinking", "Show, set (variant) or clear the side thread's thinking level", "btw:thinking", thinking),
      ],
    }));

    // OpenCode 2.0.24 ships its own `/btw` (`session.aside`, a one-shot answer in a dialog). With
    // both enabled, which one `/btw` runs depends on registration order, so say so once; `/side`
    // and the `/btw:*` commands are unambiguous.
    const collision = setTimeout(() => {
      if (store.noticed) return;
      const other = context.keymap.commands().some((c) => c.id === "session.aside" || (c.slash?.name === "btw" && c.id !== "btw.ask"));
      if (!other) return;
      context.ui.toast.show({ message: "btw: OpenCode's own one-shot /btw is also enabled, so /btw may open it; /side always opens the side thread. Disable the internal opencode.btw plugin in /plugins to make /btw unambiguous.", variant: "warning", duration: 15_000 });
      void update((draft) => {
        draft.noticed = true;
      });
    }, 5_000);

    return () => {
      clearTimeout(collision);
      offDeleted();
    };
  },
});
