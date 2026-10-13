// opencode-next-prompt (terminal): when a run ends with a `next` block, its suggestion becomes
// the ghost text of the empty prompt (the textarea's placeholder, see ghost.ts); Tab or Right
// fills it in (never sends it), typing hides it, clearing the prompt brings it back, and a new
// run drops it. Each session keeps its own suggestion. The block itself is hidden in the
// transcript: a code block renderer for the `next` info string draws nothing.
//
// Plain TypeScript with no JSX; the static `@opentui/core` import is rewritten by the host to
// its runtime module, so the Box and StyledText here are the ones OpenCode draws with.
import { Plugin } from "@opencode/plugin/tui";
import { BoxRenderable, StyledText, dim, fg } from "@opentui/core";
import { createEffect, createSignal } from "solid-js";
import { Tracker, keyLabel } from "./core.ts";
import { type EditorLike, Ghost, isPrompt } from "./ghost.ts";
import { NextPromptRpc, type Verdict } from "./rpc.ts";
import { DEFAULTS, NAME, type Options } from "./server.ts";
import { loadSettings } from "./settings.ts";

export default Plugin.define({
  id: "next-prompt.tui",
  setup(context) {
    const options = (): Options =>
      loadSettings(NAME, DEFAULTS, context.options, (context.location ?? context.data.location.default()).directory);
    const rpc = context.client.rpc(NextPromptRpc);
    const tracker = new Tracker();
    const ghost = new Ghost();
    const [suggestions, setSuggestions] = createSignal<Record<string, string>>({});
    const [store, update] = context.storage.store<{ enabled: boolean }>("next-prompt", { initial: { enabled: true } });
    /** Bumped per session whenever its offer is dropped, so a late verdict is not shown. */
    const generation = new Map<string, number>();
    let lastVerdict = "";
    const acceptKeys = options().acceptKeys;

    const enabled = () => store.enabled && options().enabled;

    const clear = (sessionID: string) => {
      generation.set(sessionID, (generation.get(sessionID) ?? 0) + 1);
      tracker.forget(sessionID);
      if (!(sessionID in suggestions())) return;
      const { [sessionID]: _gone, ...rest } = suggestions();
      setSuggestions(rest);
    };

    const settle = async (sessionID: string) => {
      const opts = options();
      const candidate = tracker.take(sessionID, context.data.session.message.list(sessionID) ?? [], opts.maxChars);
      // A subagent's session gets no instruction; should it end with a block anyway, nothing shows it.
      if (!candidate || !enabled() || context.data.session.get(sessionID)?.parentID) return;
      const mine = (generation.get(sessionID) ?? 0) + 1;
      generation.set(sessionID, mine);
      let verdict: Verdict;
      try {
        verdict = (await rpc.vet(candidate)) as Verdict;
      } catch (error) {
        // No server half (or an older one): the model already abstains on its own.
        verdict = { show: true, reason: `server unavailable (${error instanceof Error ? error.message : String(error)}), shown anyway` };
      }
      lastVerdict = `"${candidate.suggestion}": ${verdict.show ? "shown" : "held back"} (${verdict.reason})`;
      if (!verdict.show || generation.get(sessionID) !== mine) return;
      setSuggestions({ ...suggestions(), [sessionID]: candidate.suggestion });
    };

    const offs = [
      context.data.on("session.text.ended", (event) => tracker.ended(event.data.sessionID, event.data.assistantMessageID, event.data.text)),
      context.data.on("session.execution.started", (event) => clear(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => void settle(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => clear(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => clear(event.data.sessionID)),
      context.data.on("session.compaction.ended", (event) => clear(event.data.sessionID)),
      context.data.on("session.deleted", (event) => clear(event.data.sessionID)),
    ];

    // The transcript: a `next` block draws nothing.
    const offRenderer = context.markdown.registerCodeBlockRenderer("next", () => new BoxRenderable(context.renderer, { height: 0 }));

    // The prompt editor in view, and the suggestion for the session it belongs to.
    const shownSession = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const [prompt, setPrompt] = createSignal<EditorLike | undefined>(undefined);
    // OpenCode sets the prompt's traits in an effect after it mounts and focuses, so an editor
    // that is not the prompt yet when it gets focus is checked again when its traits change.
    type Watched = { on(event: string, handler: () => void): unknown; off(event: string, handler: () => void): unknown };
    let watched: { editor: Watched; handler: () => void } | undefined;
    const unwatch = () => {
      watched?.editor.off("traits-changed", watched.handler);
      watched = undefined;
    };
    const adopt = (editor: unknown) => {
      unwatch();
      if (isPrompt(editor)) {
        ghost.attach(editor);
        setPrompt(editor);
        return;
      }
      const candidate = editor as Partial<Watched> | null;
      if (!candidate || typeof candidate.on !== "function" || typeof candidate.off !== "function") return;
      const handler = () => {
        if (!isPrompt(editor)) return;
        unwatch();
        ghost.attach(editor);
        setPrompt(editor);
      };
      watched = { editor: candidate as Watched, handler };
      candidate.on("traits-changed", handler);
    };
    adopt(context.renderer.currentFocusedEditor);
    const onFocus = (editor: unknown) => adopt(editor);
    context.renderer.on("focused_editor", onFocus);

    // The suggestion in the placeholder's usual muted color, the key hint dimmer still.
    const placeholder = (text: string) =>
      new StyledText([fg(context.theme.text.muted)(text), dim(fg(context.theme.text.muted)(`  ${keyLabel(acceptKeys[0] ?? "tab")} to accept`))]);
    createEffect(() => {
      const session = shownSession();
      const text = session && enabled() ? suggestions()[session] : undefined;
      const editor = prompt();
      if (!editor || (editor.isDestroyed ?? false)) return;
      ghost.show(text ? placeholder(text) : undefined);
    });

    /** The offer the accept keys act on: the shown session's suggestion, in an empty, focused prompt. */
    const current = (): { editor: EditorLike; sessionID: string; text: string } | undefined => {
      const sessionID = shownSession();
      if (!sessionID || !enabled()) return undefined;
      const text = suggestions()[sessionID];
      const editor = context.renderer.currentFocusedEditor;
      if (!text || !isPrompt(editor) || !editor.focused || editor.plainText !== "") return undefined;
      return { editor, sessionID, text };
    };

    context.keymap.layer(() => ({
      priority: 10,
      commands: acceptKeys.map((key) => ({
        bind: key,
        title: "Accept the suggested prompt",
        group: "Prompt",
        enabled: () => current() !== undefined,
        run: () => {
          const now = current();
          if (!now) return false;
          clear(now.sessionID);
          now.editor.setText(now.text);
          now.editor.gotoBufferEnd();
        },
      })),
    }));

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "next-prompt.toggle",
          title: "Toggle next-prompt suggestions",
          group: "Prompt",
          palette: true,
          slash: { name: "next-prompt" },
          run: async () => {
            const on = !store.enabled;
            await update((draft) => {
              draft.enabled = on;
            });
            if (!on) for (const id of Object.keys(suggestions())) clear(id);
            context.ui.toast.show({ message: `next-prompt ${on ? "on" : "off"}${lastVerdict ? `. Last: ${lastVerdict}` : ""}`, variant: "info" });
          },
        },
      ],
    }));

    return () => {
      for (const off of offs) off();
      offRenderer();
      context.renderer.off("focused_editor", onFocus);
      unwatch();
      ghost.detach();
    };
  },
});
